import { setupGizmo } from './gizmo-setup';
import type { GizmoLines, GizmoMaterial, GizmoPlaneDirection, GizmoPlaneName, GizmoPlanes } from './gizmo-setup';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import {
    InstancedMesh,
    Mesh,
    Vector3,
    Scene,
    Camera,
    Renderer,
    Group,
    Object3D,
    Matrix4,
    Quaternion,
    Box3,
    Vector2,
    Raycaster,
    BoxGeometry,
    MeshBasicMaterial,
    InstancedBufferAttribute
} from 'three/webgpu';
import { dragDeltaMatrix, dragSelectedAttributeName } from '../../entity-material';
import {
    blockbenchScaleMode,
    computeBlockbenchPivotFrame,
    transformBoxToPivotFrame,
    detectBlockbenchScaleAxes,
    computeBlockbenchScaleShift
} from './blockbench-scale';
import * as GroupUtils from '../grouping/group';
import { knifeSelection } from '../grouping/knife';
import * as Overlay from '../selection/overlay';
import * as CustomPivot from '../pivot/custom-pivot';
import { initDrag, applyDeltaToSelection } from '../selection/drag';
import { mergeInstanceIds } from '../selection/instance-ranges';
import { initHandleKey, type HandleKeyState } from '../input/handle-key';
import { captureSceneState, recordSceneChange, restoreSceneState, setHistoryGizmoState, setHistorySelection, type SceneSnapshot } from '../undo-redo/scene-history';
import type { DragInterface } from '../selection/drag';
import type { InstanceIdRange } from '../selection/instance-ranges';
import { processVertexSnap } from '../vertex/vertex-translate';
import { processVertexRotate } from '../vertex/vertex-rotate';
import { processVertexScale } from '../vertex/vertex-scale';
import * as Select from '../selection/select';
import type { SelectionState } from '../selection/select';
import type { GroupData } from '../grouping/group';
import type { QueueItem } from '../vertex/vertex-swap';
import * as VertexQueue from '../vertex/vertex-queue';
import { flipObjectUuids, reflectGroups, type FlipAxis } from '../transform/flip';
import {
    applyLinkedMirrorDelta,
    getLinkedMirrorSelection,
    getMirrorPairs,
    isMirrorModelingEnabled,
    linkMirrorPair,
    mirrorModelingPivot,
    setMirrorModeling,
    syncLinkedMirrorGroupPivot
} from '../transform/mirroring';
import {
    createGroupCommand,
    deleteSelectedItemsCommand,
    duplicateSelectedCommand,
    ungroupGroupsCommand,
    type DuplicateCommandCallbacks
} from './gizmo-commands';
import {
    beginSmartScaleDrag,
    endSmartScaleDrag,
    getSmartScaleVisualPivot,
    isSmartScaleEnabled,
    normalizeSmartScaleDrag,
    resetSmartScaleSession,
    toggleSmartScale,
    updateSmartScaleDuringDrag
} from './smart-scale';

// Interfaces 

type PdeMesh = InstancedMesh | Mesh;

interface SceneUpdatedDetail {
    skipGizmoRefresh?: boolean;
    pivotChanged?: boolean;
}

export interface OrbitControlsLike {
    enabled: boolean;
    target: Vector3;
    screenSpacePanning: boolean;
    dispose(): void;
    update(): boolean;
}

export interface GizmoState {
    pivotMode: string;
    isCustomPivot: boolean;
    pivotOffset: Vector3;
    _gizmoAnchorValid: boolean;
    _gizmoAnchorPosition: Vector3;
    _multiSelectionOriginAnchorValid: boolean;
    _multiSelectionOriginAnchorPosition: Vector3;
    _multiSelectionOriginAnchorInitialValid: boolean;
    _multiSelectionOriginAnchorInitialPosition: Vector3;
    selectionAnchorMode?: 'default' | 'center';
    _multiSelectionExplicitPivot?: boolean;
}

export interface InitGizmoParams {
    scene: Scene;
    camera: Camera;
    renderer: Renderer;
    controls: OrbitControlsLike;
    loadedObjectGroup: Group;
    setControls?: (c: OrbitControlsLike) => void;
}

export interface InitGizmoResult {
    getTransformControls: () => TransformControls;
    updateGizmo: () => void;
    resetSelection: () => void;
    getSelectedObject: () => Object3D | null;
    createGroup: () => string | undefined;
    getGroups: () => Map<string, GroupData>;
    setCamera: (nextCamera: Camera) => void;
    hasSelection: () => boolean;
    flipSelected: (axis: FlipAxis) => Promise<void>;
    setMirrorModeling: (enabled: boolean) => void;
}

//  Aliases 
const getSelectionBoundingBox = () => Overlay.getSelectionBoundingBox(currentSelection);

//  Shared temporaries 

const _TMP_MAT4_A = new Matrix4();
const _TMP_MAT4_B = new Matrix4();
const _TMP_VEC3_A = new Vector3();
const _TMP_VEC3_B = new Vector3();
const _TMP_QUAT_A = new Quaternion();

//  Selection state 

function _beginSelectionReplace(options?: { anchorMode?: string; detachTransform?: boolean; preserveAnchors?: boolean }): void {
    Select.beginSelectionReplace({
        revertEphemeralPivotUndoIfAny: _revertEphemeralPivotUndoIfAny,
        detachTransformControls: () => { if (transformControls) transformControls.detach(); },
        pushToVertexQueue: _pushToVertexQueue,
        clearGizmoAnchor: _clearGizmoAnchor,
        setSelectionAnchorMode: (mode: 'default' | 'center') => { _selectionAnchorMode = mode; },
        resetPivotState: () => {
            pivotOffset.set(0, 0, 0);
            isCustomPivot = false;
            currentSelection.primary = null;
        }
    }, options);
}


//  Group helpers 

function getGroups(): Map<string, GroupData> {
    return GroupUtils.getGroups(loadedObjectGroup);
}

function getObjectToGroup(): Map<string, string> {
    return GroupUtils.getObjectToGroup(loadedObjectGroup);
}

function getGroupKey(mesh: Object3D, instanceId: number): string {
    return GroupUtils.getGroupKey(mesh, instanceId);
}

function getGroupChain(startGroupId: string): string[] {
    return GroupUtils.getGroupChain(loadedObjectGroup, startGroupId);
}

//  Group pivot helpers 

const _DEFAULT_GROUP_PIVOT = GroupUtils.DEFAULT_GROUP_PIVOT;
const _ZERO_VEC3 = new Vector3(0, 0, 0);

function normalizePivotToVector3(pivot: Vector3 | undefined, out = new Vector3()): Vector3 | null {
    return GroupUtils.normalizePivotToVector3(pivot, out);
}

function getGroupWorldMatrix(group: GroupData, out = new Matrix4()): Matrix4 {
    return GroupUtils.getGroupWorldMatrix(group, out);
}

function shouldUseGroupPivot(group: GroupData): boolean {
    return GroupUtils.shouldUseGroupPivot(group);
}

//  Selection caches 

const _isMultiSelection = Select.isMultiSelection;

function _revertEphemeralPivotUndoIfAny(): void {
    CustomPivot.revertEphemeralPivotUndoIfAny();
}

const _hasAnySelection = Select.hasAnySelection;
const _getSingleSelectedGroupId = Select.getSingleSelectedGroupId;
const _setPrimaryToFirstAvailable = Select.setPrimaryToFirstAvailable;

function _clearSelectionState(): void {
    Select.clearSelectionState({
        pushToVertexQueue: _pushToVertexQueue
    });
}

function _recomputePivotStateForSelection(): void {
    isCustomPivot = CustomPivot.recomputePivotStateForSelection(
        pivotMode,
        _isMultiSelection(),
        isCustomPivot,
        pivotOffset,
        currentSelection,
        loadedObjectGroup,
        {
            getSingleSelectedGroupId: Select.getSingleSelectedGroupId,
            getSingleSelectedMeshEntry: Select.getSingleSelectedMeshEntry
        }
    );
}

const invalidateSelectionCaches = Select.invalidateSelectionCaches;
const getSelectedItems = Select.getSelectedItems;

//  Module-level scene references 

let scene: Scene;
let camera: Camera;
let renderer: Renderer;
let controls: OrbitControlsLike;
let loadedObjectGroup: Group;
let transformControls: TransformControls | null = null;
let selectionHelper: Mesh | null = null;
let previousHelperMatrix = new Matrix4();
let positionDragValue: number | null = null;
let scaleDragValue: number | null = null;

function applyGizmoDragValues(): void {
    const value = (key: string): number | null => {
        const stored = Number(localStorage.getItem(key) ?? '0.0001');
        return Number.isFinite(stored) && stored > 0 ? stored : null;
    };
    const rotation = value('pdeRotationDragValue');
    positionDragValue = value('pdePositionDragValue');
    scaleDragValue = value('pdeScaleDragValue');
    transformControls?.setTranslationSnap(null);
    transformControls?.setRotationSnap(rotation === null ? null : rotation * Math.PI / 180);
    transformControls?.setScaleSnap(null);
}

window.addEventListener('pde:gizmo-drag-values-changed', applyGizmoDragValues);

//  Selection state 

const currentSelection: SelectionState = Select.currentSelection;
const selectedVertexKeys = new Set<string>();
const vertexQueue: QueueItem[] = [];
let suppressVertexQueue = false;

function _pushToVertexQueue(): void {
    VertexQueue.pushToVertexQueue({
        suppressVertexQueue,
        isVertexMode,
        selectionAnchorMode: _selectionAnchorMode,
        isCustomPivot,
        pivotOffset,
        multiSelectionExplicitPivot: _multiSelectionExplicitPivot,
        multiSelectionOriginAnchorValid: _multiSelectionOriginAnchorValid,
        multiSelectionOriginAnchorPosition: _multiSelectionOriginAnchorPosition,
        currentSelection,
        selectedVertexKeys,
        vertexQueue,
        selectionHelper,
        getSelectionCenterWorld: _getSelectionCenterWorld,
        getSelectionOriginWorld: (out = new Vector3()) => {
            const origin = SelectionCenter('origin', false, _ZERO_VEC3);
            return out.copy(origin);
        }
    });
}

//  Pivot / anchor state 

let pivotMode = 'origin';
let currentSpace: 'world' | 'local' = 'world';
let lastDirections: Record<string, string | null> = { X: null, Y: null, Z: null, XY: null, YZ: null, XZ: null };

const _gizmoAnchorPosition = new Vector3();
let _gizmoAnchorValid = false;

const _multiSelectionOriginAnchorPosition = new Vector3();
let _multiSelectionOriginAnchorValid = false;

const _multiSelectionOriginAnchorInitialPosition = new Vector3();
let _multiSelectionOriginAnchorInitialValid = false;
const _multiSelectionOriginAnchorInitialLocal = new Vector3();
let _multiSelectionOriginAnchorInitialLocalValid = false;

let _multiSelectionExplicitPivot = false;
const _multiSelectionAccumulatedRotation = new Quaternion();
let _selectionAnchorMode: 'default' | 'center' = 'default';

function _clearGizmoAnchor(): void {
    _gizmoAnchorValid = false;
    _gizmoAnchorPosition.set(0, 0, 0);

    _multiSelectionOriginAnchorValid = false;
    _multiSelectionOriginAnchorPosition.set(0, 0, 0);

    _multiSelectionOriginAnchorInitialValid = false;
    _multiSelectionOriginAnchorInitialPosition.set(0, 0, 0);
    _multiSelectionOriginAnchorInitialLocalValid = false;
    _multiSelectionOriginAnchorInitialLocal.set(0, 0, 0);

    _multiSelectionExplicitPivot = false;
    _multiSelectionAccumulatedRotation.set(0, 0, 0, 1);
}

