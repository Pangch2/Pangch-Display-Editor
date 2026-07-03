# handle-key-old.ts

## Purpose
Legacy keyboard shortcut controller for gizmo interaction, transform mode/space toggles, pivot mode, vertex mode, custom pivot reset, grouping, selection, deletion, duplication, and camera focus.

## Exports

### Types / Interfaces
- `HandleKeyParams` -- callback-heavy contract exposing mutable gizmo, selection, pivot, drag, group, and overlay state to keyboard handlers.

### Functions / Methods
- `initHandleKey(p): void` -- registers keydown, keyup, blur, visibility, and focus handlers for editor shortcuts.

## Internal State
- Keeps local handler state for Ctrl+Alt logging, Alt/pivot edit mode recovery, and key dispatch while transform dragging is active.
- The `x` key toggles `currentSpace`, calls `TransformControls.setSpace`, then updates helper position and overlay so local-space rotation is recalculated immediately.

## Dependencies (imports)
- `three/webgpu` -- math and scene object types.
- `TransformControls` -- typed transform controls interface.
- legacy modules for custom pivot reset, shear removal, camera focus, and blockbench scale mode.
- legacy selection, group, and vertex queue types.

## Used By (known callers)
- `gizmo-old.ts` -- passes gizmo state callbacks into `initHandleKey`.

## Notes
- Shortcuts ignore text inputs.
- During active dragging, handled transform keys first release TransformControls and rebuild orbit controls before applying the shortcut.
