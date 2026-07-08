# drag.ts

## Purpose
Handles marquee selection and drag initiation, and applies transform deltas back onto selected instanced objects and groups.

## Exports

### Functions / Methods
- `applyDeltaToSelection(params): void` -- applies a world-space delta to selected instances and groups.
- `initDrag(options): DragInterface` -- installs marquee selection behavior and returns pointer handlers.

## Dependencies (imports)
- `three/webgpu` -- math and scene object types.
- `./select` -- selection replacement helpers.
- `./overlay` -- instance bounds and projection helpers.
- `../grouping/group` -- group hierarchy access.

## Used By (known callers)
- `renderer/controls/gizmo/gizmo.ts`

## Notes
Marquee selection now traverses InstancedMesh objects only. Shift/Ctrl behavior and drag-time selection replacement are unchanged.
