# upload-pbde.ts

## Purpose
Window drag-and-drop entrypoint for PBDE files. Opens an "Open" vs "Merge" modal, then routes files to `loadpbde` or `mergepbde`.

## Exports

### Variables / Constants
- `loadedObjectGroup` -- re-export from `mesh-builder`

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
- Files without `.bdengine` or `.pdengine` extension are ignored.
