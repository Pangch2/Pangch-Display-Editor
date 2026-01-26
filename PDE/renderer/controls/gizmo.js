import { setupGizmo } from './gizmo-setup.js';
import * as THREE from 'three/webgpu';
import { 
    blockbenchScaleMode, 
    toggleBlockbenchScaleMode, 
    computeBlockbenchPivotFrame, 
    transformBoxToPivotFrame, 
    detectBlockbenchScaleAxes, 
    computeBlockbenchScaleShift 
} from './blockbench-scale.js';
import * as GroupUtils from './group.js';
import * as Overlay from './overlay.js';
import * as CustomPivot from './custom-pivot.js';
import * as Duplicate from './duplicate.js';
import * as Delete from './delete.js';
import { removeShearFromSelection } from './shear-remove.js';
import { focusCameraOnSelection } from './camera.js';
import { initDrag } from './drag.js';

import { processVertexSnap } from './vertex-translate.js';
import * as Select from './select.js';

// Aliases for moved/exported functions
const disposeThreeObjectTree = Overlay.disposeThreeObjectTree;
const getInstanceCount = Overlay.getInstanceCount;
const isInstanceValid = Overlay.isInstanceValid;
const getDisplayType = Overlay.getDisplayType;
const isItemDisplayHatEnabled = Overlay.isItemDisplayHatEnabled;
const getInstanceLocalBoxMin = Overlay.getInstanceLocalBoxMin;
const getInstanceWorldMatrixForOrigin = Overlay.getInstanceWorldMatrixForOrigin;
const calculateAvgOriginForChildren = Overlay.calculateAvgOriginForChildren;
const getGroupWorldMatrixWithFallback = Overlay.getGroupWorldMatrixWithFallback;
const createEdgesGeometryFromBox3 = Overlay.createEdgesGeometryFromBox3;
const unionTransformedBox3 = Overlay.unionTransformedBox3;
const getInstanceLocalBox = Overlay.getInstanceLocalBox;
const getInstanceWorldMatrix = Overlay.getInstanceWorldMatrix;
const getGroupLocalBoundingBox = Overlay.getGroupLocalBoundingBox;
const getRotationFromMatrix = Overlay.getRotationFromMatrix;
const getSelectionBoundingBox = () => Overlay.getSelectionBoundingBox(currentSelection);
const createOverlayLineMaterial = Overlay.createOverlayLineMaterial;


// Small shared temporaries (avoid allocations in hot paths)
const _TMP_MAT4_A = new THREE.Matrix4();
const _TMP_MAT4_B = new THREE.Matrix4();
const _TMP_BOX3_A = new THREE.Box3();
const _TMP_VEC3_A = new THREE.Vector3();
const _TMP_VEC3_B = new THREE.Vector3();

// Selection logic moved to select.js
function _beginSelectionReplace(options) {
    Select.beginSelectionReplace({
        revertEphemeralPivotUndoIfAny: _revertEphemeralPivotUndoIfAny,
        detachTransformControls: () => { if (transformControls) transformControls.detach(); },
        pushToVertexQueue: _pushToVertexQueue,
        clearGizmoAnchor: _clearGizmoAnchor,
        setSelectionAnchorMode: (mode) => { _selectionAnchorMode = mode; },
        resetPivotState: () => { 
            pivotOffset.set(0, 0, 0); 
            isCustomPivot = false; 
            currentSelection.primary = null; 
        }
    }, options);
}

const pickInstanceByOverlayBox = Select.pickInstanceByOverlayBox;

// Group Data Structures
function getGroups() {
    return GroupUtils.getGroups(loadedObjectGroup);
}

function getObjectToGroup() {
    return GroupUtils.getObjectToGroup(loadedObjectGroup);
}

function getGroupKey(mesh, instanceId) {
    return GroupUtils.getGroupKey(mesh, instanceId);
}

function getGroupChain(startGroupId) {
    return GroupUtils.getGroupChain(loadedObjectGroup, startGroupId);
}

function getAllGroupChildren(groupId) {
    return GroupUtils.getAllGroupChildren(loadedObjectGroup, groupId);
}

function getAllDescendantGroups(groupId) {
    return GroupUtils.getAllDescendantGroups(loadedObjectGroup, groupId);
}

// Group Pivot Helpers
const _DEFAULT_GROUP_PIVOT = GroupUtils.DEFAULT_GROUP_PIVOT;
const _ZERO_VEC3 = new THREE.Vector3(0, 0, 0);

function _nearlyEqual(a, b, eps = 1e-6) {
    return Math.abs(a - b) <= eps;
}

function normalizePivotToVector3(pivot, out = new THREE.Vector3()) {
    return GroupUtils.normalizePivotToVector3(pivot, out);
}

function isCustomGroupPivot(pivot) {
    return GroupUtils.isCustomGroupPivot(pivot);
}

function getGroupWorldMatrix(group, out = new THREE.Matrix4()) {
    return GroupUtils.getGroupWorldMatrix(group, out);
}

function shouldUseGroupPivot(group) {
    return GroupUtils.shouldUseGroupPivot(group);
}


// Baseline origin used by SelectionCenter for groups in pivotMode === 'origin' (without pivotOffset).
function getGroupOriginWorld(groupId, out = new THREE.Vector3()) {
    const groups = getGroups();
    const group = groups.get(groupId);
    if (!group) return out.set(0, 0, 0);

    const box = getGroupLocalBoundingBox(groupId);
    if (!box.isEmpty()) {
        const m = getGroupWorldMatrix(group, new THREE.Matrix4());
        return out.copy(box.min).applyMatrix4(m);
    }
    if (group.position) return out.copy(group.position);

    // Stable per-group fallback (avoid depending on current selection).
    const children = getAllGroupChildren(groupId);
    if (children.length > 0) {
        return calculateAvgOriginForChildren(children, out);
    }
    return out.set(0, 0, 0);
}

// Selection caches (critical for performance when group has many children)
let _selectedItemsCacheKey = null;
let _selectedItemsCache = null;

let _ephemeralPivotUndo = null;
let _pivotEditUndoCapture = null;

const _isMultiSelection = Select.isMultiSelection;

function _clearEphemeralPivotUndo() {
    CustomPivot.clearEphemeralPivotUndo();
}

function _revertEphemeralPivotUndoIfAny() {
    CustomPivot.revertEphemeralPivotUndoIfAny();
}

function _capturePivotUndoForCurrentSelection() {
    return CustomPivot.capturePivotUndoForCurrentSelection(currentSelection);
}

const _hasAnySelection = Select.hasAnySelection;
const _getSingleSelectedGroupId = Select.getSingleSelectedGroupId;
const _getSingleSelectedMeshEntry = Select.getSingleSelectedMeshEntry;

const _setPrimaryToFirstAvailable = Select.setPrimaryToFirstAvailable;

function _clearSelectionState() {
    Select.clearSelectionState({
        pushToVertexQueue: _pushToVertexQueue
    });
}

function _recomputePivotStateForSelection() {
    isCustomPivot = CustomPivot.recomputePivotStateForSelection(
        pivotMode, 
        _isMultiSelection(), 
        isCustomPivot, 
        pivotOffset, 
        currentSelection,
        loadedObjectGroup,
        { 
            getSelectedItems: Select.getSelectedItems, 
            getSingleSelectedGroupId: Select.getSingleSelectedGroupId, 
            getSingleSelectedMeshEntry: Select.getSingleSelectedMeshEntry 
        }
    );
}

const invalidateSelectionCaches = Select.invalidateSelectionCaches;

const getSelectedItems = Select.getSelectedItems;

let scene, camera, renderer, controls, loadedObjectGroup;
let transformControls = null;
let selectionHelper = null;
let previousHelperMatrix = new THREE.Matrix4();

// Selection State
const currentSelection = Select.currentSelection;

const selectedVertexKeys = new Set(); // Stores vertex position keys

const vertexQueue = [];
let suppressVertexQueue = false;

// Increase history to allow selecting vertices on multiple previously selected objects
const VERTEX_QUEUE_MAX_SIZE = 1;

