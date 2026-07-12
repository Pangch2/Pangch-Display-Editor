# main.css

## Purpose
Defines renderer UI styling, including independent left/right panel docks, project and selected-object property forms, project tab navigation/dropdown, panel drag/drop previews, adjustable divider, scene tree, loading overlay, and FPS counter.

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
- Object properties use compact XYZ rows, 18 px Blockbench scale direction arrows attached to scale inputs, a 4x4 matrix grid, single-line NBT inputs, dark native number spinners, and full-width native metadata selects below NBT; offscreen sections use CSS content visibility with an intrinsic height estimate to avoid unnecessary layout and paint work.
- The "개체 속성" metadata heading uses the same h3 styling except for a 10 px top margin, which separates it from the preceding NBT input.
- Disabled matrix inputs force muted Chromium text/background styling and a blocked cursor.
- The Project Details header places project navigation directly after its fixed title and lets it fill the remaining panel width; long names truncate and the dropdown stays inside that area, with each project row reserving a 30 px Lucide delete button beside its tab.
- Project tab rows draw a 2 px sky-blue line above or below the target row while reordering, matching Scene object before/after drop feedback.
