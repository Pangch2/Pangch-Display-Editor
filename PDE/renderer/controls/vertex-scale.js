
import * as THREE from 'three/webgpu';
import * as Overlay from './overlay.js';
import { performSelectionSwap } from './vertex-swap.js';
import { removeShearFromSelection } from './shear-remove.js';
import { getAllGroupChildren } from './group.js';

const _TMP_MAT4_A = new THREE.Matrix4();
const _TMP_MAT4_B = new THREE.Matrix4();
const _TMP_VEC3_A = new THREE.Vector3();
const _TMP_QUAT_A = new THREE.Quaternion();
const _TMP_SCALE_A = new THREE.Vector3();

// Cube-based scale snap logic (Ctrl Logic) vs Pivot-based (Affine) logic (Default)
export function processVertexScale(
    selectedVertexKeys,
    {
        isVertexMode,
        gizmoMode,
        isCtrlDown, 
        currentSelection,
        loadedObjectGroup,
        selectionHelper,
        getGizmoState,
        setGizmoState,
        getGroups,
        getGroupWorldMatrixWithFallback,
        updateHelperPosition,
        updateSelectionOverlay,
        SelectionCenter,
        vertexQueue
    }
) {
    if (!isVertexMode) return false;
    if (gizmoMode !== 'scale') return false;

    const keys = Array.from(selectedVertexKeys);
    if (keys.length !== 2) return false;

    const k1 = keys[0];
    const k2 = keys[1];

    const foundSprites = Overlay.findSpritesByKeys([k1, k2]);
    const sprite1 = foundSprites[k1];
    const sprite2 = foundSprites[k2];

    if (!sprite1 || !sprite2) return false;

    // Sprite 1 must be the source object vertex being manipulated
    if (!sprite1.userData.source) return false; 

    // Prevent scaling if source and target are effectively the same position
    const p1 = sprite1.position.clone();
    const p2 = sprite2.position.clone();
    
    // Epsilon for distance check
    if (p1.distanceToSquared(p2) < 1e-9) {
        selectedVertexKeys.clear();
        return false;
    }

    const src = sprite1.userData.source;
    let objectWorldMatrix = _TMP_MAT4_A;
    let localBox = null;
    let worldPosition = new THREE.Vector3();
    let worldQuaternion = new THREE.Quaternion(); 
    let worldScale = new THREE.Vector3(); 

    // 1. Resolve effective World Matrix and Local Bounding Box
    if (src.type === 'object') {
        const { mesh, instanceId } = src;
        if (mesh.isBatchedMesh || mesh.isInstancedMesh) {
             mesh.getMatrixAt(instanceId, objectWorldMatrix);
        } else {
             objectWorldMatrix.copy(mesh.matrix);
        }
        objectWorldMatrix.premultiply(mesh.matrixWorld);
        localBox = Overlay.getInstanceLocalBox(mesh, instanceId);
    } else if (src.type === 'group') {
        getGroupWorldMatrixWithFallback(src.id, objectWorldMatrix);
        localBox = Overlay.getGroupLocalBoundingBox(src.id);
    }

    if (!localBox || localBox.isEmpty()) return false;

    // 2. Determine "Fixed Point" & Apply Logic
    if (isCtrlDown) {
        // [Cube Logic] (Original) with Shear Removal

        // Capture p1 in Local Space (to track it after shear removal)
        // Note: p1 is the corner being dragged.
        const originalInv = objectWorldMatrix.clone().invert();
        const p1Local = p1.clone().applyMatrix4(originalInv);

        // Remove Shear First
        if (src.type === 'object') {
             const items = [{ mesh: src.mesh, instanceId: src.instanceId }];
             const state = getGizmoState();
             removeShearFromSelection(
                 items, selectionHelper, currentSelection, loadedObjectGroup,
                 state.pivotMode, state.isCustomPivot, state.pivotOffset,
                 { SelectionCenter, updateHelperPosition, updateSelectionOverlay }
             );

             // Refresh World Matrix after shear removal
             if (src.mesh.isBatchedMesh || src.mesh.isInstancedMesh) {
                 src.mesh.getMatrixAt(src.instanceId, objectWorldMatrix);
             } else {
                 objectWorldMatrix.copy(src.mesh.matrix);
             }
             objectWorldMatrix.premultiply(src.mesh.matrixWorld);
             
             // Refresh p1 World Position (it moved due to un-shearing)
             // We assume p1Local (the corner index logic) stays valid in the orthogonalized box.
             p1.copy(p1Local).applyMatrix4(objectWorldMatrix);
             
        } else if (src.type === 'group') {
            // Group shear removal (Manual, since removeShearFromSelection works on mesh Selection)
            const groups = getGroups();
            const group = groups.get(src.id);
            if (group) {
                 // Decompose/Orthogonalize Group Matrix if it exists, or just ensure P/Q/S is used?
                 // Usually Groups don't carry complex shear unless parented or manually set matrix.
                 // Assuming standard behavior for now or skipping explicit shear removal for Group container itself
                 // (or we would need to implement Group Shear Removal).
                 
                 // If we strictly follow user instruction "Use shear-remove.js", 
                 // and shear-remove.js doesn't support direct group ID input clearly without selection...
                 // We skip for group for now or implement if requested.
            }
        }

        // Decompose Unsheared Matrix
        objectWorldMatrix.decompose(worldPosition, worldQuaternion, worldScale);

        // Calculate Fixed Point (Opposite Corner) using new matrix
        const invMatrix = objectWorldMatrix.clone().invert();
        // p1Local should theoretically be the same, but let's recompute or use cached?
        // Use cached p1Local to determine WHICH corner it was?
        // Actually, we can use p1 (World) -> Inv -> p1Local (New).
        // Since we updated p1 from p1Local, this round-trip is consistent.
        // We need p1 (World) and Fixed (World) to be consistent.

        const min = localBox.min;
        const max = localBox.max;
        const center = new THREE.Vector3().addVectors(min, max).multiplyScalar(0.5);
        const eps = 1e-4;

        const fixedLocal = new THREE.Vector3();
        fixedLocal.x = (p1Local.x > center.x + eps) ? min.x : ((p1Local.x < center.x - eps) ? max.x : p1Local.x);
        fixedLocal.y = (p1Local.y > center.y + eps) ? min.y : ((p1Local.y < center.y - eps) ? max.y : p1Local.y);
        fixedLocal.z = (p1Local.z > center.z + eps) ? min.z : ((p1Local.z < center.z - eps) ? max.z : p1Local.z);

        const fixedWorld = fixedLocal.clone().applyMatrix4(objectWorldMatrix);

        // Compute Scale Ratios relative to Local Basis (Unsheared)
        const basisX = new THREE.Vector3(1, 0, 0).applyQuaternion(worldQuaternion).normalize();
        const basisY = new THREE.Vector3(0, 1, 0).applyQuaternion(worldQuaternion).normalize();
        const basisZ = new THREE.Vector3(0, 0, 1).applyQuaternion(worldQuaternion).normalize();

        const vOld = new THREE.Vector3().subVectors(p1, fixedWorld);
        const vNew = new THREE.Vector3().subVectors(p2, fixedWorld);

        const distOldX = vOld.dot(basisX);
        const distOldY = vOld.dot(basisY);
        const distOldZ = vOld.dot(basisZ);
        
        const distNewX = vNew.dot(basisX);
        const distNewY = vNew.dot(basisY);
        const distNewZ = vNew.dot(basisZ);

        const ratioX = Math.abs(distOldX) > 1e-5 ? distNewX / distOldX : 1;
        const ratioY = Math.abs(distOldY) > 1e-5 ? distNewY / distOldY : 1;
        const ratioZ = Math.abs(distOldZ) > 1e-5 ? distNewZ / distOldZ : 1;

        // Apply
        const pivotWorldOld = worldPosition; 
        const vPivot = new THREE.Vector3().subVectors(pivotWorldOld, fixedWorld);
        const vPivotNew = new THREE.Vector3()
            .addScaledVector(basisX, vPivot.dot(basisX) * ratioX)
            .addScaledVector(basisY, vPivot.dot(basisY) * ratioY)
            .addScaledVector(basisZ, vPivot.dot(basisZ) * ratioZ);

        const pivotWorldNew = new THREE.Vector3().addVectors(fixedWorld, vPivotNew);
        const MIN_SCALE = 1e-4; // Increased from 1e-6 to prevent Z-fighting/flickering

        if (src.type === 'object') {
            const { mesh, instanceId } = src;
            const localMatrix = _TMP_MAT4_A;
            if (mesh.isBatchedMesh || mesh.isInstancedMesh) {
                mesh.getMatrixAt(instanceId, localMatrix);
            } else {
                localMatrix.copy(mesh.matrix);
            }
            
            const localPos = _TMP_VEC3_A;
            const localQuat = _TMP_QUAT_A;
            const localScl = _TMP_SCALE_A;
            localMatrix.decompose(localPos, localQuat, localScl);

            localScl.x *= ratioX;
            localScl.y *= ratioY;
            localScl.z *= ratioZ;

            if (Math.abs(localScl.x) < MIN_SCALE) localScl.x = Math.sign(localScl.x) * MIN_SCALE || MIN_SCALE;
            if (Math.abs(localScl.y) < MIN_SCALE) localScl.y = Math.sign(localScl.y) * MIN_SCALE || MIN_SCALE;
            if (Math.abs(localScl.z) < MIN_SCALE) localScl.z = Math.sign(localScl.z) * MIN_SCALE || MIN_SCALE;

            if (mesh.isBatchedMesh || mesh.isInstancedMesh) {
                const spaceInv = mesh.matrixWorld.clone().invert();
                const newLocalPos = pivotWorldNew.clone().applyMatrix4(spaceInv);
                localMatrix.compose(newLocalPos, localQuat, localScl);
                mesh.setMatrixAt(instanceId, localMatrix);
                if (mesh.instanceMatrix) mesh.instanceMatrix.needsUpdate = true;
            } else {
                // Return to Standard Mode (Shear Removed)
                mesh.matrixAutoUpdate = true; 
                
                const parentWorldInv = mesh.parent ? mesh.parent.matrixWorld.clone().invert() : new THREE.Matrix4();
                const newPosRelativeParent = pivotWorldNew.clone().applyMatrix4(parentWorldInv);
                localMatrix.compose(newPosRelativeParent, localQuat, localScl);
                mesh.matrix.copy(localMatrix);
                mesh.matrix.decompose(mesh.position, mesh.quaternion, mesh.scale);
            }
        } else if (src.type === 'group') {
            const groups = getGroups();
            const group = groups.get(src.id);
            if (group) {
                group.scale.x *= ratioX;
                group.scale.y *= ratioY;
                group.scale.z *= ratioZ;

                if (Math.abs(group.scale.x) < MIN_SCALE) group.scale.x = Math.sign(group.scale.x) * MIN_SCALE || MIN_SCALE;
                if (Math.abs(group.scale.y) < MIN_SCALE) group.scale.y = Math.sign(group.scale.y) * MIN_SCALE || MIN_SCALE;
                if (Math.abs(group.scale.z) < MIN_SCALE) group.scale.z = Math.sign(group.scale.z) * MIN_SCALE || MIN_SCALE;

                let parentMatrixWorld = new THREE.Matrix4();
                if (group.parent && group.parent.matrixWorld) {
                    parentMatrixWorld.copy(group.parent.matrixWorld);
                }
                const parentInv = parentMatrixWorld.clone().invert();
                const newLocalPos = pivotWorldNew.clone().applyMatrix4(parentInv);
                group.position.copy(newLocalPos);

                // --- Apply to Children ---
                const newLocalMatrix = new THREE.Matrix4().compose(group.position, group.quaternion, group.scale);
                const newGroupWorldMatrix = parentMatrixWorld.clone().multiply(newLocalMatrix);
                const deltaMatrix = new THREE.Matrix4().multiplyMatrices(newGroupWorldMatrix, objectWorldMatrix.clone().invert());

                const allChildren = getAllGroupChildren(loadedObjectGroup, src.id);
                for (const child of allChildren) {
                    if (child.type === 'object' && child.mesh) {
                        const { mesh, instanceId } = child;
                        const instanceLocalMatrix = new THREE.Matrix4();
                        if (mesh.isBatchedMesh || mesh.isInstancedMesh) {
                            mesh.getMatrixAt(instanceId, instanceLocalMatrix);
                        } else {
                            instanceLocalMatrix.copy(mesh.matrix);
                        }

                        const meshWorld = mesh.matrixWorld;
                        const transformer = meshWorld.clone().invert().multiply(deltaMatrix).multiply(meshWorld);
                        instanceLocalMatrix.premultiply(transformer);

                        if (mesh.isBatchedMesh || mesh.isInstancedMesh) {
                            mesh.setMatrixAt(instanceId, instanceLocalMatrix);
                            if (mesh.instanceMatrix) mesh.instanceMatrix.needsUpdate = true;
                        } else {
                            mesh.matrix.copy(instanceLocalMatrix);
                            mesh.matrix.decompose(mesh.position, mesh.quaternion, mesh.scale);
                        }
                    }
                }
            }
        }

    } else {
        // [Affine Logic] (Shear/Scale along the vector)
        // Fixed Point = Opposite Corner of geometry (ignoring pivot)

        const invMatrix = objectWorldMatrix.clone().invert();
        const p1Local = p1.clone().applyMatrix4(invMatrix);

        const min = localBox.min;
        const max = localBox.max;
        const center = new THREE.Vector3().addVectors(min, max).multiplyScalar(0.5);
        const eps = 1e-4;

        const fixedLocal = new THREE.Vector3();
        fixedLocal.x = (p1Local.x > center.x + eps) ? min.x : ((p1Local.x < center.x - eps) ? max.x : p1Local.x);
        fixedLocal.y = (p1Local.y > center.y + eps) ? min.y : ((p1Local.y < center.y - eps) ? max.y : p1Local.y);
        fixedLocal.z = (p1Local.z > center.z + eps) ? min.z : ((p1Local.z < center.z - eps) ? max.z : p1Local.z);

        const fixedWorld = fixedLocal.clone().applyMatrix4(objectWorldMatrix);

        const u = new THREE.Vector3().subVectors(p1, fixedWorld);
        const v = new THREE.Vector3().subVectors(p2, fixedWorld);
        const uLenSq = u.lengthSq();

        // 0-scale check
        const MIN_SCALE_LOGIC = 1e-6;
        const dotProd = u.dot(v);
        
        // Determinant of I + (v-u)u^T / u^2 is (v.u)/u^2
        // We require (v.u) / u^2 >= MIN_SCALE (ignoring sign flip for now, assuming strictly positive-ish scale implies maintaining direction?)
        // If the user drags 'through' the pivot, it flips. 
        // We just ensure the magnitude along the axis is not zero.
        if (uLenSq < 1e-9 || Math.abs(dotProd) < MIN_SCALE_LOGIC) {
            // Can't scale 0-length vector or flatten to 0
            selectedVertexKeys.clear();
            return false;
        }

        // Construct Shear Matrix M = I + ( (v - u) * u^T ) / (u . u)
        // M * u = v
        const delta = new THREE.Vector3().subVectors(v, u);
        const factor = 1.0 / uLenSq;
        
        // M = I + factor * (delta (outer) u)
        const M = new THREE.Matrix4().identity();
        const me = M.elements; // Col-Major: 0,1,2,3(x), 4,5,6,7(y), 8,9,10,11(z), 12,13,14,15(w)

        // Add Outer Product: delta * u^T
        // u = (ux, uy, uz)
        // delta = (dx, dy, dz)
        // Col 0 (x): dx*ux, dy*ux, dz*ux
        me[0]  += delta.x * u.x * factor;
        me[1]  += delta.y * u.x * factor;
        me[2]  += delta.z * u.x * factor;

        me[4]  += delta.x * u.y * factor;
        me[5]  += delta.y * u.y * factor;
        me[6]  += delta.z * u.y * factor;

        me[8]  += delta.x * u.z * factor;
        me[9]  += delta.y * u.z * factor;
        me[10] += delta.z * u.z * factor;

        // Apply to Object:
        // NewWorld = T(F) * M * T(-F) * OldWorld
        // We can optimize T(F) * M * T(-F)
        // Let M_about_F = T(F) * M * T(-F).
        // If F is origin, then M_about_F = M.
        
        const matTranslateF = _TMP_MAT4_B.makeTranslation(fixedWorld.x, fixedWorld.y, fixedWorld.z);
        const matTranslateNegF =  new THREE.Matrix4().makeTranslation(-fixedWorld.x, -fixedWorld.y, -fixedWorld.z);
        
        const transformMatrix = matTranslateF.multiply(M).multiply(matTranslateNegF);
        
        // Apply transformMatrix to Object World Matrix
        const newWorldMatrix = transformMatrix.multiply(objectWorldMatrix);

        if (src.type === 'object') {
            const { mesh, instanceId } = src;
            
            // Calc New Local Matrix
            const newLocalMatrix = _TMP_MAT4_A;
            
            if (mesh.isBatchedMesh || mesh.isInstancedMesh) {
                // Instanced: Local = MeshWorldInverse * NewWorld
                const meshWorldInv = mesh.matrixWorld.clone().invert();
                newLocalMatrix.multiplyMatrices(meshWorldInv, newWorldMatrix);
                
                mesh.setMatrixAt(instanceId, newLocalMatrix);
                if (mesh.instanceMatrix) mesh.instanceMatrix.needsUpdate = true;
                
            } else {
                // Standard: Local = ParentWorldInverse * NewWorld
                const parentWorldInv = mesh.parent ? mesh.parent.matrixWorld.clone().invert() : new THREE.Matrix4();
                newLocalMatrix.multiplyMatrices(parentWorldInv, newWorldMatrix);
                
                mesh.matrix.copy(newLocalMatrix);
                mesh.matrixAutoUpdate = false; // Important to preserve shear
                // Note: Updating P/Q/S from decomposed non-orthogonal matrix might be lossy/inaccurate
                // but we update them anyway for helpers/inspection if needed.
                mesh.matrix.decompose(mesh.position, mesh.quaternion, mesh.scale);
            }
            
        } else if (src.type === 'group') {
            const groups = getGroups();
            const group = groups.get(src.id);
            if (group) {
                // Local = ParentWorldInverse * NewWorld
                let parentMatrixWorld = new THREE.Matrix4();
                if (group.parent && group.parent.matrixWorld) {
                    parentMatrixWorld.copy(group.parent.matrixWorld);
                }
                const parentInv = parentMatrixWorld.invert();
                
                const newLocal = parentInv.multiply(newWorldMatrix);
                
                if (!group.matrix) group.matrix = new THREE.Matrix4();
                group.matrix.copy(newLocal);
                
                newLocal.decompose(group.position, group.quaternion, group.scale);

                // --- Apply to Children ---
                const deltaMatrix = new THREE.Matrix4().multiplyMatrices(newWorldMatrix, objectWorldMatrix.clone().invert());
                
                const allChildren = getAllGroupChildren(loadedObjectGroup, src.id);
                for (const child of allChildren) {
                    if (child.type === 'object' && child.mesh) {
                        const { mesh, instanceId } = child;
                        const instanceLocalMatrix = new THREE.Matrix4();
                        if (mesh.isBatchedMesh || mesh.isInstancedMesh) {
                            mesh.getMatrixAt(instanceId, instanceLocalMatrix);
                        } else {
                            instanceLocalMatrix.copy(mesh.matrix);
                        }

                        const meshWorld = mesh.matrixWorld;
                        const transformer = meshWorld.clone().invert().multiply(deltaMatrix).multiply(meshWorld);
                        instanceLocalMatrix.premultiply(transformer);

                        if (mesh.isBatchedMesh || mesh.isInstancedMesh) {
                            mesh.setMatrixAt(instanceId, instanceLocalMatrix);
                            if (mesh.instanceMatrix) mesh.instanceMatrix.needsUpdate = true;
                        } else {
                            mesh.matrix.copy(instanceLocalMatrix);
                            mesh.matrix.decompose(mesh.position, mesh.quaternion, mesh.scale);
                        }
                    }
                }
            }
        }
    }

    /* Lines 153-157 omitted */

    // 6. Perform Swap: Select target object
    let targetSrc = sprite2.userData.source;
    if (!targetSrc && sprite2.userData.isCenter && currentSelection.primary) {
        targetSrc = currentSelection.primary;
    }
    
    // Only swap if valid target exists
    if (targetSrc) {
        performSelectionSwap(src, targetSrc, {
            currentSelection,
            getGroups,
            getGroupWorldMatrixWithFallback,
            setGizmoState,
            getGizmoState,
            updateHelperPosition,
            SelectionCenter,
            vertexQueue
        });
    }

    selectedVertexKeys.clear();
    updateHelperPosition();
    updateSelectionOverlay();

    return true;
}