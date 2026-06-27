# scene-parser.ts

## Purpose
Parse PBDE archive data into renderer-ready metadata. Decompresses PRJ2 content, resolves model trees and blockstate variants, builds packed geometry buffers, and emits atlas/group/scene-order metadata for `mesh-builder.ts`.

## Exports

### Types / Interfaces
- `PbdeAssetProvider` -- asset source contract used during parse
- `ParsedPbdeProject` -- parser result with `metadata` and raw `geometryBuffer`

### Functions / Methods
- `parsePbdeProject(fileContent, provider)` -- main parser entry; returns packed geometry and metadata

## Internal State
- `assetProvider` -- active provider for JSON and texture reads
- `groups` and `sceneOrder` -- module-level accumulators reset per parse
- Multiple caches for model resolution, textures, geometry, and worker-side state

## Dependencies (imports)
- `fflate` -- `decompressSync`, `strFromU8` for PRJ2 archive unpacking
- `three/webgpu` -- matrix/vector math and geometry construction
- `./pbde-types` -- shared group type alias

## Used By (known callers)
- `mesh-builder.ts` -- calls `parsePbdeProject` with `mainThreadAssetProvider`

## Notes
- Expects PRJ2 archive with embedded `scene.json`.
- Produces shared geometry buffer plus metadata references, not ready-made meshes.
- Handles hardcoded models, display transforms, atlas packing, and player/item display variants in one pass.
