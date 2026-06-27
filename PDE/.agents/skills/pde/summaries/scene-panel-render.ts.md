# scene-panel-render.ts

## Purpose
Renders the scene panel tree from `loadedObjectGroup.userData`, including group recursion, object rows, root ordering, and text fitting for names and extra metadata. It also re-applies selection after refresh and exposes the fit scheduler used by resize and scroll events.

## Exports

### Functions / Methods
- `scheduleSceneExtraFit(): void` -- schedules a deferred pass that fits labels and extra info into visible rows.
- `refreshScenePanel(): void` -- rebuilds the full panel DOM and reapplies current selection.

## Dependencies (imports)
- `../controls/select` -- provides the current selection snapshot for highlight sync.
- `../load-project/upload-pbde` -- source scene data used to build the tree.
- `./scene-panel-dnd` -- drag handlers for rendered rows.
- `./scene-panel-model` -- label cleanup, object visibility, and child resolution helpers.
- `./scene-panel-selection` -- click handling and selection sync.
- `./scene-panel-state` -- shared DOM/state singleton, ellipsis token, and caches.
- `./scene-panel-types` -- scene selection and user-data contracts.

## Internal State
- `scenePanelState.sceneExtraFitRaf` gates the requestAnimationFrame fit pass.
- `scenePanelState.extraTokenCache` caches split extra-info tokens for incremental truncation.

## Notes
- Root rendering respects `sceneOrder` first, then falls back to groups and object names to preserve legacy behavior.
- The fitting pass only inspects rows near the viewport to keep resize/scroll updates cheap.

