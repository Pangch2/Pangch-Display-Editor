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
- `InitGizmoResult.setCamera(nextCamera): void` -- rebinds raycasting, TransformControls, and keyboard actions to a replacement camera.
- `InitGizmoResult.hasSelection(): boolean` -- reports whether the context-menu flip command is available.
- `InitGizmoResult.flipSelected(axis): Promise<void>` -- applies type-specific X/Y/Z reflection to the selected display objects.
- `InitGizmoResult.setMirrorModeling(enabled): void` -- toggles mirrored duplication across the display X=-0.5 plane.

## Dependencies (imports)
- `./gizmo-setup` -- TransformControls initialization and gizmo line patching.
- `./blockbench-scale` -- Blockbench-style scale mode and pivot-frame helpers.
- `./gizmo-commands` -- group/delete/duplicate command orchestration.
- `../grouping/group` -- group hierarchy and pivot helpers.
- `../selection/overlay` -- selection overlays, box math, and vertex helpers.
- `../selection/select` -- selection state machine.
- `../selection/drag` -- marquee selection and delta application.
- `../selection/instance-ranges` -- selected instance ID sorting and contiguous-range merging.
- `../flip` -- applies object and group reflection operations.
- `../mirroring` -- owns mirror-modeling state, pairing, and linked transform deltas.
- `../../entityMaterial.js` -- shared drag mask attribute name and GPU preview delta matrix.
- `../pivot/custom-pivot` -- pivot recomputation and undo handling.
- `../input/handle-key` -- keyboard bindings and `HandleKeyState` adapter type.
- `../vertex/vertex-translate`, `../vertex/vertex-rotate`, `../vertex/vertex-scale`, `../vertex/vertex-queue` -- vertex snap and queue behavior.

## Used By (known callers)
- `renderer/renderer.ts`
- `renderer/controls/vertex/vertex-*`

## Notes
- Selection changes update persistent per-mesh `dragSelected` masks only when the selected instance IDs differ.
- Shared selection callbacks recompute custom-pivot state before positioning the helper, including selections initiated from the scene panel and marquee/keyboard paths.
- TransformControls caches merged selected ranges at drag start; `updateGizmo()` changes one shared cumulative drag uniform per frame while applying incremental deltas only to vertex overlays and drag-time UI events.
- Drag end commits CPU and outline matrices, tightens the aggregate selection box once, then immediately resets the GPU preview; loaded and overlay instance matrices use WebGPU storage buffers that upload the committed matrices in the next render without the large interleaved-buffer delay.
- Selection overlay refreshes emit `pde:selection-transform-context` with the current gizmo world pivot so property edits honor origin, center, and custom pivot modes.
- Internal group, ungroup, delete, and duplicate commands emit `pde:scene-updated` with `skipGizmoRefresh`; the gizmo listener skips its redundant refresh while other listeners still receive the event. Detail-free external scene updates retain the normal gizmo and overlay refresh.
- Property-panel object/group pivot edits mark `pde:scene-updated` with `pivotChanged`, switching the active pivot mode to origin before recomputing the gizmo.
- Mirror-modeling duplication delegates fixed-pivot reflection and pair bookkeeping to the dedicated controls, then refreshes selection state and emits the scene update.
- Direct selection flips delegate object/group reflection to `controls/flip.ts`; this controller preserves multi-selection pivot flags, offsets, anchors, and linked partner selection around the asynchronous operation.
- Direct selection flips refresh the selection overlay as soon as the reflected preview matrices are applied, before asynchronous block-state replacement completes.
- Direct group flips use the live selection-bounds center so reflection stays in place, then apply the same world reflection to selected root and descendant group transforms. Non-group flips continue to honor the active pivot mode.
- Object custom pivots are remapped through the reflection so their world positions remain consistent with the mirrored objects, and pivot state is recomputed before repositioning the gizmo.
- Player-head, block-state, custom-pivot, and linked-partner reflection details live in `controls/flip.ts`.
- Camera references accept the common Three.js `Camera` type so perspective/orthographic switching does not recreate the interaction system.
- Model replacement events preserve the current group/object multi-selection, replace only the rebuilt object, remap a selected swap-pop source instance, and retain the primary selection where possible.
- Selection transform events expose the active `pivotMode` and `multiCustomPivotLocal`; the latter converts the current helper pivot through the primary group/object inverse world matrix, with the captured local anchor only as a fallback.
- `pde:multi-selection-pivot-change` commits property-panel pivot edits through the normal custom-pivot path, updates all multi-selection anchors, and refreshes the overlay.
- Committing a custom pivot entered from center mode switches the active pivot mode to origin instead of restoring center.
This remains the highest-risk control module because it owns event wiring and mutable shared state. `initGizmo` now passes primitive keyboard state to `initHandleKey` through a local accessor-backed `HandleKeyState` object instead of individual getter/setter callbacks. It routes object selection and duplication through InstancedMesh paths and passes most overlay helpers directly. Multi-selection primary anchors use `CustomPivot.getObjectOriginWorld` so block and item display origins match single-selection behavior.
