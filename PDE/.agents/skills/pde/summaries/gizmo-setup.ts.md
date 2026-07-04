# gizmo-setup.ts

## Purpose
Creates the TransformControls instance and patches internal gizmo geometry so the editor can render negative-direction helper lines and mirrored translate/scale plane handles.

## Exports

### Types / Interfaces
- `GizmoMaterial` -- material type extended with cached opacity state.
- `GizmoLineSet` -- original and negative line meshes for one axis.
- `GizmoPlaneDirection` -- direction key for mirrored plane variants.
- `GizmoPlaneName` -- supported TransformControls plane names.
- `GizmoPlaneSet` -- direction-indexed mesh variants for one plane.
- `GizmoLines` -- X/Y/Z axis line collections.
- `GizmoPlanes` -- XY/YZ/XZ plane variant collections.
- `GizmoSetupResult` -- transform controls plus patched gizmo line and plane sets.

### Functions / Methods
- `setupGizmo(camera, renderer, scene): GizmoSetupResult` -- initializes TransformControls, adds the helper to the scene, and clones axis lines for negative directions.
- `createEmptyGizmoPlanes(): GizmoPlanes` -- creates empty plane variant collections.

## Dependencies (imports)
- `three/examples/jsm/controls/TransformControls.js` -- transform gizmo implementation.
- `three/webgpu` -- camera, renderer, scene, mesh, material, object, and matrix types.

## Used By (known callers)
- `renderer/controls/gizmo.ts`

## Notes
The patch is best-effort and wrapped in a try/catch because it reaches into TransformControls internals. Plane variants are created for visible gizmo planes and picker planes; visible variants start transparent until caller logic chooses which direction to show.
