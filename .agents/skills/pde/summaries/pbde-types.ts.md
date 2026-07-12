# pbde-types.ts

## Purpose
Shared type layer for load-project pipeline. Keeps parser output, batched geometry metadata, renderer inputs, group tree, and asset payload shapes aligned across files.

## Exports

### Types / Interfaces
- `AssetPayload` -- asset content union from `PbdeAssetProvider.getAsset`
- `TypedArrayConstructor` -- runtime typed-array constructor shape for merge logic
- `HeadGeometrySet` -- cached player-head geometries (`base`, `layer`, `merged`)
- `GeometryMeta` -- per-geometry slice metadata into shared geometry buffer, including optional atlas UV transform
- `GeometryInstanceMeta` -- per-instance transform/uuid/group/name/NBT/brightness data for a batched geometry shape, including optional single or per-part atlas UV transforms, block properties, and item-display metadata
- `GeometryInstanceBatch` -- compressed parser output with shared geometry `parts` and repeated `instances`
- `OtherItem` -- non-geometry render item such as player head display data
- `GroupChild` -- child entry in `GroupData.children`
- `GroupData` -- group node with transform, children, parent, optional pivot, and editable NBT
- `ProjectDetails` -- normalized project name, project NBT, and full NBT strings.
- `WorkerMetadata` -- parser output consumed by `loadAndRenderPbde`, with optional `geometryBatches` and required project details.

## Dependencies (imports)
- `three/webgpu` -- type-only `BufferGeometry`, `Object3D`, `Vector3`, `Quaternion`

## Used By (known callers)
- `scene-parser.ts` -- builds `ParserGroupData` and `WorkerMetadata` shape
- `mesh-builder.ts` -- consumes geometry, group, and metadata types
- `pbde-assets.ts` -- uses `AssetPayload`

## Notes
- `GroupData.position/quaternion/scale` may be plain objects or THREE instances.
- `GeometryMeta.geometryBufferKey` distinguishes actual buffer slices when different batches share the same model id/index.
- `GeometryMeta.uvTransform`, `GeometryInstanceMeta.atlasUvTransform`, and `GeometryInstanceMeta.atlasUvTransforms` allow same-shape atlas geometry to vary texture location per instance and per part.
- `GeometryInstanceMeta.blockProps` preserves per-object properties when different variants share one geometry batch.
- `GeometryInstanceMeta.isItemDisplayModel` and `itemDisplayType` preserve display semantics when block and item display instances share one batch.
- Geometry and instance metadata can retain each object's editable NBT string.
- Instance metadata can retain optional sky/block brightness values.
- `WorkerMetadata.atlas` stays optional to signal atlas packing result.
- `WorkerMetadata.geometries` remains for legacy per-item metadata; `geometryBatches` is preferred when present.
