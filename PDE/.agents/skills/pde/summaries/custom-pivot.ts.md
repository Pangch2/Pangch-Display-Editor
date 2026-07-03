# custom-pivot.ts

## Purpose
Owns custom pivot behavior for the controls layer. It tracks Alt-driven pivot edit state, temporarily switches TransformControls to translate while Alt is held, restores the previous gizmo mode on Alt release, stores custom pivots from Alt-drag, and resolves stored custom pivot positions back to world space.

## Exports

### Types / Interfaces
- `MatrixInstanceObject` -- structural type for objects exposing `getMatrixAt`/`setMatrixAt` instance transforms.
- `CustomPivotState` -- Alt/pivot-drag state plus the previous transform mode to restore.

### Functions / Methods
- `createCustomPivotState(): CustomPivotState` -- creates default custom pivot state.
- `setAltPressed(state, isPressed): void` -- updates Alt pressed state from pointer events.
- `handleCustomPivotKeyDown(state, event, hasSelection, transformControls): void` -- records the previous mode and switches to translate when Alt is pressed with a selection.
- `handleCustomPivotKeyUp(state, event, transformControls): void` -- clears Alt state and restores the previous mode.
- `cancelCustomPivotMode(state, transformControls): void` -- clears Alt/pivot-drag state and restores the previous transform mode.
- `beginCustomPivotDrag(state): boolean` -- marks drag as pivot editing if Alt is currently pressed.
- `endCustomPivotDrag(state, selectedObjects, pivotWorld): boolean` -- commits the pivot world position to selected objects when ending an Alt drag.
- `restorePreviousTransformMode(state, transformControls): void` -- restores the pre-Alt transform mode if one is stored.
- `getCustomPivotWorld(mesh, instanceId, target): boolean` -- resolves stored per-instance or per-object custom pivot data to world coordinates.

## Internal State
- Reuses module-level `Matrix4` temporaries for inverse, instance, and world matrix calculations.

## Dependencies (imports)
- `three/webgpu` -- matrix, object, and vector primitives.
- `three/examples/jsm/controls/TransformControls.js` -- type-only dependency for transform mode control.
- `./handle-key` -- reuses Alt+Tab detection, including Alt-first then Tab, so OS/app switching cancels temporary pivot mode instead of starting a pivot edit.

## Used By (known callers)
- `renderer/controls/gizmo.ts` -- delegates Alt pivot edit state and pivot storage/lookup.

## Notes
- Custom pivots are stored in `mesh.userData.customPivots` for instance-like objects and `mesh.userData.customPivot` for normal objects.
- Alt release restores the previous transform mode immediately, even if the pointer drag is still active.
- Alt+Tab clears custom pivot Alt state, cancels pivot drag state, and restores the previous transform mode even when Alt was pressed before Tab.
