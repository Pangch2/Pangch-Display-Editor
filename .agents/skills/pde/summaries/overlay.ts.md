# overlay.ts

## Purpose
Builds selection overlays and vertex markers, updates drag-time bounds, and provides the geometry math used by selection, gizmo, drag, and snapping logic.

## Exports

### Types / Interfaces
- `SelectionState` -- selected groups and object-instance map.
- `QueueItemType` -- selection overlay queue item type.
- `QueueItem` -- queued selection or vertex item.

### Functions / Methods
- `setLoadedObjectGroup(group)` -- stores the active root group for overlay queries.
- `getInstanceCount(mesh)` -- returns instance count for InstancedMesh objects.
- `isInstanceValid(mesh, instanceId)` -- checks whether an instance is still valid.
- `getDisplayType(mesh, instanceId)` -- returns per-instance or mesh display type.
- `isItemDisplayHatEnabled(mesh, instanceId)` -- reports whether an item-display instance uses its hat transform.
- `getInstanceLocalBoxMin(mesh, instanceId, out)` -- writes the instance-local minimum corner.
- `getInstanceWorldMatrixForOrigin(mesh, instanceId, outMatrix)` -- builds the origin world matrix with local-matrix compensation.
- `calculateAvgOriginForChildren(children, out)` -- averages group-child origins in world space.
- `getGroupWorldMatrixWithFallback(groupId, out)` -- gets stored group transform or composes its fallback.
- `unionTransformedBox3(targetBox, localBox, matrix, tempBox)` -- unions transformed local bounds.
- `getInstanceLocalBox(mesh, instanceId)` -- returns instance-local bounds.
- `getInstanceWorldMatrix(mesh, instanceId, outMatrix)` -- returns the instance world matrix.
- `getGroupLocalBoundingBox(groupId)` -- calculates group bounds in group-local space.
- `getGroupOriginWorld(groupId, out)` -- resolves a group's world origin.
- `getRotationFromMatrix(matrix)` -- extracts an orthonormal rotation quaternion.
- `getSelectionBoundingBox(currentSelection)` -- calculates combined selection bounds.
- `prepareMultiSelectionDrag(currentSelection)` -- caches bounds data used during drag.
- `getSelectionPointsOverlay()` -- returns the active vertex-marker group.
- `updateSelectionOverlay(...)` -- rebuilds selection instances, vertex sprites, and overlay boxes.
- `updateMultiSelectionOverlayDuringDrag(...)` -- updates the cached multi-selection box transform during drag.
- `syncSelectionPointsOverlay(delta)` -- translates vertex markers with a selection.
- `syncSelectionOverlay(deltaMatrix)` -- updates vertex-marker transforms during a drag; selected outlines follow the shared GPU preview matrix.
- `commitSelectionOverlay(deltaMatrix)` -- commits the cumulative drag delta to selected outline instance matrices once at drag end.
- `findClosestVertexForSnapping(...)` -- finds the closest projected vertex within a pixel threshold.
- `getHoveredVertex(...)` -- hit-tests projected vertex sprites.
- `updateVertexHoverHighlight(...)` -- updates hover colors and the selected-to-hovered guide line.
- `findSpritesByKeys(keys)` -- maps requested vertex keys to sprites.
- `refreshSelectionPointColors(selectedVertexKeys)` -- reapplies selected vertex materials.

## Internal State
- Active overlay objects, loaded group root, drag-bound typed arrays, and the last hovered sprite are module state.
- Unit geometries and selection, vertex, axis, and multi-selection materials are shared for the module lifetime.

## Dependencies (imports)
- `three/webgpu` -- geometry, material, math, and scene types.
- `../grouping/group` -- group hierarchy and bounds helpers.
- `../../entityMaterial.js` -- shared drag mask name and TSL preview position graph.

## Used By (known callers)
- `renderer/controls/gizmo/gizmo.ts` -- owns overlay refresh and drag synchronization.
- Selection, pivot, vertex, grouping, input, project-load, and object-properties modules -- use exported bounds and instance helpers.

## Notes
- Selectable object instances use InstancedMesh paths.
- Selected outlines use the same shared TSL drag matrix as entity geometry, while queued overlay boxes are masked out.
- Selection overlay instance matrices use WebGPU storage attributes and are uploaded once at drag end instead of on every preview frame.
- Selection boxes use one InstancedMesh; vertex sprites and drag boxes reuse shared GPU resources instead of recreating materials or geometry.
- Replaced selection InstancedMeshes are disposed so large instance buffers do not remain allocated after deselection or deletion.
- Repeated hover events for the same sprite are ignored; selection refreshes clear the transient hover guide.
