import {
    InstancedMesh,
    BufferGeometry,
    BufferAttribute,
    Matrix4,
    Color,
    Object3D,
    Group,
    InstancedBufferAttribute,
    Mesh,
    Material,
    MathUtils
} from 'three/webgpu';
import * as GroupUtils from './group';
import type { CloneJobEntry } from './group';
import * as Overlay from '../selection/overlay';
import { createEntityMaterial } from '../../entityMaterial.js';

const getDisplayType = Overlay.getDisplayType;

interface DuplicationContext {
    headPool: Map<string, InstancedMesh>; // key -> InstancedMesh (player_head)
    tmpSourceWorld: Matrix4;
    tmpTargetLocal: Matrix4;
    tmpInv: Matrix4;
    tmpColor: Color;
    _groupIdMap?: Map<string, string>;
    planBatchCallback?: (mesh: Mesh | InstancedMesh, instanceId: number, targetGroupId: string | null) => void;
}

interface PendingHeadClone {
    sourceMesh: InstancedMesh;
    sourceId: number;
    targetGroupId: string | null;
    coveredByGroup: boolean;
}

interface CloneResult {
    mesh?: InstancedMesh | Mesh;
    instanceId?: number;
    objectUuid?: string;
    isPending?: boolean;
}

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
    sceneOrder?: SceneOrderEntry[];
}

interface SourceObjectLocation {
    parentGroupId: string | null;
    containerKind: 'group' | 'scene';
    container: Array<{ type: 'group' | 'object'; id?: string; mesh?: Object3D; instanceId?: number }>;
    index: number;
}

export interface DuplicationSelection {
    groups: Set<string>;
    objects: Map<InstancedMesh | Mesh, Set<number>>;
}

let _pendingHeadClones: PendingHeadClone[] = [];

function _cloneBlockProps<T>(value: T): T {
    if (value === null || value === undefined) return value;
    if (typeof structuredClone === 'function') {
        try {
            return structuredClone(value);
        } catch {
            // structuredClone can fail for non-cloneable values.
        }
    }

    if (Array.isArray(value)) {
        return value.map(v => _cloneBlockProps(v)) as unknown as T;
    }

    if (typeof value === 'object') {
        return { ...(value as Record<string, unknown>) } as T;
    }

    return value;
}

function _ensureDuplicateUserDataStores(loadedObjectGroup: Group): Required<Pick<
    DuplicateUserData,
    'instanceKeyToObjectUuid' | 'objectUuidToInstance' | 'objectNames' | 'objectIsItemDisplay' | 'objectDisplayTypes' | 'objectBlockProps'
>> & { sceneOrder?: SceneOrderEntry[]; objectToGroup?: Map<string, string> } {
    const ud = loadedObjectGroup.userData as DuplicateUserData;
    if (!ud.instanceKeyToObjectUuid) ud.instanceKeyToObjectUuid = new Map<string, string>();
    if (!ud.objectUuidToInstance) ud.objectUuidToInstance = new Map<string, { mesh: Object3D; instanceId: number }>();
    if (!ud.objectNames) ud.objectNames = new Map<string, string>();
    if (!ud.objectIsItemDisplay) ud.objectIsItemDisplay = new Set<string>();
    if (!ud.objectDisplayTypes) ud.objectDisplayTypes = new Map<string, string>();
    if (!ud.objectBlockProps) ud.objectBlockProps = new Map<string, unknown>();

    return {
        instanceKeyToObjectUuid: ud.instanceKeyToObjectUuid,
        objectUuidToInstance: ud.objectUuidToInstance,
        objectNames: ud.objectNames,
        objectIsItemDisplay: ud.objectIsItemDisplay,
        objectDisplayTypes: ud.objectDisplayTypes,
        objectBlockProps: ud.objectBlockProps,
        sceneOrder: ud.sceneOrder,
        objectToGroup: ud.objectToGroup
    };
}

