# shear-remove.ts

## Purpose
Removes shear from selected instance transforms by preserving scale and orthogonalizing basis vectors. It keeps the current gizmo world position as the visual anchor for single selections and center-mode multi selections, while avoiding multi-origin anchor drift.

## Exports

### Types / Interfaces
- `ShearItem` -- target mesh and instance pair.
- `ShearSelection` -- minimal selection shape needed for group clearing and custom-pivot reseat handling.
- `ShearCallbacks` -- callbacks needed to recompute selection center and redraw the UI.

### Functions / Methods
- `removeShearFromSelection(items, selectionHelper, currentSelection, loadedObjectGroup, pivotMode, isCustomPivot, pivotOffset, callbacks): void` -- orthogonalizes selected transforms, clears affected cached group matrices, translates eligible selections back to the existing gizmo position, and refreshes single-object custom pivot storage.

## Dependencies (imports)
- `three/webgpu` -- instance, matrix, vector, and group types.
- `./group` -- group lookup and descendant traversal.

## Used By (known callers)
- `renderer/controls/input/handle-key.ts`
- `renderer/controls/vertex/vertex-scale.ts`

## Notes
Uses Gram-Schmidt orthogonalization to eliminate shear in one pass. Multi selections skip translation compensation only outside center mode to avoid drift from mismatched multi-anchor and `SelectionCenter` calculations. The selection logic assumes InstancedMesh object instances only.
