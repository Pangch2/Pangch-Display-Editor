import {
    Color,
    Group,
    InstancedBufferAttribute,
    InstancedMesh,
    MathUtils,
    Matrix4,
    Mesh,
    Object3D
} from 'three/webgpu';
import * as GroupUtils from './group';
import type { CloneJobEntry } from './group';
import * as Overlay from '../selection/overlay';
import { isPbdeLogEnabled, pbdeLogNames } from '../../load-project/pbde-log';

const getDisplayType = Overlay.getDisplayType;

interface SceneOrderEntry {
    type: 'group' | 'object';
    id: string;
}

interface DuplicateUserData {
    instanceKeyToObjectUuid?: Map<string, string>;
    objectUuidToInstance?: Map<string, { mesh: Object3D; instanceId: number }>;
    objectToGroup?: Map<string, string>;
    objectNames?: Map<string, string>;
    objectIsItemDisplay?: Set<string>;
    objectDisplayTypes?: Map<string, string>;
    objectBlockProps?: Map<string, unknown>;
    objectNbt?: Map<string, string>;
    objectBrightness?: Map<string, unknown>;
    objectTextures?: Map<string, string>;
    sceneOrder?: SceneOrderEntry[];
}

interface SourceObjectLocation {
    parentGroupId: string | null;
    containerKind: 'group' | 'scene';
    container: Array<{ type: 'group' | 'object'; id?: string; mesh?: Object3D; instanceId?: number }>;
    index: number;
}

interface CloneResult {
    mesh: Mesh | InstancedMesh;
    instanceId: number;
    objectUuid: string;
    coveredByGroup: boolean;
}

interface DuplicateTimingStats {
    attrsMs: number;
    metadataMs: number;
    chunks: number;
}

export interface DuplicationSelection {
    groups: Set<string>;
    objects: Map<InstancedMesh | Mesh, Set<number>>;
}

const tmpTargetLocal = new Matrix4();
const tmpColor = new Color();
const PREWARM_CHUNK_REMAINING_RATIO = 0.25;
const spareInstancedChunks = new WeakMap<InstancedMesh, InstancedMesh[]>();
const pendingChunkPrewarms = new WeakSet<InstancedMesh>();

function cloneData<T>(value: T): T {
    if (value === null || value === undefined) return value;
    if (value instanceof Map) return new Map([...value].map(([key, val]) => [cloneData(key), cloneData(val)])) as T;
    if (value instanceof Set) return new Set([...value].map(cloneData)) as T;
    const clone = (value as { clone?: unknown }).clone;
    if (typeof clone === 'function') {
        try { return clone.call(value); } catch { /* fallback below */ }
    }
    if (typeof structuredClone === 'function') {
        try { return structuredClone(value); } catch { /* fallback below */ }
    }
    if (Array.isArray(value)) return value.map(cloneData) as T;
    if (typeof value === 'object') return { ...(value as Record<string, unknown>) } as T;
    return value;
}

function ensureStores(loadedObjectGroup: Group) {
    const ud = loadedObjectGroup.userData as DuplicateUserData;
    if (!ud.instanceKeyToObjectUuid) ud.instanceKeyToObjectUuid = new Map<string, string>();
    if (!ud.objectUuidToInstance) ud.objectUuidToInstance = new Map<string, { mesh: Object3D; instanceId: number }>();
    if (!ud.objectNames) ud.objectNames = new Map<string, string>();
    if (!ud.objectIsItemDisplay) ud.objectIsItemDisplay = new Set<string>();
    if (!ud.objectDisplayTypes) ud.objectDisplayTypes = new Map<string, string>();
    if (!ud.objectBlockProps) ud.objectBlockProps = new Map<string, unknown>();
    return ud;
}

