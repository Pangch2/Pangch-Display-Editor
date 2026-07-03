# renderer.ts

## Purpose
Bootstraps the main PDE app UI. It initializes the loading overlay, waits for asset preparation, creates the Three.js/WebGPU scene and OrbitControls, initializes the lightweight click-selection gizmo module, adds helper visuals, starts the render loop, and keeps the canvas sized to the main content area.

## Exports

### Variables / Constants
- `scene: Scene` -- exported scene reference for other modules that need the active scene.

## Internal State
- Holds the live `scene`, `camera`, `renderer`, `controls`, and optional `gizmoModule` used by the animation loop and resize handler.
- Tracks FPS with `lastTime`, `frameCount`, and `fpsCounterElement`.

## Dependencies (imports)
- `three/examples/jsm/controls/OrbitControls.js` -- orbit camera controls.
- `three/webgpu` -- WebGPU renderer, scene graph, camera, helpers, and math primitives.
- `./controls/gizmo` -- initializes click selection, selection overlay/gizmo attachment, and provides the per-frame update hook.
- `./asset-manager` -- preloads/caches assets before scene start.
- `./load-project/upload-pbde` -- provides `loadedObjectGroup` for the scene root.
- `./ui/ui-open-close` -- loading overlay open/close animations.

## Used By (known callers)
- `renderer/load-project/upload-pbde.ts` -- imports `loadedObjectGroup` so loaded PBDE content can be attached before scene initialization.

## Notes
- Uses `WebGPURenderer`; WebGL is not used.
- `initScene()` is only called after assets finish initializing.
- Scene panel bootstrapping is temporarily disabled; this file no longer side-effect imports `./ui/scene-panel`.
- `initScene()` passes OrbitControls to the gizmo module so TransformControls dragging can disable orbit input.
- `animate()` renders the scene continuously and calls the gizmo update hook each frame.
