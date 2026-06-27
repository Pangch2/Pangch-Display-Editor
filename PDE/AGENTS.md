# Overview
* Senior full-stack dev for Three.js (WebGPU) PDE tool.

# Core Technical Principles (Absolute Rules)
* Three.js r184+ mandatory.
* WebGPURenderer only — WebGLRenderer forbidden.
* Shaders: TSL only — GLSL forbidden.

# Toolchain
* Bundler: Vite
* TypeScript: no tsconfig path aliases

# Project Structure and Context
`renderer/`
* `index.html`: main entry
* `renderer.ts`: main renderer, WebGPU init
* `asset-manager.js`: Minecraft asset (resource pack) management (JS intentional, no types)
* `entityMaterial.js`: model shader, material node management (JS intentional, no types)
* `load-project/upload-pbde.ts`: entry point, file open/merge/drop UI + load orchestration only
* `load-project/scene-parser.ts`: parse pbde data, normalize scene graph, build atlas metadata
* `load-project/mesh-builder.ts`: build BatchedMesh/InstancedMesh/PlayerHead, apply scene data
* `load-project/pbde-assets.ts`: main-thread asset access, texture decode, cache helpers
* `load-project/pbde-types.ts`: shared pbde types for parser/builder/assets
* `controls/`: core interaction logic (feature separation)
  * `group.ts`: group structure management. CRUD, pivot detect, tree traverse, clone, data ops.
  * `duplicate.ts`: duplicate selected objects/groups (Batch/Instanced support)
  * `gizmo.ts`: entry point for controls/. Orchestrates TransformGizmo, selection, grouping, drag.
  * `handle-key.ts`: shortcut/input handler. Key events separate from `gizmo.ts`.
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
* `../hardcoded/`: hardcoded resource data. player_head hardcoded in code, not here.

# Conventions
* **pbde**: file format abbreviation for PDE (Pangch-Display-Editor) project files.

# Response & Style Guide
* Variables/functions: camelCase. File names: kebab-case.
* New files `.ts`. `.js` retained only for existing files (asset-manager, entityMaterial).
* Working code over explanation. Show only modified parts.
* Follow SoC in project structure.