# scene-panel-state.ts

## Purpose
Holds the singleton scene-panel DOM references and mutable UI state shared across the scene-panel modules, including virtual-list containers, row caches, expansion, drag/drop, selection click suppression, and label-fitting caches.

## Exports

### Variables / Constants
- `ELLIPSIS: string` -- shared truncation marker used by the render module.
- `scenePanelState: ScenePanelState` -- central mutable state object for the scene panel cluster.

## Internal State
- Creates `.scene-virtual-spacer` and `.scene-virtual-content` children inside `#scene-object-list` at module load.
- Tracks virtual-list sizing via `rowHeight`, `rowOverscan`, `visibleRows`, and `renderedRowEls`.
- `lastClickedItem` stores row metadata rather than an HTMLElement.

## Dependencies (imports)
- `./scene-panel-types` -- state shape definition.

## Notes
- This module is intentionally side-effectful and acts as the shared state hub for the cluster.
- `scenePanelList` is resolved once from `#scene-object-list`.
