# scene-panel-selection.ts

## Purpose
Handles scene-panel click behavior and selection highlighting. It translates DOM clicks into the PDE selection API, keeps the visual selection state in sync with the shared scene selection payload, and expands ancestor groups for visible highlights.

## Exports

### Functions / Methods
- `handleSceneItemClick(e, el): void` -- processes single, toggle, and range click selection behavior for scene rows.
- `syncScenePanelSelection(sel): void` -- applies the current selection state to the scene panel DOM.

## Dependencies (imports)
- `three/webgpu` -- `Object3D` typing for range and toggle selection collections.
- `../controls/select` -- source of the current global selection snapshot and selection mutators.
- `./scene-panel-state` -- tracks last clicked item, expansion state, and click suppression.
- `./scene-panel-types` -- scene-panel selection and user-data contracts.

## Used By (known callers)
- `scene-panel-render.ts` -- re-applies selection after rebuilding the tree.
- `scene-panel.ts` -- updates highlight state on `pde:selection-changed`.

## Notes
- Range selection uses the visible row order, not the full scene order.
- Selection sync expands ancestor groups so selected children stay visible.

