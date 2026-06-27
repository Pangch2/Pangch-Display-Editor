import type { Object3D } from 'three/webgpu';
import { loadedObjectGroup } from '../load-project/upload-pbde';
import type { ScenePanelSelectionState, LoadedObjectUserData } from './scene-panel-types';
import { scenePanelState } from './scene-panel-state';

export function handleSceneItemClick(e: MouseEvent, el: HTMLElement): void {
    if (Date.now() < scenePanelState.suppressSceneItemClickUntil) {
        e.preventDefault();
        e.stopPropagation();
        return;
    }

    const ud = loadedObjectGroup.userData as LoadedObjectUserData;
    if (!ud) return;

    if (e.ctrlKey && e.shiftKey && scenePanelState.lastClickedItem && scenePanelState.lastClickedItem !== el && scenePanelState.scenePanelList) {
        const visibleItems = Array.from(scenePanelState.scenePanelList.querySelectorAll('.scene-object-item, .scene-tree-group'))
            .filter(node => (node as HTMLElement).offsetParent !== null) as HTMLElement[];

        const idx1 = visibleItems.indexOf(scenePanelState.lastClickedItem);
        const idx2 = visibleItems.indexOf(el);

        if (idx1 !== -1 && idx2 !== -1) {
            const start = Math.min(idx1, idx2);
            const end = Math.max(idx1, idx2);

            const rangeGroups = new Set<string>();
            const rangeObjects = new Map<Object3D, Set<number>>();
            const uuidToInstance = ud.objectUuidToInstance;

            const selectedNodes = scenePanelState.scenePanelList.querySelectorAll('.selected') as NodeListOf<HTMLElement>;
            selectedNodes.forEach(node => {
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
                const node = visibleItems[i];
                if (node.dataset.displayType === 'group') {
                    const gId = node.dataset.groupId;
                    if (gId) {
                        rangeGroups.add(gId);
                    }
                } else {
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
            }

            const sortedRangeGroups = new Set<string>();
            const sortedRangeObjects = new Map<Object3D, Set<number>>();

            if (scenePanelState.lastClickedItem.dataset.displayType === 'group') {
                const gId = scenePanelState.lastClickedItem.dataset.groupId;
                if (gId) sortedRangeGroups.add(gId);
            } else {
                const uuid = scenePanelState.lastClickedItem.dataset.uuid;
                if (uuid && uuidToInstance) {
                    const inst = uuidToInstance.get(uuid);
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

    scenePanelState.lastClickedItem = el;

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

function expandAncestors(el: HTMLElement): void {
    if (!scenePanelState.scenePanelList) return;
    let node = el.parentElement;
    while (node && node !== scenePanelState.scenePanelList) {
        if (node.classList.contains('scene-tree-children') && node.classList.contains('collapsed')) {
            node.classList.remove('collapsed');
            const header = node.previousElementSibling as HTMLElement | null;
            if (header?.classList.contains('scene-tree-group')) {
                const gId = header.dataset.groupId;
                if (gId) scenePanelState.expandedGroupIds.add(gId);
                const toggle = header.querySelector('.scene-toggle');
                if (toggle) toggle.innerHTML = '&#xE06D;';
            }
        }
        node = node.parentElement;
    }
}

export function syncScenePanelSelection(sel: ScenePanelSelectionState | null): void {
    if (!scenePanelState.scenePanelList) return;

    scenePanelState.scenePanelList.querySelectorAll('.selected').forEach(el => el.classList.remove('selected'));

    if (!sel) return;

    let newPrimaryEl: HTMLElement | null = null;
    const ud = loadedObjectGroup.userData as LoadedObjectUserData;

    if (sel.groups && sel.groups.size > 0) {
        for (const groupId of sel.groups) {
            const el = scenePanelState.scenePanelList.querySelector(`.scene-tree-group[data-group-id="${groupId}"]`) as HTMLElement | null;
            if (el) {
                el.classList.add('selected');
                expandAncestors(el);
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
                        expandAncestors(el);
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
        scenePanelState.lastClickedItem = newPrimaryEl;
    } else if (!sel.primary && sel.groups?.size === 0 && sel.objects?.size === 0) {
        scenePanelState.lastClickedItem = null;
    }
}
