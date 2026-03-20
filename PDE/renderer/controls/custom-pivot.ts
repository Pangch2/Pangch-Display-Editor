import {
    Mesh,
    BatchedMesh,
    InstancedMesh,
    Box3,
    Vector3,
    Matrix4,
    Group
} from 'three/webgpu';
// @ts-ignore
import * as GroupUtils from './group';
// @ts-ignore
import * as Overlay from './overlay';

/**
 * Interface representing an element in the selection (either a group or a specific object instance).
 */
export interface SelectionElement {
    type: 'group' | 'object';
    id?: string;
    mesh?: Mesh | BatchedMesh | InstancedMesh;
    instanceId?: number;
}

/**
 * Interface representing the current selection state.
 */
export interface CurrentSelection {
    primary?: SelectionElement;
    groups?: Set<string>;
    objects?: Map<Mesh | BatchedMesh | InstancedMesh, Set<number>>;
}

/**
 * Callbacks required for computing pivot states and selection centers.
 */
export interface CustomPivotCallbacks {
    getSingleSelectedGroupId: () => string | null;
    getSingleSelectedMeshEntry: () => { mesh: Mesh | BatchedMesh | InstancedMesh, instanceId: number } | null;
    getSelectedItems: () => SelectionElement[];
    getSelectionBoundingBox: () => Box3 | null;
    calculateAvgOrigin: () => Vector3;
}

