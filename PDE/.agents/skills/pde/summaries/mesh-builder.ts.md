# mesh-builder.ts

## Purpose
Main-thread renderer for parsed PBDE projects. Loads parsed metadata, consumes batched or legacy geometry metadata, builds textures/materials/InstancedMesh roots, manages scene clearing and merging, and handles selection state for newly created objects.

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
- Signature hash scratch buffer and per-load geometry/material update caches to reduce mesh creation allocations
- Optional `geometryBatches` metadata path skips per-item regrouping by consuming parser-provided shared parts plus instance arrays.
- `MAX_INSTANCES_PER_INSTANCED_MESH` chunk limit prevents oversized signature groups from becoming one huge `InstancedMesh`

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
- Mesh building prefers `WorkerMetadata.geometryBatches`; if absent, it groups legacy geometry metadata by `itemId` before signature matching so all parts of one scene object merge into the same InstancedMesh geometry.
- During InstancedMesh creation, hashed part signatures avoid long model-matrix string joins, merged geometry is cached by geometry layout, and only placeholder material slots are tracked for batched async replacement.
- `GeometryMeta.geometryBufferKey` is used when present so same model id/index values from different packed batches do not collide.
- Signature groups are split into 32,768-instance chunks to avoid partial rendering/dropout from oversized instanced draws.
- Special-cases atlas textures, item-display player heads, and stale async load cancellation.
- Logs per-file elapsed time from `loadAndRenderPbde` entry until mesh roots are added to `loadedObjectGroup`.
