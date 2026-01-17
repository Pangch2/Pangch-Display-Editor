import * as THREE from 'three/webgpu';
import * as GroupUtils from './group.js';
import * as Overlay from './overlay.js';
import * as CustomPivot from './custom-pivot.js';

// Selection State
// Exported so Gizmo and others can access it.
export const currentSelection = {
    groups: new Set(),
    objects: new Map(), // Map<THREE.Object3D, Set<number>>
    primary: null // { type: 'group', id } | { type: 'object', mesh, instanceId }
};

const _TMP_MAT4_A = new THREE.Matrix4();

// Aliases for imported overlays
const getInstanceCount = Overlay.getInstanceCount;
const isInstanceValid = Overlay.isInstanceValid;
const getInstanceWorldMatrixForOrigin = Overlay.getInstanceWorldMatrixForOrigin;

export function invalidateSelectionCaches() {
    // In strict Separation of Concerns, cache should probably be here too?
    // Gizmo keeps cache vars, let's keep them there or move them here?
    // For now, Gizmo owns the cache variables. But `gizmo.js` is calling this.
    // If I move selection state here, cache probably belongs here too.
    _selectedItemsCacheKey = null;
    _selectedItemsCache = null;
}

// Caching logic moved here
let _selectedItemsCacheKey = null;
let _selectedItemsCache = null;

function _getSelectionCacheKey() {
    if (!hasAnySelection()) return 'none';

    const g = currentSelection.groups && currentSelection.groups.size > 0
        ? Array.from(currentSelection.groups).slice().sort().join('|')
        : '';

    const oParts = [];
    if (currentSelection.objects && currentSelection.objects.size > 0) {
        for (const [mesh, ids] of currentSelection.objects) {
            oParts.push(`${mesh.uuid}:${Array.from(ids).sort().join(',')}`);
        }
    }
    oParts.sort();

    return `g:${g};o:${oParts.join('|')}`;
}

export function getSelectedItems() {
    const key = _getSelectionCacheKey();
    if (_selectedItemsCacheKey === key && _selectedItemsCache) return _selectedItemsCache;

    const items = [];
    const seen = new Set();

    if (currentSelection.groups && currentSelection.groups.size > 0) {
        if (loadedObjectGroupForSelect) {
            for (const groupId of currentSelection.groups) {
                const children = GroupUtils.getAllGroupChildren(loadedObjectGroupForSelect, groupId);
                children.forEach(child => {
                    const uniqueKey = `${child.mesh.uuid}_${child.instanceId}`;
                    if (!seen.has(uniqueKey)) {
                        seen.add(uniqueKey);
                        items.push(child);
                    }
                });
            }
        }
    }

    if (currentSelection.objects && currentSelection.objects.size > 0) {
        for (const [mesh, ids] of currentSelection.objects) {
            for (const id of ids) {
                const uniqueKey = `${mesh.uuid}_${id}`;
                if (!seen.has(uniqueKey)) {
                    seen.add(uniqueKey);
                    items.push({ type: 'object', mesh, instanceId: id });
                }
            }
        }
    }

    _selectedItemsCacheKey = key;
    _selectedItemsCache = items;
    return items;
}

let loadedObjectGroupForSelect = null;

export function setLoadedObjectGroup(group) {
    loadedObjectGroupForSelect = group;
}

