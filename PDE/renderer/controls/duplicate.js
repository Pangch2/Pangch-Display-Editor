import * as THREE from 'three/webgpu';
import * as GroupUtils from './group.js';
import * as Overlay from './overlay.js';
import { createEntityMaterial } from '../entityMaterial.js';

const getDisplayType = Overlay.getDisplayType;

const _WRITABLE_BATCH_SIZE = 512;
const _WRITABLE_BATCH_MAX_VERTS = _WRITABLE_BATCH_SIZE * 512; 
const _WRITABLE_BATCH_MAX_INDICES = _WRITABLE_BATCH_SIZE * 768; 

let _pendingHeadClones = [];

function createDuplicationContext() {
    return {
        batchPool: new Map(), // key -> BatchedMesh
        batchWorldInv: new WeakMap(), // BatchedMesh -> Matrix4
        batchGeometryToId: new WeakMap(), // BatchedMesh -> Map<BufferGeometry, number>
        batchPlans: new Map(), // key -> { instanceCount, maxVerts, maxIndices, geometries:Set<BufferGeometry> }
        fullBatches: new WeakSet(), // BatchedMesh that hit max during this duplication pass
        headPool: new Map(), // key -> InstancedMesh (player_head)
        tmpSourceWorld: new THREE.Matrix4(),
        tmpTargetLocal: new THREE.Matrix4(),
        tmpInv: new THREE.Matrix4(),
        tmpColor: new THREE.Color(),
        itemIdMap: new Map() // Old ItemId -> New ItemId
    };
}

