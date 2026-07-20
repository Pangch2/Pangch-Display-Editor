# camera.ts

## Purpose
Centers either perspective or orthographic cameras on the current selection using the selection bounds when available, or the selection center as fallback.

## Exports

### Functions / Methods
- `focusCameraOnSelection(camera, controls, hasAnySelection, getSelectionBoundingBox, getSelectionCenterWorld): void` -- repositions the camera and orbit target to frame the current selection.

## Dependencies (imports)
- `three/webgpu` -- vector math, camera type, and bounding-box support.

## Used By (known callers)
- `renderer/controls/input/handle-key.ts` -- bound to the `F` hotkey.

## Notes
Perspective distance is derived from FOV and selection size; orthographic framing adjusts zoom while preserving distance.
