import * as THREE from 'three/webgpu';
import * as GroupUtils from './group.js';
import * as Overlay from './overlay.js';

// --- Imports from Overlay (mirrors gizmo.js aliases) ---
const getInstanceWorldMatrixForOrigin = Overlay.getInstanceWorldMatrixForOrigin;
const getDisplayType = Overlay.getDisplayType;
const isItemDisplayHatEnabled = Overlay.isItemDisplayHatEnabled;
const getInstanceLocalBoxMin = Overlay.getInstanceLocalBoxMin;
const getGroupWorldMatrixWithFallback = Overlay.getGroupWorldMatrixWithFallback;
const getGroupLocalBoundingBox = Overlay.getGroupLocalBoundingBox;

// --- State Variables managed by CustomPivot ---
// Warning: These are module-level variables. 
// In a fuller refactor, these might be part of a class instance or passed in consistently.
let _ephemeralPivotUndo = null;
let _pivotEditUndoCapture = null;

// Small shared temporaries
const _TMP_MAT4_A = new THREE.Matrix4();


// --- Public API Functions ---

export function clearEphemeralPivotUndo() {
    _ephemeralPivotUndo = null;
    _pivotEditUndoCapture = null;
}

export function revertEphemeralPivotUndoIfAny() {
    if (!_ephemeralPivotUndo) return;
    try {
        _ephemeralPivotUndo();
    } finally {
        clearEphemeralPivotUndo();
    }
}

export function capturePivotUndoForCurrentSelection(currentSelection) {
    const undoFns = [];

    // Legacy helper: captures per-object custom pivot writes so they can be reverted.
    // Multi-selection pivot edit no longer writes per-object pivots, so this is normally unused.
    if (currentSelection.objects && currentSelection.objects.size > 0) {
        for (const [mesh, ids] of currentSelection.objects) {
            if (!mesh || !ids || ids.size === 0) continue;

            const hadIsCustomPivot = Object.prototype.hasOwnProperty.call(mesh.userData, 'isCustomPivot');
            const prevIsCustomPivot = mesh.userData.isCustomPivot;
            undoFns.push(() => {
                if (!mesh.userData) return;
                if (hadIsCustomPivot) mesh.userData.isCustomPivot = prevIsCustomPivot;
                else delete mesh.userData.isCustomPivot;
            });

            const isInstancedLike = !!(mesh.isBatchedMesh || mesh.isInstancedMesh);
            if (isInstancedLike) {
                const hadMap = Object.prototype.hasOwnProperty.call(mesh.userData, 'customPivots') && mesh.userData.customPivots;
                const prevById = new Map();
                for (const id of ids) {
                    const prev = hadMap ? mesh.userData.customPivots.get(id) : undefined;
                    prevById.set(id, prev ? prev.clone() : undefined);
                }
                undoFns.push(() => {
                    if (!mesh.userData) return;
                    if (!mesh.userData.customPivots) mesh.userData.customPivots = new Map();
                    for (const [id, prev] of prevById) {
                        if (prev === undefined) mesh.userData.customPivots.delete(id);
                        else mesh.userData.customPivots.set(id, prev.clone());
                    }
                    if (!hadMap && mesh.userData.customPivots.size === 0) {
                        delete mesh.userData.customPivots;
                    }
                });
            } else {
                const hadCustomPivot = Object.prototype.hasOwnProperty.call(mesh.userData, 'customPivot');
                const prevCustomPivot = mesh.userData.customPivot ? mesh.userData.customPivot.clone() : undefined;
                undoFns.push(() => {
                    if (!mesh.userData) return;
                    if (hadCustomPivot) mesh.userData.customPivot = prevCustomPivot ? prevCustomPivot.clone() : undefined;
                    else delete mesh.userData.customPivot;
                });
            }
        }
    }

    if (undoFns.length === 0) return null;
    return () => {
        for (let i = undoFns.length - 1; i >= 0; i--) {
            try {
                undoFns[i]();
            } catch {
            }
        }
    };
}