function _registerClonedObjectMetadata(
    loadedObjectGroup: Group,
    sourceMesh: Mesh | InstancedMesh,
    sourceInstanceId: number,
    targetMesh: Mesh | InstancedMesh,
    targetInstanceId: number
): string {
    const stores = _ensureDuplicateUserDataStores(loadedObjectGroup);
    const sourceKey = GroupUtils.getGroupKey(sourceMesh, sourceInstanceId);
    const sourceUuid = stores.instanceKeyToObjectUuid.get(sourceKey);
    const newUuid = MathUtils.generateUUID();
    const targetKey = GroupUtils.getGroupKey(targetMesh, targetInstanceId);

    stores.instanceKeyToObjectUuid.set(targetKey, newUuid);
    stores.objectUuidToInstance.set(newUuid, { mesh: targetMesh, instanceId: targetInstanceId });

    if (sourceUuid) {
        const sourceName = stores.objectNames.get(sourceUuid);
        if (sourceName) stores.objectNames.set(newUuid, sourceName);

        if (stores.objectIsItemDisplay.has(sourceUuid)) {
            stores.objectIsItemDisplay.add(newUuid);
        }

        const sourceDisplayType = stores.objectDisplayTypes.get(sourceUuid);
        if (sourceDisplayType) {
            stores.objectDisplayTypes.set(newUuid, sourceDisplayType);
        }

        if (stores.objectBlockProps.has(sourceUuid)) {
            stores.objectBlockProps.set(newUuid, _cloneBlockProps(stores.objectBlockProps.get(sourceUuid)));
        }
    } else {
        stores.objectNames.set(newUuid, newUuid.slice(0, 8));
    }

    return newUuid;
}

function _findSourceObjectLocation(
    loadedObjectGroup: Group,
    sourceMesh: Mesh | InstancedMesh,
    sourceInstanceId: number
): SourceObjectLocation | null {
    const stores = _ensureDuplicateUserDataStores(loadedObjectGroup);
    const sourceKey = GroupUtils.getGroupKey(sourceMesh, sourceInstanceId);
    const sourceUuid = stores.instanceKeyToObjectUuid.get(sourceKey);
    if (!sourceUuid) return null;

    const groups = GroupUtils.getGroups(loadedObjectGroup);
    const parentGroupId = stores.objectToGroup?.get(sourceKey) ?? null;

    if (parentGroupId) {
        const parentGroup = groups.get(parentGroupId);
        if (parentGroup && Array.isArray(parentGroup.children)) {
            const index = parentGroup.children.findIndex((child) => child.type === 'object' && child.id === sourceUuid);
            if (index !== -1) {
                return {
                    parentGroupId,
                    containerKind: 'group',
                    container: parentGroup.children,
                    index
                };
            }
        }
    }

    if (Array.isArray(stores.sceneOrder)) {
        const index = stores.sceneOrder.findIndex((entry) => entry.type === 'object' && entry.id === sourceUuid);
        if (index !== -1) {
            return {
                parentGroupId: null,
                containerKind: 'scene',
                container: stores.sceneOrder,
                index
            };
        }
    }

    return null;
}

