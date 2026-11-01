import type { Object3D } from 'three/webgpu';
import { loadedObjectGroup } from '../../load-project/pbde/upload-pbde';
import type { ScenePanelRow, ScenePanelSelectionState, LoadedObjectUserData } from './scene-panel-types';
import { scenePanelState } from './scene-panel-state';
import { matchesPointerShortcut } from '../../controls/input/shortcuts';

function getRowFromElement(el: HTMLElement): ScenePanelRow | null {
    const visibleIndex = Number(el.dataset.visibleIndex);
    if (!Number.isInteger(visibleIndex)) return null;
    return scenePanelState.visibleRows[visibleIndex] ?? null;
}

function expandGroupAncestors(groupId: string, ud: LoadedObjectUserData, visited: Set<string>, includeSelf = false): boolean {
    const groups = ud.groups;
    if (!groups) return false;

    let changed = false;
    let current: string | null = includeSelf ? groupId : (groups.get(groupId)?.parent ?? null);

    while (current && !visited.has(current)) {
        visited.add(current);
        if (!scenePanelState.expandedGroupIds.has(current)) {
            scenePanelState.expandedGroupIds.add(current);
            changed = true;
        }
        current = groups.get(current)?.parent ?? null;
    }

    return changed;
}

function findObjectParentGroupId(uuid: string, ud: LoadedObjectUserData): string | null {
    const inst = ud.objectUuidToInstance?.get(uuid);
    if (inst && ud.objectToGroup) return ud.objectToGroup.get(`${inst.mesh.uuid}_${inst.instanceId}`) ?? null;

    const groups = ud.groups;
    if (!groups) return null;

    for (const group of groups.values()) {
        for (const child of group.children || []) {
            if (child.type !== 'object') continue;
            if (child.id === uuid) return group.id;
            if (child.mesh && typeof child.instanceId === 'number') {
                const childUuid = ud.instanceKeyToObjectUuid?.get(`${child.mesh.uuid}_${child.instanceId}`);
                if (childUuid === uuid) return group.id;
            }
        }
    }

    return null;
}

function expandSelectionAncestors(sel: ScenePanelSelectionState, ud: LoadedObjectUserData): boolean {
    let changed = false;
    const visited = new Set<string>();

    if (sel.groups) {
        for (const groupId of sel.groups) {
            changed = expandGroupAncestors(groupId, ud, visited) || changed;
        }
    }

    if (sel.objects) {
        const keyToUuid = ud.instanceKeyToObjectUuid;
        if (keyToUuid) {
            for (const [mesh, ids] of sel.objects) {
                for (const instanceId of ids) {
                    const key = `${mesh.uuid}_${instanceId}`;
                    let parentGroupId: string | null | undefined;
                    if (ud.objectToGroup) parentGroupId = ud.objectToGroup.get(key);
                    else {
                        const uuid = keyToUuid.get(key);
                        parentGroupId = uuid ? findObjectParentGroupId(uuid, ud) : null;
                    }
                    if (parentGroupId) {
                        changed = expandGroupAncestors(parentGroupId, ud, visited, true) || changed;
                    }
                }
            }
        }
    }

    if (sel.primary?.type === 'group') {
        changed = expandGroupAncestors(sel.primary.id, ud, visited) || changed;
    } else if (sel.primary?.type === 'object') {
        const uuid = ud.instanceKeyToObjectUuid?.get(`${sel.primary.mesh.uuid}_${sel.primary.instanceId}`);
        if (uuid) {
            const parentGroupId = findObjectParentGroupId(uuid, ud);
            if (parentGroupId) {
                changed = expandGroupAncestors(parentGroupId, ud, visited, true) || changed;
            }
        }
    }

    return changed;
}

