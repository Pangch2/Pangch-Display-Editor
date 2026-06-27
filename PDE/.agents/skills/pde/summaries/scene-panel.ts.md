# scene-panel.ts

## Purpose
Builds and keeps sync scene-object sidebar for loaded PBDE scene. Renders groups and objects, tracks selection state, supports expand/collapse, drag-drop reordering, auto-fit truncation for long labels, and emits/consumes `pde:scene-updated` and `pde:selection-changed` events.

## Exports

### Functions / Methods
- `refreshScenePanel(): void` -- Rebuilds entire scene tree from `loadedObjectGroup.userData`, then reapplies selection.

## Internal State
- `scenePanelList` -- DOM root for scene object list.
- `sceneExtraFitRaf` -- `requestAnimationFrame` throttle for text fitting.
- `extraTokenCache` -- caches tokenized extra-info strings for truncation.
- `lastClickedItem` -- anchor for range selection and selection sync.
- `expandedGroupIds` -- remembers expanded groups across rerenders.
- Drag/drop state: `sceneDragBundle`, `sceneDropHint`, `sceneDropMarkerEl`, `sceneDropMarkerClass`, `sceneDragPreviewEl`, `sceneAutoExpandTimer`, `sceneAutoExpandGroupId`, `suppressSceneItemClickUntil`.

## Dependencies (imports)
- `three/webgpu` -- `Object3D`, `Vector3`, `Quaternion`, and type references.
- `../load-project/upload-pbde` -- source of `loadedObjectGroup.userData` scene data.
- `../controls/select` -- current selection snapshot for sync.

## Used By (known callers)
- `window` event listeners -- `pde:scene-updated` triggers rerender; `pde:selection-changed` updates highlight state.

## Notes
- Renders root order from `sceneOrder` first, then any unrooted groups, then loose objects.
- Selection supports click, shift range select, ctrl/meta toggle, and keeps ancestors expanded for visible selection.
- Drag/drop moves both group tree nodes and object instances, while preventing invalid cycles and self-drops.
- Label fitting uses binary search on visible rows to fit name plus optional extra-info tokens.
