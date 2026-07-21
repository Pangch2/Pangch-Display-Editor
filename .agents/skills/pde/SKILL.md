---
name: pde
description: >
  PDE (Pangch-Display-Editor) CodeGraph awareness skill.
  Enabled by default for every new session in this workspace. When active,
  it uses the repository CodeGraph before reading or changing tracked PDE files.
  `/pde on` re-enables it immediately.
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

## Workflow

For **every tracked file** mentioned in request while skill active:

1. Run `codegraph explore` with the relevant file names, symbols, and question before grep/find or direct file reads.
2. Use the returned current source and call paths to understand dependencies and blast radius.
3. Perform the requested task and use CodeGraph again when verification needs updated call-path context.
