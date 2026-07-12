# select.ts

## Purpose
Implements the selection state machine: caches selected items, resolves click hits to groups or instanced objects, and coordinates selection replacement and deselection callbacks.

## Exports

### Types / Interfaces
- `PrimarySelection` -- currently focused group or object instance.
- `SelectionState` -- selected groups, objects, and primary item.
- `SelectionCallbacks` -- hooks used when selection changes.
- `SelectedItem` -- normalized object-instance selection entry.

### Variables / Constants
- `currentSelection: SelectionState` -- shared live selection state.

### Functions / Methods
- `getSelectedItems(): SelectedItem[]` -- expands selected groups into concrete object-instance items.
- `pickInstanceByOverlayBox(raycaster, rootGroup)` -- raycasts rendered instanced geometry, with a world-box fallback for zero-scale instances, and returns the closest valid hit.
- `replaceSelectionWithObjectsMap(...)` -- replaces selection with object instances only.
- `replaceSelectionWithGroupsAndObjects(...)` -- replaces selection with groups and objects.
- `selectAllObjectsVisibleInScene(loadedObjectGroup)` -- collects all visible instanced object ids by mesh.

## Dependencies (imports)
- `three/webgpu` -- mesh, group, vector, matrix, and raycaster types.
- `../grouping/group` -- group hierarchy and object-to-group lookup.
- `./overlay` -- bounds, instance validity, and origin math.

## Used By (known callers)
- `renderer/controls/selection/drag.ts`
- `renderer/controls/gizmo/gizmo.ts`

## Notes
Selection now only considers InstancedMesh objects in the control layer. The replacement helpers remain the normal way to mutate selection state. Shift-click additions preserve the first selected primary anchor.