export function pickInstanceByOverlayBox(raycaster, rootGroup) {
    const rayWorld = raycaster.ray.clone();
    const best = { mesh: null, instanceId: undefined, distance: Infinity };
    
    // Using Overlay-compatible logic (BatchedMesh aware)
    // Note: The original gizmo code iterated manually.
    // Let's reuse that logic.

    rootGroup.traverse((obj) => {
        if (!obj || (!obj.isInstancedMesh && !obj.isBatchedMesh)) return;
        if (obj.visible === false) return; // Optimization
        if (!raycaster.layers.test(obj.layers)) return;

        const mesh = obj;
        const instanceCount = getInstanceCount(mesh);

        if (instanceCount <= 0) return;

        // Optimization: check against mesh bounding sphere first? 
        // Be careful with instanced/batched mesh bounding spheres.
        
        for (let instanceId = 0; instanceId < instanceCount; instanceId++) {
            if (!isInstanceValid(mesh, instanceId)) continue;

            const box = Overlay.getInstanceLocalBox(mesh, instanceId, new THREE.Box3());
            
            // Transform ray to local space is expensive if done for every instance
            // But instances have different transforms.
            
            // Strategy: Get Instance World Matrix, Transform Box to World (OBB), intersect with Ray.
            // OR: Transform Ray to Instance Local Space, intersect with AABB.
            // The Gizmo implementation did the latter (or similar).
            
            // Gizmo implementation used `pickInstanceByOverlayBox` which wasn't fully shown in context
            // but implied iterating instances.
            
            // Let's implement robust picking:
            const matrixWorld = Overlay.getInstanceWorldMatrix(mesh, instanceId, new THREE.Matrix4());
            
            // Simple Ray-OBB or Ray-AABB (Local) check
            const invMatrix = matrixWorld.clone().invert();
            const localRay = rayWorld.clone().applyMatrix4(invMatrix);
            
            const intersect = localRay.intersectBox(box, new THREE.Vector3());
            if (intersect) {
                // Determine distance in world space
                const hitPointWorld = intersect.clone().applyMatrix4(matrixWorld);
                const dist = rayWorld.origin.distanceTo(hitPointWorld);
                
                if (dist < best.distance) {
                    best.distance = dist;
                    best.mesh = mesh;
                    best.instanceId = instanceId;
                }
            }
        }
    });

    if (!best.mesh || best.instanceId === undefined) return null;
    return { mesh: best.mesh, instanceId: best.instanceId };
}

export function getSingleSelectedGroupId() {
    if (!currentSelection.groups || currentSelection.groups.size !== 1) return null;
    if (currentSelection.objects && currentSelection.objects.size > 0) return null;
    return Array.from(currentSelection.groups)[0] || null;
}

export function getSingleSelectedMeshEntry() {
    if (currentSelection.groups && currentSelection.groups.size > 0) return null;
    if (!currentSelection.objects || currentSelection.objects.size !== 1) return null;
    const [mesh, ids] = currentSelection.objects.entries().next().value;
    return (mesh && ids && ids.size === 1) ? { mesh, instanceId: Array.from(ids)[0] } : null; // Logic fix: ensure single ID
}

export function hasAnySelection() {
    return (currentSelection.groups && currentSelection.groups.size > 0) || (currentSelection.objects && currentSelection.objects.size > 0);
}

// These functions require access to gizmo's internal methods (clearGizmo, helper update, etc.)
// We can pass a `callbacks` object or similar.

export function clearSelectionState(callbacks) {
    // If Vertex Mode check is needed, it should be done by caller or passed in.
    // Callbacks: { pushToVertexQueue }
    if (callbacks && callbacks.pushToVertexQueue) {
        callbacks.pushToVertexQueue();
    }
    
    currentSelection.groups.clear();
    currentSelection.objects.clear();
    currentSelection.primary = null;
    invalidateSelectionCaches();
}

export function beginSelectionReplace(callbacks, { anchorMode = 'default', detachTransform = false, preserveAnchors = false } = {}) {
    // callbacks: { revertEphemeralPivotUndoIfAny, detachTransformControls, clearGizmoAnchor }
    
    if (callbacks.revertEphemeralPivotUndoIfAny) callbacks.revertEphemeralPivotUndoIfAny();
    if (detachTransform && callbacks.detachTransformControls) callbacks.detachTransformControls();
    
    clearSelectionState(callbacks);
    
    if (!preserveAnchors && callbacks.clearGizmoAnchor) callbacks.clearGizmoAnchor();

    // Callbacks should handle 'setSelectionAnchorMode' if needed, or return it.
    // Assuming context lets us set state.
    if (callbacks.setSelectionAnchorMode) callbacks.setSelectionAnchorMode(anchorMode);

    // Callbacks should handle 'resetPivotState' (pivotOffset=0, isCustomPivot=false)
    if (callbacks.resetPivotState) callbacks.resetPivotState();

    currentSelection.primary = null;
    invalidateSelectionCaches();
}

export function resetSelectionAndDeselect(callbacks) {
     if (hasAnySelection() || (callbacks.hasVertexQueue && callbacks.hasVertexQueue())) {
         beginSelectionReplace(callbacks, { detachTransform: true });
         if (callbacks.updateHelperPosition) callbacks.updateHelperPosition();
         if (callbacks.updateSelectionOverlay) callbacks.updateSelectionOverlay();
     }
}