function _nextPow2(v) {
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

function _headPoolKey(sourceMesh) {
    if (!sourceMesh) return 'head|null';
    let material = sourceMesh.material;
    if (Array.isArray(material)) material = material[0];
    const matKey = material && material.uuid ? material.uuid : String(material);
    return `head|${matKey}`;
}

function _isPlayerHeadMesh(obj) {
    return !!(obj && obj.isInstancedMesh && obj.geometry && obj.geometry.attributes && obj.geometry.attributes.instancedUvOffset && obj.userData && obj.userData.displayType === 'item_display');
}

function _getHeadCapacity(mesh) {
    if (!mesh) return 0;
    const max = mesh.instanceMatrix && mesh.instanceMatrix.count ? mesh.instanceMatrix.count : 0;
    return mesh.userData && typeof mesh.userData._pdeHeadCapacity === 'number' ? mesh.userData._pdeHeadCapacity : max;
}

function _getHeadUsed(mesh) {
    if (!mesh) return 0;
    if (mesh.userData && typeof mesh.userData._pdeHeadUsed === 'number') return mesh.userData._pdeHeadUsed;
    // Prefer render count if set.
    if (typeof mesh.count === 'number') return mesh.count;
    return 0;
}

function _setHeadUsed(mesh, used) {
    if (!mesh.userData) mesh.userData = {};
    mesh.userData._pdeHeadUsed = used;
    mesh.count = used;
}

function _createWritableHeadMeshFromSource(sourceMesh, capacity) {
    const sourceGeometry = sourceMesh.geometry;
    const sourceMaterial = sourceMesh.material;

    const geo = new THREE.BufferGeometry();
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
    geo.setAttribute('instancedUvOffset', new THREE.InstancedBufferAttribute(uvOffsets, 2));

    const mesh = new THREE.InstancedMesh(geo, sourceMaterial, capacity);
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

function _getOrCreateWritableHeadMesh(loadedObjectGroup, sourceMesh, additionalCount, ctx) {
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

        let matA = child.material;
        let matB = sourceMesh.material;
        if (Array.isArray(matA)) matA = matA[0];
        if (Array.isArray(matB)) matB = matB[0];
        if (matA !== matB) continue;

        // We intentionally pool by material only to keep draw calls low.

        const used = _getHeadUsed(child);
        const cap = _getHeadCapacity(child);
        if (used + additionalCount <= cap) {
            ctx.headPool.set(key, child);
            return child;
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

function _getBatchMaxInstances(batch) {
    if (!batch) return null;
    if (batch.userData && typeof batch.userData._pdeMaxInstances === 'number') return batch.userData._pdeMaxInstances;
    // Prefer public property if present, otherwise fall back to three internal fields.
    const publicMax = batch.maxInstanceCount;
    if (typeof publicMax === 'number') {
        if (!batch.userData) batch.userData = {};
        batch.userData._pdeMaxInstances = publicMax;
        return publicMax;
    }
    const internalMax = batch._maxInstanceCount;
    if (typeof internalMax === 'number') {
        if (!batch.userData) batch.userData = {};
        batch.userData._pdeMaxInstances = internalMax;
        return internalMax;
    }
    return null;
}

function _getBatchCurrentInstances(batch) {
    if (!batch) return 0;
    if (batch.userData && Array.isArray(batch.userData.instanceGeometryIds)) return batch.userData.instanceGeometryIds.length;
    const internalCount = batch._instanceCount;
    if (typeof internalCount === 'number') return internalCount;
    return 0;
}

function _batchHasSpace(batch) {
    const max = _getBatchMaxInstances(batch);
    if (!max) return true; // Unknown: allow and rely on retry path
    return _getBatchCurrentInstances(batch) < max;
}

function _planWritableBatchFor(mesh, instanceId, targetGroupId, ctx) {
    if (!ctx || !mesh) return;

    // Player heads are handled by a dedicated bulk path (InstancedMesh with instancedUvOffset)
    if (mesh.isInstancedMesh && mesh.geometry && mesh.geometry.attributes && mesh.geometry.attributes.instancedUvOffset) {
        return;
    }

    let geometry = null;
    let material = mesh.material;
    if (Array.isArray(material)) material = material[0];

    if (mesh.isBatchedMesh) {
        const geomId = mesh.userData && mesh.userData.instanceGeometryIds ? mesh.userData.instanceGeometryIds[instanceId] : null;
        if (geomId !== null && mesh.userData && mesh.userData.originalGeometries) {
            geometry = mesh.userData.originalGeometries.get(geomId);
        }
    } else if (mesh.isInstancedMesh) {
        geometry = mesh.geometry;
    }

    if (!geometry || !material) return;

    // Pool writable batches globally by material (not by group) to keep draw calls low,
    // matching how the loader batches blocks while storing group membership separately.
    const key = _batchPoolKey(material);
    let plan = ctx.batchPlans.get(key);
    if (!plan) {
        plan = { instanceCount: 0, maxVerts: 0, maxIndices: 0, geometries: new Set() };
        ctx.batchPlans.set(key, plan);
    }

    plan.instanceCount++;

    if (!plan.geometries.has(geometry)) {
        plan.geometries.add(geometry);
        const pos = geometry.attributes && geometry.attributes.position;
        const idx = geometry.index;
        plan.maxVerts += pos ? pos.count : 0;
        plan.maxIndices += idx ? idx.count : 0;
    }
}

function _batchPoolKey(material) {
    const matKey = material && material.uuid ? material.uuid : String(material);
    return `${matKey}`;
}

function _getBatchWorldInverse(batch, ctx) {
    const cached = ctx.batchWorldInv.get(batch);
    if (cached) return cached;
    const inv = new THREE.Matrix4().copy(batch.matrixWorld).invert();
    ctx.batchWorldInv.set(batch, inv);
    return inv;
}

function _getOrCreateBatchGeometryId(batch, geometry, ctx) {
    if (!batch || !geometry) return -1;

    let map = ctx.batchGeometryToId.get(batch);
    if (!map) {
        map = new Map();
        // Seed from existing geometries once (avoids scanning originalGeometries per clone)
        if (batch.userData && batch.userData.originalGeometries) {
            for (const [id, geo] of batch.userData.originalGeometries) {
                if (geo) map.set(geo, id);
            }
        }
        ctx.batchGeometryToId.set(batch, map);
    }

    const existing = map.get(geometry);
    if (existing !== undefined) return existing;

    const newId = batch.addGeometry(geometry);
    if (!batch.userData.originalGeometries) batch.userData.originalGeometries = new Map();
    batch.userData.originalGeometries.set(newId, geometry);

    if (!batch.userData.geometryBounds) batch.userData.geometryBounds = new Map();
    if (!geometry.boundingBox) geometry.computeBoundingBox();
    if (geometry.boundingBox) batch.userData.geometryBounds.set(newId, geometry.boundingBox.clone());

    map.set(geometry, newId);
    return newId;
}

function flushPendingHeadClones(loadedObjectGroup, ctx) {
    if (_pendingHeadClones.length === 0) return [];

    const newSelectionItems = [];
    const jobsByKey = new Map();

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
    const sourceMatrix = new THREE.Matrix4();

    for (const { sourceMesh, jobs } of jobsByKey.values()) {
        const count = jobs.length;
        const targetMesh = _getOrCreateWritableHeadMesh(loadedObjectGroup, sourceMesh, count, ctx);
        if (!targetMesh) continue;

        const start = _getHeadUsed(targetMesh);
        const uvAttr = targetMesh.geometry && targetMesh.geometry.attributes ? targetMesh.geometry.attributes.instancedUvOffset : null;
        if (!uvAttr) continue;
        const uvArray = uvAttr.array;

        for (let i = 0; i < count; i++) {
            const { sourceMesh: sm, sourceId, targetGroupId, coveredByGroup } = jobs[i];
            const dstId = start + i;

            // Matrix: Source World -> Target Local
            sm.getMatrixAt(sourceId, sourceMatrix);
            sourceMatrix.premultiply(sm.matrixWorld);
            const targetLocal = sourceMatrix.multiply(parentInv);
            targetMesh.setMatrixAt(dstId, targetLocal);

            // UV Offset
            const sourceAttr = sm.geometry && sm.geometry.attributes ? sm.geometry.attributes.instancedUvOffset : null;
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

            // Register Group mapping
            if (targetGroupId) {
                const groups = GroupUtils.getGroups(loadedObjectGroup);
                const group = groups.get(targetGroupId);
                if (group) {
                    if (!Array.isArray(group.children)) group.children = [];
                    group.children.push({ type: 'object', mesh: targetMesh, instanceId: dstId });
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

function getOrCreateWritableBatch(loadedObjectGroup, targetGroupId, material, geometry, ctx) {
    if (ctx) {
        const key = _batchPoolKey(material);
        const cached = ctx.batchPool.get(key);
        if (cached) {
            if (ctx.fullBatches && ctx.fullBatches.has(cached)) {
                ctx.batchPool.delete(key);
            } else if (!_batchHasSpace(cached)) {
                ctx.fullBatches && ctx.fullBatches.add(cached);
                ctx.batchPool.delete(key);
            } else {
                return cached;
            }
        }
    }
    
    let candidateMesh = null;

    // Always search globally for a reusable writable batch.
    // Group membership is tracked in the custom group maps, not in the Three.js scene graph.
    for (const child of loadedObjectGroup.children) {
        if (!child || !child.isBatchedMesh) continue;
        if (!child.userData || !child.userData.isWritable) continue;
        if (child.material !== material) continue;
        if (ctx && ctx.fullBatches && ctx.fullBatches.has(child)) continue;
        const maxInstances = _getBatchMaxInstances(child);
        const currentInstances = _getBatchCurrentInstances(child);
        if (!maxInstances || currentInstances < maxInstances) {
            candidateMesh = child;
            break;
        }
    }

    if (candidateMesh) {
        if (ctx) ctx.batchPool.set(_batchPoolKey(material), candidateMesh);
        return candidateMesh;
    }

    // 2. Create new batch (size from plan when available to avoid reallocation / overflow)
    const planKey = ctx ? _batchPoolKey(material) : null;
    const plan = (ctx && planKey) ? ctx.batchPlans.get(planKey) : null;

    let maxInstances = _WRITABLE_BATCH_SIZE;
    let maxVerts = _WRITABLE_BATCH_MAX_VERTS;
    let maxIndices = _WRITABLE_BATCH_MAX_INDICES;

    if (plan) {
        // Small slack to prevent edge overflow while still being tight.
        const inst = Math.max(1, plan.instanceCount);
        const verts = Math.max(64, plan.maxVerts);
        const indices = Math.max(64, plan.maxIndices);

        maxInstances = Math.ceil(inst * 1.1) + 8;
        maxVerts = Math.ceil(verts * 1.1) + 64;
        maxIndices = Math.ceil(indices * 1.1) + 64;
    }

    const batch = new THREE.BatchedMesh(maxInstances, maxVerts, maxIndices, material);
    batch.frustumCulled = false;
    batch.userData.isWritable = true;
    batch.userData._pdeMaxInstances = maxInstances;
    batch.userData.displayType = 'block_display';
    batch.userData.displayTypes = new Map();
    batch.userData.geometryBounds = new Map();
    batch.userData.instanceGeometryIds = [];
    batch.userData.itemIds = new Map();
    batch.userData.localMatrices = new Map();
    batch.userData.originalGeometries = new Map();
    batch.userData.customPivots = new Map();

    loadedObjectGroup.add(batch);

    if (ctx) ctx.batchPool.set(_batchPoolKey(material), batch);
    return batch;
}

function cloneInstance(loadedObjectGroup, mesh, instanceId, targetGroupId, ctx, coveredByGroup = false) {
    if (!mesh) return null;

    // Detect Player Head (InstancedMesh with instancedUvOffset) for Bulk Cloning
    if (mesh.isInstancedMesh && mesh.geometry && mesh.geometry.attributes.instancedUvOffset) {
        _pendingHeadClones.push({ sourceMesh: mesh, sourceId: instanceId, targetGroupId, coveredByGroup });
        return { isPending: true };
    }

    let geometry = null;
    let material = mesh.material;
    
    // Extract Geometry
    if (mesh.isBatchedMesh) {
        const geomId = mesh.userData.instanceGeometryIds ? mesh.userData.instanceGeometryIds[instanceId] : null;
        if (geomId !== null && mesh.userData.originalGeometries) {
            geometry = mesh.userData.originalGeometries.get(geomId);
        }
    } else if (mesh.isInstancedMesh) {
        geometry = mesh.geometry;

        // Player Head: Bake UV offset from instanced attribute to geometry UVs
        if (geometry && geometry.attributes.instancedUvOffset) {
            const attr = geometry.attributes.instancedUvOffset;
            const u = attr.getX(instanceId);
            const v = attr.getY(instanceId);

            // Always clone to separate from the shared instanced geometry and strip the attribute
            geometry = geometry.clone();
            const uv = geometry.attributes.uv;
            if (uv) {
                for (let i = 0; i < uv.count; i++) {
                    uv.setXY(i, uv.getX(i) + u, uv.getY(i) + v);
                }
                uv.needsUpdate = true;
            }
            geometry.deleteAttribute('instancedUvOffset');

            // Replace material with one that doesn't use instancedUvOffset
            // (The original material expects the attribute, which we just deleted)
            let sourceMat = mesh.material;
            if (Array.isArray(sourceMat)) sourceMat = sourceMat[0];

            if (sourceMat && sourceMat.map) {
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
                material = sourceMat.userData.bakedVariant;
            }
        }
    }

    if (!geometry) {
        console.warn('Cannot duplicate: Geometry not found');
        return null;
    }
    
    if (Array.isArray(material)) material = material[0];

    // Find target batch
    let targetBatch = getOrCreateWritableBatch(loadedObjectGroup, targetGroupId, material, geometry, ctx);
    if (!targetBatch) {
        console.error('Failed to create writable batch');
        return null;
    }

    // If the cached/candidate batch is already full, force rollover before adding.
    if (ctx && !_batchHasSpace(targetBatch)) {
        const key = _batchPoolKey(material);
        ctx.fullBatches && ctx.fullBatches.add(targetBatch);
        ctx.batchPool && ctx.batchPool.delete(key);
        targetBatch = getOrCreateWritableBatch(loadedObjectGroup, targetGroupId, material, geometry, ctx);
        if (!targetBatch) {
            console.error('Failed to create writable batch (rollover)');
            return null;
        }
    }

    // Add Geometry (reuse if exists in target) - O(1) via per-duplication cache
    let targetGeomId = -1;
    let attempts = 0;
    while (true) {
        attempts++;
        try {
            if (ctx) {
                targetGeomId = _getOrCreateBatchGeometryId(targetBatch, geometry, ctx);
            } else {
                // Fallback (should be rare)
                let id = -1;
                if (targetBatch.userData && targetBatch.userData.originalGeometries) {
                    for (const [gid, geo] of targetBatch.userData.originalGeometries) {
                        if (geo === geometry) { id = gid; break; }
                    }
                }
                if (id === -1) {
                    id = targetBatch.addGeometry(geometry);
                    if (!targetBatch.userData.originalGeometries) targetBatch.userData.originalGeometries = new Map();
                    targetBatch.userData.originalGeometries.set(id, geometry);
                    if (!targetBatch.userData.geometryBounds) targetBatch.userData.geometryBounds = new Map();
                    if (!geometry.boundingBox) geometry.computeBoundingBox();
                    if (geometry.boundingBox) targetBatch.userData.geometryBounds.set(id, geometry.boundingBox.clone());
                }
                targetGeomId = id;
            }
            break;
        } catch (e) {
            const msg = e ? (e.message || String(e)) : '';
            if (ctx && attempts < 100 && msg && (msg.includes('Reserved space request exceeds') || msg.includes('maximum buffer size'))) {
                const key = _batchPoolKey(material);
                if (ctx.fullBatches) ctx.fullBatches.add(targetBatch);
                if (ctx.batchPool && ctx.batchPool.get(key) === targetBatch) ctx.batchPool.delete(key);
    
                targetBatch = getOrCreateWritableBatch(loadedObjectGroup, targetGroupId, material, geometry, ctx);
                if (!targetBatch) {
                    console.error('Failed to create writable batch (geometry rollover)');
                    return null;
                }
                continue;
            }
            throw e;
        }
    }

    // Add Instance (retry once on capacity error)
    let newInstanceId;
    let usedGeomId = targetGeomId;
    try {
        newInstanceId = targetBatch.addInstance(targetGeomId);
    } catch (e) {
        const msg = (e && e.message) ? String(e.message) : '';
        if (ctx && msg.includes('Maximum item count reached')) {
            const key = _batchPoolKey(material);
            ctx.fullBatches && ctx.fullBatches.add(targetBatch);
            ctx.batchPool && ctx.batchPool.delete(key);

            // Create/resolve a new batch and retry once
            targetBatch = getOrCreateWritableBatch(loadedObjectGroup, targetGroupId, material, geometry, ctx);
            const retryGeomId = ctx ? _getOrCreateBatchGeometryId(targetBatch, geometry, ctx) : targetGeomId;
            usedGeomId = retryGeomId;
            newInstanceId = targetBatch.addInstance(retryGeomId);
        } else {
            throw e;
        }
    }
    targetBatch.userData.instanceGeometryIds[newInstanceId] = usedGeomId;

    // Copy Transforms
    // 1. World Matrix of source instance
    const sourceWorld = ctx ? ctx.tmpSourceWorld : new THREE.Matrix4();
    mesh.getMatrixAt(instanceId, sourceWorld);
    sourceWorld.premultiply(mesh.matrixWorld); // World space

    // 2. Target Local Matrix (Target Batch World Inverse * Source World)
    const targetLocal = ctx ? ctx.tmpTargetLocal : new THREE.Matrix4();
    const invTargetWorld = ctx ? _getBatchWorldInverse(targetBatch, ctx) : targetBatch.matrixWorld.clone().invert();
    targetLocal.copy(sourceWorld).premultiply(invTargetWorld);
    targetBatch.setMatrixAt(newInstanceId, targetLocal);

    // Copy UserData
    // Local Matrices (Blockstates)
    if (mesh.isBatchedMesh && mesh.userData.localMatrices && mesh.userData.localMatrices.has(instanceId)) {
        targetBatch.userData.localMatrices.set(newInstanceId, mesh.userData.localMatrices.get(instanceId).clone());
    }

    // Color
    if (mesh.getColorAt) {
        // InstancedMesh.getColorAt throws if instanceColor is null
        if (mesh.isInstancedMesh && !mesh.instanceColor) {
            // No instance colors to copy
        } else {
            try {
                const c = ctx ? ctx.tmpColor : new THREE.Color();
                mesh.getColorAt(instanceId, c);
                targetBatch.setColorAt(newInstanceId, c);
            } catch (e) {
                // Ignore color copy errors
            }
        }
    }

    // Display Types
    const displayType = getDisplayType(mesh, instanceId);
    if (displayType) {
        if (!targetBatch.userData.displayTypes) targetBatch.userData.displayTypes = new Map();
        targetBatch.userData.displayTypes.set(newInstanceId, displayType);
    }
    
    // Item IDs
    if (mesh.userData.itemIds && mesh.userData.itemIds.has(instanceId)) {
        const oldItemId = mesh.userData.itemIds.get(instanceId);
        let newItemId;
        
        if (ctx && ctx.itemIdMap) {
            if (ctx.itemIdMap.has(oldItemId)) {
                newItemId = ctx.itemIdMap.get(oldItemId);
            } else {
                newItemId = THREE.MathUtils.generateUUID();
                ctx.itemIdMap.set(oldItemId, newItemId);
            }
        } else {
            newItemId = THREE.MathUtils.generateUUID();
        }

        targetBatch.userData.itemIds.set(newInstanceId, newItemId);
    }
    
    // Has Hat (Player Head)
    if (mesh.userData.hasHat && mesh.userData.hasHat[instanceId] !== undefined) {
         if (!targetBatch.userData.hasHat) targetBatch.userData.hasHat = {}; 
         targetBatch.userData.hasHat[newInstanceId] = mesh.userData.hasHat[instanceId];
    }
    
    // Custom Pivot
    if (mesh.userData.customPivots && mesh.userData.customPivots.has(instanceId)) {
         targetBatch.userData.customPivots.set(newInstanceId, mesh.userData.customPivots.get(instanceId).clone());
    } else if (mesh.userData.customPivot) {
         targetBatch.userData.customPivots.set(newInstanceId, mesh.userData.customPivot.clone());
    }

    // Register in LoadedObjectGroup hierarchy if group exists
    if (targetGroupId) {
        const groups = GroupUtils.getGroups(loadedObjectGroup);
        const group = groups.get(targetGroupId);
        if (group) {
            if (!Array.isArray(group.children)) group.children = [];
            group.children.push({ type: 'object', mesh: targetBatch, instanceId: newInstanceId });
        }
        
        const objectToGroup = GroupUtils.getObjectToGroup(loadedObjectGroup);
        const key = GroupUtils.getGroupKey(targetBatch, newInstanceId);
        objectToGroup.set(key, targetGroupId);
    }

    return { mesh: targetBatch, instanceId: newInstanceId };
}

function cloneGroup(loadedObjectGroup, groupId, parentId, idMap, ctx) {
    return GroupUtils.cloneGroupStructure(loadedObjectGroup, groupId, parentId, idMap);
}

function _collectCloneJobsFromGroup(loadedObjectGroup, groupId, newGroupId, ctx, outJobs) {
    // Inject planning callback
    const ctxWithCallback = {
        ...ctx,
        planBatchCallback: (mesh, instanceId, targetGroupId) => _planWritableBatchFor(mesh, instanceId, targetGroupId, ctx)
    };
    GroupUtils.collectCloneJobsFromGroup(loadedObjectGroup, groupId, newGroupId, ctxWithCallback, outJobs);
}

export function duplicateGroupsAndObjects(loadedObjectGroup, groupIds, objectEntries) {
    const ctx = createDuplicationContext();
    _pendingHeadClones = [];

    const newSelection = { groups: new Set(), objects: new Map() };
    const idMap = new Map(); // OldGroupID -> NewGroupID
    const groups = GroupUtils.getGroups(loadedObjectGroup);
    const jobs = [];
    if (ctx) ctx._groupIdMap = idMap;
    
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
        if (result && !result.isPending && !job.coveredByGroup) {
            if (!newSelection.objects.has(result.mesh)) {
                newSelection.objects.set(result.mesh, new Set());
            }
            newSelection.objects.get(result.mesh).add(result.instanceId);
        }
    }
    
    // Flush pending bulk clones (Player Heads)
    const newHeads = flushPendingHeadClones(loadedObjectGroup, ctx);
    for (const { mesh, instanceId, coveredByGroup } of newHeads) {
        if (coveredByGroup) continue;
        if (!newSelection.objects.has(mesh)) {
            newSelection.objects.set(mesh, new Set());
        }
        newSelection.objects.get(mesh).add(instanceId);
    }

    return newSelection;
}