import * as THREE from 'three/webgpu';
import * as GroupUtils from './group';
import * as Overlay from './overlay';
import { performSelectionSwap, SelectionSource, QueueItem, QueueBundle, QueueEntry } from './vertex-swap';
import type { GroupData } from './group';
import type { GizmoState } from './gizmo';

const _TMP_MAT4_A = new THREE.Matrix4();
const _TMP_MAT4_B = new THREE.Matrix4();
const _TMP_INSTANCE_MATRIX = new THREE.Matrix4();
const _ZERO_VEC3 = new THREE.Vector3(0, 0, 0);

type MeshType = THREE.InstancedMesh | THREE.BatchedMesh | THREE.Mesh;

interface VertexTranslateContext {
    isVertexMode: boolean;
    gizmoMode: string;
    currentSelection: {
        groups: Set<string>;
        objects: Map<THREE.Object3D, Set<number>>;
        primary: SelectionSource | null;
    };
    loadedObjectGroup: THREE.Group;
    selectionHelper: THREE.Mesh;

    getGizmoState: () => GizmoState;
    setGizmoState: (updates: Partial<GizmoState>) => void;
    setMultiAnchorInitial: (worldPos: THREE.Vector3) => void;

    getGroups: () => Map<string, GroupData>;
    getGroupWorldMatrixWithFallback: (id: string, target: THREE.Matrix4) => THREE.Matrix4;
    getGroupWorldMatrix: (group: GroupData, out?: THREE.Matrix4) => THREE.Matrix4;
    updateHelperPosition: () => void;
    updateSelectionOverlay: () => void;
    _isMultiSelection: () => boolean;
    _getSingleSelectedGroupId: () => string | null;
    SelectionCenter: (mode: string, useOffset: boolean, target: THREE.Vector3) => THREE.Vector3;
    vertexQueue: QueueItem[];
}