export function setPrimaryToFirstAvailable() {
    if (currentSelection.groups && currentSelection.groups.size > 0) {
        const id = Array.from(currentSelection.groups)[0];
        currentSelection.primary = id ? { type: 'group', id } : null;
        return;
    }
    if (currentSelection.objects && currentSelection.objects.size > 0) {
        for (const [mesh, ids] of currentSelection.objects) {
            if (ids.size > 0) {
                 const firstId = Array.from(ids)[0];
                 currentSelection.primary = { type: 'object', mesh, instanceId: firstId };
                 return;
            }
        }
    }
    currentSelection.primary = null;
}

export function replaceSelectionWithObjectsMap(meshToIds, callbacks, { anchorMode = 'default' } = {}) {
    if (!meshToIds || meshToIds.size === 0) {
        resetSelectionAndDeselect(callbacks);
        return;
    }

    beginSelectionReplace(callbacks, { anchorMode, detachTransform: true });

    for (const [mesh, ids] of meshToIds) {
        if (!mesh || !ids || ids.size === 0) continue;
        currentSelection.objects.set(mesh, ids);
    }

    if (callbacks.recomputePivotState) callbacks.recomputePivotState();
    if (callbacks.updateHelperPosition) callbacks.updateHelperPosition();
    if (callbacks.updateSelectionOverlay) callbacks.updateSelectionOverlay();
}

export function replaceSelectionWithGroupsAndObjects(groupIds, meshToIds, callbacks, { anchorMode = 'default' } = {}) {
    const hasGroups = groupIds && groupIds.size > 0;
    const hasObjects = meshToIds && meshToIds.size > 0;
    if (!hasGroups && !hasObjects) {
        resetSelectionAndDeselect(callbacks);
        return;
    }

    beginSelectionReplace(callbacks, { anchorMode, detachTransform: true });

    if (hasGroups) {
        for (const gid of groupIds) {
            if (gid) currentSelection.groups.add(gid);
        }
    }
    if (hasObjects) {
        for (const [mesh, ids] of meshToIds) {
            if (!mesh || !ids || ids.size === 0) continue;
            currentSelection.objects.set(mesh, ids);
        }
    }

    if (callbacks.recomputePivotState) callbacks.recomputePivotState();
    if (callbacks.updateHelperPosition) callbacks.updateHelperPosition();
    if (callbacks.updateSelectionOverlay) callbacks.updateSelectionOverlay();
}

export function selectAllObjectsVisibleInScene(loadedObjectGroup) {
     const meshToIds = new Map();
    if (!loadedObjectGroup) return meshToIds;

    loadedObjectGroup.traverse((obj) => {
        if (!obj || (!obj.isInstancedMesh && !obj.isBatchedMesh)) return;
        if (obj.visible === false) return;

        const instanceCount = getInstanceCount(obj);
        if (instanceCount <= 0) return;

        const ids = new Set();
        for (let i = 0; i < instanceCount; i++) {
            if (isInstanceValid(obj, i)) {
                ids.add(i);
            }
        }
        if (ids.size > 0) {
            meshToIds.set(obj, ids);
        }
    });

    return meshToIds;
}

// Helpers for recomputePivotStateForSelection
export function isMultiSelection() {
    const groupCount = currentSelection.groups ? currentSelection.groups.size : 0;
    
    let objectIdCount = 0;
    if (currentSelection.objects && currentSelection.objects.size > 0) {
         // This logic exists in Gizmo, needed for CustomPivot
         // Or we can import Overlay's helper if it matches
         for (const [mesh, ids] of currentSelection.objects) {
             // Basic count, assumes IDs are valid
             objectIdCount += ids.size;
         }
    }
    
    // Using Overlay.js helper logic if we trust it, or keep local logic strict.
    return (groupCount + objectIdCount) > 1;
}

export function commitSelectionChange(callbacks) {
    invalidateSelectionCaches();
    if (hasAnySelection() && !currentSelection.primary) { 
        setPrimaryToFirstAvailable();
    }
    if (callbacks.recomputePivotState) callbacks.recomputePivotState();
    if (callbacks.updateHelperPosition) callbacks.updateHelperPosition();
    if (callbacks.updateSelectionOverlay) callbacks.updateSelectionOverlay();
}