export function recomputePivotStateForSelection(
    pivotMode, 
    isMultiSelection, 
    isCustomPivot, 
    pivotOffset, 
    currentSelection,
    loadedObjectGroup,
    callbacks // { getSelectedItems, getSingleSelectedGroupId, getSingleSelectedMeshEntry }
) {
    const { getSingleSelectedGroupId, getSingleSelectedMeshEntry } = callbacks;

    const preserveMultiCustomPivot = pivotMode === 'origin' && isMultiSelection && isCustomPivot;
    let newIsCustomPivot = isCustomPivot;
    
    if (!preserveMultiCustomPivot) {
        pivotOffset.set(0, 0, 0);
        newIsCustomPivot = false;
    }

    const singleGroupId = getSingleSelectedGroupId();
    if (singleGroupId) {
        // Single selection should always recompute pivot state.
        pivotOffset.set(0, 0, 0);
        newIsCustomPivot = false;
        const groups = GroupUtils.getGroups(loadedObjectGroup);
        const group = groups.get(singleGroupId);
        if (group && GroupUtils.shouldUseGroupPivot(group)) {
            const localPivot = GroupUtils.normalizePivotToVector3(group.pivot, new THREE.Vector3());
            if (localPivot) {
                const groupMatrix = GroupUtils.getGroupWorldMatrix(group, new THREE.Matrix4());
                const targetWorld = localPivot.clone().applyMatrix4(groupMatrix);
                
                // Group Origin World Calculation inline or helper
                const baseWorld = new THREE.Vector3(0, 0, 0);
                // logic from getGroupOriginWorld:
                const box = getGroupLocalBoundingBox(singleGroupId);
                if (!box.isEmpty()) baseWorld.copy(box.min).applyMatrix4(groupMatrix);
                else {
                    const children = GroupUtils.getAllGroupChildren(loadedObjectGroup, singleGroupId);
                    if (children.length > 0) Overlay.calculateAvgOriginForChildren(children, baseWorld);
                }

                pivotOffset.subVectors(targetWorld, baseWorld);
                newIsCustomPivot = true;
            }
        }
        return newIsCustomPivot;
    }

    const singleMeshEntry = getSingleSelectedMeshEntry();
    if (!singleMeshEntry) return newIsCustomPivot;

    // Single selection should always recompute pivot state.
    pivotOffset.set(0, 0, 0);
    newIsCustomPivot = false;

    const mesh = singleMeshEntry.mesh;
    // singleMeshEntry from Select.getSingleSelectedMeshEntry returns { mesh, instanceId }, not a Set of ids.
    const idsArr = [singleMeshEntry.instanceId];
    if (!mesh || idsArr.length === 0) return newIsCustomPivot;

    let customPivot = null;
    if ((mesh.isBatchedMesh || mesh.isInstancedMesh) && mesh.userData.customPivots && idsArr.length > 0) {
        if (mesh.userData.customPivots.has(idsArr[0])) {
            customPivot = mesh.userData.customPivots.get(idsArr[0]);
        }
    } else if (mesh.userData.customPivot) {
        customPivot = mesh.userData.customPivot;
    }

    if (!customPivot) return newIsCustomPivot;

    newIsCustomPivot = true;
    
    // Calculate Average Origin for single object (just one item)
    // Using inline logic to avoid circular dependency or requiring callbacks for calculateAvgOrigin
    const center = new THREE.Vector3();
    const tempMat = new THREE.Matrix4();
    const tempPos = new THREE.Vector3();
    
    getInstanceWorldMatrixForOrigin(mesh, idsArr[0], tempMat);
    const localY = isItemDisplayHatEnabled(mesh, idsArr[0]) ? 0.03125 : 0;
    tempPos.set(0, localY, 0).applyMatrix4(tempMat);
    center.add(tempPos);
    // divide by 1 is same

    const firstId = idsArr[0];
    mesh.getMatrixAt(firstId, tempMat);
    const worldMatrix = tempMat.premultiply(mesh.matrixWorld);
    const targetWorld = customPivot.clone().applyMatrix4(worldMatrix);
    pivotOffset.subVectors(targetWorld, center);

    return newIsCustomPivot;
}

export function SelectionCenter(
    pivotMode, 
    isCustomPivot, 
    pivotOffset, 
    currentSelection,
    loadedObjectGroup,
    callbacks // { getSelectedItems, getSelectionBoundingBox, getSingleSelectedGroupId, calculateAvgOrigin }
) {
    const { getSelectedItems, getSelectionBoundingBox, getSingleSelectedGroupId, calculateAvgOrigin } = callbacks;
    
    const center = new THREE.Vector3();
    const items = getSelectedItems();
    
    if (items.length === 0) return center;

    if (pivotMode === 'center') {
        const singleGroupId = getSingleSelectedGroupId();
        if (singleGroupId) {
            const groups = GroupUtils.getGroups(loadedObjectGroup);
            const group = groups.get(singleGroupId);
            const box = getGroupLocalBoundingBox(singleGroupId);
            if (!box.isEmpty()) {
                const groupMatrix = getGroupWorldMatrixWithFallback(singleGroupId, _TMP_MAT4_A);
                box.getCenter(center);
                center.applyMatrix4(groupMatrix);
            } else if (group && group.position) {
                center.copy(group.position);
            } else {
                center.copy(calculateAvgOrigin());
            }
        } else {
            const box = getSelectionBoundingBox();
            if (box && !box.isEmpty()) box.getCenter(center);
            else center.copy(calculateAvgOrigin());
        }
    } else {
        // Origin (Average Position)
        const singleGroupId = getSingleSelectedGroupId();
        if (singleGroupId) {
            const groups = GroupUtils.getGroups(loadedObjectGroup);
            const group = groups.get(singleGroupId);

            const box = getGroupLocalBoundingBox(singleGroupId);
            if (!box.isEmpty()) {
                const groupMatrix = getGroupWorldMatrixWithFallback(singleGroupId, new THREE.Matrix4());
                center.copy(box.min).applyMatrix4(groupMatrix);
            } else if (group && group.position) {
                center.copy(group.position);
            } else {
                center.copy(calculateAvgOrigin());
            }
        } else {
             const firstItem = items[0];
             const mesh = firstItem.mesh;
             const displayType = getDisplayType(mesh, firstItem.instanceId);

             const isBlockDisplayWithoutCustomPivot = displayType === 'block_display' && !isCustomPivot; 
             if (isBlockDisplayWithoutCustomPivot) {
                 const localPivot = getInstanceLocalBoxMin(mesh, firstItem.instanceId, new THREE.Vector3(0, 0, 0));
                 if (localPivot) {
                     const worldMatrix = getInstanceWorldMatrixForOrigin(mesh, firstItem.instanceId, new THREE.Matrix4());
                     center.copy(localPivot.applyMatrix4(worldMatrix));
                 } else {
                     center.copy(calculateAvgOrigin());
                 }
             } else {
                 center.copy(calculateAvgOrigin());
             }
        }
    }

    // Apply offset only in Origin mode. Custom pivots are offsets from Origin.
    if (pivotMode === 'origin') {
        center.add(pivotOffset);
    }

    return center;
}

export function setEphemeralPivotUndo(undoFn) {
    _ephemeralPivotUndo = undoFn;
}

export function setPivotEditUndoCapture(undoFn) {
    _pivotEditUndoCapture = undoFn;
}

export function getPivotEditUndoCapture() {
    return _pivotEditUndoCapture;
}
