import {
    BatchedMesh,
    InstancedMesh,
    Group,
    Matrix4,
    Color,
    Mesh,
    BufferGeometry,
    Material
} from 'three/webgpu';
import type { GroupChild } from '../controls/group';
import * as GroupUtils from '../controls/group';

export const DISPLAY_MESH_INSTANCE_LIMIT = 65535;

type PdeMesh = Mesh | BatchedMesh | InstancedMesh;

type SelectionMap = Map<PdeMesh, Set<number>>;

export interface DisplayMeshRebalanceOptions {
    selectedObjects?: SelectionMap;
}

export interface DisplayMeshRebalanceResult {
    mode: 'instanced' | 'batched';
    totalEligibleCount: number;
    converted: boolean;
    selectedObjects?: SelectionMap;
}

function isDisplayTypeValue(value: unknown): value is 'block_display' | 'item_display' {
    return value === 'block_display' || value === 'item_display';
}

function isPlayerHeadInstancedMesh(mesh: InstancedMesh): boolean {
    if (!mesh || !mesh.isInstancedMesh) return false;
    const displayType = mesh.userData?.displayType;
    const hasInstancedUv = !!(mesh.geometry && mesh.geometry.attributes && mesh.geometry.attributes.instancedUvOffset);
    return displayType === 'item_display' && hasInstancedUv;
}

function getInstanceDisplayType(mesh: BatchedMesh | InstancedMesh, instanceId: number): 'block_display' | 'item_display' | null {
    const map = mesh.userData?.displayTypes;
    if (map instanceof Map) {
        const mapped = map.get(instanceId);
        if (isDisplayTypeValue(mapped)) return mapped;
    }
    const direct = mesh.userData?.displayType;
    if (isDisplayTypeValue(direct)) return direct;
    return null;
}

function getValidInstanceIds(mesh: BatchedMesh | InstancedMesh): number[] {
    if ((mesh as InstancedMesh).isInstancedMesh) {
        const count = Math.max(0, (mesh as InstancedMesh).count ?? 0);
        const ids = new Array<number>(count);
        for (let i = 0; i < count; i++) ids[i] = i;
        return ids;
    }

    const ids: number[] = [];
    const geomIds = (mesh as BatchedMesh).userData?.instanceGeometryIds;
    if (!Array.isArray(geomIds)) return ids;
    for (let i = 0; i < geomIds.length; i++) {
        if (geomIds[i] !== undefined && geomIds[i] !== null) {
            ids.push(i);
        }
    }
    return ids;
}

function clonePerInstanceValue<T>(value: T): T {
    const maybeObj = value as unknown as { clone?: () => T };
    if (maybeObj && typeof maybeObj.clone === 'function') {
        return maybeObj.clone();
    }
    return value;
}

function copyMapEntry(
    source: Map<number, unknown> | undefined,
    target: Map<number, unknown>,
    sourceId: number,
    targetId: number
): void {
    if (!(source instanceof Map) || !source.has(sourceId)) return;
    target.set(targetId, clonePerInstanceValue(source.get(sourceId)));
}

function copyArrayLikeEntry(
    source: Record<number, unknown> | undefined,
    target: Record<number, unknown>,
    sourceId: number,
    targetId: number
): void {
    if (!source || !(sourceId in source)) return;
    target[targetId] = clonePerInstanceValue(source[sourceId]);
}

function getMaps(loadedObjectGroup: Group): {
    groups: Map<string, any>;
    objectToGroup: Map<string, string>;
    instanceKeyToObjectUuid: Map<string, string>;
    objectUuidToInstance: Map<string, { mesh: PdeMesh; instanceId: number }>;
} {
    const groups = GroupUtils.getGroups(loadedObjectGroup) as Map<string, any>;
    const objectToGroup = GroupUtils.getObjectToGroup(loadedObjectGroup);

    if (!loadedObjectGroup.userData.instanceKeyToObjectUuid) {
        loadedObjectGroup.userData.instanceKeyToObjectUuid = new Map<string, string>();
    }
    if (!loadedObjectGroup.userData.objectUuidToInstance) {
        loadedObjectGroup.userData.objectUuidToInstance = new Map<string, { mesh: PdeMesh; instanceId: number }>();
    }

    return {
        groups,
        objectToGroup,
        instanceKeyToObjectUuid: loadedObjectGroup.userData.instanceKeyToObjectUuid,
        objectUuidToInstance: loadedObjectGroup.userData.objectUuidToInstance
    };
}

