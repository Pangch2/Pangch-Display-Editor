# vertex-scale.ts

## Purpose
Handles vertex-mode scale snapping. It computes a scale transform from two selected vertices and can optionally remove shear before scaling when Ctrl is held.

## Exports

### Functions / Methods
- `processVertexScale(selectedVertexKeys, context): boolean` -- applies vertex-based scaling when vertex mode and scale gizmo are active.

## Dependencies (imports)
- `three/webgpu` -- matrix, vector, quaternion, box, and mesh types.
- `../grouping/group` -- group hierarchy traversal and lookups.
- `../selection/overlay` -- vertex, bounds, and world-matrix helpers.
- `./vertex-swap` -- selection swap logic.
- `../pivot/shear-remove` -- optional shear cleanup before Ctrl-based scaling.

## Used By (known callers)
- `renderer/controls/gizmo/gizmo.ts`

## Notes
Ctrl-modified scaling still removes shear first. The selection and queue logic now target InstancedMesh objects only. Scaled groups carry their world-space custom pivots through the same delta. After applying scale matrices, a transformed multi-selection anchor is explicitly recaptured in primary-local coordinates.
