# vertex-rotate.ts

## Purpose
Handles vertex-mode rotate snapping. It matches Blockbench-style rotate snapping by deriving each target's rotation from object-local start/target vertex directions, then swaps selection and queue state so the editor keeps the expected active item.

## Exports

### Functions / Methods
- `computeBlockbenchRotateTransform(objectWorldMatrix, startWorld, targetWorld, out): Matrix4 | null` -- computes the world-space delta for Blockbench-style local-origin vertex rotate snapping.
- `processVertexRotate(selectedVertexKeys, context): boolean` -- applies vertex-based rotation snapping when vertex mode and rotate gizmo are active.

## Dependencies (imports)
- `three/webgpu` -- matrix, vector, quaternion, and mesh/object types.
- `../grouping/group` -- group hierarchy traversal and lookups.
- `../selection/overlay` -- vertex lookup and world-matrix helpers.
- `./vertex-swap` -- selection swap logic.

## Used By (known callers)
- `renderer/controls/gizmo/gizmo.ts`

## Notes
Requires exactly two selected vertex keys. Rotation is computed per target from its own world matrix/local origin instead of the active gizmo pivot. Object sources are limited to InstancedMesh instances. Successful rotate snaps recompute pivot state before refreshing the helper so the active vertex-mode pivot matches the deactivated vertex-mode position.
