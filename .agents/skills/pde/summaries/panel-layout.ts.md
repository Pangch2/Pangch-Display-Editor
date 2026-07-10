# panel-layout.ts

- Manages Scene Objects and Project Details panel docking, ordering, horizontal/vertical resizing, persistence, and drag-and-drop.
- Caches panel and dock DOM elements so reparenting does not invalidate lookups.
- `renderLayout()` rebuilds both docks while retaining their resizers; `applyLayout()` updates viewport offsets and dispatches resize.
- Persists layout, dock widths, and shared-panel Scene Objects height in `localStorage`, including migration from older preferences.
- Panel headers use their full parent panel as the native drag image.
- Drops are accepted only within the left/right 5% viewport edges or over an existing panel; placement uses the target panel midpoint and corrects same-dock index shifts.
