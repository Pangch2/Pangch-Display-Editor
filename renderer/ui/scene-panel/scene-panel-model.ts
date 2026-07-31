import type { Object3D } from 'three/webgpu';
import { scenePanelState } from './scene-panel-state';
import type {
    GroupChild,
    GroupData,
    LoadedObjectUserData,
    SceneMoveEntry,
    SceneInsertionPoint,
    SceneItemLocation,
    SceneOrderEntry,
    SceneDropHint,
    SceneDragBundle
} from './scene-panel-types';

export function cleanLabel(rawName: string): string {
    return (rawName || '')
        .replace(/^[^:]+:/, '')
        .replace(/\[.*\]$/, '')
        .trim();
}

export function resolveChildObjectUuid(child: GroupChild, ud: LoadedObjectUserData): string | null {
    if (child.type !== 'object') return null;
    if (child.id) return child.id;
    if (!child.mesh || typeof child.instanceId !== 'number') return null;
    return ud.instanceKeyToObjectUuid?.get(`${child.mesh.uuid}_${child.instanceId}`) ?? null;
}

export function isObjectUuidGrouped(uuid: string, ud: LoadedObjectUserData): boolean {
    const inst = ud.objectUuidToInstance?.get(uuid);
    if (!inst) return false;
    const key = `${inst.mesh.uuid}_${inst.instanceId}`;
    return ud.objectToGroup?.has(key) ?? false;
}

export function hasRenderableObject(uuid: string, ud: LoadedObjectUserData): boolean {
    return ud.objectUuidToInstance?.has(uuid) ?? false;
}

export function ensureSceneOrderSeeded(ud: LoadedObjectUserData): SceneOrderEntry[] {
    if (!Array.isArray(ud.sceneOrder)) {
        ud.sceneOrder = [];
    }

    const sceneOrder = ud.sceneOrder;
    if (sceneOrder.length > 0 || !scenePanelState.scenePanelList) return sceneOrder;

    const seen = new Set<string>();
    const pushRootEntry = (entry: SceneOrderEntry): void => {
        const key = `${entry.type}:${entry.id}`;
        if (seen.has(key)) return;
        seen.add(key);
        sceneOrder.push(entry);
    };

    for (const row of scenePanelState.visibleRows) {
        if (row.parentGroupId !== null) continue;
        pushRootEntry({ type: row.type, id: row.id });
    }

    return sceneOrder;
}

export function getParentGroupIdFromElement(el: HTMLElement): string | null {
    const parentGroupId = el.dataset.parentGroupId;
    if (parentGroupId !== undefined) return parentGroupId || null;
    if (!scenePanelState.scenePanelList) return null;

    let node = el.parentElement;
    while (node && node !== scenePanelState.scenePanelList) {
        if (node.classList.contains('scene-tree-children')) {
            const header = node.previousElementSibling as HTMLElement | null;
            if (header?.classList.contains('scene-tree-group')) {
                return header.dataset.groupId || null;
            }
        }
        node = node.parentElement;
    }

    return null;
}

export function getObjectInstanceByUuid(
    uuid: string,
    ud: LoadedObjectUserData
): { mesh: Object3D; instanceId: number } | null {
    return ud.objectUuidToInstance?.get(uuid) ?? null;
}

export function getObjectGroupKeyByUuid(uuid: string, ud: LoadedObjectUserData): string | null {
    const inst = getObjectInstanceByUuid(uuid, ud);
    if (!inst) return null;
    return `${inst.mesh.uuid}_${inst.instanceId}`;
}

export function findObjectChildIndexByUuid(children: GroupChild[], objectUuid: string, ud: LoadedObjectUserData): number {
    for (let i = 0; i < children.length; i++) {
        const child = children[i];
        if (!child || child.type !== 'object') continue;
        if (resolveChildObjectUuid(child, ud) === objectUuid) return i;
    }
    return -1;
}

