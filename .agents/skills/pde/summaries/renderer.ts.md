# renderer.ts

## Purpose
Bootstraps the main PDE app UI. It initializes the loading overlay, waits for asset preparation, creates the Three.js/WebGPU scene and controls, adds helper visuals, starts the render loop, and keeps the canvas sized to the main content area.

## Exports

### Variables / Constants
- `scene: Scene` -- exported scene reference for other modules that need the active scene.

## Internal State
- Holds the live `scene`, `camera`, `renderer`, `controls`, `viewHelper`, grouped `floorGrid`, separate `zSymbol` visibility reference, ViewHelper transition state, and optional `gizmoModule` used by the animation loop and resize handler.
- Uses `viewHelperClock` to animate ViewHelper camera-axis transitions at frame-rate-independent speed.
- Tracks FPS with `lastTime`, `frameCount`, and `fpsCounterElement`.
- Tracks whether a scene precompile is in progress so the normal animation render loop does not race `renderer.compileAsync()`.
- Captures scene precompile timings split into optional per-root profile time, final full-scene compile time, optional WebGPU queue wait, and renderer pipeline-cache size before/after compilation.
- Captures per-root scene precompile traces only when `localStorage.pdePrecompileProfile === '1'`, temporarily hiding loaded mesh roots one at a time and timing `renderer.compileAsync()`.
- Tracks pending `pde:wait-render-settled` requests; per-frame render CPU timing and WebGPU queue completion waits are collected only when requested, while renderer pipeline-cache size is sampled before/after the settled render.
- Stabilizes the generated WGSL binding name for both uniform-buffer and storage-buffer `InstancedMesh.instanceMatrix` nodes so structurally identical instanced shaders can share WebGPU pipelines while retaining separate per-object bindings.
- Answers synchronous project camera-state events by snapshotting/restoring camera position, OrbitControls target, and zoom.

## Dependencies (imports)
- `three/examples/jsm/controls/OrbitControls.js` -- orbit camera controls.
- `three/examples/jsm/helpers/ViewHelper.js` -- interactive bottom-right camera orientation helper.
- `three/webgpu` -- WebGPU renderer, scene graph, camera, helpers, math primitives, and canvas-backed ViewHelper sprite materials.
- `./controls/gizmo/gizmo` -- initializes and updates the gizmo overlay.
- `./asset-manager` -- preloads/caches assets before scene start.
- `./load-project/upload-pbde` -- provides `loadedObjectGroup` for the scene root.
- `./ui/ui-open-close` -- loading overlay open/close animations.
- `./ui/scene-panel` -- side-effect import for scene panel UI setup.
- `./ui/panel-layout` -- side-effect import for independent panel docking, ordering, and resizing.
- `./ui/object-properties` -- side-effect import for the editable selected-object properties panel.

## Used By (known callers)
- `renderer/load-project/upload-pbde.ts` -- imports `loadedObjectGroup` so loaded PBDE content can be attached before scene initialization.

## Notes
- Uses `WebGPURenderer`; WebGL is not used.
- Instanced-matrix binding-name stabilization is installed after renderer initialization by wrapping the first backend node-builder creation, patching its shared builder prototype for both Three.js instance-matrix paths, and restoring the backend factory immediately.
- `initScene()` is only called after assets finish initializing.
- `initScene()` extends ViewHelper axis lines through both positive and negative directions, applies the gizmo's X/Y/Z palette to every line and 128 px marker at 0.8 opacity, labels positive markers, and groups both floor grids with the `Z>` marker so they share axis-view changes.
- `animate()` renders the scene and bottom-right ViewHelper continuously, syncing its center to the OrbitControls target, updating click-driven camera animations, rotating the floor grid to the selected view plane, and compositing the helper without clearing its viewport background.
- ViewHelper transitions accept only left clicks and temporarily hide `Z>`; the next left-button interaction restores the grouped grids to the original XZ plane and shows `Z>` again.
- Window resize updates the camera and WebGPU canvas, then renders immediately so the resized drawing buffer is never displayed empty between animation frames.
- Handles `pde:precompile-scene` by optionally profiling loaded mesh root compile costs, awaiting full `renderer.compileAsync(scene, camera)`, sampling the private pipeline-cache size, and optionally waiting for WebGPU queue completion before resolving split timing details to `upload-pbde.ts`.
- `pde:wait-render-settled` resolves after the requested number of rendered frames; callers can opt into per-frame trace collection and WebGPU queue waiting for diagnostics.
- `pde:get-camera-state` and `pde:set-camera-state` keep camera ownership in this module while allowing project tabs to preserve their last view.