function rebindObjectAndGroupReference(
    loadedObjectGroup: Group,
    oldMesh: PdeMesh,
    oldInstanceId: number,
    newMesh: PdeMesh,
    newInstanceId: number
): void {
    const { groups, objectToGroup, instanceKeyToObjectUuid, objectUuidToInstance } = getMaps(loadedObjectGroup);

    const oldKey = GroupUtils.getGroupKey(oldMesh as any, oldInstanceId);
    const newKey = GroupUtils.getGroupKey(newMesh as any, newInstanceId);

    const objectUuid = instanceKeyToObjectUuid.get(oldKey);
    if (objectUuid) {
        instanceKeyToObjectUuid.delete(oldKey);
        instanceKeyToObjectUuid.set(newKey, objectUuid);
        objectUuidToInstance.set(objectUuid, { mesh: newMesh, instanceId: newInstanceId });
    }

    const groupId = objectToGroup.get(oldKey);
    objectToGroup.delete(oldKey);
    if (groupId) {
        objectToGroup.set(newKey, groupId);

        const group = groups.get(groupId);
        if (group && Array.isArray(group.children)) {
            const idx = group.children.findIndex((child: GroupChild) => {
                if (!child || child.type !== 'object') return false;
                const childId = (child as GroupChild & { id?: string }).id;
                if (objectUuid && childId === objectUuid) return true;
                return child.mesh === oldMesh && child.instanceId === oldInstanceId;
            });
            if (idx !== -1) {
                const existing = group.children[idx];
                group.children[idx] = {
                    type: 'object',
                    mesh: newMesh,
                    instanceId: newInstanceId,
                    id: objectUuid ?? existing.id
                };
            }
        }
    }
}

function purgeStaleMeshKeys(loadedObjectGroup: Group, mesh: PdeMesh): void {
    const keyToUuid = loadedObjectGroup.userData?.instanceKeyToObjectUuid as Map<string, string> | undefined;
    const uuidToInstance = loadedObjectGroup.userData?.objectUuidToInstance as Map<string, { mesh: PdeMesh; instanceId: number }> | undefined;
    if (!(keyToUuid instanceof Map)) return;

    const prefix = `${mesh.uuid}_`;
    const keysToDelete: string[] = [];

    for (const key of keyToUuid.keys()) {
        if (key.startsWith(prefix)) keysToDelete.push(key);
    }

    for (const key of keysToDelete) {
        const uuid = keyToUuid.get(key);
        keyToUuid.delete(key);
        if (!uuid || !(uuidToInstance instanceof Map)) continue;
        const current = uuidToInstance.get(uuid);
        if (current && current.mesh === mesh) {
            uuidToInstance.delete(uuid);
        }
    }
}

function isEligibleDisplayInstance(mesh: BatchedMesh | InstancedMesh, instanceId: number): boolean {
    const displayType = getInstanceDisplayType(mesh, instanceId);
    if (!displayType) return false;
    if ((mesh as InstancedMesh).isInstancedMesh && isPlayerHeadInstancedMesh(mesh as InstancedMesh)) {
        return false;
    }
    return true;
}

