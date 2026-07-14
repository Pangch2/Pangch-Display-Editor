# object-properties.ts

## Purpose
Renders and updates the project details / object properties side panel for the selected groups and instanced objects, including transform controls, pivot editing, matrix editing, NBT, and block/item display metadata.

## Internal State
- Caches DOM handles for the details panel sections.
- Reuses shared Three.js temp objects for matrix/transform math.
- Tracks current selection order, visible hydrated sections, and current pivot context across selection updates.
- Persists the global object-metadata row order in `localStorage`.

## Notes
- Object metadata for block properties is loaded asynchronously and the section is lazily hydrated via `IntersectionObserver`.
- Metadata rows are draggable; their saved order applies to every object section.
- Player-head texture always renders as an editable input; edits accept a URL or Base64 texture JSON and update the instance's atlas slot without rebuilding the display object.
- Player-head pivot fields use the head origin (including the hat offset) instead of the generic item-display bounds center.
- Brightness always renders sky and block `0`-`15` selects together in one row and rebuilds the display object after changes.
- The matrix editor toggle swaps between 4×4 grid and one-line input, persists the choice in `localStorage`, and uses `▶`/`▲` glyphs for the expand/collapse button.
- `propertySelect()` keeps provided option order when the current value is already in that list, so item-display options stay fixed.
- `renderSelection()` is the main entrypoint driven by selection-related window events.
- The module mutates loaded object userData/maps in place when properties change.
