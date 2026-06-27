# scene-panel-model.ts

## Purpose
Implements the scene-panel data lookup and mutation helpers that operate on `loadedObjectGroup.userData`. It resolves groups and objects in the current scene order, maps DOM drops to insertion points, and applies moves back into the scene model.

## Exports

### Functions / Methods
- `cleanLabel(rawName: string): string` -- strips technical prefixes and trailing bracketed suffixes from display labels.
- `resolveChildObjectUuid(child, ud): string | null` -- resolves a child entry to a concrete object UUID.
- `isObjectUuidGrouped(uuid, ud): boolean` -- checks whether a renderable object is already attached to a group.
- `hasRenderableObject(uuid, ud): boolean` -- checks whether the panel can render a UUID as an object row.
- `ensureSceneOrderSeeded(ud): SceneOrderEntry[]` -- initializes root ordering from the existing DOM when needed.
- `getParentGroupIdFromElement(el): string | null` -- walks the DOM to find the parent group for a row.
- `getObjectInstanceByUuid(uuid, ud)` -- resolves the mesh/instance pair for an object UUID.
- `getObjectGroupKeyByUuid(uuid, ud): string | null` -- returns the `mesh_uuid_instanceId` key used for group lookups.
- `findObjectChildIndexByUuid(children, objectUuid, ud): number` -- finds an object child in a group child array.
- `findGroupLocation(groupId, ud): SceneItemLocation | null` -- resolves where a group currently lives.
- `findObjectLocation(objectUuid, ud): SceneItemLocation | null` -- resolves where an object currently lives.
- `isGroupAncestorOf(groups, ancestorId, candidateGroupId): boolean` -- ancestor check used to prevent invalid reparenting.
- `resolveInsertionPointFromDropHint(hint, ud): SceneInsertionPoint | null` -- converts a visual drop hint to a concrete insertion target.
- `moveSceneItemsByDropHint(bundle, hint, ud): boolean` -- mutates scene order/group membership for a completed drag move.

## Dependencies (imports)
- `three/webgpu` -- `Object3D` typing for object lookups and selection state.
- `./scene-panel-state` -- seeded DOM access for root ordering and parent lookup.
- `./scene-panel-types` -- shared group, order, drop, and move contracts.

## Used By (known callers)
- `scene-panel-dnd.ts` -- validates drop hints and applies move mutations.
- `scene-panel-selection.ts` -- uses scene model state contracts for selection sync.
- `scene-panel-render.ts` -- uses lookup helpers while building rows and root order.
- `scene-panel.ts` -- bootstraps the cluster and listens for scene updates.

## Notes
- Mutators keep `loadedObjectGroup.userData.sceneOrder`, `groups`, and `objectToGroup` in sync.
- The helper set is deliberately conservative about invalid drops, especially when a group would become its own ancestor.

