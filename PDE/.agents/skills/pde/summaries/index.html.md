# index.html

## Purpose
Defines the renderer document shell, loading overlay, main canvas container, temporarily disabled scene panel markup, FPS counter, stylesheet link, renderer entry script, and scene-panel resize layout script.

## Internal State
- `SCENE_PANEL_ENABLED` is currently `false`; the inline script hides `#scene-panel` and expands `#main-content` to the full window.
- Inline script reads `scene-panel-width` from `localStorage` only when the scene panel is enabled.
- Dispatches `resize` after layout changes so `renderer.ts` can resize the WebGPU canvas.

## Dependencies (imports)
- `./ui/main.css` -- renderer UI styling.
- `./renderer.ts` -- main renderer application module.

## Used By (known callers)
- Vite/Electron renderer entry -- loaded as the main HTML page for the PDE renderer.

## Notes
- `#main-content` right offset must match the scene panel width when the scene panel is enabled; with the panel disabled it is forced to `0px`.
