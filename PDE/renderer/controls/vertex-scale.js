import * as THREE from 'three/webgpu';
import * as GroupUtils from './group.js';
import * as Overlay from './overlay.js';
import { performSelectionSwap } from './vertex-swap.js';
import { removeShearFromSelection } from './shear-remove.js';

const _TMP_MAT4_A = new THREE.Matrix4();
const _TMP_MAT4_B = new THREE.Matrix4();
const _TMP_INSTANCE_MATRIX = new THREE.Matrix4();

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
        vertexQueue,
        getSelectedItems
    }
) {
    if (!isVertexMode || gizmoMode !== 'scale') return false;

    const groupCount = currentSelection.groups ? currentSelection.groups.size : 0;
    let objectIdCount = 0;
    if (currentSelection.objects && currentSelection.objects.size > 0) {
        for (const ids of currentSelection.objects.values()) {
            objectIdCount += ids.size;
        }
    }
    const activeSelectionCount = groupCount + objectIdCount;
    const preserveSelectionOnSnap = activeSelectionCount > 1;

    const keys = Array.from(selectedVertexKeys);
    if (keys.length !== 2) return false;

    const k1 = keys[0];
    const k2 = keys[1];

    const foundSprites = Overlay.findSpritesByKeys([k1, k2]);
    const sprite1 = foundSprites[k1];
    const sprite2 = foundSprites[k2];

    if (!sprite1 || !sprite2 || !sprite1.userData.source) return false;

    const p1 = sprite1.position.clone();
    const p2 = sprite2.position.clone();
    
    if (p1.distanceToSquared(p2) < 1e-9) {
        selectedVertexKeys.clear();
        return false;
    }

    const src = sprite1.userData.source;

    // 1. Identify effective selection
    const isSrcEffectiveSelected = (() => {
        if (src.type === 'group') return currentSelection.groups.has(src.id);
        if (src.type === 'object') {
            if (currentSelection.objects.has(src.mesh) && currentSelection.objects.get(src.mesh).has(src.instanceId)) return true;
            
            const objectToGroup = GroupUtils.getObjectToGroup(loadedObjectGroup);
            if (objectToGroup) {
                const key = GroupUtils.getGroupKey(src.mesh, src.instanceId);
                let groupId = objectToGroup.get(key);
                while (groupId) {
                    if (currentSelection.groups.has(groupId)) return true;
                    const g = getGroups().get(groupId);
                    groupId = g ? g.parent : null;
                }
            }
        }
        return false;
    })();

    // 2. Resolve bundle from queue
    let containingBundle = null;
    if (!isSrcEffectiveSelected) {
        for (const qItem of vertexQueue) {
            if (qItem.type === 'bundle' && qItem.items) {
                const found = qItem.items.find(sub => {
                    if (src.type === 'group' && sub.type === 'group') return sub.id === src.id;
                    if (src.type === 'object' && sub.type === 'object') return sub.mesh === src.mesh && sub.instanceId === src.instanceId;
                    return false;
                });
                if (found) {
                    containingBundle = qItem;
                    break;
                }
            }
        }
    }

    let objectWorldMatrix = new THREE.Matrix4();
    let localBox = null;

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

    let transformMatrix = new THREE.Matrix4();
    const MIN_SCALE = 1e-4;

    // 3. Determine Transformation Matrix
    if (isCtrlDown) {
        const originalInv = objectWorldMatrix.clone().invert();
        const p1Local = p1.clone().applyMatrix4(originalInv);

        if (src.type === 'object') {
             try {
                 const items = isSrcEffectiveSelected ? getSelectedItems() : [{ mesh: src.mesh, instanceId: src.instanceId }];
                 const state = getGizmoState();
                 removeShearFromSelection(
                     items, selectionHelper, currentSelection, loadedObjectGroup,
                     state.pivotMode, state.isCustomPivot, state.pivotOffset,
                     { SelectionCenter, updateHelperPosition, updateSelectionOverlay }
                 );
                 if (src.mesh.isBatchedMesh || src.mesh.isInstancedMesh) src.mesh.getMatrixAt(src.instanceId, objectWorldMatrix);
                 else objectWorldMatrix.copy(src.mesh.matrix);
                 objectWorldMatrix.premultiply(src.mesh.matrixWorld);
                 p1.copy(p1Local).applyMatrix4(objectWorldMatrix);
             } catch (err) {}
        }

        const worldPos = new THREE.Vector3(), worldQuat = new THREE.Quaternion(), worldScl = new THREE.Vector3();
        objectWorldMatrix.decompose(worldPos, worldQuat, worldScl);

        const center = new THREE.Vector3().addVectors(localBox.min, localBox.max).multiplyScalar(0.5);
        const invMatrix = objectWorldMatrix.clone().invert();
        const curP1Local = p1.clone().applyMatrix4(invMatrix);
        const eps = 1e-4;

        const fixedLocal = new THREE.Vector3();
        fixedLocal.x = (curP1Local.x > center.x + eps) ? localBox.min.x : ((curP1Local.x < center.x - eps) ? localBox.max.x : curP1Local.x);
        fixedLocal.y = (curP1Local.y > center.y + eps) ? localBox.min.y : ((curP1Local.y < center.y - eps) ? localBox.max.y : p1Local.y); // Fixed p1Local fallback
        fixedLocal.z = (curP1Local.z > center.z + eps) ? localBox.min.z : ((curP1Local.z < center.z - eps) ? localBox.max.z : curP1Local.z);

        const fixedWorld = fixedLocal.applyMatrix4(objectWorldMatrix);
        const basisX = new THREE.Vector3(1, 0, 0).applyQuaternion(worldQuat).normalize();
        const basisY = new THREE.Vector3(0, 1, 0).applyQuaternion(worldQuat).normalize();
        const basisZ = new THREE.Vector3(0, 0, 1).applyQuaternion(worldQuat).normalize();

        const vOld = new THREE.Vector3().subVectors(p1, fixedWorld);
        const vNew = new THREE.Vector3().subVectors(p2, fixedWorld);

        const ratioX = Math.abs(vOld.dot(basisX)) > 1e-5 ? vNew.dot(basisX) / vOld.dot(basisX) : 1;
        const ratioY = Math.abs(vOld.dot(basisY)) > 1e-5 ? vNew.dot(basisY) / vOld.dot(basisY) : 1;
        const ratioZ = Math.abs(vOld.dot(basisZ)) > 1e-5 ? vNew.dot(basisZ) / vOld.dot(basisZ) : 1;

        const matT = new THREE.Matrix4().makeTranslation(fixedWorld.x, fixedWorld.y, fixedWorld.z);
        const matTInv = new THREE.Matrix4().makeTranslation(-fixedWorld.x, -fixedWorld.y, -fixedWorld.z);
        const matR = new THREE.Matrix4().makeRotationFromQuaternion(worldQuat);
        const matRInv = matR.clone().invert();
        const matS = new THREE.Matrix4().makeScale(ratioX, ratioY, ratioZ);

        transformMatrix = matT.multiply(matR).multiply(matS).multiply(matRInv).multiply(matTInv);

    } else {
        const center = new THREE.Vector3().addVectors(localBox.min, localBox.max).multiplyScalar(0.5);
        const invMatrix = objectWorldMatrix.clone().invert();
        const p1Local = p1.clone().applyMatrix4(invMatrix);
        const eps = 1e-4;

        const fixedLocal = new THREE.Vector3();
        fixedLocal.x = (p1Local.x > center.x + eps) ? localBox.min.x : ((p1Local.x < center.x - eps) ? localBox.max.x : p1Local.x);
        fixedLocal.y = (p1Local.y > center.y + eps) ? localBox.min.y : ((p1Local.y < center.y - eps) ? localBox.max.y : p1Local.y);
        fixedLocal.z = (p1Local.z > center.z + eps) ? localBox.min.z : ((p1Local.z < center.z - eps) ? localBox.max.z : p1Local.z);

        const fixedWorld = fixedLocal.applyMatrix4(objectWorldMatrix);
        const u = new THREE.Vector3().subVectors(p1, fixedWorld);
        const v = new THREE.Vector3().subVectors(p2, fixedWorld);
        const uLenSq = u.lengthSq();

        if (uLenSq < 1e-9 || Math.abs(u.dot(v)) < 1e-6) {
            selectedVertexKeys.clear();
            return false;
        }

        const deltaVec = new THREE.Vector3().subVectors(v, u);
        const factor = 1.0 / uLenSq;
        const M = new THREE.Matrix4().identity();
        const me = M.elements; 
        me[0] += deltaVec.x * u.x * factor; me[1] += deltaVec.y * u.x * factor; me[2] += deltaVec.z * u.x * factor;
        me[4] += deltaVec.x * u.y * factor; me[5] += deltaVec.y * u.y * factor; me[6] += deltaVec.z * u.y * factor;
        me[8] += deltaVec.x * u.z * factor; me[9] += deltaVec.y * u.z * factor; me[10] += deltaVec.z * u.z * factor;

        const matT = new THREE.Matrix4().makeTranslation(fixedWorld.x, fixedWorld.y, fixedWorld.z);
        const matTInv = new THREE.Matrix4().makeTranslation(-fixedWorld.x, -fixedWorld.y, -fixedWorld.z);
        transformMatrix = matT.multiply(M).multiply(matTInv);
    }

    // 4. Resolve Targets
    const targets = { groups: new Set(), instances: new Map() };
    const addInstance = (mesh, id) => {
        let set = targets.instances.get(mesh);
        if (!set) { set = new Set(); targets.instances.set(mesh, set); }
        set.add(id);
    };
    const addGroup = (groupId) => {
        targets.groups.add(groupId);
        GroupUtils.getAllGroupChildren(loadedObjectGroup, groupId).forEach(c => {
            if (c.type === 'object') addInstance(c.mesh, c.instanceId);
            else if (c.type === 'group') addGroup(c.id);
        });
    };

    if (isSrcEffectiveSelected) {
        currentSelection.groups?.forEach(addGroup);
        currentSelection.objects?.forEach((ids, mesh) => ids.forEach(id => addInstance(mesh, id)));
        
        const state = getGizmoState();
        const updates = {};
        if (state._gizmoAnchorValid) updates._gizmoAnchorPosition = state._gizmoAnchorPosition.clone().applyMatrix4(transformMatrix);
        if (state._multiSelectionOriginAnchorValid) updates._multiSelectionOriginAnchorPosition = state._multiSelectionOriginAnchorPosition.clone().applyMatrix4(transformMatrix);
        setGizmoState(updates);
    } else if (containingBundle) {
        containingBundle.items.forEach(item => {
            if (item.type === 'group') addGroup(item.id);
            else addInstance(item.mesh, item.instanceId);
        });
    } else {
        if (src.type === 'group') addGroup(src.id);
        else addInstance(src.mesh, src.instanceId);
    }

    // 5. Execute
    for (const [mesh, ids] of targets.instances) {
        const meshWorldInv = _TMP_MAT4_B.copy(mesh.matrixWorld).invert();
        const localTransform = new THREE.Matrix4().multiplyMatrices(meshWorldInv, transformMatrix).multiply(mesh.matrixWorld);
        
        for (const id of ids) {
            mesh.getMatrixAt(id, _TMP_INSTANCE_MATRIX);
            _TMP_INSTANCE_MATRIX.premultiply(localTransform);
            
            // Safety: Check if matrix is valid (not collapsed)
            if (Math.abs(_TMP_INSTANCE_MATRIX.determinant()) > 1e-12) {
                mesh.setMatrixAt(id, _TMP_INSTANCE_MATRIX);
                
                // For standard meshes (non-instanced), we must ensure matrixAutoUpdate is false to keep shear
                if (!mesh.isInstancedMesh && !mesh.isBatchedMesh) {
                    mesh.matrixAutoUpdate = false;
                    _TMP_INSTANCE_MATRIX.decompose(mesh.position, mesh.quaternion, mesh.scale);
                }
            }
        }
        if (mesh.isInstancedMesh) mesh.instanceMatrix.needsUpdate = true;
    }

    for (const groupId of targets.groups) {
        const groups = getGroups();
        const group = groups.get(groupId);
        if (group) {
            if (!group.matrix) {
                const gPos = group.position || new THREE.Vector3();
                const gQuat = group.quaternion || new THREE.Quaternion();
                const gScale = group.scale || new THREE.Vector3(1, 1, 1);
                group.matrix = new THREE.Matrix4().compose(gPos, gQuat, gScale);
            }
            
            _TMP_MAT4_A.copy(group.matrix).premultiply(transformMatrix);
            
            if (Math.abs(_TMP_MAT4_A.determinant()) > 1e-12) {
                group.matrix.copy(_TMP_MAT4_A);
                // We still decompose for UI/inspector, but the matrix will hold the shear
                group.matrix.decompose(
                    group.position = group.position || new THREE.Vector3(), 
                    group.quaternion = group.quaternion || new THREE.Quaternion(), 
                    group.scale = group.scale || new THREE.Vector3(1, 1, 1)
                );
            }
        }
    }

    // 6. Swap
    let targetSrc = sprite2.userData.source || (sprite2.userData.isCenter ? currentSelection.primary : null);
    if (targetSrc) performSelectionSwap(src, targetSrc, {
        currentSelection, getGroups, getGroupWorldMatrixWithFallback, setGizmoState, getGizmoState, updateHelperPosition, SelectionCenter, vertexQueue
    }, { preserveSelection: preserveSelectionOnSnap || isSrcEffectiveSelected || !!containingBundle });

    selectedVertexKeys.clear();
    updateHelperPosition();
    updateSelectionOverlay();
    return true;
}
