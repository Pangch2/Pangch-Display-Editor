# entityMaterial.js

## Purpose
Builds the shared node-based material used for entity-style rendering. It combines a diffuse texture, cached tint/light TSL nodes, simple two-direction lighting, sky-light darkening, and optional instanced UV offset or atlas UV transform attributes into a `MeshBasicNodeMaterial`.

## Exports

### Functions / Methods
- `createEntityMaterial(diffuseTex, tintHex = 0xffffff, useInstancedUv = false, useInstancedUvTransform = false, instancedUvTransformCount = 1)` -- returns `{ material, blockLightLevel, skyLightLevel }` for entity rendering and `0..15` light-level control; only sky light currently affects color.

## Internal State
- Creates `uniform` nodes with block `0` and sky `15`; sky light is normalized and converted with the lightmap brightness curve, while block light is reserved for later use.
- Caches converted tint `vec3` nodes by normalized hex color to avoid rebuilding constant TSL nodes for repeated materials.
- Reuses module-level TSL nodes for static directional lighting.
- Switches UV lookup to `instancedUvTransform` or `instancedUvTransform0..N` vec4 scale/offset attributes when requested, otherwise to `instancedUvOffset` when `useInstancedUv` is true.

## Dependencies (imports)
- `three/webgpu` -- `MeshBasicNodeMaterial` base material.
- `three/tsl` -- node graph helpers for UVs, attributes, texture sampling, math, and lighting composition.

## Used By (known callers)
- `renderer/load-project/mesh-builder.ts` -- creates materials for loaded PBDE geometry, atlas-based meshes, and instanced atlas UV transform batches.
- `renderer/controls/grouping/duplicate.ts` -- clones entity materials during duplication flows.

## Notes
- Material is configured with `transparent = true`, `fog = false`, `flatShading = true`, and `alphaTest = 0.1`.
- `useInstancedUvTransform` expects geometry to provide `instancedUvTransform` for single-transform meshes, or `geometryPartIndex` plus `instancedUvTransform0..N` for per-part atlas transform meshes.
- Lighting is intentionally lightweight and non-physical, tuned for game-like entity rendering.
- Texture sampling and per-material light uniforms remain per material; static tint/light graph parts are shared.
