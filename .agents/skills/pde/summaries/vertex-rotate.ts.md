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
Requires exactly two selected vertex keys. Stored object pivots are converted from local to world coordinates, while stored group pivots are already world positions. Rotated groups carry their world pivots through the same delta. Otherwise an effectively selected source uses the active gizmo anchor, then falls back to its world origin. After applying rotation matrices, a transformed multi-selection anchor is explicitly recaptured in primary-local coordinates.
