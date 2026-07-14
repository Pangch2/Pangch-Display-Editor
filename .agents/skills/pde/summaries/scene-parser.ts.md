# scene-parser.ts

## Purpose
Parse PBDE archive data into renderer-ready metadata. Decompresses PRJ2 content, resolves model trees and blockstate variants, delegates texture atlas packing, builds packed geometry buffers, and emits batched geometry, project details, atlas UV transform, group, and scene-order metadata for `mesh-builder.ts`.

## Exports

### Types / Interfaces
- `PbdeAssetProvider` -- asset source contract used during parse
- `ParsedPbdeProject` -- parser result with `metadata`, optional `geometryBatches`, and raw `geometryBuffer`

### Functions / Methods
- `getPlayerHeadDisplayMatrix(displayType)` -- returns the shared player-head display transform matrix used by parsing and targeted object replacement.
- `getItemDisplayModelMatrix(rawName)` -- returns a retained local model/display matrix for in-place display edits without requiring the cleared asset provider.
- `parsePbdeProject(fileContent, provider)` -- main parser entry; returns packed geometry and metadata

## Internal State
- `assetProvider` -- active provider for JSON and texture reads
- `groups` and `sceneOrder` -- module-level accumulators reset per parse
- Promise caches for JSON assets and block display templates to deduplicate concurrent scene traversal work
- Multiple caches for model resolution, textures, block/item geometry, and worker-side state
- Promise and resolved-template caches for block/item display templates deduplicate repeated geometry and display-matrix work before traversal.
- Retained item display matrices store every editor-supported display variant per loaded item name after temporary parser caches are cleared.
- Geometry pack step groups identical renderable shapes into `geometryBatches`; each batch stores shared parts once and per-instance transform/uuid/group/name/NBT data separately.
- Atlas-backed geometry can batch across different texture atlas locations and single matrix rotations by comparing normalized UV/shape keys, moving uniform local model-matrix differences into per-instance transforms, and storing per-instance `atlasUvTransform` or per-part `atlasUvTransforms`; block and item display sources remain separate.

## Dependencies (imports)
- `fflate` -- `decompressSync`, `strFromU8` for PRJ2 archive unpacking
- `three/webgpu` -- matrix/vector math and geometry construction
- `./texture-atlas-builder` -- builds atlas textures and rewrites geometry UVs/texture paths
- `./pbde-log` -- central PBDE log registry plus localStorage flag helpers for parser timing logs
- `./pbde-types` -- shared group type alias

## Used By (known callers)
- `mesh-builder.ts` -- calls `parsePbdeProject` with `mainThreadAssetProvider`

## Notes
- Expects PRJ2 archive with embedded `scene.json`.
- Produces shared geometry buffer plus metadata references, not ready-made meshes.
- `metadata.geometries` remains for compatibility but batched output is emitted through `metadata.geometryBatches`.
- Handles hardcoded models, display transforms, and player/item display variants while atlas packing is delegated.
- Player-head items retain their editable world transform; their display/render scale matrix is applied symmetrically by `mesh-builder.ts`.
- Beds and trapped chests use hardcoded blockstates; bed geometry and split-texture compatibility remain isolated in the hardcoded assets.
- Reuses identical block display templates and block model geometry during a parse; per-node transform/uuid metadata is still assigned separately.
- Large scene traversal avoids cloning the full source tree, preloads repeated block/item templates once, and then walks nodes synchronously into a shared render list instead of creating per-node promises and nested arrays.
- Pack key generation caches repeated matrix and structured JSON string keys within a parse.
- Same-shape atlas geometry ignores texture location, item display type, and block props when every part has an atlas UV transform, the part model matrix is uniform, and the part count stays within the supported per-part UV transform limit; it splits batches by block/item source type and local model matrix so display classification and object origins remain correct. Legacy batches also split by geometry identity, part index, local matrix, texture, and tint.
- Per-instance `blockProps` are emitted for batched geometry so scene-panel metadata remains correct when different properties share one mesh root.
- Per-instance item-display flags/types are emitted so block display and item display objects can share one mesh root without losing downstream display-type behavior.
- Optional `Scene timings` and `Parse timings` logs are controlled through `pbde-log.ts` registry helpers and default to disabled.
- Root `name`, `mainNBT`, and `nbt` values are normalized to strings in `metadata.projectDetails`.
- Block and item display paths, including targeted item-model replacements, preserve node NBT in per-instance metadata.
- Block and item display paths preserve optional `{ sky, block }` brightness metadata for the properties panel.
- Display nodes may provide a UUID for targeted in-editor model replacement; normal project nodes still receive generated UUIDs.
- Item names using `display=none` are normalized to the base item transform instead of being treated as an unsupported display transform.
- Collection nodes preserve their NBT on group metadata.
