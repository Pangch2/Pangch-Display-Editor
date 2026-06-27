# select.ts

## Purpose
Implements the selection state machine: caches selected items, resolves click hits to groups or object instances, and coordinates selection replacement and deselection callbacks.

## Exports

### Types / Interfaces
- `PrimarySelection` -- currently focused group or object instance.
- `SelectionState` -- selected groups, objects, and primary item.
- `SelectionCallbacks` -- hooks used when selection changes.
- `SelectedItem` -- normalized object-instance selection entry.

### Variables / Constants
- `currentSelection: SelectionState` -- shared live selection state.

### Functions / Methods
- `invalidateSelectionCaches(): void` -- clears selected-item cache.
- `getSelectedItems(): SelectedItem[]` -- expands selected groups into concrete object-instance items.
- `setLoadedObjectGroup(group): void` -- sets the group root used for selection expansion.
- `calculateAvgOrigin(): Vector3` -- computes the average world origin of the current selected items.
- `pickInstanceByOverlayBox(raycaster, rootGroup)` -- tests instance AABBs against a ray and returns the closest hit.
- `getSingleSelectedGroupId(): string | null` -- returns the only selected group, if that is the whole selection.
- `getSingleSelectedMeshEntry(): { mesh, instanceId } | null` -- returns the only selected object instance, if present.
- `hasAnySelection(): boolean` -- true when any group or object is selected.
- `clearSelectionState(callbacks?): void` -- clears selection and optionally flushes vertex queue state.
- `beginSelectionReplace(callbacks, options?): void` -- shared prelude for replacing selection.
- `resetSelectionAndDeselect(callbacks): void` -- clears selection and updates UI.
- `setPrimaryToFirstAvailable(): void` -- chooses a primary selection from the current set.
- `replaceSelectionWithObjectsMap(meshToIds, callbacks, options?): void` -- replaces selection with object instances only.
- `replaceSelectionWithGroupsAndObjects(groupIds, meshToIds, callbacks, options?): void` -- replaces selection with groups and objects.
- `selectAllObjectsVisibleInScene(loadedObjectGroup): Map<...>` -- collects all visible instance ids by mesh.
- `isMultiSelection(): boolean` -- true when more than one group/object instance is selected.
- `commitSelectionChange(callbacks): void` -- finalizes selection changes and refreshes UI.
- `handleSelectionClick(raycaster, event, loadedObjectGroup, callbacks): void` -- processes click selection, including group-chain behavior and shift/meta modifiers.

## Dependencies (imports)
- `three/webgpu` -- mesh, group, vector, matrix, and raycaster types.
- `./group` -- group hierarchy and object-to-group lookup.
- `./overlay` -- bounds, instance validity, and origin math.

## Used By (known callers)
- `renderer/controls/drag.ts`
- `renderer/controls/gizmo.ts`

## Notes
Selection can represent groups, concrete object instances, or both. Callers should use the replacement helpers rather than mutating `currentSelection` directly unless they are already inside the selection state machine.
