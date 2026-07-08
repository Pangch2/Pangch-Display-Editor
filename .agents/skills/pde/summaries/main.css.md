# main.css

## Purpose
Defines renderer UI styling, including the canvas layout, right-side scene panel tree, virtual-list rows, drag/drop visual states, loading overlay, FPS counter, and shared project buttons.

## Internal State
- CSS only; no runtime state.

## Used By (known callers)
- `index.html` -- loads the stylesheet for the renderer UI.
- `scene-panel-render.ts` -- emits virtual row DOM classes styled here for scene rows, groups, extra labels, selection, and drag/drop markers.

## Notes
- Scene panel rows have fixed 28 px height for virtualization.
- `.scene-virtual-spacer` preserves scroll height while `.scene-virtual-content` holds absolutely positioned rendered rows.
- Selection colors differ for item displays, block displays, and groups.
