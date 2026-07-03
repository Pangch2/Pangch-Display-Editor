# gizmo.ts

## Purpose
Transitional gizmo entry point for the editor control layer. It gives `renderer.ts` a stable import path while the real orchestration logic still lives in `controls-old/gizmo-old.ts`.

## Exports

### Types / Interfaces
- `OrbitControlsLike` -- minimal orbit-control contract used by the editor.
- `GizmoState` -- shared pivot and anchor state shape exposed by the gizmo layer.
- `InitGizmoParams` -- inputs required to initialize the gizmo system.
- `InitGizmoResult` -- public handles returned by `initGizmo`.

### Functions / Methods
- `initGizmo(params): InitGizmoResult` -- re-exported old gizmo initializer.

## Dependencies (imports)
- `../controls-old/gizmo-old` -- current implementation behind the new entry point.

## Used By (known callers)
- `renderer/renderer.ts`

## Notes
This file is a migration shim, not the final refactored implementation.
