# gizmo-commands.ts

## Purpose
Contains command-level orchestration extracted from `gizmo.ts` for creating groups, ungrouping, deleting selections, and duplicating selections while preserving selection and pivot refresh behavior.

## Exports

### Types / Interfaces
- `GizmoCommandCallbacks` -- callback surface needed by group and delete commands.
- `DuplicateCommandCallbacks` -- callback surface needed to duplicate while preserving pivot and selection anchor state.

### Functions / Methods
- `createGroupCommand(...)` -- creates a group from current selected groups and object instances.
- `ungroupGroupCommand(...)` -- removes a group and selects its parent when available.
- `deleteSelectedItemsCommand(...)` -- deletes selected groups and objects and emits scene update.
- `duplicateSelectedCommand(...)` -- duplicates selected groups and objects and installs the duplicated selection.

## Dependencies (imports)
- `three/webgpu` -- group, mesh, object, and vector types.
- `../grouping/group` -- group creation and ungroup helpers.
- `../grouping/duplicate` -- duplication implementation.
- `../grouping/delete` -- deletion implementation.
- `../selection/select` -- selection types and average-origin helper.

## Used By (known callers)
- `renderer/controls/gizmo/gizmo.ts`

## Notes
Duplicate now hands off to an InstancedMesh-based clone path instead of batched writable pools.
