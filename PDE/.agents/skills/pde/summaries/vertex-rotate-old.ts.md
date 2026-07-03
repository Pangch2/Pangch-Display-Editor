# vertex-rotate-old.ts

## Purpose
Handles vertex-mode rotate snapping. It derives a rotation around a selected pivot corner and then swaps selection/queue state so the editor keeps the expected active item.

## Exports

### Functions / Methods
- `processVertexRotate(selectedVertexKeys, context): boolean` -- applies vertex-based rotation snapping when vertex mode and rotate gizmo are active.

## Dependencies (imports)
- `three/webgpu` -- matrix, vector, quaternion, box, and mesh types.
- `./group` -- group hierarchy traversal and lookups.
- `./overlay` -- vertex, bounds, and world-matrix helpers.
- `./vertex-swap` -- selection swap logic.

## Used By (known callers)
- `renderer/controls/gizmo.ts`

## Notes
Requires exactly two selected vertex keys. It has separate logic for object and group sources, and preserves multi-selection behavior when snapping from a queued bundle.
