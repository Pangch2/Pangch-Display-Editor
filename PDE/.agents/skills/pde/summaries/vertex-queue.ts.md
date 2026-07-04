# vertex-queue.ts

## Purpose
Owns the queue state used by vertex snapping. It snapshots the current selection into queue entries and bundles, keeping gizmo anchor and pivot state synchronized.

## Exports

### Constants
- `VERTEX_QUEUE_MAX_SIZE` -- maximum queue length.

### Functions / Methods
- `pushToVertexQueue(params): void` -- captures the current selection into the vertex queue.

## Dependencies (imports)
- `three/webgpu` -- matrix, vector, quaternion, mesh, and box types.
- `../selection/overlay` -- selection geometry and world-matrix helpers.
- `../selection/select` -- selection state.
- `./vertex-swap` -- queue item and bundle types.

## Used By (known callers)
- `renderer/controls/gizmo/gizmo.ts`

## Notes
The queue currently records InstancedMesh object entries only.
