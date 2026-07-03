# custom-pivot-old.ts

## Purpose
Owns custom-pivot state for selections. It captures undo for pivot edits, recomputes pivot offsets for groups and objects, and commits pivot edits from drag interactions.

## Exports

### Types / Interfaces
- `SelectionElement` -- selected group/object entry.
- `CurrentSelection` -- current selection snapshot for pivot logic.
- `CustomPivotCallbacks` -- callbacks needed to compute selection centers and group/object pivots.
- `CommitPivotEditParams` -- payload for committing a pivot drag.
- `CommitPivotEditResult` -- resulting pivot state after a commit.

### Functions / Methods
- `clearEphemeralPivotUndo(): void` -- clears captured undo hooks.
- `revertEphemeralPivotUndoIfAny(): void` -- replays and clears any pending pivot undo.
- `capturePivotUndoForCurrentSelection(currentSelection): (() => void) | null` -- snapshots per-object custom pivot writes.
- `recomputePivotStateForSelection(pivotMode, isMultiSelection, isCustomPivot, pivotOffset, currentSelection, loadedObjectGroup, callbacks): boolean` -- recalculates the effective pivot offset/state.
- `SelectionCenter(pivotMode, isCustomPivot, pivotOffset, currentSelection, loadedObjectGroup, callbacks): Vector3` -- computes the world-space center/origin used by gizmo placement.
- `setEphemeralPivotUndo(undoFn): void` -- stores a temporary undo closure.
- `setPivotEditUndoCapture(undoFn): void` -- stores a deferred pivot-edit undo capture.
- `getPivotEditUndoCapture(): (() => void) | null` -- retrieves the deferred undo capture.
- `commitPivotEditFromDragEnd(params): CommitPivotEditResult` -- applies a dragged pivot into group/object metadata.

## Internal State
Tracks two module-level undo hooks for transient pivot edits.

## Dependencies (imports)
- `three/webgpu` -- vector, matrix, mesh, and group types.
- `./group` -- group pivot and hierarchy helpers.
- `./overlay` -- world-matrix and bounding-box helpers.

## Used By (known callers)
- `renderer/controls/gizmo.ts`
- `renderer/controls/handle-key.ts`

## Notes
Handles both single-object and grouped selection pivots, including instanced/batched meshes via `customPivots` maps.