function _getPrimaryWorldMatrix(out = new Matrix4()): Matrix4 | null {
    if (!currentSelection.primary) return null;
    const prim = currentSelection.primary;
    if (prim.type === 'group') {
        const groups = getGroups();
        const group = groups.get(prim.id);
        if (!group) return null;
        getGroupWorldMatrix(group, out);
    } else if (prim.type === 'object' && prim.mesh) {
        (prim.mesh as InstancedMesh).getMatrixAt(prim.instanceId, out);
        out.premultiply(prim.mesh.matrixWorld);
    } else return null;
    if (_dragPreviewActive) out.premultiply(dragDeltaMatrix);
    return out;
}

function _getMultiSelectionPivotLocal(): Vector3 | undefined {
    if (!_isMultiSelection()) return undefined;
    const primaryWorld = _getPrimaryWorldMatrix(_TMP_MAT4_B);
    if (primaryWorld && selectionHelper) {
        return selectionHelper.position.clone().applyMatrix4(primaryWorld.invert());
    }
    return _multiSelectionOriginAnchorInitialLocalValid
        ? _multiSelectionOriginAnchorInitialLocal.clone()
        : new Vector3();
}

function _setMultiAnchorInitial(worldPos: Vector3): void {
    _multiSelectionOriginAnchorInitialPosition.copy(worldPos);
    _multiSelectionOriginAnchorInitialValid = true;
    const mat = _getPrimaryWorldMatrix(_TMP_MAT4_B);
    if (mat) {
        _multiSelectionOriginAnchorInitialLocal.copy(worldPos).applyMatrix4(_TMP_MAT4_B.clone().invert());
        _multiSelectionOriginAnchorInitialLocalValid = true;
    } else {
        _multiSelectionOriginAnchorInitialLocalValid = false;
    }
}

function _captureMultiAnchorInitialIfNeeded(worldPos: Vector3): void {
    if (_multiSelectionOriginAnchorInitialValid) return;
    _setMultiAnchorInitial(worldPos);
}

function _resolveMultiAnchorInitialWorld(out = new Vector3()): Vector3 | null {
    if (_multiSelectionOriginAnchorInitialLocalValid) {
        const mat = _getPrimaryWorldMatrix(_TMP_MAT4_B);
        if (mat) {
            out.copy(_multiSelectionOriginAnchorInitialLocal).applyMatrix4(mat);
            return out;
        }
    }
    return null;
}

function _getSelectionCenterWorld(out = new Vector3()): Vector3 {
    const box = getSelectionBoundingBox();
    if (box && !box.isEmpty()) {
        return box.getCenter(out);
    }
    return out.copy(Select.calculateAvgOrigin());
}

function getSelectionCallbacks(): Select.SelectionCallbacks {
    return {
        revertEphemeralPivotUndoIfAny: () => _revertEphemeralPivotUndoIfAny(),
        detachTransformControls: () => transformControls!.detach(),
        clearGizmoAnchor: () => _clearGizmoAnchor(),
        setSelectionAnchorMode: (mode: 'default' | 'center') => { _selectionAnchorMode = mode; },
        resetPivotState: () => {
            pivotOffset.set(0, 0, 0);
            isCustomPivot = false;
        },
        recomputePivotState: () => _recomputePivotStateForSelection(),
        updateHelperPosition: () => updateHelperPosition(),
        updateSelectionOverlay: () => updateSelectionOverlay(),
        pushToVertexQueue: () => {
            vertexQueue.length = 0;
            selectedVertexKeys.clear();
        },
        hasVertexQueue: () => vertexQueue.length > 0
    };
}

function _replaceSelectionWithObjectsMap(meshToIds: Map<PdeMesh, Set<number>>, options?: { anchorMode?: string }): void {
    Select.replaceSelectionWithObjectsMap(meshToIds, getSelectionCallbacks(), options);
}

function _replaceSelectionWithGroupsAndObjects(
    groupIds: Set<string>,
    meshToIds: Map<PdeMesh, Set<number>>,
    options?: {
        anchorMode?: string;
        preserveAnchors?: boolean;
        primaryIsRangeStart?: boolean;
        explicitPrimary?: Select.PrimarySelection | null;
    }
): void {
    Select.replaceSelectionWithGroupsAndObjects(groupIds, meshToIds, getSelectionCallbacks(), options);
}

function _selectAllObjectsVisibleInScene(): Map<PdeMesh, Set<number>> {
    return Select.selectAllObjectsVisibleInScene(loadedObjectGroup);
}

//  Drag state 

let gizmoLines: GizmoLines = {
    X: { original: [], negative: [] },
    Y: { original: [], negative: [] },
    Z: { original: [], negative: [] }
};
let gizmoPlanes: GizmoPlanes = {
    XY: { variants: { '++': [], '+-': [], '-+': [], '--': [] } },
    YZ: { variants: { '++': [], '+-': [], '-+': [], '--': [] } },
    XZ: { variants: { '++': [], '+-': [], '-+': [], '--': [] } }
};

const dragInitialMatrix = new Matrix4();
const dragInitialQuaternion = new Quaternion();
const dragInitialScale = new Vector3();
const dragInitialPosition = new Vector3();
const dragInitialBoundingBox = new Box3();
const dragStartPivotBaseWorld = new Vector3();
let draggingMode: string | null = null;
let isGizmoBusy = false;
let dragAnchorDirections: { x: boolean; y: boolean; z: boolean } = { x: true, y: true, z: true };
let previousGizmoMode = 'translate';
let isPivotEditMode = false;
let isVertexMode = false;
let isUniformScale = false;
let isCustomPivot = false;
let pivotOffset = new Vector3(0, 0, 0);

const _tmpPrevInvMatrix = new Matrix4();
const _tmpDeltaMatrix = new Matrix4();
const _dragTotalDeltaMatrix = new Matrix4();
const _identityMatrix = new Matrix4();
const _pendingHelperMatrix = new Matrix4();
const _meshToInstanceRanges = new Map<Object3D, InstanceIdRange[]>();
let selectionTransformDirty = false;
let dragHistoryBefore: SceneSnapshot | null = null;
let _dragPreviewActive = false;
let _dragSelectedIdsByMesh = new Map<InstancedMesh, Set<number>>();

function snapFromStart(current: number, start: number, step: number): number {
    return start + Math.round((current - start) / step) * step;
}

function applyRelativeDragSnap(): void {
    if (!selectionHelper || !transformControls) return;
    if (transformControls.mode === 'translate' && positionDragValue !== null) {
        const delta = _TMP_VEC3_A.copy(selectionHelper.position).sub(dragInitialPosition);
        if (currentSpace === 'local') delta.applyQuaternion(_TMP_QUAT_A.copy(dragInitialQuaternion).invert());
        delta.set(
            Math.round(delta.x / positionDragValue) * positionDragValue,
            Math.round(delta.y / positionDragValue) * positionDragValue,
            Math.round(delta.z / positionDragValue) * positionDragValue
        );
        if (currentSpace === 'local') delta.applyQuaternion(dragInitialQuaternion);
        selectionHelper.position.copy(dragInitialPosition).add(delta);
    } else if (transformControls.mode === 'scale' && scaleDragValue !== null) {
        selectionHelper.scale.set(
            snapFromStart(selectionHelper.scale.x, dragInitialScale.x, scaleDragValue) || scaleDragValue,
            snapFromStart(selectionHelper.scale.y, dragInitialScale.y, scaleDragValue) || scaleDragValue,
            snapFromStart(selectionHelper.scale.z, dragInitialScale.z, scaleDragValue) || scaleDragValue
        );
    }
}

if (import.meta.env.DEV) {
    console.assert(Math.abs(snapFromStart(0.63, 0.37, 0.5) - 0.87) < 1e-9, 'Relative gizmo snapping moved the drag start value.');
}
function getItemUuid({ mesh, instanceId }: Select.SelectedItem): string | undefined {
    return (loadedObjectGroup.userData.instanceKeyToObjectUuid as Map<string, string> | undefined)
        ?.get(GroupUtils.getGroupKey(mesh, instanceId));
}

function getDirectSelectedItems(): Select.SelectedItem[] {
    return Array.from(currentSelection.objects, ([mesh, ids]) =>
        [...ids].map(instanceId => ({ type: 'object' as const, mesh, instanceId }))
    ).flat();
}

//  Selection helpers 

function getGroupRotationQuaternion(groupId: string | null, out = new Quaternion()): Quaternion {
    if (!groupId) return out.set(0, 0, 0, 1);
    const m = Overlay.getGroupWorldMatrixWithFallback(groupId, _TMP_MAT4_A);
    const q = Overlay.getRotationFromMatrix(m);
    return out.copy(q);
}

function SelectionCenter(pivotMode: string, isCustomPivot: boolean, pivotOffset: Vector3): Vector3 {
    return CustomPivot.SelectionCenter(
        pivotMode,
        isCustomPivot,
        pivotOffset,
        currentSelection,
        loadedObjectGroup,
        {
            getSelectedItems,
            getSelectionBoundingBox,
            getSingleSelectedGroupId: _getSingleSelectedGroupId,
            getSingleSelectedMeshEntry: Select.getSingleSelectedMeshEntry,
            calculateAvgOrigin: Select.calculateAvgOrigin
        }
    );
}

function syncDragSelectionMask(): void {
    const nextIdsByMesh = new Map<InstancedMesh, Set<number>>();
    for (const { mesh, instanceId } of getSelectedItems()) {
        if (!(mesh as InstancedMesh)?.isInstancedMesh) continue;
        const instancedMesh = mesh as InstancedMesh;
        let ids = nextIdsByMesh.get(instancedMesh);
        if (!ids) nextIdsByMesh.set(instancedMesh, ids = new Set<number>());
        ids.add(instanceId);
    }

    const meshes = new Set([..._dragSelectedIdsByMesh.keys(), ...nextIdsByMesh.keys()]);
    for (const mesh of meshes) {
        const previousIds = _dragSelectedIdsByMesh.get(mesh) ?? new Set<number>();
        const nextIds = nextIdsByMesh.get(mesh) ?? new Set<number>();
        if (previousIds.size === nextIds.size && [...previousIds].every(id => nextIds.has(id))) continue;

        const attribute = mesh.geometry.getAttribute(dragSelectedAttributeName) as InstancedBufferAttribute | undefined;
        if (!attribute) continue;
        for (const id of previousIds) if (!nextIds.has(id)) attribute.setX(id, 0);
        for (const id of nextIds) if (!previousIds.has(id)) attribute.setX(id, 1);
        attribute.needsUpdate = true;
    }
    _dragSelectedIdsByMesh = nextIdsByMesh;
}

function updateSelectionOverlay(): void {
    syncDragSelectionMask();
    Overlay.updateSelectionOverlay(scene, renderer, camera, currentSelection, vertexQueue, isVertexMode, selectionHelper, selectedVertexKeys);
    window.dispatchEvent(new CustomEvent('pde:selection-changed', { detail: currentSelection }));
    window.dispatchEvent(new CustomEvent('pde:selection-transform-context', {
        detail: {
            selection: currentSelection,
            pivotWorld: selectionHelper?.position.clone(),
            pivotMode,
            multiCustomPivotLocal: _getMultiSelectionPivotLocal()
        }
    }));
}

