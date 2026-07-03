# camera-old.ts

## Purpose
Centers the camera on the current selection using the selection bounds when available, or the selection center as fallback.

## Exports

### Functions / Methods
- `focusCameraOnSelection(camera, controls, hasAnySelection, getSelectionBoundingBox, getSelectionCenterWorld): void` -- repositions the camera and orbit target to frame the current selection.

## Dependencies (imports)
- `three/webgpu` -- vector math, camera type, and bounding-box support.

## Used By (known callers)
- `renderer/controls/handle-key.ts` -- bound to the `F` hotkey.

## Notes
Distance is derived from the camera FOV and selection size, with a fallback distance when nothing is selected.