function _insertClonedObjectEntry(
    loadedObjectGroup: Group,
    sourceMesh: Mesh | InstancedMesh,
    sourceInstanceId: number,
    targetGroupId: string | null,
    targetMesh: Mesh | InstancedMesh,
    targetInstanceId: number,
    newObjectUuid: string,
    coveredByGroup: boolean
): void {
    const stores = _ensureDuplicateUserDataStores(loadedObjectGroup);
    const groups = GroupUtils.getGroups(loadedObjectGroup);

    if (targetGroupId) {
        const targetGroup = groups.get(targetGroupId);
        if (!targetGroup) return;
        if (!Array.isArray(targetGroup.children)) targetGroup.children = [];

        if (coveredByGroup) {
            targetGroup.children.push({ type: 'object', mesh: targetMesh, instanceId: targetInstanceId, id: newObjectUuid });
            return;
        }

        const sourceLocation = _findSourceObjectLocation(loadedObjectGroup, sourceMesh, sourceInstanceId);
        if (sourceLocation && sourceLocation.parentGroupId === targetGroupId && sourceLocation.containerKind === 'group') {
            sourceLocation.container.splice(sourceLocation.index + 1, 0, {
                type: 'object',
                mesh: targetMesh,
                instanceId: targetInstanceId,
                id: newObjectUuid
            });
            return;
        }

        targetGroup.children.push({ type: 'object', mesh: targetMesh, instanceId: targetInstanceId, id: newObjectUuid });
        return;
    }

    const sourceLocation = _findSourceObjectLocation(loadedObjectGroup, sourceMesh, sourceInstanceId);
    if (sourceLocation && sourceLocation.parentGroupId === null && sourceLocation.containerKind === 'scene') {
        sourceLocation.container.splice(sourceLocation.index + 1, 0, { type: 'object', id: newObjectUuid });
        return;
    }

    if (Array.isArray(stores.sceneOrder)) {
        stores.sceneOrder.push({ type: 'object', id: newObjectUuid });
    }
}

function createDuplicationContext(): DuplicationContext {
    return {
        headPool: new Map(),
        tmpSourceWorld: new Matrix4(),
        tmpTargetLocal: new Matrix4(),
        tmpInv: new Matrix4(),
        tmpColor: new Color()
    };
}

function _nextPow2(v: number): number {
    let x = v | 0;
    if (x <= 1) return 1;
    x--;
    x |= x >> 1;
    x |= x >> 2;
    x |= x >> 4;
    x |= x >> 8;
    x |= x >> 16;
    return x + 1;
}

function _headPoolKey(sourceMesh: InstancedMesh): string {
    if (!sourceMesh) return 'head|null';
    let material = sourceMesh.material;
    if (Array.isArray(material)) material = material[0];
    const matKey = material && material.uuid ? material.uuid : String(material);
    return `head|${matKey}`;
}

function _isPlayerHeadMesh(obj: Object3D): obj is InstancedMesh {
    return !!(obj && (obj as InstancedMesh).isInstancedMesh && (obj as InstancedMesh).geometry && (obj as InstancedMesh).geometry.attributes && (obj as InstancedMesh).geometry.attributes.instancedUvOffset && obj.userData && obj.userData.displayType === 'item_display');
}

function _getHeadCapacity(mesh: InstancedMesh): number {
    if (!mesh) return 0;
    const max = mesh.instanceMatrix && mesh.instanceMatrix.count ? mesh.instanceMatrix.count : 0;
    return mesh.userData && typeof mesh.userData._pdeHeadCapacity === 'number' ? mesh.userData._pdeHeadCapacity : max;
}

function _getHeadUsed(mesh: InstancedMesh): number {
    if (!mesh) return 0;
    if (mesh.userData && typeof mesh.userData._pdeHeadUsed === 'number') return mesh.userData._pdeHeadUsed;
    // Prefer render count if set.
    if (typeof mesh.count === 'number') return mesh.count;
    return 0;
}

function _setHeadUsed(mesh: InstancedMesh, used: number): void {
    if (!mesh.userData) mesh.userData = {};
    mesh.userData._pdeHeadUsed = used;
    mesh.count = used;
}

