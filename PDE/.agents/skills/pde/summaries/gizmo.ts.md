# gizmo.ts

## Purpose
Main interaction controller for the editor. It wires transform controls, selection state, keyboard/mouse events, vertex mode, pivot handling, duplication, deletion, grouping, and overlay refresh into one orchestrator.

## Exports

### Types / Interfaces
- `OrbitControlsLike` -- minimal orbit-control contract used by the editor.
- `GizmoState` -- shared pivot/anchor state tracked by the gizmo.
- `InitGizmoParams` -- inputs required to initialize the gizmo system.
- `InitGizmoResult` -- public handles returned by `initGizmo`.

### Functions / Methods
- `initGizmo(params): InitGizmoResult` -- builds the editor interaction stack and installs DOM event listeners.

## Internal State
Maintains selection, pivot, drag, vertex queue, and gizmo-anchor caches at module scope.

## Dependencies (imports)
- `./gizmo-setup` -- TransformControls initialization and gizmo line patching.
- `./blockbench-scale` -- Blockbench-style scale mode and pivot-frame helpers.
- `./group` -- group hierarchy and pivot helpers.
- `./overlay` -- selection overlays, box math, vertex helpers.
- `./custom-pivot` -- pivot recomputation and undo handling.
- `./duplicate` -- duplication logic.
- `./delete` -- deletion logic.
- `./drag` -- marquee selection and delta application.
- `./handle-key` -- keyboard bindings.
- `./vertex-translate`, `./vertex-rotate`, `./vertex-scale`, `./vertex-queue` -- vertex snap/queue behavior.
- `./select` -- selection state machine.

## Used By (known callers)
- `renderer/renderer.ts`

## Notes
This is the highest-risk module in the control layer: it owns the event wiring and many mutable shared references, so changes here can ripple across selection and transform behavior.
It now listens for `pde:scene-updated` to invalidate selection caches and recompute the helper/overlay after hierarchy edits.