export function findGroupLocation(groupId: string, ud: LoadedObjectUserData): SceneItemLocation | null {
    const groups = ud.groups;
    if (!groups) return null;

    const group = groups.get(groupId);
    if (group?.parent) {
        const parent = groups.get(group.parent);
        if (parent) {
            if (!Array.isArray(parent.children)) parent.children = [];
            const idx = parent.children.findIndex((child) => child.type === 'group' && child.id === groupId);
            if (idx !== -1) {
                return {
                    parentGroupId: group.parent,
                    containerKind: 'group',
                    container: parent.children,
                    index: idx
                };
            }
        }
    }

    const sceneOrder = ensureSceneOrderSeeded(ud);
    const rootIdx = sceneOrder.findIndex((entry) => entry.type === 'group' && entry.id === groupId);
    if (rootIdx !== -1) {
        return {
            parentGroupId: null,
            containerKind: 'scene',
            container: sceneOrder,
            index: rootIdx
        };
    }

    if (group && group.parent === null) {
        sceneOrder.push({ type: 'group', id: groupId });
        return {
            parentGroupId: null,
            containerKind: 'scene',
            container: sceneOrder,
            index: sceneOrder.length - 1
        };
    }

    for (const [parentId, parent] of groups) {
        if (!Array.isArray(parent.children)) continue;
        const idx = parent.children.findIndex((child) => child.type === 'group' && child.id === groupId);
        if (idx !== -1) {
            return {
                parentGroupId: parentId,
                containerKind: 'group',
                container: parent.children,
                index: idx
            };
        }
    }

    return null;
}

export function findObjectLocation(objectUuid: string, ud: LoadedObjectUserData): SceneItemLocation | null {
    const groups = ud.groups;
    const objectKey = getObjectGroupKeyByUuid(objectUuid, ud);
    const mappedParentId = objectKey ? (ud.objectToGroup?.get(objectKey) ?? null) : null;

    if (mappedParentId && groups) {
        const parent = groups.get(mappedParentId);
        if (parent) {
            if (!Array.isArray(parent.children)) parent.children = [];
            const idx = findObjectChildIndexByUuid(parent.children, objectUuid, ud);
            if (idx !== -1) {
                return {
                    parentGroupId: mappedParentId,
                    containerKind: 'group',
                    container: parent.children,
                    index: idx
                };
            }
        }
    }

    const sceneOrder = ensureSceneOrderSeeded(ud);
    const rootIdx = sceneOrder.findIndex((entry) => entry.type === 'object' && entry.id === objectUuid);
    if (rootIdx !== -1) {
        return {
            parentGroupId: null,
            containerKind: 'scene',
            container: sceneOrder,
            index: rootIdx
        };
    }

    if (groups) {
        for (const [parentId, parent] of groups) {
            if (!Array.isArray(parent.children)) continue;
            const idx = findObjectChildIndexByUuid(parent.children, objectUuid, ud);
            if (idx !== -1) {
                return {
                    parentGroupId: parentId,
                    containerKind: 'group',
                    container: parent.children,
                    index: idx
                };
            }
        }
    }

    if (hasRenderableObject(objectUuid, ud)) {
        sceneOrder.push({ type: 'object', id: objectUuid });
        return {
            parentGroupId: null,
            containerKind: 'scene',
            container: sceneOrder,
            index: sceneOrder.length - 1
        };
    }

    return null;
}

export function isGroupAncestorOf(groups: Map<string, GroupData>, ancestorId: string, candidateGroupId: string): boolean {
    let current: string | null = candidateGroupId;
    while (current) {
        if (current === ancestorId) return true;
        current = groups.get(current)?.parent ?? null;
    }
    return false;
}

export function resolveInsertionPointFromDropHint(hint: SceneDropHint, ud: LoadedObjectUserData): SceneInsertionPoint | null {
    const groups = ud.groups;
    const sceneOrder = ensureSceneOrderSeeded(ud);

    if (hint.mode === 'root-end' || hint.targetType === 'root') {
        return {
            parentGroupId: null,
            containerKind: 'scene',
            container: sceneOrder,
            index: sceneOrder.length
        };
    }

    if (hint.mode === 'inside') {
        if (hint.targetType !== 'group' || !hint.targetId || !groups) return null;
        const targetGroup = groups.get(hint.targetId);
        if (!targetGroup) return null;
        if (!Array.isArray(targetGroup.children)) targetGroup.children = [];
        return {
            parentGroupId: targetGroup.id,
            containerKind: 'group',
            container: targetGroup.children,
            index: targetGroup.children.length
        };
    }

    const targetLocation = hint.targetType === 'group'
        ? findGroupLocation(hint.targetId || '', ud)
        : findObjectLocation(hint.targetId || '', ud);
    if (!targetLocation) return null;

    return {
        parentGroupId: targetLocation.parentGroupId,
        containerKind: targetLocation.containerKind,
        container: targetLocation.container,
        index: targetLocation.index + (hint.mode === 'after' ? 1 : 0)
    };
}

