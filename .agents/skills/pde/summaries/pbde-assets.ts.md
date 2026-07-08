# pbde-assets.ts

## Purpose
Main-thread `PbdeAssetProvider` for PBDE load flow. Pulls assets through `window.ipcApi`, splits hardcoded vs normal paths, and returns PNG data as bytes while decoding text/JSON as strings.

## Exports

### Variables / Constants
- `mainThreadAssetProvider` -- singleton asset provider passed into `parsePbdeProject`

### Functions / Methods
- `isNodeBufferLike(content)` -- type guard for IPC-serialized Node `Buffer`
- `toUint8Array(input)` -- copy any `ArrayBuffer`/view into plain `Uint8Array`

## Internal State
No mutable module state.

## Dependencies (imports)
- `./pbde-types` -- `AssetPayload` type

## Used By (known callers)
- `mesh-builder.ts` -- decodes IPC asset payloads and supplies provider to parser

## Notes
- `hardcoded/` routes to `getHardcodedContent`; all else routes to `getAssetContent`.
- PNG path check is case-insensitive; non-PNG content becomes text.
