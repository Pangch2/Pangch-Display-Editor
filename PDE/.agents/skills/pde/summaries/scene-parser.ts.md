# scene-parser.ts

## Purpose
Parse PBDE archive data into renderer-ready metadata. Decompresses PRJ2 content, resolves model trees and blockstate variants, delegates texture atlas packing, builds packed geometry buffers, and emits batched geometry, atlas UV transform, group, and scene-order metadata for `mesh-builder.ts`.

## Exports

### Types / Interfaces
- `PbdeAssetProvider` -- asset source contract used during parse
- `ParsedPbdeProject` -- parser result with `metadata`, optional `geometryBatches`, and raw `geometryBuffer`

### Functions / Methods
- `parsePbdeProject(fileContent, provider)` -- main parser entry; returns packed geometry and metadata

## Internal State
- `assetProvider` -- active provider for JSON and texture reads
- `groups` and `sceneOrder` -- module-level accumulators reset per parse
- Promise caches for JSON assets and block display templates to deduplicate concurrent scene traversal work
- Multiple caches for model resolution, textures, block/item geometry, and worker-side state
- Promise and resolved-template caches for block/item display templates deduplicate repeated geometry and display-matrix work before traversal.
- Geometry pack step groups identical renderable shapes into `geometryBatches`; each batch stores shared parts once and per-instance transform/uuid/group/name data separately.
- Atlas-backed single-transform geometry can batch across different texture atlas locations and single matrix rotations by comparing normalized UV/shape keys, moving relative model-matrix differences into per-instance transforms, and storing per-instance `atlasUvTransform`, while keeping atlas material/transparency class in the key.

## Dependencies (imports)
- `fflate` -- `decompressSync`, `strFromU8` for PRJ2 archive unpacking
- `three/webgpu` -- matrix/vector math and geometry construction
- `./texture-atlas-builder` -- builds atlas textures and rewrites geometry UVs/texture paths
- `./pbde-types` -- shared group type alias

## Used By (known callers)
- `mesh-builder.ts` -- calls `parsePbdeProject` with `mainThreadAssetProvider`

## Notes
- Expects PRJ2 archive with embedded `scene.json`.
- Produces shared geometry buffer plus metadata references, not ready-made meshes.
- `metadata.geometries` remains for compatibility but batched output is emitted through `metadata.geometryBatches`.
- Handles hardcoded models, display transforms, and player/item display variants while atlas packing is delegated.
- Reuses identical block display templates and block model geometry during a parse; per-node transform/uuid metadata is still assigned separately.
- Large scene traversal avoids cloning the full source tree, preloads repeated block/item templates once, and then walks nodes synchronously into a shared render list instead of creating per-node promises and nested arrays.
- Pack key generation caches repeated matrix and structured JSON string keys within a parse.
- Same-shape atlas geometry only ignores texture location and block props when every part in an item shares one atlas UV transform and one model matrix; multi-texture or mixed-matrix models keep the legacy texture/property-sensitive key.
- Per-instance `blockProps` are emitted for batched geometry so scene-panel metadata remains correct when different properties share one mesh root.
- Logs parse timings for archive extraction, scene traversal, atlas generation, buffer packing, and total parse time, plus scene prep/traverse/order sub-timings.
