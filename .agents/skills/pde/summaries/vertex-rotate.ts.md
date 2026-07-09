# vertex-rotate.ts

## Purpose
Handles vertex-mode rotate snapping. It derives a rotation around a selected pivot corner and then swaps selection and queue state so the editor keeps the expected active item.

## Exports

### Functions / Methods
- `processVertexRotate(selectedVertexKeys, context): boolean` -- applies vertex-based rotation snapping when vertex mode and rotate gizmo are active.

## Dependencies (imports)
- `three/webgpu` -- matrix, vector, quaternion, box, and mesh types.
- `../grouping/group` -- group hierarchy traversal and lookups.
- `../selection/overlay` -- vertex, bounds, and world-matrix helpers.
- `./vertex-swap` -- selection swap logic.

## Used By (known callers)
- `renderer/controls/gizmo/gizmo.ts`

## Notes
Requires exactly two selected vertex keys. Object sources are limited to InstancedMesh instances. Successful rotate snaps recompute pivot state before refreshing the helper so the active vertex-mode pivot matches the deactivated vertex-mode position.
