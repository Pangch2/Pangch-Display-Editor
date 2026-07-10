# main.css

## Purpose
Defines renderer UI styling, including independent left/right panel docks, adjustable shared-section divider, scene tree, virtual-list rows, drag/drop visual states, loading overlay, FPS counter, and shared project buttons.

## Internal State
- CSS only; no runtime state.

## Used By (known callers)
- `index.html` -- loads the stylesheet for the renderer UI.
- `scene-panel-render.ts` -- emits virtual row DOM classes styled here for scene rows, groups, extra labels, selection, and drag/drop markers.

## Notes
- Scene panel rows have fixed 28 px height for virtualization.
- `.scene-virtual-spacer` preserves scroll height while `.scene-virtual-content` holds absolutely positioned rendered rows.
- Selection colors differ for item displays, block displays, and groups.
- Empty docks are hidden; a single window fills its dock, while two windows use the Scene Objects basis and Project Details fills the remainder.
- Scene Objects and Project Details headers share one single-line, ellipsis-overflow style.
- Scene Objects and Project Details use the same 6 px scrollbar styling.
- Each dock has a visible 7 x 48 px resize handle centered completely outside its edge, keeping panel scrollbars unobstructed; a shared dock shows its 12 px section divider.
- Project Details inputs keep their neutral border on hover, fill their column, and remain single-line.
