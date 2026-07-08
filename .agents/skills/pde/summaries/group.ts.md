# group.ts

## Purpose
Owns the editor custom group tree model, including group creation, cloning, ungrouping, hierarchy traversal, pivot handling, and scene-order bookkeeping.

## Exports

### Types / Interfaces
- `GroupChildObject` -- object instance entry stored under a group.
- `GroupChildGroup` -- nested group reference stored under a group.
- `GroupChild` -- union of group child node types.
- `GroupData` -- full group record stored in `loadedObjectGroup.userData.groups`.
- `SceneOrderEntry` -- root-level ordering entry for groups and objects.
- `CloneJobEntry` -- clone job produced while duplicating group contents.
- `CollectCloneContext` -- callback context for clone planning.
- `CloneGroupContext` -- cached group-name set and per-prefix next-name counters reused across group subtree cloning.

### Variables / Constants
- `DEFAULT_GROUP_PIVOT: Vector3` -- default pivot used when a group has no custom pivot.

### Functions / Methods
- `normalizePivotToVector3(pivot, out?)` -- converts supported pivot formats into a Vector3.
- `shouldUseGroupPivot(group)` -- determines whether a group pivot should affect gizmo placement.
- `getGroups(loadedObjectGroup)` -- lazy-initializes and returns the group map.
- `getObjectToGroup(loadedObjectGroup)` -- lazy-initializes and returns the object-to-group map.
- `getGroupKey(mesh, instanceId)` -- stable key for object-instance membership.
- `getGroupChain(loadedObjectGroup, startGroupId)` -- returns ancestor chain for a group.
- `getAllGroupChildren(loadedObjectGroup, groupId)` -- returns all descendant object children.
- `getGroupWorldMatrix(group, out?)` -- returns the group world matrix or recomposes it from transform fields.
- `updateGroupReferenceForMovedInstance(...)` -- updates group/object metadata after InstancedMesh swap-pop.
- `createGroupStructure(...)` -- inserts a new group and moves selected items under it.
- `ungroupGroupStructure(...)` -- removes a group while preserving its children.
- `createCloneGroupContext(loadedObjectGroup)` -- snapshots existing group names and initializes duplicate-name counters.
- `cloneGroupStructure(...)` -- recursively clones a group subtree, optionally reusing `CloneGroupContext`.
- `collectCloneJobsFromGroup(...)` -- walks a group subtree and emits object clone jobs.

## Dependencies (imports)
- `three/webgpu` -- mesh, matrix, group, vector, and UUID helpers.

## Used By (known callers)
- Most control modules, especially `select.ts`, `overlay.ts`, `duplicate.ts`, `delete.ts`, `drag.ts`, `custom-pivot.ts`, `gizmo.ts`, and `vertex-*` files.

## Notes
This module is the canonical access point for group metadata. Callers should use its accessors rather than mutating `loadedObjectGroup.userData` directly. Duplicate callers should share one `CloneGroupContext` across related `cloneGroupStructure` calls to avoid rescanning all group names and retrying duplicate name prefixes from low numbers per cloned group.
