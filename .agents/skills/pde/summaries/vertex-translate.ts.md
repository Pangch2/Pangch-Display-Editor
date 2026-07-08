# vertex-translate.ts

## Purpose
Handles vertex-mode translation snapping. It can snap a gizmo or object pivot to another vertex, move the affected selection, and then hand off selection and queue swapping.

## Exports

### Functions / Methods
- `processVertexSnap(selectedVertexKeys, context): boolean` -- applies vertex-based translation snapping when vertex mode is active.

## Dependencies (imports)
- `three/webgpu` -- matrix, vector, quaternion, mesh, and box types.
- `../grouping/group` -- group hierarchy and world-matrix helpers.
- `../selection/overlay` -- vertex, bounds, and world-matrix helpers.
- `./vertex-swap` -- selection swap logic.
- `../pivot/shear-remove` -- optional shear cleanup hook.
- `../gizmo/gizmo` -- gizmo state shape.

## Used By (known callers)
- `renderer/controls/gizmo/gizmo.ts`

## Notes
Supports snap-to-gizmo, move-target, and queue-swap cases. The object path now assumes InstancedMesh objects only.