export function moveSceneItemsByDropHint(bundle: SceneDragBundle, hint: SceneDropHint, ud: LoadedObjectUserData): boolean {
    const insertion = resolveInsertionPointFromDropHint(hint, ud);
    if (!insertion) return false;

    const moveEntries: SceneMoveEntry[] = [];
    const seen = new Set<string>();

    for (const item of bundle.items) {
        const itemKey = `${item.type}:${item.id}`;
        if (seen.has(itemKey)) continue;
        seen.add(itemKey);

        const location = item.type === 'group'
            ? findGroupLocation(item.id, ud)
            : findObjectLocation(item.id, ud);
        if (!location) continue;

        if (item.type === 'group') {
            if (!ud.groups?.has(item.id)) continue;
        } else if (!getObjectInstanceByUuid(item.id, ud)) {
            continue;
        }

        moveEntries.push({ item, location });
    }

    if (moveEntries.length === 0) return false;

    let insertionIndex = insertion.index;
    for (const entry of moveEntries) {
        if (entry.location.container === insertion.container && entry.location.index < insertionIndex) {
            insertionIndex--;
        }
    }

    const sameContainerEntries = moveEntries.filter((entry) => entry.location.container === insertion.container);
    if (sameContainerEntries.length === moveEntries.length) {
        const sortedIndices = sameContainerEntries
            .map((entry) => entry.location.index)
            .sort((a, b) => a - b);

        let isContiguous = true;
        for (let i = 1; i < sortedIndices.length; i++) {
            if (sortedIndices[i] !== sortedIndices[i - 1] + 1) {
                isContiguous = false;
                break;
            }
        }

        if (isContiguous && insertionIndex === sortedIndices[0]) {
            return false;
        }
    }

    const removalOrder = moveEntries.slice().sort((a, b) => {
        if (a.location.container === b.location.container) {
            return b.location.index - a.location.index;
        }
        return 0;
    });

    for (const entry of removalOrder) {
        const { container, index } = entry.location;
        if (index >= 0 && index < container.length) {
            container.splice(index, 1);
        }
    }

    insertionIndex = Math.max(0, Math.min(insertionIndex, insertion.container.length));
    let insertedCount = 0;

    for (const entry of moveEntries) {
        const item = entry.item;

        if (item.type === 'group') {
            const group = ud.groups?.get(item.id);
            if (!group) continue;

            group.parent = insertion.parentGroupId;

            if (insertion.containerKind === 'group') {
                (insertion.container as GroupChild[]).splice(insertionIndex + insertedCount, 0, { type: 'group', id: item.id });
            } else {
                (insertion.container as SceneOrderEntry[]).splice(insertionIndex + insertedCount, 0, { type: 'group', id: item.id });
            }

            insertedCount++;
            continue;
        }

        const inst = getObjectInstanceByUuid(item.id, ud);
        if (!inst) continue;

        if (!ud.objectToGroup) ud.objectToGroup = new Map<string, string>();
        const objectKey = `${inst.mesh.uuid}_${inst.instanceId}`;
        if (insertion.parentGroupId) {
            ud.objectToGroup.set(objectKey, insertion.parentGroupId);
        } else {
            ud.objectToGroup.delete(objectKey);
        }

        if (insertion.containerKind === 'group') {
            (insertion.container as GroupChild[]).splice(insertionIndex + insertedCount, 0, {
                type: 'object',
                id: item.id,
                mesh: inst.mesh,
                instanceId: inst.instanceId
            });
        } else {
            (insertion.container as SceneOrderEntry[]).splice(insertionIndex + insertedCount, 0, {
                type: 'object',
                id: item.id
            });
        }

        insertedCount++;
    }

    return insertedCount > 0;
}
