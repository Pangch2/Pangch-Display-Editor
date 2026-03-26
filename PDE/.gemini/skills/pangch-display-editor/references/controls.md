# Controls Component Guide

Each file in the `controls/` folder is responsible for a specific manipulation logic.

## File Roles and Responsibilities

- **`group.ts`**: Group structure management utility. Handles group CRUD, pivot detection, tree traversal, cloning, and all group data operations.
- **`duplicate.ts`**: Duplication logic for selected objects and groups (supports batchedmesh/instancedmesh).
- **`gizmo.ts`**: Central controller of `controls/`. Integrates transform gizmo management and control logic such as Select, Group, and Drag.
- **`handle-key.ts`**: Handles keyboard input and key bindings. Manages keyboard event handlers separated from `gizmo.ts`.
- **`camera.ts`**: Camera focus and view control logic.
- **`delete.ts`**: Permanent deletion logic for selected groups and objects (batchedmesh/instancedmesh).
- **`drag.ts`**: Handles drag operations and marquee selection logic.
- **`custom-pivot.ts`**: Custom pivot calculation and center point calculation for selections.
- **`custom-pivot-remove.ts`**: Resets custom pivot for selected targets.
- **`blockbench-scale.ts`**: Blockbench-style scale calculation and pivot frame transformation logic.
- **`gizmo-setup.ts`**: Initializes TransformControls and patches negative direction helper gizmo lines.
- **`overlay.ts`**: Renders selection highlights (bounding box), vertex points, and guidelines.
- **`select.ts`**: Manages selection state, raycasting picking, and hierarchical drill-down selection logic.
- **`shear-remove.ts`**: Removes shear transformations and normalizes matrices for selected targets.
- **`vertex-rotate.ts`**: Handles rotation and pivot-based transformation in vertex mode.
- **`vertex-scale.ts`**: Handles scaling and box deformation in vertex mode (integrated with Snap/Rotate/Scale).
- **`vertex-swap.ts`**: Handles swapping the primary selection or swapping targets with the vertex queue.
- **`vertex-translate.ts`**: Handles position adjustment and pivot snapping in vertex mode.
- **`vertex-queue.ts`**: Manages vertex queue state. Implements `pushToVertexQueue` (add/clean queue items, sync keys) and `promoteVertexQueueBundleOnExit` (promote queue bundle to multi-selection).