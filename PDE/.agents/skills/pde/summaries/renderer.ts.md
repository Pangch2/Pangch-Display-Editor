# renderer.ts

## Purpose
Bootstraps the main PDE app UI. It initializes the loading overlay, waits for asset preparation, creates the Three.js/WebGPU scene and controls, adds helper visuals, starts the render loop, and keeps the canvas sized to the main content area.

## Exports

### Variables / Constants
- `scene: Scene` -- exported scene reference for other modules that need the active scene.

## Internal State
- Holds the live `scene`, `camera`, `renderer`, `controls`, and optional `gizmoModule` used by the animation loop and resize handler.
- Tracks FPS with `lastTime`, `frameCount`, and `fpsCounterElement`.

## Dependencies (imports)
- `three/examples/jsm/controls/OrbitControls.js` -- orbit camera controls.
- `three/webgpu` -- WebGPU renderer, scene graph, camera, helpers, and math primitives.
- `./controls/gizmo` -- initializes and updates the gizmo overlay.
- `./asset-manager` -- preloads/caches assets before scene start.
- `./load-project/upload-pbde` -- provides `loadedObjectGroup` for the scene root.
- `./ui/ui-open-close` -- loading overlay open/close animations.
- `./ui/scene-panel` -- side-effect import for scene panel UI setup.

## Used By (known callers)
- `renderer/load-project/upload-pbde.ts` -- imports `loadedObjectGroup` so loaded PBDE content can be attached before scene initialization.

## Notes
- Uses `WebGPURenderer`; WebGL is not used.
- `initScene()` is only called after assets finish initializing.
- `animate()` renders the scene continuously and updates the gizmo each frame.
