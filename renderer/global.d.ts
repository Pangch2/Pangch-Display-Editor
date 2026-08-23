declare interface AssetContentResult {
  success: boolean;
  content: unknown;
  error?: string;
}

declare interface HardcodedContentResult {
  success: boolean;
  content: unknown;
  error?: string;
}

declare interface LoadingIconResult {
  success: boolean;
  dataUrl?: string;
  error?: string;
}

declare type PainterAssetKind = 'brush' | 'palette';

declare interface MinecraftSkinResult {
  success: boolean;
  png?: Uint8Array;
  username?: string;
  model?: 'classic' | 'slim';
  usedFallback?: boolean;
  error?: string;
}

declare interface IpcApi {
  getAssetContent(path: string): Promise<AssetContentResult>;
  saveIconAtlas(name: 'block-atlas.png' | 'item-atlas.png', data: Uint8Array): Promise<{ success: boolean; error?: string }>;
  hasSpriteAtlas(name: string): Promise<{ success: boolean; exists: boolean; error?: string }>;
  saveSpriteAtlas(name: string, data: Uint8Array, manifest: unknown): Promise<{ success: boolean; error?: string }>;
  listSpriteAtlases(): Promise<{ success: boolean; atlases: string[]; error?: string }>;
  listAssetFiles(path: string): Promise<{ success: boolean; files: string[]; error?: string }>;
  getHardcodedContent(path: string): Promise<HardcodedContentResult>;
  getLoadingIcon?: () => Promise<LoadingIconResult>;
  getPdeMemoryUsage(): Promise<number>;
  resetPdeData(scope: 'cache' | 'assets'): Promise<{ success: boolean; error?: string }>;
forceGarbageCollection(): Promise<{ success: boolean; error?: string }>;
listKeyMappingPresets(): Promise<{ success: boolean; presets: string[]; error?: string }>;
reorderKeyMappingPresets(names: string[]): Promise<{ success: boolean; error?: string }>;
loadKeyMappingPreset(name: string): Promise<{ success: boolean; mapping?: Record<string, string[]>; error?: string }>;
saveKeyMappingPreset(name: string, mapping: Record<string, string[]>): Promise<{ success: boolean; error?: string }>;
deleteKeyMappingPreset(name: string): Promise<{ success: boolean; error?: string }>;
  listPainterAssets(kind: PainterAssetKind): Promise<{ success: boolean; items: string[]; error?: string }>;
  loadPainterAsset(kind: PainterAssetKind, name: string): Promise<{ success: boolean; data?: unknown; error?: string }>;
  savePainterAsset(kind: PainterAssetKind, name: string, data: unknown): Promise<{ success: boolean; error?: string }>;
  deletePainterAsset(kind: PainterAssetKind, name: string): Promise<{ success: boolean; error?: string }>;
  getMinecraftSkin(username: string): Promise<MinecraftSkinResult>;
  on?: (channel: string, listener: (...args: unknown[]) => void) => void;
  removeAllListeners?: (channel: string) => void;
  send?: (channel: string, ...args: unknown[]) => void;
}

declare interface Window {
  ipcApi: IpcApi;
}
