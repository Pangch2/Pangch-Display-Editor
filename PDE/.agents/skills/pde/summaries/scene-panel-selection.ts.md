# scene-panel-selection.ts

## Purpose
Handles scene-panel click behavior and selection highlighting. It translates rendered virtual-row clicks into the PDE selection API, expands ancestor groups for selected hidden children, keeps visible selection classes in sync, and uses flat row metadata for range selection anchors.

## Exports

### Functions / Methods
- `handleSceneItemClick(e, el): void` -- processes single, toggle, and ctrl+shift range selection for rendered scene rows.
- `syncScenePanelSelection(sel): void` -- expands needed ancestors, refreshes virtual rows when expansion changed, applies current selection classes to mounted rows, and updates the primary row anchor when visible.

## Internal State
- Reads and writes `scenePanelState.lastClickedItem` as `ScenePanelRow | null`.
- Range selection uses `scenePanelState.visibleRows` indices instead of DOM order.
- Selection sync may add group ids to `expandedGroupIds` and schedule `pde:scene-updated` on the next animation frame.

## Dependencies (imports)
- `three/webgpu` -- `Object3D` typing for range and toggle selection collections.
- `../load-project/upload-pbde` -- source of loaded scene metadata and selection mutators.
- `./scene-panel-state` -- tracks last clicked row, visible rows, and click suppression.
- `./scene-panel-types` -- scene-panel row, selection, and user-data contracts.

## Used By (known callers)
- `scene-panel-render.ts` -- row click handlers and selection re-application after viewport rendering.
- `scene-panel.ts` -- updates highlight state on `pde:selection-changed`.

## Notes
- Object selection expands the containing group and its parents; group selection expands only parent groups.
- Selection sync only decorates currently mounted virtual rows; offscreen selected rows are highlighted when rendered.