function getEligibleDisplayCount(loadedObjectGroup: Group): number {
    let total = 0;
    for (const child of loadedObjectGroup.children) {
        const maybeInstanced = child as InstancedMesh;
        const maybeBatched = child as BatchedMesh;
        if (!maybeInstanced.isInstancedMesh && !maybeBatched.isBatchedMesh) continue;

        const ids = getValidInstanceIds(maybeInstanced.isInstancedMesh ? maybeInstanced : maybeBatched);
        for (const id of ids) {
            if (isEligibleDisplayInstance(maybeInstanced.isInstancedMesh ? maybeInstanced : maybeBatched, id)) {
                total++;
            }
        }
    }
    return total;
}

function isInstancedConvertibleToBatched(mesh: InstancedMesh): boolean {
    if (!mesh || !mesh.isInstancedMesh) return false;
    if (isPlayerHeadInstancedMesh(mesh)) return false;
    if (Array.isArray(mesh.material)) return false;

    const ids = getValidInstanceIds(mesh);
    if (ids.length === 0) return false;

    for (const id of ids) {
        if (!isEligibleDisplayInstance(mesh, id)) return false;
    }

    return true;
}

function convertBatchedMeshToInstancedMeshes(loadedObjectGroup: Group, batch: BatchedMesh): InstancedMesh[] {
    const createdMeshes: InstancedMesh[] = [];
    if (!batch || !batch.isBatchedMesh) return createdMeshes;

    const material = Array.isArray(batch.material) ? batch.material[0] : batch.material;
    if (!material) return createdMeshes;

    const geomIds = batch.userData?.instanceGeometryIds;
    const originalGeometries = batch.userData?.originalGeometries as Map<number, BufferGeometry> | undefined;
    if (!Array.isArray(geomIds) || !(originalGeometries instanceof Map)) return createdMeshes;

    const groups = new Map<string, { geomId: number; displayType: 'block_display' | 'item_display'; sourceIds: number[] }>();
    const validIds = getValidInstanceIds(batch);

    for (const sourceId of validIds) {
        if (!isEligibleDisplayInstance(batch, sourceId)) continue;
        const geomId = geomIds[sourceId];
        if (geomId === undefined || geomId === null) continue;

        const displayType = getInstanceDisplayType(batch, sourceId);
        if (!displayType) continue;

        const key = `${geomId}|${displayType}`;
        let entry = groups.get(key);
        if (!entry) {
            entry = { geomId, displayType, sourceIds: [] };
            groups.set(key, entry);
        }
        entry.sourceIds.push(sourceId);
    }

    const tmpMatrix = new Matrix4();
    const tmpColor = new Color();

    for (const entry of groups.values()) {
        const sourceGeometry = originalGeometries.get(entry.geomId);
        if (!sourceGeometry) continue;

        const instanced = new InstancedMesh(sourceGeometry, material, entry.sourceIds.length);
        instanced.frustumCulled = batch.frustumCulled;
        instanced.renderOrder = batch.renderOrder;
        instanced.userData.displayType = entry.displayType;
        instanced.userData._pdeThresholdSwitchable = true;
        if (batch.userData?.customPivot) {
            instanced.userData.customPivot = clonePerInstanceValue(batch.userData.customPivot);
        }
        instanced.userData.displayTypes = new Map<number, string>();
        instanced.userData.localMatrices = new Map<number, Matrix4>();
        instanced.userData.customPivots = new Map<number, unknown>();
        instanced.userData.itemIds = new Map<number, unknown>();

        if (batch.userData?.hasHat) {
            instanced.userData.hasHat = {};
        }

        for (let i = 0; i < entry.sourceIds.length; i++) {
            const sourceId = entry.sourceIds[i];

            batch.getMatrixAt(sourceId, tmpMatrix);
            instanced.setMatrixAt(i, tmpMatrix);

            try {
                batch.getColorAt(sourceId, tmpColor);
                instanced.setColorAt(i, tmpColor);
            } catch {
                // Ignore when source has no per-instance color.
            }

            instanced.userData.displayTypes.set(i, entry.displayType);
            copyMapEntry(batch.userData?.localMatrices, instanced.userData.localMatrices, sourceId, i);
            copyMapEntry(batch.userData?.customPivots, instanced.userData.customPivots, sourceId, i);
            copyMapEntry(batch.userData?.itemIds, instanced.userData.itemIds, sourceId, i);
            copyArrayLikeEntry(batch.userData?.hasHat, instanced.userData.hasHat ?? {}, sourceId, i);

            rebindObjectAndGroupReference(loadedObjectGroup, batch, sourceId, instanced, i);
        }

        instanced.instanceMatrix.needsUpdate = true;
        if (instanced.instanceColor) {
            instanced.instanceColor.needsUpdate = true;
        }
        instanced.computeBoundingSphere();

        loadedObjectGroup.add(instanced);
        createdMeshes.push(instanced);
    }

    if (createdMeshes.length > 0) {
        loadedObjectGroup.remove(batch);
        purgeStaleMeshKeys(loadedObjectGroup, batch);
    }

    return createdMeshes;
}