function registerClone(
    loadedObjectGroup: Group,
    sourceMesh: Mesh | InstancedMesh,
    sourceInstanceId: number,
    targetMesh: Mesh | InstancedMesh,
    targetInstanceId: number
): string {
    const stores = ensureStores(loadedObjectGroup);
    const sourceKey = GroupUtils.getGroupKey(sourceMesh, sourceInstanceId);
    const sourceUuid = stores.instanceKeyToObjectUuid!.get(sourceKey);
    const targetUuid = MathUtils.generateUUID();
    const targetKey = GroupUtils.getGroupKey(targetMesh, targetInstanceId);

    stores.instanceKeyToObjectUuid!.set(targetKey, targetUuid);
    stores.objectUuidToInstance!.set(targetUuid, { mesh: targetMesh, instanceId: targetInstanceId });

    if (!sourceUuid) {
        stores.objectNames!.set(targetUuid, targetUuid.slice(0, 8));
        return targetUuid;
    }

    const sourceName = stores.objectNames!.get(sourceUuid);
    if (sourceName) stores.objectNames!.set(targetUuid, sourceName);
    if (stores.objectIsItemDisplay!.has(sourceUuid)) stores.objectIsItemDisplay!.add(targetUuid);

    const displayType = stores.objectDisplayTypes!.get(sourceUuid);
    if (displayType) stores.objectDisplayTypes!.set(targetUuid, displayType);

    if (stores.objectBlockProps!.has(sourceUuid)) {
        stores.objectBlockProps!.set(targetUuid, cloneData(stores.objectBlockProps!.get(sourceUuid)));
    }
    if (stores.objectNbt?.has(sourceUuid)) stores.objectNbt.set(targetUuid, stores.objectNbt.get(sourceUuid)!);
    if (stores.objectBrightness?.has(sourceUuid)) {
        stores.objectBrightness.set(targetUuid, cloneData(stores.objectBrightness.get(sourceUuid)));
    }
    if (stores.objectTextures?.has(sourceUuid)) stores.objectTextures.set(targetUuid, stores.objectTextures.get(sourceUuid)!);

    return targetUuid;
}

function findSourceObjectLocation(
    loadedObjectGroup: Group,
    sourceMesh: Mesh | InstancedMesh,
    sourceInstanceId: number
): SourceObjectLocation | null {
    const stores = ensureStores(loadedObjectGroup);
    const sourceKey = GroupUtils.getGroupKey(sourceMesh, sourceInstanceId);
    const sourceUuid = stores.instanceKeyToObjectUuid!.get(sourceKey);
    if (!sourceUuid) return null;

    const groups = GroupUtils.getGroups(loadedObjectGroup);
    const parentGroupId = stores.objectToGroup?.get(sourceKey) ?? null;

    if (parentGroupId) {
        const parentGroup = groups.get(parentGroupId);
        if (parentGroup && Array.isArray(parentGroup.children)) {
            const index = parentGroup.children.findIndex(child => child.type === 'object' && child.id === sourceUuid);
            if (index !== -1) return { parentGroupId, containerKind: 'group', container: parentGroup.children, index };
        }
    }

    if (Array.isArray(stores.sceneOrder)) {
        const index = stores.sceneOrder.findIndex(entry => entry.type === 'object' && entry.id === sourceUuid);
        if (index !== -1) return { parentGroupId: null, containerKind: 'scene', container: stores.sceneOrder, index };
    }

    return null;
}