function _createWritableHeadMeshFromSource(sourceMesh: InstancedMesh, capacity: number): InstancedMesh {
    const sourceGeometry = sourceMesh.geometry;
    const sourceMaterial = sourceMesh.material;

    const geo = new BufferGeometry();
    if (sourceGeometry.index) geo.setIndex(sourceGeometry.index);
    if (sourceGeometry.attributes) {
        for (const name in sourceGeometry.attributes) {
            if (name === 'instancedUvOffset') continue;
            geo.setAttribute(name, sourceGeometry.attributes[name]);
        }
    }
    if (Array.isArray(sourceGeometry.groups) && sourceGeometry.groups.length) {
        geo.groups = sourceGeometry.groups.slice();
    }
    if (sourceGeometry.drawRange) {
        geo.drawRange.start = sourceGeometry.drawRange.start;
        geo.drawRange.count = sourceGeometry.drawRange.count;
    }
    if (sourceGeometry.boundingBox) geo.boundingBox = sourceGeometry.boundingBox;
    if (sourceGeometry.boundingSphere) geo.boundingSphere = sourceGeometry.boundingSphere;

    const uvOffsets = new Float32Array(capacity * 2);
    geo.setAttribute('instancedUvOffset', new InstancedBufferAttribute(uvOffsets, 2));

    const mesh = new InstancedMesh(geo, sourceMaterial, capacity);
    mesh.userData.displayType = 'item_display';
    mesh.userData.hasHat = {};
    mesh.userData.customPivots = new Map();
    mesh.userData.isWritableHead = true;
    mesh.userData._pdeHeadCapacity = capacity;
    mesh.userData._pdeHeadSourceGeoUuid = sourceGeometry && sourceGeometry.uuid ? sourceGeometry.uuid : null;
    mesh.frustumCulled = false;
    _setHeadUsed(mesh, 0);
    return mesh;
}

function _getOrCreateWritableHeadMesh(loadedObjectGroup: Group, sourceMesh: InstancedMesh, additionalCount: number, ctx: DuplicationContext): InstancedMesh | null {
    if (!sourceMesh || !ctx) return null;

    const key = _headPoolKey(sourceMesh);
    const cached = ctx.headPool.get(key);
    if (cached && _isPlayerHeadMesh(cached)) {
        const used = _getHeadUsed(cached);
        const cap = _getHeadCapacity(cached);
        if (used + additionalCount <= cap) return cached;
    }

    // Search existing scene for a reusable writable head mesh
    for (const child of loadedObjectGroup.children) {
        if (!_isPlayerHeadMesh(child)) continue;
        if (!child.userData || !child.userData.isWritableHead) continue;

        let matA = (child as InstancedMesh).material;
        let matB = sourceMesh.material;
        if (Array.isArray(matA)) matA = matA[0];
        if (Array.isArray(matB)) matB = matB[0];
        if (matA !== matB) continue;

        // We intentionally pool by material only to keep draw calls low.

        const used = _getHeadUsed(child as InstancedMesh);
        const cap = _getHeadCapacity(child as InstancedMesh);
        if (used + additionalCount <= cap) {
            ctx.headPool.set(key, child as InstancedMesh);
            return child as InstancedMesh;
        }
    }

    // Create a new pooled mesh with slack capacity
    const base = Math.max(256, additionalCount);
    const capacity = Math.max(2048, _nextPow2(base));
    const mesh = _createWritableHeadMeshFromSource(sourceMesh, capacity);
    loadedObjectGroup.add(mesh);
    ctx.headPool.set(key, mesh);
    return mesh;
}

function _planWritableBatchFor(mesh: InstancedMesh, _instanceId: number, _targetGroupId: string | null, ctx: DuplicationContext): void {
    if (!ctx || !mesh) return;
    if (mesh.isInstancedMesh && mesh.geometry && mesh.geometry.attributes && mesh.geometry.attributes.instancedUvOffset) {
        return;
    }
}

function _copyInstanceMetadata(
    loadedObjectGroup: Group,
    sourceMesh: Mesh | InstancedMesh,
    sourceInstanceId: number,
    targetMesh: Mesh | InstancedMesh,
    targetInstanceId: number
): string {
    return _registerClonedObjectMetadata(loadedObjectGroup, sourceMesh, sourceInstanceId, targetMesh, targetInstanceId);
}

