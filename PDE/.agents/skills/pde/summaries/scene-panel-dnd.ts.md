# scene-panel-dnd.ts

## Purpose
Implements scene-panel drag/drop behavior, including bundle creation from the current selection, drag preview rendering, drop hint calculation, auto-expansion, and the move execution path that mutates scene ordering.

## Exports

### Functions / Methods
- `handleSceneItemDragStart(event, source, el): void` -- begins a scene-panel drag operation from a group or object row.
- `handleSceneItemDragEnd(): void` -- clears drag state and removes temporary drag/drop UI.
- `handleScenePanelDragOver(event): void` -- computes and applies live drop hints while dragging.
- `handleScenePanelDrop(event): void` -- commits a drag move and refreshes the scene panel.
- `handleScenePanelDragLeave(event): void` -- clears hover/drop state when the pointer leaves the panel.

## Dependencies (imports)
- `../controls/select` -- reads the current global selection to build drag bundles.
- `../load-project/upload-pbde` -- scene data source used to validate and move items.
- `./scene-panel-model` -- location, ancestry, and mutation helpers.
- `./scene-panel-render` -- schedules label fitting after auto-expanding a group.
- `./scene-panel-state` -- stores drag state, preview nodes, and drop markers.
- `./scene-panel-types` -- drag/drop and user-data contracts.

## Internal State
- Uses `scenePanelState.sceneDragBundle`, `sceneDropHint`, `sceneDropMarkerEl`, `sceneDragPreviewEl`, and related fields to coordinate live drag UI.

## Notes
- Drops into a selected group are blocked when they would create a cycle.
- The preview only renders a capped number of rows and appends a summary count for overflow.