// --- Imports from Overlay (mirrors gizmo.ts aliases) ---
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
const _TMP_MAT4_A = new Matrix4();


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

            const userData = mesh.userData;
            const hadIsCustomPivot = Object.prototype.hasOwnProperty.call(userData, 'isCustomPivot');
            const prevIsCustomPivot = userData['isCustomPivot'];
            undoFns.push(() => {
                if (!mesh.userData) return;
                if (hadIsCustomPivot) mesh.userData['isCustomPivot'] = prevIsCustomPivot;
                else delete mesh.userData['isCustomPivot'];
            });

            const isInstancedLike = !!(
                (mesh as BatchedMesh).isBatchedMesh ||
                (mesh as InstancedMesh).isInstancedMesh
            );
            if (isInstancedLike) {
                const hadMap = Object.prototype.hasOwnProperty.call(userData, 'customPivots') && userData.customPivots;
                const prevById = new Map<number, Vector3 | undefined>();
                for (const id of ids) {
                    const prev = hadMap ? (userData.customPivots as Map<number, Vector3>).get(id) : undefined;
                    prevById.set(id, prev ? prev.clone() : undefined);
                }
                undoFns.push(() => {
                    if (!mesh.userData) return;
                    if (!mesh.userData['customPivots']) mesh.userData['customPivots'] = new Map<number, Vector3>();
                    const customPivots = mesh.userData['customPivots'] as Map<number, Vector3>;
                    for (const [id, prev] of prevById) {
                        if (prev === undefined) customPivots.delete(id);
                        else customPivots.set(id, prev.clone());
                    }
                    if (!hadMap && customPivots.size === 0) {
                        delete mesh.userData['customPivots'];
                    }
                });
            } else {
                const hadCustomPivot = Object.prototype.hasOwnProperty.call(userData, 'customPivot');
                const prevCustomPivot = userData.customPivot ? (userData.customPivot as Vector3).clone() : undefined;
                undoFns.push(() => {
                    if (!mesh.userData) return;
                    if (hadCustomPivot) mesh.userData['customPivot'] = prevCustomPivot ? prevCustomPivot.clone() : undefined;
                    else delete mesh.userData['customPivot'];
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
    pivotOffset: Vector3, 
    _currentSelection: CurrentSelection,
    loadedObjectGroup: Group,
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
        const groups = GroupUtils.getGroups(loadedObjectGroup);
        const group = groups.get(singleGroupId);
        if (group && GroupUtils.shouldUseGroupPivot(group)) {
            const localPivot = GroupUtils.normalizePivotToVector3(group.pivot, new Vector3());
            if (localPivot) {
                const groupMatrix = GroupUtils.getGroupWorldMatrix(group, new Matrix4());
                const targetWorld = localPivot.clone().applyMatrix4(groupMatrix);
                
                const baseWorld = new Vector3(0, 0, 0);
                const box = getGroupLocalBoundingBox(singleGroupId) as Box3;
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

    let customPivot: Vector3 | null = null;
    const userData = mesh.userData;
    if ((
        (mesh as BatchedMesh).isBatchedMesh ||
        (mesh as InstancedMesh).isInstancedMesh
    ) && userData['customPivots']) {
        if ((userData['customPivots'] as Map<number, Vector3>).has(instanceId)) {
            customPivot = (userData['customPivots'] as Map<number, Vector3>).get(instanceId) ?? null;
        }
    } else if (userData['customPivot']) {
        customPivot = userData['customPivot'] as Vector3;
    }

    if (!customPivot) return newIsCustomPivot;

    newIsCustomPivot = true;
    
    const center = new Vector3();
    const tempMat = new Matrix4();
    const tempPos = new Vector3();
    
    getInstanceWorldMatrixForOrigin(mesh, instanceId, tempMat);
    const localY = isItemDisplayHatEnabled(mesh, instanceId) ? 0.03125 : 0;
    tempPos.set(0, localY, 0).applyMatrix4(tempMat);
    center.add(tempPos);

    (mesh as InstancedMesh).getMatrixAt(instanceId, tempMat);
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
    pivotOffset: Vector3, 
    currentSelection: CurrentSelection,
    loadedObjectGroup: Group,
    callbacks: CustomPivotCallbacks
): Vector3 {
    const { getSelectedItems, getSelectionBoundingBox, getSingleSelectedGroupId, calculateAvgOrigin } = callbacks;
    
    const center = new Vector3();
    const items = getSelectedItems();
    
    // Check if we have ANY selection (groups or objects)
    const hasGroups = currentSelection.groups && currentSelection.groups.size > 0;
    const hasObjects = currentSelection.objects && currentSelection.objects.size > 0;

    if (items.length === 0 && !hasGroups && !hasObjects) return center;

    if (pivotMode === 'center') {
        const singleGroupId = getSingleSelectedGroupId();
        if (singleGroupId) {
            const groups = GroupUtils.getGroups(loadedObjectGroup) as Map<string, any>;
            const group = groups.get(singleGroupId);
            const box = getGroupLocalBoundingBox(singleGroupId) as Box3;
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
            const groups = GroupUtils.getGroups(loadedObjectGroup);
            const group = groups.get(singleGroupId);

            const box = getGroupLocalBoundingBox(singleGroupId) as Box3;
            if (!box.isEmpty()) {
                const groupMatrix = getGroupWorldMatrixWithFallback(singleGroupId, new Matrix4());
                center.copy(box.min).applyMatrix4(groupMatrix);
            } else if (group && group.position) {
                center.copy(group.position);
            } else {
                center.copy(calculateAvgOrigin());
            }
        } else if (currentSelection.groups && currentSelection.groups.size > 0) {
            const firstGroupId = Array.from(currentSelection.groups)[0];
            const groups = GroupUtils.getGroups(loadedObjectGroup);
            const group = groups.get(firstGroupId);
            const box = getGroupLocalBoundingBox(firstGroupId) as Box3;
            if (!box.isEmpty()) {
                const groupMatrix = getGroupWorldMatrixWithFallback(firstGroupId, new Matrix4());
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
                 const localPivot = getInstanceLocalBoxMin(mesh, firstItem.instanceId, new Vector3(0, 0, 0));
                 if (localPivot) {
                     const worldMatrix = getInstanceWorldMatrixForOrigin(mesh, firstItem.instanceId, new Matrix4());
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

export interface CommitPivotEditParams {
    pivotWorldPos: Vector3;
    isMultiPivotEdit: boolean;
    singleGroupId: string | null;
    currentSelection: {
        primary?: { type: string; id?: string; mesh?: Mesh | BatchedMesh | InstancedMesh; instanceId?: number } | null;
        objects?: Map<Mesh | BatchedMesh | InstancedMesh, Set<number>>;
    };
    loadedObjectGroup: Group;
}

export interface CommitPivotEditResult {
    newPivotOffset: Vector3;
    newIsCustomPivot: boolean;
    setMultiExplicitPivot: boolean;
}

export function commitPivotEditFromDragEnd(params: CommitPivotEditParams): CommitPivotEditResult {
    const { pivotWorldPos, isMultiPivotEdit, singleGroupId, currentSelection, loadedObjectGroup } = params;

    const newPivotOffset = new Vector3();
    let newIsCustomPivot = false;
    let setMultiExplicitPivot = false;

    // @ts-ignore
    const groups = GroupUtils.getGroups(loadedObjectGroup);

    if (singleGroupId) {
        const group = groups.get(singleGroupId);
        if (group) {
            const groupMatrix = GroupUtils.getGroupWorldMatrix(group, new Matrix4());
            const invGroupMatrix = groupMatrix.clone().invert();
            const localPivot = pivotWorldPos.clone().applyMatrix4(invGroupMatrix);

            group.pivot = localPivot.clone();
            group.isCustomPivot = true;

            // @ts-ignore
            const baseWorld = Overlay.getGroupOriginWorld(singleGroupId);
            const targetWorld = localPivot.clone().applyMatrix4(groupMatrix);
            newPivotOffset.subVectors(targetWorld, baseWorld);
            newIsCustomPivot = true;
        }
    } else if (!isMultiPivotEdit) {
        if (currentSelection.objects && currentSelection.objects.size > 0) {
            const instanceMatrix = new Matrix4();
            for (const [mesh, ids] of currentSelection.objects) {
                if (!mesh || !ids || ids.size === 0) continue;

                const firstId = Array.from(ids)[0];
                (mesh as InstancedMesh).getMatrixAt(firstId, instanceMatrix);
                const worldMatrix = instanceMatrix.premultiply(mesh.matrixWorld);
                const invWorldMatrix = worldMatrix.clone().invert();
                const localPivot = pivotWorldPos.clone().applyMatrix4(invWorldMatrix);

                if (mesh.isBatchedMesh || mesh.isInstancedMesh) {
                    if (!mesh.userData.customPivots) mesh.userData.customPivots = new Map<number, Vector3>();
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
        if (currentSelection.primary) {
            const prim = currentSelection.primary;

            if (!_ephemeralPivotUndo && !_pivotEditUndoCapture && prim.type === 'group' && prim.id) {
                const group = groups.get(prim.id);
                if (group) {
                    const prevPivot = group.pivot
                        ? (group.pivot.clone ? group.pivot.clone() : new Vector3().copy(group.pivot as Vector3))
                        : undefined;
                    const prevIsCustom = group.isCustomPivot;
                    _pivotEditUndoCapture = () => {
                        group.pivot = prevPivot;
                        if (prevIsCustom) group.isCustomPivot = true;
                        else delete group.isCustomPivot;
                    };
                }
            }

            if (prim.type === 'group' && prim.id) {
                const group = groups.get(prim.id);
                if (group) {
                    const groupMatrix = GroupUtils.getGroupWorldMatrix(group, new Matrix4());
                    const invGroupMatrix = groupMatrix.invert();
                    const localPivot = pivotWorldPos.clone().applyMatrix4(invGroupMatrix);
                    group.pivot = localPivot;
                    group.isCustomPivot = true;
                }
            }

            setMultiExplicitPivot = true;
        }
    }

    if (_pivotEditUndoCapture) {
        _ephemeralPivotUndo = _pivotEditUndoCapture;
    }
    _pivotEditUndoCapture = null;

    return { newPivotOffset, newIsCustomPivot, setMultiExplicitPivot };
}
