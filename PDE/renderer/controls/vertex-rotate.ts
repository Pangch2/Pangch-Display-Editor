import {
    Matrix4,
    Vector3,
    Quaternion,
    InstancedMesh,
    BatchedMesh,
    Mesh,
    Object3D,
    Group,
    Sprite,
    Box3
} from 'three/webgpu';
import * as GroupUtils from './group';
import * as Overlay from './overlay';
import { performSelectionSwap, SelectionSource, QueueItem, QueueBundle } from './vertex-swap';
import type { GroupData } from './group';
import type { GizmoState } from './gizmo';

const _TMP_MAT4_A = new Matrix4();
const _TMP_MAT4_B = new Matrix4();
const _TMP_INSTANCE_MATRIX = new Matrix4();
const _TMP_VEC3_A = new Vector3();
const _TMP_VEC3_B = new Vector3();
const _TMP_QUAT = new Quaternion();

type MeshType = InstancedMesh | BatchedMesh | Mesh;

interface VertexRotateContext {
    isVertexMode: boolean;
    gizmoMode: string;
    currentSelection: {
        groups: Set<string>;
        objects: Map<Object3D, Set<number>>;
        primary: SelectionSource | null;
    };
    loadedObjectGroup: Group;
    selectionHelper: Mesh;

    getGizmoState: () => GizmoState;
    setGizmoState: (updates: Partial<GizmoState>) => void;
    setMultiAnchorInitial: (worldPos: Vector3) => void;

    getGroups: () => Map<string, GroupData>;
    getGroupWorldMatrixWithFallback: (id: string, target: Matrix4) => Matrix4;
    updateHelperPosition: () => void;
    updateSelectionOverlay: () => void;
    SelectionCenter: (mode: string, useOffset: boolean, target: Vector3) => Vector3;
    vertexQueue: QueueItem[];
}

export function processVertexRotate(
    selectedVertexKeys: Set<string>,
    {
        isVertexMode,
        gizmoMode,
        currentSelection,
        loadedObjectGroup,
        selectionHelper: _selectionHelper,
        
        // State Interface
        getGizmoState,
        setGizmoState,
        setMultiAnchorInitial,
        
        // Methods
        getGroups,
        getGroupWorldMatrixWithFallback,
        updateHelperPosition,
        updateSelectionOverlay,
        SelectionCenter,
        vertexQueue
    }: VertexRotateContext
): boolean {
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
    
    let sprite1: Sprite | null = null;
    let sprite2: Sprite | null = null;
    
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
        const src: SelectionSource = sprite1.userData.source;
        let objectWorldMatrix = new Matrix4();
        let localBox: Box3 | null = null;

        // 1. Resolve effective World Matrix and Local Bounding Box (similar to vertex-scale)
        if (src.type === 'object') {
            const { mesh, instanceId } = src;
            if ((mesh as BatchedMesh).isBatchedMesh || (mesh as InstancedMesh).isInstancedMesh) {
                (mesh as InstancedMesh).getMatrixAt(instanceId, objectWorldMatrix);
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
        const center = new Vector3().addVectors(min, max).multiplyScalar(0.5);
        const eps = 1e-4;

        const fixedLocal = new Vector3();
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
        const tInvMat = new Matrix4().makeTranslation(-pivot.x, -pivot.y, -pivot.z);

        // Combine: M = T * R * T_inv
        const transformMat = tMat.multiply(rMat).multiply(tInvMat);

        // 1. Identify effective selection (same as vertex-translate)
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

            // Update Gizmo State anchors
            const state = getGizmoState();
            const updates: Partial<GizmoState> = {};
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
            const localTransform = new Matrix4().multiplyMatrices(meshWorldInv, transformMat);
            localTransform.multiply(mesh.matrixWorld);

            for (const id of ids) {
                (mesh as InstancedMesh).getMatrixAt(id, _TMP_INSTANCE_MATRIX);
                _TMP_INSTANCE_MATRIX.premultiply(localTransform);
                (mesh as InstancedMesh).setMatrixAt(id, _TMP_INSTANCE_MATRIX);
            }
            if ((mesh as InstancedMesh).isInstancedMesh) (mesh as InstancedMesh).instanceMatrix.needsUpdate = true;
        }

        // B. Update Group Metadata (Logic)
        for (const groupId of targets.groups) {
            const groups = getGroups();
            const group = groups.get(groupId);
            if (group) {
                if (!group.matrix) {
                    const gPos = group.position || new Vector3();
                    const gQuat = group.quaternion || new Quaternion();
                    const gScale = group.scale || new Vector3(1, 1, 1);
                    group.matrix = new Matrix4().compose(gPos, gQuat, gScale);
                }
                group.matrix.premultiply(transformMat);
                if (!group.position) group.position = new Vector3();
                if (!group.quaternion) group.quaternion = new Quaternion();
                if (!group.scale) group.scale = new Vector3(1, 1, 1);
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
            preserveSelection: preserveSelectionOnSnap || isSrcEffectiveSelected || !!containingBundle,
            targetAnchorWorld: p2.clone()
        });
        
        selectedVertexKeys.clear();
        updateHelperPosition();
        updateSelectionOverlay();
    } 

    return true;
}
