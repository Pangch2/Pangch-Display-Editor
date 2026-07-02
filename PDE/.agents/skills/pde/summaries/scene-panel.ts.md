# scene-panel.ts

## Purpose
Bootstraps the scene panel module cluster while preserving the existing `./ui/scene-panel` import path. It installs scroll, resize, drag/drop, scene-update, and selection listeners and re-exports `refreshScenePanel()`.

## Exports

### Functions / Methods
- `refreshScenePanel(): void` -- Rebuilds virtual row metadata from `loadedObjectGroup.userData`, renders the current viewport, and reapplies visible selection.

## Dependencies (imports)
- `./scene-panel-state` -- shared panel DOM/state singleton used by all scene-panel modules.
- `./scene-panel-dnd` -- drag/drop handlers for panel DOM events.
- `./scene-panel-render` -- refresh entrypoint, viewport scheduler, and fit scheduler.
- `./scene-panel-selection` -- selection sync listener.
- `./scene-panel-types` -- shared selection event payload type.
- `../controls/select` -- fallback selection snapshot for the selection-changed listener.

## Used By (known callers)
- `renderer.ts` -- imports this module for bootstrapping side effects.
- `window` event listeners -- `pde:scene-updated` triggers rerender; `pde:selection-changed` updates highlight state.

## Notes
- Scroll events schedule virtual viewport rendering instead of full tree rendering.
