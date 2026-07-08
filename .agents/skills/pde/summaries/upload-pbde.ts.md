# upload-pbde.ts

## Purpose
Window drag-and-drop entrypoint for PBDE files. Opens an "Open" vs "Merge" modal, then routes files to `loadpbde` or `mergepbde`.

## Exports

### Variables / Constants
- `loadedObjectGroup` -- re-export from `mesh-builder`

### Types / Interfaces
- `ScenePrecompileTrace` -- renderer precompile timing payload with availability, profile-enabled flag, total/profile/full-scene compile time, GPU queue wait time, and per-root object traces
- `ScenePrecompileObjectTrace` -- per-root precompile timing payload with compile time, instance count, material count, attribute key, and vertex count
- `RenderSettledFrameTrace` -- per-frame render-settle timing payload with frame interval, render CPU time, GPU queue wait, and queue availability
- `RenderSettledTrace` -- timing payload returned from the renderer with requested/rendered frames, aggregate frame wait/GPU wait/total wait, frame intervals, per-frame traces, and queue availability

### Functions / Methods
- `waitForScenePrecompiled(): Promise<ScenePrecompileTrace>` -- dispatches a renderer precompile request and resolves with timing details
- `waitForRenderSettled(frames, traceFrames, waitForGpu): Promise<RenderSettledTrace>` -- dispatches a render-settled request; frame tracing and GPU queue waiting are opt-in
- `logFinalPbdeLoadTime(startMs, mode, fileCount): Promise<void>` -- logs render-settle wait time and open/merge perceived load duration after the GPU queue has drained
- `precompileLoadedScene(mode, fileCount): Promise<void>` -- optionally waits for `renderer.compileAsync(scene, camera)` when `localStorage.pdeAwaitScenePrecompile === '1'`

## Internal State
- `ModalOverlayElement` -- local `HTMLDivElement` extension with optional ESC handler
- Drop modal is single-instance via `drop-modal-overlay`

## Dependencies (imports)
- `../ui/ui-open-close.js` -- modal open/close animation helpers
- `three/webgpu` -- `THREE.Object3D` for selection set typing
- `./mesh-builder` -- load/render pipeline and selection helpers
- `./pbde-log` -- central PBDE log registry plus localStorage flag helpers for render-settle/precompile logs

## Used By (known callers)
- `renderer.ts` -- imports `loadedObjectGroup`

## Notes
- `loadpbde` clears scene on first file, merges later files in same batch.
- `mergepbde` appends all files, then selects all new meshes.
- Both open and merge dispatch `pde:scene-updated` before optional scene precompile, then log perceived load time through render-settled frames and GPU queue completion when available.
- Scene precompile is skipped by default and can be enabled with `localStorage.pdeAwaitScenePrecompile = '1'`; per-root profiling still requires `localStorage.pdePrecompileProfile = '1'`.
- Logs are controlled through `pbde-log.ts` registry helpers. `Final load time` defaults to enabled; optional scene precompile and render-settle diagnostics default to disabled. Final load time now always waits for GPU queue drain after the next rendered frame, while trace logs still control extra render-settle detail collection.
- Files without `.bdengine` or `.pdengine` extension are ignored.
