# mesh-builder.ts

## Purpose
Main-thread renderer for parsed PBDE projects. Loads parsed metadata, consumes batched or legacy geometry metadata, builds textures/materials/InstancedMesh roots, applies optional per-instance atlas UV transforms, manages scene clearing and merging, stores current project details, and handles selection state for newly created objects.

## Exports

### Types / Interfaces
- `LoadedSelection` -- maps each loaded mesh root to only the instance IDs created or appended by the current load.

### Variables / Constants
- `loadedObjectGroup` -- shared `THREE.Group` that holds all rendered project objects

### Functions / Methods
- `beginPbdeLoadGeneration()` -- bumps generation token so stale async work can be ignored
- `performSelection(newlyAddedSelectableMeshes)` -- selects only the newly loaded instance IDs after load/merge, preserving group-priority selection.
- `loadAndRenderPbde(file, isMerge, overrideGen?)` -- parse file and instantiate scene objects
- `updatePlayerHeadTexture(objectUuid, textureUrl): Promise<void>` -- redraws one player head's atlas slot in place, splitting a shared slot when necessary, and updates its UV offset and hat state without rebuilding the object.
- `updateDisplayObjectMatrix(objectUuid, name): Promise<void>` -- applies item/player-head display changes to the existing instance matrix while preserving its UUID, selection, and pivot.
- `updateObjectBrightness(objectUuid, brightness): void` -- updates one object's stored brightness and per-instance sky-light color without rebuilding its mesh.
- `replaceDisplayObject(objectUuid, name, transformContext?): Promise<void>` -- rebuilds one display object through the PBDE pipeline, removes existing player-head render transforms, preserves the active center/origin pivot and any stored custom pivot in world space, and requests normal gizmo selection replacement.

## Internal State
- Texture/material caches for block and atlas assets
- `currentLoadGen` token to invalidate stale async results
- Shared placeholder material and cached head geometries
- Weakly keyed player-head atlas canvas state used for in-place skin edits and new-slot allocation
- Concurrency gate for texture decoding to avoid overload
- Signature hash scratch buffer and per-load geometry/material update caches to reduce mesh creation allocations
- Per-load material preload cache resolves unique signature-group materials before `InstancedMesh` creation, with placeholder material updates retained only as a fallback for failed or late material loads.
- Signature groups retain parser-provided instance metadata by reference, cache their UV-transform count once, and deduplicate material preload promises to avoid per-instance metadata copies and repeated waits during mesh creation.
- Per-instance atlas UV transform arrays, display-type, block-property, and NBT metadata for objects that share geometry.
- Dynamic-draw per-instance colors encode the fixed warm RGB palette for sky-light levels `0..15`, defaulting to sky `15` when metadata is absent and supporting immediate runtime brightness updates and duplication.
- Optional `geometryBatches` metadata path skips per-item regrouping by consuming parser-provided shared parts plus instance arrays.
- `MAX_INSTANCES_PER_INSTANCED_MESH` chunk limit prevents oversized signature groups from becoming one huge `InstancedMesh`
- `INITIAL_INSTANCES_PER_INSTANCED_MESH` starts block chunks at half capacity so duplicated instances can append without resizing WebGPU buffers
- Small instanced chunks allocate at least 256 capacity so repeated duplication avoids WebGPU buffer resizing for matrix/UV attributes.
- Merge builds a per-call lookup of existing non-atlas meshes by stable PBDE signature and appends compatible instances into spare capacity before creating another mesh chunk.

## Dependencies (imports)
- `three/webgpu` -- scene graph, geometry, material, and texture classes
- `fflate` -- creates the minimal compressed PBDE payload used for single-object replacement
- `../entityMaterial.js` -- entity/player-head material creation
- `../controls/grouping/delete` -- removes the superseded instance after its replacement is ready
- `../controls/selection/overlay` -- resolves display-specific default pivots and local bounds during object replacement
- `./scene-parser` -- parses PBDE archive into metadata
- `./pbde-assets` -- IPC asset decoding helpers and provider
- `./pbde-log` -- central PBDE log registry plus localStorage flag helpers for load/stat timing logs
- `./pbde-types` -- geometry, group, and metadata types