function insertCloneEntry(
    loadedObjectGroup: Group,
    sourceMesh: Mesh | InstancedMesh,
    sourceInstanceId: number,
    targetGroupId: string | null,
    targetMesh: Mesh | InstancedMesh,
    targetInstanceId: number,
    targetUuid: string,
    coveredByGroup: boolean
): void {
    const stores = ensureStores(loadedObjectGroup);
    const targetKey = GroupUtils.getGroupKey(targetMesh, targetInstanceId);

    if (targetGroupId) {
        const targetGroup = GroupUtils.getGroups(loadedObjectGroup).get(targetGroupId);
        if (!targetGroup) return;
        if (!Array.isArray(targetGroup.children)) targetGroup.children = [];

        stores.objectToGroup = GroupUtils.getObjectToGroup(loadedObjectGroup);
        stores.objectToGroup.set(targetKey, targetGroupId);

        if (!coveredByGroup) {
            const sourceLocation = findSourceObjectLocation(loadedObjectGroup, sourceMesh, sourceInstanceId);
            if (sourceLocation?.parentGroupId === targetGroupId && sourceLocation.containerKind === 'group') {
                sourceLocation.container.splice(sourceLocation.index + 1, 0, {
                    type: 'object',
                    mesh: targetMesh,
                    instanceId: targetInstanceId,
                    id: targetUuid
                });
                return;
            }
        }

        targetGroup.children.push({ type: 'object', mesh: targetMesh, instanceId: targetInstanceId, id: targetUuid });
        return;
    }

    const sourceLocation = findSourceObjectLocation(loadedObjectGroup, sourceMesh, sourceInstanceId);
    if (sourceLocation?.parentGroupId === null && sourceLocation.containerKind === 'scene') {
        sourceLocation.container.splice(sourceLocation.index + 1, 0, { type: 'object', id: targetUuid });
    } else if (Array.isArray(stores.sceneOrder)) {
        stores.sceneOrder.push({ type: 'object', id: targetUuid });
    }
}

function getAncestorSelected(groups: Map<string, GroupUtils.GroupData>, groupId: string | null | undefined, selectedGroups: Set<string> | null): boolean {
    let current = groupId ?? null;
    while (current) {
        if (selectedGroups?.has(current)) return true;
        current = groups.get(current)?.parent ?? null;
    }
    return false;
}

function getInstancedCapacity(mesh: InstancedMesh): number {
    let capacity = (mesh.instanceMatrix as InstancedBufferAttribute).count;
    if (mesh.instanceColor) capacity = Math.min(capacity, (mesh.instanceColor as InstancedBufferAttribute).count);
    for (const attribute of Object.values(mesh.geometry.attributes)) {
        const instancedAttribute = attribute as InstancedBufferAttribute;
        if (instancedAttribute.isInstancedBufferAttribute) capacity = Math.min(capacity, instancedAttribute.count);
    }
    return capacity;
}

function copyInstancedGeometryAttributes(
    sourceMesh: InstancedMesh,
    sourceId: number,
    targetMesh: InstancedMesh,
    targetId: number,
    updatedAttributes: Set<InstancedBufferAttribute>
): void {
    for (const [name, attribute] of Object.entries(sourceMesh.geometry.attributes)) {
        const sourceAttribute = attribute as InstancedBufferAttribute;
        if (!sourceAttribute.isInstancedBufferAttribute) continue;

        const targetAttribute = targetMesh.geometry.getAttribute(name) as InstancedBufferAttribute | undefined;
        if (!targetAttribute?.isInstancedBufferAttribute) continue;

        const itemSize = Math.min(sourceAttribute.itemSize, targetAttribute.itemSize);
        const srcOffset = sourceId * sourceAttribute.itemSize;
        const dstOffset = targetId * targetAttribute.itemSize;
        targetAttribute.array.set(sourceAttribute.array.subarray(srcOffset, srcOffset + itemSize), dstOffset);
        updatedAttributes.add(targetAttribute);
    }
}

function copyUserDataForInstance(sourceMesh: InstancedMesh, sourceId: number, targetMesh: InstancedMesh, targetId: number): void {
    const displayType = getDisplayType(sourceMesh, sourceId) ?? sourceMesh.userData?.displayType ?? 'block_display';
    if (!targetMesh.userData.displayTypes) targetMesh.userData.displayTypes = new Map<number, string>();
    targetMesh.userData.displayTypes.set(targetId, displayType);

    if (sourceMesh.userData?.hasHat?.[sourceId] !== undefined) {
        if (!targetMesh.userData.hasHat) targetMesh.userData.hasHat = [];
        targetMesh.userData.hasHat[targetId] = sourceMesh.userData.hasHat[sourceId];
    }

    const customPivot = sourceMesh.userData?.customPivots?.get(sourceId) ?? sourceMesh.userData?.customPivot;
    if (customPivot) {
        if (!targetMesh.userData.customPivots) targetMesh.userData.customPivots = new Map();
        targetMesh.userData.customPivots.set(targetId, customPivot.clone());
    }

    const localMatrix = sourceMesh.userData?.localMatrices?.get(sourceId);
    if (localMatrix) {
        if (!targetMesh.userData.localMatrices) targetMesh.userData.localMatrices = new Map();
        targetMesh.userData.localMatrices.set(targetId, localMatrix.clone());
    }
}

