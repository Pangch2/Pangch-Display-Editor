# vertex-scale.ts

## Purpose
Handles vertex-mode scale snapping. It computes a scale transform from two selected vertices and can optionally remove shear before scaling when Ctrl is held.

## Exports

### Functions / Methods
- `processVertexScale(selectedVertexKeys, context): boolean` -- applies vertex-based scaling when vertex mode and scale gizmo are active.

## Dependencies (imports)
- `three/webgpu` -- matrix, vector, quaternion, box, and mesh types.
- `./group` -- group hierarchy traversal and lookups.
- `./overlay` -- vertex, bounds, and world-matrix helpers.
- `./vertex-swap` -- selection swap logic.
- `./shear-remove` -- optional shear cleanup before Ctrl-based scaling.

## Used By (known callers)
- `renderer/controls/gizmo.ts`

## Notes
Has distinct behavior for Ctrl-modified scaling versus plain scaling. It preserves selection state for multi-selection snaps and queued bundles.
