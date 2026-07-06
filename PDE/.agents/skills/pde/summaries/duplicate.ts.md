# duplicate.ts

## Purpose
Duplicates selected groups and objects in the editor scene while preserving group membership, scene order, returned selection, object UUID metadata, display metadata, block properties, custom pivots, colors, and per-instance attributes. Instanced objects append into their current InstancedMesh until capacity is full, then continue in a new chunk mesh with cloned geometry/materials.

## Exports

### Types / Interfaces
- `DuplicationSelection` -- returned selection containing newly duplicated group IDs and object instances.

### Functions / Methods
- `flushPendingHeadClones()` -- compatibility no-op; instanced duplication is now handled directly in batches.
- `duplicateGroupsAndObjects(loadedObjectGroup, groupIds, objectEntries)` -- clones selected root groups and non-covered objects, batching InstancedMesh append work by source mesh before returning the duplicated selection.

## Internal State
- Module-level matrix and color scratch objects reduce per-clone allocations.
- Instanced clone jobs are grouped per source mesh so each source mesh appends all duplicate instances in one batch, spilling into new chunk meshes when full.
- `cloneData` preserves Maps, Sets, and Three-style `clone()` values used by copied plain-mesh `userData`.

## Dependencies (imports)
- `three/webgpu` -- mesh, geometry, matrix, color, UUID, and instancing primitives.
- `./group` -- canonical group tree, object mapping, and clone job helpers.
- `../selection/overlay` -- resolves per-instance display type.

## Used By (known callers)
- Control/key handling paths that invoke object or group duplicate actions.

## Notes
- Plain Mesh objects use `clone()`, then restore editor `userData` with `cloneData` so repeated duplication keeps metadata.
- InstancedMesh objects copy matrix/color/instanced attribute rows into available slots and increase `mesh.count`; when capacity is full, duplication creates another InstancedMesh chunk instead of resizing existing WebGPU buffers.
- Per-instance geometry attributes such as atlas UV offsets/transforms are copied row-for-row from source instance to appended instance so texture mapping is preserved.
- New chunks clone the source geometry/materials and reset per-instance `userData` maps so copied copies remain selectable and duplicable.
- Normal append path expects meshes created by `mesh-builder.ts` to have spare capacity; chunk spillover handles unlimited repeated duplication without rebinding existing buffers.
- Group clone jobs rely on `group.ts` for structure cloning and object traversal.
