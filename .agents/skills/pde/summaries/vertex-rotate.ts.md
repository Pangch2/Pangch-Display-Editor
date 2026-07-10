# vertex-rotate.ts

## Purpose
Handles vertex-mode rotate snapping. It derives one Blockbench-style rotation from the clicked vertices around the active pivot, applies that shared world delta to all targets, and swaps selection/queue state.

## Exports

### Functions / Methods
- `processVertexRotate(selectedVertexKeys, context): boolean` -- applies vertex-based rotation snapping when vertex mode and rotate gizmo are active.

## Dependencies (imports)
- `three/webgpu` -- matrix, vector, quaternion, and mesh/object types.
- `../grouping/group` -- group hierarchy traversal and lookups.
- `../selection/overlay` -- vertex lookup and world-matrix helpers.
- `./vertex-swap` -- selection swap logic.

## Used By (known callers)
- `renderer/controls/gizmo/gizmo.ts`

## Notes
Requires exactly two selected vertex keys. A stored object/group custom pivot takes precedence and is converted from local to world coordinates; otherwise an effectively selected source uses the active gizmo anchor, then falls back to its world origin. Direction conversion excludes instance scale because Blockbench cube dimensions live in geometry while PDE encodes object dimensions in instance scale. The resulting shared world rotation moves positions and orientations together around the pivot. Object sources are limited to InstancedMesh instances. Successful rotate snaps recompute pivot state before refreshing the helper.
