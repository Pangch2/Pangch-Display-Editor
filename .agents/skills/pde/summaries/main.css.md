# main.css

## Purpose
Defines renderer UI styling, including independent left/right panel docks, project tab navigation/dropdown, opaque panel drag previews, sky-blue panel drop-position previews, adjustable shared-section divider, scene tree, virtual-list rows, drag/drop visual states, loading overlay, FPS counter, and shared project buttons.

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
- Global `:focus` and `:focus-visible` outlines are removed, so native keyboard focus rings are suppressed across the UI.
- Panel drag previews are fixed, opaque copies that follow the pointer above the editor UI.
- Valid panel drop positions use a sky-blue highlighted region; its shared edge is drawn by the layout script.
- The FPS counter has an opaque black background and stays above dragged panels.
- Scene Objects and Project Details use the same 6 px scrollbar styling.
- Each dock has a visible 7 x 48 px resize handle centered completely outside its edge, keeping panel scrollbars unobstructed; a shared dock shows its 12 px section divider.
- Project Details inputs keep their neutral border on hover, fill their column, and remain single-line.
- The Project Details header places project navigation directly after its fixed title and lets it fill the remaining panel width; long names truncate and the dropdown stays inside that area, with each project row reserving a 30 px Lucide delete button beside its tab.
- Project tab rows draw a 2 px sky-blue line above or below the target row while reordering, matching Scene object before/after drop feedback.