function _updateMultiSelectionOverlayDuringDrag(): void {
    Overlay.updateMultiSelectionOverlayDuringDrag(currentSelection, selectionHelper!.matrixWorld, dragInitialMatrix);
}

function flushSelectionTransform(): void {
    if (!selectionTransformDirty) return;
    selectionTransformDirty = false;
    if (_pendingHelperMatrix.equals(previousHelperMatrix)) return;

    _tmpPrevInvMatrix.copy(previousHelperMatrix).invert();
    _tmpDeltaMatrix.multiplyMatrices(_pendingHelperMatrix, _tmpPrevInvMatrix);
    previousHelperMatrix.copy(_pendingHelperMatrix);
    _tmpPrevInvMatrix.copy(dragInitialMatrix).invert();
    _dragTotalDeltaMatrix.multiplyMatrices(_pendingHelperMatrix, _tmpPrevInvMatrix);
    dragDeltaMatrix.copy(_dragTotalDeltaMatrix);
    _dragPreviewActive = true;
    applyLinkedMirrorDelta(loadedObjectGroup, _tmpDeltaMatrix, getDirectSelectedItems(), currentSelection.groups);
    Overlay.syncSelectionOverlay(_tmpDeltaMatrix);
    _updateMultiSelectionOverlayDuringDrag();
    window.dispatchEvent(new CustomEvent('pde:object-transform-changed', {
        detail: {
            selection: currentSelection,
            pivotWorld: selectionHelper!.position.clone(),
            pivotMode,
            multiCustomPivotLocal: _getMultiSelectionPivotLocal(),
            deltaMatrix: _tmpDeltaMatrix.clone(),
            dragging: true
        }
    }));
}

function commitSelectionTransform(): void {
    flushSelectionTransform();
    if (!_dragPreviewActive) return;

    if (!_dragTotalDeltaMatrix.equals(_identityMatrix)) {
        applyDeltaToSelection({
            deltaMatrix: _dragTotalDeltaMatrix,
            meshToInstanceRanges: _meshToInstanceRanges,
            selectedGroupIds: currentSelection.groups,
            loadedObjectGroup
        });
        Overlay.commitSelectionOverlay(_dragTotalDeltaMatrix, currentSelection);
    }
    _dragPreviewActive = false;
    dragDeltaMatrix.identity();
}

function resetSelectionAndDeselect(): void {
    resetSmartScaleSession();
    if (_hasAnySelection() || vertexQueue.length > 0) {
        _revertEphemeralPivotUndoIfAny();
        transformControls!.detach();
        _clearSelectionState();
        vertexQueue.length = 0;
        selectedVertexKeys.clear();
        _clearGizmoAnchor();

        pivotOffset.set(0, 0, 0);
        isCustomPivot = false;
        _selectionAnchorMode = 'default';

        invalidateSelectionCaches();
        updateSelectionOverlay();
        lastDirections = { X: null, Y: null, Z: null, XY: null, YZ: null, XZ: null };
        console.log('선택 제거');
    }
}

function setGizmoMaterialOpacity(meshes: Mesh[], opacity: number): void {
    meshes.forEach(mesh => {
        if (!mesh.material) return;
        const material = mesh.material as GizmoMaterial;
        material.transparent = true;
        material.opacity = opacity;
        material._opacity = opacity;
    });
}

function getPlaneDirection(planeName: GizmoPlaneName, direction: Vector3): GizmoPlaneDirection {
    if (planeName === 'XY') return `${direction.x > 0 ? '+' : '-'}${direction.y > 0 ? '+' : '-'}` as GizmoPlaneDirection;
    if (planeName === 'YZ') return `${direction.y > 0 ? '+' : '-'}${direction.z > 0 ? '+' : '-'}` as GizmoPlaneDirection;
    return `${direction.x > 0 ? '+' : '-'}${direction.z > 0 ? '+' : '-'}` as GizmoPlaneDirection;
}

function updateHelperPosition(): void {
    const items = getSelectedItems();
    if (items.length === 0 && !_hasAnySelection()) return;

    const isMulti = _isMultiSelection();

    if (!isCustomPivot && !_multiSelectionOriginAnchorValid && _isMultiSelection() && currentSelection.primary && _selectionAnchorMode !== 'center') {
        let primaryPivotWorld: Vector3 | null = null;
        const prim = currentSelection.primary;

        if (prim.type === 'group') {
            const groups = getGroups();
            const group = groups.get(prim.id);
            if (group) {
                if (shouldUseGroupPivot(group)) {
                    primaryPivotWorld = normalizePivotToVector3(group.pivot, _TMP_VEC3_A);
                }
                if (!primaryPivotWorld) {
                    primaryPivotWorld = Overlay.getGroupOriginWorld(prim.id, _TMP_VEC3_A);
                }
            }
        } else if (prim.type === 'object') {
            const { mesh, instanceId } = prim;
            if (mesh) {
                let custom: Vector3 | null = null;
                if ((mesh as InstancedMesh).isInstancedMesh) {
                    if (mesh.userData.customPivots && mesh.userData.customPivots.has(instanceId)) {
                        custom = mesh.userData.customPivots.get(instanceId);
                    }
                } else {
                    if (mesh.userData.customPivot) custom = mesh.userData.customPivot;
                }

                if (custom) {
                    const tempMat = _TMP_MAT4_A;
                    (mesh as InstancedMesh).getMatrixAt(instanceId, tempMat);
                    tempMat.premultiply(mesh.matrixWorld);
                    primaryPivotWorld = custom.clone().applyMatrix4(tempMat);
                } else {
                    primaryPivotWorld = CustomPivot.getObjectOriginWorld(mesh, instanceId, _TMP_VEC3_B);
                }
            }
        }

        if (primaryPivotWorld) {
            _multiSelectionOriginAnchorPosition.copy(primaryPivotWorld);
            _multiSelectionOriginAnchorValid = true;
            _captureMultiAnchorInitialIfNeeded(primaryPivotWorld);
        }
    }

    if (pivotMode === 'origin' && isMulti && !_multiSelectionOriginAnchorValid && _gizmoAnchorValid) {
        _multiSelectionOriginAnchorPosition.copy(_gizmoAnchorPosition);
        _multiSelectionOriginAnchorValid = true;
        // NOTE: _gizmoAnchorPosition 은 이전 모드의 world 좌표일 수 있으므로
        // _captureMultiAnchorInitialIfNeeded 를 호출하지 않음.
        // 로컬 초기값 캡처는 Block 1(primaryPivotWorld)에서만 수행.
    }

    const shouldPrioritizeMultiCustomPivot = _multiSelectionExplicitPivot || isCustomPivot;
    const lockMultiOrigin =
        (pivotMode === 'origin') &&
        isMulti &&
        _multiSelectionOriginAnchorValid &&
        (_selectionAnchorMode !== 'center' || shouldPrioritizeMultiCustomPivot);
    if (lockMultiOrigin) {
        // 로컬 좌표에서 world 위치 재계산: center 모드에서 이동 후 world 앵커가 stale 되는 문제 원천 차단
        const refreshedFromLocal = _resolveMultiAnchorInitialWorld(new Vector3());
        if (refreshedFromLocal) {
            _multiSelectionOriginAnchorPosition.copy(refreshedFromLocal);
        }
        selectionHelper!.position.copy(_multiSelectionOriginAnchorPosition);
        _gizmoAnchorPosition.copy(_multiSelectionOriginAnchorPosition);
        _gizmoAnchorValid = true;
    } else {
        const useCenterAnchorMode = (_selectionAnchorMode === 'center') && !shouldPrioritizeMultiCustomPivot;
        const center = useCenterAnchorMode
            ? _getSelectionCenterWorld(new Vector3())
            : SelectionCenter(pivotMode, isCustomPivot, pivotOffset);
        selectionHelper!.position.copy(center);
        _gizmoAnchorPosition.copy(center);
        _gizmoAnchorValid = true;

        if (pivotMode === 'origin' && isMulti) {
            _multiSelectionOriginAnchorPosition.copy(center);
            _multiSelectionOriginAnchorValid = true;
            // drag 선택처럼 primary가 없는 경우: 첫 번째 오브젝트를 primary로 설정하고
            // center를 그 primary의 로컬 좌표에 저장. 이후 이동 후 pivot mode 전환 시
            // _resolveMultiAnchorInitialWorld()가 올바른 현재 중앙을 반환하게 됨.
            if (!currentSelection.primary) _setPrimaryToFirstAvailable();
            _captureMultiAnchorInitialIfNeeded(center);
        }
    }

    const gizmoPos = selectionHelper!.position;

    let localPos: Vector3 | null = null;
    if (currentSelection.primary) {
        const prim = currentSelection.primary;
        const tempMat = _TMP_MAT4_A;
        if (prim.type === 'group') {
            Overlay.getGroupWorldMatrixWithFallback(prim.id, tempMat);
        } else {
            Overlay.getInstanceWorldMatrix(prim.mesh, prim.instanceId, tempMat);
        }

        const inv = _TMP_MAT4_B.copy(tempMat).invert();
        localPos = gizmoPos.clone().applyMatrix4(inv);
    }

    if (localPos && currentSelection.primary) {
        const prim = currentSelection.primary;
        const idStr = prim.type === 'group' ? `G_${prim.id}` : `O_${prim.mesh!.uuid}_${prim.instanceId}`;
        const queueKey = `QUEUE_${idStr}_${localPos.x.toFixed(4)}_${localPos.y.toFixed(4)}_${localPos.z.toFixed(4)}`;
        if (selectedVertexKeys.has(queueKey)) {
            selectedVertexKeys.delete(queueKey);
            const centerKey = `CENTER_${gizmoPos.x.toFixed(4)}_${gizmoPos.y.toFixed(4)}_${gizmoPos.z.toFixed(4)}`;
            selectedVertexKeys.add(centerKey);
        }
    }

    const singleGroupId = _getSingleSelectedGroupId();
    if (singleGroupId) {
        const groups = getGroups();
        const group = groups.get(singleGroupId);
        if (currentSpace === 'world') {
            selectionHelper!.quaternion.set(0, 0, 0, 1);
        } else if (group) {
            getGroupRotationQuaternion(singleGroupId, selectionHelper!.quaternion);
        } else {
            selectionHelper!.quaternion.set(0, 0, 0, 1);
        }
        selectionHelper!.scale.set(1, 1, 1);
    } else if (items.length > 0) {
        if (currentSpace === 'world') {
            selectionHelper!.quaternion.set(0, 0, 0, 1);
        } else {
            if (currentSelection.primary) {
                if (currentSelection.primary.type === 'group') {
                    getGroupRotationQuaternion(currentSelection.primary.id, selectionHelper!.quaternion);
                } else if (currentSelection.primary.type === 'object') {
                    const { mesh, instanceId } = currentSelection.primary;
                    if (mesh) {
                        const instanceMatrix = _TMP_MAT4_A;
                        (mesh as InstancedMesh).getMatrixAt(instanceId, instanceMatrix);
                        const worldMatrix = instanceMatrix.premultiply(mesh.matrixWorld);
                        selectionHelper!.quaternion.copy(Overlay.getRotationFromMatrix(worldMatrix));
                    }
                }
            } else {
                selectionHelper!.quaternion.copy(_multiSelectionAccumulatedRotation);
            }
        }
        selectionHelper!.scale.set(1, 1, 1);
    } else {
        selectionHelper!.quaternion.set(0, 0, 0, 1);
        selectionHelper!.scale.set(1, 1, 1);
    }

    selectionHelper!.updateMatrixWorld();
    if (!isVertexMode) {
        transformControls!.attach(selectionHelper!);
    } else {
        transformControls!.detach();
    }
    previousHelperMatrix.copy(selectionHelper!.matrixWorld);
}

