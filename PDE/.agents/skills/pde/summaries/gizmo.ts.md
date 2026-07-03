# gizmo.ts

## Purpose
Lightweight gizmo entry point for the editor control layer. It installs canvas click selection and global keyboard shortcuts, exposes minimal selection hooks on `loadedObjectGroup.userData`, attaches `TransformControls` to a center/origin/custom-pivot anchor using the selected object's world rotation, applies gizmo drag deltas to selected object/instance matrices, and delegates selection overlay state/box rendering to `overlay.ts` and custom pivot behavior to `custom-pivot.ts`.

## Exports

### Types / Interfaces
- `InitGizmoParams` -- scene, camera, renderer, orbit-controls enabled flag, and loaded object group needed to wire selection/gizmo behavior.
- `InitGizmoResult` -- render-loop compatibility object with `updateGizmo()`.

### Functions / Methods
- `initGizmo(params): InitGizmoResult` -- sets up `TransformControls`, keyboard shortcuts, pointer/click selection, transform delta application, Alt-drag custom pivot editing, selection reset/replacement hooks, and gizmo attachment.

## Dependencies (imports)
- `three/webgpu` -- scene, camera, renderer, group, object, raycaster, matrix, and pointer math classes.
- `./gizmo-setup` -- creates and patches `TransformControls`.
- `./overlay` -- selection state mutation and selection box overlay helpers.
- `./handle-key` -- installs global editor shortcuts using the active `TransformControls` instance.
- `./custom-pivot` -- manages Alt-driven pivot mode state and custom pivot storage/lookup.

## Used By (known callers)
- `renderer/renderer.ts`

## Internal State
- Tracks `pivotMode` inside `initGizmo()` as `center` or `origin`; `z` toggles it through `handle-key.ts` and updates the active gizmo anchor.

## Notes
- Click selection ignores pointer movement over 4 px squared distance to avoid selecting after orbit drags.
- Selected instanced/batched hits use `instanceId` or `batchId`, falling back to `0`.
- During gizmo drag, the anchor world-matrix delta is converted into each selected object's local space and written via `setMatrixAt()` for instance-like objects or decomposed onto normal `Object3D` transforms.
- Alt keydown, keyup, and window blur are forwarded to `custom-pivot.ts`; Alt switches to translate, keyup/blur restores the previous gizmo mode, and blur covers Alt+Tab focus loss.
- Alt + gizmo drag stores the dragged anchor as custom pivot without transforming the selected object.
- `initHandleKey()` is called once during gizmo initialization so `t`, `r`, and `s` switch translate/rotate/scale, `x` toggles world/local space, and `z` toggles center/origin pivot placement.
- Custom pivots take precedence over the center/origin pivot mode when a selected object or instance has one stored.
- The gizmo anchor uses identity rotation whenever `TransformControls.space` is `world`, matching the old controls behavior.
- The gizmo anchor derives local rotation from normalized world-matrix basis vectors so local space follows object/instance rotation without directly decomposing scale-heavy matrices.
- World-space scale on normal `Object3D` preserves the pre-scale local quaternion after matrix decomposition to avoid shear-induced rotation drift changing the gizmo angle.
- `handle-key.ts` calls back after mode/space changes so the current selection reattaches with the correct anchor rotation immediately.
