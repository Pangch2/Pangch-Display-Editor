import { Color, Matrix4, Group, InstancedMesh, BufferGeometry, InstancedBufferAttribute, Quaternion, Vector3 } from 'three/webgpu';
import * as GroupUtils from './group';
import type { GroupData, GroupChild } from './group';
import { batchOf, objectRef, objectUuidAt, type ObjectBatch } from '../../scene-store/object-access';
import { captureBatchRemoval, disposeRemovedBatch, removeInstances, restoreBatchRemoval, type BatchRemovalState } from '../../scene-store/object-batches';
import { ObjectStore } from '../../scene-store/object-store';

import { removeAnimationTargets } from '../../animation/animation-state';

interface SceneOrderEntry {
    type: 'group' | 'object';
    id: string;
}

interface DeleteUserData {
    objectUuidToInstance?: ObjectStore<{ mesh: ObjectBatch; instanceId: number }>;
    objectNames?: Map<string, string>;
    objectLabels?: Map<string, string>;
    objectIsItemDisplay?: Set<string>;
    objectDisplayTypes?: Map<string, string>;
    objectBlockProps?: Map<string, unknown>;
    objectTextDisplayOptions?: Map<string, unknown>;
    objectTextures?: Map<string, string>;
    objectNbt?: Map<string, string>;
    objectBrightness?: Map<string, unknown>;
    objectPivots?: Map<string, unknown>;
    objectIsCustomPivot?: Map<string, boolean>;
    objectDisplayKinds?: Map<string, string>;
    sceneOrder?: SceneOrderEntry[];
    cleanupUnusedPlayerHeadAtlasSlots?: () => void;
    capturePlayerHeadAtlasState?: (targets?: Iterable<string> | Map<ObjectBatch, Iterable<number>>) => unknown;
    restorePlayerHeadAtlasState?: (state: unknown) => void;
}

interface EntryState<K, V> {
    key: K;
    has: boolean;
    value?: V;
}

export interface DeletedSceneDelta {
    deletedUuids: Set<string>;
    undo(): void;
    redo(): void;
    dispose(): void;
}

function _removeDeletedObjectMetadata(loadedObjectGroup: Group, mesh: ObjectBatch, instanceId: number): string | undefined {
    const ud = loadedObjectGroup.userData as DeleteUserData;
    const objectUuid = objectUuidAt(loadedObjectGroup, mesh, instanceId);
    if (!objectUuid) return undefined;

    ud.objectUuidToInstance?.delete(objectUuid);
    ud.objectNames?.delete(objectUuid);
    ud.objectLabels?.delete(objectUuid);
    ud.objectIsItemDisplay?.delete(objectUuid);
    ud.objectDisplayTypes?.delete(objectUuid);
    ud.objectBlockProps?.delete(objectUuid);
    ud.objectTextDisplayOptions?.delete(objectUuid);
    ud.objectTextures?.delete(objectUuid);
    ud.objectNbt?.delete(objectUuid);
    ud.objectBrightness?.delete(objectUuid);
    ud.objectPivots?.delete(objectUuid);
    ud.objectIsCustomPivot?.delete(objectUuid);
    ud.objectDisplayKinds?.delete(objectUuid);

    return objectUuid;
}

export interface DeleteSelectionCallbacks {
    resetSelectionAndDeselect: () => void;
    preserveAnimation?: boolean;
    undoable?: boolean;
}

/**
 * 선택된 모든 그룹 및 객체를 씬과 데이터 구조에서 영구 삭제
 */