let _pivotEditPreviousPivotMode: string | null = null;

function applySelection(mesh: Object3D | null, instanceIds: number[], groupId: string | null = null): void {
    _revertEphemeralPivotUndoIfAny();
    _clearSelectionState();
    _clearGizmoAnchor();
    _selectionAnchorMode = 'default';

    if (groupId) {
        currentSelection.groups.add(groupId);
        currentSelection.primary = { type: 'group', id: groupId };
    } else if (mesh && Array.isArray(instanceIds) && instanceIds.length > 0) {
        const idSet = new Set(instanceIds);
        currentSelection.objects.set(mesh as PdeMesh, idSet);
        currentSelection.primary = { type: 'object', mesh: mesh as PdeMesh, instanceId: instanceIds[0] };
    }

    invalidateSelectionCaches();
    _recomputePivotStateForSelection();

    updateHelperPosition();
    updateSelectionOverlay();

    if (groupId) {
        console.log(`그룹 선택: ${groupId}`);
    } else if (mesh && Array.isArray(instanceIds)) {
        console.log(`선택됨 InstancedMesh (IDs: ${instanceIds.join(',')})`);
    }
}

function _commitSelectionChange(): void {
    invalidateSelectionCaches();
    if (_hasAnySelection() && !currentSelection.primary) {
        _setPrimaryToFirstAvailable();
    }
    _recomputePivotStateForSelection();
    updateHelperPosition();
    updateSelectionOverlay();
}

function _promoteVertexQueueBundleOnExit(): boolean {
    return VertexQueue.promoteVertexQueueBundleOnExit({
        vertexQueue,
        replaceSelectionWithGroupsAndObjects: _replaceSelectionWithGroupsAndObjects
    });
}

function _emitSceneUpdated(): void {
    window.dispatchEvent(new CustomEvent<SceneUpdatedDetail>('pde:scene-updated', {
        detail: { skipGizmoRefresh: true }
    }));
}

function _handleSceneUpdated(event: Event): void {
    const detail = (event as CustomEvent<SceneUpdatedDetail>).detail;
    if (detail?.skipGizmoRefresh) return;
    if (detail?.pivotChanged) pivotMode = 'origin';
    if (!_hasAnySelection()) {
        transformControls?.detach();
        _clearGizmoAnchor();
    }
    invalidateSelectionCaches();
    _recomputePivotStateForSelection();
    updateHelperPosition();
    updateSelectionOverlay();
}

function _runWithoutVertexQueue<T>(fn: () => T): T {
    suppressVertexQueue = true;
    vertexQueue.length = 0;
    try {
        return fn();
    } finally {
        suppressVertexQueue = false;
    }
}

function _getGizmoCommandCallbacks() {
    return {
        getSelectedItems,
        hasAnySelection: _hasAnySelection,
        getGroups,
        getSingleSelectedGroupId: _getSingleSelectedGroupId,
        getGroupKey,
        invalidateSelectionCaches,
        applySelection,
        resetSelectionAndDeselect,
        emitSceneUpdated: _emitSceneUpdated
    };
}

function createGroup(): string | undefined {
    const before = captureSceneState(loadedObjectGroup);
    const groupId = _runWithoutVertexQueue(() => {
        const linked = getLinkedMirrorSelection(loadedObjectGroup, getDirectSelectedItems(), currentSelection.groups);
        const sourceGroupId = createGroupCommand(loadedObjectGroup, currentSelection, _getGizmoCommandCallbacks());
        if (!sourceGroupId || (linked.objects.size === 0 && linked.groups.size === 0)) return sourceGroupId;

        _replaceSelectionWithGroupsAndObjects(linked.groups, linked.objects);
        const mirrorGroupId = createGroupCommand(loadedObjectGroup, currentSelection, _getGizmoCommandCallbacks());
        linkMirrorPair(getMirrorPairs(loadedObjectGroup, 'groupMirrorPairs'), sourceGroupId, mirrorGroupId);
        applySelection(null, [], sourceGroupId);
        return sourceGroupId;
    });
    if (groupId) recordSceneChange(loadedObjectGroup, before);
    return groupId;
}

function ungroupGroup(groupIds: string | readonly string[], deselect = false): void {
    const groups = getGroups();
    const requestedIds = [...new Set(typeof groupIds === 'string' ? [groupIds] : groupIds)].filter(id => groups.has(id));
    if (requestedIds.length === 0) return;
    const before = captureSceneState(loadedObjectGroup, true);
    let changed = false;
    _runWithoutVertexQueue(() => {
        const pairs = getMirrorPairs(loadedObjectGroup, 'groupMirrorPairs');
        const targets: string[] = [];
        const seen = new Set<string>();
        for (const groupId of requestedIds) {
            const partnerId = isMirrorModelingEnabled() ? pairs.get(groupId) : undefined;
            for (const id of [partnerId, groupId]) {
                if (id && !seen.has(id)) {
                    seen.add(id);
                    targets.push(id);
                }
            }
            pairs.delete(groupId);
            if (partnerId) pairs.delete(partnerId);
        }
        changed = ungroupGroupsCommand(loadedObjectGroup, targets, _getGizmoCommandCallbacks(), !deselect);
    });
    if (changed) recordSceneChange(loadedObjectGroup, before);
}

function deleteSelectedItems(): void {
    if (!_hasAnySelection()) return;
    const before = captureSceneState(loadedObjectGroup);
    _runWithoutVertexQueue(() => {
        const linked = getLinkedMirrorSelection(loadedObjectGroup, getDirectSelectedItems(), currentSelection.groups);
        if (linked.objects.size > 0 || linked.groups.size > 0) {
            const objects = new Map(Array.from(currentSelection.objects, ([mesh, ids]) => [mesh, new Set(ids)]));
            linked.objects.forEach((ids, mesh) => {
                const selectedIds = objects.get(mesh) ?? new Set<number>();
                ids.forEach(id => selectedIds.add(id));
                objects.set(mesh, selectedIds);
            });
            _replaceSelectionWithGroupsAndObjects(new Set([...currentSelection.groups, ...linked.groups]), objects);
        }
        deleteSelectedItemsCommand(loadedObjectGroup, currentSelection, _getGizmoCommandCallbacks());
    });
    recordSceneChange(loadedObjectGroup, before);
}

function getDuplicateCommandCallbacks(): DuplicateCommandCallbacks {
    return {
        hasAnySelection: _hasAnySelection,
        isMultiSelection: _isMultiSelection,
        beginSelectionReplace: _beginSelectionReplace,
        setPrimaryToFirstAvailable: _setPrimaryToFirstAvailable,
        invalidateSelectionCaches,
        recomputePivotStateForSelection: _recomputePivotStateForSelection,
        updateHelperPosition,
        updateSelectionOverlay,
        emitSceneUpdated: _emitSceneUpdated,
        getCustomPivotState: () => ({ isCustomPivot, pivotOffset: pivotOffset.clone() }),
        restoreCustomPivotState: state => {
            isCustomPivot = true;
            pivotOffset.copy(state.pivotOffset);
        }
    };
}

function duplicateSelected(): void {
    if (!_hasAnySelection()) return;
    const before = captureSceneState(loadedObjectGroup);
    _runWithoutVertexQueue(() => {
        let sourceUuids = getSelectedItems().map(getItemUuid);
        let sourceGroupIds = [...currentSelection.groups];
        let sourceObjects = new Map(Array.from(currentSelection.objects, ([mesh, ids]) => [mesh, new Set(ids)]));
        let sourcePrimary = currentSelection.primary;
        const mirrorModeling = isMirrorModelingEnabled();
        const hasMirrorPair = mirrorModeling && (
            sourceUuids.some(uuid => uuid && getMirrorPairs(loadedObjectGroup, 'objectMirrorPairs').has(uuid))
            || sourceGroupIds.some(id => getMirrorPairs(loadedObjectGroup, 'groupMirrorPairs').has(id))
        );
        const duplicateCallbacks = getDuplicateCommandCallbacks();
        duplicateSelectedCommand(loadedObjectGroup, currentSelection, _selectionAnchorMode, duplicateCallbacks);
        if (!mirrorModeling) {
            recordSceneChange(loadedObjectGroup, before);
            return;
        }

        if (hasMirrorPair) {
            sourceUuids = getSelectedItems().map(getItemUuid);
            sourceGroupIds = [...currentSelection.groups];
            sourceObjects = new Map(Array.from(currentSelection.objects, ([mesh, ids]) => [mesh, new Set(ids)]));
            sourcePrimary = currentSelection.primary;
            duplicateSelectedCommand(loadedObjectGroup, currentSelection, _selectionAnchorMode, duplicateCallbacks);
        }
        const mirroredUuids = getSelectedItems().map(getItemUuid);
        const mirroredGroupIds = [...currentSelection.groups];
        _replaceSelectionWithGroupsAndObjects(new Set(sourceGroupIds), sourceObjects, {
            preserveAnchors: true,
            explicitPrimary: sourcePrimary
        });
        reflectGroups(loadedObjectGroup, new Set(mirroredGroupIds), 'x', mirrorModelingPivot, mirrorModelingPivot.clone().setX(0));
        const flipPromise = flipObjectUuids(loadedObjectGroup, mirroredUuids, 'x', mirrorModelingPivot, mirroredGroupIds.length > 0 ? 'center' : pivotMode, undefined, mirrorModelingPivot.clone().setX(0));
        sourceGroupIds.forEach((id, index) => {
            linkMirrorPair(getMirrorPairs(loadedObjectGroup, 'groupMirrorPairs'), id, mirroredGroupIds[index]);
            const group = GroupUtils.getGroups(loadedObjectGroup).get(id);
            const customPivot = group && GroupUtils.shouldUseGroupPivot(group)
                ? GroupUtils.normalizePivotToVector3(group.pivot)
                : null;
            if (customPivot) syncLinkedMirrorGroupPivot(loadedObjectGroup, id, customPivot);
        });
        updateHelperPosition();
        updateSelectionOverlay();
        _emitSceneUpdated();

        void flipPromise.then(finalUuids => {
            sourceUuids.forEach((uuid, index) => linkMirrorPair(getMirrorPairs(loadedObjectGroup, 'objectMirrorPairs'), uuid, finalUuids[index]));
            updateHelperPosition();
            updateSelectionOverlay();
            _emitSceneUpdated();
        }).catch(error => console.error('미러링 복제에 실패했습니다.', error))
            .finally(() => recordSceneChange(loadedObjectGroup, before));
    });
}

function knifeSelected(): void {
    if (!_hasAnySelection()) return;
    const x = Number(document.querySelector<HTMLInputElement>('.toolbar-dimensions input[name="x"]')?.value);
    const y = Number(document.querySelector<HTMLInputElement>('.toolbar-dimensions input[name="y"]')?.value);
    const z = Number(document.querySelector<HTMLInputElement>('.toolbar-dimensions input[name="z"]')?.value);
    const before = captureSceneState(loadedObjectGroup);
    const primary = currentSelection.primary;

    _runWithoutVertexQueue(() => {
        try {
            const result = knifeSelection(loadedObjectGroup, currentSelection, x, y, z, isMirrorModelingEnabled());
            if (!result.changed) return;
            _replaceSelectionWithGroupsAndObjects(result.groups, result.objects, {
                anchorMode: isCustomPivot || _multiSelectionOriginAnchorValid ? _selectionAnchorMode : 'center',
                preserveAnchors: true,
                explicitPrimary: primary
            });
            _emitSceneUpdated();
            recordSceneChange(loadedObjectGroup, before);
        } catch (error) {
            restoreSceneState(loadedObjectGroup, before);
            invalidateSelectionCaches();
            updateHelperPosition();
            updateSelectionOverlay();
            console.error('나이프 실행에 실패했습니다.', error);
            window.alert(error instanceof Error ? error.message : '나이프 실행에 실패했습니다.');
        }
    });
}

