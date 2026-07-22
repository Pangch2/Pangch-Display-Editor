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
  on?: (channel: string, listener: (...args: unknown[]) => void) => void;
  removeAllListeners?: (channel: string) => void;
  send?: (channel: string, ...args: unknown[]) => void;
}

declare interface Window {
  ipcApi: IpcApi;
}
