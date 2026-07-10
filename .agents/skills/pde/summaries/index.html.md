# index.html

## Purpose
Defines the renderer shell: loading overlay, canvas, independent left/right panel docks containing Scene Objects and editable Project Details sections, FPS counter, and renderer module entrypoint.

## Dependencies
- `./ui/main.css` -- renderer UI styling.
- `./renderer.ts` -- application entrypoint that initializes panel layout behavior.

## Notes
- Contains separate left and right dock shells, each with its own outer width resizer and shared inner divider slot.
- Scene Objects and Project Details can occupy the same dock or separate docks; behavior is implemented in `ui/panel-layout.ts`.
- Contains no inline JavaScript.
- Project name, project NBT, and full NBT use single-line text inputs.
