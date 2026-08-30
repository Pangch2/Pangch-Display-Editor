import {
    Color,
    Matrix4,
    Group,
    InterleavedBufferAttribute,
    Mesh,
    InstancedMesh,
    BufferAttribute,
    BufferGeometry,
    InstancedBufferAttribute,
    Quaternion,
    Vector3
} from 'three/webgpu';
import * as GroupUtils from './group';
import type { GroupData, GroupChild } from './group';

interface SceneOrderEntry {
    type: 'group' | 'object';
    id: string;
}

interface DeleteUserData {
    instanceKeyToObjectUuid?: Map<string, string>;
    objectUuidToInstance?: Map<string, { mesh: Mesh | InstancedMesh; instanceId: number }>;
    objectNames?: Map<string, string>;
    objectLabels?: Map<string, string>;
    objectIsItemDisplay?: Set<string>;
    objectDisplayTypes?: Map<string, string>;
    objectBlockProps?: Map<string, unknown>;
    objectTextDisplayOptions?: Map<string, unknown>;
    objectTextures?: Map<string, string>;
    objectNbt?: Map<string, string>;
    objectBrightness?: Map<string, unknown>;
    sceneOrder?: SceneOrderEntry[];
    cleanupUnusedPlayerHeadAtlasSlots?: () => void;
    capturePlayerHeadAtlasState?: (targets?: Iterable<string> | Map<InstancedMesh, Iterable<number>>) => unknown;
    restorePlayerHeadAtlasState?: (state: unknown) => void;
}

type InstancedGeometryAttribute = BufferAttribute | InterleavedBufferAttribute;

interface EntryState<K, V> {
    key: K;
    has: boolean;
    value?: V;
}

interface InstanceSlotState {
    instanceId: number;
    attributes: Array<{ attribute: InstancedGeometryAttribute; values: number[] }>;
    hasHat: EntryState<number, boolean>;
    imageHeadTilePosition: EntryState<number, [number, number]>;
    indexedUserData: Array<{ map: Map<number, unknown>; entry: EntryState<number, unknown> }>;
}

interface MeshDeleteState {
    mesh: Mesh | InstancedMesh;
    parent: Group | null;
    childIndex: number;
    count?: number;
    detachedWhole: boolean;
    slots: InstanceSlotState[];
}

export interface DeletedSceneDelta {
    deletedUuids: Set<string>;
    undo(): void;
    redo(): void;
    dispose(): void;
}

function isInstancedGeometryAttribute(attribute: unknown): attribute is InstancedGeometryAttribute {
    const candidate = attribute as BufferAttribute & {
        isInstancedBufferAttribute?: boolean;
        isInterleavedBufferAttribute?: boolean;
        data?: { isInstancedInterleavedBuffer?: boolean };
    };
    return !!(candidate?.isInstancedBufferAttribute
        || (candidate?.isInterleavedBufferAttribute && candidate.data?.isInstancedInterleavedBuffer));
}

// 성능을 위한 임시 변수
const _TMP_MAT4_A = new Matrix4();

function removeDeletedMesh(mesh: Mesh | InstancedMesh): void {
    mesh.removeFromParent();
}

function _removeDeletedObjectMetadata(loadedObjectGroup: Group, mesh: Mesh, instanceId: number): string | undefined {
    const ud = loadedObjectGroup.userData as DeleteUserData;
    const keyToUuid = ud.instanceKeyToObjectUuid;
    if (!keyToUuid) return undefined;

    const key = GroupUtils.getGroupKey(mesh, instanceId);
    const objectUuid = keyToUuid.get(key);
    keyToUuid.delete(key);

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

    return objectUuid;
}

/**
 * InstancedMesh에서 swap-pop 발생 시 그룹 내 인스턴스 ID 참조 업데이트
 * group.ts::updateGroupReferenceForMovedInstance 호출 래퍼
 */
function _updateGroupReferenceForMovedInstance(loadedObjectGroup: Group, mesh: Mesh, oldInstanceId: number, newInstanceId: number): void {
    GroupUtils.updateGroupReferenceForMovedInstance(loadedObjectGroup, mesh, oldInstanceId, newInstanceId);
}

/**
 * InstancedMesh 인스턴스 삭제 (Swap-Pop 방식)
 */
