# Load-Project Component Guide

Components in the `load-project/` folder parse `.bdengine` and `.pdengine` files and create entities such as `player_head`, `item_display`, and `block_display` in the 3D scene.

## File Roles and Responsibilities

- **`pbde-worker.ts`**: A Web Worker that parses large binary data and JSON structures without blocking the main thread.
- **`upload-pbde.ts`**: Creates Three.js objects from worker data, manages assets (textures, materials), and performs optimized rendering.

---

## `pbde-worker.ts` Detailed Structure

Performs compute-heavy tasks such as file parsing, model resolution, and geometry generation in the background.

### 1. Data Parsing and Tree Traversal
- **Decompression**: Uses `fflate` to decompress `.pbde` data and convert to JSON.
- **Scene Tree Traversal**: Recursively traverses the scene graph via `processNode` and accumulates world transforms (`worldTransform`).
- **Grouping**: On `isCollection`, generates a UUID and builds `GroupData` to preserve hierarchy.

### 2. Minecraft Model System
- **Model Resolution**: `resolveModelTree` follows the parent chain to produce final `elements` and texture references.
- **Blockstate Matching**: Matches `variants` and `multipart` conditions with block `props` to select models.
- **Hardcoded Logic**: For special models (Chest, Bed, Sign), prioritizes JSON in `hardcoded/`.

### 3. Geometry Generation
- **JSON to Buffer**: Converts cube-based `elements` into Three.js buffers (`positions`, `normals`, `uvs`).
- **Item Extrusion**: For 2D items (`builtin/generated`), analyzes opaque pixels and builds 1/16-block-thick border geometry (`buildBuiltinBorderBetweenPlanesGeometry`).
- **Tinting**: Applies tint colors via rules in `getTextureColor` (grass, leaves, redstone, etc.).

### 4. Dynamic Atlas Generation
- **Texture Packing**: Packs all used textures into a single atlas.
- **UV Remapping**: Recomputes UVs to atlas-relative coordinates.
- **Transparency Classification**: Splits atlas into opaque (`__ATLAS__`) and translucent (`__ATLAS_TRANSLUCENT__`) based on alpha analysis.

### 5. Main Thread Communication
- **Asset Request**: Sends `requestAsset` to fetch missing assets asynchronously.
- **Transferable Objects**: Sends large geometry buffers (`ArrayBuffer`) as Transferables to avoid copy overhead.

---

## `upload-pbde.ts` Detailed Structure

### 1. Asset and Resource Management
- **Asset Provider**: Supplies assets (JSON, PNG) via `mainThreadAssetProvider` over IPC.
- **Caching**:
  - Uses `blockTextureCache`, `blockMaterialCache` to avoid duplication.
  - Uses `currentLoadGen` to ignore stale async results when a new load starts.
- **Concurrency Control**: Limits concurrent decodes via `MAX_TEXTURE_DECODE_CONCURRENCY`.

### 2. Material and Transparency Handling
- **Transparency Analysis**: `analyzeTextureTransparency` inspects alpha:
  - `Opaque`
  - `Cutout` (alpha test, e.g., grass/flowers)
  - `Translucent` (e.g., glass/water)
- **Custom Material**: Uses `createEntityMaterial` from `entityMaterial.js` for Minecraft-style rendering (including tint).

### 3. Rendering Optimization
- **BatchedMesh (Atlas)**: Renders atlas-based blocks in a single draw call; separates opaque and translucent batches.
- **InstancedMesh**: Groups objects with identical geometry or non-atlas textures for performance.
- **Geometry Baking**: Bakes local transforms and vertex colors (tint) into geometry and merges (e.g., grass block).

### 4. Special Entity Handling (Player Head)
- **Skin Atlas**: Merges multiple skins into a 2048×2048 atlas.
- **Instanced UV Offset**: Uses `InstancedBufferAttribute` to offset UVs per instance.
- **2-Layer Rendering**: Builds base and outer (hat) layers; conditionally renders outer layer based on transparency.

### 5. Project Load Flow
- **`loadpbde`**: Clears scene (`_clearSceneAndCaches`) and loads a new file.
- **`mergepbde`**: Keeps the scene, adds new objects, and auto-selects them (`performSelection`).
- **Drag & Drop**: Detects extension and shows `drop-modal-overlay` to choose between open or merge.

### 6. Scene Data Structure
- Stores metadata in `loadedObjectGroup.userData` for gizmo/UI:
  - `objectNames`
  - `objectIsItemDisplay`
  - `groups`
  - `sceneOrder`