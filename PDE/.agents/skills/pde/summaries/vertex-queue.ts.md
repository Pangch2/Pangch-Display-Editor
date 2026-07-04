# vertex-queue.ts

## Purpose
Manages the vertex-mode selection queue. It captures the current selection as queue items with local gizmo pivots and promotes queued bundles back into selection on exit.

## Exports

### Variables / Constants
- `VERTEX_QUEUE_MAX_SIZE: number` -- maximum retained queue depth.

### Types / Interfaces
- `PushVertexQueueParams` -- state required to enqueue the current selection.
- `PromoteVertexQueueParams` -- state required to convert queued items back into selection.

### Functions / Methods
- `pushToVertexQueue(params): void` -- converts the current selection into queue entries, tracks vertex keys, and trims old queue items.
- `promoteVertexQueueBundleOnExit(params): boolean` -- restores a queued bundle into selection when leaving vertex mode.

## Internal State
Maintains the current queue and key caches externally via caller-owned arrays/sets; the module itself only holds geometry math helpers.

## Dependencies (imports)
- `three/webgpu` -- matrix, vector, box, and mesh types.
- `./overlay` -- world-matrix, bounds, and vertex helper access.
- `./group` -- group hierarchy helpers.

## Used By (known callers)
- `renderer/controls/gizmo.ts`
- `renderer/controls/handle-key.ts`

## Notes
Queue items preserve local gizmo position/quaternion so later swaps can reconstruct a consistent anchor world position.