export function deleteSelectedItems(
    loadedObjectGroup: Group, 
    currentSelection: { groups: Set<string>; objects: Map<ObjectBatch, Set<number>> }, 
    { resetSelectionAndDeselect, preserveAnimation = false, undoable = true }: DeleteSelectionCallbacks
): DeletedSceneDelta | null {
    const itemsToDelete = new Map<string, { mesh: ObjectBatch; instanceId: number }>();

    const collectItem = (mesh: ObjectBatch, instanceId: number) => {
        if (!mesh) return;
        const k = GroupUtils.getGroupKey(mesh, instanceId);
        if (!itemsToDelete.has(k)) {
            itemsToDelete.set(k, { mesh, instanceId });
        }
    };

    const groups = GroupUtils.getGroups(loadedObjectGroup) as Map<string, GroupData>;
    const objectToGroup = GroupUtils.getObjectToGroup(loadedObjectGroup) as Map<string, string>;
    const allGroupsToDelete = new Set<string>();
    const pendingGroups = [...currentSelection.groups];
    while (pendingGroups.length) {
        const gid = pendingGroups.pop()!;
        if (!gid || allGroupsToDelete.has(gid)) continue;
        allGroupsToDelete.add(gid);
        for (const child of groups.get(gid)?.children ?? []) {
            if (child.type === 'group') pendingGroups.push(child.id);
        }
    }

    for (const gid of allGroupsToDelete) {
        const g = groups.get(gid);
        if (g && Array.isArray(g.children)) {
            for (const child of g.children) {
                const ref = child.type === 'object' ? objectRef(loadedObjectGroup, child.id) : undefined;
                if (ref) collectItem(ref.mesh, ref.instanceId);
            }
        }
    }

    // 2. 개별 선택된 객체 식별
    if (currentSelection.objects && currentSelection.objects.size > 0) {
        for (const [mesh, ids] of currentSelection.objects) {
            if (!mesh || !ids) continue;
            for (const id of ids) {
                collectItem(mesh, id);
            }
        }
    }

    if (itemsToDelete.size === 0 && allGroupsToDelete.size === 0) return null;

    const userData = loadedObjectGroup.userData as DeleteUserData & Record<string, unknown>;
    const mapEntry = <K, V>(map: Map<K, V> | undefined, key: K): EntryState<K, V> => ({ key, has: !!map?.has(key), value: map?.get(key) });
    const restoreEntries = <K, V>(map: Map<K, V> | undefined, entries: EntryState<K, V>[]): void => {
        if (!map) return;
        entries.forEach(entry => entry.has ? map.set(entry.key, entry.value!) : map.delete(entry.key));
    };
    const byMesh = new Map<ObjectBatch, Set<number>>();
    const selectedGroupIds = new Set(currentSelection.groups);
    for (const { mesh, instanceId } of itemsToDelete.values()) {
        const ids = byMesh.get(mesh) ?? new Set<number>();
        ids.add(instanceId);
        byMesh.set(mesh, ids);
    }
    // Batches as they were, with the slots the deletion removes or swap-moves.
    const meshStates: BatchRemovalState[] = [...byMesh].map(([mesh, ids]) => captureBatchRemoval(mesh, ids, undoable));
    const affectedSlots = meshStates.flatMap(state => state.touched.map(id => [state.batch, id] as const));
    const selectedUuids = new Set([...itemsToDelete.values()].flatMap(({ mesh, instanceId }) => {
        const uuid = objectUuidAt(loadedObjectGroup, mesh, instanceId);
        return uuid ? [uuid] : [];
    }));
    const playerHeadAtlasState = userData.capturePlayerHeadAtlasState?.(new Map(byMesh));
    const objectToGroupEntries = [...selectedUuids].map(uuid => mapEntry(objectToGroup, uuid));
    // Restoring their refs restores the store's slot side too.
    const affectedUuids = new Set(affectedSlots.flatMap(([mesh, id]) => objectUuidAt(loadedObjectGroup, mesh, id) ?? []));
    const uuidMapNames = [
        'objectUuidToInstance', 'objectNames', 'objectLabels', 'objectDisplayTypes', 'objectBlockProps',
        'objectTextDisplayOptions', 'objectTextures', 'objectNbt', 'objectBrightness', 'objectPivots', 'objectIsCustomPivot', 'objectDisplayKinds'
    ] as const;
    const uuidMapEntries = uuidMapNames.flatMap(name => {
        const map = userData[name] as Map<string, unknown> | undefined;
        return map ? [[map, [...affectedUuids].map(uuid => mapEntry(map, uuid))] as const] : [];
    });
    const itemDisplayEntries = [...affectedUuids].map(uuid => ({ key: uuid, has: userData.objectIsItemDisplay?.has(uuid) ?? false }));
    const affectedGroupIds = new Set<string>(allGroupsToDelete);
    for (const entry of objectToGroupEntries) if (entry.value) affectedGroupIds.add(entry.value);
    for (const groupId of allGroupsToDelete) {
        const parentId = groups.get(groupId)?.parent;
        if (parentId) affectedGroupIds.add(parentId);
    }
    const groupEntries = [...affectedGroupIds].map(id => mapEntry(groups, id));
    const groupChildren = [...affectedGroupIds].flatMap(id => {
        const group = groups.get(id);
        return group ? [[group, group.children.map(child => ({ ...child }))] as const] : [];
    });
    const sceneOrder = userData.sceneOrder?.slice();
    const capturePairEntries = (map: Map<string, string> | undefined, ids: Iterable<string>) => {
        const keys = new Set<string>();
        for (const id of ids) {
            keys.add(id);
            const partner = map?.get(id);
            if (partner) keys.add(partner);
        }
        return [...keys].map(key => mapEntry(map, key));
    };
    const objectMirrorPairs = userData.objectMirrorPairs as Map<string, string> | undefined;
    const groupMirrorPairs = userData.groupMirrorPairs as Map<string, string> | undefined;
    const objectMirrorEntries = capturePairEntries(objectMirrorPairs, selectedUuids);
    const groupMirrorEntries = capturePairEntries(groupMirrorPairs, allGroupsToDelete);
    const restoreAnimation = preserveAnimation ? () => {} : removeAnimationTargets(loadedObjectGroup, new Set([...selectedUuids, ...allGroupsToDelete]));

    // 3. 그룹 구조 정리
    for (const gid of affectedGroupIds) {
        if (allGroupsToDelete.has(gid)) continue;
        const parent = groups.get(gid);
        if (parent) parent.children = parent.children.filter(child => child.type !== 'group' || !allGroupsToDelete.has(child.id));
    }

    for (const gid of allGroupsToDelete) {
        groups.delete(gid);
    }

    // 4. 객체 삭제 처리 (메쉬별 그룹화)
    const deletedUuidsByGroup = new Map<string, Set<string>>();
    const deletedObjectUuids = new Set<string>();

    for (const { mesh, instanceId } of itemsToDelete.values()) {
        const objectUuid = _removeDeletedObjectMetadata(loadedObjectGroup, mesh, instanceId);
        if (!objectUuid) continue;
        deletedObjectUuids.add(objectUuid);
        const parentGroupId = objectToGroup.get(objectUuid);
        if (parentGroupId) {
            if (groups.has(parentGroupId)) {
                let deletedUuids = deletedUuidsByGroup.get(parentGroupId);
                if (!deletedUuids) deletedUuidsByGroup.set(parentGroupId, deletedUuids = new Set());
                deletedUuids.add(objectUuid);
            }
            objectToGroup.delete(objectUuid);
        }
    }

    for (const [groupId, deletedUuids] of deletedUuidsByGroup) {
        const group = groups.get(groupId);
        if (group) group.children = group.children.filter(child => child.type !== 'object' || !deletedUuids.has(child.id));
    }

    if (Array.isArray(userData.sceneOrder)) {
        userData.sceneOrder = userData.sceneOrder.filter(entry => (
            (entry.type !== 'object' || !deletedObjectUuids.has(entry.id))
            && (entry.type !== 'group' || !allGroupsToDelete.has(entry.id))
        ));
    }

    resetSelectionAndDeselect();

    // 5. 실제 메쉬 인스턴스 제거 실행
    for (const [mesh, idSet] of byMesh) removeInstances(loadedObjectGroup, mesh, Array.from(idSet).sort((a, b) => b - a));
    const removePairs = (map: Map<string, string> | undefined, ids: Iterable<string>) => {
        for (const id of ids) {
            const partner = map?.get(id);
            map?.delete(id);
            if (partner) map?.delete(partner);
        }
    };
    removePairs(objectMirrorPairs, deletedObjectUuids);
    removePairs(groupMirrorPairs, allGroupsToDelete);
    if (Array.isArray(playerHeadAtlasState) && playerHeadAtlasState.length > 0) {
        userData.cleanupUnusedPlayerHeadAtlasSlots?.();
    }

    let deleted = true;
    return {
        deletedUuids: deletedObjectUuids,
        undo: () => {
            if (!undoable || !deleted) return;
            // Animation previews can move surviving logical objects into different physical batches.
            const moved = new Map<ObjectBatch, Set<number>>();
            for (const [map, entries] of uuidMapEntries) if (map === userData.objectUuidToInstance) for (const entry of entries) {
                const saved = entry.value as { mesh: ObjectBatch; instanceId: number } | undefined;
                const current = userData.objectUuidToInstance?.get(entry.key);
                if (!saved || !current || saved.mesh === current.mesh) continue;
                const ids = moved.get(current.mesh) ?? new Set<number>(); ids.add(current.instanceId); moved.set(current.mesh, ids);
            }
            if (moved.size) deleteSelectedItems(loadedObjectGroup, { groups: new Set(), objects: moved },
                { resetSelectionAndDeselect: () => {}, preserveAnimation: true, undoable: false })?.dispose();
            meshStates.forEach(restoreBatchRemoval);
            restoreEntries(objectToGroup, objectToGroupEntries);
            uuidMapEntries.forEach(([map, entries]) => restoreEntries(map, entries));
            itemDisplayEntries.forEach(entry => entry.has ? userData.objectIsItemDisplay?.add(entry.key) : userData.objectIsItemDisplay?.delete(entry.key));
            restoreEntries(groups, groupEntries);
            groupChildren.forEach(([group, children]) => { group.children = children.map(child => ({ ...child })); });
            if (sceneOrder) userData.sceneOrder = sceneOrder.slice();
            restoreEntries(objectMirrorPairs, objectMirrorEntries);
            restoreEntries(groupMirrorPairs, groupMirrorEntries);
            if (playerHeadAtlasState !== undefined) userData.restorePlayerHeadAtlasState?.(playerHeadAtlasState);
            loadedObjectGroup.updateMatrixWorld(true);
            restoreAnimation();
            deleted = false;
        },
        redo: () => {
            if (!undoable || deleted) return;
            const objects = new Map<ObjectBatch, Set<number>>();
            for (const uuid of selectedUuids) {
                const ref = userData.objectUuidToInstance?.get(uuid);
                if (!ref) continue;
                let ids = objects.get(ref.mesh);
                if (!ids) objects.set(ref.mesh, ids = new Set());
                ids.add(ref.instanceId);
            }
            deleteSelectedItems(loadedObjectGroup, {
                groups: selectedGroupIds,
                objects: selectedUuids.size ? objects : new Map(Array.from(byMesh, ([mesh, ids]) => [mesh, new Set(ids)]))
            }, { resetSelectionAndDeselect: () => {}, preserveAnimation });
            deleted = true;
        },
        dispose: () => {
            if (!deleted) return;
            meshStates.forEach(disposeRemovedBatch);
        }
    };
}

