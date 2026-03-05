import * as THREE from 'three/webgpu';
// @ts-ignore
import * as GroupUtils from './group';
// @ts-ignore
import * as Overlay from './overlay.js';

/**
 * Interface representing an element in the selection (either a group or a specific object instance).
 */
export interface SelectionElement {
    type: 'group' | 'object';
    id?: string;
    mesh?: THREE.Mesh | THREE.BatchedMesh | THREE.InstancedMesh;
    instanceId?: number;
}

/**
 * Interface representing the current selection state.
 */
export interface CurrentSelection {
    primary?: SelectionElement;
    groups?: Set<string>;
    objects?: Map<THREE.Mesh | THREE.BatchedMesh | THREE.InstancedMesh, Set<number>>;
}

/**
 * Callbacks required for computing pivot states and selection centers.
 */
export interface CustomPivotCallbacks {
    getSingleSelectedGroupId: () => string | null;
    getSingleSelectedMeshEntry: () => { mesh: THREE.Mesh | THREE.BatchedMesh | THREE.InstancedMesh, instanceId: number } | null;
    getSelectedItems: () => SelectionElement[];
    getSelectionBoundingBox: () => THREE.Box3 | null;
    calculateAvgOrigin: () => THREE.Vector3;
}

// --- Imports from Overlay (mirrors gizmo.js aliases) ---
const getInstanceWorldMatrixForOrigin = Overlay.getInstanceWorldMatrixForOrigin;
const getDisplayType = Overlay.getDisplayType;
const isItemDisplayHatEnabled = Overlay.isItemDisplayHatEnabled;
const getInstanceLocalBoxMin = Overlay.getInstanceLocalBoxMin;
const getGroupWorldMatrixWithFallback = Overlay.getGroupWorldMatrixWithFallback;
const getGroupLocalBoundingBox = Overlay.getGroupLocalBoundingBox;

// --- State Variables managed by CustomPivot ---
let _ephemeralPivotUndo: (() => void) | null = null;
let _pivotEditUndoCapture: (() => void) | null = null;

// Small shared temporaries
const _TMP_MAT4_A = new THREE.Matrix4();


// --- Public API Functions ---

export function clearEphemeralPivotUndo(): void {
    _ephemeralPivotUndo = null;
    _pivotEditUndoCapture = null;
}

export function revertEphemeralPivotUndoIfAny(): void {
    if (!_ephemeralPivotUndo) return;
    try {
        _ephemeralPivotUndo();
    } finally {
        clearEphemeralPivotUndo();
    }
}

/**
 * Captures per-object custom pivot writes so they can be reverted.
 */
