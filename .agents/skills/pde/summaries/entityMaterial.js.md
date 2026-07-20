# entityMaterial.js

## Purpose
Builds the shared node-based material used for entity-style rendering. It combines a diffuse texture, cached tint/light TSL nodes, toggleable two-direction shading, sky-light darkening, and optional instanced UV offset or atlas UV transform attributes into a `MeshBasicNodeMaterial`.

## Exports

### Functions / Methods
- `createEntityMaterial(diffuseTex, tintHex = 0xffffff, useInstancedUv = false, useInstancedUvTransform = false, instancedUvTransformCount = 1, instancedUvTransformIndex = 0)` -- returns `{ material, blockLightLevel, skyLightLevel }` for entity rendering and `0..15` light-level control; only sky light currently affects color.
- `toggleShading()` -- toggles the shared TSL shading uniform for all entity materials and returns whether shading is enabled.

### Variables / Constants
- `dragSelectedAttributeName: string` -- shared geometry attribute name used by the GPU drag mask.
- `dragDeltaMatrix: Matrix4` -- shared world-space uniform value mutated during gizmo drags.
- `dragPreviewPositionNode` -- shared masked TSL position graph used by entity and selection-overlay materials.

## Internal State
- Creates `uniform` nodes with block `0` and sky `15`; sky light is normalized and converted with the lightmap brightness curve, while block light is reserved for later use.
- Caches converted tint `vec3` nodes by normalized hex color to avoid rebuilding constant TSL nodes for repeated materials.
- Reuses module-level TSL nodes for static directional lighting.
- Keeps a shared shading uniform, enabled by default, that blends every entity material between unlit texture/tint color and its lit result.
- Reuses one module-level position graph that applies the shared world-space drag delta only when the current instance's `dragSelected` value is set; the delta uses Three.js's shared `renderGroup` instead of per-object uniform buffers.
- Switches UV lookup to one requested `instancedUvTransform` or `instancedUvTransformN` vec4 scale/offset attribute, otherwise to `instancedUvOffset` when `useInstancedUv` is true.

## Dependencies (imports)
- `three/webgpu` -- `MeshBasicNodeMaterial` base material and shared drag `Matrix4` value.
- `three/tsl` -- node graph helpers for UVs, attributes, texture sampling, math, and lighting composition.

## Used By (known callers)
- `renderer/load-project/mesh-builder.ts` -- creates materials for loaded PBDE geometry, atlas-based meshes, and instanced atlas UV transform batches.
- `renderer/controls/grouping/duplicate.ts` -- clones entity materials during duplication flows.
- `renderer/controls/selection/overlay.ts` -- reuses the same GPU drag position graph for selected outlines.

## Notes
- `positionNode` converts the common world-space drag delta into each mesh's local space after Three.js applies its instance matrix.
- `useInstancedUvTransform` expects geometry to provide `instancedUvTransform` for single-transform meshes or the indexed `instancedUvTransformN` selected for that material in multi-part meshes.
- Lighting is intentionally lightweight and non-physical, tuned for game-like entity rendering.
- Texture sampling and per-material light uniforms remain per material; static tint/light graph parts are shared.
