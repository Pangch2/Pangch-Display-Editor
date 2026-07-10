# index.html

## Purpose
Defines the renderer shell: loading overlay, canvas, resizable right-side panel split between Scene Objects and editable project details, FPS counter, and renderer module entrypoint.

## Internal State
- Inline script restores and persists the Scene panel width and keeps the canvas layout aligned with it.

## Dependencies
- `./ui/main.css` -- renderer UI styling.
- `./renderer.ts` -- application entrypoint.

## Notes
- Scene panel width is constrained to 160–600 px and stored in `localStorage`.
- Scene Objects occupies 30% of the panel height and project details remains visible in the other 70%.
- Project name, project NBT, and full NBT use single-line text inputs.