export function capturePivotUndoForCurrentSelection(currentSelection: CurrentSelection): (() => void) | null {
    const undoFns: (() => void)[] = [];

    if (currentSelection.objects && currentSelection.objects.size > 0) {
        for (const [mesh, ids] of currentSelection.objects) {
            if (!mesh || !ids || ids.size === 0) continue;

            const userData = mesh.userData as any;
            const hadIsCustomPivot = Object.prototype.hasOwnProperty.call(userData, 'isCustomPivot');
            const prevIsCustomPivot = userData.isCustomPivot;
            undoFns.push(() => {
                if (!mesh.userData) return;
                if (hadIsCustomPivot) (mesh.userData as any).isCustomPivot = prevIsCustomPivot;
                else delete (mesh.userData as any).isCustomPivot;
            });

            const isInstancedLike = !!((mesh as any).isBatchedMesh || (mesh as any).isInstancedMesh);
            if (isInstancedLike) {
                const hadMap = Object.prototype.hasOwnProperty.call(userData, 'customPivots') && userData.customPivots;
                const prevById = new Map<number, THREE.Vector3 | undefined>();
                for (const id of ids) {
                    const prev = hadMap ? (userData.customPivots as Map<number, THREE.Vector3>).get(id) : undefined;
                    prevById.set(id, prev ? prev.clone() : undefined);
                }
                undoFns.push(() => {
                    if (!mesh.userData) return;
                    if (!(mesh.userData as any).customPivots) (mesh.userData as any).customPivots = new Map<number, THREE.Vector3>();
                    const customPivots = (mesh.userData as any).customPivots as Map<number, THREE.Vector3>;
                    for (const [id, prev] of prevById) {
                        if (prev === undefined) customPivots.delete(id);
                        else customPivots.set(id, prev.clone());
                    }
                    if (!hadMap && customPivots.size === 0) {
                        delete (mesh.userData as any).customPivots;
                    }
                });
            } else {
                const hadCustomPivot = Object.prototype.hasOwnProperty.call(userData, 'customPivot');
                const prevCustomPivot = userData.customPivot ? (userData.customPivot as THREE.Vector3).clone() : undefined;
                undoFns.push(() => {
                    if (!mesh.userData) return;
                    if (hadCustomPivot) (mesh.userData as any).customPivot = prevCustomPivot ? prevCustomPivot.clone() : undefined;
                    else delete (mesh.userData as any).customPivot;
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
                // Ignore errors during undo
            }
        }
    };
}

/**
 * Recomputes pivot state for the selection.
 */
export function recomputePivotStateForSelection(
    pivotMode: string, 
    isMultiSelection: boolean, 
    isCustomPivot: boolean, 
    pivotOffset: THREE.Vector3, 
    currentSelection: CurrentSelection,
    loadedObjectGroup: THREE.Group,
    callbacks: Pick<CustomPivotCallbacks, 'getSingleSelectedGroupId' | 'getSingleSelectedMeshEntry'>
): boolean {
    const { getSingleSelectedGroupId, getSingleSelectedMeshEntry } = callbacks;

    const preserveMultiCustomPivot = pivotMode === 'origin' && isMultiSelection && isCustomPivot;
    let newIsCustomPivot = isCustomPivot;
    
    if (!preserveMultiCustomPivot) {
        pivotOffset.set(0, 0, 0);
        newIsCustomPivot = false;
    }

    const singleGroupId = getSingleSelectedGroupId();
    if (singleGroupId) {
        pivotOffset.set(0, 0, 0);
        newIsCustomPivot = false;
        const groups = GroupUtils.getGroups(loadedObjectGroup) as Map<string, any>;
        const group = groups.get(singleGroupId);
        if (group && GroupUtils.shouldUseGroupPivot(group)) {
            const localPivot = GroupUtils.normalizePivotToVector3(group.pivot, new THREE.Vector3());
            if (localPivot) {
                const groupMatrix = GroupUtils.getGroupWorldMatrix(group, new THREE.Matrix4());
                const targetWorld = localPivot.clone().applyMatrix4(groupMatrix);
                
                const baseWorld = new THREE.Vector3(0, 0, 0);
                const box = getGroupLocalBoundingBox(singleGroupId) as THREE.Box3;
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

    pivotOffset.set(0, 0, 0);
    newIsCustomPivot = false;

    const mesh = singleMeshEntry.mesh;
    const instanceId = singleMeshEntry.instanceId;
    if (!mesh) return newIsCustomPivot;

    let customPivot: THREE.Vector3 | null = null;
    const userData = mesh.userData as any;
    if (((mesh as any).isBatchedMesh || (mesh as any).isInstancedMesh) && userData.customPivots) {
        if (userData.customPivots.has(instanceId)) {
            customPivot = userData.customPivots.get(instanceId);
        }
    } else if (userData.customPivot) {
        customPivot = userData.customPivot;
    }

    if (!customPivot) return newIsCustomPivot;

    newIsCustomPivot = true;
    
    const center = new THREE.Vector3();
    const tempMat = new THREE.Matrix4();
    const tempPos = new THREE.Vector3();
    
    getInstanceWorldMatrixForOrigin(mesh, instanceId, tempMat);
    const localY = isItemDisplayHatEnabled(mesh, instanceId) ? 0.03125 : 0;
    tempPos.set(0, localY, 0).applyMatrix4(tempMat);
    center.add(tempPos);

    (mesh as any).getMatrixAt(instanceId, tempMat);
    const worldMatrix = tempMat.premultiply(mesh.matrixWorld);
    const targetWorld = customPivot.clone().applyMatrix4(worldMatrix);
    pivotOffset.subVectors(targetWorld, center);

    return newIsCustomPivot;
}

/**
 * Calculates the world center of the current selection based on the pivot mode.
 */
export function SelectionCenter(
    pivotMode: string, 
    isCustomPivot: boolean, 
    pivotOffset: THREE.Vector3, 
    currentSelection: CurrentSelection,
    loadedObjectGroup: THREE.Group,
    callbacks: CustomPivotCallbacks
): THREE.Vector3 {
    const { getSelectedItems, getSelectionBoundingBox, getSingleSelectedGroupId, calculateAvgOrigin } = callbacks;
    
    const center = new THREE.Vector3();
    const items = getSelectedItems();
    
    if (items.length === 0) return center;

    if (pivotMode === 'center') {
        const singleGroupId = getSingleSelectedGroupId();
        if (singleGroupId) {
            const groups = GroupUtils.getGroups(loadedObjectGroup) as Map<string, any>;
            const group = groups.get(singleGroupId);
            const box = getGroupLocalBoundingBox(singleGroupId) as THREE.Box3;
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
        // Origin Mode
        const singleGroupId = getSingleSelectedGroupId();
        if (singleGroupId) {
            const groups = GroupUtils.getGroups(loadedObjectGroup) as Map<string, any>;
            const group = groups.get(singleGroupId);

            const box = getGroupLocalBoundingBox(singleGroupId) as THREE.Box3;
            if (!box.isEmpty()) {
                const groupMatrix = getGroupWorldMatrixWithFallback(singleGroupId, new THREE.Matrix4());
                center.copy(box.min).applyMatrix4(groupMatrix);
            } else if (group && group.position) {
                center.copy(group.position);
            } else {
                center.copy(calculateAvgOrigin());
            }
        } else if (currentSelection.groups && currentSelection.groups.size > 0) {
            const firstGroupId = Array.from(currentSelection.groups)[0];
            const groups = GroupUtils.getGroups(loadedObjectGroup) as Map<string, any>;
            const group = groups.get(firstGroupId);
            const box = getGroupLocalBoundingBox(firstGroupId) as THREE.Box3;
            if (!box.isEmpty()) {
                const groupMatrix = getGroupWorldMatrixWithFallback(firstGroupId, new THREE.Matrix4());
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

export function setEphemeralPivotUndo(undoFn: (() => void) | null): void {
    _ephemeralPivotUndo = undoFn;
}

export function setPivotEditUndoCapture(undoFn: (() => void) | null): void {
    _pivotEditUndoCapture = undoFn;
}

export function getPivotEditUndoCapture(): (() => void) | null {
    return _pivotEditUndoCapture;
}