## Used By (known callers)
- `upload-pbde.ts` -- drives load and merge flow
- `ui/object-properties.ts` -- updates player-head textures and display matrices in place, rebuilding only geometry-changing properties

## Notes
- Uses WebGPU-only Three.js path; no WebGL fallback.
- Clears caches and scene state on non-merge load, then builds block and item display objects as InstancedMesh roots.
- Mesh building prefers `WorkerMetadata.geometryBatches`; if absent, it groups legacy geometry metadata by `itemId` before signature matching so all parts of one scene object merge into the same InstancedMesh geometry.
- During InstancedMesh creation, hashed part signatures avoid long model-matrix string joins, merged geometry is cached by geometry layout, and materials are normally preloaded before meshes enter the scene to avoid placeholder-to-real material swaps.
- Batched instance metadata is reused directly instead of being normalized into duplicate transform/meta arrays; display type is derived when registering each instance.
- When `atlasUvTransform` or `atlasUvTransforms` metadata is present, mesh chunks clone the merged geometry and attach one or more instanced UV transform attributes; merged geometry includes `geometryPartIndex` so TSL materials can select the correct per-part atlas transform.
- Batched object metadata prefers `GeometryInstanceMeta.blockProps` over representative part props so variants grouped into one mesh still display their own properties.
- Block and item display signature groups remain separate; loaded instanced meshes set their root `userData.displayType` from the first chunk instance and also populate `userData.displayTypes` per instance.
- `GeometryMeta.geometryBufferKey` is used when present so same model id/index values from different packed batches do not collide.
- Signature groups are split into 32,768-instance chunks to avoid partial rendering/dropout from oversized instanced draws.
- Instanced meshes are allocated with spare capacity and then `mesh.count` is lowered to the active instance count so duplicate append can reuse existing matrix/UV buffers without rebinding texture attributes; tiny chunks still get 256 slots minimum to reduce duplicate-time chunk creation.
- Non-atlas meshes retain their PBDE signature in `userData`; merge reuses only an exact signature match and falls back to normal mesh creation for atlas content or exhausted capacity. Fully reused groups skip unused material preloading.
- Load results track new instance IDs per mesh so appending to an existing mesh does not cause its older instances to be selected.
- Special-cases atlas textures, item-display player heads, and stale async load cancellation.
- Fresh loads store parser-provided project details on `loadedObjectGroup.userData`; merges preserve the current details.
- `loadedObjectGroup.userData.objectNbt` maps object UUIDs to editable NBT strings for the properties panel.
- Property-panel model changes finish building the replacement before deleting the current instance, so load failures preserve the original object.
- Property-panel model changes keep the active Pivot Mode reference fixed: center uses bounds center, block origin uses local bounds minimum, and custom pivots retain their world position without changing the object transform.
- UUID-indexed brightness and player-head texture metadata feed the properties panel and survive property-driven object replacement.
- Brightness panel edits update the selected instance color in place from the sky-light palette; block brightness remains stored but does not affect rendering yet.
- Player-head display and half-scale transforms share one renderer matrix; replacement reverses that same matrix before parsing, preventing display/property edits from accumulating scale or translation.
- Display-only edits update the current instance slot and metadata without running the PBDE replacement/delete pipeline.
- Player-head texture edits redraw the existing atlas slot when exclusive; shared slots receive a new slot so other instances keep their skin. The instance matrix and UUID remain unchanged.
- Player-head image load failures retry once with the default skin; property edits store that fallback URL instead of the invalid input.
- Logs are controlled through `pbde-log.ts` registry helpers. `Processing items`, `Load timings`, `Geometry stats`, and `Mesh uploaded` default to enabled; `Finished processing` defaults to disabled.