function _pushToVertexQueue() {
    if (suppressVertexQueue || !isVertexMode) return;

    let currentGizmoPos = null;
    let currentGizmoQuat = null;
    if ((currentSelection.groups.size > 0 || currentSelection.objects.size > 0)) {
        currentGizmoPos = new THREE.Vector3();
        currentGizmoQuat = new THREE.Quaternion();
        if (selectionHelper) {
             currentGizmoPos.copy(selectionHelper.position);
             currentGizmoQuat.copy(selectionHelper.quaternion);
        } else {
             _getSelectionCenterWorld(currentGizmoPos);
             // Default to identity or some sensible rotation if no helper
             currentGizmoQuat.identity();
        }
    }

    // Maintain selection status of the gizmo point
    const centerKey = currentGizmoPos ? `CENTER_${currentGizmoPos.x.toFixed(4)}_${currentGizmoPos.y.toFixed(4)}_${currentGizmoPos.z.toFixed(4)}` : null;
    const isCenterSelected = centerKey && selectedVertexKeys.has(centerKey);

    if (isCenterSelected) {
        selectedVertexKeys.delete(centerKey);
    }

    const itemsToAdd = [];
    if (currentSelection.groups.size > 0) {
        for (const gid of currentSelection.groups) {
            itemsToAdd.push({ type: 'group', id: gid });
        }
    }
    if (currentSelection.objects.size > 0) {
        for (const [mesh, ids] of currentSelection.objects) {
            for (const id of ids) {
                itemsToAdd.push({ type: 'object', mesh, instanceId: id });
            }
        }
    }

    const tempMat = _TMP_MAT4_A;
    const tempInv = _TMP_MAT4_B;

    for (const item of itemsToAdd) {
        let localPos = null;
        let localQuat = null;

        if (currentGizmoPos) {
            if (item.type === 'group') {
                getGroupWorldMatrixWithFallback(item.id, tempMat);
            } else {
                getInstanceWorldMatrix(item.mesh, item.instanceId, tempMat);
            }
            
            tempInv.copy(tempMat).invert();
            localPos = currentGizmoPos.clone().applyMatrix4(tempInv);

            if (currentGizmoQuat) {
                 const objQuat = getRotationFromMatrix(tempMat);
                 localQuat = objQuat.invert().multiply(currentGizmoQuat);
            }
        }

        vertexQueue.push({ ...item, gizmoLocalPosition: localPos, gizmoLocalQuaternion: localQuat });

        if (isCenterSelected && localPos) {
            const qKey = `QUEUE_${localPos.x.toFixed(4)}_${localPos.y.toFixed(4)}_${localPos.z.toFixed(4)}`;
            selectedVertexKeys.add(qKey);
        }
    }

    while (vertexQueue.length > VERTEX_QUEUE_MAX_SIZE) {
        vertexQueue.shift(); 
    }
}

let pivotMode = 'origin';
let currentSpace = 'world';
let lastDirections = { X: null, Y: null, Z: null };

// Gizmo position lock: keep the initial selection gizmo position while multi-selecting.
const _gizmoAnchorPosition = new THREE.Vector3();
let _gizmoAnchorValid = false;

// Multi-selection Pivot Mode: origin position cache.
// This lets us temporarily switch pivotMode (e.g. origin -> center -> origin)
// without losing the multi-selection origin pivot position.
const _multiSelectionOriginAnchorPosition = new THREE.Vector3();
let _multiSelectionOriginAnchorValid = false;

// The very first remembered origin anchor for the current multi-selection session.
// Used by "Pivot reset to origin" to restore the original temporary origin.
const _multiSelectionOriginAnchorInitialPosition = new THREE.Vector3();
let _multiSelectionOriginAnchorInitialValid = false;

// Multi-selection Rotation Accumulator (for "No Basis" / Select All mode)
const _multiSelectionAccumulatedRotation = new THREE.Quaternion();

// When selection is created without a meaningful "first" target (Ctrl+A / marquee),
// anchor the gizmo at the selection center.
let _selectionAnchorMode = 'default'; // 'default' | 'center'

function _clearGizmoAnchor() {
    _gizmoAnchorValid = false;
    _gizmoAnchorPosition.set(0, 0, 0);

    _multiSelectionOriginAnchorValid = false;
    _multiSelectionOriginAnchorPosition.set(0, 0, 0);

    _multiSelectionOriginAnchorInitialValid = false;
    _multiSelectionOriginAnchorInitialPosition.set(0, 0, 0);
    
    _multiSelectionAccumulatedRotation.set(0, 0, 0, 1);
}

function _getSelectionCenterWorld(out = new THREE.Vector3()) {
    const box = getSelectionBoundingBox();
    if (box && !box.isEmpty()) {
        return box.getCenter(out);
    }
    return out.copy(calculateAvgOrigin());
}

function getSelectionCallbacks() {
    return {
        revertEphemeralPivotUndoIfAny: () => _revertEphemeralPivotUndoIfAny(),
        detachTransformControls: () => transformControls.detach(),
        clearGizmoAnchor: () => _clearGizmoAnchor(),
        setSelectionAnchorMode: (mode) => { _selectionAnchorMode = mode; },
        resetPivotState: () => {
            pivotOffset.set(0, 0, 0);
            isCustomPivot = false;
        },
        updateHelperPosition: () => updateHelperPosition(),
        updateSelectionOverlay: () => updateSelectionOverlay(),
        pushToVertexQueue: () => {
            // Note: Select.js seems to call this in clearSelectionState?
            // If the intention is to clear the vertex queue, we should probably do:
            vertexQueue.length = 0;
            selectedVertexKeys.clear();
        },
        hasVertexQueue: () => vertexQueue.length > 0,
        // Any other needed callbacks
        getLoadedObjectGroup: () => loadedObjectGroup
    };
}

function _replaceSelectionWithObjectsMap(meshToIds, options) {
    Select.replaceSelectionWithObjectsMap(meshToIds, getSelectionCallbacks(), options);
}

function _replaceSelectionWithGroupsAndObjects(groupIds, meshToIds, options) {
    Select.replaceSelectionWithGroupsAndObjects(groupIds, meshToIds, getSelectionCallbacks(), options);
}

function _selectAllObjectsVisibleInScene() {
    return Select.selectAllObjectsVisibleInScene(loadedObjectGroup);
}

let gizmoLines = {
  X: { original: [], negative: [] },
  Y: { original: [], negative: [] },
  Z: { original: [], negative: [] }
};

// drag state
const dragInitialMatrix = new THREE.Matrix4();
const dragInitialQuaternion = new THREE.Quaternion();
const dragInitialScale = new THREE.Vector3();
const dragInitialPosition = new THREE.Vector3();
const dragInitialBoundingBox = new THREE.Box3();
const dragStartAvgOrigin = new THREE.Vector3();
const dragStartPivotBaseWorld = new THREE.Vector3();
let draggingMode = null;
let isGizmoBusy = false;
// blockbenchScaleMode imported
let dragAnchorDirections = { x: true, y: true, z: true };
let previousGizmoMode = 'translate';
let isPivotEditMode = false;
let isVertexMode = false;
let isUniformScale = false;
let isCustomPivot = false;
let pivotOffset = new THREE.Vector3(0, 0, 0);

// Reusable temporaries (avoid allocations during dragging)
const _tmpPrevInvMatrix = new THREE.Matrix4();
const _tmpDeltaMatrix = new THREE.Matrix4();
const _tmpInstanceMatrix = new THREE.Matrix4();
const _tmpMeshWorldInverse = new THREE.Matrix4();
const _tmpLocalDelta = new THREE.Matrix4();
const _meshToInstanceIds = new Map();

// Helpers
// Blockbench scale mode needs a stable "pivot frame" transform.
// For groups, this must include shear from the group's world matrix, but be anchored at the current gizmo pivot position.
// Logic moved to blockbench-scale.js

function getGroupRotationQuaternion(groupId, out = new THREE.Quaternion()) {
    if (!groupId) return out.set(0, 0, 0, 1);
    const m = getGroupWorldMatrixWithFallback(groupId, _TMP_MAT4_A);
    const q = getRotationFromMatrix(m);
    return out.copy(q);
}

function SelectionCenter(pivotMode, isCustomPivot, pivotOffset) {
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
            calculateAvgOrigin
        }
    );
}