function convertInstancedMeshToBatchedMesh(loadedObjectGroup: Group, instanced: InstancedMesh): BatchedMesh | null {
    if (!isInstancedConvertibleToBatched(instanced)) return null;

    const material = instanced.material as Material;
    const geometry = instanced.geometry;
    if (!geometry || !material) return null;

    const maxInstances = Math.max(1, instanced.count);
    const maxVerts = Math.max(64, (geometry.attributes?.position?.count ?? 0) + 16);
    const maxIndices = Math.max(64, (geometry.index?.count ?? 0) + 16);

    const batch = new BatchedMesh(maxInstances, maxVerts, maxIndices, material);
    batch.frustumCulled = instanced.frustumCulled;
    batch.renderOrder = instanced.renderOrder;
    batch.userData.isWritable = true;
    batch.userData._pdeMaxInstances = maxInstances;
    batch.userData._pdeThresholdSwitchable = true;
    batch.userData.displayType = instanced.userData?.displayType ?? 'block_display';
    if (instanced.userData?.customPivot) {
        batch.userData.customPivot = clonePerInstanceValue(instanced.userData.customPivot);
    }
    batch.userData.displayTypes = new Map<number, string>();
    batch.userData.geometryBounds = new Map<number, unknown>();
    batch.userData.instanceGeometryIds = [];
    batch.userData.localMatrices = new Map<number, Matrix4>();
    batch.userData.originalGeometries = new Map<number, BufferGeometry>();
    batch.userData.customPivots = new Map<number, unknown>();
    batch.userData.itemIds = new Map<number, unknown>();

    const batchGeomId = batch.addGeometry(geometry);
    batch.userData.originalGeometries.set(batchGeomId, geometry);
    if (!geometry.boundingBox) geometry.computeBoundingBox();
    if (geometry.boundingBox) {
        batch.userData.geometryBounds.set(batchGeomId, geometry.boundingBox.clone());
    }

    const tmpMatrix = new Matrix4();
    const tmpColor = new Color();

    for (let sourceId = 0; sourceId < instanced.count; sourceId++) {
        if (!isEligibleDisplayInstance(instanced, sourceId)) continue;

        const newInstanceId = batch.addInstance(batchGeomId);
        batch.userData.instanceGeometryIds[newInstanceId] = batchGeomId;

        instanced.getMatrixAt(sourceId, tmpMatrix);
        batch.setMatrixAt(newInstanceId, tmpMatrix);

        if (instanced.instanceColor) {
            try {
                instanced.getColorAt(sourceId, tmpColor);
                batch.setColorAt(newInstanceId, tmpColor);
            } catch {
                // Ignore when source has no per-instance color.
            }
        }

        const displayType = getInstanceDisplayType(instanced, sourceId) ?? 'block_display';
        batch.userData.displayTypes.set(newInstanceId, displayType);

        copyMapEntry(instanced.userData?.localMatrices, batch.userData.localMatrices, sourceId, newInstanceId);
        copyMapEntry(instanced.userData?.customPivots, batch.userData.customPivots, sourceId, newInstanceId);
        copyMapEntry(instanced.userData?.itemIds, batch.userData.itemIds, sourceId, newInstanceId);
        if (instanced.userData?.hasHat) {
            if (!batch.userData.hasHat) batch.userData.hasHat = {};
            copyArrayLikeEntry(instanced.userData.hasHat, batch.userData.hasHat, sourceId, newInstanceId);
        }

        rebindObjectAndGroupReference(loadedObjectGroup, instanced, sourceId, batch, newInstanceId);
    }

    loadedObjectGroup.add(batch);
    loadedObjectGroup.remove(instanced);
    purgeStaleMeshKeys(loadedObjectGroup, instanced);

    return batch;
}

