# delete.ts

## Purpose
Deletes selected groups and objects from the scene graph and from the editor's custom group/object metadata structures.

## Exports

### Types / Interfaces
- `DeleteSelectionCallbacks` -- callbacks needed after deletion to clear selection state.

### Functions / Methods
- `deleteSelectedItems(loadedObjectGroup, currentSelection, callbacks): void` -- removes the selected groups and instances, updates metadata maps, and handles batched/instanced mesh compaction.

## Internal State
Uses a shared temporary matrix for swap-pop instance handling.

## Dependencies (imports)
- `three/webgpu` -- mesh, matrix, and group types.
- `./group` -- hierarchy and metadata bookkeeping.

## Used By (known callers)
- `renderer/controls/gizmo.ts`
- `renderer/controls/handle-key.ts`

## Notes
Instanced meshes are removed with swap-pop logic, so group/object references must be updated after compaction.