function calculateAvgOrigin() {
    const center = new THREE.Vector3();
    const items = getSelectedItems();
    
    if (items.length === 0) return center;

    const tempPos = new THREE.Vector3();
    const tempMat = new THREE.Matrix4();
    
    items.forEach(({mesh, instanceId}) => {
        getInstanceWorldMatrixForOrigin(mesh, instanceId, tempMat);
        const localY = isItemDisplayHatEnabled(mesh, instanceId) ? 0.03125 : 0;
        tempPos.set(0, localY, 0).applyMatrix4(tempMat);
        center.add(tempPos);
    });
    
    center.divideScalar(items.length);
    return center;
}

function updateSelectionOverlay() {
    Overlay.updateSelectionOverlay(scene, renderer, camera, currentSelection, vertexQueue, isVertexMode, selectionHelper, selectedVertexKeys);
}

function _updateMultiSelectionOverlayDuringDrag() {
    Overlay.updateMultiSelectionOverlayDuringDrag(currentSelection, scene);
}

function resetSelectionAndDeselect() {
    if (_hasAnySelection() || vertexQueue.length > 0) {
        // If the user created a custom pivot during multi-selection, it should not persist after deselect.
        _revertEphemeralPivotUndoIfAny();
        transformControls.detach();
        _clearSelectionState();
        vertexQueue.length = 0;
        selectedVertexKeys.clear();
        _clearGizmoAnchor();

        // Clear any selection-derived pivot state so it can't leak into the next selection.
        pivotOffset.set(0, 0, 0);
        isCustomPivot = false;
        _selectionAnchorMode = 'default';

        invalidateSelectionCaches();
        updateSelectionOverlay();
        lastDirections = { X: null, Y: null, Z: null };
        console.log('선택 해제');
    }
}

function updateHelperPosition() {
    const items = getSelectedItems();
    if (items.length === 0 && !_hasAnySelection()) return;

    // Pivot Mode center must always work: recompute each time.
    // For multi-selection, Pivot Mode origin should stay stable (anchored) even when
    // the selection set changes (Shift+Click). Additionally, remember the origin pivot
    // so we can return to it after temporarily switching pivotMode.
    const isMulti = _isMultiSelection();

    // 3. Multi-Selection: Check if PRIMARY has a stored custom pivot
    // If we have a primary selection, and IT has a custom pivot, we should respect it
    // effectively treating it as the "multi-selection custom pivot".
    // BUT only do this if we don't already have an active custom pivot (e.g. manually edited).
    if (!isCustomPivot && _isMultiSelection() && currentSelection.primary) {
        let primaryPivotWorld = null;
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
                     primaryPivotWorld = getGroupOriginWorld(prim.id, _TMP_VEC3_A);
                }
            }
        } else if (prim.type === 'object') {
             const { mesh, instanceId } = prim;
             if (mesh) {
                 // Check per-object custom pivot (userData.customPivot/customPivots)
                 let custom = null;
                 if (mesh.isBatchedMesh || mesh.isInstancedMesh) {
                     if (mesh.userData.customPivots && mesh.userData.customPivots.has(instanceId)) {
                         custom = mesh.userData.customPivots.get(instanceId);
                     }
                 } else {
                     if (mesh.userData.customPivot) custom = mesh.userData.customPivot;
                 }
                 
                 if (custom) {
                     const tempMat = _TMP_MAT4_A;
                     mesh.getMatrixAt(instanceId, tempMat);
                     tempMat.premultiply(mesh.matrixWorld);
                     primaryPivotWorld = custom.clone().applyMatrix4(tempMat);
                 } else {
                     // Default Origin
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
            if (!_multiSelectionOriginAnchorInitialValid) {
                _multiSelectionOriginAnchorInitialPosition.copy(primaryPivotWorld);
                _multiSelectionOriginAnchorInitialValid = true;
            }
        }
    }

    // When a selection grows from single -> multi (Shift+Click add), we want Pivot Mode: origin
    // to keep the original gizmo position (first selected) instead of jumping to a newly
    // computed origin. Seed the multi-origin anchor from the existing gizmo anchor.
    if (pivotMode === 'origin' && isMulti && !_multiSelectionOriginAnchorValid && _gizmoAnchorValid) {
        _multiSelectionOriginAnchorPosition.copy(_gizmoAnchorPosition);
        _multiSelectionOriginAnchorValid = true;
        if (!_multiSelectionOriginAnchorInitialValid) {
            _multiSelectionOriginAnchorInitialPosition.copy(_gizmoAnchorPosition);
            _multiSelectionOriginAnchorInitialValid = true;
        }
    }

    const lockMultiOrigin = (pivotMode === 'origin') && isMulti && _multiSelectionOriginAnchorValid;
    if (lockMultiOrigin) {
        selectionHelper.position.copy(_multiSelectionOriginAnchorPosition);
        _gizmoAnchorPosition.copy(_multiSelectionOriginAnchorPosition);
        _gizmoAnchorValid = true;
    } else {
        const center = (_selectionAnchorMode === 'center')
            ? _getSelectionCenterWorld(new THREE.Vector3())
            : SelectionCenter(pivotMode, isCustomPivot, pivotOffset);
        selectionHelper.position.copy(center);
        _gizmoAnchorPosition.copy(center);
        _gizmoAnchorValid = true;

        // When computing an origin pivot position, keep the multi-origin cache up to date.
        if (pivotMode === 'origin' && isMulti) {
            _multiSelectionOriginAnchorPosition.copy(center);
            _multiSelectionOriginAnchorValid = true;
            if (!_multiSelectionOriginAnchorInitialValid) {
                _multiSelectionOriginAnchorInitialPosition.copy(center);
                _multiSelectionOriginAnchorInitialValid = true;
            }
        }
    }

    // Restore vertex selection state from Queue if this gizmo position was previously in the queue
    const gizmoPos = selectionHelper.position;
    
    let localPos = null;
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

    if (localPos) {
        const queueKey = `QUEUE_${localPos.x.toFixed(4)}_${localPos.y.toFixed(4)}_${localPos.z.toFixed(4)}`;
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
            selectionHelper.quaternion.set(0, 0, 0, 1);
        } else if (group) {
            // Groups may have shear in their matrix; derive a stable orthonormal rotation for local space.
            getGroupRotationQuaternion(singleGroupId, selectionHelper.quaternion);
        } else {
            selectionHelper.quaternion.set(0, 0, 0, 1);
        }
        // Keep helper scale neutral so scale gizmo math is consistent with object selection.
        selectionHelper.scale.set(1, 1, 1);
    } else if (items.length > 0) {
        if (currentSpace === 'world') {
            selectionHelper.quaternion.set(0, 0, 0, 1);
        } else {
            if (currentSelection.primary) {
                // Use Primary Selection Rotation
                if (currentSelection.primary.type === 'group') {
                    getGroupRotationQuaternion(currentSelection.primary.id, selectionHelper.quaternion);
                } else if (currentSelection.primary.type === 'object') {
                    const { mesh, instanceId } = currentSelection.primary;
                    if (mesh) {
                        const instanceMatrix = _TMP_MAT4_A;
                        mesh.getMatrixAt(instanceId, instanceMatrix);
                        const worldMatrix = instanceMatrix.premultiply(mesh.matrixWorld);
                        selectionHelper.quaternion.copy(getRotationFromMatrix(worldMatrix));
                    }
                }
            } else {
                // No Primary (e.g. Select All) -> Use Accumulated Rotation
                selectionHelper.quaternion.copy(_multiSelectionAccumulatedRotation);
            }
        }
        selectionHelper.scale.set(1, 1, 1);
    } else {
        selectionHelper.quaternion.set(0, 0, 0, 1);
        selectionHelper.scale.set(1, 1, 1);
    }

    selectionHelper.updateMatrixWorld();
    if (!isVertexMode) {
        transformControls.attach(selectionHelper);
    } else {
        transformControls.detach();
    }
    previousHelperMatrix.copy(selectionHelper.matrixWorld);
}

let _pivotEditPreviousPivotMode = null;

