import { setupGizmo } from './gizmo-setup';
import type { GizmoLines, GizmoMaterial } from './gizmo-setup';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import * as THREE from 'three/webgpu';
import {
    blockbenchScaleMode,
    computeBlockbenchPivotFrame,
    transformBoxToPivotFrame,
    detectBlockbenchScaleAxes,
    computeBlockbenchScaleShift
} from './blockbench-scale';
import * as GroupUtils from './group';
import * as Overlay from './overlay';
import * as CustomPivot from './custom-pivot';
import * as Duplicate from './duplicate';
import * as Delete from './delete';
import { initDrag, applyDeltaToSelection } from './drag';
import { initHandleKey } from './handle-key';
import type { DragInterface } from './drag';
import { processVertexSnap } from './vertex-translate';
import { processVertexRotate } from './vertex-rotate';
import { processVertexScale } from './vertex-scale';
import * as Select from './select';
import type { SelectionState } from './select';
import type { GroupData } from './group';
import type { QueueItem } from './vertex-swap';
import * as VertexQueue from './vertex-queue';

// Interfaces 

type PdeMesh = THREE.InstancedMesh | THREE.BatchedMesh | THREE.Mesh;

interface OrbitControlsLike {
    enabled: boolean;
    target: THREE.Vector3;
    screenSpacePanning: boolean;
    dispose(): void;
    update(): boolean;
}

export interface GizmoState {
    pivotMode: string;
    isCustomPivot: boolean;
    pivotOffset: THREE.Vector3;
    _gizmoAnchorValid: boolean;
    _gizmoAnchorPosition: THREE.Vector3;
    _multiSelectionOriginAnchorValid: boolean;
    _multiSelectionOriginAnchorPosition: THREE.Vector3;
    _multiSelectionOriginAnchorInitialValid: boolean;
    _multiSelectionOriginAnchorInitialPosition: THREE.Vector3;
}

export interface InitGizmoParams {
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    renderer: THREE.Renderer;
    controls: OrbitControlsLike;
    loadedObjectGroup: THREE.Group;
    setControls?: (c: OrbitControlsLike) => void;
}

export interface InitGizmoResult {
    getTransformControls: () => TransformControls;
    updateGizmo: () => void;
    resetSelection: () => void;
    getSelectedObject: () => THREE.Object3D | null;
    createGroup: () => string | undefined;
    getGroups: () => Map<string, GroupData>;
}

//  Aliases 
const getInstanceCount = Overlay.getInstanceCount;
const isInstanceValid = Overlay.isInstanceValid;
const getDisplayType = Overlay.getDisplayType;
const isItemDisplayHatEnabled = Overlay.isItemDisplayHatEnabled;
const getInstanceLocalBoxMin = Overlay.getInstanceLocalBoxMin;
const getInstanceWorldMatrixForOrigin = Overlay.getInstanceWorldMatrixForOrigin;
const getGroupWorldMatrixWithFallback = Overlay.getGroupWorldMatrixWithFallback;
const unionTransformedBox3 = Overlay.unionTransformedBox3;
const getInstanceLocalBox = Overlay.getInstanceLocalBox;
const getInstanceWorldMatrix = Overlay.getInstanceWorldMatrix;
const getGroupLocalBoundingBox = Overlay.getGroupLocalBoundingBox;
const getRotationFromMatrix = Overlay.getRotationFromMatrix;
const getSelectionBoundingBox = () => Overlay.getSelectionBoundingBox(currentSelection);

//  Shared temporaries 

const _TMP_MAT4_A = new THREE.Matrix4();
const _TMP_MAT4_B = new THREE.Matrix4();
const _TMP_VEC3_A = new THREE.Vector3();
const _TMP_VEC3_B = new THREE.Vector3();

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

function getGroupKey(mesh: THREE.Object3D, instanceId: number): string {
    return GroupUtils.getGroupKey(mesh, instanceId);
}

function getGroupChain(startGroupId: string): string[] {
    return GroupUtils.getGroupChain(loadedObjectGroup, startGroupId);
}

//  Group pivot helpers 

const _DEFAULT_GROUP_PIVOT = GroupUtils.DEFAULT_GROUP_PIVOT;
const _ZERO_VEC3 = new THREE.Vector3(0, 0, 0);

function normalizePivotToVector3(pivot: THREE.Vector3 | undefined, out = new THREE.Vector3()): THREE.Vector3 | null {
    return GroupUtils.normalizePivotToVector3(pivot, out);
}

