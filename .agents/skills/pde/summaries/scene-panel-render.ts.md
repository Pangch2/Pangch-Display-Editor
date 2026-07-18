# scene-panel-render.ts

## Purpose
Renders the scene panel as a virtualized flat tree from `loadedObjectGroup.userData`. It rebuilds visible row metadata on scene updates, only creates DOM rows around the current viewport, preserves selection highlighting, and keeps the extra-label fitting pass scoped to rendered rows.

## Exports

### Functions / Methods
- `scheduleSceneExtraFit(): void` -- schedules a deferred pass that fits rendered row labels and extra metadata.
- `renderVisibleSceneRows(): void` -- reconciles the viewport row DOM against `scenePanelState.visibleRows`.
- `scheduleScenePanelRender(): void` -- RAF-coalesces scroll/resize viewport rendering.
- `refreshScenePanel(): void` -- rebuilds flat row metadata, updates spacer height, renders the current viewport, syncs selection, and logs timings.

## Internal State
- Uses `scenePanelState.visibleRows` as the canonical rendered tree order.
- Uses `scenePanelState.renderedRowEls` to track mounted virtual rows by visible index; group row keys include expansion state so toggles and styling are recreated when it changes.
- Uses `scenePanelState.scenePanelSpacerEl` and `scenePanelContentEl` to maintain scroll height while rendering only visible rows.
- `scenePanelState.sceneExtraFitRaf` and `scenePanelRenderRaf` gate deferred work.

## Dependencies (imports)
- `../controls/selection/select` -- provides the current selection snapshot for highlight sync.
- `../load-project/pbde-log` -- gates optional scene-panel timing logs via localStorage flags.
- `../load-project/upload-pbde` -- source scene data used to build row metadata.
- `./scene-panel-dnd` -- drag handlers for rendered rows.
- `./scene-panel-model` -- label cleanup, object visibility, grouping, and child resolution helpers.
- `./scene-panel-selection` -- click handling and selection sync.
- `./scene-panel-state` -- shared DOM/state singleton and virtual-list caches.
- `./scene-panel-types` -- row, selection, and user-data contracts.

## Used By (known callers)
- `scene-panel.ts` -- refreshes on scene updates and schedules viewport renders on scroll/resize.
- `scene-panel-dnd.ts` -- imports `scheduleSceneExtraFit()` for drag auto-expand updates.

## Notes
- Root rendering respects `sceneOrder` first, then falls back to groups and object names.
- Group expand/collapse rebuilds the flat row list and spacer height, not the full scene DOM.
- Expanded group rows receive the `expanded` class for their visual state.
- Optional `Scene panel timings` and slow `Scene panel viewport render` logs are disabled by default and can be enabled through `localStorage` using the human-readable log name.
