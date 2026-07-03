# handle-key.ts

## Purpose
Registers global keyboard and click shortcuts for editor controls, including TransformControls mode/space switching, pivot mode toggling through a caller callback, and logging placeholders for selection, grouping, deletion, duplication, pivot, shear, and scale actions.

## Exports

### Types / Interfaces
- `HandleKeyParams` -- provides access to the active `TransformControls` instance, optional transform-change and pivot-toggle callbacks, and allows extra future parameters.

### Functions / Methods
- `initHandleKey(p): void` -- installs window-level keydown, keyup, and click listeners for editor shortcuts while ignoring editable targets.
- `isAltTabShortcut(event, isAltPressed?): boolean` -- returns true for Alt+Tab, including when Alt was pressed before Tab, so editor shortcuts and custom pivot mode can ignore the OS/app switch shortcut.

## Internal State
- Tracks `ctrlAltLogged` inside `initHandleKey()` to avoid repeating the custom-pivot reset log while Ctrl+Alt remains held.
- Tracks `altPressed` inside `initHandleKey()` so Alt-first then Tab is treated as Alt+Tab even if the Tab event modifier state is unreliable.
- `shortcutLogs` centralizes the Korean console messages for shortcut placeholders.

## Dependencies (imports)
- `three/examples/jsm/controls/TransformControls.js` -- type-only dependency for the active transform controls.

## Used By (known callers)
- `renderer/controls/gizmo.ts` -- passes the active `TransformControls` instance so shortcuts can switch gizmo modes.

## Notes
- `t`, `r`, and `s` call `TransformControls.setMode()` for translate, rotate, and scale.
- `t`, `r`, `s`, and `x` call optional `onTransformControlsChanged()` after changing mode/space so callers can refresh the attached gizmo anchor.
- `x` toggles `TransformControls` space between `world` and `local`, then logs the current space.
- `z` calls optional `togglePivotMode()` and logs the current pivot mode; if no callback is provided it falls back to the placeholder log.
- Alt alone and Alt+T no longer create/log a custom pivot; `gizmo.ts` handles custom pivot creation through Alt + gizmo drag.
- Alt+Tab is ignored by editor shortcut handling, including Alt-first then Tab, and is exposed as a helper for custom pivot cancellation.
- Editable `input`, `textarea`, and contenteditable targets are ignored so typing into UI does not trigger shortcuts.
