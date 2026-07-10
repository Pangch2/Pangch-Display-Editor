# handle-key.ts

## Purpose
Installs keyboard shortcuts for the editor: focus camera, toggle vertex mode, switch transform modes, toggle space, duplicate, delete, select all, group/ungroup, reset pivots, and enter/exit pivot edit mode.

## Exports

### Types / Interfaces
- `HandleKeyState` -- mutable primitive keyboard/gizmo state surface shared with `gizmo.ts`.
- `HandleKeyParams` -- the callback/state surface required by the keyboard handler.

### Functions / Methods
- `initHandleKey(p): void` -- registers global keydown/keyup/blur handlers.

## Dependencies (imports)
- `three/webgpu` -- core math and scene object types.
- `../pivot/custom-pivot-remove` -- pivot reset helper.
- `../pivot/shear-remove` -- shear removal helper.
- `./camera` -- focus camera action.
- `../gizmo/blockbench-scale` -- Blockbench scale toggle.

## Used By (known callers)
- `renderer/controls/gizmo/gizmo.ts`

## Notes
Primitive state is read/written through `p.state`; object references and callbacks remain direct `HandleKeyParams` fields. Selection hotkeys assume InstancedMesh-only object handling in the control layer. Entering vertex mode and switching pivot modes preserve the current selection's tracked origin anchor.
