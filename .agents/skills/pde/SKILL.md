---
name: pde
description: >
  PDE (Pangch-Display-Editor) code-summary awareness skill.
  Enabled by default for every new session in this workspace. When active,
  it reads the stored code summary for any tracked PDE source file before
  performing work on it, generates a summary if none exists, and updates the
  summary after any modification. `/pde on` re-enables it immediately.
  `/pde off` disables it for the current session only.
triggers:
  - any request involving tracked PDE files
  - /pde on
  - /pde off
---

# PDE Skill

## Activation

- Skill is treated as active by default in every new session.
- `/pde on`  → explicitly activate if needed
- `/pde off` → deactivate for the current session only

Persists across sessions unless explicitly disabled in the current session.

If the session state is not available, assume the skill is active for this workspace.

---

## Tracked Files

Tracked files — any time one mentioned in request while skill active, follow **Workflow** below.

| File | Path (relative to workspace `renderer/`) |
|---|---|
| `index.html` | `index.html` |
| `renderer.ts` | `renderer.ts` |
| `asset-manager.js` | `asset-manager.js` |
| `entityMaterial.js` | `entityMaterial.js` |
| `upload-pbde.ts` | `load-project/upload-pbde.ts` |
| `scene-parser.ts` | `load-project/scene-parser.ts` |
| `mesh-builder.ts` | `load-project/mesh-builder.ts` |
| `pbde-assets.ts` | `load-project/pbde-assets.ts` |
| `pbde-types.ts` | `load-project/pbde-types.ts` |
| `group.ts` | `controls/grouping/group.ts` |
| `duplicate.ts` | `controls/grouping/duplicate.ts` |
| `gizmo.ts` | `controls/gizmo/gizmo.ts` |
| `handle-key.ts` | `controls/input/handle-key.ts` |
| `camera.ts` | `controls/input/camera.ts` |
| `delete.ts` | `controls/grouping/delete.ts` |
| `drag.ts` | `controls/selection/drag.ts` |
| `custom-pivot.ts` | `controls/pivot/custom-pivot.ts` |
| `custom-pivot-remove.ts` | `controls/pivot/custom-pivot-remove.ts` |
| `blockbench-scale.ts` | `controls/gizmo/blockbench-scale.ts` |
| `gizmo-setup.ts` | `controls/gizmo/gizmo-setup.ts` |
| `overlay.ts` | `controls/selection/overlay.ts` |
| `select.ts` | `controls/selection/select.ts` |
| `shear-remove.ts` | `controls/pivot/shear-remove.ts` |
| `vertex-rotate.ts` | `controls/vertex/vertex-rotate.ts` |
| `vertex-scale.ts` | `controls/vertex/vertex-scale.ts` |
| `vertex-swap.ts` | `controls/vertex/vertex-swap.ts` |
| `vertex-translate.ts` | `controls/vertex/vertex-translate.ts` |
| `vertex-queue.ts` | `controls/vertex/vertex-queue.ts` |
| `main.css` | `ui/main.css` |
| `scene-panel.ts` | `ui/scene-panel.ts` |
| `scene-panel-types.ts` | `ui/scene-panel-types.ts` |
| `scene-panel-state.ts` | `ui/scene-panel-state.ts` |
| `scene-panel-model.ts` | `ui/scene-panel-model.ts` |
| `scene-panel-selection.ts` | `ui/scene-panel-selection.ts` |
| `scene-panel-dnd.ts` | `ui/scene-panel-dnd.ts` |
| `scene-panel-render.ts` | `ui/scene-panel-render.ts` |

---

## Summary Storage

Summaries live at:

```
.agents/skills/pde/summaries/<filename>.md
```

Example: summary for `gizmo.ts` -> `summaries/gizmo.ts.md`

---

## Workflow

For **every tracked file** mentioned in request while skill active:

### Step 1 - Check for existing summary

Look for `summaries/<filename>.md`.

- **Exists** -> read fully before proceeding.
- **Does not exist** -> go to **Generate Summary** first, then proceed.

### Step 2 - Generate Summary (only when missing)

1. Read full source file from disk.
2. Write `summaries/<filename>.md` using **Summary Format** below.
3. Continue with requested task.

### Step 3 - Perform the requested task

Use summary as context. Shows what file does, what it exports, which files depend on it — avoid breaking callers.

### Step 4 - Update summary after any modification

If task modified file:
1. Re-read changed file.
2. Overwrite `summaries/<filename>.md` with updated summary.

---

## Summary Format

```markdown
# <filename>

## Purpose
One-paragraph description of what this file does and why it exists.

## Exports

### Types / Interfaces
- `TypeName` -- description

### Functions / Methods
- `fnName(params): ReturnType` -- description

### Variables / Constants
- `CONST_NAME: Type` -- description

## Internal State
Key module-level variables, closures, or side effects worth knowing.

## Dependencies (imports)
- `file-or-package` -- why it is imported

## Used By (known callers)
- `file` -- what it uses from this file

## Notes
Any gotchas, patterns, or invariants the agent should respect.
```

Omit empty sections. Entries concise — one line each unless critical detail requires more. Do **not** reproduce source code in summary; use references.