function captureSelectedUuids(loadedObjectGroup: Group, selectedObjects?: SelectionMap): Set<string> {
    const uuids = new Set<string>();
    if (!selectedObjects || selectedObjects.size === 0) return uuids;

    const keyToUuid = loadedObjectGroup.userData.instanceKeyToObjectUuid as Map<string, string> | undefined;
    if (!(keyToUuid instanceof Map)) return uuids;

    for (const [mesh, ids] of selectedObjects) {
        if (!mesh || !ids) continue;
        for (const id of ids) {
            const key = GroupUtils.getGroupKey(mesh as any, id);
            const uuid = keyToUuid.get(key);
            if (uuid) uuids.add(uuid);
        }
    }

    return uuids;
}

function rebuildSelectionFromUuids(loadedObjectGroup: Group, uuids: Set<string>): SelectionMap {
    const out: SelectionMap = new Map();
    if (uuids.size === 0) return out;

    const uuidToInstance = loadedObjectGroup.userData.objectUuidToInstance as Map<string, { mesh: PdeMesh; instanceId: number }> | undefined;
    if (!(uuidToInstance instanceof Map)) return out;

    for (const uuid of uuids) {
        const inst = uuidToInstance.get(uuid);
        if (!inst || !inst.mesh) continue;
        if (!out.has(inst.mesh)) out.set(inst.mesh, new Set<number>());
        out.get(inst.mesh)?.add(inst.instanceId);
    }

    return out;
}

export function rebalanceDisplayMeshesByThreshold(
    loadedObjectGroup: Group,
    options: DisplayMeshRebalanceOptions = {}
): DisplayMeshRebalanceResult {
    if (!loadedObjectGroup) {
        return {
            mode: 'batched',
            totalEligibleCount: 0,
            converted: false,
            selectedObjects: options.selectedObjects
        };
    }

    const selectedUuids = captureSelectedUuids(loadedObjectGroup, options.selectedObjects);

    const totalEligibleCount = getEligibleDisplayCount(loadedObjectGroup);
    const mode: 'instanced' | 'batched' = totalEligibleCount > DISPLAY_MESH_INSTANCE_LIMIT ? 'instanced' : 'batched';

    let converted = false;

    if (mode === 'instanced') {
        const children = [...loadedObjectGroup.children];
        for (const child of children) {
            const mesh = child as BatchedMesh;
            if (!mesh || !mesh.isBatchedMesh) continue;

            const created = convertBatchedMeshToInstancedMeshes(loadedObjectGroup, mesh);
            if (created.length > 0) {
                converted = true;
            }
        }
    } else {
        const children = [...loadedObjectGroup.children];
        for (const child of children) {
            const mesh = child as InstancedMesh;
            if (!mesh || !mesh.isInstancedMesh) continue;
            if (!isInstancedConvertibleToBatched(mesh)) continue;

            const convertedBatch = convertInstancedMeshToBatchedMesh(loadedObjectGroup, mesh);
            if (convertedBatch) {
                converted = true;
            }
        }
    }

    const selectedObjects = selectedUuids.size > 0
        ? rebuildSelectionFromUuids(loadedObjectGroup, selectedUuids)
        : options.selectedObjects;

    return {
        mode,
        totalEligibleCount,
        converted,
        selectedObjects
    };
}
