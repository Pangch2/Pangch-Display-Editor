# asset-manager.js

## Purpose
Initializes PDE's file-system asset cache through the Electron IPC bridge and exposes a helper for resolving cached asset files into browser-usable Blob URLs.

## Exports

### Functions / Methods
- `initAssets(): Promise<void>` -- starts asset cache preparation once, listens for IPC success/failure events, and returns the shared readiness promise.
- `getAssetUrl(assetPath): Promise<string>` -- waits for cache readiness, requests asset bytes from the main process, and returns a generated object URL.

### Variables / Constants
- `CACHE_NAME: string` -- legacy cache name constant; currently unused because file-system cache is always used.

## Internal State
- `assetsReadyPromise` stores the single initialization promise so repeated `initAssets()` calls share the same cache preparation flow.
- Registers and removes `window.ipcApi` listeners for `assets-downloaded` and `assets-download-failed`.

## Dependencies (imports)
- None.

## Used By (known callers)
- `renderer.ts` -- imports and awaits `initAssets()` during renderer startup before continuing scene setup.

## Notes
- `getAssetUrl()` must only be called after `initAssets()` has been called; otherwise it throws.
- Returned object URLs are not revoked by this module, so callers should manage URL lifetime if they create many asset URLs.
