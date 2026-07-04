import {
    Group,
    InstancedMesh,
    Mesh,
    Object3D,
    Vector3
} from 'three/webgpu';
import * as GroupUtils from '../grouping/group';
import * as Duplicate from '../grouping/duplicate';
import * as Delete from '../grouping/delete';
import * as Select from '../selection/select';
import type { SelectionState, SelectedItem } from '../selection/select';
import type { GroupData } from '../grouping/group';

type PdeMesh = InstancedMesh | Mesh;

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
    const selectedObjects: Array<{ mesh: PdeMesh; instanceId: number }> = [];
    if (currentSelection.objects && currentSelection.objects.size > 0) {
        for (const [mesh, ids] of currentSelection.objects) {
            if (!mesh || !ids) continue;
            for (const id of ids) {
                selectedObjects.push({ mesh, instanceId: id });
            }
        }
    }

    let primaryId: string | null = null;
    if (currentSelection.primary) {
        if (currentSelection.primary.type === 'group') {
            primaryId = currentSelection.primary.id;
        } else {
            const key = callbacks.getGroupKey(currentSelection.primary.mesh, currentSelection.primary.instanceId);
            const keyToUuid = loadedObjectGroup.userData.instanceKeyToObjectUuid as Map<string, string> | undefined;
            primaryId = keyToUuid?.get(key) || null;
        }
    }

    const newGroupId = GroupUtils.createGroupStructure(loadedObjectGroup, selectedGroupIds, selectedObjects, initialPosition, primaryId);

    callbacks.invalidateSelectionCaches();
    callbacks.applySelection(null, [], newGroupId);
    callbacks.emitSceneUpdated();

    console.log(`Group created: ${newGroupId}`);
    return newGroupId;
}

export function ungroupGroupCommand(
    loadedObjectGroup: Group,
    groupId: string,
    callbacks: GizmoCommandCallbacks
): void {
    if (!groupId) return;

    const result = GroupUtils.ungroupGroupStructure(loadedObjectGroup, groupId);
    if (!result) return;

    callbacks.invalidateSelectionCaches();

    if (result.parentId && callbacks.getGroups().has(result.parentId)) {
        callbacks.applySelection(null, [], result.parentId);
    } else {
        callbacks.resetSelectionAndDeselect();
    }

    callbacks.emitSceneUpdated();
    console.log(`Group removed: ${groupId}`);
}

export function deleteSelectedItemsCommand(
    loadedObjectGroup: Group,
    currentSelection: SelectionState,
    callbacks: GizmoCommandCallbacks
): void {
    if (!callbacks.hasAnySelection()) return;

    Delete.deleteSelectedItems(loadedObjectGroup, currentSelection, {
        resetSelectionAndDeselect: callbacks.resetSelectionAndDeselect
    });
    callbacks.emitSceneUpdated();
}

export function duplicateSelectedCommand(
    loadedObjectGroup: Group,
    currentSelection: SelectionState,
    selectionAnchorMode: 'default' | 'center',
    callbacks: DuplicateCommandCallbacks
): void {
    if (!callbacks.hasAnySelection()) return;

    const savedPivotState = callbacks.getCustomPivotState();
    const hadPrimary = !!currentSelection.primary;

    const selectedGroupIds = currentSelection.groups;
    const selectedObjects: Array<{ mesh: PdeMesh; instanceId: number }> = [];
    if (currentSelection.objects) {
        for (const [mesh, ids] of currentSelection.objects) {
            for (const id of ids) selectedObjects.push({ mesh, instanceId: id });
        }
    }

    const newSel = Duplicate.duplicateGroupsAndObjects(loadedObjectGroup, selectedGroupIds, selectedObjects);

    const preserveAnchors = callbacks.isMultiSelection();
    callbacks.beginSelectionReplace({ anchorMode: selectionAnchorMode, detachTransform: false, preserveAnchors });
    currentSelection.groups = newSel.groups;
    currentSelection.objects = newSel.objects;

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
}
