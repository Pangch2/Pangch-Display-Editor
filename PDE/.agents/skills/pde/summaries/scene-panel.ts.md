# scene-panel.ts

## Purpose
Bootstraps the scene panel module cluster while preserving the existing `./ui/scene-panel` import path. Installs the resize/scroll/drag/drop/scene-update/selection listeners and re-exports `refreshScenePanel()`, while the actual render, selection, drag/drop, and scene-data logic now live in the sibling scene-panel modules.

## Exports

### Functions / Methods
- `refreshScenePanel(): void` -- Rebuilds entire scene tree from `loadedObjectGroup.userData`, then reapplies selection.

## Dependencies (imports)
- `./scene-panel-state` -- shared panel DOM/state singleton used by all scene-panel modules.
- `./scene-panel-dnd` -- drag/drop handlers for panel DOM events.
- `./scene-panel-render` -- render entrypoint and fit scheduler.
- `./scene-panel-selection` -- selection sync and click handling.
- `./scene-panel-types` -- shared local type for the selection-changed event payload.
- `../controls/select` -- fallback selection snapshot for the selection-changed listener.
- `../load-project/upload-pbde` -- source of `loadedObjectGroup.userData` scene data.

## Used By (known callers)
- `renderer.ts` -- imports this module for bootstrapping side effects.
- `window` event listeners -- `pde:scene-updated` triggers rerender; `pde:selection-changed` updates highlight state.

## Notes
- Shared mutable state was extracted to `scene-panel-state.ts`.
- Rendering helpers live in `scene-panel-render.ts`; model/lookups in `scene-panel-model.ts`; click/selection in `scene-panel-selection.ts`; drag/drop in `scene-panel-dnd.ts`.
- Behavior and DOM structure were kept unchanged.
