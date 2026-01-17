import * as THREE from 'three/webgpu';
import * as GroupUtils from './group.js';

// Small shared temporaries (avoid allocations in hot paths)
const _TMP_MAT4_A = new THREE.Matrix4();

function _deleteBatchedMeshInstances(mesh, instanceIds) {
    if (!mesh || !mesh.isBatchedMesh) return;

    // Process all deletions
    for (const instanceId of instanceIds) {
        // 1. Call real delete
        if (typeof mesh.deleteInstance === 'function') {
            mesh.deleteInstance(instanceId);
        } else {
            // Fallback if deleteInstance is missing (should not happen in modern Three.js)
            if (typeof mesh.setVisibleAt === 'function') mesh.setVisibleAt(instanceId, false);
        }

        // 2. Clean up UserData Maps/Arrays
        if (mesh.userData) {
            // instanceGeometryIds is an array, we mark it as null/undefined to preserve indices for other instances
            if (Array.isArray(mesh.userData.instanceGeometryIds)) {
                mesh.userData.instanceGeometryIds[instanceId] = undefined;
            }
            if (mesh.userData.localMatrices instanceof Map) {
                mesh.userData.localMatrices.delete(instanceId);
            }
            if (mesh.userData.displayTypes instanceof Map) {
                mesh.userData.displayTypes.delete(instanceId);
            }
            if (mesh.userData.itemIds instanceof Map) {
                mesh.userData.itemIds.delete(instanceId);
            }
            if (mesh.userData.customPivots instanceof Map) {
                mesh.userData.customPivots.delete(instanceId);
            }
        }
    }
}

function _updateGroupReferenceForMovedInstance(loadedObjectGroup, mesh, oldInstanceId, newInstanceId) {
    GroupUtils.updateGroupReferenceForMovedInstance(loadedObjectGroup, mesh, oldInstanceId, newInstanceId);
}

function _deleteInstancedMeshInstances(loadedObjectGroup, mesh, instanceIdsSortedDescending) {
    if (!mesh || !mesh.isInstancedMesh) return;

    const instanceMatrix = mesh.instanceMatrix;
    const uvAttr = mesh.geometry && mesh.geometry.attributes ? mesh.geometry.attributes.instancedUvOffset : null;
    const hasHatArray = mesh.userData ? mesh.userData.hasHat : null; // Array

    // Helper to swap data from srcIdx to dstIdx
    const swapData = (srcIdx, dstIdx) => {
        // Matrix
        _TMP_MAT4_A.fromArray(instanceMatrix.array, srcIdx * 16);
        _TMP_MAT4_A.toArray(instanceMatrix.array, dstIdx * 16);

        // UV
        if (uvAttr) {
            const u = uvAttr.getX(srcIdx);
            const v = uvAttr.getY(srcIdx);
            uvAttr.setXY(dstIdx, u, v);
        }

        // Hat
        if (Array.isArray(hasHatArray)) {
            hasHatArray[dstIdx] = hasHatArray[srcIdx];
        }
    };

    for (const deleteIdx of instanceIdsSortedDescending) {
        const lastIdx = mesh.count - 1;
        
        // If the item to delete is NOT the last one, we swap the last one into this slot
        if (deleteIdx < lastIdx) {
            swapData(lastIdx, deleteIdx);
            
            // Critical: The instance that was at 'lastIdx' is now at 'deleteIdx'.
            // We must update any group references pointing to 'lastIdx' to now point to 'deleteIdx'.
            _updateGroupReferenceForMovedInstance(loadedObjectGroup, mesh, lastIdx, deleteIdx);
        }
        
        // Decrease count
        mesh.count--;
    }

    mesh.instanceMatrix.needsUpdate = true;
    if (uvAttr) uvAttr.needsUpdate = true;
}

