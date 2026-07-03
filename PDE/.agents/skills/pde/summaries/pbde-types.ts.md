# pbde-types.ts

## Purpose
Shared type layer for load-project pipeline. Keeps parser output, batched geometry metadata, renderer inputs, group tree, and asset payload shapes aligned across files.

## Exports

### Types / Interfaces
- `AssetPayload` -- asset content union from `PbdeAssetProvider.getAsset`
- `TypedArrayConstructor` -- runtime typed-array constructor shape for merge logic
- `HeadGeometrySet` -- cached player-head geometries (`base`, `layer`, `merged`)
- `GeometryMeta` -- per-geometry slice metadata into shared geometry buffer, including optional atlas UV transform
- `GeometryInstanceMeta` -- per-instance transform/uuid/group/name data for a batched geometry shape, including optional atlas UV transform and block properties
- `GeometryInstanceBatch` -- compressed parser output with shared geometry `parts` and repeated `instances`
- `OtherItem` -- non-geometry render item such as player head display data
- `GroupChild` -- child entry in `GroupData.children`
- `GroupData` -- group node with transform, children, parent, and optional pivot
- `WorkerMetadata` -- parser output consumed by `loadAndRenderPbde`, with optional `geometryBatches`

## Dependencies (imports)
- `three/webgpu` -- type-only `BufferGeometry`, `Object3D`, `Vector3`, `Quaternion`

## Used By (known callers)
- `scene-parser.ts` -- builds `ParserGroupData` and `WorkerMetadata` shape
- `mesh-builder.ts` -- consumes geometry, group, and metadata types
- `pbde-assets.ts` -- uses `AssetPayload`

## Notes
- `GroupData.position/quaternion/scale` may be plain objects or THREE instances.
- `GeometryMeta.geometryBufferKey` distinguishes actual buffer slices when different batches share the same model id/index.
- `GeometryMeta.uvTransform` and `GeometryInstanceMeta.atlasUvTransform` allow same-shape atlas geometry to vary texture location per instance.
- `GeometryInstanceMeta.blockProps` preserves per-object properties when different variants share one geometry batch.
- `WorkerMetadata.atlas` stays optional to signal atlas packing result.
- `WorkerMetadata.geometries` remains for legacy per-item metadata; `geometryBatches` is preferred when present.
