# Controls Logic (`renderer/controls/`)

This directory contains the core manipulation logic. **Strictly adhere to file responsibilities.**

- **`gizmo.ts`**: **Central Controller**. Manages Transform Gizmos, selection state, grouping, and drag operations. Integrates other modules.
- **`group.ts`**: Group structure management. Handles CRUD, pivot calculation, tree traversal, and cloning of groups.
- **`duplicate.ts`**: Logic for duplicating selected objects/groups (supports Batch/InstancedMesh).
- **`handle-key.ts`**: Keyboard event handling and shortcuts. Separated from `gizmo.ts`.
- **`camera.ts`**: Camera focus and view control.
- **`delete.ts`**: Permanent deletion of selected groups/objects.
- **`drag.ts`**: Dragging and Marquee Selection logic.
- **`custom-pivot.ts`**: Calculation of custom pivot points and selection centers.
- **`custom-pivot-remove.ts`**: Resetting custom pivots.
- **`blockbench-scale.ts`**: Blockbench-style scaling and pivot frame transformations.
- **`gizmo-setup.ts`**: Initialization of `TransformControls` and patching for negative direction guide lines.
- **`overlay.ts`**: Visual feedback (Bounding Box, vertex points, guidelines).
- **`select.ts`**: Selection state management, raycasting, and hierarchy drill-down.
- **`shear-remove.ts`**: Removing shear deformation and normalizing matrices.
- **`vertex-rotate.ts`**: Vertex mode rotation and pivot transformation.
- **`vertex-scale.ts`**: Vertex mode scaling and box deformation (linked with Snap/Rotate).
- **`vertex-swap.ts`**: Swapping primary selection or swapping with the queue.
- **`vertex-translate.ts`**: Vertex position adjustment and pivot snapping.
- **`vertex-queue.ts`**: Vertex Queue management.
  - `pushToVertexQueue`: Add/cleanup items, sync keys.
  - `promoteVertexQueueBundleOnExit`: Promote queue bundle to multi-selection.
