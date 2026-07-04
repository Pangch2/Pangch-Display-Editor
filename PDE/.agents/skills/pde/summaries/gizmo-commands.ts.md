# gizmo-commands.ts

## Purpose
Contains command-level orchestration extracted from `gizmo.ts` for creating groups, ungrouping, deleting selections, and duplicating selections while preserving selection/pivot refresh behavior.

## Exports

### Types / Interfaces
- `GizmoCommandCallbacks` -- common callback surface needed by group/delete commands.
- `DuplicateCommandCallbacks` -- callback surface needed to duplicate while preserving pivot and selection anchor state.

### Functions / Methods
- `createGroupCommand(loadedObjectGroup, currentSelection, callbacks): string | undefined` -- creates a group from current selected groups/objects and selects it.
- `ungroupGroupCommand(loadedObjectGroup, groupId, callbacks): void` -- removes a group and selects its parent when available.
- `deleteSelectedItemsCommand(loadedObjectGroup, currentSelection, callbacks): void` -- deletes selected groups/objects and emits scene update.
- `duplicateSelectedCommand(loadedObjectGroup, currentSelection, selectionAnchorMode, callbacks): void` -- duplicates selected groups/objects and installs the duplicated selection.

## Dependencies (imports)
- `three/webgpu` -- group, mesh, object, and vector types.
- `../grouping/group` -- group creation/ungroup helpers.
- `../grouping/duplicate` -- duplication implementation.
- `../grouping/delete` -- deletion implementation.
- `../selection/select` -- average-origin helper and selection types.

## Used By (known callers)
- `renderer/controls/gizmo/gizmo.ts`

## Notes
This module is intentionally callback-driven so it does not own gizmo module state directly. `gizmo.ts` remains responsible for vertex queue suppression around command execution.