function clonePlainMesh(
    loadedObjectGroup: Group,
    sourceMesh: Mesh,
    sourceInstanceId: number,
    targetGroupId: string | null,
    coveredByGroup: boolean
): CloneResult {
    const clone = sourceMesh.clone() as Mesh;
    clone.userData = cloneData(sourceMesh.userData);
    loadedObjectGroup.add(clone);

    const objectUuid = registerClone(loadedObjectGroup, sourceMesh, sourceInstanceId, clone, 0);
    insertCloneEntry(loadedObjectGroup, sourceMesh, sourceInstanceId, targetGroupId, clone, 0, objectUuid, coveredByGroup);
    return { mesh: clone, instanceId: 0, objectUuid, coveredByGroup };
}

function createInstancedChunk(loadedObjectGroup: Group, sourceMesh: InstancedMesh): InstancedMesh {
    const capacity = Math.max(1, getInstancedCapacity(sourceMesh));
    const material = Array.isArray(sourceMesh.material) ? [...sourceMesh.material] : sourceMesh.material;
    const chunk = new InstancedMesh(sourceMesh.geometry.clone(), material, capacity);
    chunk.count = 0;
    chunk.userData.displayType = sourceMesh.userData?.displayType;
    chunk.userData.displayTypes = new Map<number, string>();
    if (sourceMesh.userData?.hasHat) chunk.userData.hasHat = [];
    chunk.frustumCulled = sourceMesh.frustumCulled;
    chunk.renderOrder = sourceMesh.renderOrder;
    chunk.visible = sourceMesh.visible;
    chunk.layers.mask = sourceMesh.layers.mask;
    loadedObjectGroup.add(chunk);
    return chunk;
}

function takeSpareInstancedChunk(loadedObjectGroup: Group, sourceMesh: InstancedMesh): InstancedMesh {
    return spareInstancedChunks.get(sourceMesh)?.pop() ?? createInstancedChunk(loadedObjectGroup, sourceMesh);
}

function scheduleInstancedChunkPrewarm(loadedObjectGroup: Group, sourceMesh: InstancedMesh): void {
    if (pendingChunkPrewarms.has(sourceMesh)) return;
    if ((spareInstancedChunks.get(sourceMesh)?.length ?? 0) > 0) return;

    pendingChunkPrewarms.add(sourceMesh);
    const prewarm = () => {
        pendingChunkPrewarms.delete(sourceMesh);
        if (sourceMesh.parent !== loadedObjectGroup) return;
        if ((spareInstancedChunks.get(sourceMesh)?.length ?? 0) > 0) return;
        const chunk = createInstancedChunk(loadedObjectGroup, sourceMesh);
        const chunks = spareInstancedChunks.get(sourceMesh) ?? [];
        chunks.push(chunk);
        spareInstancedChunks.set(sourceMesh, chunks);
    };

    const requestIdle = (globalThis as {
        requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
    }).requestIdleCallback;
    if (requestIdle) {
        requestIdle(prewarm, { timeout: 250 });
    } else {
        setTimeout(prewarm, 0);
    }
}

function maybePrewarmNextInstancedChunk(loadedObjectGroup: Group, sourceMesh: InstancedMesh, targetMesh: InstancedMesh, targetCapacity: number): void {
    if (targetCapacity <= 0) return;
    const remaining = targetCapacity - targetMesh.count;
    if (remaining <= Math.max(1, Math.floor(targetCapacity * PREWARM_CHUNK_REMAINING_RATIO))) {
        scheduleInstancedChunkPrewarm(loadedObjectGroup, sourceMesh);
    }
}

