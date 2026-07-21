# vertex-swap.ts

## Purpose
Owns the queue-aware selection swap logic used by vertex snapping. It translates between selection items, queued bundles, and gizmo anchor and pivot state so swaps keep the right item active.

## Exports

### Types / Interfaces
- `SelectionSource` -- group or object instance used as a swap target or source.
- `QueueEntry` -- single queued item with local gizmo pivot data.
- `QueueBundle` -- bundled queue entry containing multiple items.
- `QueueItem` -- union of queue entry and bundle.
- `SwapContext` -- selection, gizmo, and queue dependencies required to perform a swap.
- `SwapOptions` -- flags for preserving selection and specifying an anchor world position.

### Functions / Methods
- `performSelectionSwap(src, targetSrc, context, options?): void` -- swaps selection and queue membership and updates pivot and anchor state.

## Internal State
Uses a shared temporary matrix and zero vector for source and world conversions.

## Dependencies (imports)
- `three/webgpu` -- matrix, vector, quaternion, mesh, and group types.
- `../selection/overlay` -- display type, bounds, and world-matrix helpers.
- `../grouping/group` -- group hierarchy and world-matrix helpers.
- `../gizmo/gizmo` -- gizmo state shape.

## Used By (known callers)
- `renderer/controls/vertex/vertex-translate.ts`
- `renderer/controls/vertex/vertex-rotate.ts`
- `renderer/controls/vertex/vertex-scale.ts`

## Notes
This module is the bridge between geometric snap actions and persistent selection state. It handles InstancedMesh-only object sources in controls. Group custom pivots are read as world positions and converted to group-local coordinates only for queue entries. Snap finalization preserves any valid transformed multi-selection anchor and only clears anchor state when no valid multi anchor remains. Queue restoration treats its stored primary-local anchor as authoritative and recomputes the world-space pivot offset from that restored position.
