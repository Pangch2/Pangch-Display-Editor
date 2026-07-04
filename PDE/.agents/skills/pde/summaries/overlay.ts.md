# overlay.ts

## Purpose
Builds and maintains selection overlays, vertex markers, and helper geometries for groups and object instances. It also exposes the geometry math used by selection, gizmo, drag, and snapping logic.

## Exports

### Types / Interfaces
- `SelectionState` -- selection groups and object-instance map.
- `QueueItemType` -- selection overlay queue item type.
- `QueueItem` -- queued selection/vertex item.

### Functions / Methods
- `setLoadedObjectGroup(group)` -- stores the active root group for overlay queries.
- `createOverlayLineMaterial(color)` -- creates line material for selection boxes.
- `createEdgesGeometryFromBox3(box)` -- builds a wireframe box geometry from a bounding box.
- `getInstanceCount(mesh)` -- returns instance count for instanced or batched meshes.
- `isInstanceValid(mesh, instanceId)` -- checks whether an instance is still valid.
- `disposeThreeObjectTree(root)` -- disposes geometry/materials in a subtree.
- `getDisplayType(mesh, instanceId)` -- resolves the effective display type.
- `isItemDisplayHatEnabled(mesh, instanceId)` -- checks the item-display hat flag.
- `getInstanceLocalBoxMin(mesh, instanceId, out?)` -- returns the local min corner of an instance box.
- `getInstanceWorldMatrixForOrigin(mesh, instanceId, outMatrix)` -- resolves world matrix with local-matrix corrections.
- `calculateAvgOriginForChildren(children, out?)` -- averages world-space origins for group children.
- `getGroupWorldMatrixWithFallback(groupId, out?)` -- resolves a group's world matrix or reconstructs it.
- `unionTransformedBox3(targetBox, localBox, matrix, tempBox?)` -- unions a transformed box into a target.
- `getInstanceLocalBox(mesh, instanceId)` -- returns instance-local bounds.
- `getInstanceWorldMatrix(mesh, instanceId, outMatrix)` -- returns the instance world matrix.
- `getGroupLocalBoundingBox(groupId)` -- returns a group's bounding box in group-local space.
- `getGroupOriginWorld(groupId, out?)` -- resolves the world origin used for group selection.
- `getRotationFromMatrix(matrix)` -- extracts a stable rotation quaternion from a matrix.
- `getSelectionBoundingBox(currentSelection)` -- unions current group/object selection bounds.
- `prepareMultiSelectionDrag(currentSelection)` -- caches selection geometry for drag-time overlay updates.
- `getSelectionPointsOverlay()` -- returns the current vertex marker overlay group.
- `updateSelectionOverlay(scene, renderer, camera, currentSelection, vertexQueue, isVertexMode, selectionHelper, selectedVertexKeys): void` -- rebuilds selection meshes, vertex sprites, and overlay boxes.
- `updateMultiSelectionOverlayDuringDrag(currentSelection, currentGizmoMat, initialGizmoMat): void` -- updates drag-time bounding boxes.
- `syncSelectionPointsOverlay(delta)` -- moves vertex points overlay by a delta.
- `syncSelectionOverlay(deltaMatrix)` -- reapplies transforms to selection overlays.
- `findClosestVertexForSnapping(gizmoWorldPos, camera, renderer, snapThreshold?)` -- finds nearest selectable vertex in screen space.
- `getHoveredVertex(mouseNDC, camera, renderer)` -- ray-style screen-distance hover test for vertex sprites.
- `updateVertexHoverHighlight(hoveredSprite, selectedVertexKeys)` -- updates vertex sprite colors and hover line.
- `findSpritesByKeys(keys)` -- looks up vertex sprites by selection keys.
- `refreshSelectionPointColors(selectedVertexKeys)` -- refreshes vertex sprite colors from selection state.

## Internal State
Caches group/root references and drag overlay geometry buffers for performance.

## Dependencies (imports)
- `three/webgpu` -- all geometry, material, and scene types.
- `../grouping/group` -- group hierarchy and bounds helpers.

## Used By (known callers)
- Nearly every control module: `select.ts`, `drag.ts`, `gizmo.ts`, `custom-pivot.ts`, `delete.ts`, `duplicate.ts`, `vertex-*`, and `handle-key.ts`.

## Notes
The overlay is rebuilt aggressively and disposes previous meshes/sprites each refresh. Callers should treat it as owned state, not a persistent scene node.