export function deleteSelectedItems(loadedObjectGroup, currentSelection, { resetSelectionAndDeselect }) {
    // 1. Identify all items to delete (deduplicated)
    // Key: "meshUuid_instanceId" -> { mesh, instanceId }
    const itemsToDelete = new Map();

    // Helper to collect items
    const collectItem = (mesh, instanceId) => {
        if (!mesh) return;
        const k = GroupUtils.getGroupKey(mesh, instanceId);
        if (!itemsToDelete.has(k)) {
            itemsToDelete.set(k, { mesh, instanceId });
        }
    };

    // Collect from selected Groups (and their descendants)
    const allGroupsToDelete = new Set();
    if (currentSelection.groups && currentSelection.groups.size > 0) {
        for (const gid of currentSelection.groups) {
            if (gid) {
                allGroupsToDelete.add(gid);
                const descendants = GroupUtils.getAllDescendantGroups(loadedObjectGroup, gid);
                for (const d of descendants) allGroupsToDelete.add(d);
            }
        }
    }

    const groups = GroupUtils.getGroups(loadedObjectGroup);
    const objectToGroup = GroupUtils.getObjectToGroup(loadedObjectGroup);

    // Remove groups from structure first (so we don't process them as valid parents later)
    // But we need to look up their children first.
    
    // First, collect all children objects from these groups
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

    // Also collect explicitly selected objects
    if (currentSelection.objects && currentSelection.objects.size > 0) {
        for (const [mesh, ids] of currentSelection.objects) {
            if (!mesh || !ids) continue;
            for (const id of ids) {
                collectItem(mesh, id);
            }
        }
    }

    if (itemsToDelete.size === 0 && allGroupsToDelete.size === 0) return;

    // 2. Cleanup Group Structures
    // Remove top-level deleted groups from their parents
    for (const gid of currentSelection.groups) { // Iterate original selection roots
         if(!gid) continue;
         const g = groups.get(gid);
         if (g && g.parent) {
             const parent = groups.get(g.parent);
             if (parent && !allGroupsToDelete.has(g.parent)) {
                 if (Array.isArray(parent.children)) {
                     parent.children = parent.children.filter(c => !(c && c.type === 'group' && c.id === gid));
                 }
             }
         }
    }

    // Now delete all the groups from the map
    for (const gid of allGroupsToDelete) {
        groups.delete(gid);
    }

    // 3. Process Object Deletion
    // We need to group by Mesh to handle InstancedMesh swap logic efficiently
    const byMesh = new Map(); // mesh -> Set<instanceId>

    for (const { mesh, instanceId } of itemsToDelete.values()) {
        // Also cleanup objectToGroup for the deleted item itself
        const key = GroupUtils.getGroupKey(mesh, instanceId);
        
        // If the object was in a group that wasn't deleted, we need to remove it from that group's children
        if (objectToGroup.has(key)) {
            const parentGroupId = objectToGroup.get(key);
            // If parent group still exists (was not in allGroupsToDelete), remove child ref
            if (groups.has(parentGroupId)) {
                const pg = groups.get(parentGroupId);
                if (pg && Array.isArray(pg.children)) {
                     pg.children = pg.children.filter(c => !(c.type === 'object' && c.mesh === mesh && c.instanceId === instanceId));
                }
            }
            objectToGroup.delete(key);
        }

        if (!byMesh.has(mesh)) byMesh.set(mesh, new Set());
        byMesh.get(mesh).add(instanceId);
    }

    // Clear selection now, before modifying indices
    resetSelectionAndDeselect();

    // Execute Deletion
    for (const [mesh, idSet] of byMesh) {
        if (mesh.isBatchedMesh) {
            _deleteBatchedMeshInstances(mesh, Array.from(idSet));
        } else if (mesh.isInstancedMesh) {
            // Sort Descending for Swap-Pop safety
            const sortedIds = Array.from(idSet).sort((a, b) => b - a);
            _deleteInstancedMeshInstances(loadedObjectGroup, mesh, sortedIds);
        }
    }

    console.log('선택된 항목 제거됨 (Real Delete)');
}