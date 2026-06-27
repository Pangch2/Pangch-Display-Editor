# entityMaterial.js

## Purpose
Builds the shared node-based material used for entity-style rendering. It combines a diffuse texture, optional tint, simple two-direction lighting, and optional instanced UV offsets into a `MeshBasicNodeMaterial`.

## Exports

### Functions / Methods
- `createEntityMaterial(diffuseTex, tintHex = 0xffffff, useInstancedUv = false)` -- returns `{ material, blockLightLevel, skyLightLevel }` for entity rendering and light-level control.

## Internal State
- Creates `uniform` nodes for block and sky light so callers can adjust brightness through node values.
- Converts the hex tint from sRGB to linear before multiplying it into the sampled texture.
- Switches UV lookup to `instancedUvOffset` when `useInstancedUv` is true.

## Dependencies (imports)
- `three/webgpu` -- `MeshBasicNodeMaterial` base material.
- `three/tsl` -- node graph helpers for UVs, attributes, texture sampling, math, and lighting composition.

## Used By (known callers)
- `renderer/load-project/mesh-builder.ts` -- creates materials for loaded PBDE geometry and atlas-based meshes.
- `renderer/controls/duplicate.ts` -- clones entity materials during duplication flows.

## Notes
- Material is configured with `transparent = true`, `fog = false`, `flatShading = true`, and `alphaTest = 0.1`.
- Lighting is intentionally lightweight and non-physical, tuned for game-like entity rendering.