async function flipSelected(axis: FlipAxis): Promise<void> {
    if (!_hasAnySelection() || !selectionHelper) return;
    const before = captureSceneState(loadedObjectGroup);
    const isMulti = _isMultiSelection();
    const activePivotMode = pivotMode;
    const preserveGroupBounds = currentSelection.groups.size > 0;
    updateHelperPosition();
    const pivotWorld = activePivotMode === 'center' || preserveGroupBounds
        ? _getSelectionCenterWorld()
        : selectionHelper.position.clone();
    const multiPivotState = isMulti ? {
        isCustomPivot,
        pivotOffset: pivotOffset.clone(),
        explicitPivot: _multiSelectionExplicitPivot,
        anchorMode: _selectionAnchorMode
    } : null;
    const selectedUuids = getSelectedItems().map(getItemUuid);
    const selected = new Set(selectedUuids);
    const pairs = getMirrorPairs(loadedObjectGroup, 'objectMirrorPairs');
    const linkedUuids = selectedUuids.map(uuid => uuid && !selected.has(pairs.get(uuid)) ? pairs.get(uuid) : undefined);
    reflectGroups(loadedObjectGroup, currentSelection.groups, axis, pivotWorld);
    await flipObjectUuids(loadedObjectGroup, selectedUuids, axis, pivotWorld, preserveGroupBounds ? 'center' : activePivotMode, updateSelectionOverlay);
    await flipObjectUuids(loadedObjectGroup, linkedUuids, axis, undefined, activePivotMode);
    if (multiPivotState) {
        isCustomPivot = multiPivotState.isCustomPivot;
        pivotOffset.copy(multiPivotState.pivotOffset);
        _multiSelectionExplicitPivot = multiPivotState.explicitPivot;
        _selectionAnchorMode = multiPivotState.anchorMode;
    }
    _recomputePivotStateForSelection();
    if (isMulti) {
        _gizmoAnchorPosition.copy(pivotWorld);
        _gizmoAnchorValid = true;
        if (activePivotMode === 'origin') {
            _multiSelectionOriginAnchorPosition.copy(pivotWorld);
            _multiSelectionOriginAnchorValid = true;
            _setMultiAnchorInitial(pivotWorld);
        } else if (_multiSelectionOriginAnchorValid) {
            const axisIndex = { x: 0, y: 1, z: 2 }[axis];
            _multiSelectionOriginAnchorPosition.setComponent(
                axisIndex,
                2 * pivotWorld.getComponent(axisIndex) - _multiSelectionOriginAnchorPosition.getComponent(axisIndex)
            );
            _setMultiAnchorInitial(_multiSelectionOriginAnchorPosition);
        }
    }
    updateHelperPosition();
    updateSelectionOverlay();
    _emitSceneUpdated();
    recordSceneChange(loadedObjectGroup, before);
}

//  Main entry point 

