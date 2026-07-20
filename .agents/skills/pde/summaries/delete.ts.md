# delete.ts

## Purpose
Deletes selected groups and objects from the scene graph and editor metadata structures, batching container cleanup for large multi-selections.

## Exports

### Types / Interfaces
- `DeleteSelectionCallbacks` -- callbacks needed after deletion to clear selection state.

### Functions / Methods
- `deleteSelectedItems(loadedObjectGroup, currentSelection, callbacks): void` -- removes selected groups and instanced objects, bulk-filters affected group/scene-order containers, updates metadata maps, and compacts InstancedMesh instances.

## Internal State
Uses a shared temporary matrix for swap-pop instance handling.

## Dependencies (imports)
- `three/webgpu` -- mesh, matrix, and group types.
- `./group` -- hierarchy and metadata bookkeeping.

## Used By (known callers)
- `renderer/controls/gizmo/gizmo.ts`
- `renderer/controls/input/handle-key.ts`

## Notes
Deletion assumes InstancedMesh object instances only. Parent children and scene order are filtered once per deletion batch rather than once per object. Swap-pop updates group references after compaction; emptied duplication-only chunks are detached and their instance/geometry GPU resources are disposed.
