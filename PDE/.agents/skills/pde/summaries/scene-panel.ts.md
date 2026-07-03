# scene-panel.ts

## Purpose
Temporarily disabled scene-panel entry point that preserves the existing `./ui/scene-panel` import/export surface without installing panel listeners or importing the scene-panel module cluster.

## Exports

### Functions / Methods
- `refreshScenePanel(): void` -- no-op placeholder while the scene panel is disabled.

## Used By (known callers)
- Existing callers may import `refreshScenePanel`, but `renderer.ts` currently does not side-effect import this module.

## Notes
- Scene panel bootstrapping is intentionally disabled until its selection/control dependency is replaced.
