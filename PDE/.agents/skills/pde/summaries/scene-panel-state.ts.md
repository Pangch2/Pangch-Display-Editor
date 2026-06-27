# scene-panel-state.ts

## Purpose
Holds the singleton scene-panel DOM reference and all mutable UI state shared across the split scene-panel modules, including expansion, drag/drop, selection click suppression, and label-fitting caches.

## Exports

### Variables / Constants
- `ELLIPSIS: string` -- shared truncation marker used by the render module.
- `scenePanelState: ScenePanelState` -- central mutable state object for the scene panel cluster.

## Dependencies (imports)
- `./scene-panel-types` -- state shape definition.

## Notes
- `scenePanelState.scenePanelList` is resolved once from `#scene-object-list` and reused by every sibling module.
- This module is intentionally side-effectful and acts as the shared state hub for the cluster.

