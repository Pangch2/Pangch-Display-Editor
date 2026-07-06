# duplicate.ts

## Purpose
Duplicates selected groups and objects in the editor scene while preserving group membership, scene order, returned selection, object UUID metadata, display metadata, block properties, custom pivots, colors, and per-instance attributes. Instanced objects append back into their source InstancedMesh, growing instance buffers when needed instead of creating a new InstancedMesh.

## Exports

### Types / Interfaces
- `DuplicationSelection` -- returned selection containing newly duplicated group IDs and object instances.

### Functions / Methods
- `flushPendingHeadClones()` -- compatibility no-op; instanced duplication is now handled directly in batches.
- `duplicateGroupsAndObjects(loadedObjectGroup, groupIds, objectEntries)` -- clones selected root groups and non-covered objects, batching InstancedMesh append work by source mesh before returning the duplicated selection.

## Internal State
- Module-level matrix and color scratch objects reduce per-clone allocations.
- Instanced clone jobs are grouped per source mesh so each source mesh appends all duplicate instances in one batch.
- `cloneData` preserves Maps, Sets, and Three-style `clone()` values used by copied plain-mesh `userData`.

## Dependencies (imports)
- `three/webgpu` -- mesh, geometry, matrix, color, UUID, and instancing primitives.
- `./group` -- canonical group tree, object mapping, and clone job helpers.
- `../selection/overlay` -- resolves per-instance display type.

## Used By (known callers)
- Control/key handling paths that invoke object or group duplicate actions.

## Notes
- Plain Mesh objects use `clone()`, then restore editor `userData` with `cloneData` so repeated duplication keeps metadata.
- InstancedMesh objects grow `instanceMatrix`, `instanceColor`, and geometry `InstancedBufferAttribute` arrays when needed, then copy matrix/color/instanced attribute rows and increase `mesh.count`.
- Per-instance geometry attributes such as atlas UV offsets/transforms are copied row-for-row from source instance to appended instance so texture mapping is preserved.
- Normal append path expects meshes created by `mesh-builder.ts` to have spare capacity; resize is a compatibility fallback for already-loaded or full-capacity meshes.
- When an instanced buffer grows, geometry GPU resources are disposed and materials are marked `needsUpdate`, but WebGPU buffer resizing is still best avoided by loading meshes with spare capacity.
- Group clone jobs rely on `group.ts` for structure cloning and object traversal.
