import {
    Matrix4,
    Vector3,
    Quaternion,
    InstancedMesh,
    Mesh,
    Object3D,
    Group,
    Sprite
} from 'three/webgpu';
import * as GroupUtils from '../grouping/group';
import * as Overlay from '../selection/overlay';
import { performSelectionSwap, SelectionSource, QueueItem, QueueBundle } from './vertex-swap';
import type { GroupData } from '../grouping/group';
import type { GizmoState } from '../gizmo/gizmo';

const _TMP_MAT4_A = new Matrix4();
const _TMP_INSTANCE_MATRIX = new Matrix4();
const _TMP_VEC3_A = new Vector3();
const _TMP_VEC3_B = new Vector3();
const _TMP_VEC3_C = new Vector3();
const _TMP_VEC3_D = new Vector3();
const _TMP_QUAT_B = new Quaternion();
const _TMP_QUAT_C = new Quaternion();

type MeshType = InstancedMesh | Mesh;

function computeBlockbenchLocalRotation(
    objectWorldMatrix: Matrix4,
    pivotWorld: Vector3,
    startWorld: Vector3,
    targetWorld: Vector3,
    out: Quaternion
): Quaternion | null {
    objectWorldMatrix.decompose(_TMP_VEC3_C, _TMP_QUAT_B, _TMP_VEC3_D);
    _TMP_QUAT_B.invert();

    // Blockbench cube dimensions live in geometry, while PDE stores them in the
    // instance scale. Exclude scale here so both editors compare pivot-relative
    // directions in the same units.
    const localStart = _TMP_VEC3_A.copy(startWorld).sub(pivotWorld).applyQuaternion(_TMP_QUAT_B);
    const localTarget = _TMP_VEC3_B.copy(targetWorld).sub(pivotWorld).applyQuaternion(_TMP_QUAT_B);
    const targetDistanceSq = localTarget.lengthSq();
    if (targetDistanceSq < 1e-9) return null;

    let longestAxis: 'x' | 'y' | 'z' = 'x';
    if (localStart.y > localStart.x) longestAxis = 'y';
    if (localStart.z > localStart.y) longestAxis = 'z';

    const offAxes = (['x', 'y', 'z'] as const).filter(axis => axis !== longestAxis);
    const adjustedAxisSq = targetDistanceSq
        - localStart[offAxes[0]] * localStart[offAxes[0]]
        - localStart[offAxes[1]] * localStart[offAxes[1]];
    if (adjustedAxisSq < 1e-9) return null;

    localStart[longestAxis] = Math.sqrt(adjustedAxisSq);
    if (localStart.lengthSq() < 1e-9) return null;

    localStart.normalize();
    localTarget.normalize();

    return out.setFromUnitVectors(localStart, localTarget);
}

function computeWorldRotationDelta(
    objectWorldMatrix: Matrix4,
    pivotWorld: Vector3,
    localRotation: Quaternion,
    out: Matrix4
): Matrix4 {
    objectWorldMatrix.decompose(_TMP_VEC3_C, _TMP_QUAT_B, _TMP_VEC3_D);
    _TMP_QUAT_C.copy(_TMP_QUAT_B).multiply(localRotation).multiply(_TMP_QUAT_B.invert());
    return out.makeTranslation(pivotWorld.x, pivotWorld.y, pivotWorld.z)
        .multiply(_TMP_MAT4_A.makeRotationFromQuaternion(_TMP_QUAT_C))
        .multiply(new Matrix4().makeTranslation(-pivotWorld.x, -pivotWorld.y, -pivotWorld.z));
}

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
    recomputePivotStateForSelection: () => void;
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
        recomputePivotStateForSelection,
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
    // -> Rotate the targets together around the active pivot like Blockbench vertex snap rotate.
    if (sprite1 && sprite2 && sprite1.userData.source && (sprite2.userData.isCenter || sprite2.userData.source)) {
        const src: SelectionSource = sprite1.userData.source;
        const p1 = sprite1.position;
        const p2 = sprite2.position;

        const sourceWorldMatrix = new Matrix4();
        if (src.type === 'object') {
            (src.mesh as InstancedMesh).getMatrixAt(src.instanceId, sourceWorldMatrix);
            sourceWorldMatrix.premultiply(src.mesh.matrixWorld);
        } else {
            getGroupWorldMatrixWithFallback(src.id, sourceWorldMatrix);
        }

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

        const state = getGizmoState();
        let transformedMultiAnchorWorld: Vector3 | null = null;
        sourceWorldMatrix.decompose(_TMP_VEC3_C, _TMP_QUAT_B, _TMP_VEC3_D);
        const sourceGroup = src.type === 'group' ? getGroups().get(src.id) : null;
        const customPivot = src.type === 'object'
            ? src.mesh.userData.customPivots?.get(src.instanceId)
            : sourceGroup?.isCustomPivot ? GroupUtils.normalizePivotToVector3(sourceGroup.pivot) : null;
        const pivotWorld = customPivot
            ? src.type === 'group' ? customPivot : customPivot.clone().applyMatrix4(sourceWorldMatrix)
            : isSrcEffectiveSelected && state._gizmoAnchorValid
                ? state._gizmoAnchorPosition
                : _TMP_VEC3_C;
        const sourceLocalRotation = computeBlockbenchLocalRotation(sourceWorldMatrix, pivotWorld, p1, p2, new Quaternion());
        if (!sourceLocalRotation) {
            selectedVertexKeys.clear();
            updateSelectionOverlay();
            return false;
        }
        const sourceTransformMat = computeWorldRotationDelta(sourceWorldMatrix, pivotWorld, sourceLocalRotation, new Matrix4());

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
            const updates: Partial<GizmoState> = {};
            if (state._gizmoAnchorValid && state._gizmoAnchorPosition) {
                updates._gizmoAnchorPosition = state._gizmoAnchorPosition.clone().applyMatrix4(sourceTransformMat);
            }
            if (state._multiSelectionOriginAnchorValid && state._multiSelectionOriginAnchorPosition) {
                transformedMultiAnchorWorld = state._multiSelectionOriginAnchorPosition.clone().applyMatrix4(sourceTransformMat);
                updates._multiSelectionOriginAnchorPosition = transformedMultiAnchorWorld;
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
            const localTransform = new Matrix4().copy(mesh.matrixWorld).invert()
                .multiply(sourceTransformMat)
                .multiply(mesh.matrixWorld);
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
                if (GroupUtils.shouldUseGroupPivot(group)) {
                    group.pivot = GroupUtils.normalizePivotToVector3(group.pivot)?.applyMatrix4(sourceTransformMat);
                }
                if (!group.matrix) {
                    const gPos = group.position || new Vector3();
                    const gQuat = group.quaternion || new Quaternion();
                    const gScale = group.scale || new Vector3(1, 1, 1);
                    group.matrix = new Matrix4().compose(gPos, gQuat, gScale);
                }
                if (!group.position) group.position = new Vector3();
                if (!group.quaternion) group.quaternion = new Quaternion();
                if (!group.scale) group.scale = new Vector3(1, 1, 1);
                group.matrix.premultiply(sourceTransformMat);
                group.matrix.decompose(group.position, group.quaternion, group.scale);
            }
        }

        if (transformedMultiAnchorWorld) {
            setMultiAnchorInitial(transformedMultiAnchorWorld);
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
        recomputePivotStateForSelection();
        updateHelperPosition();
        updateSelectionOverlay();
    } 

    return true;
}