if (import.meta.env.DEV) {
    const root = new Group();
    const instanced = new InstancedMesh(undefined, undefined, 1);
    instanced.count = 1;
    root.add(instanced);
    removeInstances(root, batchOf(instanced), [0]);
    console.assert(root.children.length === 0, 'An emptied batch must leave the scene.');

    const deltaRoot = new Group();
    const geometry = new BufferGeometry();
    const custom = new InstancedBufferAttribute(new Float32Array([10, 11, 12, 13, 14]), 1);
    geometry.setAttribute('customInstanceValue', custom);
    const deltaMesh = new InstancedMesh(geometry, undefined, 5);
    for (let instanceId = 0; instanceId < 5; instanceId++) {
        deltaMesh.setMatrixAt(instanceId, new Matrix4().makeTranslation(instanceId, 0, 0));
        deltaMesh.setColorAt(instanceId, new Color(instanceId / 5, 0, 0));
    }
    const children = Array.from({ length: 5 }, (_, instanceId) => ({ type: 'object' as const, id: `uuid-${instanceId}` }));
    deltaRoot.add(deltaMesh);
    deltaRoot.userData.groups = new Map<string, GroupData>([['group', {
        id: 'group', isCollection: false, children, parent: null, name: 'group',
        position: new Vector3(), quaternion: new Quaternion(), scale: new Vector3(1, 1, 1)
    }]]);
    deltaRoot.userData.objectToGroup = new Map(children.map(child => [child.id, 'group']));
    deltaRoot.userData.objectUuidToInstance = new ObjectStore(children.map((child, instanceId) => [child.id, { mesh: batchOf(deltaMesh), instanceId }]));
    deltaRoot.userData.objectNames = new Map(children.map(child => [child.id, child.id]));
    deltaRoot.userData.sceneOrder = children.map(child => ({ type: 'object', id: child.id }));
    let atlasCleanupCount = 0;
    let atlasRestored = false;
    deltaRoot.userData.capturePlayerHeadAtlasState = () => [{ regions: [{}] }];
    deltaRoot.userData.cleanupUnusedPlayerHeadAtlasSlots = () => { atlasCleanupCount++; };
    deltaRoot.userData.restorePlayerHeadAtlasState = () => { atlasRestored = true; };
    const delta = deleteSelectedItems(deltaRoot, {
        groups: new Set(), objects: new Map([[batchOf(deltaMesh), new Set([0, 2, 4])]])
    }, { resetSelectionAndDeselect: () => {} })!;
    console.assert(deltaMesh.count === 2 && atlasCleanupCount === 1, 'Partial deletion or atlas cleanup failed.');
    delta.undo();
    const restoredMatrices = Array.from({ length: 5 }, (_, instanceId) => deltaMesh.getMatrixAt(instanceId, new Matrix4()).elements[12]);
    console.assert(restoredMatrices.join() === '0,1,2,3,4', 'Deleted instance matrices were not restored.');
    console.assert(Array.from({ length: 5 }, (_, instanceId) => custom.getX(instanceId)).join() === '10,11,12,13,14', 'Deleted instanced attributes were not restored.');
    console.assert(deltaRoot.userData.objectUuidToInstance.size === 5
        && deltaRoot.userData.groups.get('group').children.map((child: GroupChild) => child.id).join() === 'uuid-0,uuid-1,uuid-2,uuid-3,uuid-4'
        && children.every((child, instanceId) => deltaRoot.userData.objectUuidToInstance.get(child.id)?.instanceId === instanceId)
        && deltaRoot.userData.sceneOrder.map((entry: SceneOrderEntry) => entry.id).join() === 'uuid-0,uuid-1,uuid-2,uuid-3,uuid-4'
        && atlasRestored,
    'Deleted UUID/group/order metadata was not restored.');
    delta.redo();
    console.assert(deltaMesh.count === 2, 'Partial deletion redo failed.');
}
