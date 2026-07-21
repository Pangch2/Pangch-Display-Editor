# flip.ts

## Purpose
Reflects display objects and group transforms across an X, Y, or Z plane, including mirrored block states, player-head textures, and custom pivots.

## Exports
- `FlipAxis` -- supported reflection axis.
- `reflectGroups(...)` -- reflects selected group hierarchies while retaining decomposable positive scale values and mirrored world pivots.
- `flipObjectUuids(...)` -- previews object reflection synchronously, then replaces mirrored block/player-head assets asynchronously.

## Dependencies
- `three/webgpu` -- transform math and display meshes.
- `./selection/drag` -- applies group reflection deltas.
- `./selection/overlay` -- display bounds and type helpers.
- load-project helpers -- block-state replacement and player-head texture mirroring.
- `./mirroring` -- repairs mirror UUID pairs after replacement.

## Notes
Display and group matrices use world and local reflections together so their transforms keep positive scale values. Object pivots convert through the previous and reflected frames; group world pivots follow the world reflection delta.
