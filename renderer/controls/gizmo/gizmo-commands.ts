import {
    Group,
    Object3D,
    Vector3
} from 'three/webgpu';
import * as GroupUtils from '../grouping/group';
import * as Duplicate from '../grouping/duplicate';
import * as Delete from '../grouping/delete';
import type { DeletedSceneDelta } from '../grouping/delete';
import * as Select from '../selection/select';
import type { SelectionState, SelectedItem } from '../selection/select';
import type { GroupData } from '../grouping/group';

import type { ObjectBatch } from '../../scene-store/object-access';

export interface GizmoCommandCallbacks {
    getSelectedItems(): SelectedItem[];
    hasAnySelection(): boolean;
    getGroups(): Map<string, GroupData>;
    getSingleSelectedGroupId(): string | null;
    getGroupKey(mesh: Object3D, instanceId: number): string;
    invalidateSelectionCaches(): void;
    applySelection(mesh: Object3D | null, instanceIds: number[], groupId?: string | null): void;
    resetSelectionAndDeselect(): void;
    emitSceneUpdated(): void;
}

export interface DuplicateCommandCallbacks {
    hasAnySelection(): boolean;
    isMultiSelection(): boolean;
    beginSelectionReplace(options?: { anchorMode?: string; detachTransform?: boolean; preserveAnchors?: boolean }): void;
    setPrimaryToFirstAvailable(): void;
    invalidateSelectionCaches(): void;
    recomputePivotStateForSelection(): void;
    updateHelperPosition(): void;
    updateSelectionOverlay(): void;
    emitSceneUpdated(): void;
    getCustomPivotState(): { isCustomPivot: boolean; pivotOffset: Vector3 };
    restoreCustomPivotState(state: { isCustomPivot: boolean; pivotOffset: Vector3 }): void;
}

function slotList(uuids: Set<string>): Array<{ mesh: ObjectBatch; instanceId: number }> {
    return [...uuids].flatMap(uuid => Select.selectedObjectRef(uuid) ?? []);
}

export function createGroupCommand(
    loadedObjectGroup: Group,
    currentSelection: SelectionState,
    callbacks: GizmoCommandCallbacks
): string | undefined {
    const items = callbacks.getSelectedItems();
    if (items.length === 0 && !callbacks.hasAnySelection()) {
        return undefined;
    }

    const groups = callbacks.getGroups();
    let initialPosition = new Vector3();
    const singleGroupId = callbacks.getSingleSelectedGroupId();
    if (singleGroupId) {
        const existingGroup = groups.get(singleGroupId);
        if (existingGroup && existingGroup.position) initialPosition.copy(existingGroup.position);
        else initialPosition = Select.calculateAvgOrigin();
    } else {
        initialPosition = Select.calculateAvgOrigin();
    }

    const selectedGroupIds = currentSelection.groups ? Array.from(currentSelection.groups).filter(Boolean) : [];
    const selectedObjects = slotList(currentSelection.objects);
    const primary = currentSelection.primary;
    const primaryId = primary ? (primary.type === 'group' ? primary.id : primary.uuid) : null;

    let newGroupId: string;
    try { newGroupId = GroupUtils.createGroupStructure(loadedObjectGroup, selectedGroupIds, selectedObjects, initialPosition, primaryId); }
    catch (error) { window.alert(error instanceof Error ? error.message : String(error)); return undefined; }

    callbacks.invalidateSelectionCaches();
    callbacks.applySelection(null, [], newGroupId);
    callbacks.emitSceneUpdated();

    console.log(`Group created: ${newGroupId}`);
    return newGroupId;
}

export function ungroupGroupsCommand(
    loadedObjectGroup: Group,
    groupIds: readonly string[],
    callbacks: GizmoCommandCallbacks,
    selectParent = true
): boolean {
    let result: ReturnType<typeof GroupUtils.ungroupGroupStructure> = null;
    let removedCount = 0;
    for (const groupId of groupIds) {
        const nextResult = GroupUtils.ungroupGroupStructure(loadedObjectGroup, groupId);
        if (!nextResult) continue;
        result = nextResult;
        removedCount++;
    }
    if (!result) return false;

    callbacks.invalidateSelectionCaches();

    if (selectParent && result.parentId && callbacks.getGroups().has(result.parentId)) {
        callbacks.applySelection(null, [], result.parentId);
    } else {
        callbacks.resetSelectionAndDeselect();
    }

    callbacks.emitSceneUpdated();
    console.log(`Groups removed: ${removedCount}`);
    return true;
}

export function deleteSelectedItemsCommand(
    loadedObjectGroup: Group,
    currentSelection: SelectionState,
    callbacks: GizmoCommandCallbacks
): DeletedSceneDelta | null {
    if (!callbacks.hasAnySelection()) return null;

    const delta = Delete.deleteSelectedItems(loadedObjectGroup, { groups: currentSelection.groups, objects: Select.toMeshMap(currentSelection.objects) }, {
        resetSelectionAndDeselect: callbacks.resetSelectionAndDeselect
    });
    callbacks.emitSceneUpdated();
    return delta;
}

export function duplicateSelectedCommand(
    loadedObjectGroup: Group,
    currentSelection: SelectionState,
    selectionAnchorMode: 'default' | 'center',
    callbacks: DuplicateCommandCallbacks
): { groups: Set<string>; objects: Map<ObjectBatch, Set<number>> } | null {
    if (!callbacks.hasAnySelection()) return null;

    const savedPivotState = callbacks.getCustomPivotState();
    const hadPrimary = !!currentSelection.primary;

    const selectedGroupIds = currentSelection.groups;
    const selectedObjects = slotList(currentSelection.objects);

    const newSel = Duplicate.duplicateGroupsAndObjects(loadedObjectGroup, selectedGroupIds, selectedObjects);
    if (!newSel.groups.size && !newSel.objects.size) return null; // only the camera was selected

    const preserveAnchors = callbacks.isMultiSelection();
    callbacks.beginSelectionReplace({ anchorMode: selectionAnchorMode, detachTransform: false, preserveAnchors });
    currentSelection.groups = newSel.groups;
    currentSelection.objects = Select.toObjectUuids(newSel.objects);

    if (hadPrimary || !callbacks.isMultiSelection()) {
        callbacks.setPrimaryToFirstAvailable();
    } else {
        currentSelection.primary = null;
    }

    callbacks.invalidateSelectionCaches();
    callbacks.recomputePivotStateForSelection();

    if (savedPivotState.isCustomPivot) {
        callbacks.restoreCustomPivotState(savedPivotState);
    }

    callbacks.updateHelperPosition();
    callbacks.emitSceneUpdated();
    callbacks.updateSelectionOverlay();

    console.log('Duplication complete');
    return newSel;
}