function _clonePlainMesh(
    loadedObjectGroup: Group,
    sourceMesh: Mesh,
    sourceInstanceId: number,
    targetGroupId: string | null,
    coveredByGroup: boolean
): CloneResult | null {
    const clone = sourceMesh.clone() as Mesh;
    loadedObjectGroup.add(clone);
    const objectUuid = _copyInstanceMetadata(loadedObjectGroup, sourceMesh, sourceInstanceId, clone, 0);
    _insertClonedObjectEntry(loadedObjectGroup, sourceMesh, sourceInstanceId, targetGroupId, clone, 0, objectUuid, coveredByGroup);
    return { mesh: clone, instanceId: 0, objectUuid };
}

function _cloneInstancedMesh(
    loadedObjectGroup: Group,
    sourceMesh: InstancedMesh,
    sourceInstanceId: number,
    targetGroupId: string | null,
    ctx: DuplicationContext,
    coveredByGroup: boolean
): CloneResult | null {
    if (!sourceMesh || !sourceMesh.isInstancedMesh) return null;

    const geometry = sourceMesh.geometry;
    if (!geometry) return null;

    let material = sourceMesh.material;
    if (Array.isArray(material)) material = material[0];

    let cloneGeometry = geometry;
    let cloneMaterial = material;

    if (geometry.attributes && geometry.attributes.instancedUvOffset) {
        cloneGeometry = geometry.clone();
        const uv = cloneGeometry.attributes.uv as BufferAttribute | undefined;
        if (uv) {
            const sourceAttr = geometry.attributes.instancedUvOffset as InstancedBufferAttribute;
            const u = sourceAttr.getX(sourceInstanceId);
            const v = sourceAttr.getY(sourceInstanceId);
            for (let i = 0; i < uv.count; i++) {
                uv.setXY(i, uv.getX(i) + u, uv.getY(i) + v);
            }
            uv.needsUpdate = true;
        }
        cloneGeometry.deleteAttribute('instancedUvOffset');

        if (material && (material as Material).map) {
            const sourceMat = material as Material;
            if (!sourceMat.userData.bakedVariant) {
                const { material: newMat } = createEntityMaterial(sourceMat.map, 0xffffff, false);
                newMat.side = sourceMat.side;
                newMat.alphaTest = sourceMat.alphaTest;
                newMat.transparent = sourceMat.transparent;
                newMat.depthWrite = sourceMat.depthWrite;
                newMat.toneMapped = sourceMat.toneMapped;
                newMat.fog = sourceMat.fog;
                newMat.flatShading = sourceMat.flatShading;
                sourceMat.userData.bakedVariant = newMat;
            }
            cloneMaterial = sourceMat.userData.bakedVariant;
        }
    }

    const cloneMesh = new InstancedMesh(cloneGeometry, cloneMaterial, 1);
    cloneMesh.frustumCulled = false;
    cloneMesh.userData.displayType = getDisplayType(sourceMesh, sourceInstanceId) ?? sourceMesh.userData?.displayType ?? 'block_display';
    cloneMesh.userData.displayTypes = new Map();
    cloneMesh.userData.geometryBounds = new Map();
    cloneMesh.userData.localMatrices = new Map();
    cloneMesh.userData.originalGeometries = new Map();
    cloneMesh.userData.customPivots = new Map();

    const sourceWorld = ctx ? ctx.tmpSourceWorld : new Matrix4();
    sourceMesh.getMatrixAt(sourceInstanceId, sourceWorld);
    sourceWorld.premultiply(sourceMesh.matrixWorld);
    const targetLocal = ctx ? ctx.tmpTargetLocal : new Matrix4();
    const parentInv = loadedObjectGroup.matrixWorld.clone().invert();
    targetLocal.copy(sourceWorld).premultiply(parentInv);
    cloneMesh.setMatrixAt(0, targetLocal);

    if (sourceMesh.getColorAt) {
        try {
            const c = ctx ? ctx.tmpColor : new Color();
            sourceMesh.getColorAt(sourceInstanceId, c);
            cloneMesh.setColorAt(0, c);
        } catch {
            // ignore color copy failures
        }
    }

    if (sourceMesh.userData.hasHat && sourceMesh.userData.hasHat[sourceInstanceId] !== undefined) {
        cloneMesh.userData.hasHat = { 0: sourceMesh.userData.hasHat[sourceInstanceId] };
    }

    if (sourceMesh.userData.customPivots && sourceMesh.userData.customPivots.has(sourceInstanceId)) {
        cloneMesh.userData.customPivots.set(0, sourceMesh.userData.customPivots.get(sourceInstanceId).clone());
    } else if (sourceMesh.userData.customPivot) {
        cloneMesh.userData.customPivots.set(0, sourceMesh.userData.customPivot.clone());
    }

    if (sourceMesh.userData.localMatrices && sourceMesh.userData.localMatrices.has(sourceInstanceId)) {
        cloneMesh.userData.localMatrices.set(0, sourceMesh.userData.localMatrices.get(sourceInstanceId).clone());
    }

    loadedObjectGroup.add(cloneMesh);
    const objectUuid = _copyInstanceMetadata(loadedObjectGroup, sourceMesh, sourceInstanceId, cloneMesh, 0);
    _insertClonedObjectEntry(loadedObjectGroup, sourceMesh, sourceInstanceId, targetGroupId, cloneMesh, 0, objectUuid, coveredByGroup);

    cloneMesh.instanceMatrix.needsUpdate = true;
    return { mesh: cloneMesh, instanceId: 0, objectUuid };
}

