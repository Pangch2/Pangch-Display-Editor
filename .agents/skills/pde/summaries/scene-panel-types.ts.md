# scene-panel-types.ts

## Purpose
Defines the local scene-panel data model shared across the refactored scene-panel modules. It keeps drag/drop, selection, lookup, mutation, and virtual-list helpers on the same type contracts without tying them to implementation code.

## Exports

### Types / Interfaces
- `GroupChild` -- child entry inside a group, either nested group or object reference.
- `GroupData` -- group transform/matrix, pivot, editable NBT metadata, and child list stored in `loadedObjectGroup.userData`.
- `SceneOrderEntry` -- root-level ordering entry for groups and objects.
- `SceneDragItemType` -- discriminates drag sources by `group` or `object`.
- `SceneDropMode` -- describes the drop target relation.
- `SceneDragSource` -- one drag source item.
- `SceneDragBundle` -- lead item plus deduped selection bundle for a drag operation.
- `SceneDropHint` -- resolved drop target metadata.
- `SceneItemLocation` -- resolved current location of a scene item.
- `SceneInsertionPoint` -- resolved insertion target for a move.
- `SceneMoveEntry` -- drag source paired with its current location.
- `ScenePanelSelectionState` -- canonical selection payload for the scene panel.
- `ScenePanelRow` -- flat virtual row metadata for a visible group/object row.
- `LoadedObjectUserData` -- scene metadata contract used throughout the panel.
- `ScenePanelState` -- module-level singleton state held by `scene-panel-state.ts`.

## Dependencies (imports)
- `three/webgpu` -- shared `Matrix4`, `Object3D`, `Quaternion`, and `Vector3` types used in the model.

## Notes
- This file is type-only plumbing; it should stay free of runtime logic.
