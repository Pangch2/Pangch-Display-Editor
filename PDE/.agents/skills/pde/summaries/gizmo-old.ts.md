# gizmo-old.ts

## Purpose
Legacy full-featured gizmo controller for PDE selection, TransformControls attachment, pivot modes, custom pivots, grouping, vertex operations, overlays, duplication, deletion, and drag application.

## Exports

### Types / Interfaces
- `OrbitControlsLike` -- minimal orbit controls contract used by gizmo and keyboard handlers.
- `GizmoState` -- serializable pivot and anchor state used by vertex tools.
- `InitGizmoParams` -- scene, camera, renderer, controls, and loaded object group inputs.
- `InitGizmoResult` -- public gizmo API returned from initialization.

### Functions / Methods
- `initGizmo(params): InitGizmoResult` -- initializes TransformControls, selection state, overlays, pointer handlers, keyboard handlers, and public selection helpers.

## Internal State
- Tracks current selection through `Select.currentSelection`, selected vertex keys, vertex queue, pivot mode, transform space, custom pivot flags, multi-selection anchors, drag baselines, and gizmo line/plane visibility.
- `updateHelperPosition` positions the selection helper and sets its quaternion from world identity or local selected/group rotation using matrix-derived orthonormal basis rotation.

## Dependencies (imports)
- `three/webgpu` -- scene objects, math primitives, raycasting, and rendering types.
- `TransformControls` -- object transform gizmo.
- `gizmo-setup` -- creates visual gizmo lines and planes.
- legacy control modules -- grouping, overlays, pivots, drag, keyboard, selection, deletion, duplication, blockbench scale, and vertex tools.

## Used By (known callers)
- Legacy renderer/control wiring imports `initGizmo` to provide the old editor interaction model.

## Notes
- WebGPU/TSL constraints are preserved by using Three.js math and controls only.
- Local transform space derives the helper rotation from the primary selected object or group world matrix with scale removed before quaternion extraction.