export function handleSelectionClick(
    raycaster,
    event,
    loadedObjectGroup,
    callbacks
) {
    // 1. Raycasting
    // Assumes raycaster is already set up with camera and mouse coords by the caller
    const picked = pickInstanceByOverlayBox(raycaster, loadedObjectGroup);
    
    if (!picked) {
        if (!event.shiftKey) {
            if (callbacks && callbacks.onDeselect) {
                callbacks.onDeselect();
            } else {
                resetSelectionAndDeselect(callbacks);
            }
        }
        return;
    }

    const object = picked.mesh;
    const instanceId = picked.instanceId;
    let idsToSelect = [instanceId];

    // 2. BatchedMesh item ID resolution
    if (object.isBatchedMesh && object.userData.itemIds) {
        const targetItemId = object.userData.itemIds.get(instanceId);
        if (targetItemId !== undefined) {
            idsToSelect = [];
            for (const [id, itemId] of object.userData.itemIds) {
                if (itemId === targetItemId) idsToSelect.push(id);
            }
        }
    }

    // 3. Group selection hierarchy
    const key = GroupUtils.getGroupKey(object, idsToSelect[0]);
    const objectToGroup = GroupUtils.getObjectToGroup(loadedObjectGroup);
    const immediateGroupId = objectToGroup ? objectToGroup.get(key) : null;

    // Modifier keys
    const bypassGroupSelection = !!(event.ctrlKey || event.metaKey);

    let target = { type: 'object', mesh: object, ids: idsToSelect };

    if (!bypassGroupSelection && immediateGroupId) {
        const groupChain = GroupUtils.getGroupChain(loadedObjectGroup, immediateGroupId);
        if (groupChain && groupChain.length > 0) {
            let nextGroupIdToSelect = groupChain[0];

            // Drill-down logic:
            // Find the deepest group in the current chain that is ALREADY selected.
            // The target will be the child of that group (or the object itself if we reached the bottom).
            let deepestSelectedIndex = -1;
            if (currentSelection.groups && currentSelection.groups.size > 0) {
                for (let i = groupChain.length - 1; i >= 0; i--) {
                    if (currentSelection.groups.has(groupChain[i])) {
                        deepestSelectedIndex = i;
                        break;
                    }
                }
            }

            if (deepestSelectedIndex !== -1) {
                if (deepestSelectedIndex < groupChain.length - 1) {
                    nextGroupIdToSelect = groupChain[deepestSelectedIndex + 1];
                } else {
                    // We are at the bottom of the group chain, so select the object itself.
                    nextGroupIdToSelect = null;
                }
            }

            if (nextGroupIdToSelect) {
                target = { type: 'group', id: nextGroupIdToSelect };
            }
        }
    }

    // 4. Update Selection State
    if (event.shiftKey) {
        // Toggle Logic
        // In toggle mode, we don't clear existing selection.
        if (target.type === 'group') {
            const gid = target.id;
            if (currentSelection.groups.has(gid)) {
                currentSelection.groups.delete(gid);
                if (currentSelection.primary && currentSelection.primary.type === 'group' && currentSelection.primary.id === gid) {
                    currentSelection.primary = null;
                }
            } else {
                currentSelection.groups.add(gid);
                // Make freshly selected item primary
                currentSelection.primary = { type: 'group', id: gid };
            }
        } else {
            // Object toggle
            let existingSet = currentSelection.objects.get(target.mesh);
            if (!existingSet) {
                existingSet = new Set();
                currentSelection.objects.set(target.mesh, existingSet);
            }

            const firstId = target.ids[0];
            const isSelected = existingSet.has(firstId);

            if (isSelected) {
                // Deselect these IDs
                for (const id of target.ids) existingSet.delete(id);
                if (existingSet.size === 0) currentSelection.objects.delete(target.mesh);
                
                // If primary was one of these, clear primary
                if (currentSelection.primary && 
                    currentSelection.primary.type === 'object' && 
                    currentSelection.primary.mesh === target.mesh && 
                    target.ids.includes(currentSelection.primary.instanceId)) {
                    currentSelection.primary = null;
                }
            } else {
                // Select these IDs
                for (const id of target.ids) existingSet.add(id);
                currentSelection.primary = { type: 'object', mesh: target.mesh, instanceId: firstId };
            }
        }
    } else {
        // Single Select (Replace)
        // We use beginSelectionReplace to clear previous selection clearly and handle undo/history callbacks if any
        beginSelectionReplace(callbacks, { detachTransform: true });
        
        if (target.type === 'group') {
             currentSelection.groups.add(target.id);
             currentSelection.primary = { type: 'group', id: target.id };
        } else {
             const set = new Set(target.ids);
             currentSelection.objects.set(target.mesh, set);
             currentSelection.primary = { type: 'object', mesh: target.mesh, instanceId: target.ids[0] };
        }
    }

    // 5. Commit
    commitSelectionChange(callbacks);
}
