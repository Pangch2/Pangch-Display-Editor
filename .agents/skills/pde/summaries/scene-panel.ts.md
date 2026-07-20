# scene-panel.ts

## Purpose
Bootstraps the scene panel module cluster while preserving the existing `./ui/scene-panel` import path. It installs scroll, resize, drag/drop, F2 rename, scene-update, and selection listeners, pauses updates while the dock is minimized, refreshes once when restored, and re-exports `refreshScenePanel()`.

## Exports

### Functions / Methods
- `refreshScenePanel(): void` -- Rebuilds virtual row metadata from `loadedObjectGroup.userData`, renders the current viewport, and reapplies visible selection.

## Dependencies (imports)
- `./scene-panel-state` -- shared panel DOM/state singleton used by all scene-panel modules.
- `./scene-panel-dnd` -- drag/drop handlers for panel DOM events.
- `./scene-panel-render` -- refresh entrypoint, viewport/fit schedulers, and temporary row rename input.
- `./scene-panel-selection` -- selection sync listener.
- `./scene-panel-types` -- shared selection event payload type.
- `../controls/selection/select` -- fallback selection snapshot for the selection-changed listener.

## Used By (known callers)
- `renderer.ts` -- imports this module for bootstrapping side effects.
- `window` event listeners -- `pde:scene-updated` triggers rerender, `pde:object-renamed` refreshes property-panel edits without interrupting an active scene rename, `pde:selection-changed` updates highlighting, and F2 starts renaming unless a form control is focused.

## Internal State
- `scenePanelVisible` tracks visibility across resize events so restoration triggers one full refresh.

## Notes
- Scroll events schedule virtual viewport rendering instead of full tree rendering.
- Selection and resize-driven updates are skipped while the panel is hidden; restoration refreshes current scene data and selection.