export function handleSceneItemClick(e: MouseEvent, el: HTMLElement): void {
    if (Date.now() < scenePanelState.suppressSceneItemClickUntil) {
        e.preventDefault();
        e.stopPropagation();
        return;
    }

    const ud = loadedObjectGroup.userData as LoadedObjectUserData;
    if (!ud) return;

    const clickedRow = getRowFromElement(el);
    if (!clickedRow) return;
    const additive = matchesPointerShortcut(e, 'multiSelect');
    const boxSelect = matchesPointerShortcut(e, 'boxSelect');

    if (boxSelect && additive && scenePanelState.lastClickedItem && scenePanelState.lastClickedItem !== clickedRow) {
        const idx1 = scenePanelState.lastClickedItem.visibleIndex;
        const idx2 = clickedRow.visibleIndex;

        if (idx1 !== -1 && idx2 !== -1) {
            const start = Math.min(idx1, idx2);
            const end = Math.max(idx1, idx2);

            const rangeGroups = new Set<string>();
            const rangeObjects = new Map<Object3D, Set<number>>();
            const uuidToInstance = ud.objectUuidToInstance;

            const selectedNodes = scenePanelState.scenePanelList?.querySelectorAll('.selected') as NodeListOf<HTMLElement> | undefined;
            selectedNodes?.forEach(node => {
                if (node.dataset.displayType === 'group') {
                    const gId = node.dataset.groupId;
                    if (gId) rangeGroups.add(gId);
                } else if (node.dataset.uuid) {
                    const uuid = node.dataset.uuid;
                    if (uuid && uuidToInstance) {
                        const inst = uuidToInstance.get(uuid);
                        if (inst) {
                            if (!rangeObjects.has(inst.mesh)) {
                                rangeObjects.set(inst.mesh, new Set());
                            }
                            rangeObjects.get(inst.mesh)!.add(inst.instanceId);
                        }
                    }
                }
            });

            for (let i = start; i <= end; i++) {
                const row = scenePanelState.visibleRows[i];
                if (!row) continue;
                if (row.type === 'group') {
                    rangeGroups.add(row.id);
                    continue;
                }

                if (uuidToInstance) {
                    const inst = uuidToInstance.get(row.id);
                    if (inst) {
                        if (!rangeObjects.has(inst.mesh)) rangeObjects.set(inst.mesh, new Set());
                        rangeObjects.get(inst.mesh)!.add(inst.instanceId);
                    }
                }
            }

            const sortedRangeGroups = new Set<string>();
            const sortedRangeObjects = new Map<Object3D, Set<number>>();

            if (scenePanelState.lastClickedItem.type === 'group') {
                sortedRangeGroups.add(scenePanelState.lastClickedItem.id);
            } else {
                if (uuidToInstance) {
                    const inst = uuidToInstance.get(scenePanelState.lastClickedItem.id);
                    if (inst) {
                        sortedRangeObjects.set(inst.mesh, new Set([inst.instanceId]));
                    }
                }
            }

            rangeGroups.forEach(g => sortedRangeGroups.add(g));
            rangeObjects.forEach((ids, mesh) => {
                if (!sortedRangeObjects.has(mesh)) {
                    sortedRangeObjects.set(mesh, new Set());
                }
                const set = sortedRangeObjects.get(mesh)!;
                ids.forEach(id => set.add(id));
            });

            ud.replaceSelectionWithGroupsAndObjects?.(sortedRangeGroups, sortedRangeObjects, {
                anchorMode: 'default',
                primaryIsRangeStart: true
            });
            return;
        }
    }

    scenePanelState.lastClickedItem = clickedRow;

    let groupIds: Set<string> | null = null;
    let meshToIds: Map<Object3D, Set<number>> | null = null;

    if (el.dataset.displayType === 'group') {
        const groupId = el.dataset.groupId;
        if (groupId) groupIds = new Set([groupId]);
    } else {
        const uuidToInstance = ud.objectUuidToInstance;
        const uuid = el.dataset.uuid;
        if (uuidToInstance && uuid) {
            const inst = uuidToInstance.get(uuid);
            if (inst) {
                meshToIds = new Map([[inst.mesh, new Set([inst.instanceId])]]);
            }
        }
    }

    if (additive || boxSelect) {
        ud.addOrToggleInSelection?.(groupIds, meshToIds);
    } else {
        ud.replaceSelectionWithGroupsAndObjects?.(groupIds || new Set(), meshToIds || new Map(), {
            anchorMode: 'default',
            primaryIsRangeStart: true
        });
    }
}

export function syncScenePanelSelection(sel: ScenePanelSelectionState | null, expandAncestors = true): void {
    if (!scenePanelState.scenePanelList) return;

    scenePanelState.scenePanelList.querySelectorAll('.selected').forEach(el => el.classList.remove('selected'));

    if (!sel) return;

    let newPrimaryEl: HTMLElement | null = null;
    const ud = loadedObjectGroup.userData as LoadedObjectUserData;

    if (expandAncestors && expandSelectionAncestors(sel, ud)) {
        requestAnimationFrame(() => {
            window.dispatchEvent(new CustomEvent('pde:scene-updated'));
        });
        return;
    }

    for (const [index, el] of scenePanelState.renderedRowEls) {
        const row = scenePanelState.visibleRows[index];
        if (!row) continue;
        if (row.type === 'group') {
            if (sel.groups?.has(row.id)) el.classList.add('selected');
            if (sel.primary?.type === 'group' && sel.primary.id === row.id) newPrimaryEl = el;
        } else {
            const instance = ud.objectUuidToInstance?.get(row.id);
            if (!instance) continue;
            if (sel.objects?.get(instance.mesh)?.has(instance.instanceId)) el.classList.add('selected');
            if (sel.primary?.type === 'object' && sel.primary.mesh === instance.mesh && sel.primary.instanceId === instance.instanceId) newPrimaryEl = el;
        }
    }

    if (newPrimaryEl) {
        scenePanelState.lastClickedItem = getRowFromElement(newPrimaryEl);
    } else if (!sel.primary && sel.groups?.size === 0 && sel.objects?.size === 0) {
        scenePanelState.lastClickedItem = null;
    }
}
