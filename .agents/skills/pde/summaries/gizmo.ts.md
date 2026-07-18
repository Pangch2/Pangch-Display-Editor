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
- TransformControls caches selected instance IDs once at drag start; change events only mark the latest helper matrix dirty, and `updateGizmo()` applies one incremental delta per frame after skipping unchanged matrices.
- Drag end flushes the final pending delta before pivot/bounds cleanup, then emits one final `pde:object-transform-changed`; frame events carry `dragging: true` for lightweight properties-panel updates.
- Selection overlay refreshes emit `pde:selection-transform-context` with the current gizmo world pivot so property edits honor origin, center, and custom pivot modes.
- Single-object model replacement events run through the normal selection replacement path, resetting stale pivot state before recomputing the new model's origin and overlay.
- Selection transform events expose the active `pivotMode` and `multiCustomPivotLocal`; the latter converts the current helper pivot through the primary group/object inverse world matrix, with the captured local anchor only as a fallback.
- `pde:multi-selection-pivot-change` commits property-panel pivot edits through the normal custom-pivot path, updates all multi-selection anchors, and refreshes the overlay.
- Committing a custom pivot entered from center mode switches the active pivot mode to origin instead of restoring center.
This remains the highest-risk control module because it owns event wiring and mutable shared state. `initGizmo` now passes primitive keyboard state to `initHandleKey` through a local accessor-backed `HandleKeyState` object instead of individual getter/setter callbacks. It routes object selection and duplication through InstancedMesh paths and passes most overlay helpers directly. Multi-selection primary anchors use `CustomPivot.getObjectOriginWorld` so block and item display origins match single-selection behavior.
