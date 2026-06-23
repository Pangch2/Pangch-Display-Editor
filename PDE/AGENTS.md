# Overview

* Senior full-stack dev for Three.js (WebGPU) PDE tool.

# Core Technical Principles (Absolute Rules)

* Three.js r184+ mandatory.

# Project Structure and Context

`renderer/`

* `index.html`: main entry

* `renderer.ts`: main renderer, WebGPU init

* `asset-manager.js`: Minecraft asset (resource pack) management

* `entityMaterial.js`: model shader, material node management

* `load-project/upload-pbde.ts`: entry point, file open/merge/drop UI and load orchestration only
* `load-project/scene-parser.ts`: parses pbde data, normalizes scene graph, builds atlas metadata
* `load-project/mesh-builder.ts`: builds BatchedMesh/InstancedMesh/PlayerHead and applies scene data
* `load-project/pbde-assets.ts`: main-thread asset access, texture decode, cache helpers
* `load-project/pbde-types.ts`: shared pbde types for parser/builder/assets

* `controls/`: core interaction logic (feature separation)

  * `group.ts`: group structure management. Handle CRUD, pivot detect, tree traverse, clone, data ops.
  * `duplicate.ts`: duplicate selected objects/groups (Batch/Instanced support)
  * `gizmo.ts`: central controller for controls/. Integrate transform gizmo, selection, grouping, drag, controls.
  * `handle-key.ts`: shortcut, input handler. Key events separate from `gizmo.ts`.
  * `camera.ts`: camera focus, view control
  * `delete.ts`: delete selected groups/objects (Batched/Instanced)
  * `drag.ts`: drag, marquee selection
  * `custom-pivot.ts`: custom pivot, selection center calculation
  * `custom-pivot-remove.ts`: reset custom pivots
  * `blockbench-scale.ts`: Blockbench-style scale, pivot frame transform
  * `gizmo-setup.ts`: TransformControls init, negative-direction helper gizmo line patch
  * `overlay.ts`: render selection box, vertex points, guidelines
  * `select.ts`: selection state, raycast pick, hierarchical drill-down
  * `shear-remove.ts`: remove shear, normalize matrix
  * `vertex-rotate.ts`: vertex rotation, pivot-based transform
  * `vertex-scale.ts`: vertex scale, box transform (snap/rotate/scale integration)
  * `vertex-swap.ts`: swap vertex primary selection, queue multi-selection swap
  * `vertex-translate.ts`: vertex translate, pivot snap
  * `vertex-queue.ts`: vertex queue state. Implements `pushToVertexQueue` (insert, sync), `promoteVertexQueueBundleOnExit` (promote queue to multi-select on exit)

* `ui/main.css`: global styles

* `ui/scene-panel.ts`: outliner, scene UI

* `../hardcoded/`: resource data (no player_head)

# Response & Style Guide

* Variables/functions use camelCase, file names use kebab-case.
* Prioritize working code over explanation. Show only modified parts.
* Follow SoC in project structure.
