# pbde-types.ts

## Purpose
Shared type layer for load-project pipeline. Keeps parser output, renderer inputs, group tree, and asset payload shapes aligned across files.

## Exports

### Types / Interfaces
- `AssetPayload` -- asset content union from `PbdeAssetProvider.getAsset`
- `TypedArrayConstructor` -- runtime typed-array constructor shape for merge logic
- `HeadGeometrySet` -- cached player-head geometries (`base`, `layer`, `merged`)
- `GeometryMeta` -- per-geometry slice metadata into shared geometry buffer
- `OtherItem` -- non-geometry render item such as player head display data
- `GroupChild` -- child entry in `GroupData.children`
- `GroupData` -- group node with transform, children, parent, and optional pivot
- `WorkerMetadata` -- parser output consumed by `loadAndRenderPbde`

## Dependencies (imports)
- `three/webgpu` -- type-only `BufferGeometry`, `Object3D`, `Vector3`, `Quaternion`

## Used By (known callers)
- `scene-parser.ts` -- builds `ParserGroupData` and `WorkerMetadata` shape
- `mesh-builder.ts` -- consumes geometry, group, and metadata types
- `pbde-assets.ts` -- uses `AssetPayload`

## Notes
- `GroupData.position/quaternion/scale` may be plain objects or THREE instances.
- `WorkerMetadata.atlas` stays optional to signal atlas packing result.
