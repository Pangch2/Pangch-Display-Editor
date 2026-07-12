# gizmo.ts

## Purpose
Main interaction controller for the editor. It wires TransformControls, selection state, keyboard and mouse events, vertex mode, pivot handling, overlay refresh, and command dispatch into the editor interaction stack.

## Exports

### Types / Interfaces
- `OrbitControlsLike` -- minimal orbit-control contract used by the editor.
- `GizmoState` -- shared pivot and anchor state tracked by the gizmo.
- `InitGizmoParams` -- inputs required to initialize the gizmo system.
- `InitGizmoResult` -- public handles returned by `initGizmo`.

### Functions / Methods
- `initGizmo(params): InitGizmoResult` -- builds the editor interaction stack and installs DOM event listeners.

## Dependencies (imports)
- `./gizmo-setup` -- TransformControls initialization and gizmo line patching.
- `./blockbench-scale` -- Blockbench-style scale mode and pivot-frame helpers.
- `./gizmo-commands` -- group/delete/duplicate command orchestration.
- `../grouping/group` -- group hierarchy and pivot helpers.
- `../selection/overlay` -- selection overlays, box math, and vertex helpers.
- `../selection/select` -- selection state machine.
- `../selection/drag` -- marquee selection and delta application.
- `../pivot/custom-pivot` -- pivot recomputation and undo handling.
- `../input/handle-key` -- keyboard bindings and `HandleKeyState` adapter type.
- `../vertex/vertex-translate`, `../vertex/vertex-rotate`, `../vertex/vertex-scale`, `../vertex/vertex-queue` -- vertex snap and queue behavior.

## Used By (known callers)
- `renderer/renderer.ts`
- `renderer/controls/vertex/vertex-*`

## Notes
- TransformControls drag changes emit `pde:object-transform-changed` with the live gizmo world pivot; pivot edits also include the unsaved pivot offset for the properties panel.
- Selection overlay refreshes emit `pde:selection-transform-context` with the current gizmo world pivot so property edits honor origin, center, and custom pivot modes.
- Single-object model replacement events run through the normal selection replacement path, resetting stale pivot state before recomputing the new model's origin and overlay.
- Selection transform events expose `multiCustomPivotLocal` for multi-selection by converting the current helper pivot through the primary group/object inverse world matrix; the captured local anchor is only a fallback when the helper is unavailable.
- Committing a custom pivot entered from center mode switches the active pivot mode to origin instead of restoring center.
This remains the highest-risk control module because it owns event wiring and mutable shared state. `initGizmo` now passes primitive keyboard state to `initHandleKey` through a local accessor-backed `HandleKeyState` object instead of individual getter/setter callbacks. It routes object selection and duplication through InstancedMesh paths and passes most overlay helpers directly. Multi-selection primary anchors use `CustomPivot.getObjectOriginWorld` so block and item display origins match single-selection behavior.