function applySelection(mesh, instanceIds, groupId = null) {
    // Selection replacement should also drop any ephemeral multi-selection pivot edits.
    _revertEphemeralPivotUndoIfAny();
    _clearSelectionState();
    _clearGizmoAnchor();
    _selectionAnchorMode = 'default';

    if (groupId) {
        currentSelection.groups.add(groupId);
        currentSelection.primary = { type: 'group', id: groupId };
    } else if (mesh && Array.isArray(instanceIds) && instanceIds.length > 0) {
        const idSet = new Set(instanceIds);
        currentSelection.objects.set(mesh, idSet);
        currentSelection.primary = { type: 'object', mesh, instanceId: instanceIds[0] };
    }

    invalidateSelectionCaches();
    _recomputePivotStateForSelection();

    updateHelperPosition();
    updateSelectionOverlay();
    
    if (groupId) {
        console.log(`그룹 선택됨: ${groupId}`);
    } else if (mesh && Array.isArray(instanceIds)) {
        console.log(`선택됨: InstancedMesh (IDs: ${instanceIds.join(',')})`);
    }
}

function _commitSelectionChange() {
    invalidateSelectionCaches();
    if (_hasAnySelection() && !currentSelection.primary) {
        _setPrimaryToFirstAvailable();
    }
    _recomputePivotStateForSelection();
    updateHelperPosition();
    updateSelectionOverlay();
}

function createGroup() {
    suppressVertexQueue = true; // Prevent invalid IDs from entering queue during restructure
    vertexQueue.length = 0; // Clear existing queue as IDs might shift

    const items = getSelectedItems();
    if (items.length === 0 && !_hasAnySelection()) {
        suppressVertexQueue = false;
        return;
    }

    const groups = getGroups();
    
    // Preparation: Get initial position (Gizmo specific logic)
    let initialPosition = new THREE.Vector3();
    // Keep old behavior for single selected group; otherwise use average.
    const singleGroupId = _getSingleSelectedGroupId();
    if (singleGroupId) {
        const existingGroup = groups.get(singleGroupId);
        if (existingGroup && existingGroup.position) initialPosition.copy(existingGroup.position);
        else initialPosition = calculateAvgOrigin();
    } else {
        initialPosition = calculateAvgOrigin();
    }

    const selectedGroupIds = currentSelection.groups ? Array.from(currentSelection.groups).filter(Boolean) : [];
    const selectedObjects = [];
    if (currentSelection.objects && currentSelection.objects.size > 0) {
        for (const [mesh, ids] of currentSelection.objects) {
            if (!mesh || !ids) continue;
            for (const id of ids) {
                selectedObjects.push({ mesh, instanceId: id });
            }
        }
    }

    // Heavy lifting moved to group.js
    const newGroupId = GroupUtils.createGroupStructure(loadedObjectGroup, selectedGroupIds, selectedObjects, initialPosition);

    invalidateSelectionCaches();
    
    applySelection(null, [], newGroupId);
    suppressVertexQueue = false;

    console.log(`Group created: ${newGroupId}`);
    return newGroupId;
}

function ungroupGroup(groupId) {
    suppressVertexQueue = true;
    vertexQueue.length = 0;

    if (!groupId) { suppressVertexQueue = false; return; }
    
    const result = GroupUtils.ungroupGroupStructure(loadedObjectGroup, groupId);
    if (!result) { suppressVertexQueue = false; return; }

    const { parentId } = result;

    invalidateSelectionCaches();

    // After ungrouping, select the parent group if it exists, otherwise deselect.
    if (parentId && getGroups().has(parentId)) {
        applySelection(null, [], parentId);
    } else {
        resetSelectionAndDeselect();
    }

    suppressVertexQueue = false;
    console.log(`Group removed: ${groupId}`);
}