export function initGizmo({
    scene: s,
    camera: cam,
    renderer: rend,
    controls: orbitControls,
    loadedObjectGroup: lg,
    setControls
}: InitGizmoParams): InitGizmoResult {
    scene = s; camera = cam; renderer = rend; controls = orbitControls; loadedObjectGroup = lg;
    Overlay.setLoadedObjectGroup(lg);
    Select.setLoadedObjectGroup(lg);
    setHistorySelection(currentSelection);
    setHistoryGizmoState(
        () => ({
            isVertexMode,
            vertexQueue,
            selectedVertexKeys,
            isCustomPivot,
            pivotOffset: pivotOffset.clone(),
            gizmoAnchorValid: _gizmoAnchorValid,
            gizmoAnchorPosition: _gizmoAnchorPosition.clone(),
            multiSelectionOriginAnchorValid: _multiSelectionOriginAnchorValid,
            multiSelectionOriginAnchorPosition: _multiSelectionOriginAnchorPosition.clone(),
            multiSelectionOriginAnchorInitialValid: _multiSelectionOriginAnchorInitialValid,
            multiSelectionOriginAnchorInitialPosition: _multiSelectionOriginAnchorInitialPosition.clone(),
            multiSelectionOriginAnchorInitialLocalValid: _multiSelectionOriginAnchorInitialLocalValid,
            multiSelectionOriginAnchorInitialLocal: _multiSelectionOriginAnchorInitialLocal.clone(),
            multiSelectionExplicitPivot: _multiSelectionExplicitPivot,
            multiSelectionAccumulatedRotation: _multiSelectionAccumulatedRotation.clone(),
            selectionAnchorMode: _selectionAnchorMode
        }),
        state => {
            isVertexMode = state.isVertexMode;
            vertexQueue.splice(0, vertexQueue.length, ...state.vertexQueue);
            selectedVertexKeys.clear();
            state.selectedVertexKeys.forEach(key => selectedVertexKeys.add(key));
            isCustomPivot = state.isCustomPivot;
            pivotOffset.copy(state.pivotOffset);
            _gizmoAnchorValid = state.gizmoAnchorValid;
            _gizmoAnchorPosition.copy(state.gizmoAnchorPosition);
            _multiSelectionOriginAnchorValid = state.multiSelectionOriginAnchorValid;
            _multiSelectionOriginAnchorPosition.copy(state.multiSelectionOriginAnchorPosition);
            _multiSelectionOriginAnchorInitialValid = state.multiSelectionOriginAnchorInitialValid;
            _multiSelectionOriginAnchorInitialPosition.copy(state.multiSelectionOriginAnchorInitialPosition);
            _multiSelectionOriginAnchorInitialLocalValid = state.multiSelectionOriginAnchorInitialLocalValid;
            _multiSelectionOriginAnchorInitialLocal.copy(state.multiSelectionOriginAnchorInitialLocal);
            _multiSelectionExplicitPivot = state.multiSelectionExplicitPivot;
            _multiSelectionAccumulatedRotation.copy(state.multiSelectionAccumulatedRotation);
            _selectionAnchorMode = state.selectionAnchorMode;
        }
    );

    if (!loadedObjectGroup.userData.groups) loadedObjectGroup.userData.groups = new Map();
    if (!loadedObjectGroup.userData.objectToGroup) loadedObjectGroup.userData.objectToGroup = new Map();

    selectionHelper = new Mesh(
        new BoxGeometry(0.1, 0.1, 0.1),
        new MeshBasicMaterial({ visible: false })
    );
    scene.add(selectionHelper);

    const mouseInput = new Vector2();

    renderer.domElement.addEventListener('pointerdown', (event: PointerEvent) => {
        const rect = renderer.domElement.getBoundingClientRect();
        mouseInput.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        mouseInput.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    }, true);

    const setupResult = setupGizmo(camera, renderer as Renderer, scene);
    transformControls = setupResult.transformControls;
    const gizmoContainer = transformControls.getHelper().children[0];
    const updateGizmoMatrixWorld = gizmoContainer.updateMatrixWorld.bind(gizmoContainer);
    gizmoContainer.updateMatrixWorld = (force?: boolean): void => {
        const dragStartPivot = transformControls!.worldPositionStart.clone();
        const smartScaleVisualPivot = getSmartScaleVisualPivot();
        if (smartScaleVisualPivot) transformControls!.worldPositionStart.copy(smartScaleVisualPivot);
        updateGizmoMatrixWorld(force);
        transformControls!.worldPositionStart.copy(dragStartPivot);
    };
    applyGizmoDragValues();
    gizmoLines = setupResult.gizmoLines;
    gizmoPlanes = setupResult.gizmoPlanes;

    transformControls.addEventListener('dragging-changed', (event: { value: boolean }) => {
        controls.enabled = !event.value;
        if (event.value) {
            dragHistoryBefore = captureSceneState(loadedObjectGroup);
            Overlay.prepareMultiSelectionDrag(currentSelection);
            draggingMode = transformControls!.mode;
            selectionTransformDirty = false;
            _dragPreviewActive = false;
            _dragTotalDeltaMatrix.identity();
            dragDeltaMatrix.identity();

            const items = getSelectedItems();
            const meshToInstanceIds = new Map<Object3D, number[]>();
            for (const { mesh, instanceId } of items) {
                if (!mesh) continue;
                let list = meshToInstanceIds.get(mesh);
                if (!list) {
                    list = [];
                    meshToInstanceIds.set(mesh, list);
                }
                list.push(instanceId);
            }
            _meshToInstanceRanges.clear();
            for (const [mesh, instanceIds] of meshToInstanceIds) {
                _meshToInstanceRanges.set(mesh, mergeInstanceIds(instanceIds));
            }

            if (transformControls!.axis === 'XYZ') isUniformScale = true;

            selectionHelper!.updateMatrixWorld();
            dragInitialMatrix.copy(selectionHelper!.matrixWorld);
            previousHelperMatrix.copy(dragInitialMatrix);
            _pendingHelperMatrix.copy(dragInitialMatrix);
            dragInitialQuaternion.copy(selectionHelper!.quaternion);
            dragInitialScale.copy(selectionHelper!.scale);
            dragInitialPosition.copy(selectionHelper!.position);

            if (isPivotEditMode) {
                dragStartPivotBaseWorld.copy(SelectionCenter('origin', false, _ZERO_VEC3));
                CustomPivot.setPivotEditUndoCapture(null);
            }

            if ((blockbenchScaleMode || isSmartScaleEnabled()) && draggingMode === 'scale' && !isUniformScale) {
                dragAnchorDirections = detectBlockbenchScaleAxes(camera, mouseInput, selectionHelper!, currentSpace);
            }

            beginSmartScaleDrag(
                draggingMode,
                transformControls!.axis,
                dragAnchorDirections,
                items,
                dragInitialMatrix,
                dragInitialScale,
                dragInitialPosition
            );

            if ((blockbenchScaleMode || isSmartScaleEnabled()) && draggingMode === 'scale' && !isUniformScale) {
                dragInitialBoundingBox.makeEmpty();

                selectionHelper!.updateMatrixWorld();
                computeBlockbenchPivotFrame(selectionHelper!, currentSpace);

                const singleGroupId = _getSingleSelectedGroupId();
                if (singleGroupId) {
                    const groupLocalBox = Overlay.getGroupLocalBoundingBox(singleGroupId);
                    if (!groupLocalBox.isEmpty()) {
                        const groupWorldMat = Overlay.getGroupWorldMatrixWithFallback(singleGroupId, _TMP_MAT4_A);
                        const combinedMat = transformBoxToPivotFrame(groupWorldMat, _TMP_MAT4_B);
                        Overlay.unionTransformedBox3(dragInitialBoundingBox, groupLocalBox, combinedMat);
                    }
                } else {
                    if (items.length > 0) {
                        const tempMat = new Matrix4();
                        items.forEach(({ mesh, instanceId }) => {
                            const localBox = Overlay.getInstanceLocalBox(mesh, instanceId);
                            if (!localBox) return;
                            Overlay.getInstanceWorldMatrix(mesh, instanceId, tempMat);
                            const combinedMat = transformBoxToPivotFrame(tempMat, _TMP_MAT4_A);
                            Overlay.unionTransformedBox3(dragInitialBoundingBox, localBox, combinedMat);
                        });
                    }
                }
            }

        } else {
            const historyBefore = dragHistoryBefore;
            dragHistoryBefore = null;
            selectionHelper!.updateMatrixWorld();
            const changed = !selectionHelper!.matrixWorld.equals(dragInitialMatrix);
            const smartScaleExtruded = endSmartScaleDrag();
            commitSelectionTransform();

            if (draggingMode === 'rotate' && _isMultiSelection() && !currentSelection.primary) {
                _multiSelectionAccumulatedRotation.copy(selectionHelper!.quaternion);
            }

            draggingMode = null;
            isUniformScale = false;

            if (isPivotEditMode) {
                const commitResult = CustomPivot.commitPivotEditFromDragEnd({
                    pivotWorldPos: selectionHelper!.position.clone(),
                    isMultiPivotEdit: _isMultiSelection(),
                    singleGroupId: _getSingleSelectedGroupId(),
                    currentSelection,
                    loadedObjectGroup
                });

                pivotOffset.copy(commitResult.newPivotOffset);
                isCustomPivot = commitResult.newIsCustomPivot;
                if (!isCustomPivot && currentSelection.objects && currentSelection.objects.size > 0) {
                    // Object pivot edits need a live offset, not just stored userData.
                    const originBase = SelectionCenter('origin', false, _ZERO_VEC3);
                    pivotOffset.copy(selectionHelper!.position).sub(originBase);
                    isCustomPivot = true;
                }
                if (commitResult.setMultiExplicitPivot) _multiSelectionExplicitPivot = true;

                if (_pivotEditPreviousPivotMode) {
                    pivotMode = _pivotEditPreviousPivotMode === 'center' ? 'origin' : _pivotEditPreviousPivotMode;
                }

                _gizmoAnchorPosition.copy(selectionHelper!.position);
                _gizmoAnchorValid = true;
                // _selectionAnchorMode 는 변경하지 않음:
                // drag 선택('center') → reset 시 bbox 중심으로 복귀 보장
                // 수동 선택('default') → reset 시 primary origin 유지

                if (_isMultiSelection()) {
                    _multiSelectionOriginAnchorPosition.copy(selectionHelper!.position);
                    _multiSelectionOriginAnchorValid = true;
                    // 커스텀 피벗이 새로 커밋되었으므로 로컬 초기값을 강제 갱신.
                    // _captureMultiAnchorInitialIfNeeded(already-valid 시 무시) 대신
                    // _setMultiAnchorInitial을 써서 항상 덮어씀.
                    _setMultiAnchorInitial(selectionHelper!.position);
                }
            } else {
                _recomputePivotStateForSelection();

                if (_isMultiSelection() && pivotMode === 'origin') {
                    _multiSelectionOriginAnchorPosition.copy(selectionHelper!.position);
                    _multiSelectionOriginAnchorValid = true;
                }
            }

            if (smartScaleExtruded) updateHelperPosition();

            if (currentSelection.objects && currentSelection.objects.size > 0) {
                for (const [mesh] of currentSelection.objects) {
                    if (mesh) (mesh as Mesh).boundingSphere = null;
                }
            }

            if (selectionHelper) {
                selectionHelper.scale.set(1, 1, 1);
                selectionHelper.updateMatrixWorld();
                previousHelperMatrix.copy(selectionHelper.matrixWorld);
                window.dispatchEvent(new CustomEvent('pde:object-transform-changed', {
                    detail: {
                        selection: currentSelection,
                        pivotWorld: selectionHelper.position.clone(),
                        pivotMode,
                        multiCustomPivotLocal: _getMultiSelectionPivotLocal()
                    }
                }));
            }
            if (changed && historyBefore) recordSceneChange(loadedObjectGroup, historyBefore);
        }
    });

    const smartScaleCallbacks = {
        cancelPreview: () => {
            if (_dragPreviewActive) {
                applyLinkedMirrorDelta(
                    loadedObjectGroup,
                    _dragTotalDeltaMatrix.clone().invert(),
                    getDirectSelectedItems(),
                    currentSelection.groups
                );
            }
            dragDeltaMatrix.identity();
            _dragPreviewActive = false;
            selectionTransformDirty = false;
        },
        duplicateSelected: () => {
            const duplicateCallbacks = {
                ...getDuplicateCommandCallbacks(),
                updateHelperPosition: () => {}
            };
            duplicateSelectedCommand(loadedObjectGroup, currentSelection, _selectionAnchorMode, duplicateCallbacks);
            const sourceItems = getSelectedItems();
            if (!isMirrorModelingEnabled()) return sourceItems;

            const sourceUuids = sourceItems.map(getItemUuid);
            const sourceGroupIds = [...currentSelection.groups];
            const sourceObjects = new Map(Array.from(currentSelection.objects, ([mesh, ids]) => [mesh, new Set(ids)]));
            const sourcePrimary = currentSelection.primary;
            duplicateSelectedCommand(loadedObjectGroup, currentSelection, _selectionAnchorMode, duplicateCallbacks);
            const mirroredUuids = getSelectedItems().map(getItemUuid);
            const mirroredGroupIds = [...currentSelection.groups];
            Select.replaceSelectionWithGroupsAndObjects(
                new Set(sourceGroupIds),
                sourceObjects,
                { ...getSelectionCallbacks(), updateHelperPosition: undefined },
                { preserveAnchors: true, explicitPrimary: sourcePrimary, detachTransform: false }
            );
            reflectGroups(loadedObjectGroup, new Set(mirroredGroupIds), 'x', mirrorModelingPivot, mirrorModelingPivot.clone().setX(0));
            sourceGroupIds.forEach((id, index) => linkMirrorPair(getMirrorPairs(loadedObjectGroup, 'groupMirrorPairs'), id, mirroredGroupIds[index]));
            void flipObjectUuids(
                loadedObjectGroup,
                mirroredUuids,
                'x',
                mirrorModelingPivot,
                mirroredGroupIds.length > 0 ? 'center' : pivotMode,
                () => sourceUuids.forEach((uuid, index) => linkMirrorPair(
                    getMirrorPairs(loadedObjectGroup, 'objectMirrorPairs'), uuid, mirroredUuids[index]
                )),
                mirrorModelingPivot.clone().setX(0),
                true
            ).catch(error => console.error('스마트 스케일 미러링 복제에 실패했습니다.', error));
            return getSelectedItems();
        },
        deleteSelectedAndRestore: (selection: Select.SelectionState) => {
            const linked = getLinkedMirrorSelection(loadedObjectGroup, getDirectSelectedItems(), currentSelection.groups);
            linked.groups.forEach(groupId => currentSelection.groups.add(groupId));
            linked.objects.forEach((ids, mesh) => {
                const selectedIds = currentSelection.objects.get(mesh) ?? new Set<number>();
                ids.forEach(id => selectedIds.add(id));
                currentSelection.objects.set(mesh, selectedIds);
            });
            deleteSelectedItemsCommand(loadedObjectGroup, currentSelection, {
                ..._getGizmoCommandCallbacks(),
                resetSelectionAndDeselect: _clearSelectionState,
                emitSceneUpdated: () => {}
            });
            currentSelection.groups = new Set(selection.groups);
            currentSelection.objects = new Map(Array.from(selection.objects, ([mesh, ids]) => [mesh, new Set(ids)]));
            currentSelection.primary = selection.primary;
            invalidateSelectionCaches();
            _recomputePivotStateForSelection();
            updateSelectionOverlay();
            _emitSceneUpdated();
        },
        applyMirrorDelta: (deltaMatrix: Matrix4) => applyLinkedMirrorDelta(
            loadedObjectGroup,
            deltaMatrix,
            getDirectSelectedItems(),
            currentSelection.groups
        ),
        commitSelectionOverlay: (deltaMatrix: Matrix4) => {
            Overlay.syncSelectionOverlay(deltaMatrix);
            Overlay.commitSelectionOverlay(deltaMatrix, currentSelection);
            window.dispatchEvent(new CustomEvent('pde:object-transform-changed', {
                detail: {
                    selection: currentSelection,
                    pivotWorld: selectionHelper!.position.clone(),
                    pivotMode,
                    multiCustomPivotLocal: _getMultiSelectionPivotLocal(),
                    dragging: true
                }
            }));
        }
    };

    transformControls.addEventListener('change', (_event: object) => {
        if (transformControls!.dragging && _hasAnySelection()) {
            applyRelativeDragSnap();

            if (isPivotEditMode && transformControls!.mode === 'translate') {
                const snapTarget = Overlay.findClosestVertexForSnapping(selectionHelper!.position, camera, renderer);
                if (snapTarget) {
                    selectionHelper!.position.copy(snapTarget);
                }

                pivotOffset.subVectors(selectionHelper!.position, dragStartPivotBaseWorld);
                isCustomPivot = true;

                if (_isMultiSelection()) {
                    _multiSelectionOriginAnchorPosition.copy(selectionHelper!.position);
                    _multiSelectionOriginAnchorValid = true;
                }
                previousHelperMatrix.copy(selectionHelper!.matrixWorld);
                window.dispatchEvent(new CustomEvent('pde:object-transform-changed', {
                    detail: {
                        selection: currentSelection,
                        pivot: pivotOffset.clone(),
                        pivotWorld: selectionHelper!.position.clone(),
                        pivotMode,
                        multiCustomPivotLocal: _getMultiSelectionPivotLocal(),
                        dragging: true
                    }
                }));
                return;
            }

            const scaleDirections = normalizeSmartScaleDrag(selectionHelper!, dragAnchorDirections);
            if ((blockbenchScaleMode || isSmartScaleEnabled()) && transformControls!.mode === 'scale' && !isUniformScale) {
                const shiftWorld = computeBlockbenchScaleShift(selectionHelper!, dragInitialScale, dragInitialPosition, dragInitialBoundingBox, scaleDirections, currentSpace);
                if (shiftWorld) {
                    selectionHelper!.position.copy(dragInitialPosition).add(shiftWorld);
                    selectionHelper!.updateMatrixWorld();
                }
            }

            selectionHelper!.updateMatrixWorld();
            if (isSmartScaleEnabled() && updateSmartScaleDuringDrag(
                selectionHelper!, scaleDirections, currentSelection, loadedObjectGroup, smartScaleCallbacks
            )) {
                selectionTransformDirty = false;
                dragDeltaMatrix.identity();
                return;
            }
            _pendingHelperMatrix.copy(selectionHelper!.matrixWorld);
            selectionTransformDirty = true;
        }
    });

    const handleKeyState: HandleKeyState = {
        get isVertexMode() { return isVertexMode; },
        set isVertexMode(v) { isVertexMode = v; },
        get currentSpace() { return currentSpace; },
        set currentSpace(v) { currentSpace = v; },
        get pivotMode() { return pivotMode; },
        set pivotMode(v) { pivotMode = v; },
        get isCustomPivot() { return isCustomPivot; },
        set isCustomPivot(v) { isCustomPivot = v; },
        get isGizmoBusy() { return isGizmoBusy; },
        set isGizmoBusy(v) { isGizmoBusy = v; },
        get isPivotEditMode() { return isPivotEditMode; },
        set isPivotEditMode(v) { isPivotEditMode = v; },
        get previousGizmoMode() { return previousGizmoMode; },
        set previousGizmoMode(v) { previousGizmoMode = v; },
        get pivotEditPreviousPivotMode() { return _pivotEditPreviousPivotMode; },
        set pivotEditPreviousPivotMode(v) { _pivotEditPreviousPivotMode = v; },
        get multiSelectionExplicitPivot() { return _multiSelectionExplicitPivot; },
        set multiSelectionExplicitPivot(v) { _multiSelectionExplicitPivot = v; },
        get multiSelectionOriginAnchorValid() { return _multiSelectionOriginAnchorValid; },
        set multiSelectionOriginAnchorValid(v) { _multiSelectionOriginAnchorValid = v; },
        get multiSelectionOriginAnchorInitialValid() { return _multiSelectionOriginAnchorInitialValid; },
        set multiSelectionOriginAnchorInitialValid(v) { _multiSelectionOriginAnchorInitialValid = v; },
        get multiSelectionOriginAnchorInitialLocalValid() { return _multiSelectionOriginAnchorInitialLocalValid; },
        set multiSelectionOriginAnchorInitialLocalValid(v) { _multiSelectionOriginAnchorInitialLocalValid = v; },
        get gizmoAnchorValid() { return _gizmoAnchorValid; },
        set gizmoAnchorValid(v) { _gizmoAnchorValid = v; },
        get selectionAnchorMode() { return _selectionAnchorMode; },
        set selectionAnchorMode(v) { _selectionAnchorMode = v; },
        get controls() { return controls; },
        set controls(v) { controls = v; }
    };

    initHandleKey({
        state: handleKeyState,

        pivotOffset,
        multiSelectionOriginAnchorPosition:       _multiSelectionOriginAnchorPosition,
        gizmoAnchorPosition:                      _gizmoAnchorPosition,
        previousHelperMatrix,
        currentSelection,
        selectedVertexKeys,
        vertexQueue,
        dragInitialMatrix,
        dragInitialPosition,
        dragInitialQuaternion,
        dragInitialScale,
        loadedObjectGroup,

        get camera() { return camera; },
        renderer,
        getTransformControls:                     () => transformControls!,
        getSelectionHelper:                       () => selectionHelper!,
        setExternalControls:                      setControls,
        DEFAULT_GROUP_PIVOT:                      _DEFAULT_GROUP_PIVOT,

        updateHelperPosition,
        updateSelectionOverlay,
        hasAnySelection:                          _hasAnySelection,
        isMultiSelection:                         _isMultiSelection,
        getSingleSelectedGroupId:                 _getSingleSelectedGroupId,
        getSelectedItems,
        recomputePivotStateForSelection:          _recomputePivotStateForSelection,
        revertEphemeralPivotUndoIfAny:            _revertEphemeralPivotUndoIfAny,

        duplicateSelected,
        knifeSelected,
        toggleSmartScale,
        resetSelectionAndDeselect,
        deleteSelectedItems,
        createGroup,
        ungroupGroup,
        promoteVertexQueueBundleOnExit:           _promoteVertexQueueBundleOnExit,
        pushToVertexQueue:                        _pushToVertexQueue,
        replaceSelectionWithObjectsMap:           _replaceSelectionWithObjectsMap,
        replaceSelectionWithGroupsAndObjects:     _replaceSelectionWithGroupsAndObjects,
        selectAllObjectsVisibleInScene:           _selectAllObjectsVisibleInScene,

        SelectionCenter,
        getSelectionBoundingBox,
        getSelectionCenterWorld:                  _getSelectionCenterWorld,
        resolveMultiAnchorInitialWorld:           _resolveMultiAnchorInitialWorld,
        setMultiAnchorInitial:                    _setMultiAnchorInitial,

        getGroupChain,
        getObjectToGroup,
        getGroupKey,
        getGroups,
        getGroupOriginWorld:                      Overlay.getGroupOriginWorld,
        getGroupWorldMatrix,
        shouldUseGroupPivot,
        normalizePivotToVector3,

        getInstanceCount:                         Overlay.getInstanceCount,
        isInstanceValid:                          Overlay.isInstanceValid,
        getDisplayType:                           Overlay.getDisplayType,
        getInstanceLocalBoxMin:                   Overlay.getInstanceLocalBoxMin,
        getInstanceWorldMatrixForOrigin:          Overlay.getInstanceWorldMatrixForOrigin,
        isItemDisplayHatEnabled:                  Overlay.isItemDisplayHatEnabled,
        prepareMultiSelectionDrag:                Overlay.prepareMultiSelectionDrag,
    });

    const raycaster = new Raycaster();
    raycaster.layers.enable(2);
    const mouse = new Vector2();
    let mouseDownPos: { x: number; y: number } | null = null;
    const cameraMatrixOnPointerDown = new Matrix4();

    const dragControls: DragInterface = initDrag({
        renderer,
        camera,
        getControls: () => controls,
        transformControls: transformControls!,
        loadedObjectGroup,
        getSelectionCallbacks: () => getSelectionCallbacks()
    });

    renderer.domElement.addEventListener('pointermove', (event: PointerEvent) => {
        if (transformControls!.dragging || dragControls.isMarqueeActiveOrCandidate()) return;

        if (isVertexMode) {
            const rect = renderer.domElement.getBoundingClientRect();
            const m = new Vector2(
                ((event.clientX - rect.left) / rect.width) * 2 - 1,
                -((event.clientY - rect.top) / rect.height) * 2 + 1
            );

            const hovered = Overlay.getHoveredVertex(m, camera, renderer);
            Overlay.updateVertexHoverHighlight(hovered, selectedVertexKeys);

            if (hovered) {
                renderer.domElement.style.cursor = 'pointer';
            } else if (isVertexMode) {
                renderer.domElement.style.cursor = '';
            }
        }
    });

    loadedObjectGroup.userData.resetSelection = resetSelectionAndDeselect;
    loadedObjectGroup.userData.deleteSelected = deleteSelectedItems;
    loadedObjectGroup.userData.duplicateSelected = duplicateSelected;
    loadedObjectGroup.userData.groupSelected = () => { createGroup(); };
    loadedObjectGroup.userData.ungroupSelected = (groupId: string) => { ungroupGroup(groupId); };
    loadedObjectGroup.userData.getPivotMode = () => pivotMode;
    loadedObjectGroup.userData.replaceSelectionWithObjectsMap = (meshToIds: Map<PdeMesh, Set<number>>, options?: { anchorMode?: string }) => {
        _replaceSelectionWithObjectsMap(meshToIds, options);
    };
    loadedObjectGroup.userData.replaceSelectionWithGroupsAndObjects = (
        groupIds: Set<string>,
        meshToIds: Map<PdeMesh, Set<number>>,
        options?: {
            anchorMode?: string;
            preserveAnchors?: boolean;
            primaryIsRangeStart?: boolean;
            explicitPrimary?: Select.PrimarySelection | null;
        }
    ) => {
        _replaceSelectionWithGroupsAndObjects(groupIds, meshToIds, options);
    };
    loadedObjectGroup.userData.addOrToggleInSelection = (groupIds: Set<string> | null, meshToIds: Map<PdeMesh, Set<number>> | null) => {
        _revertEphemeralPivotUndoIfAny();

        if (groupIds) {
            for (const gid of groupIds) {
                if (!gid) continue;
                if (currentSelection.groups.has(gid)) {
                    currentSelection.groups.delete(gid);
                    if (currentSelection.primary?.type === 'group' && currentSelection.primary.id === gid)
                        currentSelection.primary = null;
                } else {
                    currentSelection.groups.add(gid);
                    if (!currentSelection.primary) currentSelection.primary = { type: 'group', id: gid };
                }
            }
        }
        if (meshToIds) {
            for (const [mesh, ids] of meshToIds) {
                if (!mesh || !ids) continue;
                let existing = currentSelection.objects.get(mesh);
                for (const id of ids) {
                    if (!existing) { existing = new Set(); currentSelection.objects.set(mesh, existing); }
                    if (existing.has(id)) {
                        existing.delete(id);
                        if (existing.size === 0) currentSelection.objects.delete(mesh);
                        if (currentSelection.primary?.type === 'object' && currentSelection.primary.mesh === mesh && currentSelection.primary.instanceId === id)
                            currentSelection.primary = null;
                    } else {
                        existing.add(id);
                        if (!currentSelection.primary) currentSelection.primary = { type: 'object', mesh, instanceId: id };
                    }
                }
            }
        }
        _commitSelectionChange();
    };

    renderer.domElement.addEventListener('pointerdown', (event: PointerEvent) => {
        if (isGizmoBusy) return;
        if (event.button !== 0) return;
        const headPainterTool = renderer.domElement.dataset.headPainterTool;
        if (headPainterTool && headPainterTool !== 'select') {
            mouseDownPos = null;
            return;
        }

        if (isVertexMode) {
            const rect = renderer.domElement.getBoundingClientRect();
            const m = new Vector2(
                ((event.clientX - rect.left) / rect.width) * 2 - 1,
                -((event.clientY - rect.top) / rect.height) * 2 + 1
            );

            const v = Overlay.getHoveredVertex(m, camera, renderer);
            if (v && v.userData && v.userData.key) {
                const key = v.userData.key as string;
                const vertexHistoryBefore = !selectedVertexKeys.has(key) && selectedVertexKeys.size === 1
                    ? captureSceneState(loadedObjectGroup)
                    : null;

                if (selectedVertexKeys.has(key)) {
                    selectedVertexKeys.delete(key);
                } else {
                    selectedVertexKeys.add(key);

                    if (selectedVertexKeys.size === 2) {
                        const getGizmoState = (): GizmoState => ({
                            pivotMode, isCustomPivot, pivotOffset,
                            _gizmoAnchorValid, _gizmoAnchorPosition,
                            _multiSelectionOriginAnchorValid, _multiSelectionOriginAnchorPosition,
                            _multiSelectionOriginAnchorInitialValid, _multiSelectionOriginAnchorInitialPosition,
                            selectionAnchorMode: _selectionAnchorMode,
                            _multiSelectionExplicitPivot
                        });
                        const setGizmoState = (updates: Partial<GizmoState>): void => {
                            if (updates.pivotMode !== undefined) pivotMode = updates.pivotMode;
                            if (updates.isCustomPivot !== undefined) isCustomPivot = updates.isCustomPivot;
                            if (updates.pivotOffset !== undefined) pivotOffset.copy(updates.pivotOffset);
                            if (updates._gizmoAnchorValid !== undefined) _gizmoAnchorValid = updates._gizmoAnchorValid;
                            if (updates._gizmoAnchorPosition !== undefined) _gizmoAnchorPosition.copy(updates._gizmoAnchorPosition);
                            if (updates._multiSelectionOriginAnchorValid !== undefined) _multiSelectionOriginAnchorValid = updates._multiSelectionOriginAnchorValid;
                            if (updates._multiSelectionOriginAnchorPosition !== undefined) _multiSelectionOriginAnchorPosition.copy(updates._multiSelectionOriginAnchorPosition);
                            if (updates._multiSelectionOriginAnchorInitialValid !== undefined) _multiSelectionOriginAnchorInitialValid = updates._multiSelectionOriginAnchorInitialValid;
                            if (updates._multiSelectionOriginAnchorInitialPosition !== undefined) _multiSelectionOriginAnchorInitialPosition.copy(updates._multiSelectionOriginAnchorInitialPosition);
                            if (updates.selectionAnchorMode !== undefined) _selectionAnchorMode = updates.selectionAnchorMode;
                            if (updates._multiSelectionExplicitPivot !== undefined) _multiSelectionExplicitPivot = updates._multiSelectionExplicitPivot;
                        };

                        let handled = processVertexSnap(selectedVertexKeys, {
                            isVertexMode,
                            gizmoMode: transformControls!.mode,
                            currentSelection, loadedObjectGroup, selectionHelper: selectionHelper!,
                            getGizmoState, setGizmoState, setMultiAnchorInitial: _setMultiAnchorInitial,
                            getGroups, getGroupWorldMatrixWithFallback: Overlay.getGroupWorldMatrixWithFallback, getGroupWorldMatrix,
                            updateHelperPosition, updateSelectionOverlay,
                            recomputePivotStateForSelection: _recomputePivotStateForSelection,
                            _isMultiSelection, _getSingleSelectedGroupId, SelectionCenter,
                            vertexQueue
                        });

                        if (!handled && transformControls!.mode === 'rotate') {
                            handled = processVertexRotate(selectedVertexKeys, {
                                isVertexMode,
                                gizmoMode: transformControls!.mode,
                                currentSelection, loadedObjectGroup, selectionHelper: selectionHelper!,
                                getGizmoState, setGizmoState, setMultiAnchorInitial: _setMultiAnchorInitial,
                                getGroups, getGroupWorldMatrixWithFallback: Overlay.getGroupWorldMatrixWithFallback,
                                updateHelperPosition, updateSelectionOverlay,
                                recomputePivotStateForSelection: _recomputePivotStateForSelection,
                                SelectionCenter,
                                vertexQueue
                            });
                        }

                        if (!handled && transformControls!.mode === 'scale') {
                            handled = processVertexScale(selectedVertexKeys, {
                                isVertexMode,
                                gizmoMode: transformControls!.mode,
                                isCtrlDown: event.ctrlKey || event.metaKey,
                                currentSelection, loadedObjectGroup, selectionHelper: selectionHelper!,
                                getGizmoState, setGizmoState, setMultiAnchorInitial: _setMultiAnchorInitial,
                                getGroups, getGroupWorldMatrixWithFallback: Overlay.getGroupWorldMatrixWithFallback,
                                updateHelperPosition, updateSelectionOverlay,
                                recomputePivotStateForSelection: _recomputePivotStateForSelection,
                                SelectionCenter,
                                vertexQueue,
                                getSelectedItems
                            });
                        }

                        if (handled && vertexHistoryBefore) recordSceneChange(loadedObjectGroup, vertexHistoryBefore);
                    }
                }

                Overlay.refreshSelectionPointColors(selectedVertexKeys);
                mouseDownPos = null;
                return;
            }
        }

        if (dragControls.onPointerDown(event)) {
            mouseDownPos = { x: event.clientX, y: event.clientY };
            cameraMatrixOnPointerDown.copy(camera.matrixWorld);
            return;
        }

        mouseDownPos = { x: event.clientX, y: event.clientY };
        cameraMatrixOnPointerDown.copy(camera.matrixWorld);
    }, true);

    renderer.domElement.addEventListener('pointermove', (event: PointerEvent) => {
        dragControls.onPointerMove(event);
    });

    renderer.domElement.addEventListener('pointerup', (event: PointerEvent) => {
        if (dragControls.onPointerUp(event)) {
            mouseDownPos = null;
            return;
        }

        if (!mouseDownPos) return;

        if (!camera.matrixWorld.equals(cameraMatrixOnPointerDown)) {
            mouseDownPos = null;
            return;
        }

        const dist = Math.hypot(event.clientX - mouseDownPos.x, event.clientY - mouseDownPos.y);
        if (dist > 5) { mouseDownPos = null; return; }
        mouseDownPos = null;

        const rect = renderer.domElement.getBoundingClientRect();
        mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(mouse, camera);

        Select.handleSelectionClick(raycaster, event, loadedObjectGroup, {
            onDeselect: resetSelectionAndDeselect,
            recomputePivotState: _recomputePivotStateForSelection,
            updateHelperPosition: updateHelperPosition,
            updateSelectionOverlay: updateSelectionOverlay,
            pushToVertexQueue: _pushToVertexQueue,
            hasVertexQueue: () => vertexQueue.length > 0,
            revertEphemeralPivotUndoIfAny: _revertEphemeralPivotUndoIfAny,
            detachTransformControls: () => { if (transformControls) transformControls.detach(); },
            clearGizmoAnchor: _clearGizmoAnchor,
            setSelectionAnchorMode: (mode: 'default' | 'center') => { _selectionAnchorMode = mode; },
            resetPivotState: () => {
                pivotOffset.set(0, 0, 0);
                isCustomPivot = false;
            },
            isVertexMode: isVertexMode
        });
    });

    window.addEventListener('pde:scene-updated', _handleSceneUpdated);
    window.addEventListener('pde:multi-selection-pivot-change', event => {
        if (!_isMultiSelection() || !selectionHelper) return;
        const pivotWorld = (event as CustomEvent<Vector3>).detail;
        selectionHelper.position.copy(pivotWorld);
        selectionHelper.updateMatrixWorld();
        CustomPivot.commitPivotEditFromDragEnd({
            pivotWorldPos: pivotWorld,
            isMultiPivotEdit: true,
            singleGroupId: null,
            currentSelection,
            loadedObjectGroup
        });
        pivotMode = 'origin';
        isCustomPivot = true;
        _multiSelectionExplicitPivot = true;
        _multiSelectionOriginAnchorPosition.copy(pivotWorld);
        _multiSelectionOriginAnchorValid = true;
        _gizmoAnchorPosition.copy(pivotWorld);
        _gizmoAnchorValid = true;
        _setMultiAnchorInitial(pivotWorld);
        previousHelperMatrix.copy(selectionHelper.matrixWorld);
        updateSelectionOverlay();
    });
    window.addEventListener('pde:replace-object-selection', event => {
        const replacements = (event as CustomEvent<Array<{
            oldMesh: PdeMesh;
            oldInstanceId: number;
            oldLastInstanceId: number;
            mesh: PdeMesh;
            instanceId: number;
        }>>).detail;
        const preservedAnchor = _isMultiSelection() && _multiSelectionOriginAnchorValid
            ? _multiSelectionOriginAnchorPosition.clone()
            : null;
        const preservedPivotState = preservedAnchor ? {
            isCustomPivot,
            pivotOffset: pivotOffset.clone(),
            explicitPivot: _multiSelectionExplicitPivot,
            anchorMode: _selectionAnchorMode
        } : null;
        const objects = new Map(Array.from(currentSelection.objects, ([selectedMesh, ids]) => [selectedMesh, new Set(ids)]));
        let primary = currentSelection.primary;
        let primaryReplacement: { mesh: PdeMesh; instanceId: number } | null = null;
        const replacedSelections: Array<{ mesh: PdeMesh; instanceId: number }> = [];
        let changed = false;
        for (const { oldMesh, oldInstanceId, oldLastInstanceId, mesh, instanceId } of replacements) {
            const oldIds = objects.get(oldMesh);
            const replaced = oldIds?.delete(oldInstanceId) ?? false;
            const moved = oldInstanceId < oldLastInstanceId && (oldIds?.delete(oldLastInstanceId) ?? false);
            if (moved) oldIds!.add(oldInstanceId);
            if (oldIds?.size === 0) objects.delete(oldMesh);
            if (replaced) replacedSelections.push({ mesh, instanceId });
            changed ||= replaced || moved;

            if (primary?.type === 'object' && primary.mesh === oldMesh) {
                if (primary.instanceId === oldInstanceId) {
                    primary = null;
                    primaryReplacement = { mesh, instanceId };
                }
                else if (moved && primary.instanceId === oldLastInstanceId) primary = { type: 'object', mesh: oldMesh, instanceId: oldInstanceId };
            }
        }
        if (!changed) return;
        for (const { mesh, instanceId } of replacedSelections) {
            const ids = objects.get(mesh) ?? new Set<number>();
            ids.add(instanceId);
            objects.set(mesh, ids);
        }
        if (primaryReplacement) primary = { type: 'object', ...primaryReplacement };
        if (preservedAnchor) _multiSelectionOriginAnchorInitialLocalValid = false;
        _replaceSelectionWithGroupsAndObjects(new Set(currentSelection.groups), objects, {
            preserveAnchors: true,
            explicitPrimary: primary
        });
        if (preservedAnchor && preservedPivotState) {
            isCustomPivot = preservedPivotState.isCustomPivot;
            pivotOffset.copy(preservedPivotState.pivotOffset);
            _multiSelectionExplicitPivot = preservedPivotState.explicitPivot;
            _selectionAnchorMode = preservedPivotState.anchorMode;
            _multiSelectionOriginAnchorPosition.copy(preservedAnchor);
            _multiSelectionOriginAnchorValid = true;
            const lockPreservedAnchor = pivotMode === 'origin'
                && (_selectionAnchorMode !== 'center' || _multiSelectionExplicitPivot || isCustomPivot);
            if (lockPreservedAnchor) _setMultiAnchorInitial(preservedAnchor);
            updateHelperPosition();
            if (!lockPreservedAnchor) _setMultiAnchorInitial(_multiSelectionOriginAnchorPosition);
            updateSelectionOverlay();
            if (import.meta.env.DEV) {
                const resolvedAnchor = _resolveMultiAnchorInitialWorld(new Vector3());
                console.assert(
                    !!resolvedAnchor && resolvedAnchor.distanceTo(_multiSelectionOriginAnchorPosition) < 1e-6,
                    'Display replacement changed the multi-selection anchor.'
                );
            }
        }
    });

    return {
        setCamera: (nextCamera: Camera) => {
            camera = nextCamera;
            transformControls!.camera = nextCamera;
        },
        getTransformControls: () => transformControls!,
        updateGizmo: () => {
            flushSelectionTransform();

            if (_hasAnySelection() && transformControls!.object &&
                (transformControls!.mode === 'translate' || transformControls!.mode === 'scale')) {

                const gizmoPos = transformControls!.object.position;
                const camPos = camera.position;
                const direction = camPos.clone().sub(gizmoPos).normalize();
                if (currentSpace === 'local') direction.applyQuaternion(transformControls!.object.quaternion.clone().invert());

                for (const axis of ['X', 'Y', 'Z'] as const) {
                    const isPositive = direction[axis.toLowerCase() as 'x' | 'y' | 'z'] > 0;
                    const currentDirection = isPositive ? 'positive' : 'negative';
                    if (currentDirection !== lastDirections[axis]) {
                        lastDirections[axis] = currentDirection;
                        if (isPositive) {
                            setGizmoMaterialOpacity(gizmoLines[axis].original, 1);
                            setGizmoMaterialOpacity(gizmoLines[axis].negative, 0.001);
                        } else {
                            setGizmoMaterialOpacity(gizmoLines[axis].negative, 1);
                            setGizmoMaterialOpacity(gizmoLines[axis].original, 0.001);
                        }
                    }
                }

                (['XY', 'YZ', 'XZ'] as const).forEach(planeName => {
                    const visibleDirection = getPlaneDirection(planeName, direction);
                    if (visibleDirection === lastDirections[planeName]) return;

                    lastDirections[planeName] = visibleDirection;
                    Object.entries(gizmoPlanes[planeName].variants).forEach(([variantDirection, meshes]) => {
                        const opacity = variantDirection === visibleDirection
                            ? ((meshes[0]?.material as GizmoMaterial | undefined)?._pdeVisibleOpacity ?? 1)
                            : 0.001;
                        setGizmoMaterialOpacity(meshes, opacity);
                    });
                });
            }
        },
        resetSelection: resetSelectionAndDeselect,
        getSelectedObject: () => (currentSelection.primary && currentSelection.primary.type === 'object' ? currentSelection.primary.mesh : null),
        createGroup: createGroup,
        getGroups: getGroups,
        hasSelection: _hasAnySelection,
        flipSelected,
        setMirrorModeling
    };
}
