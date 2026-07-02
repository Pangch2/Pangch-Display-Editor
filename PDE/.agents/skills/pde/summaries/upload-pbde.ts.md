# upload-pbde.ts

## Purpose
Window drag-and-drop entrypoint for PBDE files. Opens an "Open" vs "Merge" modal, then routes files to `loadpbde` or `mergepbde`.

## Exports

### Variables / Constants
- `loadedObjectGroup` -- re-export from `mesh-builder`

### Functions / Methods
- `waitForRenderSettled(frames): Promise<void>` -- dispatches a render-settled request and resolves after renderer frame/GPU queue completion
- `logFinalPbdeLoadTime(startMs, mode, fileCount): Promise<void>` -- logs render-settle wait time and open/merge perceived load duration

## Internal State
- `ModalOverlayElement` -- local `HTMLDivElement` extension with optional ESC handler
- Drop modal is single-instance via `drop-modal-overlay`

## Dependencies (imports)
- `../ui/ui-open-close.js` -- modal open/close animation helpers
- `three/webgpu` -- `THREE.Object3D` for selection set typing
- `./mesh-builder` -- load/render pipeline and selection helpers

## Used By (known callers)
- `renderer.ts` -- imports `loadedObjectGroup`

## Notes
- `loadpbde` clears scene on first file, merges later files in same batch.
- `mergepbde` appends all files, then selects all new meshes.
- Both open and merge log perceived load time from operation start through `pde:scene-updated`, render-settled frames, and GPU queue completion when available.
- Logs `[PBDE] Render settle wait` separately so GPU/first-render wait can be compared with mesh-builder CPU timings.
- Files without `.bdengine` or `.pdengine` extension are ignored.
