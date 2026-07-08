# custom-pivot-remove.ts

## Purpose
Clears custom pivot state from the current selection, including group pivots, per-object pivots, and any ephemeral multi-selection pivot bookkeeping.

## Exports

### Functions / Methods
- `resetCustomPivot(currentSelection, pivotOffset, multiAnchorPos, gizmoAnchorPos, flags, deps): void` -- removes custom pivot data and resets anchor state according to the current selection mode.

## Dependencies (imports)
- `three/webgpu` -- mesh, matrix, and vector types.
- `./group` -- group lookups and default pivot handling.

## Used By (known callers)
- `renderer/controls/input/handle-key.ts`

## Notes
Preserves user intent where possible: multi-selection reset behaves differently depending on whether the selection had an explicit multi pivot.
