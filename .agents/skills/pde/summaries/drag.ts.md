# drag.ts

## Purpose
Handles marquee selection and drag initiation, and applies transform deltas back onto selected instanced objects and groups.

## Exports

### Functions / Methods
- `projectedBoxIntersectsMarquee(corners, cornerCount, minX, maxX, minY, maxY): boolean` -- tests the projected box's convex hull against the marquee rectangle.
- `applyDeltaToSelection(params): void` -- applies a world-space delta to selected instances and groups.
- `initDrag(options): DragInterface` -- installs marquee selection behavior and returns pointer handlers.

## Dependencies (imports)
- `three/webgpu` -- math and scene object types.
- `./select` -- selection replacement helpers.
- `./overlay` -- instance bounds and projection helpers.
- `./instance-ranges` -- contiguous instance range type used by drag transforms.
- `../grouping/group` -- group hierarchy access.

## Used By (known callers)
- `renderer/controls/gizmo/gizmo.ts`
- `renderer/ui/object-properties.ts` -- applies property-edit deltas through `applyDeltaToSelection`.

## Notes
Marquee selection traverses InstancedMesh objects only and intersects the marquee with each projected box's convex hull, avoiding screen-AABB false positives for rotated or sheared instances. Drag transforms can consume merged instance ranges and register only those matrix component ranges for WebGPU buffer updates; property edits retain the direct-ID path.
- `applyDeltaToSelection` applies the same world delta to each transformed group's world-space custom pivot.