function _deleteInstancedMeshInstances(loadedObjectGroup: Group, mesh: InstancedMesh, instanceIdsSortedDescending: number[]): void {
    if (!mesh || !mesh.isInstancedMesh) return;

    const instanceMatrix = mesh.instanceMatrix;
    const uvAttr = (mesh.geometry && mesh.geometry.attributes) ? (mesh.geometry.attributes.instancedUvOffset as BufferAttribute) : null;
    const hasHatArray = mesh.userData ? (mesh.userData.hasHat as boolean[]) : null;

    const swapData = (srcIdx: number, dstIdx: number) => {
        // 행렬 복사
        _TMP_MAT4_A.fromArray(instanceMatrix.array as number[], srcIdx * 16);
        _TMP_MAT4_A.toArray(instanceMatrix.array as number[], dstIdx * 16);

        for (const attribute of Object.values(mesh.geometry.attributes)) {
            if (!isInstancedGeometryAttribute(attribute)) continue;
            const instanced = attribute;
            if (instanced.isInterleavedBufferAttribute) {
                for (let component = 0; component < instanced.itemSize; component++) {
                    instanced.setComponent(dstIdx, component, instanced.getComponent(srcIdx, component));
                }
            } else {
                const source = srcIdx * instanced.itemSize;
                instanced.array.copyWithin(dstIdx * instanced.itemSize, source, source + instanced.itemSize);
            }
            instanced.needsUpdate = true;
        }
        if (mesh.instanceColor) {
            const source = srcIdx * mesh.instanceColor.itemSize;
            mesh.instanceColor.array.copyWithin(dstIdx * mesh.instanceColor.itemSize, source, source + mesh.instanceColor.itemSize);
        }

        // Hat 여부 복사
        if (Array.isArray(hasHatArray)) {
            hasHatArray[dstIdx] = hasHatArray[srcIdx];
        }
        const imageHeadTilePositions = mesh.userData.imageHeadTilePositions as Array<[number, number]> | undefined;
        if (imageHeadTilePositions) {
            if (srcIdx in imageHeadTilePositions) imageHeadTilePositions[dstIdx] = imageHeadTilePositions[srcIdx];
            else delete imageHeadTilePositions[dstIdx];
            delete imageHeadTilePositions[srcIdx];
        }
        for (const key of ['customPivots', 'localMatrices', 'displayTypes', 'textDisplayTemplateKeys'] as const) {
            const values = mesh.userData[key] as Map<number, unknown> | undefined;
            if (values?.has(srcIdx)) values.set(dstIdx, values.get(srcIdx));
            else values?.delete(dstIdx);
            values?.delete(srcIdx);
        }
    };

    for (const deleteIdx of instanceIdsSortedDescending) {
        const lastIdx = mesh.count - 1;
        
        if (deleteIdx < lastIdx) {
            swapData(lastIdx, deleteIdx);
            // 마지막 인스턴스가 삭제된 위치로 이동했으므로 그룹 참조 갱신
            _updateGroupReferenceForMovedInstance(loadedObjectGroup, mesh, lastIdx, deleteIdx);
        }
        
        mesh.count--;
    }

    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    if (uvAttr) uvAttr.needsUpdate = true;
    if (mesh.count === 0) removeDeletedMesh(mesh);
}

export interface DeleteSelectionCallbacks {
    resetSelectionAndDeselect: () => void;
}

/**
 * 선택된 모든 그룹 및 객체를 씬과 데이터 구조에서 영구 삭제
 */
