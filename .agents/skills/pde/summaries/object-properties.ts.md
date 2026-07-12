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
- Player-head texture always renders as an editable input; edits accept a URL or Base64 texture JSON and rebuild the display object with the extracted skin URL.
- Brightness always renders sky and block `0`-`15` selects together in one row and rebuilds the display object after changes.
- `propertySelect()` keeps provided option order when the current value is already in that list, so item-display options stay fixed.
- `renderSelection()` is the main entrypoint driven by selection-related window events.
- The module mutates loaded object userData/maps in place when properties change.
