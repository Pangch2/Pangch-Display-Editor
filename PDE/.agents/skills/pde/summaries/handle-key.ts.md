# handle-key.ts

## Purpose
Installs keyboard shortcuts for the editor: focus camera, toggle vertex mode, switch transform modes, toggle space, duplicate, delete, select all, group/ungroup, reset pivots, and enter/exit pivot edit mode.

## Exports

### Types / Interfaces
- `HandleKeyParams` -- the full callback/state surface required by the keyboard handler.

### Functions / Methods
- `initHandleKey(p): void` -- registers global keydown/keyup/blur handlers.

## Dependencies (imports)
- `three/webgpu` -- core math and scene object types.
- `three/examples/jsm/controls/TransformControls.js` -- transform control type reference.
- `../pivot/custom-pivot-remove` -- pivot reset helper.
- `../pivot/shear-remove` -- shear removal helper.
- `./camera` -- focus camera action.
- `../gizmo/blockbench-scale` -- Blockbench scale toggle.

## Used By (known callers)
- `renderer/controls/gizmo/gizmo.ts`

## Notes
This file owns a lot of hotkey policy. It also has protective logic around `Alt`/`Ctrl` interactions so pivot-edit state does not get stuck on blur or focus loss.
