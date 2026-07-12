# duplicate.ts

## Purpose
Duplicates selected groups and objects in the editor scene while preserving group membership, scene order, returned selection, UUID-indexed object metadata, custom pivots, colors, and per-instance attributes. Instanced objects append into their current InstancedMesh until capacity is full, then continue in a spare or newly-created chunk mesh with cloned geometry/materials.

## Exports

### Types / Interfaces
- `DuplicationSelection` -- returned selection containing newly duplicated group IDs and object instances.

### Functions / Methods
- `flushPendingHeadClones()` -- compatibility no-op; instanced duplication is now handled directly in batches.
- `duplicateGroupsAndObjects(loadedObjectGroup, groupIds, objectEntries)` -- clones selected root groups and non-covered objects, batching InstancedMesh append work by source mesh before returning the duplicated selection.

## Internal State
- Module-level matrix and color scratch objects reduce per-clone allocations.
- Group duplication creates one shared `CloneGroupContext` so cloned group names do not rescan the full group map per group.
- Instanced clone jobs are grouped per source mesh so each source mesh appends all duplicate instances in one batch, spilling into new chunk meshes when full and marking changed GPU attributes once per batch.
- A WeakMap-backed spare chunk pool keeps at most one prewarmed InstancedMesh chunk per source mesh; idle prewarm starts when remaining capacity drops below 25%.
- `cloneData` preserves Maps, Sets, and Three-style `clone()` values used by copied plain-mesh `userData`.

## Dependencies (imports)
- `three/webgpu` -- mesh, geometry, matrix, color, UUID, and instancing primitives.
- `./group` -- canonical group tree, object mapping, and clone job helpers.
- `../selection/overlay` -- resolves per-instance display type.
- `../../load-project/pbde-log` -- gates optional duplicate performance timing logs.

## Used By (known callers)
- `renderer/controls/gizmo/gizmo-commands.ts` -- calls `duplicateGroupsAndObjects` from duplicate-selected command handling.

## Notes
- Plain Mesh objects use `clone()`, then restore editor `userData` with `cloneData` so repeated duplication keeps metadata.
- InstancedMesh objects copy matrix/color/instanced attribute rows into available slots and increase `mesh.count`; when capacity is full, duplication first consumes a prewarmed spare chunk, otherwise creates another InstancedMesh chunk instead of resizing existing WebGPU buffers.
- Per-instance geometry attributes such as atlas UV offsets/transforms are copied with typed-array slices from source instance to appended instance so texture mapping is preserved.
- UUID-indexed NBT, brightness, and texture values are copied to the clone so its properties panel and later edits retain the source values.
- New chunks clone the source geometry/materials and reset per-instance `userData` maps so copied copies remain selectable and duplicable; idle prewarm skips stale source meshes removed by project reloads.
- Normal append path expects meshes created by `mesh-builder.ts` to have spare capacity; chunk spillover handles unlimited repeated duplication without rebinding existing buffers.
- Group clone jobs rely on `group.ts` for structure cloning and object traversal.
- `Duplicate timings` pbde log emits one summary line with job counts and timing buckets when enabled.
