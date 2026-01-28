import * as THREE from 'three/webgpu';
import * as Overlay from './overlay.js';

const _TMP_MAT4_A = new THREE.Matrix4();
const _ZERO_VEC3 = new THREE.Vector3(0, 0, 0);

export function performSelectionSwap(
    src,
    targetSrc,
    {
        currentSelection,
        getGroups,
        getGroupWorldMatrixWithFallback,
        setGizmoState,
        getGizmoState,
        updateHelperPosition,
        SelectionCenter,
        vertexQueue
    }
) {
    if (!targetSrc) return;

    // 1. Select Source (A) if provided
    if (src) {
         currentSelection.groups.clear();
         currentSelection.objects.clear();
         currentSelection.primary = null;

         if (src.type === 'group') {
             currentSelection.groups.add(src.id);
             currentSelection.primary = { type: 'group', id: src.id };
         } else {
             const { mesh, instanceId } = src;
             const ids = new Set();
             ids.add(instanceId);

             currentSelection.objects.set(mesh, ids);
             currentSelection.primary = { type: 'object', mesh, instanceId };
         }

         // Recompute Pivot State for 'src'
         let pivotWorld = null;

         if (src.type === 'object') {
             const { mesh, instanceId } = src;
             
             const getWorldPivot = (id) => {
                 let local = null;
                 if (mesh.userData.customPivots) {
                     local = mesh.userData.customPivots.get(id);
                     if (!local) {
                         const k = (typeof id === 'number') ? String(id) : Number(id);
                         local = mesh.userData.customPivots.get(k);
                     }
                 }
                 
                 if (local) {
                     const m = _TMP_MAT4_A;
                     if (mesh.isBatchedMesh || mesh.isInstancedMesh) {
                         mesh.getMatrixAt(id, m);
                     } else {
                         m.copy(mesh.matrix);
                     }
                     m.premultiply(mesh.matrixWorld);
                     return local.clone().applyMatrix4(m);
                 }
                 return null;
             };

             if (mesh.isBatchedMesh || mesh.isInstancedMesh) {
                 pivotWorld = getWorldPivot(instanceId);
             } else if (mesh.userData.customPivot) {
                 pivotWorld = mesh.userData.customPivot.clone().applyMatrix4(mesh.matrixWorld);
             }
             
         } else if (src.type === 'group') {
             const groups = getGroups();
             const group = groups.get(src.id);
             if (group && group.isCustomPivot && group.pivot) {
                 const gMat = getGroupWorldMatrixWithFallback(src.id, _TMP_MAT4_A);
                 pivotWorld = group.pivot.clone().applyMatrix4(gMat);
             }
         }

         if (pivotWorld) {
             const origin = SelectionCenter('origin', false, _ZERO_VEC3);
             const offset = new THREE.Vector3().subVectors(pivotWorld, origin);
             
             setGizmoState({
                 isCustomPivot: true,
                 pivotOffset: offset
             });
         } else {
             setGizmoState({
                 isCustomPivot: false,
                 pivotOffset: new THREE.Vector3(0, 0, 0)
             });
         }

         updateHelperPosition();
    }

    // 2. Queue Target (B)
    let targetLocalPivot = new THREE.Vector3(0, 0, 0); 
    let hasCustomPivot = false;

    const state = getGizmoState();

    if (state.pivotMode !== 'center') {
        if (targetSrc.type === 'object') {
            const { mesh, instanceId } = targetSrc;
            if (mesh.isBatchedMesh || mesh.isInstancedMesh) {
                 let pivot = null;
                 if (mesh.userData.customPivots) {
                     pivot = mesh.userData.customPivots.get(instanceId);
                     if (!pivot) {
                         const key = (typeof instanceId === 'number') ? String(instanceId) : Number(instanceId);
                         pivot = mesh.userData.customPivots.get(key);
                     }
                 }
                 if (pivot) {
                     targetLocalPivot.copy(pivot);
                     hasCustomPivot = true;
                 }
            } else if (mesh.userData.customPivot) {
                 targetLocalPivot.copy(mesh.userData.customPivot);
                 hasCustomPivot = true;
            }
        } else if (targetSrc.type === 'group') {
            const groups = getGroups();
            const group = groups.get(targetSrc.id);
            if (group && group.isCustomPivot && group.pivot) {
                 targetLocalPivot.copy(group.pivot);
                 hasCustomPivot = true;
            }
        }
    }

    if (state.pivotMode === 'center') {
        let localBox = null;
        if (targetSrc.type === 'object') {
            localBox = Overlay.getInstanceLocalBox(targetSrc.mesh, targetSrc.instanceId);
        } else if (targetSrc.type === 'group') {
             localBox = Overlay.getGroupLocalBoundingBox(targetSrc.id);
        }
        if (localBox && !localBox.isEmpty()) {
            localBox.getCenter(targetLocalPivot);
        }
    }

    vertexQueue.push({
        type: targetSrc.type,
        id: targetSrc.id,
        mesh: targetSrc.mesh,
        instanceId: targetSrc.instanceId,
        gizmoLocalPosition: targetLocalPivot,
        gizmoLocalQuaternion: new THREE.Quaternion() 
    });

    while (vertexQueue.length > 1) vertexQueue.shift();
}
