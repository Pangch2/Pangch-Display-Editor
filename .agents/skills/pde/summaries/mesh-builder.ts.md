# mesh-builder.ts

## Purpose
Main-thread renderer for parsed PBDE projects. Loads parsed metadata, consumes batched or legacy geometry metadata, builds textures/materials/InstancedMesh roots, applies optional per-instance atlas UV transforms, manages scene clearing and merging, stores current project details, and handles selection state for newly created objects.

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
- Per-load material preload cache resolves unique signature-group materials before `InstancedMesh` creation, with placeholder material updates retained only as a fallback for failed or late material loads.
- Per-instance atlas UV transform arrays, display-type, and block-property metadata for same-shape objects that share geometry but use different atlas locations, source display types, or rotation-only properties.
- Optional `geometryBatches` metadata path skips per-item regrouping by consuming parser-provided shared parts plus instance arrays.
- `MAX_INSTANCES_PER_INSTANCED_MESH` chunk limit prevents oversized signature groups from becoming one huge `InstancedMesh`
- `INITIAL_INSTANCES_PER_INSTANCED_MESH` starts block chunks at half capacity so duplicated instances can append without resizing WebGPU buffers
- Small instanced chunks allocate at least 256 capacity so repeated duplication avoids WebGPU buffer resizing for matrix/UV attributes.

## Dependencies (imports)
- `three/webgpu` -- scene graph, geometry, material, and texture classes
- `../entityMaterial.js` -- entity/player-head material creation
- `./scene-parser` -- parses PBDE archive into metadata
- `./pbde-assets` -- IPC asset decoding helpers and provider
- `./pbde-log` -- central PBDE log registry plus localStorage flag helpers for load/stat timing logs
- `./pbde-types` -- geometry, group, and metadata types

## Used By (known callers)
- `upload-pbde.ts` -- drives load and merge flow

## Notes
- Uses WebGPU-only Three.js path; no WebGL fallback.
- Clears caches and scene state on non-merge load, then builds block and item display objects as InstancedMesh roots.
- Mesh building prefers `WorkerMetadata.geometryBatches`; if absent, it groups legacy geometry metadata by `itemId` before signature matching so all parts of one scene object merge into the same InstancedMesh geometry.
- During InstancedMesh creation, hashed part signatures avoid long model-matrix string joins, merged geometry is cached by geometry layout, and materials are normally preloaded before meshes enter the scene to avoid placeholder-to-real material swaps.
- When `atlasUvTransform` or `atlasUvTransforms` metadata is present, mesh chunks clone the merged geometry and attach one or more instanced UV transform attributes; merged geometry includes `geometryPartIndex` so TSL materials can select the correct per-part atlas transform.
- Batched object metadata prefers `GeometryInstanceMeta.blockProps` over representative part props so variants grouped into one mesh still display their own properties.
- Loaded instanced meshes populate `userData.displayTypes` per instance so mixed block/item-display batches still work with `Overlay.getDisplayType`.
- `GeometryMeta.geometryBufferKey` is used when present so same model id/index values from different packed batches do not collide.
- Signature groups are split into 32,768-instance chunks to avoid partial rendering/dropout from oversized instanced draws.
- Instanced meshes are allocated with spare capacity and then `mesh.count` is lowered to the active instance count so duplicate append can reuse existing matrix/UV buffers without rebinding texture attributes; tiny chunks still get 256 slots minimum to reduce duplicate-time chunk creation.
- Special-cases atlas textures, item-display player heads, and stale async load cancellation.
- Fresh loads store parser-provided project details on `loadedObjectGroup.userData`; merges preserve the current details.
- Logs are controlled through `pbde-log.ts` registry helpers. `Processing items` defaults to enabled; optional `Load timings`, `Geometry stats`, `Mesh uploaded`, and `Finished processing` logs default to disabled.
