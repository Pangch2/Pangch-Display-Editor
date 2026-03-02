import * as THREE from 'three/webgpu';
import * as GroupUtils from './group.js';
import * as Overlay from './overlay.js';
import { performSelectionSwap } from './vertex-swap.js';

const _TMP_MAT4_A = new THREE.Matrix4();
const _TMP_MAT4_B = new THREE.Matrix4();
const _TMP_INSTANCE_MATRIX = new THREE.Matrix4();
const _TMP_VEC3_A = new THREE.Vector3();
const _TMP_VEC3_B = new THREE.Vector3();
const _TMP_QUAT = new THREE.Quaternion();

export function processVertexRotate(
    selectedVertexKeys,
    {
        isVertexMode,
        gizmoMode,
        currentSelection,
        loadedObjectGroup,
        selectionHelper,
        
        // State Interface
        getGizmoState,
        setGizmoState,
        
        // Methods
        getGroups,
        getGroupWorldMatrixWithFallback,
        updateHelperPosition,
        updateSelectionOverlay,
        SelectionCenter,
        vertexQueue
    }
) {
    if (!isVertexMode || gizmoMode !== 'rotate') return false;

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
    
    let sprite1 = null;
    let sprite2 = null;
    
    const foundSprites = Overlay.findSpritesByKeys([k1, k2]);
    sprite1 = foundSprites[k1];
    sprite2 = foundSprites[k2];

    // CASE 1: First Click = Gizmo (Center)
    // Rotating around the center to a vertex is invalid (distance 0 -> distance > 0)
    // So we ignore Case 1 for Rotation or treat it as invalid.
    if (sprite1 && sprite1.userData.isCenter) {
        // If needed, we could implement "Aim Gizmo" here, but for now we ignore.
        // Clearing selection to reset interaction
        selectedVertexKeys.clear();
        updateSelectionOverlay();
        return false;
    }

    // CASE 2: First Click = Object Vertex, Second Click = (Gizmo OR Object Vertex)
    // -> Rotate Object around Opposite Corner (Pivot) logic
    if (sprite1 && sprite2 && sprite1.userData.source && (sprite2.userData.isCenter || sprite2.userData.source)) {
        const src = sprite1.userData.source;
        let objectWorldMatrix = new THREE.Matrix4();
        let localBox = null;

        // 1. Resolve effective World Matrix and Local Bounding Box (similar to vertex-scale)
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

        if (!localBox || localBox.isEmpty()) {
            selectedVertexKeys.clear();
            return false;
        }

        const p1 = sprite1.position;
        const p2 = sprite2.position;

        // Compute Pivot: Opposite Corner in Local Space -> World Space
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

        const pivot = fixedLocal.clone().applyMatrix4(objectWorldMatrix);
        
        // Vectors from Pivot to Clicked Points
        const v1 = _TMP_VEC3_A.subVectors(p1, pivot);
        const v2 = _TMP_VEC3_B.subVectors(p2, pivot);

        // Check for zero length to avoid NaN
        if (v1.lengthSq() < 1e-9 || v2.lengthSq() < 1e-9) {
            selectedVertexKeys.clear();
            updateSelectionOverlay();
            return false;
        }

        v1.normalize();
        v2.normalize();

        // Calculate Rotation Quaternion from v1 to v2
        const q = _TMP_QUAT.setFromUnitVectors(v1, v2);

        // Build Rotation Matrix around Pivot: T(P) * R(q) * T(-P)
        const tMat = _TMP_MAT4_A.makeTranslation(pivot.x, pivot.y, pivot.z);
        const rMat = _TMP_MAT4_B.makeRotationFromQuaternion(q);
        const tInvMat = new THREE.Matrix4().makeTranslation(-pivot.x, -pivot.y, -pivot.z);

        // Combine: M = T * R * T_inv
        const transformMat = tMat.multiply(rMat).multiply(tInvMat);

        // 1. Identify effective selection (same as vertex-translate)
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

        // 2. Build explicit lists of what to move
        const targets = {
            groups: new Set(),
            instances: new Map(),
            isBundleMove: false
        };

        const addInstance = (mesh, id) => {
            let set = targets.instances.get(mesh);
            if (!set) { set = new Set(); targets.instances.set(mesh, set); }
            set.add(id);
        };

        const addGroup = (groupId) => {
            targets.groups.add(groupId);
            const children = GroupUtils.getAllGroupChildren(loadedObjectGroup, groupId);
            for (const child of children) {
                if (child.type === 'object') addInstance(child.mesh, child.instanceId);
                else if (child.type === 'group') addGroup(child.id);
            }
        };

        const addBundle = (bundle) => {
            if (!bundle || !bundle.items) return;
            targets.isBundleMove = true;
            for (const item of bundle.items) {
                if (item.type === 'group') addGroup(item.id);
                else if (item.type === 'object') addInstance(item.mesh, item.instanceId);
            }
        };

        // Check if src is part of a bundle in the queue
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

        if (isSrcEffectiveSelected) {
            if (currentSelection.groups) {
                for (const gid of currentSelection.groups) addGroup(gid);
            }
            if (currentSelection.objects) {
                for (const [mesh, ids] of currentSelection.objects) {
                    for (const id of ids) {
                        addInstance(mesh, id);
                    }
                }
            }

            // Update Gizmo State anchors
            const state = getGizmoState();
            const updates = {};
            if (state._gizmoAnchorValid && state._gizmoAnchorPosition) {
                updates._gizmoAnchorPosition = state._gizmoAnchorPosition.clone().applyMatrix4(transformMat);
            }
            if (state._multiSelectionOriginAnchorValid && state._multiSelectionOriginAnchorPosition) {
                updates._multiSelectionOriginAnchorPosition = state._multiSelectionOriginAnchorPosition.clone().applyMatrix4(transformMat);
            }
            if (Object.keys(updates).length > 0) setGizmoState(updates);

        } else if (containingBundle) {
            addBundle(containingBundle);
        } else {
            if (src.type === 'group') {
                addGroup(src.id);
            } else {
                const { mesh, instanceId } = src;
                addInstance(mesh, instanceId);
            }
        }

        // 3. Execute Moves (Rotation)
        
        // A. Update Instances (Visuals)
        for (const [mesh, ids] of targets.instances) {
            const meshWorldInv = _TMP_MAT4_B.copy(mesh.matrixWorld).invert();
            const localTransform = new THREE.Matrix4().multiplyMatrices(meshWorldInv, transformMat);
            localTransform.multiply(mesh.matrixWorld);

            for (const id of ids) {
                mesh.getMatrixAt(id, _TMP_INSTANCE_MATRIX);
                _TMP_INSTANCE_MATRIX.premultiply(localTransform);
                mesh.setMatrixAt(id, _TMP_INSTANCE_MATRIX);
            }
            if (mesh.isInstancedMesh) mesh.instanceMatrix.needsUpdate = true;
        }

        // B. Update Group Metadata (Logic)
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
                group.matrix.premultiply(transformMat);
                if (!group.position) group.position = new THREE.Vector3();
                if (!group.quaternion) group.quaternion = new THREE.Quaternion();
                if (!group.scale) group.scale = new THREE.Vector3(1, 1, 1);
                group.matrix.decompose(group.position, group.quaternion, group.scale);
            }
        }

        // Swapping selection state
        let targetSrc = sprite2.userData.source;
        if (!targetSrc && sprite2.userData.isCenter && currentSelection.primary) {
            targetSrc = currentSelection.primary;
        }
        performSelectionSwap(src, targetSrc, {
            currentSelection,
            getGroups,
            getGroupWorldMatrixWithFallback,
            setGizmoState,
            getGizmoState,
            updateHelperPosition,
            SelectionCenter,
            vertexQueue
        }, { preserveSelection: preserveSelectionOnSnap || isSrcEffectiveSelected || !!containingBundle });
        
        selectedVertexKeys.clear();
        updateHelperPosition();
        updateSelectionOverlay();
    } 

    return true;
}