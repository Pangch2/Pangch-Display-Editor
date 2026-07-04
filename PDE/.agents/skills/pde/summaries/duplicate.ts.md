# duplicate.ts

## Purpose
Duplicates selected groups and object instances, preserving group hierarchy, custom metadata, instance transforms, and scene ordering. Object duplication now uses InstancedMesh or Mesh clones instead of batched writable pools.

## Exports

### Types / Interfaces
- `DuplicationSelection` -- the cloned groups and object instances to select after duplication.

### Functions / Methods
- `flushPendingHeadClones(loadedObjectGroup, ctx)` -- resolves deferred player-head clones into pooled InstancedMesh meshes.
- `duplicateGroupsAndObjects(loadedObjectGroup, groupIds, objectEntries): DuplicationSelection` -- clones selected groups and/or object instances.

## Internal State
Maintains a module-level queue for pending player-head clones.

## Dependencies (imports)
- `three/webgpu` -- mesh, geometry, material, and transform types.
- `./group` -- group tree cloning and metadata helpers.
- `../selection/overlay` -- display-type and instance metadata helpers.
- `../../entityMaterial.js` -- creates baked fallback materials for cloned player-head meshes.

## Used By (known callers)
- `renderer/controls/gizmo/gizmo-commands.ts`

## Notes
The old BatchedMesh writable-pool path is removed. Standard InstancedMesh clones and the player-head bulk path remain.