export function flushPendingHeadClones(loadedObjectGroup: Group, ctx: DuplicationContext): Array<{ mesh: InstancedMesh, instanceId: number, targetGroupId: string | null, coveredByGroup: boolean }> {
    if (_pendingHeadClones.length === 0) return [];

    const newSelectionItems: Array<{ mesh: InstancedMesh, instanceId: number, targetGroupId: string | null, coveredByGroup: boolean }> = [];
    const jobsByKey = new Map<string, { sourceMesh: InstancedMesh, jobs: PendingHeadClone[] }>();

    // Group by pooling key (material) so we reuse a single InstancedMesh across repeated duplicates
    for (const job of _pendingHeadClones) {
        const key = _headPoolKey(job.sourceMesh);
        let entry = jobsByKey.get(key);
        if (!entry) {
            entry = { sourceMesh: job.sourceMesh, jobs: [] };
            jobsByKey.set(key, entry);
        }
        entry.jobs.push(job);
    }

    _pendingHeadClones = []; // Clear global

    const parentInv = loadedObjectGroup.matrixWorld.clone().invert();
    const sourceMatrix = new Matrix4();

    for (const { sourceMesh, jobs } of jobsByKey.values()) {
        const count = jobs.length;
        const targetMesh = _getOrCreateWritableHeadMesh(loadedObjectGroup, sourceMesh, count, ctx);
        if (!targetMesh) continue;

        const start = _getHeadUsed(targetMesh);
        const uvAttr = targetMesh.geometry && targetMesh.geometry.attributes ? targetMesh.geometry.attributes.instancedUvOffset as InstancedBufferAttribute : null;
        if (!uvAttr) continue;
        const uvArray = uvAttr.array as Float32Array;

        for (let i = 0; i < count; i++) {
            const { sourceMesh: sm, sourceId, targetGroupId, coveredByGroup } = jobs[i];
            const dstId = start + i;

            // Matrix: Source World -> Target Local
            sm.getMatrixAt(sourceId, sourceMatrix);
            sourceMatrix.premultiply(sm.matrixWorld);
            const targetLocal = sourceMatrix.multiply(parentInv);
            targetMesh.setMatrixAt(dstId, targetLocal);

            // UV Offset
            const sourceAttr = sm.geometry && sm.geometry.attributes ? sm.geometry.attributes.instancedUvOffset as InstancedBufferAttribute : null;
            if (sourceAttr) {
                const u = sourceAttr.getX(sourceId);
                const v = sourceAttr.getY(sourceId);
                const o = dstId * 2;
                uvArray[o] = u;
                uvArray[o + 1] = v;
            }

            // HasHat
            if (sm.userData && sm.userData.hasHat && sm.userData.hasHat[sourceId] !== undefined) {
                targetMesh.userData.hasHat[dstId] = sm.userData.hasHat[sourceId];
            }

            // Custom Pivot
            if (sm.userData.customPivots && sm.userData.customPivots.has(sourceId)) {
                if (!targetMesh.userData.customPivots) targetMesh.userData.customPivots = new Map();
                targetMesh.userData.customPivots.set(dstId, sm.userData.customPivots.get(sourceId).clone());
            } else if (sm.userData.customPivot) {
                if (!targetMesh.userData.customPivots) targetMesh.userData.customPivots = new Map();
                targetMesh.userData.customPivots.set(dstId, sm.userData.customPivot.clone());
            }

            const newObjectUuid = _registerClonedObjectMetadata(
                loadedObjectGroup,
                sm,
                sourceId,
                targetMesh,
                dstId
            );

            // Register Group mapping
            if (targetGroupId) {
                const groups = GroupUtils.getGroups(loadedObjectGroup);
                const group = groups.get(targetGroupId);
                if (group) {
                    if (!Array.isArray(group.children)) group.children = [];
                    group.children.push({ type: 'object', mesh: targetMesh, instanceId: dstId, id: newObjectUuid });
                }
                const objectToGroup = GroupUtils.getObjectToGroup(loadedObjectGroup);
                const key = GroupUtils.getGroupKey(targetMesh, dstId);
                objectToGroup.set(key, targetGroupId);
            }

            newSelectionItems.push({ mesh: targetMesh, instanceId: dstId, targetGroupId, coveredByGroup });
        }

        _setHeadUsed(targetMesh, start + count);
        targetMesh.instanceMatrix.needsUpdate = true;
        uvAttr.needsUpdate = true;
    }

    return newSelectionItems;
}