function getGroupWorldMatrix(group: GroupData, out = new THREE.Matrix4()): THREE.Matrix4 {
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

let scene: THREE.Scene;
let camera: THREE.PerspectiveCamera;
let renderer: THREE.Renderer;
let controls: OrbitControlsLike;
let loadedObjectGroup: THREE.Group;
let transformControls: TransformControls | null = null;
let selectionHelper: THREE.Mesh | null = null;
let previousHelperMatrix = new THREE.Matrix4();

//  Selection state 

const currentSelection: SelectionState = Select.currentSelection;
const selectedVertexKeys = new Set<string>();
const vertexQueue: QueueItem[] = [];
let suppressVertexQueue = false;

function _pushToVertexQueue(): void {
    VertexQueue.pushToVertexQueue({
        suppressVertexQueue,
        isVertexMode,
        currentSelection,
        selectedVertexKeys,
        vertexQueue,
        selectionHelper,
        getSelectionCenterWorld: _getSelectionCenterWorld
    });
}

//  Pivot / anchor state 

let pivotMode = 'origin';
let currentSpace: 'world' | 'local' = 'world';
let lastDirections: Record<string, string | null> = { X: null, Y: null, Z: null };

const _gizmoAnchorPosition = new THREE.Vector3();
let _gizmoAnchorValid = false;

const _multiSelectionOriginAnchorPosition = new THREE.Vector3();
let _multiSelectionOriginAnchorValid = false;

const _multiSelectionOriginAnchorInitialPosition = new THREE.Vector3();
let _multiSelectionOriginAnchorInitialValid = false;
const _multiSelectionOriginAnchorInitialLocal = new THREE.Vector3();
let _multiSelectionOriginAnchorInitialLocalValid = false;

let _multiSelectionExplicitPivot = false;
const _multiSelectionAccumulatedRotation = new THREE.Quaternion();
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

function _getPrimaryWorldMatrix(out = new THREE.Matrix4()): THREE.Matrix4 | null {
    if (!currentSelection.primary) return null;
    const prim = currentSelection.primary;
    if (prim.type === 'group') {
        const groups = getGroups();
        const group = groups.get(prim.id);
        if (!group) return null;
        getGroupWorldMatrix(group, out);
        return out;
    } else if (prim.type === 'object' && prim.mesh) {
        (prim.mesh as THREE.InstancedMesh).getMatrixAt(prim.instanceId, out);
        out.premultiply(prim.mesh.matrixWorld);
        return out;
    }
    return null;
}

function _setMultiAnchorInitial(worldPos: THREE.Vector3): void {
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

function _captureMultiAnchorInitialIfNeeded(worldPos: THREE.Vector3): void {
    if (_multiSelectionOriginAnchorInitialValid) return;
    _setMultiAnchorInitial(worldPos);
}

function _resolveMultiAnchorInitialWorld(out = new THREE.Vector3()): THREE.Vector3 | null {
    if (_multiSelectionOriginAnchorInitialLocalValid) {
        const mat = _getPrimaryWorldMatrix(_TMP_MAT4_B);
        if (mat) return out.copy(_multiSelectionOriginAnchorInitialLocal).applyMatrix4(mat);
    }
    return null;
}

function _getSelectionCenterWorld(out = new THREE.Vector3()): THREE.Vector3 {
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

function _replaceSelectionWithGroupsAndObjects(groupIds: Set<string>, meshToIds: Map<PdeMesh, Set<number>>, options?: { anchorMode?: string; preserveAnchors?: boolean }): void {
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

const dragInitialMatrix = new THREE.Matrix4();
const dragInitialQuaternion = new THREE.Quaternion();
const dragInitialScale = new THREE.Vector3();
const dragInitialPosition = new THREE.Vector3();
const dragInitialBoundingBox = new THREE.Box3();
const dragStartAvgOrigin = new THREE.Vector3();
const dragStartPivotBaseWorld = new THREE.Vector3();
let draggingMode: string | null = null;
let isGizmoBusy = false;
let dragAnchorDirections: { x: boolean; y: boolean; z: boolean } = { x: true, y: true, z: true };
let previousGizmoMode = 'translate';
let isPivotEditMode = false;
let isVertexMode = false;
let isUniformScale = false;
let isCustomPivot = false;
let pivotOffset = new THREE.Vector3(0, 0, 0);

const _tmpPrevInvMatrix = new THREE.Matrix4();
const _tmpDeltaMatrix = new THREE.Matrix4();
const _meshToInstanceIds = new Map<THREE.Object3D, number[]>();

//  Selection helpers 

function getGroupRotationQuaternion(groupId: string | null, out = new THREE.Quaternion()): THREE.Quaternion {
    if (!groupId) return out.set(0, 0, 0, 1);
    const m = getGroupWorldMatrixWithFallback(groupId, _TMP_MAT4_A);
    const q = getRotationFromMatrix(m);
    return out.copy(q);
}

function SelectionCenter(pivotMode: string, isCustomPivot: boolean, pivotOffset: THREE.Vector3): THREE.Vector3 {
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

function updateSelectionOverlay(): void {
    Overlay.updateSelectionOverlay(scene, renderer, camera, currentSelection, vertexQueue, isVertexMode, selectionHelper, selectedVertexKeys);
    window.dispatchEvent(new CustomEvent('pde:selection-changed', { detail: currentSelection }));
}

function _updateMultiSelectionOverlayDuringDrag(): void {
    Overlay.updateMultiSelectionOverlayDuringDrag(currentSelection, selectionHelper!.matrixWorld, dragInitialMatrix);
}

function resetSelectionAndDeselect(): void {
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
        lastDirections = { X: null, Y: null, Z: null };
        console.log('선택 제거');
    }
}

function updateHelperPosition(): void {
    const items = getSelectedItems();
    if (items.length === 0 && !_hasAnySelection()) return;

    const isMulti = _isMultiSelection();

    if (!isCustomPivot && !_multiSelectionOriginAnchorValid && _isMultiSelection() && currentSelection.primary) {
        let primaryPivotWorld: THREE.Vector3 | null = null;
        const prim = currentSelection.primary;

        if (prim.type === 'group') {
            const groups = getGroups();
            const group = groups.get(prim.id);
            if (group) {
                if (shouldUseGroupPivot(group)) {
                    const localPivot = normalizePivotToVector3(group.pivot, _TMP_VEC3_A);
                    if (localPivot) {
                        const groupMatrix = getGroupWorldMatrix(group, _TMP_MAT4_A);
                        primaryPivotWorld = localPivot.applyMatrix4(groupMatrix);
                    }
                }
                if (!primaryPivotWorld) {
                    primaryPivotWorld = Overlay.getGroupOriginWorld(prim.id, _TMP_VEC3_A);
                }
            }
        } else if (prim.type === 'object') {
            const { mesh, instanceId } = prim;
            if (mesh) {
                let custom: THREE.Vector3 | null = null;
                if ((mesh as THREE.BatchedMesh).isBatchedMesh || (mesh as THREE.InstancedMesh).isInstancedMesh) {
                    if (mesh.userData.customPivots && mesh.userData.customPivots.has(instanceId)) {
                        custom = mesh.userData.customPivots.get(instanceId);
                    }
                } else {
                    if (mesh.userData.customPivot) custom = mesh.userData.customPivot;
                }

                if (custom) {
                    const tempMat = _TMP_MAT4_A;
                    (mesh as THREE.InstancedMesh).getMatrixAt(instanceId, tempMat);
                    tempMat.premultiply(mesh.matrixWorld);
                    primaryPivotWorld = custom.clone().applyMatrix4(tempMat);
                } else {
                    const displayType = getDisplayType(mesh, instanceId);
                    if (displayType === 'block_display') {
                        const localPivot = getInstanceLocalBoxMin(mesh, instanceId, _TMP_VEC3_B);
                        if (localPivot) {
                            const worldMatrix = getInstanceWorldMatrixForOrigin(mesh, instanceId, _TMP_MAT4_A);
                            primaryPivotWorld = localPivot.applyMatrix4(worldMatrix);
                        }
                    }
                    if (!primaryPivotWorld) {
                        const tempMat = _TMP_MAT4_A;
                        getInstanceWorldMatrixForOrigin(mesh, instanceId, tempMat);
                        const localY = isItemDisplayHatEnabled(mesh, instanceId) ? 0.03125 : 0;
                        primaryPivotWorld = _TMP_VEC3_B.set(0, localY, 0).applyMatrix4(tempMat);
                    }
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

    const lockMultiOrigin = (pivotMode === 'origin') && isMulti && _multiSelectionOriginAnchorValid;
    if (lockMultiOrigin) {
        // 로컬 좌표에서 world 위치 재계산: center 모드에서 이동 후 world 앵커가 stale 되는 문제 원천 차단
        const refreshedFromLocal = _resolveMultiAnchorInitialWorld(new THREE.Vector3());
        if (refreshedFromLocal) {
            _multiSelectionOriginAnchorPosition.copy(refreshedFromLocal);
        }
        selectionHelper!.position.copy(_multiSelectionOriginAnchorPosition);
        _gizmoAnchorPosition.copy(_multiSelectionOriginAnchorPosition);
        _gizmoAnchorValid = true;
    } else {
        const center = (_selectionAnchorMode === 'center')
            ? _getSelectionCenterWorld(new THREE.Vector3())
            : SelectionCenter(pivotMode, isCustomPivot, pivotOffset);
        selectionHelper!.position.copy(center);
        _gizmoAnchorPosition.copy(center);
        _gizmoAnchorValid = true;

        if (pivotMode === 'origin' && isMulti) {
            _multiSelectionOriginAnchorPosition.copy(center);
            _multiSelectionOriginAnchorValid = true;
            // NOTE: center 는 SelectionCenter 계산값(world 평균)이므로
            // primary 로컬 초기값 캡처에 사용하지 않음.
            // 로컬 초기값 캡처는 Block 1(primaryPivotWorld)에서만 수행.
        }
    }

    const gizmoPos = selectionHelper!.position;

    let localPos: THREE.Vector3 | null = null;
    if (currentSelection.primary) {
        const prim = currentSelection.primary;
        const tempMat = _TMP_MAT4_A;
        if (prim.type === 'group') {
            getGroupWorldMatrixWithFallback(prim.id, tempMat);
        } else {
            getInstanceWorldMatrix(prim.mesh, prim.instanceId, tempMat);
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
                        (mesh as THREE.InstancedMesh).getMatrixAt(instanceId, instanceMatrix);
                        const worldMatrix = instanceMatrix.premultiply(mesh.matrixWorld);
                        selectionHelper!.quaternion.copy(getRotationFromMatrix(worldMatrix));
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

function applySelection(mesh: THREE.Object3D | null, instanceIds: number[], groupId: string | null = null): void {
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

function createGroup(): string | undefined {
    suppressVertexQueue = true;
    vertexQueue.length = 0;

    const items = getSelectedItems();
    if (items.length === 0 && !_hasAnySelection()) {
        suppressVertexQueue = false;
        return undefined;
    }

    const groups = getGroups();

    let initialPosition = new THREE.Vector3();
    const singleGroupId = _getSingleSelectedGroupId();
    if (singleGroupId) {
        const existingGroup = groups.get(singleGroupId);
        if (existingGroup && existingGroup.position) initialPosition.copy(existingGroup.position);
        else initialPosition = Select.calculateAvgOrigin();
    } else {
        initialPosition = Select.calculateAvgOrigin();
    }

    const selectedGroupIds = currentSelection.groups ? Array.from(currentSelection.groups).filter(Boolean) : [];
    const selectedObjects: Array<{ mesh: PdeMesh; instanceId: number }> = [];
    if (currentSelection.objects && currentSelection.objects.size > 0) {
        for (const [mesh, ids] of currentSelection.objects) {
            if (!mesh || !ids) continue;
            for (const id of ids) {
                selectedObjects.push({ mesh, instanceId: id });
            }
        }
    }

    const newGroupId = GroupUtils.createGroupStructure(loadedObjectGroup, selectedGroupIds, selectedObjects, initialPosition);

    invalidateSelectionCaches();
    applySelection(null, [], newGroupId);
    suppressVertexQueue = false;

    console.log(`Group created: ${newGroupId}`);
    return newGroupId;
}

function ungroupGroup(groupId: string): void {
    suppressVertexQueue = true;
    vertexQueue.length = 0;

    if (!groupId) { suppressVertexQueue = false; return; }

    const result = GroupUtils.ungroupGroupStructure(loadedObjectGroup, groupId);
    if (!result) { suppressVertexQueue = false; return; }

    const { parentId } = result;

    invalidateSelectionCaches();

    if (parentId && getGroups().has(parentId)) {
        applySelection(null, [], parentId);
    } else {
        resetSelectionAndDeselect();
    }

    suppressVertexQueue = false;
    console.log(`Group removed: ${groupId}`);
}

function deleteSelectedItems(): void {
    suppressVertexQueue = true;
    vertexQueue.length = 0;

    if (!_hasAnySelection()) {
        suppressVertexQueue = false;
        return;
    }

    try {
        Delete.deleteSelectedItems(loadedObjectGroup, currentSelection, { resetSelectionAndDeselect });
    } finally {
        suppressVertexQueue = false;
    }
}

function duplicateSelected(): void {
    suppressVertexQueue = true;
    vertexQueue.length = 0;
    try {
        if (!_hasAnySelection()) return;

        // 복제 후에도 커스텀 피벗 상태 유지: duplicate 후 선택 교체 시에도 커스텀 피벗 오프셋 보존.
        const savedIsCustomPivot = isCustomPivot;
        const savedPivotOffset = pivotOffset.clone();
        const hadPrimary = !!currentSelection.primary;

        const selectedGroupIds = currentSelection.groups;
        const selectedObjects: Array<{ mesh: PdeMesh; instanceId: number }> = [];
        if (currentSelection.objects) {
            for (const [mesh, ids] of currentSelection.objects) {
                for (const id of ids) selectedObjects.push({ mesh, instanceId: id });
            }
        }

        const newSel = Duplicate.duplicateGroupsAndObjects(loadedObjectGroup, selectedGroupIds, selectedObjects);

        const preserveAnchors = _isMultiSelection();
        const anchorMode = _selectionAnchorMode;
        _beginSelectionReplace({ anchorMode, detachTransform: false, preserveAnchors });
        currentSelection.groups = newSel.groups;
        currentSelection.objects = newSel.objects;

        if (hadPrimary || !_isMultiSelection()) {
            _setPrimaryToFirstAvailable();
        } else {
            currentSelection.primary = null;
        }

        invalidateSelectionCaches();
        _recomputePivotStateForSelection();

        if (savedIsCustomPivot) {
            isCustomPivot = true;
            pivotOffset.copy(savedPivotOffset);
        }

        updateHelperPosition();
        updateSelectionOverlay();

        console.log('Duplication complete');
    } finally {
        suppressVertexQueue = false;
    }
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

    if (!loadedObjectGroup.userData.groups) loadedObjectGroup.userData.groups = new Map();
    if (!loadedObjectGroup.userData.objectToGroup) loadedObjectGroup.userData.objectToGroup = new Map();

    selectionHelper = new THREE.Mesh(
        new THREE.BoxGeometry(0.1, 0.1, 0.1),
        new THREE.MeshBasicMaterial({ visible: false })
    );
    scene.add(selectionHelper);

    const mouseInput = new THREE.Vector2();
    let detectedAnchorDirections: { x: boolean | null; y: boolean | null; z: boolean | null } = { x: null, y: null, z: null };

    renderer.domElement.addEventListener('pointerdown', (event: PointerEvent) => {
        const rect = renderer.domElement.getBoundingClientRect();
        mouseInput.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        mouseInput.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

        detectedAnchorDirections = { x: null, y: null, z: null };

        if (!transformControls!.dragging) {
            raycaster.setFromCamera(mouseInput, camera);
            const gizmo = transformControls!.getHelper();
            const intersects = raycaster.intersectObject(gizmo, true);

            if (intersects.length > 0) {
                const object = intersects[0].object;
                if (object.name === 'XYZ') {
                    isUniformScale = true;
                } else {
                    isUniformScale = false;
                    const check = (axis: string): boolean | null => {
                        if (gizmoLines[axis as keyof GizmoLines].negative.includes(object as THREE.Mesh)) return false;
                        if (gizmoLines[axis as keyof GizmoLines].original.includes(object as THREE.Mesh)) return true;
                        return null;
                    };
                    detectedAnchorDirections.x = check('X');
                    detectedAnchorDirections.y = check('Y');
                    detectedAnchorDirections.z = check('Z');
                }
            }
        }
    }, true);

    const setupResult = setupGizmo(camera, renderer as THREE.Renderer, scene);
    transformControls = setupResult.transformControls;
    gizmoLines = setupResult.gizmoLines;

    transformControls.addEventListener('dragging-changed', (event: { value: boolean }) => {
        controls.enabled = !event.value;
        if (event.value) {
            Overlay.prepareMultiSelectionDrag(currentSelection);
            draggingMode = transformControls!.mode;

            const items = getSelectedItems();
            _meshToInstanceIds.clear();
            for (const { mesh, instanceId } of items) {
                if (!mesh) continue;
                let list = _meshToInstanceIds.get(mesh);
                if (!list) {
                    list = [];
                    _meshToInstanceIds.set(mesh, list);
                }
                list.push(instanceId);
            }

            if (transformControls!.axis === 'XYZ') isUniformScale = true;

            dragInitialMatrix.copy(selectionHelper!.matrix);
            dragInitialQuaternion.copy(selectionHelper!.quaternion);
            dragInitialScale.copy(selectionHelper!.scale);
            dragInitialPosition.copy(selectionHelper!.position);

            if (isPivotEditMode) {
                dragStartPivotBaseWorld.copy(SelectionCenter('origin', false, _ZERO_VEC3));
                dragStartAvgOrigin.copy(Select.calculateAvgOrigin());
                CustomPivot.setPivotEditUndoCapture(null);
            }

            if (blockbenchScaleMode && draggingMode === 'scale' && !isUniformScale) {
                dragInitialBoundingBox.makeEmpty();

                selectionHelper!.updateMatrixWorld();
                computeBlockbenchPivotFrame(selectionHelper!, currentSpace);

                const singleGroupId = _getSingleSelectedGroupId();
                if (singleGroupId) {
                    const groupLocalBox = getGroupLocalBoundingBox(singleGroupId);
                    if (!groupLocalBox.isEmpty()) {
                        const groupWorldMat = getGroupWorldMatrixWithFallback(singleGroupId, _TMP_MAT4_A);
                        const combinedMat = transformBoxToPivotFrame(groupWorldMat, _TMP_MAT4_B);
                        unionTransformedBox3(dragInitialBoundingBox, groupLocalBox, combinedMat);
                    }
                } else {
                    const items = getSelectedItems();
                    if (items.length > 0) {
                        const tempMat = new THREE.Matrix4();
                        items.forEach(({ mesh, instanceId }) => {
                            const localBox = getInstanceLocalBox(mesh, instanceId);
                            if (!localBox) return;
                            getInstanceWorldMatrix(mesh, instanceId, tempMat);
                            const combinedMat = transformBoxToPivotFrame(tempMat, _TMP_MAT4_A);
                            unionTransformedBox3(dragInitialBoundingBox, localBox, combinedMat);
                        });
                    }
                }

                dragAnchorDirections = detectBlockbenchScaleAxes(camera, mouseInput, selectionHelper!, currentSpace, detectedAnchorDirections);
            }

        } else {
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
                if (commitResult.setMultiExplicitPivot) _multiSelectionExplicitPivot = true;

                if (_pivotEditPreviousPivotMode) {
                    pivotMode = _pivotEditPreviousPivotMode;
                }

                _gizmoAnchorPosition.copy(selectionHelper!.position);
                _gizmoAnchorValid = true;
                _selectionAnchorMode = 'default';

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

            if (currentSelection.objects && currentSelection.objects.size > 0) {
                for (const [mesh] of currentSelection.objects) {
                    if (mesh) (mesh as THREE.Mesh).boundingSphere = null;
                }
            }

            if (selectionHelper) {
                selectionHelper.scale.set(1, 1, 1);
                selectionHelper.updateMatrixWorld();
                previousHelperMatrix.copy(selectionHelper.matrixWorld);
            }
        }
    });

    transformControls.addEventListener('change', (_event: object) => {
        if (transformControls!.dragging && _hasAnySelection()) {

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
                return;
            }

            if (blockbenchScaleMode && transformControls!.mode === 'scale' && !isUniformScale) {
                const shiftWorld = computeBlockbenchScaleShift(selectionHelper!, dragInitialScale, dragInitialPosition, dragInitialBoundingBox, dragAnchorDirections, currentSpace);
                if (shiftWorld) {
                    selectionHelper!.position.copy(dragInitialPosition).add(shiftWorld);
                    selectionHelper!.updateMatrixWorld();
                }
            }

            selectionHelper!.updateMatrixWorld();
            _tmpPrevInvMatrix.copy(previousHelperMatrix).invert();
            _tmpDeltaMatrix.multiplyMatrices(selectionHelper!.matrixWorld, _tmpPrevInvMatrix);

            const items = getSelectedItems();
            _meshToInstanceIds.clear();
            for (const { mesh, instanceId } of items) {
                if (!mesh) continue;
                let list = _meshToInstanceIds.get(mesh);
                if (!list) { list = []; _meshToInstanceIds.set(mesh, list); }
                list.push(instanceId);
            }

            applyDeltaToSelection({
                deltaMatrix: _tmpDeltaMatrix,
                meshToInstanceIds: _meshToInstanceIds,
                selectedGroupIds: currentSelection.groups,
                loadedObjectGroup
            });

            previousHelperMatrix.copy(selectionHelper!.matrixWorld);
            Overlay.syncSelectionOverlay(_tmpDeltaMatrix);
            _updateMultiSelectionOverlayDuringDrag();
        }
    });

    initHandleKey({
        getIsVertexMode:                          () => isVertexMode,
        setIsVertexMode:                          (v) => { isVertexMode = v; },
        getCurrentSpace:                          () => currentSpace,
        setCurrentSpace:                          (v) => { currentSpace = v; },
        getPivotMode:                             () => pivotMode,
        setPivotMode:                             (v) => { pivotMode = v; },
        getIsCustomPivot:                         () => isCustomPivot,
        setIsCustomPivot:                         (v) => { isCustomPivot = v; },
        getIsGizmoBusy:                           () => isGizmoBusy,
        setIsGizmoBusy:                           (v) => { isGizmoBusy = v; },
        getIsPivotEditMode:                       () => isPivotEditMode,
        setIsPivotEditMode:                       (v) => { isPivotEditMode = v; },
        getPreviousGizmoMode:                     () => previousGizmoMode,
        setPreviousGizmoMode:                     (v) => { previousGizmoMode = v; },
        getPivotEditPreviousPivotMode:            () => _pivotEditPreviousPivotMode,
        setPivotEditPreviousPivotMode:            (v) => { _pivotEditPreviousPivotMode = v; },
        getMultiSelectionExplicitPivot:           () => _multiSelectionExplicitPivot,
        setMultiSelectionExplicitPivot:           (v) => { _multiSelectionExplicitPivot = v; },
        getMultiSelectionOriginAnchorValid:       () => _multiSelectionOriginAnchorValid,
        setMultiSelectionOriginAnchorValid:       (v) => { _multiSelectionOriginAnchorValid = v; },
        getMultiSelectionOriginAnchorInitialValid:      () => _multiSelectionOriginAnchorInitialValid,
        setMultiSelectionOriginAnchorInitialValid:      (v) => { _multiSelectionOriginAnchorInitialValid = v; },
        getMultiSelectionOriginAnchorInitialLocalValid:  () => _multiSelectionOriginAnchorInitialLocalValid,
        setMultiSelectionOriginAnchorInitialLocalValid:  (v) => { _multiSelectionOriginAnchorInitialLocalValid = v; },
        getGizmoAnchorValid:                      () => _gizmoAnchorValid,
        setGizmoAnchorValid:                      (v) => { _gizmoAnchorValid = v; },
        getSelectionAnchorMode:                   () => _selectionAnchorMode,
        setSelectionAnchorMode:                   (v) => { _selectionAnchorMode = v; },
        getControls:                              () => controls,
        setInternalControls:                      (v) => { controls = v; },

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

        camera,
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

        getInstanceCount,
        isInstanceValid,
        getDisplayType,
        getInstanceLocalBoxMin,
        getInstanceWorldMatrixForOrigin,
        isItemDisplayHatEnabled,
        prepareMultiSelectionDrag:                Overlay.prepareMultiSelectionDrag,
    });

    const raycaster = new THREE.Raycaster();
    raycaster.layers.enable(2);
    const mouse = new THREE.Vector2();
    let mouseDownPos: { x: number; y: number } | null = null;
    const cameraMatrixOnPointerDown = new THREE.Matrix4();

    function getHoveredVertex(mouseNDC: THREE.Vector2): THREE.Sprite | null {
        if (!isVertexMode) return null;
        return Overlay.getHoveredVertex(mouseNDC, camera, renderer);
    }

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
            const m = new THREE.Vector2(
                ((event.clientX - rect.left) / rect.width) * 2 - 1,
                -((event.clientY - rect.top) / rect.height) * 2 + 1
            );

            const hovered = getHoveredVertex(m);
            Overlay.updateVertexHoverHighlight(hovered, selectedVertexKeys);

            if (hovered) {
                renderer.domElement.style.cursor = 'pointer';
            } else if (isVertexMode) {
                renderer.domElement.style.cursor = '';
            }
        }
    });

    loadedObjectGroup.userData.resetSelection = resetSelectionAndDeselect;
    loadedObjectGroup.userData.replaceSelectionWithObjectsMap = (meshToIds: Map<PdeMesh, Set<number>>, options?: { anchorMode?: string }) => {
        _replaceSelectionWithObjectsMap(meshToIds, options);
    };
    loadedObjectGroup.userData.replaceSelectionWithGroupsAndObjects = (groupIds: Set<string>, meshToIds: Map<PdeMesh, Set<number>>, options?: { anchorMode?: string; preserveAnchors?: boolean }) => {
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

        if (isVertexMode) {
            const rect = renderer.domElement.getBoundingClientRect();
            const m = new THREE.Vector2(
                ((event.clientX - rect.left) / rect.width) * 2 - 1,
                -((event.clientY - rect.top) / rect.height) * 2 + 1
            );

            const v = getHoveredVertex(m);
            if (v && v.userData && v.userData.key) {
                const key = v.userData.key as string;

                if (selectedVertexKeys.has(key)) {
                    selectedVertexKeys.delete(key);
                } else {
                    selectedVertexKeys.add(key);

                    if (selectedVertexKeys.size === 2) {
                        const getGizmoState = (): GizmoState => ({
                            pivotMode, isCustomPivot, pivotOffset,
                            _gizmoAnchorValid, _gizmoAnchorPosition,
                            _multiSelectionOriginAnchorValid, _multiSelectionOriginAnchorPosition,
                            _multiSelectionOriginAnchorInitialValid, _multiSelectionOriginAnchorInitialPosition
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
                        };

                        const handled = processVertexSnap(selectedVertexKeys, {
                            isVertexMode,
                            gizmoMode: transformControls!.mode,
                            currentSelection, loadedObjectGroup, selectionHelper: selectionHelper!,
                            getGizmoState, setGizmoState,
                            getGroups, getGroupWorldMatrixWithFallback, getGroupWorldMatrix,
                            updateHelperPosition, updateSelectionOverlay,
                            _isMultiSelection, _getSingleSelectedGroupId, SelectionCenter,
                            vertexQueue
                        });

                        if (!handled && transformControls!.mode === 'rotate') {
                            processVertexRotate(selectedVertexKeys, {
                                isVertexMode,
                                gizmoMode: transformControls!.mode,
                                currentSelection, loadedObjectGroup, selectionHelper: selectionHelper!,
                                getGizmoState, setGizmoState,
                                getGroups, getGroupWorldMatrixWithFallback,
                                updateHelperPosition, updateSelectionOverlay,
                                SelectionCenter,
                                vertexQueue
                            });
                        }

                        if (!handled && transformControls!.mode === 'scale') {
                            processVertexScale(selectedVertexKeys, {
                                isVertexMode,
                                gizmoMode: transformControls!.mode,
                                isCtrlDown: event.ctrlKey || event.metaKey,
                                currentSelection, loadedObjectGroup, selectionHelper: selectionHelper!,
                                getGizmoState, setGizmoState,
                                getGroups, getGroupWorldMatrixWithFallback,
                                updateHelperPosition, updateSelectionOverlay,
                                SelectionCenter,
                                vertexQueue,
                                getSelectedItems
                            });
                        }
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

        const dist = Math.sqrt((event.clientX - mouseDownPos.x) ** 2 + (event.clientY - mouseDownPos.y) ** 2);
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

    return {
        getTransformControls: () => transformControls!,
        updateGizmo: () => {
            if (_hasAnySelection() && transformControls!.object &&
                (transformControls!.mode === 'translate' || transformControls!.mode === 'scale')) {

                const gizmoPos = transformControls!.object.position;
                const camPos = camera.position;
                const direction = camPos.clone().sub(gizmoPos).normalize();
                if (currentSpace === 'local') direction.applyQuaternion(transformControls!.object.quaternion.clone().invert());

                const axesConfig: Record<string, { originalLines: THREE.Mesh[]; negativeLines: THREE.Mesh[]; getDirection: () => boolean }> = {
                    X: { originalLines: gizmoLines.X.original, negativeLines: gizmoLines.X.negative, getDirection: () => direction.x > 0 },
                    Y: { originalLines: gizmoLines.Y.original, negativeLines: gizmoLines.Y.negative, getDirection: () => direction.y > 0 },
                    Z: { originalLines: gizmoLines.Z.original, negativeLines: gizmoLines.Z.negative, getDirection: () => direction.z > 0 }
                };

                for (const axis in axesConfig) {
                    const { originalLines, negativeLines, getDirection } = axesConfig[axis];
                    const isPositive = getDirection();
                    const currentDirection = isPositive ? 'positive' : 'negative';
                    if (currentDirection !== lastDirections[axis]) {
                        lastDirections[axis] = currentDirection;
                        if (isPositive) {
                            originalLines.forEach(line => { if (line.material) { (line.material as GizmoMaterial).transparent = true; (line.material as GizmoMaterial).opacity = 1; (line.material as GizmoMaterial)._opacity = 1; } });
                            negativeLines.forEach(line => { if (line.material) { (line.material as GizmoMaterial).transparent = true; (line.material as GizmoMaterial).opacity = 0.001; (line.material as GizmoMaterial)._opacity = 0.001; } });
                        } else {
                            negativeLines.forEach(line => { if (line.material) { (line.material as GizmoMaterial).transparent = true; (line.material as GizmoMaterial).opacity = 1; (line.material as GizmoMaterial)._opacity = 1; } });
                            originalLines.forEach(line => { if (line.material) { (line.material as GizmoMaterial).transparent = true; (line.material as GizmoMaterial).opacity = 0.001; (line.material as GizmoMaterial)._opacity = 0.001; } });
                        }
                    }
                }
            }
        },
        resetSelection: resetSelectionAndDeselect,
        getSelectedObject: () => (currentSelection.primary && currentSelection.primary.type === 'object' ? currentSelection.primary.mesh : null),
        createGroup: createGroup,
        getGroups: getGroups
    };
}
