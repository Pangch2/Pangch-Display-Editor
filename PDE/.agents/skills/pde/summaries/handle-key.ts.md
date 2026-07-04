# handle-key.ts

## Purpose
Installs keyboard shortcuts for the editor: focus camera, toggle vertex mode, switch transform modes, toggle space, duplicate, delete, select all, group/ungroup, reset pivots, and enter/exit pivot edit mode.

## Exports

### Types / Interfaces
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
Selection hotkeys now assume InstancedMesh-only object handling in the control layer.