export function deleteSelectedItems(
    loadedObjectGroup: Group, 
    currentSelection: { groups: Set<string>; objects: Map<Mesh, Set<number>> }, 
    { resetSelectionAndDeselect }: DeleteSelectionCallbacks
): DeletedSceneDelta | null {
    const itemsToDelete = new Map<string, { mesh: Mesh; instanceId: number }>();

    const collectItem = (mesh: Mesh, instanceId: number) => {
        if (!mesh) return;
        const k = GroupUtils.getGroupKey(mesh, instanceId);
        if (!itemsToDelete.has(k)) {
            itemsToDelete.set(k, { mesh, instanceId });
        }
    };

    const allGroupsToDelete = new Set<string>();
    if (currentSelection.groups && currentSelection.groups.size > 0) {
        for (const gid of currentSelection.groups) {
            if (gid) {
                allGroupsToDelete.add(gid);
                const descendants = GroupUtils.getAllDescendantGroups(loadedObjectGroup, gid);
                for (const d of descendants) allGroupsToDelete.add(d);
            }
        }
    }

    const groups = GroupUtils.getGroups(loadedObjectGroup) as Map<string, GroupData>;
    const objectToGroup = GroupUtils.getObjectToGroup(loadedObjectGroup) as Map<string, string>;

    for (const gid of allGroupsToDelete) {
        const g = groups.get(gid);
        if (g && Array.isArray(g.children)) {
            for (const child of g.children) {
                if (child.type === 'object') {
                    collectItem(child.mesh, child.instanceId);
                }
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
    const byMesh = new Map<Mesh, Set<number>>();
    const selectedGroupIds = new Set(currentSelection.groups);
    for (const { mesh, instanceId } of itemsToDelete.values()) {
        const ids = byMesh.get(mesh) ?? new Set<number>();
        ids.add(instanceId);
        byMesh.set(mesh, ids);
    }
    const affectedKeys = new Set<string>();
    const meshStates: MeshDeleteState[] = [];
    for (const [mesh, ids] of byMesh) {
        const parent = mesh.parent as Group | null;
        const childIndex = parent?.children.indexOf(mesh) ?? -1;
        if (!(mesh as InstancedMesh).isInstancedMesh) {
            affectedKeys.add(GroupUtils.getGroupKey(mesh, 0));
            meshStates.push({ mesh, parent, childIndex, detachedWhole: true, slots: [] });
            continue;
        }
        const instanced = mesh as InstancedMesh;
        const detachedWhole = ids.size === instanced.count;
        const touchedIds = new Set(ids);
        let remaining = instanced.count;
        for (let index = 0; index < ids.size; index++) touchedIds.add(--remaining);
        touchedIds.forEach(id => affectedKeys.add(GroupUtils.getGroupKey(mesh, id)));
        const attributes = [
            instanced.instanceMatrix,
            instanced.instanceColor,
            ...Object.values(instanced.geometry.attributes).filter(isInstancedGeometryAttribute)
        ].filter((attribute, index, values): attribute is InstancedGeometryAttribute => !!attribute && values.indexOf(attribute) === index);
        const slots = detachedWhole ? [] : [...ids].map(instanceId => ({
            instanceId,
            attributes: attributes.map(attribute => ({
                attribute,
                values: Array.from({ length: attribute.itemSize }, (_, component) => attribute.getComponent(instanceId, component))
            })),
            hasHat: {
                key: instanceId,
                has: Array.isArray(instanced.userData.hasHat) && instanceId in instanced.userData.hasHat,
                value: (instanced.userData.hasHat as boolean[] | undefined)?.[instanceId]
            },
            imageHeadTilePosition: {
                key: instanceId,
                has: Array.isArray(instanced.userData.imageHeadTilePositions) && instanceId in instanced.userData.imageHeadTilePositions,
                value: (instanced.userData.imageHeadTilePositions as Array<[number, number]> | undefined)?.[instanceId]
            },
            indexedUserData: ['customPivots', 'localMatrices', 'displayTypes', 'textDisplayTemplateKeys'].flatMap(key => {
                const map = instanced.userData[key] as Map<number, unknown> | undefined;
                return map ? [{ map, entry: mapEntry(map, instanceId) }] : [];
            })
        }));
        meshStates.push({ mesh, parent, childIndex, count: instanced.count, detachedWhole, slots });
    }
    const keyEntries = [...affectedKeys].map(key => mapEntry(userData.instanceKeyToObjectUuid, key));
    const selectedUuids = new Set([...itemsToDelete.values()].flatMap(({ mesh, instanceId }) => {
        const uuid = userData.instanceKeyToObjectUuid?.get(GroupUtils.getGroupKey(mesh, instanceId));
        return uuid ? [uuid] : [];
    }));
    const playerHeadAtlasState = userData.capturePlayerHeadAtlasState?.(new Map(
        [...byMesh].filter((entry): entry is [InstancedMesh, Set<number>] => entry[0].isInstancedMesh)
    ));
    const objectToGroupEntries = [...affectedKeys].map(key => mapEntry(objectToGroup, key));
    const affectedUuids = new Set(keyEntries.flatMap(entry => entry.value ? [entry.value] : []));
    const uuidMapNames = [
        'objectUuidToInstance', 'objectNames', 'objectLabels', 'objectDisplayTypes', 'objectBlockProps',
        'objectTextDisplayOptions', 'objectTextures', 'objectNbt', 'objectBrightness'
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

    // 3. 그룹 구조 정리
    for (const gid of currentSelection.groups) {
         if(!gid) continue;
         const g = groups.get(gid);
         if (g && g.parent) {
             const parent = groups.get(g.parent);
             if (parent && !allGroupsToDelete.has(g.parent)) {
                 if (Array.isArray(parent.children)) {
                     parent.children = parent.children.filter((c: GroupChild) => !(c.type === 'group' && c.id === gid));
                 }
             }
         }
    }

    for (const gid of allGroupsToDelete) {
        groups.delete(gid);
    }

    // 4. 객체 삭제 처리 (메쉬별 그룹화)
    const deletedKeysByGroup = new Map<string, Set<string>>();
    const deletedObjectUuids = new Set<string>();

    for (const { mesh, instanceId } of itemsToDelete.values()) {
        const key = GroupUtils.getGroupKey(mesh, instanceId);
        const objectUuid = _removeDeletedObjectMetadata(loadedObjectGroup, mesh, instanceId);
        if (objectUuid) deletedObjectUuids.add(objectUuid);
        
        const parentGroupId = objectToGroup.get(key);
        if (parentGroupId) {
            if (groups.has(parentGroupId)) {
                let deletedKeys = deletedKeysByGroup.get(parentGroupId);
                if (!deletedKeys) deletedKeysByGroup.set(parentGroupId, deletedKeys = new Set());
                deletedKeys.add(key);
            }
            objectToGroup.delete(key);
        }

        if (!byMesh.has(mesh)) byMesh.set(mesh, new Set());
        byMesh.get(mesh)!.add(instanceId);
    }

    for (const [groupId, deletedKeys] of deletedKeysByGroup) {
        const group = groups.get(groupId);
        if (group) {
            group.children = group.children.filter(child => (
                child.type !== 'object' || !deletedKeys.has(GroupUtils.getGroupKey(child.mesh, child.instanceId))
            ));
        }
    }

    if (Array.isArray(userData.sceneOrder)) {
        userData.sceneOrder = userData.sceneOrder.filter(entry => (
            (entry.type !== 'object' || !deletedObjectUuids.has(entry.id))
            && (entry.type !== 'group' || !allGroupsToDelete.has(entry.id))
        ));
    }

    resetSelectionAndDeselect();

    // 5. 실제 메쉬 인스턴스 제거 실행
    // InstancedMesh: lastIdx를 삭제 지에 복사하는 Swap-Pop 방식 — 이동된 ID는 _updateGroupReferenceForMovedInstance로 갱신
    for (const [mesh, idSet] of byMesh) {
        if ((mesh as InstancedMesh).isInstancedMesh) {
            const sortedIds = Array.from(idSet).sort((a, b) => b - a);
            _deleteInstancedMeshInstances(loadedObjectGroup, mesh as InstancedMesh, sortedIds);
        } else removeDeletedMesh(mesh);
    }
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

    console.log('선택된 항목 제거됨 (Real Delete)');

    let deleted = true;
    return {
        deletedUuids: deletedObjectUuids,
        undo: () => {
            if (!deleted) return;
            for (const state of meshStates) {
                if (state.parent && !state.mesh.parent) {
                    state.parent.add(state.mesh);
                    if (state.childIndex >= 0) state.parent.children.splice(state.childIndex, 0, state.parent.children.pop()!);
                }
                if (!(state.mesh as InstancedMesh).isInstancedMesh) continue;
                const mesh = state.mesh as InstancedMesh;
                mesh.count = state.count!;
                for (const slot of state.slots) {
                    for (const { attribute, values } of slot.attributes) {
                        values.forEach((value, component) => attribute.setComponent(slot.instanceId, component, value));
                        attribute.needsUpdate = true;
                    }
                    const hasHat = mesh.userData.hasHat as boolean[] | undefined;
                    if (hasHat) slot.hasHat.has ? hasHat[slot.instanceId] = slot.hasHat.value! : delete hasHat[slot.instanceId];
                    const positions = mesh.userData.imageHeadTilePositions as Array<[number, number]> | undefined;
                    if (positions) slot.imageHeadTilePosition.has ? positions[slot.instanceId] = slot.imageHeadTilePosition.value! : delete positions[slot.instanceId];
                    slot.indexedUserData.forEach(({ map, entry }) => restoreEntries(map, [entry]));
                }
                mesh.instanceMatrix.needsUpdate = true;
                if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
                mesh.computeBoundingBox();
                mesh.computeBoundingSphere();
            }
            restoreEntries(userData.instanceKeyToObjectUuid, keyEntries);
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
            deleted = false;
        },
        redo: () => {
            if (deleted) return;
            deleteSelectedItems(loadedObjectGroup, {
                groups: selectedGroupIds,
                objects: new Map(Array.from(byMesh, ([mesh, ids]) => [mesh, new Set(ids)]))
            }, { resetSelectionAndDeselect: () => {} });
            deleted = true;
        },
        dispose: () => {
            if (!deleted) return;
            for (const state of meshStates) {
                if (!state.detachedWhole || state.mesh.parent || !state.mesh.userData.pdeDuplicateChunk) continue;
                state.mesh.dispose();
                state.mesh.geometry.dispose();
            }
        }
    };
}

if (import.meta.env.DEV) {
    const root = new Group();
    const plain = new Mesh();
    const instanced = new InstancedMesh(undefined, undefined, 1);
    instanced.count = 1;
    root.add(plain, instanced);
    removeDeletedMesh(plain);
    _deleteInstancedMeshInstances(root, instanced, [0]);
    console.assert(root.children.length === 0, 'Deleted meshes must leave the scene.');

    const deltaRoot = new Group();
    const geometry = new BufferGeometry();
    const custom = new InstancedBufferAttribute(new Float32Array([10, 11, 12, 13, 14]), 1);
    geometry.setAttribute('customInstanceValue', custom);
    const deltaMesh = new InstancedMesh(geometry, undefined, 5);
    for (let instanceId = 0; instanceId < 5; instanceId++) {
        deltaMesh.setMatrixAt(instanceId, new Matrix4().makeTranslation(instanceId, 0, 0));
        deltaMesh.setColorAt(instanceId, new Color(instanceId / 5, 0, 0));
    }
    const children = Array.from({ length: 5 }, (_, instanceId) => ({
        type: 'object' as const,
        mesh: deltaMesh,
        instanceId,
        id: `uuid-${instanceId}`
    }));
    deltaRoot.add(deltaMesh);
    deltaRoot.userData.groups = new Map<string, GroupData>([['group', {
        id: 'group', isCollection: false, children, parent: null, name: 'group',
        position: new Vector3(), quaternion: new Quaternion(), scale: new Vector3(1, 1, 1)
    }]]);
    deltaRoot.userData.objectToGroup = new Map(children.map(child => [`${deltaMesh.uuid}_${child.instanceId}`, 'group']));
    deltaRoot.userData.instanceKeyToObjectUuid = new Map(children.map(child => [`${deltaMesh.uuid}_${child.instanceId}`, child.id]));
    deltaRoot.userData.objectUuidToInstance = new Map(children.map(child => [child.id, { mesh: deltaMesh, instanceId: child.instanceId }]));
    deltaRoot.userData.objectNames = new Map(children.map(child => [child.id, child.id]));
    deltaRoot.userData.sceneOrder = children.map(child => ({ type: 'object', id: child.id }));
    let atlasCleanupCount = 0;
    let atlasRestored = false;
    deltaRoot.userData.capturePlayerHeadAtlasState = () => [{ regions: [{}] }];
    deltaRoot.userData.cleanupUnusedPlayerHeadAtlasSlots = () => { atlasCleanupCount++; };
    deltaRoot.userData.restorePlayerHeadAtlasState = () => { atlasRestored = true; };
    const delta = deleteSelectedItems(deltaRoot, {
        groups: new Set(), objects: new Map([[deltaMesh, new Set([0, 2, 4])]])
    }, { resetSelectionAndDeselect: () => {} })!;
    console.assert(deltaMesh.count === 2 && atlasCleanupCount === 1, 'Partial deletion or atlas cleanup failed.');
    delta.undo();
    const restoredMatrices = Array.from({ length: 5 }, (_, instanceId) => deltaMesh.getMatrixAt(instanceId, new Matrix4()).elements[12]);
    console.assert(restoredMatrices.join() === '0,1,2,3,4', 'Deleted instance matrices were not restored.');
    console.assert(Array.from({ length: 5 }, (_, instanceId) => custom.getX(instanceId)).join() === '10,11,12,13,14', 'Deleted instanced attributes were not restored.');
    console.assert(deltaRoot.userData.objectUuidToInstance.size === 5
        && deltaRoot.userData.groups.get('group').children.map((child: GroupChild) => child.id).join() === 'uuid-0,uuid-1,uuid-2,uuid-3,uuid-4'
        && deltaRoot.userData.groups.get('group').children.map((child: GroupChild) => child.type === 'object' ? child.instanceId : -1).join() === '0,1,2,3,4'
        && deltaRoot.userData.sceneOrder.map((entry: SceneOrderEntry) => entry.id).join() === 'uuid-0,uuid-1,uuid-2,uuid-3,uuid-4'
        && atlasRestored,
    'Deleted UUID/group/order metadata was not restored.');
    delta.redo();
    console.assert(deltaMesh.count === 2, 'Partial deletion redo failed.');
}
