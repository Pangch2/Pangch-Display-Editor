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

declare interface IpcApi {
  getAssetContent(path: string): Promise<AssetContentResult>;
  saveIconAtlas(name: 'block-atlas.png' | 'item-atlas.png', data: Uint8Array): Promise<{ success: boolean; error?: string }>;
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
  on?: (channel: string, listener: (...args: unknown[]) => void) => void;
  removeAllListeners?: (channel: string) => void;
  send?: (channel: string, ...args: unknown[]) => void;
}

declare interface Window {
  ipcApi: IpcApi;
}
