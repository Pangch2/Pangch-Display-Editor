# scene-panel-dnd.ts

## Purpose
Implements scene-panel drag/drop behavior for rendered virtual rows, including bundle creation from current selection, drag preview rendering, drop hint calculation, auto-expansion, and move execution.

## Exports

### Functions / Methods
- `handleSceneItemDragStart(event, source, el): void` -- begins a scene-panel drag operation from a rendered group or object row.
- `handleSceneItemDragEnd(): void` -- clears drag state and temporary drag/drop UI.
- `handleScenePanelDragOver(event): void` -- computes and applies live drop hints while dragging.
- `handleScenePanelDrop(event): void` -- commits a drag move and refreshes the scene panel.
- `handleScenePanelDragLeave(event): void` -- clears hover/drop state when the pointer leaves the panel.

## Internal State
- Uses `scenePanelState.sceneDragBundle`, `sceneDropHint`, `sceneDropMarkerEl`, `sceneDragPreviewEl`, and auto-expand fields.
- Uses a local empty `currentSelection` placeholder while the scene panel is disabled and the old controls selection module is removed.

## Dependencies (imports)
- `../load-project/upload-pbde` -- scene data source used to validate and move items.
- `./scene-panel-model` -- location, parent lookup, ancestry, and mutation helpers.
- `./scene-panel-render` -- schedules label fitting after drag auto-expansion.
- `./scene-panel-state` -- stores drag state, preview nodes, and drop markers.
- `./scene-panel-types` -- drag/drop and user-data contracts.

## Notes
- Auto-expand adds the group id to expansion state and dispatches `pde:scene-updated` so virtual rows rebuild.
- Drop parent resolution comes from row metadata exposed as `data-parent-group-id`.
