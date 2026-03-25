# Project Structure & Context

## `renderer/`
- **`index.html`**: Main entry point.
- **`renderer.js`**: Main scene renderer and WebGPU initialization.
- **`asset-manager.js`**: Minecraft asset management (resource packs, etc.).
- **`entityMaterial.js`**: Model shader and material node management.
- **`load-project/pbde-worker.ts`**: Parsing logic for `.bdengine` and `.pdengine` files (runs in a Worker).
- **`load-project/upload-pbde.ts`**: Receives parsed data and loads the scene.

## `ui/`
- **`main.css`**: Global stylesheet.
- **`scene-panel.js`**: Outliner and scene management UI.

## `../hardcoded/`
- Resource data (excluding `player_head`).
