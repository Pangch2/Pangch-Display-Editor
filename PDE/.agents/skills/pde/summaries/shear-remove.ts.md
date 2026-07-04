# shear-remove.ts

## Purpose
Removes shear from selected instance transforms, preserving scale and keeping gizmo world position fixed while orthogonalizing basis vectors. Also refreshes group matrices when group selection is affected.

## Exports

### Types / Interfaces
- `ShearItem` -- target mesh/instance pair.
- `ShearSelection` -- minimal selection shape needed for group clearing and custom-pivot reseat handling.
- `ShearCallbacks` -- callbacks needed to recompute selection center and redraw the UI.

### Functions / Methods
- `removeShearFromSelection(items, selectionHelper, currentSelection, loadedObjectGroup, pivotMode, isCustomPivot, pivotOffset, callbacks): void` -- orthogonalizes selected transforms, reapplies position compensation from gizmo anchor, and refreshes single-object custom pivot storage.

## Dependencies (imports)
- `three/webgpu` -- instance, matrix, vector, and group types.
- `./group` -- group lookup and descendant traversal.

## Used By (known callers)
- `renderer/controls/input/handle-key.ts`
- `renderer/controls/vertex/vertex-scale.ts`

## Notes
Uses Gram-Schmidt orthogonalization to eliminate shear in one pass. For group selections it clears cached group matrices first so center recalculation stays consistent. Translation correction (keep gizmo at `targetPosition`) is skipped in Center mode — in that mode the gizmo is the bbox center, which shifts when the basis is orthogonalized; compensating would snap the object origin to the old (sheared) bbox center. In Origin mode the offset is ~0 so the object stays put. Custom pivot rewrite (single-object) is also gated behind the `pivotMode !== 'center'` guard.
