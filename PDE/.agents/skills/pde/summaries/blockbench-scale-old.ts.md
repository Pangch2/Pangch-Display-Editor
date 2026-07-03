# blockbench-scale-old.ts

## Purpose
Implements Blockbench-style scale behavior: toggles the mode, computes the pivot frame, detects active axes from camera/mouse direction, and calculates the selection shift needed to keep the scaling anchor stable.

## Exports

### Variables / Constants
- `blockbenchScaleMode: boolean` -- global toggle for Blockbench scale mode.
- `_BB_PIVOT_FRAME_MAT3: Matrix3` -- cached pivot-frame normal matrix for local-space transforms.

### Functions / Methods
- `toggleBlockbenchScaleMode(): boolean` -- flips the mode and logs the new state.
- `computeBlockbenchPivotFrame(selectionHelper, currentSpace)` -- caches world/pivot matrices for the current drag frame.
- `getBlockbenchPivotFrameMatrices()` -- returns the cached frame matrices.
- `transformBoxToPivotFrame(worldMatrix, tempMat4?)` -- converts a world matrix into pivot-frame space.
- `detectBlockbenchScaleAxes(camera, mouseInput, selectionHelper, currentSpace, defaultDetectedKeys)` -- infers which axes should be active.
- `computeBlockbenchScaleShift(selectionHelper, dragInitialScale, dragInitialPosition, dragInitialBoundingBox, dragAnchorDirections, currentSpace)` -- computes the translation compensation for scaled selections.

## Internal State
Cached `Matrix4`/`Matrix3` instances are reused to avoid allocations during drag.

## Dependencies (imports)
- `three/webgpu` -- matrix/vector math and scene object types.

## Used By (known callers)
- `renderer/controls/gizmo.ts` -- uses the mode and pivot-frame helpers during transform handling.
- `renderer/controls/handle-key.ts` -- toggles the mode from keyboard input.

## Notes
World-space and local-space are handled differently when resolving the pivot frame. The module is stateful and intentionally reuses mutable cached matrices.
