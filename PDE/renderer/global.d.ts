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

declare interface IpcApi {
  getAssetContent(path: string): Promise<AssetContentResult>;
  getHardcodedContent(path: string): Promise<HardcodedContentResult>;
  getLoadingIcon?: () => Promise<AssetContentResult>;
  on?: (channel: string, listener: (...args: any[]) => void) => void;
  removeAllListeners?: (channel: string) => void;
  send?: (channel: string, ...args: any[]) => void;
}

declare interface Window {
  ipcApi: IpcApi;
}