function cloneInstance(
    loadedObjectGroup: Group,
    mesh: Mesh | InstancedMesh,
    instanceId: number,
    targetGroupId: string | null,
    ctx: DuplicationContext,
    coveredByGroup: boolean = false
): CloneResult | null {
    if (!mesh) return null;

    if (mesh.isInstancedMesh && mesh.geometry && mesh.geometry.attributes && mesh.geometry.attributes.instancedUvOffset) {
        _pendingHeadClones.push({ sourceMesh: mesh, sourceId: instanceId, targetGroupId, coveredByGroup });
        return { isPending: true };
    }

    if (mesh.isInstancedMesh) {
        return _cloneInstancedMesh(loadedObjectGroup, mesh, instanceId, targetGroupId, ctx, coveredByGroup);
    }

    return _clonePlainMesh(loadedObjectGroup, mesh, instanceId, targetGroupId, coveredByGroup);
}

function cloneGroup(loadedObjectGroup: Group, groupId: string, parentId: string | null, idMap: Map<string, string>, _ctx: DuplicationContext): string | null {
    return GroupUtils.cloneGroupStructure(loadedObjectGroup, groupId, parentId, idMap);
}

function _collectCloneJobsFromGroup(loadedObjectGroup: Group, groupId: string, newGroupId: string, ctx: DuplicationContext, outJobs: CloneJobEntry[]): void {
    // Inject planning callback
    const ctxWithCallback: DuplicationContext = {
        ...ctx,
        planBatchCallback: (mesh, instanceId, targetGroupId) => _planWritableBatchFor(mesh, instanceId, targetGroupId, ctx)
    };
    GroupUtils.collectCloneJobsFromGroup(loadedObjectGroup, groupId, newGroupId, ctxWithCallback, outJobs);
}

