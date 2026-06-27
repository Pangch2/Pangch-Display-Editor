# gizmo-setup.ts

## Purpose
Creates the TransformControls instance and patches its gizmo geometry so the editor can render negative-direction helper lines.

## Exports

### Types / Interfaces
- `GizmoMaterial` -- material type extended with cached opacity state.
- `GizmoLineSet` -- original and negative line meshes for one axis.
- `GizmoLines` -- X/Y/Z axis line collections.
- `GizmoSetupResult` -- transform controls plus patched gizmo line sets.

### Functions / Methods
- `setupGizmo(camera, renderer, scene): GizmoSetupResult` -- initializes TransformControls, adds the helper to the scene, and clones axis lines for negative directions.

## Dependencies (imports)
- `three/examples/jsm/controls/TransformControls.js` -- transform gizmo implementation.
- `three/webgpu` -- camera, renderer, scene, mesh, and material types.

## Used By (known callers)
- `renderer/controls/gizmo.ts`

## Notes
The patch is best-effort and wrapped in a try/catch because it reaches into TransformControls internals.
