# gizmo.ts

## Purpose
Main interaction controller for the editor. It wires TransformControls, selection state, keyboard/mouse events, vertex mode, pivot handling, overlay refresh, and command dispatch into the editor interaction stack.

## Exports

### Types / Interfaces
- `OrbitControlsLike` -- minimal orbit-control contract used by the editor.
- `GizmoState` -- shared pivot/anchor state tracked by the gizmo.
- `InitGizmoParams` -- inputs required to initialize the gizmo system.
- `InitGizmoResult` -- public handles returned by `initGizmo`.

### Functions / Methods
- `initGizmo(params): InitGizmoResult` -- builds the editor interaction stack and installs DOM event listeners.

## Internal State
Maintains selection, pivot, drag, vertex queue, gizmo-anchor caches, and cached gizmo axis/plane direction visibility at module scope.

## Dependencies (imports)
- `./gizmo-setup` -- TransformControls initialization and gizmo line patching.
- `./blockbench-scale` -- Blockbench-style scale mode and pivot-frame helpers.
- `./gizmo-commands` -- group/delete/duplicate command orchestration.
- `../grouping/group` -- group hierarchy and pivot helpers.
- `../selection/overlay` -- selection overlays, box math, vertex helpers.
- `../selection/select` -- selection state machine.
- `../selection/drag` -- marquee selection and delta application.
- `../pivot/custom-pivot` -- pivot recomputation and undo handling.
- `../input/handle-key` -- keyboard bindings.
- `../vertex/vertex-translate`, `../vertex/vertex-rotate`, `../vertex/vertex-scale`, `../vertex/vertex-queue` -- vertex snap/queue behavior.

## Used By (known callers)
- `renderer/renderer.ts`
- `renderer/controls/vertex/vertex-*` -- imports `GizmoState` type for snap/swap callbacks.

## Notes
This remains the highest-risk module in the control layer because it owns event wiring and many mutable shared references. Group/delete/duplicate command bodies now live in `gizmo-commands.ts`; `gizmo.ts` keeps suppressing vertex queue state around those commands.
It listens for `pde:scene-updated` to invalidate selection caches and recompute the helper/overlay after hierarchy edits.
After pivot-edit commit, object custom pivots derive `pivotOffset` from the pre-custom-pivot origin so follow-up transforms keep using the custom anchor.
`SelectionCenter`: for multi-selection with a locked anchor (`_multiSelectionOriginAnchorValid`), the function short-circuits and returns `_multiSelectionOriginAnchorPosition` (refreshed from local if possible) instead of delegating to `CustomPivot.SelectionCenter`.
`updateGizmo` updates both axis helper line opacity and mirrored XY/YZ/XZ plane variant opacity from the camera direction, using local-space direction when TransformControls is in local space.