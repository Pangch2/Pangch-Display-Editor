# custom-pivot.ts

## Purpose
Owns custom-pivot state for selections. It captures undo for pivot edits, recomputes pivot offsets for groups and objects, and commits pivot edits from drag interactions.

## Exports

### Types / Interfaces
- `SelectionElement` -- selected group or object entry.
- `CurrentSelection` -- current selection snapshot for pivot logic.
- `CustomPivotCallbacks` -- callbacks needed to compute selection centers and group/object pivots.
- `CommitPivotEditParams` -- payload for committing a pivot drag.
- `CommitPivotEditResult` -- resulting pivot state after a commit.

### Functions / Methods
- `clearEphemeralPivotUndo(): void` -- clears captured undo hooks.
- `revertEphemeralPivotUndoIfAny(): void` -- replays and clears any pending pivot undo.
- `capturePivotUndoForCurrentSelection(currentSelection): (() => void) | null` -- snapshots per-object custom pivot writes.
- `recomputePivotStateForSelection(...)` -- recalculates the effective pivot offset/state.
- `SelectionCenter(...)` -- computes the world-space center/origin used by gizmo placement.
- `setEphemeralPivotUndo(undoFn): void` -- stores a temporary undo closure.
- `setPivotEditUndoCapture(undoFn): void` -- stores a deferred pivot-edit undo capture.
- `getPivotEditUndoCapture(): (() => void) | null` -- retrieves the deferred undo capture.
- `commitPivotEditFromDragEnd(params): CommitPivotEditResult` -- applies a dragged pivot into group/object metadata.

## Internal State
Tracks two module-level undo hooks for transient pivot edits. Uses one internal object-origin helper so block_display origin stays at local box min while item_display origin stays at overlay box center.

## Dependencies (imports)
- `three/webgpu` -- vector, matrix, mesh, and group types.
- `../grouping/group` -- group pivot and hierarchy helpers.
- `../selection/overlay` -- world-matrix and bounding-box helpers.

## Used By (known callers)
- `renderer/controls/gizmo/gizmo.ts`
- `renderer/controls/input/handle-key.ts`

## Notes
Handles both single-object and grouped selection pivots using InstancedMesh customPivots maps. Object pivot offsets must be computed from the same type-specific origin used by `SelectionCenter`; custom offsets apply only in origin mode so pivot mode changes still move the gizmo.