export function duplicateGroupsAndObjects(loadedObjectGroup: Group, groupIds: Set<string> | null, objectEntries: Array<{ mesh: Mesh | InstancedMesh, instanceId: number }> | null): DuplicationSelection {
    const ctx = createDuplicationContext();
    _pendingHeadClones = [];

    const newSelection: DuplicationSelection = { groups: new Set(), objects: new Map() };
    const idMap = new Map<string, string>(); // OldGroupID -> NewGroupID
    const groups = GroupUtils.getGroups(loadedObjectGroup);
    const jobs: CloneJobEntry[] = [];
    ctx._groupIdMap = idMap;

    // 1. Duplicate Groups
    if (groupIds) {
        for (const groupId of groupIds) {
            const group = groups.get(groupId);
            if (!group) continue;

            // If parent is also selected, this group will be cloned recursively by the parent.
            // We should only explicitly clone roots of the selection forest.
            let isParentSelected = false;
            let curr = group.parent;
            while(curr) {
                 if (groupIds.has(curr)) {
                     isParentSelected = true;
                     break;
                 }
                 const p = groups.get(curr);
                 curr = p ? p.parent : null;
            }

            if (!isParentSelected) {
                const newGroupId = cloneGroup(loadedObjectGroup, groupId, group.parent, idMap, ctx);
                if (newGroupId) newSelection.groups.add(newGroupId);
            }
        }
    }

    // Collect clone jobs for all objects inside newly-created group trees
    if (groupIds) {
        for (const groupId of groupIds) {
            // Only roots were added to selection; collect from roots only.
            const newGroupId = idMap.get(groupId);
            if (!newGroupId) continue;

            // If parent is selected, it wasn't mapped at root-level here; skip non-roots.
            const group = groups.get(groupId);
            if (!group) continue;
            let isParentSelected = false;
            let curr = group.parent;
            while (curr) {
                if (groupIds.has(curr)) {
                    isParentSelected = true;
                    break;
                }
                const p = groups.get(curr);
                curr = p ? p.parent : null;
            }
            if (isParentSelected) continue;

            _collectCloneJobsFromGroup(loadedObjectGroup, groupId, newGroupId, ctx, jobs);
        }
    }

    // 2. Duplicate Objects
    // If an object is inside a selected group, it's already cloned.
    // We only clone objects not covered by selected groups.
    if (objectEntries) {
        const objectToGroup = GroupUtils.getObjectToGroup(loadedObjectGroup);

        for (const { mesh, instanceId } of objectEntries) {
             const key = GroupUtils.getGroupKey(mesh, instanceId);
             const parentGroupId = objectToGroup.get(key);

             // Check if parent group (or any ancestor) is selected
             let isAncestorSelected = false;
             let curr = parentGroupId;
             while(curr) {
                 if (groupIds && groupIds.has(curr)) {
                     isAncestorSelected = true;
                     break;
                 }
                 const p = groups.get(curr);
                 curr = p ? p.parent : null;
            }

             if (!isAncestorSelected) {
                 // Plan + clone in a second pass
                 const targetGroup = parentGroupId; // Stay in same group
                 _planWritableBatchFor(mesh, instanceId, targetGroup, ctx);
                 jobs.push({ mesh, instanceId, targetGroupId: targetGroup, coveredByGroup: false });
             }
        }
    }

    // Execute clone jobs
    for (const job of jobs) {
        const result = cloneInstance(loadedObjectGroup, job.mesh, job.instanceId, job.targetGroupId, ctx, job.coveredByGroup);
        if (result && !result.isPending && !job.coveredByGroup && result.mesh) {
            if (!newSelection.objects.has(result.mesh)) {
                newSelection.objects.set(result.mesh, new Set());
            }
            newSelection.objects.get(result.mesh)!.add(result.instanceId!);
        }
    }

    // Flush pending bulk clones (Player Heads)
    const newHeads = flushPendingHeadClones(loadedObjectGroup, ctx);
    for (const { mesh, instanceId, coveredByGroup } of newHeads) {
        if (coveredByGroup) continue;
        if (!newSelection.objects.has(mesh)) {
            newSelection.objects.set(mesh, new Set());
        }
        newSelection.objects.get(mesh)!.add(instanceId);
    }

    return newSelection;
}
