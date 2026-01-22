import * as THREE from 'three/webgpu';
import * as GroupUtils from './group.js';
import * as Overlay from './overlay.js';

const _TMP_MAT4_A = new THREE.Matrix4();
const _TMP_MAT4_B = new THREE.Matrix4();
const _TMP_INSTANCE_MATRIX = new THREE.Matrix4();
const _ZERO_VEC3 = new THREE.Vector3(0, 0, 0);

export function processVertexSnap(
    selectedVertexKeys,
    {
        isVertexMode,
        gizmoMode,
        currentSelection,
        loadedObjectGroup,
        selectionHelper,
        
        // State Interface
        getGizmoState,   // Returns object with current state values
        setGizmoState,   // Function to update state values
        
        // Methods
        getGroups,
        getGroupWorldMatrixWithFallback,
        getGroupWorldMatrix,
        updateHelperPosition,
        updateSelectionOverlay,
        _isMultiSelection,
        _getSingleSelectedGroupId,
        SelectionCenter,
        vertexQueue
    }
) {
    if (!isVertexMode || gizmoMode !== 'translate') return false;

    const keys = Array.from(selectedVertexKeys);
    if (keys.length !== 2) return false;

    const k1 = keys[0];
    const k2 = keys[1];
    
    let sprite1 = null;
    let sprite2 = null;
    
    const foundSprites = Overlay.findSpritesByKeys([k1, k2]);
    sprite1 = foundSprites[k1];
    sprite2 = foundSprites[k2];

    const state = getGizmoState();
    
    // Helper to update gizmoLocalPosition in vertexQueue
    const updateQueueItemPivot = (sourceItem, newPivot) => {
        if (!vertexQueue) return;
        const target = vertexQueue.find(item => {
            if (item.type !== sourceItem.type) return false;
            if (item.type === 'group') return item.id === sourceItem.id;
            return item.mesh === sourceItem.mesh && item.instanceId === sourceItem.instanceId;
        });
        if (target) {
            target.gizmoLocalPosition = newPivot;
        }
    };

    // Check for Gizmo Snap or Object Snap based on selection order
    // sprite1 = First Clicked, sprite2 = Second Clicked

    // CASE 1: First Clicked = Gizmo (Center)
    if (sprite1 && sprite2 && sprite1.userData.isCenter) {
        
        const isClonedGizmo = !!sprite1.userData.source;

        // 1-A. Cloned Gizmo (Has Source) -> Snap ONLY that object's pivot to Target (Vertex or Gizmo Center)
        if (isClonedGizmo && (sprite2.userData.source || sprite2.userData.isCenter)) {
            const targetPos = sprite2.position.clone();
            const src = sprite1.userData.source;

            if (src.type === 'object' && src.mesh) {
                const { mesh, instanceId } = src;
                const instanceMatrix = _TMP_MAT4_A;
                
                if (mesh.isBatchedMesh || mesh.isInstancedMesh) {
                     mesh.getMatrixAt(instanceId, instanceMatrix);
                } else {
                     instanceMatrix.copy(mesh.matrix);
                }
                const worldMatrix = instanceMatrix.premultiply(mesh.matrixWorld);
                const inv = worldMatrix.clone().invert();
                const localPivot = targetPos.clone().applyMatrix4(inv);

                if (mesh.isBatchedMesh || mesh.isInstancedMesh) {
                    if (!mesh.userData.customPivots) mesh.userData.customPivots = new Map();
                    mesh.userData.customPivots.set(instanceId, localPivot);

                    // Propagate to peers if composite object
                    if (mesh.userData.itemIds) {
                        const myItemId = mesh.userData.itemIds.get(instanceId);
                        if (myItemId !== undefined) {
                            for (const [peerId, peerItemId] of mesh.userData.itemIds) {
                                if (peerItemId === myItemId && peerId !== instanceId) {
                                     // Re-calculate local pivot for peer (World Space Pivot -> Peer Local Space)
                                     mesh.getMatrixAt(peerId, _TMP_MAT4_B);
                                     _TMP_MAT4_B.premultiply(mesh.matrixWorld);
                                     _TMP_MAT4_B.invert();
                                     const peerPivot = targetPos.clone().applyMatrix4(_TMP_MAT4_B);
                                     mesh.userData.customPivots.set(peerId, peerPivot);
                                }
                            }
                        }
                    }
                } else {
                    mesh.userData.customPivot = localPivot;
                }
                mesh.userData.isCustomPivot = true;
                updateQueueItemPivot(src, localPivot);
                console.log(`Cloned Gizmo: Custom pivot updated for object ${mesh.uuid} instance ${instanceId}`);
            } else if (src.type === 'group') {
                const groups = getGroups();
                const group = groups.get(src.id);
                if (group) {
                     const groupMatrix = getGroupWorldMatrixWithFallback(src.id, _TMP_MAT4_A);
                     const inv = groupMatrix.clone().invert();
                     group.pivot = targetPos.clone().applyMatrix4(inv);
                     group.isCustomPivot = true;
                     updateQueueItemPivot(src, group.pivot);
                     console.log(`Cloned Gizmo: Custom pivot updated for group ${src.id}`);
                }
            }
            
            selectedVertexKeys.clear();
            updateHelperPosition();
            updateSelectionOverlay();

        // 1-B. Main Gizmo (No Source) -> Snap Selection Pivot to Vertex (Original Logic)
        } else if (!isClonedGizmo && sprite2.userData.source) {
            // Snap Gizmo to Vertex
            const targetSprite = sprite2;
            const targetPos = targetSprite.position.clone();
            selectionHelper.position.copy(targetPos);
            
            setGizmoState({
                _gizmoAnchorPosition: targetPos,
                _gizmoAnchorValid: true
            });

            selectionHelper.updateMatrixWorld();

            // Update Custom Pivot State
            // Use isCustomPivot=true for baseline calculation to ensure we measure offset 
            // against the same origin that will be used when rendering.
            
            // Note: We need to temporarily force isCustomPivot true locally if it wasn't, 
            // but here we are establishing it so we pass true.
            const baseline = SelectionCenter('origin', true, _ZERO_VEC3);
            const newPivotOffset = new THREE.Vector3().subVectors(selectionHelper.position, baseline);
            
            setGizmoState({
                isCustomPivot: true,
                pivotOffset: newPivotOffset
            });

            // When a custom pivot is set by snapping, force switch to Origin mode
            // so the user sees the new pivot location immediately.
            if (state.pivotMode === 'center') {
                setGizmoState({ pivotMode: 'origin' });
                console.log("Switched to Pivot Mode: Origin (due to Custom Pivot snap)");
            }

            // Apply to Selection State (Persist)
            if (_isMultiSelection()) {
                setGizmoState({
                    _multiSelectionOriginAnchorPosition: selectionHelper.position,
                    _multiSelectionOriginAnchorValid: true
                });

                if (!state._multiSelectionOriginAnchorInitialValid) {
                    setGizmoState({
                        _multiSelectionOriginAnchorInitialPosition: selectionHelper.position.clone(),
                        _multiSelectionOriginAnchorInitialValid: true
                    });
                }
            }

            // Always persist to Groups (Single or Multi)
            if (currentSelection.groups && currentSelection.groups.size > 0) {
                 const groups = getGroups();
                 for (const groupId of currentSelection.groups) {
                     const group = groups.get(groupId);
                     if (group) {
                         const groupMatrix = getGroupWorldMatrixWithFallback(groupId, _TMP_MAT4_A);
                         const inv = groupMatrix.clone().invert();
                         group.pivot = targetPos.clone().applyMatrix4(inv);
                         group.isCustomPivot = true;
                         updateQueueItemPivot({ type: 'group', id: groupId }, group.pivot);
                     }
                 }
            }

            // Always persist to Objects (Single or Multi)
            if (currentSelection.objects && currentSelection.objects.size > 0) {
                for (const [mesh, ids] of currentSelection.objects) {
                    if (!mesh || !ids) continue;
                    
                    for (const id of ids) {
                        const instanceMatrix = _TMP_MAT4_A;
                        mesh.getMatrixAt(id, instanceMatrix);
                        const worldMatrix = instanceMatrix.premultiply(mesh.matrixWorld);
                        const inv = worldMatrix.clone().invert();
                        const localPivot = targetPos.clone().applyMatrix4(inv);
                        
                        if (mesh.isBatchedMesh || mesh.isInstancedMesh) {
                            if (!mesh.userData.customPivots) mesh.userData.customPivots = new Map();
                            mesh.userData.customPivots.set(id, localPivot);
                            
                             // Propagate to peers if composite object
                            if (mesh.userData.itemIds) {
                                let myItemId = mesh.userData.itemIds.get(id);
                                if (myItemId === undefined) {
                                    const key = (typeof id === 'number') ? String(id) : Number(id);
                                    myItemId = mesh.userData.itemIds.get(key);
                                }
                                
                                if (myItemId !== undefined) {
                                    for (const [peerKey, peerItemId] of mesh.userData.itemIds) {
                                        const peerId = Number(peerKey);
                                        const currentId = Number(id);
                                        if (peerItemId === myItemId && peerId !== currentId) {
                                             mesh.getMatrixAt(peerId, _TMP_MAT4_B);
                                             _TMP_MAT4_B.premultiply(mesh.matrixWorld);
                                             _TMP_MAT4_B.invert();
                                             const peerPivot = targetPos.clone().applyMatrix4(_TMP_MAT4_B);
                                             mesh.userData.customPivots.set(peerId, peerPivot);
                                        }
                                    }
                                }
                            }
                        } else {
                            mesh.userData.customPivot = localPivot;
                        }
                        mesh.userData.isCustomPivot = true;
                        updateQueueItemPivot({ type: 'object', mesh, instanceId: id }, localPivot);
                    }
                }
            }

            selectedVertexKeys.clear();
            updateHelperPosition();
            updateSelectionOverlay();
            console.log("Gizmo snapped to vertex (Custom Pivot set)");
        }

    // CASE 2: First Clicked = Object Vertex, Second Clicked = (Gizmo OR Object Vertex)
    // -> Move Object (Snap Object to Position)
    } else if (sprite1 && sprite2 && sprite1.userData.source && (sprite2.userData.isCenter || sprite2.userData.source)) {
        const p1 = sprite1.position;
        const p2 = sprite2.position;
        const delta = new THREE.Vector3().subVectors(p2, p1);
        
        const src = sprite1.userData.source;
        const tMat = _TMP_MAT4_A.makeTranslation(delta.x, delta.y, delta.z);

        // Fix: Complete logic to resolve what to move (Group Children & Composite Items)
        // 1. Identify effective selection
        const isSrcEffectiveSelected = (() => {
            if (src.type === 'group') return currentSelection.groups.has(src.id);
            if (src.type === 'object') {
                // Direct
                if (currentSelection.objects.has(src.mesh) && currentSelection.objects.get(src.mesh).has(src.instanceId)) return true;
                
                // Group Ancestry
                const objectToGroup = GroupUtils.getObjectToGroup(loadedObjectGroup); // Use GroupUtils direct import
                if (objectToGroup) {
                    const key = GroupUtils.getGroupKey(src.mesh, src.instanceId);
                    let groupId = objectToGroup.get(key);
                    while (groupId) {
                        if (currentSelection.groups.has(groupId)) return true;
                        const g = getGroups().get(groupId);
                        groupId = g ? g.parent : null;
                    }
                }

                // ItemId Linkage (Composite Object part of selection?)
                if (src.mesh.isBatchedMesh && src.mesh.userData.itemIds) {
                    const myItemId = src.mesh.userData.itemIds.get(src.instanceId);
                    if (myItemId !== undefined) {
                        // Check if any selected object shares this itemId
                        for (const [sMesh, sIds] of currentSelection.objects) {
                            if (sMesh.isBatchedMesh && sMesh.userData.itemIds) {
                                for (const sId of sIds) {
                                    if (sMesh.userData.itemIds.get(sId) === myItemId) return true;
                                }
                            }
                        }
                    }
                }
            }
            return false;
        })();

        // 2. Build explicit lists of what to move
        const targets = {
            groups: new Set(),         // Group Metadata to update
            instances: new Map()       // Actual visual instances { mesh -> Set<id> }
        };

        const addInstance = (mesh, id) => {
            let set = targets.instances.get(mesh);
            if (!set) { set = new Set(); targets.instances.set(mesh, set); }
            set.add(id);
        };

        const addGroup = (groupId) => {
            targets.groups.add(groupId);
            // Recursively add all children instances of this group
            const children = GroupUtils.getAllGroupChildren(loadedObjectGroup, groupId);
            for (const child of children) {
                if (child.type === 'object') addInstance(child.mesh, child.instanceId);
                else if (child.type === 'group') addGroup(child.id);
            }
        };

        const addItemIdPeers = (mesh, instanceId) => {
            if (mesh.isBatchedMesh && mesh.userData.itemIds) {
                const itemId = mesh.userData.itemIds.get(instanceId);
                if (itemId !== undefined) {
                    // Scan logic: we must find all parts of this item
                    loadedObjectGroup.traverse(obj => {
                        if (obj.isBatchedMesh && obj.userData.itemIds) {
                            // iterate all to find match
                            for (const [id, tId] of obj.userData.itemIds) {
                                if (tId === itemId) addInstance(obj, id);
                            }
                        }
                    });
                }
            }
        }

        if (isSrcEffectiveSelected) {
            // Move entire selection
            if (currentSelection.groups) {
                for (const gid of currentSelection.groups) addGroup(gid);
            }
            if (currentSelection.objects) {
                for (const [mesh, ids] of currentSelection.objects) {
                    for (const id of ids) {
                        addInstance(mesh, id);
                        addItemIdPeers(mesh, id); // Ensure composite parts come along
                    }
                }
            }
        } else {
            // Move only the picked logical entity
            if (src.type === 'group') {
                // Move the specific group clicked
                addGroup(src.id);
            } else {
                const { mesh, instanceId } = src;
                // Check if it belongs to a group
                const objectToGroup = GroupUtils.getObjectToGroup(loadedObjectGroup);
                const key = GroupUtils.getGroupKey(mesh, instanceId);
                const groupId = objectToGroup ? objectToGroup.get(key) : null;
                
                if (groupId) {
                    // It's in a group -> Move that specific group
                    addGroup(groupId);
                } else {
                    // Loose object -> Move it + peers
                    addInstance(mesh, instanceId);
                    addItemIdPeers(mesh, instanceId);
                }
            }
        }

        // 3. Execute Moves
        
        // A. Update Instances (Visuals)
        for (const [mesh, ids] of targets.instances) {
            const meshWorldInv = _TMP_MAT4_B.copy(mesh.matrixWorld).invert();
            const localDelta = new THREE.Matrix4().multiplyMatrices(meshWorldInv, tMat);
            localDelta.multiply(mesh.matrixWorld);

            for (const id of ids) {
                mesh.getMatrixAt(id, _TMP_INSTANCE_MATRIX);
                _TMP_INSTANCE_MATRIX.premultiply(localDelta);
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
                group.matrix.premultiply(tMat);
                if (!group.position) group.position = new THREE.Vector3();
                if (!group.quaternion) group.quaternion = new THREE.Quaternion();
                if (!group.scale) group.scale = new THREE.Vector3(1, 1, 1);
                group.matrix.decompose(group.position, group.quaternion, group.scale);
            }
        }
        
        selectedVertexKeys.clear();
        updateHelperPosition();
        updateSelectionOverlay();
    } // End Case 2

    return true;
}