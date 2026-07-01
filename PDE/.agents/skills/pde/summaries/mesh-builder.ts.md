# mesh-builder.ts

## Purpose
Main-thread renderer for parsed PBDE projects. Loads parsed metadata, builds textures/materials/InstancedMesh roots, manages scene clearing and merging, and handles selection state for newly created objects.

## Exports

### Variables / Constants
- `loadedObjectGroup` -- shared `THREE.Group` that holds all rendered project objects

### Functions / Methods
- `beginPbdeLoadGeneration()` -- bumps generation token so stale async work can be ignored
- `performSelection(newlyAddedSelectableMeshes)` -- updates active selection after load/merge
- `loadAndRenderPbde(file, isMerge, overrideGen?)` -- parse file and instantiate scene objects

## Internal State
- Texture/material caches for block and atlas assets
- `currentLoadGen` token to invalidate stale async results
- Shared placeholder material and cached head geometries
- Concurrency gate for texture decoding to avoid overload

## Dependencies (imports)
- `three/webgpu` -- scene graph, geometry, material, and texture classes
- `../entityMaterial.js` -- entity/player-head material creation
- `./scene-parser` -- parses PBDE archive into metadata
- `./pbde-assets` -- IPC asset decoding helpers and provider
- `./pbde-types` -- geometry, group, and metadata types

## Used By (known callers)
- `upload-pbde.ts` -- drives load and merge flow

## Notes
- Uses WebGPU-only Three.js path; no WebGL fallback.
- Clears caches and scene state on non-merge load, then builds block and item display objects as InstancedMesh roots.
- Mesh building groups geometry metadata by `itemId` before signature matching so all parts of one scene object merge into the same InstancedMesh geometry.
- Special-cases atlas textures, item-display player heads, and stale async load cancellation.
- Logs per-file elapsed time from `loadAndRenderPbde` entry until mesh roots are added to `loadedObjectGroup`.
