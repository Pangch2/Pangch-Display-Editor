# upload-pbde.ts

## Purpose
Window drag-and-drop entrypoint for PBDE files. Opens an "Open" vs "Merge" modal, routes files to `loadpbde` or `mergepbde`, manages multiple in-memory project scenes, and refreshes the project-details panel after opening or switching a project.

## Exports

### Variables / Constants
- `loadedObjectGroup` -- re-export from `mesh-builder`

### Types / Interfaces
- `ScenePrecompileTrace` -- renderer precompile timing payload with availability, profile-enabled flag, total/profile/full-scene compile time, GPU queue wait time, pipeline-cache size before/after, and per-root object traces
- `ScenePrecompileObjectTrace` -- per-root precompile timing payload with compile time, instance count, material count, attribute key, and vertex count
- `RenderSettledFrameTrace` -- per-frame render-settle timing payload with frame interval, render CPU time, GPU queue wait, and queue availability
- `RenderSettledTrace` -- timing payload returned from the renderer with requested/rendered frames, aggregate frame wait/GPU wait/total wait, frame intervals, per-frame traces, queue availability, and pipeline-cache size before/after
- `ProjectState` -- stable id plus saved scene children, non-function `loadedObjectGroup.userData`, and optional camera position/target/zoom for one project window

### Functions / Methods
- `waitForScenePrecompiled(): Promise<ScenePrecompileTrace>` -- dispatches a renderer precompile request and resolves with timing details
- `waitForRenderSettled(frames, traceFrames, waitForGpu): Promise<RenderSettledTrace>` -- dispatches a render-settled request; frame tracing and GPU queue waiting are opt-in
- `logFinalPbdeLoadTime(startMs, mode, fileCount): Promise<void>` -- logs render-settle wait time and open/merge perceived load duration after the GPU queue has drained
- `precompileLoadedScene(mode, fileCount): Promise<void>` -- optionally waits for `renderer.compileAsync(scene, camera)` when `localStorage.pdeAwaitScenePrecompile === '1'`
- `updateProjectDetails(): void` -- fills the Scene panel project name/NBT inputs, sets the window title to `PDE - {name}` (or `PDE` when empty), and keeps both project data and the title synchronized with edits.

## Internal State
- `ModalOverlayElement` -- local `HTMLDivElement` extension with optional ESC handler
- Drop modal is single-instance via `drop-modal-overlay`
- `projects` stores project windows, scene metadata, and last camera state in display order; startup creates one empty project and `activeProject` indexes the state currently mounted in the shared scene root.
- `projectTabDropMarkerEl` and `projectTabDropMarkerClass` track the project row currently showing a before/after reorder marker.

## Dependencies (imports)
- `../ui/ui-open-close.js` -- modal open/close animation helpers
- `three/webgpu` -- `THREE.Object3D` for selection set typing
- `./mesh-builder` -- load/render pipeline and selection helpers
- `./pbde-log` -- central PBDE log registry plus localStorage flag helpers for render-settle/precompile logs

## Used By (known callers)
- `renderer.ts` -- imports `loadedObjectGroup`

## Notes
- `loadpbde` opens every selected file as a separate project tab, reusing an active empty tab when available; the drop modal can instead reuse the current tab.
- `mergepbde` appends all files, merges their mesh-to-instance selection maps, then selects only the newly added instances.
- Both open and merge dispatch `pde:scene-updated` before optional scene precompile, then log perceived load time through render-settled frames and GPU queue completion when available.
- Scene precompile is skipped by default and can be enabled with `localStorage.pdeAwaitScenePrecompile = '1'`; per-root profiling still requires `localStorage.pdePrecompileProfile = '1'`.
- Logs are controlled through `pbde-log.ts` registry helpers. Final load timing waits for GPU queue drain after the next rendered frame; scene-precompile and render-settle trace lines also report the renderer pipeline-cache change when its private cache is available.
- Files without `.bdengine` or `.pdengine` extension are ignored.
- Opening creates independent project scenes and details per file; merging leaves the active project's details unchanged.
- The drop modal centers its remembered `pdeReuseCurrentProject` checkbox directly below the open-mode prompt at a smaller font size; checking it suppresses new project-tab creation so Open replaces the current project.
- The drop modal heading and prompt use tight inline margins so the gap between “프로젝트 파일 감지됨” and “어떻게 열건가요?” stays small.
- A new Open operation creates a project window unless the active one is empty; switching snapshots/restores children and metadata on the existing shared root so scene, gizmo, and panel consumers keep the same group reference.
- Switching restores saved children individually, so activating an empty project never calls Three.js `Group.add` without an object.
- Previous/next controls activate with multiple projects. The always-enabled dropdown switches projects, creates empty project windows, and reorders entries with native drag-and-drop; pointer position selects a before/after insertion marker matching Scene object reorder feedback. Every expanded project row has a Lucide trash control that removes that project without first activating it.
- The project-tab dropdown stays open for clicks inside the tab/menu subtree by checking `event.composedPath()` before hiding it, which avoids false closes when the menu re-renders during actions like adding a project.
- One project window always exists: an empty window is created on startup, and the sole remaining project's trash control and deletion path are disabled.
- Switching synchronously snapshots/restores camera position, OrbitControls target, and zoom through renderer-owned `pde:get-camera-state` / `pde:set-camera-state` events.