export function processVertexSnap(
    selectedVertexKeys: Set<string>,
    {
        isVertexMode,
        gizmoMode,
        currentSelection,
        loadedObjectGroup,
        selectionHelper,

        // State Interface
        getGizmoState,
        setGizmoState,
        setMultiAnchorInitial,

        // Methods
        getGroups,
        getGroupWorldMatrixWithFallback,
        getGroupWorldMatrix: _getGroupWorldMatrix,
        updateHelperPosition,
        updateSelectionOverlay,
        _isMultiSelection,
        _getSingleSelectedGroupId: __getSingleSelectedGroupId,
        SelectionCenter,
        vertexQueue
    }: VertexTranslateContext
): boolean {
    if (!isVertexMode) return false;

    const groupCount = currentSelection.groups ? currentSelection.groups.size : 0;
    let objectIdCount = 0;
    if (currentSelection.objects && currentSelection.objects.size > 0) {
        for (const ids of currentSelection.objects.values()) {
            objectIdCount += ids.size;
        }
    }
    const activeSelectionCount = groupCount + objectIdCount;
    const preserveSelectionOnSnap = _isMultiSelection() || activeSelectionCount > 1;

    const keys = Array.from(selectedVertexKeys);
    if (keys.length !== 2) return false;

    const k1 = keys[0];
    const k2 = keys[1];

    let sprite1: THREE.Sprite | null = null;
    let sprite2: THREE.Sprite | null = null;

    const foundSprites = Overlay.findSpritesByKeys([k1, k2]);
    sprite1 = foundSprites[k1];
    sprite2 = foundSprites[k2];

    const state = getGizmoState();

    // Helper to update gizmoLocalPosition in vertexQueue
    const updateQueueItemPivot = (sourceItem: SelectionSource, newPivot: THREE.Vector3) => {
        if (!vertexQueue) return;
        const target = vertexQueue.find(item => {
            if (item.type !== sourceItem.type) return false;
            if (item.type === 'group') return (item as QueueEntry).id === (sourceItem as { type: 'group'; id: string }).id;
            return (item as QueueEntry).mesh === (sourceItem as { type: 'object'; mesh: MeshType; instanceId: number }).mesh
                && (item as QueueEntry).instanceId === (sourceItem as { type: 'object'; mesh: MeshType; instanceId: number }).instanceId;
        });
        if (target) {
            (target as QueueEntry).gizmoLocalPosition = newPivot;
        }
    };

    // CASE 1: First Clicked = Gizmo (Center)
    if (sprite1 && sprite2 && sprite1.userData.isCenter) {

        const isClonedGizmo = !!sprite1.userData.source;

        // 1-A. Cloned Gizmo (Has Source) -> Snap ONLY that object's pivot to Target (Vertex or Gizmo Center)
        if (isClonedGizmo && (sprite2.userData.source || sprite2.userData.isCenter)) {
            const targetPos = sprite2.position.clone();
            const src: SelectionSource = sprite1.userData.source;

            if (src.type === 'object' && src.mesh) {
                const { mesh, instanceId } = src;
                const instanceMatrix = _TMP_MAT4_A;

                if ((mesh as THREE.BatchedMesh).isBatchedMesh || (mesh as THREE.InstancedMesh).isInstancedMesh) {
                    (mesh as THREE.InstancedMesh).getMatrixAt(instanceId, instanceMatrix);
                } else {
                    instanceMatrix.copy(mesh.matrix);
                }
                const worldMatrix = instanceMatrix.premultiply(mesh.matrixWorld);
                const inv = worldMatrix.clone().invert();
                const localPivot = targetPos.clone().applyMatrix4(inv);

                if ((mesh as THREE.BatchedMesh).isBatchedMesh || (mesh as THREE.InstancedMesh).isInstancedMesh) {
                    if (!mesh.userData.customPivots) mesh.userData.customPivots = new Map<number, THREE.Vector3>();
                    mesh.userData.customPivots.set(instanceId, localPivot);
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

            let targetSrc: SelectionSource | null = sprite2.userData.source ?? null;
            if (!targetSrc && sprite2.userData.isCenter && currentSelection.primary) {
                targetSrc = currentSelection.primary;
            }
            performSelectionSwap(sprite1.userData.source, targetSrc, {
                currentSelection,
                getGroups,
                getGroupWorldMatrixWithFallback,
                setGizmoState,
                getGizmoState,
                setMultiAnchorInitial,
                updateHelperPosition,
                SelectionCenter,
                vertexQueue
            }, { preserveSelection: preserveSelectionOnSnap });

            if (state.pivotMode === 'center') {
                setGizmoState({ pivotMode: 'origin' });
            }

            selectedVertexKeys.clear();
            updateHelperPosition();
            updateSelectionOverlay();

        // 1-B. Main Gizmo (No Source) -> Snap Selection Pivot to Vertex (Original Logic)
        } else if (!isClonedGizmo && sprite2.userData.source) {
            const targetSprite = sprite2;
            const targetPos = targetSprite.position.clone();
            selectionHelper.position.copy(targetPos);

            setGizmoState({
                _gizmoAnchorPosition: targetPos,
                _gizmoAnchorValid: true
            });

            selectionHelper.updateMatrixWorld();

            const baseline = SelectionCenter('origin', true, _ZERO_VEC3);
            const newPivotOffset = new THREE.Vector3().subVectors(selectionHelper.position, baseline);

            setGizmoState({
                isCustomPivot: true,
                pivotOffset: newPivotOffset
            });

            if (state.pivotMode === 'center') {
                setGizmoState({ pivotMode: 'origin' });
                console.log("Switched to Pivot Mode: Origin (due to Custom Pivot snap)");
            }

            if (_isMultiSelection()) {
                setGizmoState({
                    _multiSelectionOriginAnchorPosition: selectionHelper.position,
                    _multiSelectionOriginAnchorValid: true
                });
                setMultiAnchorInitial(selectionHelper.position.clone());
            } else {
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

                if (currentSelection.objects && currentSelection.objects.size > 0) {
                    for (const [mesh, ids] of currentSelection.objects) {
                        if (!mesh || !ids) continue;

                        for (const id of ids) {
                            const instanceMatrix = _TMP_MAT4_A;
                            (mesh as MeshType).getMatrixAt(id, instanceMatrix);
                            const worldMatrix = instanceMatrix.premultiply(mesh.matrixWorld);
                            const inv = worldMatrix.clone().invert();
                            const localPivot = targetPos.clone().applyMatrix4(inv);

                            if ((mesh as THREE.BatchedMesh).isBatchedMesh || (mesh as THREE.InstancedMesh).isInstancedMesh) {
                                if (!mesh.userData.customPivots) mesh.userData.customPivots = new Map<number, THREE.Vector3>();
                                mesh.userData.customPivots.set(id, localPivot);
                            } else {
                                mesh.userData.customPivot = localPivot;
                            }
                            mesh.userData.isCustomPivot = true;
                            updateQueueItemPivot({ type: 'object', mesh: mesh as MeshType, instanceId: id }, localPivot);
                        }
                    }
                }
            }

            performSelectionSwap(null, sprite2.userData.source, {
                currentSelection,
                getGroups,
                getGroupWorldMatrixWithFallback,
                setGizmoState,
                getGizmoState,
                setMultiAnchorInitial,
                updateHelperPosition,
                SelectionCenter,
                vertexQueue
            }, { preserveSelection: preserveSelectionOnSnap });

            selectedVertexKeys.clear();
            updateHelperPosition();
            updateSelectionOverlay();
            console.log("Gizmo snapped to vertex (Custom Pivot set)");
        }

    // CASE 2: First Clicked = Object Vertex, Second Clicked = (Gizmo OR Object Vertex)
    // -> Move Object (Snap Object to Position)
    } else if (sprite1 && sprite2 && sprite1.userData.source && (sprite2.userData.isCenter || sprite2.userData.source)) {
        if (gizmoMode !== 'translate') return false;

        const p1 = sprite1.position;
        const p2 = sprite2.position;
        const delta = new THREE.Vector3().subVectors(p2, p1);

        const src: SelectionSource = sprite1.userData.source;
        const tMat = _TMP_MAT4_A.makeTranslation(delta.x, delta.y, delta.z);

        // 1. Identify effective selection
        const isSrcEffectiveSelected = (() => {
            if (src.type === 'group') return currentSelection.groups.has(src.id);
            if (src.type === 'object') {
                if (currentSelection.objects.has(src.mesh) && currentSelection.objects.get(src.mesh)!.has(src.instanceId)) return true;

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
            groups: new Set<string>(),
            instances: new Map<MeshType, Set<number>>(),
            isBundleMove: false
        };

        const addInstance = (mesh: MeshType, id: number) => {
            let set = targets.instances.get(mesh);
            if (!set) { set = new Set(); targets.instances.set(mesh, set); }
            set.add(id);
        };

        const addGroup = (groupId: string) => {
            targets.groups.add(groupId);
            const children = GroupUtils.getAllGroupChildren(loadedObjectGroup, groupId);
            for (const child of children) {
                if (child.type === 'object') addInstance(child.mesh, child.instanceId);
                else if (child.type === 'group') addGroup((child as unknown as GroupUtils.GroupChildGroup).id);
            }
        };

        const addBundle = (bundle: QueueBundle) => {
            if (!bundle || !bundle.items) return;
            targets.isBundleMove = true;
            for (const item of bundle.items) {
                if (item.type === 'group') addGroup(item.id!);
                else if (item.type === 'object') addInstance(item.mesh!, item.instanceId!);
            }
        };

        // Check if src is part of a bundle in the queue
        let containingBundle: QueueBundle | null = null;
        if (!isSrcEffectiveSelected) {
            for (const qItem of vertexQueue) {
                if (qItem.type === 'bundle' && (qItem as QueueBundle).items) {
                    const found = (qItem as QueueBundle).items.find(sub => {
                        if (src.type === 'group' && sub.type === 'group') return sub.id === src.id;
                        if (src.type === 'object' && sub.type === 'object') return sub.mesh === src.mesh && sub.instanceId === src.instanceId;
                        return false;
                    });
                    if (found) {
                        containingBundle = qItem as QueueBundle;
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
                        addInstance(mesh as MeshType, id);
                    }
                }
            }

            const state = getGizmoState();
            const updates: Partial<GizmoState> = {};
            let nextMultiAnchorWorld: THREE.Vector3 | null = null;
            if (state._gizmoAnchorValid && state._gizmoAnchorPosition) {
                updates._gizmoAnchorPosition = state._gizmoAnchorPosition.clone().add(delta);
            }
            if (state._multiSelectionOriginAnchorValid && state._multiSelectionOriginAnchorPosition) {
                nextMultiAnchorWorld = state._multiSelectionOriginAnchorPosition.clone().add(delta);
                updates._multiSelectionOriginAnchorPosition = nextMultiAnchorWorld;
            } else if (_isMultiSelection() && state._gizmoAnchorValid && state._gizmoAnchorPosition) {
                nextMultiAnchorWorld = state._gizmoAnchorPosition.clone().add(delta);
                updates._multiSelectionOriginAnchorPosition = nextMultiAnchorWorld;
                updates._multiSelectionOriginAnchorValid = true;
            }
            if (Object.keys(updates).length > 0) setGizmoState(updates);
            if (_isMultiSelection() && nextMultiAnchorWorld) {
                setMultiAnchorInitial(nextMultiAnchorWorld.clone());
            }

        } else if (containingBundle) {
            addBundle(containingBundle);
        } else {
            if (src.type === 'group') {
                addGroup(src.id);
            } else if (src.type === 'object') {
                const { mesh, instanceId } = src;
                addInstance(mesh, instanceId);
            }
        }

        // 3. Execute Moves

        // A. Update Instances (Visuals)
        for (const [mesh, ids] of targets.instances) {
            const meshWorldInv = _TMP_MAT4_B.copy(mesh.matrixWorld).invert();
            const localDelta = new THREE.Matrix4().multiplyMatrices(meshWorldInv, tMat);
            localDelta.multiply(mesh.matrixWorld);

            for (const id of ids) {
                (mesh as THREE.InstancedMesh).getMatrixAt(id, _TMP_INSTANCE_MATRIX);
                _TMP_INSTANCE_MATRIX.premultiply(localDelta);
                (mesh as THREE.InstancedMesh).setMatrixAt(id, _TMP_INSTANCE_MATRIX);
            }
            if ((mesh as THREE.InstancedMesh).isInstancedMesh) (mesh as THREE.InstancedMesh).instanceMatrix.needsUpdate = true;
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

        // Swapping selection state
        let targetSrc: SelectionSource | null = sprite2.userData.source ?? null;
        if (!targetSrc && sprite2.userData.isCenter && currentSelection.primary) {
            targetSrc = currentSelection.primary;
        }

        performSelectionSwap(src, targetSrc, {
            currentSelection,
            getGroups,
            getGroupWorldMatrixWithFallback,
            setGizmoState,
            getGizmoState,
            setMultiAnchorInitial,
            updateHelperPosition,
            SelectionCenter,
            vertexQueue
        }, {
            preserveSelection: preserveSelectionOnSnap || isSrcEffectiveSelected || !!containingBundle
        });

        selectedVertexKeys.clear();
        updateHelperPosition();
        updateSelectionOverlay();
    }

    return true;
}
