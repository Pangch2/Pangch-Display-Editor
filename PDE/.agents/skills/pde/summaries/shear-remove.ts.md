# shear-remove.ts

## Purpose
Removes shear from selected instance transforms, preserving position and scale while orthogonalizing basis vectors. Also refreshes group matrices when group selection is affected.

## Exports

### Types / Interfaces
- `ShearItem` -- target mesh/instance pair.
- `ShearSelection` -- minimal selection shape needed for group clearing.
- `ShearCallbacks` -- callbacks needed to recompute selection center and redraw the UI.

### Functions / Methods
- `removeShearFromSelection(items, selectionHelper, currentSelection, loadedObjectGroup, pivotMode, isCustomPivot, pivotOffset, callbacks): void` -- orthogonalizes selected transforms and reapplies position compensation.

## Dependencies (imports)
- `three/webgpu` -- instance, matrix, vector, and group types.
- `./group` -- group lookup and descendant traversal.

## Used By (known callers)
- `renderer/controls/handle-key.ts`
- `renderer/controls/vertex-scale.ts`

## Notes
Uses Gram-Schmidt orthogonalization to eliminate shear in one pass. For group selections it clears cached group matrices first so center recalculation stays consistent.
