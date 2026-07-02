import type { Object3D } from 'three/webgpu';
import { loadedObjectGroup } from '../load-project/upload-pbde';
import type { ScenePanelRow, ScenePanelSelectionState, LoadedObjectUserData } from './scene-panel-types';
import { scenePanelState } from './scene-panel-state';

function getRowFromElement(el: HTMLElement): ScenePanelRow | null {
    const visibleIndex = Number(el.dataset.visibleIndex);
    if (!Number.isInteger(visibleIndex)) return null;
    return scenePanelState.visibleRows[visibleIndex] ?? null;
}

function expandGroupAncestors(groupId: string, ud: LoadedObjectUserData, includeSelf = false): boolean {
    const groups = ud.groups;
    if (!groups) return false;

    let changed = false;
    let current: string | null = includeSelf ? groupId : (groups.get(groupId)?.parent ?? null);

    while (current) {
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
    if (inst) {
        const mappedParentId = ud.objectToGroup?.get(`${inst.mesh.uuid}_${inst.instanceId}`);
        if (mappedParentId) return mappedParentId;
    }

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

    if (sel.groups) {
        for (const groupId of sel.groups) {
            changed = expandGroupAncestors(groupId, ud) || changed;
        }
    }

    if (sel.objects) {
        const keyToUuid = ud.instanceKeyToObjectUuid;
        if (keyToUuid) {
            for (const [mesh, ids] of sel.objects) {
                for (const instanceId of ids) {
                    const uuid = keyToUuid.get(`${mesh.uuid}_${instanceId}`);
                    if (!uuid) continue;
                    const parentGroupId = findObjectParentGroupId(uuid, ud);
                    if (parentGroupId) {
                        changed = expandGroupAncestors(parentGroupId, ud, true) || changed;
                    }
                }
            }
        }
    }

    if (sel.primary?.type === 'group') {
        changed = expandGroupAncestors(sel.primary.id, ud) || changed;
    } else if (sel.primary?.type === 'object') {
        const uuid = ud.instanceKeyToObjectUuid?.get(`${sel.primary.mesh.uuid}_${sel.primary.instanceId}`);
        if (uuid) {
            const parentGroupId = findObjectParentGroupId(uuid, ud);
            if (parentGroupId) {
                changed = expandGroupAncestors(parentGroupId, ud, true) || changed;
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

    if (e.ctrlKey && e.shiftKey && scenePanelState.lastClickedItem && scenePanelState.lastClickedItem !== clickedRow) {
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

    if (e.shiftKey || e.ctrlKey || e.metaKey) {
        ud.addOrToggleInSelection?.(groupIds, meshToIds);
    } else {
        ud.replaceSelectionWithGroupsAndObjects?.(groupIds || new Set(), meshToIds || new Map(), { anchorMode: 'default' });
    }
}

export function syncScenePanelSelection(sel: ScenePanelSelectionState | null): void {
    if (!scenePanelState.scenePanelList) return;

    scenePanelState.scenePanelList.querySelectorAll('.selected').forEach(el => el.classList.remove('selected'));

    if (!sel) return;

    let newPrimaryEl: HTMLElement | null = null;
    const ud = loadedObjectGroup.userData as LoadedObjectUserData;

    if (expandSelectionAncestors(sel, ud)) {
        requestAnimationFrame(() => {
            window.dispatchEvent(new CustomEvent('pde:scene-updated'));
        });
        return;
    }

    if (sel.groups && sel.groups.size > 0) {
        for (const groupId of sel.groups) {
            const el = scenePanelState.scenePanelList.querySelector(`.scene-tree-group[data-group-id="${groupId}"]`) as HTMLElement | null;
            if (el) {
                el.classList.add('selected');
            }
        }
    }

    if (sel.objects && sel.objects.size > 0) {
        const keyToUuid = ud.instanceKeyToObjectUuid;
        if (keyToUuid) {
            for (const [mesh, ids] of sel.objects) {
                for (const instanceId of ids) {
                    const uuid = keyToUuid.get(`${mesh.uuid}_${instanceId}`);
                    if (!uuid) continue;
                    const el = scenePanelState.scenePanelList.querySelector(`.scene-object-item[data-uuid="${uuid}"]`) as HTMLElement | null;
                    if (el) {
                        el.classList.add('selected');
                    }
                }
            }
        }
    }

    if (sel.primary) {
        if (sel.primary.type === 'group') {
            newPrimaryEl = scenePanelState.scenePanelList.querySelector(`.scene-tree-group[data-group-id="${sel.primary.id}"]`) as HTMLElement | null;
        } else if (sel.primary.type === 'object') {
            const uuid = ud.instanceKeyToObjectUuid?.get(`${sel.primary.mesh.uuid}_${sel.primary.instanceId}`);
            if (uuid) {
                newPrimaryEl = scenePanelState.scenePanelList.querySelector(`.scene-object-item[data-uuid="${uuid}"]`) as HTMLElement | null;
            }
        }
    }

    if (newPrimaryEl) {
        scenePanelState.lastClickedItem = getRowFromElement(newPrimaryEl);
    } else if (!sel.primary && sel.groups?.size === 0 && sel.objects?.size === 0) {
        scenePanelState.lastClickedItem = null;
    }
}
