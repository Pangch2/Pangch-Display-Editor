# overlay.ts

## Purpose
Builds selection overlays, vertex markers, and the geometry math used by selection, gizmo, drag, and snapping logic. It now treats object instances as InstancedMesh-only in controls.

## Exports

### Types / Interfaces
- `SelectionState` -- selected groups and object-instance map.
- `QueueItemType` -- selection overlay queue item type.
- `QueueItem` -- queued selection or vertex item.

### Functions / Methods
- `setLoadedObjectGroup(group)` -- stores the active root group for overlay queries.
- `createOverlayLineMaterial(color)` -- creates line material for selection boxes.
- `createEdgesGeometryFromBox3(box)` -- builds a wireframe box geometry from a bounding box.
- `getInstanceCount(mesh)` -- returns instance count for InstancedMesh objects.
- `isInstanceValid(mesh, instanceId)` -- checks whether an instance is still valid.
- `getInstanceLocalBox(mesh, instanceId)` -- returns instance-local bounds.
- `getInstanceWorldMatrix(mesh, instanceId, outMatrix)` -- returns the instance world matrix.
- `updateSelectionOverlay(...)` -- rebuilds selection meshes, vertex sprites, and overlay boxes.

## Dependencies (imports)
- `three/webgpu` -- geometry, material, math, and scene types.
- `../grouping/group` -- group hierarchy and bounds helpers.

## Used By (known callers)
- Most control modules under `renderer/controls/`.

## Notes
The control layer no longer carries BatchedMesh-specific branches. Overlay helpers now assume InstancedMesh for selectable object instances.
