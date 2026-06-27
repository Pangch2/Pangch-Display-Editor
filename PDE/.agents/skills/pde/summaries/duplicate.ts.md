# duplicate.ts

## Purpose
Duplicates selected groups and objects, preserving group hierarchy, custom metadata, instance transforms, and special handling for player-head meshes and batched geometry.

## Exports

### Types / Interfaces
- `DuplicationSelection` -- the cloned groups and object instances to select after duplication.

### Functions / Methods
- `flushPendingHeadClones(loadedObjectGroup, ctx)` -- resolves deferred player-head clones into writable pooled meshes.
- `duplicateGroupsAndObjects(loadedObjectGroup, groupIds, objectEntries): DuplicationSelection` -- clones selected groups and/or objects into new writable batches.

## Internal State
Maintains a module-level queue for pending player-head clones.

## Dependencies (imports)
- `three/webgpu` -- mesh, geometry, material, and transform types.
- `./group` -- group tree cloning and metadata helpers.
- `./overlay` -- display-type and instance metadata helpers.
- `../entityMaterial.js` -- creates baked fallback materials for cloned player-head meshes.

## Used By (known callers)
- `renderer/controls/gizmo.ts`

## Notes
Uses writable batch pooling to keep draw calls low. Clone metadata mirrors the source object when possible, including names, display type, block props, and scene order.
