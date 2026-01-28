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
    // -> Rotate Object around Gizmo Center (Pivot)
    if (sprite1 && sprite2 && sprite1.userData.source && (sprite2.userData.isCenter || sprite2.userData.source)) {
        const pivot = selectionHelper.position.clone();
        
        const p1 = sprite1.position;
        const p2 = sprite2.position;
        
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

        const src = sprite1.userData.source;

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
            instances: new Map() 
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
            // Delta = M_inv_parent * Transform * M_parent
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
        });
        
        selectedVertexKeys.clear();
        updateHelperPosition();
        updateSelectionOverlay();
    } 

    return true;
}
