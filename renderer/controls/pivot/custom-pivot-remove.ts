import { Vector3 } from 'three/webgpu';
import type { GroupData } from '../grouping/group';
import { setInstanceIsCustomPivot, setInstancePivot } from '../../scene-store/object-access';
import { toMeshMap, type SelectionState } from '../selection/select';

type CurrentSelection = Partial<SelectionState>;

interface PivotFlags {
    isCustomPivot: boolean;
    multiExplicitPivot: boolean;
    multiAnchorValid: boolean;
    multiAnchorInitialValid: boolean;
    multiAnchorInitialLocalValid: boolean;
    gizmoAnchorValid: boolean;
    selectionAnchorMode: 'default' | 'center';
}

interface PivotDeps {
    isMultiSelection: () => boolean;
    revertEphemeralPivotUndoIfAny: () => void;
    getGroups: () => Map<string, GroupData>;
    DEFAULT_GROUP_PIVOT: Vector3;
}

/**
 * Resets the custom pivot for the current selection (triggered by Alt+Ctrl).
 */
export function resetCustomPivot(
    currentSelection: CurrentSelection,
    pivotOffset: Vector3,
    multiAnchorPos: Vector3,
    gizmoAnchorPos: Vector3,
    flags: PivotFlags,
    deps: PivotDeps
): void {
    const {
        isMultiSelection,
        revertEphemeralPivotUndoIfAny,
        getGroups,
        DEFAULT_GROUP_PIVOT,
    } = deps;

    const isMultiReset = isMultiSelection();
    const hadExplicitMultiPivot = isMultiReset && flags.multiExplicitPivot;

    // Reset should also drop any ephemeral multi-selection pivot edits.
    revertEphemeralPivotUndoIfAny();

    pivotOffset.set(0, 0, 0);
    flags.isCustomPivot = false;
    flags.multiExplicitPivot = false;

    if (isMultiReset) {
        if (hadExplicitMultiPivot) {
            // 다중선택 커스텀 피벗만 제거. 개별 오브젝트 userData 커스텀 피벗은 건드리지 않음.
            // 앵커 초기화 후 updateHelperPosition에 재계산 위임.
            // selectionAnchorMode는 유지: drag='center' → bbox 중심, manual='default' → primary 원점.
            flags.multiAnchorValid = false;
            flags.multiAnchorInitialValid = false;
            flags.multiAnchorInitialLocalValid = false;
            flags.gizmoAnchorValid = false;
        } else {
            if (currentSelection.groups && currentSelection.groups.size > 0) {
                const groups = getGroups();
                for (const groupId of currentSelection.groups) {
                    const group = groups.get(groupId);
                    if (!group) continue;
                    group.pivot = DEFAULT_GROUP_PIVOT.clone();
                    delete group.isCustomPivot;
                }
            }
            if (currentSelection.objects && currentSelection.objects.size > 0) {
                for (const [mesh, ids] of toMeshMap(currentSelection.objects)) {
                    if (!mesh) continue;
                    for (const id of ids) {
                        setInstancePivot(mesh, id, undefined);
                        setInstanceIsCustomPivot(mesh, id, undefined);
                    }
                }
            }

            // 앵커 완전 초기화: updateHelperPosition에 재계산 위임.
            // selectionAnchorMode 유지 - drag='center' → bbox 중심, manual='default' → primary 원점.
            multiAnchorPos.set(0, 0, 0);
            gizmoAnchorPos.set(0, 0, 0);
            flags.multiAnchorValid = false;
            flags.multiAnchorInitialValid = false;
            flags.multiAnchorInitialLocalValid = false;
            flags.gizmoAnchorValid = false;
        }
    } else {
        if (currentSelection.groups && currentSelection.groups.size > 0) {
            const groups = getGroups();
            for (const groupId of currentSelection.groups) {
                const group = groups.get(groupId);
                if (!group) continue;
                group.pivot = DEFAULT_GROUP_PIVOT.clone();
                delete group.isCustomPivot;
            }
        }

        if (currentSelection.objects && currentSelection.objects.size > 0) {
            for (const [mesh, ids] of toMeshMap(currentSelection.objects)) {
                if (!mesh) continue;
                for (const id of ids) {
                    setInstancePivot(mesh, id, undefined);
                    setInstanceIsCustomPivot(mesh, id, undefined);
                }
            }
        }

        flags.multiAnchorValid = false;
        flags.selectionAnchorMode = 'default';
    }
}
