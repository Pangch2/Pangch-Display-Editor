import {
    Box3,
    Vector3,
    Matrix4,
    Group
} from 'three/webgpu';
// @ts-ignore
import * as GroupUtils from '../grouping/group';
import { animationSession } from '../../animation/animation-state';
import { getLinkedMirrorSelection, syncLinkedMirrorGroupPivot, syncLinkedMirrorPivot } from '../transform/mirroring';
// @ts-ignore
import * as Overlay from '../selection/overlay';
import { getInstanceIsCustomPivot, getInstanceMatrix, getInstancePivot, hasInstanceHatData, objectUuidAt, setInstanceIsCustomPivot, setInstancePivot,
    type ObjectBatch } from '../../scene-store/object-access';
import { toMeshMap, type SelectionState } from '../selection/select';

/**
 * Interface representing an element in the selection (either a group or a specific object instance).
 */
export interface SelectionElement {
    type: 'group' | 'object';
    id?: string;
    mesh?: ObjectBatch;
    instanceId?: number;
}

/**
 * The current selection state.
 */
export type CurrentSelection = Partial<SelectionState>;

/**
 * Callbacks required for computing pivot states and selection centers.
 */
export interface CustomPivotCallbacks {
    getSingleSelectedGroupId: () => string | null;
    getSingleSelectedMeshEntry: () => { mesh: ObjectBatch, instanceId: number } | null;
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

export function getObjectOriginWorld(mesh: ObjectBatch, instanceId: number, out = new Vector3()): Vector3 {
    const displayType = getDisplayType(mesh, instanceId);
    if (displayType === 'block_display') {
        const localPivot = getInstanceLocalBoxMin(mesh, instanceId, out);
        if (localPivot) {
            return localPivot.applyMatrix4(getInstanceWorldMatrixForOrigin(mesh, instanceId, _TMP_MAT4_A));
        }
    }
    if (displayType === 'item_display' && hasInstanceHatData(mesh)) {
        getInstanceWorldMatrixForOrigin(mesh, instanceId, _TMP_MAT4_A);
        return out.set(0, isItemDisplayHatEnabled(mesh, instanceId) ? 0.03125 : 0, 0).applyMatrix4(_TMP_MAT4_A);
    }
    if (displayType === 'item_display') {
        const box = Overlay.getInstanceLocalBox(mesh, instanceId);
        if (box) {
            box.getCenter(out);
            return out.applyMatrix4(Overlay.getInstanceWorldMatrix(mesh, instanceId, _TMP_MAT4_A));
        }
    }
    if (displayType === 'text_display') {
        Overlay.getInstanceLocalOriginOffset(mesh, instanceId, out);
    } else {
        out.set(0, 0, 0);
    }

    getInstanceWorldMatrixForOrigin(mesh, instanceId, _TMP_MAT4_A);
    return out.applyMatrix4(_TMP_MAT4_A);
}


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
        for (const [mesh, ids] of toMeshMap(currentSelection.objects ?? [])) {
            if (!mesh || !ids || ids.size === 0) continue;
            const previous = [...ids].map(id => ({ id, pivot: getInstancePivot(mesh, id)?.clone(), isCustomPivot: getInstanceIsCustomPivot(mesh, id) }));
            undoFns.push(() => {
                for (const { id, pivot, isCustomPivot } of previous) {
                    setInstancePivot(mesh, id, pivot?.clone());
                    setInstanceIsCustomPivot(mesh, id, isCustomPivot);
                }
            });
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
            const worldPivot = GroupUtils.normalizePivotToVector3(group.pivot, new Vector3());
            if (worldPivot) {
                const groupMatrix = GroupUtils.getGroupWorldMatrix(group, new Matrix4());
                
                const baseWorld = new Vector3(0, 0, 0);
                const box = getGroupLocalBoundingBox(singleGroupId) as Box3;
                if (!box.isEmpty()) baseWorld.copy(box.min).applyMatrix4(groupMatrix);
                else {
                    const children = GroupUtils.getAllGroupChildren(loadedObjectGroup, singleGroupId);
                    if (children.length > 0) Overlay.calculateAvgOriginForChildren(children, baseWorld);
                }

                pivotOffset.subVectors(worldPivot, baseWorld);
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

    const customPivot = getInstancePivot(mesh, instanceId) ?? null;

    if (!customPivot) return newIsCustomPivot;

    newIsCustomPivot = true;
    
    const tempMat = new Matrix4();
    const baseWorld = getObjectOriginWorld(mesh, instanceId);

    getInstanceMatrix(mesh, instanceId, tempMat);
    const worldMatrix = tempMat.premultiply(mesh.matrixWorld);
    const targetWorld = customPivot.clone().applyMatrix4(worldMatrix);
    pivotOffset.subVectors(targetWorld, baseWorld);

    return newIsCustomPivot;
}

/**
 * Calculates the world center of the current selection based on the pivot mode.
 */
export function SelectionCenter(
    pivotMode: string, 
    _isCustomPivot: boolean,
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

    const effectivePivotMode = pivotMode;

    if (effectivePivotMode === 'center') {
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
        // Origin Mode (or custom pivot overriding center mode)
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
             center.copy(getObjectOriginWorld(mesh, firstItem.instanceId));
        }
    }

    // Apply custom pivot offset only in origin mode.
    if (effectivePivotMode === 'origin') {
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
    currentSelection: CurrentSelection;
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
    const animated = animationSession(loadedObjectGroup).enabled;

    if (animated && isMultiPivotEdit) {
        clearEphemeralPivotUndo();
        return { newPivotOffset, newIsCustomPivot: true, setMultiExplicitPivot: true };
    }

    // @ts-ignore
    const groups = GroupUtils.getGroups(loadedObjectGroup);

    if (singleGroupId) {
        const group = groups.get(singleGroupId);
        if (group) {
            group.pivot = pivotWorldPos.clone();
            group.isCustomPivot = true;
            syncLinkedMirrorGroupPivot(loadedObjectGroup, singleGroupId, pivotWorldPos);

            // @ts-ignore
            const baseWorld = Overlay.getGroupOriginWorld(singleGroupId);
            newPivotOffset.subVectors(pivotWorldPos, baseWorld);
            newIsCustomPivot = true;
        }
    } else if (!isMultiPivotEdit) {
        if (currentSelection.objects && currentSelection.objects.size > 0) {
            const instanceMatrix = new Matrix4();
            for (const [mesh, ids] of toMeshMap(currentSelection.objects ?? [])) {
                if (!mesh || !ids || ids.size === 0) continue;

                const firstId = Array.from(ids)[0];
                getInstanceMatrix(mesh, firstId, instanceMatrix);
                const worldMatrix = instanceMatrix.premultiply(mesh.matrixWorld);
                const invWorldMatrix = worldMatrix.clone().invert();
                const localPivot = pivotWorldPos.clone().applyMatrix4(invWorldMatrix);

                for (const id of ids) {
                    setInstancePivot(mesh, id, localPivot.clone());
                    const uuid = objectUuidAt(loadedObjectGroup, mesh, id);
                    if (uuid) syncLinkedMirrorPivot(loadedObjectGroup, uuid, localPivot);
                }
                for (const id of ids) setInstanceIsCustomPivot(mesh, id, true);
            }
        }
    } else {
        if (currentSelection.primary) {
            const prim = currentSelection.primary;

            if (!_ephemeralPivotUndo && !_pivotEditUndoCapture && prim.type === 'group' && prim.id) {
                const linked = getLinkedMirrorSelection(loadedObjectGroup, [], new Set([prim.id]));
                const snapshots = [...new Set([prim.id, ...linked.groups])].flatMap(id => {
                    const group = groups.get(id);
                    return group ? [{ group, pivot: GroupUtils.normalizePivotToVector3(group.pivot) ?? undefined,
                        isCustomPivot: group.isCustomPivot }] : [];
                });
                _pivotEditUndoCapture = () => {
                    for (const { group, pivot, isCustomPivot } of snapshots) {
                        group.pivot = pivot;
                        if (isCustomPivot) group.isCustomPivot = true;
                        else delete group.isCustomPivot;
                    }
                };
            }

            if (prim.type === 'group' && prim.id) {
                const group = groups.get(prim.id);
                if (group) {
                    group.pivot = pivotWorldPos.clone();
                    group.isCustomPivot = true;
                    syncLinkedMirrorGroupPivot(loadedObjectGroup, prim.id, pivotWorldPos);
                }
            }

            setMultiExplicitPivot = true;
        }
    }

    if (animated) clearEphemeralPivotUndo();
    else if (_pivotEditUndoCapture) {
        _ephemeralPivotUndo = _pivotEditUndoCapture;
    }
    _pivotEditUndoCapture = null;

    return { newPivotOffset, newIsCustomPivot, setMultiExplicitPivot };
}
