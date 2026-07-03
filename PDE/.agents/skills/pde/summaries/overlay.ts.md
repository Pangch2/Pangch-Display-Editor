# overlay.ts

## Purpose
Holds lightweight selection state helpers and selected-object overlay rendering for the current controls layer. It computes selection bounds for normal meshes and instanced/batched-style objects, draws an oriented edge overlay that follows the selected object's real world transform, and exposes the selected box center for gizmo placement.

## Exports

### Types / Interfaces
- `SelectionState` -- selected groups, selected object instance ids, and primary object selection.

### Functions / Methods
- `createSelectionState(): SelectionState` -- creates an empty selection state.
- `clearSelectionState(selection): void` -- clears group/object selections and primary selection.
- `setObjectSelection(selection, mesh, instanceId): void` -- replaces selection with one object instance.
- `replaceSelectionWithObjectsMap(selection, meshToIds): void` -- replaces object selection from a mesh-to-instance-id map.
- `resolveSelectionBox(mesh, instanceId, target): boolean` -- computes a world-space box for a mesh or instance.
- `createSelectionOverlay(scene)` -- returns overlay helpers for clearing/updating a reusable instanced edge overlay and reading its center.

## Internal State
- Reuses module-level `Matrix4`, `Box3`, and `Vector3` temporaries for selection frame and overlay edge calculation.
- `createSelectionOverlay` creates one hidden `InstancedMesh` with 12 box-edge instances and reuses it across selection updates.

## Dependencies (imports)
- `three/webgpu` -- box, box geometry, instanced mesh, material, matrix, object, scene, and vector classes.

## Used By (known callers)
- `gizmo.ts` -- delegates selection state mutation, selection box display, and selected center lookup.

## Notes
- Instanced or batched-like objects are supported through `getMatrixAt(index, matrix)` when present.
- The visible overlay is oriented by the selected object's world matrix, while the exported `box` remains the world-space AABB used for center queries.
