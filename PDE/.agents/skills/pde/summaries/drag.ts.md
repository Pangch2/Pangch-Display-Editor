# drag.ts

## Purpose
Handles marquee selection and drag initiation, and applies transform deltas back onto selected instances and groups.

## Exports

### Types / Interfaces
- `DragInitOptions` -- dependencies required to wire drag handling into the editor.
- `DragInterface` -- pointer-event handlers and marquee controls returned by `initDrag`.
- `ApplyDeltaParams` -- parameters for applying a transform delta to current selection.

### Functions / Methods
- `applyDeltaToSelection(params): void` -- applies a world-space delta to selected instances and groups.
- `initDrag(options): DragInterface` -- installs marquee selection behavior and returns pointer handlers.

## Internal State
Creates and removes a temporary DOM marquee element during drag selection.

## Dependencies (imports)
- `three/webgpu` -- math and scene object types.
- `./select` -- selection replacement helpers.
- `./overlay` -- instance bounds and projection helpers.
- `../grouping/group` -- group hierarchy access.
- `three/examples/jsm/controls/TransformControls.js` -- drag-state integration.

## Used By (known callers)
- `renderer/controls/gizmo/gizmo.ts`

## Notes
Ctrl/meta drag starts marquee selection; shift modifies whether groups are included. Selection updates are deferred until the drag finishes.
