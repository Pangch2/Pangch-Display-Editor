# pbde-assets.ts

## Purpose
Main-thread `PbdeAssetProvider` for PBDE load flow. Pulls assets through `window.ipcApi`, splits hardcoded vs normal paths, and returns PNG data as bytes while decoding text/JSON as strings.

## Exports

### Variables / Constants
- `mainThreadAssetProvider` -- singleton asset provider passed into `parsePbdeProject`

### Functions / Methods
- `isNodeBufferLike(content)` -- type guard for IPC-serialized Node `Buffer`
- `toUint8Array(input)` -- copy any `ArrayBuffer`/view into plain `Uint8Array`
- `getBlockPropertyOptions(name, current): Promise<Record<string, string[]>>` -- returns naturally sorted compatible variant values and discovers multipart properties, including both boolean values.

## Internal State
No mutable module state.

## Dependencies (imports)
- `./pbde-types` -- `AssetPayload` type

## Used By (known callers)
- `mesh-builder.ts` -- decodes IPC asset payloads and supplies provider to parser
- `ui/object-properties.ts` -- populates block property dropdowns with blockstate-backed choices

## Notes
- `hardcoded/` routes to `getHardcodedContent`; all else routes to `getAssetContent`.
- PNG path check is case-insensitive; non-PNG content becomes text.
- Properties omitted from the object because they use a default value are discovered from multipart blockstates such as fences.
- Property choices use stable natural ordering instead of placing the current value first.