function cloneInstancedBatch(
    loadedObjectGroup: Group,
    sourceMesh: InstancedMesh,
    jobs: CloneJobEntry[],
    timings?: DuplicateTimingStats
): CloneResult[] {
    if (!sourceMesh.geometry || jobs.length === 0) return [];

    let targetMesh = sourceMesh;
    let targetCapacity = getInstancedCapacity(targetMesh);
    const results: CloneResult[] = [];
    const updatedMeshes = new Set<InstancedMesh>();
    const updatedColorMeshes = new Set<InstancedMesh>();
    const updatedAttributes = new Set<InstancedBufferAttribute>();

    for (const job of jobs) {
        if (targetMesh.count >= targetCapacity) {
            targetMesh = takeSpareInstancedChunk(loadedObjectGroup, sourceMesh);
            targetCapacity = getInstancedCapacity(targetMesh);
            scheduleInstancedChunkPrewarm(loadedObjectGroup, sourceMesh);
            if (timings) timings.chunks++;
        }

        const targetId = targetMesh.count;
        sourceMesh.getMatrixAt(job.instanceId, tmpTargetLocal);
        targetMesh.setMatrixAt(targetId, tmpTargetLocal);
        const attrsStart = timings ? performance.now() : 0;
        copyInstancedGeometryAttributes(sourceMesh, job.instanceId, targetMesh, targetId, updatedAttributes);
        if (timings) timings.attrsMs += performance.now() - attrsStart;

        if (sourceMesh.instanceColor && sourceMesh.getColorAt) {
            sourceMesh.getColorAt(job.instanceId, tmpColor);
            targetMesh.setColorAt(targetId, tmpColor);
            updatedColorMeshes.add(targetMesh);
        }

        const metadataStart = timings ? performance.now() : 0;
        copyUserDataForInstance(sourceMesh, job.instanceId, targetMesh, targetId);

        const objectUuid = registerClone(loadedObjectGroup, sourceMesh, job.instanceId, targetMesh, targetId);
        insertCloneEntry(
            loadedObjectGroup,
            sourceMesh,
            job.instanceId,
            job.targetGroupId,
            targetMesh,
            targetId,
            objectUuid,
            job.coveredByGroup
        );
        if (timings) timings.metadataMs += performance.now() - metadataStart;
        results.push({ mesh: targetMesh, instanceId: targetId, objectUuid, coveredByGroup: job.coveredByGroup });
        targetMesh.count++;
        updatedMeshes.add(targetMesh);
        maybePrewarmNextInstancedChunk(loadedObjectGroup, sourceMesh, targetMesh, targetCapacity);
    }

    for (const mesh of updatedMeshes) mesh.instanceMatrix.needsUpdate = true;
    for (const mesh of updatedColorMeshes) {
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
    for (const attribute of updatedAttributes) attribute.needsUpdate = true;

    return results;
}

function addSelection(selection: DuplicationSelection, result: CloneResult): void {
    if (result.coveredByGroup) return;
    if (!selection.objects.has(result.mesh)) selection.objects.set(result.mesh, new Set());
    selection.objects.get(result.mesh)!.add(result.instanceId);
}

export function flushPendingHeadClones(_loadedObjectGroup?: Group, _ctx?: unknown): Array<{ mesh: InstancedMesh, instanceId: number, targetGroupId: string | null, coveredByGroup: boolean }> {
    return [];
}

export function duplicateGroupsAndObjects(
    loadedObjectGroup: Group,
    groupIds: Set<string> | null,
    objectEntries: Array<{ mesh: Mesh | InstancedMesh, instanceId: number }> | null
): DuplicationSelection {
    const logTimings = isPbdeLogEnabled(pbdeLogNames.duplicateTimings);
    const totalStart = logTimings ? performance.now() : 0;
    const timings: DuplicateTimingStats | undefined = logTimings ? { attrsMs: 0, metadataMs: 0, chunks: 0 } : undefined;
    let groupCloneMs = 0;
    let collectMs = 0;
    let plainCloneMs = 0;
    let instancedCloneMs = 0;
    let plainJobs = 0;

    const newSelection: DuplicationSelection = { groups: new Set(), objects: new Map() };
    const groups = GroupUtils.getGroups(loadedObjectGroup);
    const idMap = new Map<string, string>();
    const jobs: CloneJobEntry[] = [];
    const cloneGroupCtx = groupIds ? GroupUtils.createCloneGroupContext(loadedObjectGroup) : undefined;

    if (groupIds) {
        const groupCloneStart = logTimings ? performance.now() : 0;
        for (const groupId of groupIds) {
            const group = groups.get(groupId);
            if (!group || getAncestorSelected(groups, group.parent, groupIds)) continue;

            const newGroupId = GroupUtils.cloneGroupStructure(loadedObjectGroup, groupId, group.parent, idMap, cloneGroupCtx);
            if (newGroupId) newSelection.groups.add(newGroupId);
        }
        if (logTimings) groupCloneMs += performance.now() - groupCloneStart;

        const collectStart = logTimings ? performance.now() : 0;
        for (const groupId of groupIds) {
            const group = groups.get(groupId);
            const newGroupId = idMap.get(groupId);
            if (!group || !newGroupId || getAncestorSelected(groups, group.parent, groupIds)) continue;

            GroupUtils.collectCloneJobsFromGroup(
                loadedObjectGroup,
                groupId,
                newGroupId,
                { _groupIdMap: idMap },
                jobs
            );
        }
        if (logTimings) collectMs += performance.now() - collectStart;
    }

    if (objectEntries) {
        const collectStart = logTimings ? performance.now() : 0;
        const objectToGroup = GroupUtils.getObjectToGroup(loadedObjectGroup);
        for (const { mesh, instanceId } of objectEntries) {
            const parentGroupId = objectToGroup.get(GroupUtils.getGroupKey(mesh, instanceId)) ?? null;
            if (getAncestorSelected(groups, parentGroupId, groupIds)) continue;
            jobs.push({ mesh, instanceId, targetGroupId: parentGroupId as string, coveredByGroup: false });
        }
        if (logTimings) collectMs += performance.now() - collectStart;
    }

    const instancedJobs = new Map<InstancedMesh, CloneJobEntry[]>();
    for (const job of jobs) {
        if (job.mesh.isInstancedMesh) {
            let bucket = instancedJobs.get(job.mesh);
            if (!bucket) {
                bucket = [];
                instancedJobs.set(job.mesh, bucket);
            }
            bucket.push(job);
        } else {
            plainJobs++;
            const plainStart = logTimings ? performance.now() : 0;
            addSelection(newSelection, clonePlainMesh(
                loadedObjectGroup,
                job.mesh as Mesh,
                job.instanceId,
                job.targetGroupId,
                job.coveredByGroup
            ));
            if (logTimings) plainCloneMs += performance.now() - plainStart;
        }
    }

    for (const [sourceMesh, batchJobs] of instancedJobs) {
        const instancedStart = logTimings ? performance.now() : 0;
        const results = cloneInstancedBatch(loadedObjectGroup, sourceMesh, batchJobs, timings);
        if (logTimings) instancedCloneMs += performance.now() - instancedStart;
        for (const result of results) {
            addSelection(newSelection, result);
        }
    }

    if (logTimings && timings) {
        const instancedJobsCount = jobs.length - plainJobs;
        console.log(
            `[PBDE] Duplicate timings: total=${(performance.now() - totalStart).toFixed(2)}ms ` +
            `jobs=${jobs.length} plain=${plainJobs} instanced=${instancedJobsCount} ` +
            `groups=${newSelection.groups.size} batches=${instancedJobs.size} chunks=${timings.chunks} ` +
            `groupClone=${groupCloneMs.toFixed(2)}ms collect=${collectMs.toFixed(2)}ms ` +
            `plainClone=${plainCloneMs.toFixed(2)}ms instancedClone=${instancedCloneMs.toFixed(2)}ms ` +
            `attrs=${timings.attrsMs.toFixed(2)}ms metadata=${timings.metadataMs.toFixed(2)}ms`
        );
    }

    return newSelection;
}