function deleteSelectedItems() {
    suppressVertexQueue = true;
    vertexQueue.length = 0; // Clear queue to avoid stale ID references
    
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

function duplicateSelected() {
    suppressVertexQueue = true; // Prevent ghost selections during duplication
    vertexQueue.length = 0;
    try {
        if (!_hasAnySelection()) return;

    // Preserve custom pivot state (multi-selection uses transient global state)
    const savedIsCustomPivot = isCustomPivot;
    const savedPivotOffset = pivotOffset.clone();

    // Capture if we have a primary
    const hadPrimary = !!currentSelection.primary;

    const selectedGroupIds = currentSelection.groups;
    const selectedObjects = [];
    if (currentSelection.objects) {
        for (const [mesh, ids] of currentSelection.objects) {
             for (const id of ids) selectedObjects.push({ mesh, instanceId: id });
        }
    }

    const newSel = Duplicate.duplicateGroupsAndObjects(loadedObjectGroup, selectedGroupIds, selectedObjects);

    // Apply new selection
    // When duplicating a multi-selection, keep the existing gizmo anchor so the gizmo position stays stable.
    // Also preserve the current anchorMode (e.g. Ctrl+A / marquee uses 'center').
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

    // Restore custom pivot if it was active
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

function initGizmo({scene: s, camera: cam, renderer: rend, controls: orbitControls, loadedObjectGroup: lg, setControls}) {
    scene = s; camera = cam; renderer = rend; controls = orbitControls; loadedObjectGroup = lg;
    Overlay.setLoadedObjectGroup(lg);
    Select.setLoadedObjectGroup(lg);

    if (!loadedObjectGroup.userData.groups) loadedObjectGroup.userData.groups = new Map();
    if (!loadedObjectGroup.userData.objectToGroup) loadedObjectGroup.userData.objectToGroup = new Map();

    selectionHelper = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.1), new THREE.MeshBasicMaterial({ visible: false }));
    scene.add(selectionHelper);

    const mouseInput = new THREE.Vector2();
    let detectedAnchorDirections = { x: null, y: null, z: null };

    renderer.domElement.addEventListener('pointerdown', (event) => {
        const rect = renderer.domElement.getBoundingClientRect();
        mouseInput.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        mouseInput.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

        detectedAnchorDirections = { x: null, y: null, z: null };

        if (!transformControls.dragging) {
            raycaster.setFromCamera(mouseInput, camera);
            const gizmo = transformControls.getHelper();
            const intersects = raycaster.intersectObject(gizmo, true);

            if (intersects.length > 0) {
                const object = intersects[0].object;
                if (object.name === 'XYZ') {
                    isUniformScale = true;
                } else {
                    isUniformScale = false;
                    const check = (axis) => {
                        if (gizmoLines[axis].negative.includes(object)) return false;
                        if (gizmoLines[axis].original.includes(object)) return true;
                        return null;
                    };
                    detectedAnchorDirections.x = check('X');
                    detectedAnchorDirections.y = check('Y');
                    detectedAnchorDirections.z = check('Z');
                }
            }
        }
    }, true);

    const setupResult = setupGizmo(camera, renderer, scene);
    transformControls = setupResult.transformControls;
    gizmoLines = setupResult.gizmoLines;

    transformControls.addEventListener('dragging-changed', (event) => {
        controls.enabled = !event.value;
        if (event.value) {
            draggingMode = transformControls.mode;
            
            // Pre-calculate mesh grouping for performance
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

            if (transformControls.axis === 'XYZ') isUniformScale = true;

            dragInitialMatrix.copy(selectionHelper.matrix);
            dragInitialQuaternion.copy(selectionHelper.quaternion);
            dragInitialScale.copy(selectionHelper.scale);
            dragInitialPosition.copy(selectionHelper.position);

            if (isPivotEditMode) {
                  // Pivot edit: compute pivotOffset relative to the same baseline that SelectionCenter(origin) uses.
                  dragStartPivotBaseWorld.copy(SelectionCenter('origin', false, _ZERO_VEC3));
                  dragStartAvgOrigin.copy(calculateAvgOrigin());

                // Multi-selection custom pivot should behave like a temporary group:
                // do NOT persist per-object custom pivots into mesh.userData.
                // Selection-level pivot is handled via pivotOffset/isCustomPivot only.
                _pivotEditUndoCapture = null;
            }

            if (blockbenchScaleMode && draggingMode === 'scale' && !isUniformScale) {
                dragInitialBoundingBox.makeEmpty();

                selectionHelper.updateMatrixWorld();
                computeBlockbenchPivotFrame(selectionHelper, currentSpace);

                const singleGroupId = _getSingleSelectedGroupId();
                if (singleGroupId) {
                    // Group Selection: Use the Group's Bounding Box (matches the green overlay)
                    const groupLocalBox = getGroupLocalBoundingBox(singleGroupId);
                    if (!groupLocalBox.isEmpty()) {
                        const groupWorldMat = getGroupWorldMatrixWithFallback(singleGroupId, _TMP_MAT4_A);
                        // Transform: Group Local -> World -> Pivot Frame
                        const combinedMat = transformBoxToPivotFrame(groupWorldMat, _TMP_MAT4_B);
                        unionTransformedBox3(dragInitialBoundingBox, groupLocalBox, combinedMat);
                    }
                } else {
                    // Object / Multi Selection: Aggregate children boxes
                    const items = getSelectedItems();
                    if (items.length > 0) {
                        const tempMat = new THREE.Matrix4();
                        items.forEach(({mesh, instanceId}) => {
                            const localBox = getInstanceLocalBox(mesh, instanceId);
                            if (!localBox) return;

                            getInstanceWorldMatrix(mesh, instanceId, tempMat);

                            const combinedMat = transformBoxToPivotFrame(tempMat, _TMP_MAT4_A);
                            unionTransformedBox3(dragInitialBoundingBox, localBox, combinedMat);
                        });
                    }
                }

                dragAnchorDirections = detectBlockbenchScaleAxes(camera, mouseInput, selectionHelper, currentSpace, detectedAnchorDirections);
            }

        } else {
            // Capture accumulated rotation for multi-selection "No Basis" mode
            if (draggingMode === 'rotate' && _isMultiSelection() && !currentSelection.primary) {
                _multiSelectionAccumulatedRotation.copy(selectionHelper.quaternion);
            }

            draggingMode = null;
            isUniformScale = false;

            if (isPivotEditMode) {
                const isMultiPivotEdit = _isMultiSelection();
                const singleGroupId = _getSingleSelectedGroupId();
                if (singleGroupId) {
                    const groups = getGroups();
                    const group = groups.get(singleGroupId);
                    if (group) {
                        const pivotWorld = selectionHelper.position.clone();
                        const groupMatrix = getGroupWorldMatrix(group, new THREE.Matrix4());
                        const invGroupMatrix = groupMatrix.clone().invert();
                        const localPivot = pivotWorld.applyMatrix4(invGroupMatrix);

                        // Persist as group.pivot (compatible with pbde-worker payload shape).
                        group.pivot = localPivot.clone();
                        group.isCustomPivot = true;

                        // Ensure offset matches the baseline origin mode for groups.
                        const baseWorld = getGroupOriginWorld(singleGroupId, new THREE.Vector3());
                        const targetWorld = localPivot.clone().applyMatrix4(groupMatrix);
                        pivotOffset.subVectors(targetWorld, baseWorld);
                        isCustomPivot = true;
                    }
                } else if (!isMultiPivotEdit) {
                    // Single-object selection: persist per-mesh custom pivots.
                    if (currentSelection.objects && currentSelection.objects.size > 0) {
                        const pivotWorld = selectionHelper.position.clone();
                        const instanceMatrix = new THREE.Matrix4();

                        for (const [mesh, ids] of currentSelection.objects) {
                            if (!mesh || !ids || ids.size === 0) continue;

                            const firstId = Array.from(ids)[0];
                            mesh.getMatrixAt(firstId, instanceMatrix);
                            const worldMatrix = instanceMatrix.premultiply(mesh.matrixWorld);
                            const invWorldMatrix = worldMatrix.clone().invert();
                            const localPivot = pivotWorld.clone().applyMatrix4(invWorldMatrix);

                            if (mesh.isBatchedMesh || mesh.isInstancedMesh) {
                                if (!mesh.userData.customPivots) mesh.userData.customPivots = new Map();
                                for (const id of ids) {
                                    mesh.userData.customPivots.set(id, localPivot.clone());
                                }
                            } else {
                                mesh.userData.customPivot = localPivot.clone();
                            }

                            mesh.userData.isCustomPivot = true;
                        }
                    }
                } else {
                    // Multi-selection pivot edit: Save to PRIMARY selection so it persists and rotates with it.
                    if (currentSelection.primary) {
                        const prim = currentSelection.primary;
                        const pivotWorld = selectionHelper.position.clone();
                        
                        // Capture undo state for the primary object (if not already captured)
                        if (!_ephemeralPivotUndo && !_pivotEditUndoCapture) {
                            if (prim.type === 'group') {
                                const groups = getGroups();
                                const group = groups.get(prim.id);
                                if (group) {
                                    const prevPivot = group.pivot ? (group.pivot.clone ? group.pivot.clone() : new THREE.Vector3().copy(group.pivot)) : undefined;
                                    const prevIsCustom = group.isCustomPivot;
                                    _pivotEditUndoCapture = () => {
                                        group.pivot = prevPivot;
                                        if (prevIsCustom) group.isCustomPivot = true;
                                        else delete group.isCustomPivot;
                                    };
                                }
                            } else if (prim.type === 'object') {
                                const { mesh, instanceId } = prim;
                                if (mesh) {
                                    const prevIsCustom = mesh.userData.isCustomPivot;
                                    let prevPivotEntry = undefined;
                                    const isBatchOrInst = mesh.isBatchedMesh || mesh.isInstancedMesh;
                                    
                                    if (isBatchOrInst) {
                                        if (mesh.userData.customPivots && mesh.userData.customPivots.has(instanceId)) {
                                            prevPivotEntry = mesh.userData.customPivots.get(instanceId).clone();
                                        }
                                    } else {
                                        if (mesh.userData.customPivot) prevPivotEntry = mesh.userData.customPivot.clone();
                                    }

                                    _pivotEditUndoCapture = () => {
                                        if (isBatchOrInst) {
                                            if (prevPivotEntry) {
                                                if (!mesh.userData.customPivots) mesh.userData.customPivots = new Map();
                                                mesh.userData.customPivots.set(instanceId, prevPivotEntry);
                                            } else if (mesh.userData.customPivots) {
                                                mesh.userData.customPivots.delete(instanceId);
                                            }
                                        } else {
                                            mesh.userData.customPivot = prevPivotEntry;
                                        }
                                        
                                        if (prevIsCustom) mesh.userData.isCustomPivot = true;
                                        else delete mesh.userData.isCustomPivot;
                                    };
                                }
                            }
                        }

                        if (prim.type === 'group') {
                             const groups = getGroups();
                             const group = groups.get(prim.id);
                             if (group) {
                                 const groupMatrix = getGroupWorldMatrix(group, new THREE.Matrix4());
                                 const invGroupMatrix = groupMatrix.invert();
                                 const localPivot = pivotWorld.applyMatrix4(invGroupMatrix);
                                 group.pivot = localPivot;
                                 group.isCustomPivot = true;
                             }
                        } else if (prim.type === 'object') {
                             const { mesh, instanceId } = prim;
                             if (mesh) {
                                 const instanceMatrix = new THREE.Matrix4();
                                 mesh.getMatrixAt(instanceId, instanceMatrix);
                                 const worldMatrix = instanceMatrix.premultiply(mesh.matrixWorld);
                                 const invWorldMatrix = worldMatrix.invert();
                                 const localPivot = pivotWorld.applyMatrix4(invWorldMatrix);

                                 if (mesh.isBatchedMesh || mesh.isInstancedMesh) {
                                     if (!mesh.userData.customPivots) mesh.userData.customPivots = new Map();
                                     mesh.userData.customPivots.set(instanceId, localPivot);
                                 } else {
                                     mesh.userData.customPivot = localPivot;
                                 }
                                 mesh.userData.isCustomPivot = true;
                             }
                        }
                    }
                }

                // Preserve the user's pivotMode (e.g. allow creating a custom pivot while in center mode).
                if (_pivotEditPreviousPivotMode) {
                    pivotMode = _pivotEditPreviousPivotMode;
                }

                // Multi-selection no longer writes per-object pivots, so no ephemeral undo is needed.
                // Keep the hook for any future cases where we might snapshot state.
                if (_pivotEditUndoCapture) _ephemeralPivotUndo = _pivotEditUndoCapture;
                _pivotEditUndoCapture = null;

                // Keep the gizmo anchor at the edited pivot location.
                _gizmoAnchorPosition.copy(selectionHelper.position);
                _gizmoAnchorValid = true;
                _selectionAnchorMode = 'default';

                // Multi-selection: remember the edited custom pivot location as the origin anchor.
                if (_isMultiSelection()) {
                    _multiSelectionOriginAnchorPosition.copy(selectionHelper.position);
                    _multiSelectionOriginAnchorValid = true;
                    // Do not overwrite the initial anchor; pivot reset should restore that.
                    if (!_multiSelectionOriginAnchorInitialValid) {
                        _multiSelectionOriginAnchorInitialPosition.copy(selectionHelper.position);
                        _multiSelectionOriginAnchorInitialValid = true;
                    }
                }
            } else {
                _recomputePivotStateForSelection();

                // If we were transforming a multi-selection in Pivot Mode: origin, keep the cached
                // origin anchor following the moved gizmo.
                if (_isMultiSelection() && pivotMode === 'origin') {
                    _multiSelectionOriginAnchorPosition.copy(selectionHelper.position);
                    _multiSelectionOriginAnchorValid = true;
                }
            }

            // Invalidate bounding spheres for all affected meshes
            if (currentSelection.objects && currentSelection.objects.size > 0) {
                for (const [mesh] of currentSelection.objects) {
                    if (mesh) mesh.boundingSphere = null;
                }
            }

            if (selectionHelper) {
                selectionHelper.scale.set(1, 1, 1);
                selectionHelper.updateMatrixWorld();
                previousHelperMatrix.copy(selectionHelper.matrixWorld);
            }
        }
    });

    transformControls.addEventListener('change', (event) => {
        if (transformControls.dragging && _hasAnySelection()) {
            
            if (isPivotEditMode && transformControls.mode === 'translate') {
                // Snapping Logic
                // Snapping Logic
                const snapTarget = Overlay.findClosestVertexForSnapping(selectionHelper.position, camera, renderer);
                if (snapTarget) {
                    selectionHelper.position.copy(snapTarget);
                }

                // Keep pivotOffset consistent with SelectionCenter(origin) baseline (group uses box.min, block_display uses min when not custom).
                pivotOffset.subVectors(selectionHelper.position, dragStartPivotBaseWorld);
                isCustomPivot = true;

                // Multi-selection: keep the origin anchor in sync with the edited pivot while dragging.
                if (_isMultiSelection()) {
                    _multiSelectionOriginAnchorPosition.copy(selectionHelper.position);
                    _multiSelectionOriginAnchorValid = true;
                }
                previousHelperMatrix.copy(selectionHelper.matrixWorld);
                return;
            }

            if (blockbenchScaleMode && transformControls.mode === 'scale' && !isUniformScale) {
                const shiftWorld = computeBlockbenchScaleShift(selectionHelper, dragInitialScale, dragInitialPosition, dragInitialBoundingBox, dragAnchorDirections, currentSpace);

                if (shiftWorld) {
                    selectionHelper.position.copy(dragInitialPosition).add(shiftWorld);
                    selectionHelper.updateMatrixWorld();
                }
            }

            selectionHelper.updateMatrixWorld();
            _tmpPrevInvMatrix.copy(previousHelperMatrix).invert();
            _tmpDeltaMatrix.multiplyMatrices(selectionHelper.matrixWorld, _tmpPrevInvMatrix);

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

            for (const [mesh, instanceIds] of _meshToInstanceIds) {
                _tmpMeshWorldInverse.copy(mesh.matrixWorld).invert();
                _tmpLocalDelta.multiplyMatrices(_tmpMeshWorldInverse, _tmpDeltaMatrix);
                _tmpLocalDelta.multiply(mesh.matrixWorld);

                for (let i = 0; i < instanceIds.length; i++) {
                    const instanceId = instanceIds[i];
                    mesh.getMatrixAt(instanceId, _tmpInstanceMatrix);
                    _tmpInstanceMatrix.premultiply(_tmpLocalDelta);
                    mesh.setMatrixAt(instanceId, _tmpInstanceMatrix);
                }

                if (mesh.isInstancedMesh) {
                    mesh.instanceMatrix.needsUpdate = true;
                }
            }

            if (currentSelection.groups && currentSelection.groups.size > 0) {
                const groups = getGroups();
                const toUpdate = new Set();

                for (const rootId of currentSelection.groups) {
                    if (!rootId) continue;
                    toUpdate.add(rootId);
                    const descendants = getAllDescendantGroups(rootId);
                    for (const subId of descendants) toUpdate.add(subId);
                }

                for (const id of toUpdate) {
                    const g = groups.get(id);
                    if (!g) continue;

                    if (!g.matrix) {
                        const gPos = g.position || new THREE.Vector3();
                        const gQuat = g.quaternion || new THREE.Quaternion();
                        const gScale = g.scale || new THREE.Vector3(1, 1, 1);
                        g.matrix = new THREE.Matrix4().compose(gPos, gQuat, gScale);
                    }

                    g.matrix.premultiply(_tmpDeltaMatrix);
                    if (!g.position) g.position = new THREE.Vector3();
                    if (!g.quaternion) g.quaternion = new THREE.Quaternion();
                    if (!g.scale) g.scale = new THREE.Vector3(1, 1, 1);
                    g.matrix.decompose(g.position, g.quaternion, g.scale);
                }
            }

            previousHelperMatrix.copy(selectionHelper.matrixWorld);

            // Keep overlay in sync without rebuilding geometry
            Overlay.syncSelectionOverlay(_tmpDeltaMatrix);

            // White multi-selection overlay must stay world-aligned (no rotation).
            _updateMultiSelectionOverlayDuringDrag();
        }
    });

    const handleKeyPress = (key) => {
        const resetHelperRotationForWorldSpace = () => {
            if (currentSpace !== 'world') return;
            const items = getSelectedItems();
            if (items.length > 0) {
                selectionHelper.quaternion.set(0, 0, 0, 1);
                selectionHelper.updateMatrixWorld();
                previousHelperMatrix.copy(selectionHelper.matrixWorld);
            }
        };

        switch (key) {
            case 'v':
                isVertexMode = !isVertexMode;
                console.log(isVertexMode ? 'Vertex mode activated' : 'Vertex mode deactivated');

                if (!isVertexMode) {
                    for (let i = vertexQueue.length - 1; i >= 0; i--) {
                        const item = vertexQueue[i];
                        let isSelected = false;

                        if (item.type === 'group') {
                            if (currentSelection.groups.has(item.id)) isSelected = true;
                        } else {
                            const ids = currentSelection.objects.get(item.mesh);
                            if (ids && ids.has(item.instanceId)) {
                                isSelected = true;
                            }
                        }

                        if (!isSelected) {
                            vertexQueue.splice(i, 1);
                        }
                    }
                }

                updateHelperPosition();
                updateSelectionOverlay();
                break;
            case 't':
                transformControls.setMode('translate');
                resetHelperRotationForWorldSpace();
                break;
            case 'r':
                transformControls.setMode('rotate');
                resetHelperRotationForWorldSpace();
                break;
            case 's':
                transformControls.setMode('scale');
                resetHelperRotationForWorldSpace();
                break;
            case 'd':
                duplicateSelected();
                break;
            case 'x': {
                currentSpace = currentSpace === 'world' ? 'local' : 'world';
                transformControls.setSpace(currentSpace);
                updateHelperPosition();
                updateSelectionOverlay();
                console.log('TransformControls Space:', currentSpace);
                break;
            }
            case 'z': {
                // Attempt to preserve "Gizmo Center" selection across pivot mode changes.
                // The Gizmo Center moves when pivot mode changes, invalidating its selection Key.
                // We capture the old key, and if selected, migrate it to the new key after update.
                const oldPos = selectionHelper.position.clone();
                const oldKey = `CENTER_${oldPos.x.toFixed(4)}_${oldPos.y.toFixed(4)}_${oldPos.z.toFixed(4)}`;
                const wasCenterSelected = selectedVertexKeys.has(oldKey);

                // If non-center vertices are selected, we keep them (they don't move).
                
                if (pivotMode === 'center') {
                    const prevPos = selectionHelper.position.clone();
                    updateHelperPosition();
                    if (prevPos.distanceTo(selectionHelper.position) < 0.001) {
                        pivotMode = 'origin';
                        updateHelperPosition();
                    }
                } else {
                    pivotMode = 'center';
                    updateHelperPosition();
                }

                if (wasCenterSelected) {
                    selectedVertexKeys.delete(oldKey);
                    const newPos = selectionHelper.position;
                    const newKey = `CENTER_${newPos.x.toFixed(4)}_${newPos.y.toFixed(4)}_${newPos.z.toFixed(4)}`;
                    selectedVertexKeys.add(newKey);
                }

                updateSelectionOverlay();
                console.log('Pivot Mode:', pivotMode);
                break;
            }
            case 'q': {
                const items = getSelectedItems();
                if (items.length > 0) {
                    removeShearFromSelection(
                        items,
                        selectionHelper,
                        currentSelection,
                        loadedObjectGroup,
                        pivotMode,
                        isCustomPivot,
                        pivotOffset,
                        { SelectionCenter, updateHelperPosition, updateSelectionOverlay }
                    );
                }
                break;
            }
            case 'b': {
                toggleBlockbenchScaleMode();
                break;
            }
            case 'g': {
                // If exactly one group is selected (and no objects), ungroup it.
                // If 2+ groups are selected, group the groups together.
                const groupCount = currentSelection.groups ? currentSelection.groups.size : 0;
                const hasObjects = currentSelection.objects && currentSelection.objects.size > 0;

                if (groupCount === 1 && !hasObjects) {
                    const gid = Array.from(currentSelection.groups)[0];
                    if (gid) ungroupGroup(gid);
                    resetSelectionAndDeselect();
                    break;
                }

                const items = getSelectedItems();
                if (items.length > 0) createGroup();
                break;
            }
        }
    };

    window.addEventListener('keydown', (event) => {
        if (event.target.tagName === 'INPUT' || event.target.tagName === 'TEXTAREA') return;

        if (event.key.toLowerCase() === 'f') {
            event.preventDefault();
            focusCameraOnSelection(camera, controls, _hasAnySelection(), getSelectionBoundingBox, _getSelectionCenterWorld);
            return;
        }

        if (event.key === 'Delete' || event.key === 'Backspace') {
            event.preventDefault();
            deleteSelectedItems();
            return;
        }

        // Ctrl+Shift+A: select all objects directly (ignore groups)
        if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'a') {
            event.preventDefault();
            const all = _selectAllObjectsVisibleInScene();
            
            let totalCount = 0;
            for (const [mesh, ids] of all) {
                totalCount += ids.size;
            }

            const mode = (totalCount > 1) ? 'center' : 'default';
            _replaceSelectionWithObjectsMap(all, { anchorMode: mode });
            return;
        }

        // Ctrl+A: select all (no first selection, so anchor at center)
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
            event.preventDefault();
            const groupIds = new Set();
            const meshToIds = new Map();

            if (loadedObjectGroup) {
                const objectToGroup = getObjectToGroup();
                loadedObjectGroup.traverse((obj) => {
                    if (!obj || (!obj.isInstancedMesh && !obj.isBatchedMesh)) return;
                    if (obj.visible === false) return;

                    const instanceCount = getInstanceCount(obj);
                    if (instanceCount <= 0) return;

                    for (let instanceId = 0; instanceId < instanceCount; instanceId++) {
                        if (!isInstanceValid(obj, instanceId)) continue;

                        const key = getGroupKey(obj, instanceId);
                        const immediateGroupId = objectToGroup.get(key);
                        if (immediateGroupId) {
                            const chain = getGroupChain(immediateGroupId);
                            const root = chain && chain.length > 0 ? chain[0] : immediateGroupId;
                            if (root) groupIds.add(root);
                            continue;
                        }

                        let set = meshToIds.get(obj);
                        if (!set) {
                            set = new Set();
                            meshToIds.set(obj, set);
                        }
                        set.add(instanceId);
                    }
                });
            }

            let objectCount = 0;
            for (const [mesh, ids] of meshToIds) {
                objectCount += ids.size;
            }

            const totalCount = groupIds.size + objectCount;
            const mode = (totalCount > 1) ? 'center' : 'default';

            _replaceSelectionWithGroupsAndObjects(groupIds, meshToIds, { anchorMode: mode });
            return;
        }

        // Ctrl+G: force ungroup for selected groups (even if multiple groups are selected)
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'g') {
            event.preventDefault();
            const hasGroups = currentSelection.groups && currentSelection.groups.size > 0;
            if (hasGroups) {
                const ids = Array.from(currentSelection.groups);
                // Ungroup all selected groups (safe order: deeper first)
                ids.sort((a, b) => getGroupChain(a).length - getGroupChain(b).length).reverse();
                ids.forEach(id => ungroupGroup(id));
                resetSelectionAndDeselect();
            }
            return;
        }

        if (event.key === 'Alt') {
            event.preventDefault();
            if (!isPivotEditMode) {
                isPivotEditMode = true;
                previousGizmoMode = transformControls.mode;
                _pivotEditPreviousPivotMode = pivotMode;
                transformControls.setMode('translate');
            }
        }

        if (event.altKey && event.ctrlKey) {
            if (event.key === 'Alt' || event.key === 'Control') {
                event.preventDefault();

                const isMultiReset = _isMultiSelection();
                const wasCustomPivot = isCustomPivot;

                // Reset should also drop any ephemeral multi-selection pivot edits.
                _revertEphemeralPivotUndoIfAny();

                pivotOffset.set(0, 0, 0);
                isCustomPivot = false;

                let shouldClearAll = true;
                if (isMultiReset && wasCustomPivot) {
                    shouldClearAll = false;
                }

                if (shouldClearAll) {
                    // Clear ALL group pivots
                    if (currentSelection.groups && currentSelection.groups.size > 0) {
                        const groups = getGroups();
                        for (const groupId of currentSelection.groups) {
                            const group = groups.get(groupId);
                            if (!group) continue;
                            group.pivot = _DEFAULT_GROUP_PIVOT.clone();
                            delete group.isCustomPivot;
                        }
                    }

                    // Clear ALL object pivots
                    if (currentSelection.objects && currentSelection.objects.size > 0) {
                        for (const [mesh, ids] of currentSelection.objects) {
                            if (!mesh) continue;
                            if ((mesh.isBatchedMesh || mesh.isInstancedMesh) && mesh.userData.customPivots) {
                                for (const id of ids) mesh.userData.customPivots.delete(id);
                            }
                            delete mesh.userData.customPivot;
                            delete mesh.userData.isCustomPivot;
                        }
                    }
                } else {
                    // Clear ONLY Primary pivot (acts as selection pivot)
                    if (currentSelection.primary) {
                        if (currentSelection.primary.type === 'group') {
                            const groups = getGroups();
                            const group = groups.get(currentSelection.primary.id);
                            if (group) {
                                group.pivot = _DEFAULT_GROUP_PIVOT.clone();
                                delete group.isCustomPivot;
                            }
                        } else if (currentSelection.primary.type === 'object') {
                            const { mesh, instanceId } = currentSelection.primary;
                            if (mesh) {
                                if ((mesh.isBatchedMesh || mesh.isInstancedMesh) && mesh.userData.customPivots) {
                                    mesh.userData.customPivots.delete(instanceId);
                                }
                                delete mesh.userData.customPivot;
                                delete mesh.userData.isCustomPivot;
                            }
                        }
                    }
                }

                _recomputePivotStateForSelection();

                // Multi-selection: clear the origin anchors so they recompute based on current positions.
                if (_isMultiSelection()) {
                    let restoredToPrimary = false;

                    // Reset to the CURRENT position of the primary object (geometric origin).
                    // We prefer the Primary as the origin reset target.
                    if (currentSelection.primary) {
                        const prim = currentSelection.primary;
                        const targetPos = new THREE.Vector3();
                        let found = false;

                        if (prim.type === 'group') {
                            getGroupOriginWorld(prim.id, targetPos);
                            found = true;
                        } else if (prim.type === 'object' && prim.mesh) {
                            const tempMat = new THREE.Matrix4();
                            getInstanceWorldMatrixForOrigin(prim.mesh, prim.instanceId, tempMat);
                            const localY = isItemDisplayHatEnabled(prim.mesh, prim.instanceId) ? 0.03125 : 0;
                            targetPos.set(0, localY, 0).applyMatrix4(tempMat);
                            found = true;
                        }

                        if (found) {
                            _multiSelectionOriginAnchorPosition.copy(targetPos);
                            _multiSelectionOriginAnchorValid = true;
                            _gizmoAnchorPosition.copy(targetPos);
                            _gizmoAnchorValid = true;
                            _selectionAnchorMode = 'default';
                            restoredToPrimary = true;
                        }
                    }

                    if (!restoredToPrimary) {
                        _multiSelectionOriginAnchorValid = false;
                        _multiSelectionOriginAnchorInitialValid = false;
                        _gizmoAnchorValid = false;
                        _selectionAnchorMode = 'center';
                    }
                } else {
                    // Not multi-selection: clear multi-selection caches.
                    _multiSelectionOriginAnchorValid = false;
                    _multiSelectionOriginAnchorInitialValid = false;
                    _selectionAnchorMode = 'default';
                }

                updateHelperPosition();
                console.log('Pivot reset to origin');
            }
        }

        if (isGizmoBusy) return;
        const key = event.key.toLowerCase();
        const keysToHandle = ['t', 'r', 's', 'x', 'z', 'q', 'b', 'g', 'd', 'v'];
        if (transformControls.dragging && keysToHandle.includes(key)) {
            isGizmoBusy = true;
            const attachedObject = transformControls.object;
            transformControls.pointerUp({button: 0});
            const oldTarget = controls.target.clone();
            controls.dispose();
            const newControls = new (controls.constructor)(camera, renderer.domElement);
            newControls.screenSpacePanning = true;
            newControls.target.copy(oldTarget);
            newControls.update();
            if (setControls) setControls(newControls);
            controls = newControls;
            setTimeout(() => {
                if (attachedObject) {
                    transformControls.detach();
                    transformControls.attach(attachedObject);
                }
                handleKeyPress(key);
                isGizmoBusy = false;
            }, 0);
            return;
        }
        if (keysToHandle.includes(key)) {
            isGizmoBusy = true;
            handleKeyPress(key);
            setTimeout(() => { isGizmoBusy = false; }, 50);
        }
        });

    window.addEventListener('keyup', (event) => {
        if (event.key === 'Alt') {
            if (isPivotEditMode) {
                isPivotEditMode = false;
                transformControls.setMode(previousGizmoMode);
                _pivotEditPreviousPivotMode = null;
            }
        }
    });
    const clearAltState = () => {
        if (isPivotEditMode) {
            isPivotEditMode = false;
            try {
                transformControls.setMode(previousGizmoMode);
            } catch (err) {
                console.warn('Failed to restore transformControls mode on blur/visibility change', err);
            }
        }
        isGizmoBusy = false;
        try {
            if (transformControls && transformControls.dragging) {
                transformControls.pointerUp({ button: 0 });
            }
        } catch (err) {
        }
    };
    const resetOrbitControls = () => {
        if (controls && setControls) {
            const oldTarget = controls.target.clone();
            const oldScreenSpacePanning = controls.screenSpacePanning;
            controls.dispose();
            
            const newControls = new (controls.constructor)(camera, renderer.domElement);
            newControls.screenSpacePanning = oldScreenSpacePanning;
            newControls.target.copy(oldTarget);
            newControls.update();
            
            setControls(newControls);
            controls = newControls;
        }
    }

    window.addEventListener('blur', () => {
        clearAltState();
        resetOrbitControls();
    });
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            clearAltState();
            resetOrbitControls();
        }
    });
    window.addEventListener('focus', () => {
        clearAltState();
    });

    // selection with raycaster
    const raycaster = new THREE.Raycaster();
    raycaster.layers.enable(2);
    const mouse = new THREE.Vector2();
    let mouseDownPos = null;
    const cameraMatrixOnPointerDown = new THREE.Matrix4();

    // Vertex Interaction Helper
    function getHoveredVertex(mouseNDC) {
        if (!isVertexMode) return null;
        return Overlay.getHoveredVertex(mouseNDC, camera, renderer);
    }
    
    // Vertex Selection State is managed by selectedVertexKeys

    const dragControls = initDrag({
        renderer,
        camera,
        getControls: () => controls,
        transformControls,
        loadedObjectGroup,
        getSelectionCallbacks: () => getSelectionCallbacks()
    });

    renderer.domElement.addEventListener('pointermove', (event) => {
        if (transformControls.dragging || dragControls.isMarqueeActiveOrCandidate()) return;
        
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
    // Programmatic selection helpers (used by project merge workflow)
    loadedObjectGroup.userData.replaceSelectionWithObjectsMap = (meshToIds, options) => {
        _replaceSelectionWithObjectsMap(meshToIds, options);
    };
    loadedObjectGroup.userData.replaceSelectionWithGroupsAndObjects = (groupIds, meshToIds, options) => {
        _replaceSelectionWithGroupsAndObjects(groupIds, meshToIds, options);
    };

    renderer.domElement.addEventListener('pointerdown', (event) => {
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
                const key = v.userData.key;
                
                // Toggle selection logic
                if (selectedVertexKeys.has(key)) {
                    selectedVertexKeys.delete(key);
                } else {
                    selectedVertexKeys.add(key);

                    if (transformControls.mode === 'translate' && selectedVertexKeys.size === 2) {
                        const getGizmoState = () => ({
                            pivotMode, isCustomPivot, pivotOffset,
                            _gizmoAnchorValid, _gizmoAnchorPosition,
                            _multiSelectionOriginAnchorValid, _multiSelectionOriginAnchorPosition,
                            _multiSelectionOriginAnchorInitialValid, _multiSelectionOriginAnchorInitialPosition
                        });
                        const setGizmoState = (updates) => {
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

                        processVertexSnap(selectedVertexKeys, {
                            isVertexMode,
                            gizmoMode: transformControls.mode,
                            currentSelection, loadedObjectGroup, selectionHelper,
                            getGizmoState, setGizmoState,
                            getGroups, getGroupWorldMatrixWithFallback, getGroupWorldMatrix,
                            updateHelperPosition, updateSelectionOverlay,
                            _isMultiSelection, _getSingleSelectedGroupId, SelectionCenter,
                            vertexQueue
                        });
                    }
                }
                
                Overlay.refreshSelectionPointColors(selectedVertexKeys);
                mouseDownPos = null; // Prevent object selection/marquee
                return;
            } 
            // Removed automatic deselection on miss to allow camera controls
        }

        if (dragControls.onPointerDown(event)) {
             mouseDownPos = { x: event.clientX, y: event.clientY };
             cameraMatrixOnPointerDown.copy(camera.matrixWorld);
             return;
        }

        mouseDownPos = { x: event.clientX, y: event.clientY };
        cameraMatrixOnPointerDown.copy(camera.matrixWorld);
    }, true);

    renderer.domElement.addEventListener('pointermove', (event) => {
        dragControls.onPointerMove(event);
    });

    renderer.domElement.addEventListener('pointerup', (event) => {
        if (dragControls.onPointerUp(event)) {
            mouseDownPos = null;
            return;
        }

        if (!mouseDownPos) return;

        // If camera has moved, it's a drag, not a click.
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
            setSelectionAnchorMode: (mode) => { _selectionAnchorMode = mode; },
            resetPivotState: () => { 
                pivotOffset.set(0, 0, 0); 
                isCustomPivot = false; 
            }
        });
    });

    return {
        getTransformControls: () => transformControls,
        updateGizmo: () => {
            // gizmo axis positive/negative toggling
            if (_hasAnySelection() && transformControls.object && (transformControls.mode === 'translate' || transformControls.mode === 'scale')) {
                const gizmoPos = transformControls.object.position;
                const camPos = camera.position;
                const direction = camPos.clone().sub(gizmoPos).normalize();
                if (currentSpace === 'local') direction.applyQuaternion(transformControls.object.quaternion.clone().invert());
                const axesConfig = {
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
                            originalLines.forEach(line => { if (line.material) { line.material.transparent = true; line.material.opacity = 1; line.material._opacity = 1; } });
                            negativeLines.forEach(line => { if (line.material) { line.material.transparent = true; line.material.opacity = 0.001; line.material._opacity = 0.001; } });
                        } else {
                            negativeLines.forEach(line => { if (line.material) { line.material.transparent = true; line.material.opacity = 1; line.material._opacity = 1; } });
                            originalLines.forEach(line => { if (line.material) { line.material.transparent = true; line.material.opacity = 0.001; line.material._opacity = 0.001; } });
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

export { initGizmo };