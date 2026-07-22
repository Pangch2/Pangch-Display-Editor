const { contextBridge, ipcRenderer } = require('electron');

type AssetEventChannel = 'assets-downloaded' | 'assets-download-failed';
type AtlasName = 'block-atlas.png' | 'item-atlas.png';

// 렌더러 프로세스의 window 객체에 안전하게 API 노출
contextBridge.exposeInMainWorld('ipcApi', {
  // Main -> Renderer (수신)
  on: (channel: AssetEventChannel, callback: (...args: unknown[]) => void) => {
    const validChannels = ['assets-downloaded', 'assets-download-failed'];
    if (validChannels.includes(channel)) {
      // 유효한 채널에 대해서만 콜백 등록
      ipcRenderer.on(channel, (_event: unknown, ...args: unknown[]) => callback(...args));
    }
  },
  // Renderer -> Main (송신)
  send: (channel: 'download-assets' | 'log-atlas-generation-time', data?: unknown) => {
    const validChannels = ['download-assets', 'log-atlas-generation-time'];
    if (validChannels.includes(channel)) {
      ipcRenderer.send(channel, data);
    }
  },
  // Renderer -> Main (양방향 통신, 요청-응답)
  getAssetContent: (assetPath: string) => {
    if (typeof assetPath !== 'string') {
      return Promise.reject(new TypeError('assetPath must be a string.'));
    }
    return ipcRenderer.invoke('get-asset-content', assetPath);
  },
  saveIconAtlas: (name: AtlasName, data: Uint8Array) => ipcRenderer.invoke('save-icon-atlas', name, data),
  // Read static files bundled with the app under the hardcoded/ folder
  getHardcodedContent: (relPath: string) => {
    if (typeof relPath !== 'string') {
      return Promise.reject(new TypeError('relPath must be a string.'));
    }
    return ipcRenderer.invoke('get-hardcoded-content', relPath);
  },
  getLoadingIcon: () => ipcRenderer.invoke('get-loading-icon'),
  getRequiredPrefixes: () => ipcRenderer.invoke('get-required-prefixes'),
  // 리스너 정리 (메모리 누수 방지)
  removeAllListeners: (channel: AssetEventChannel) => {
    const validChannels = ['assets-downloaded', 'assets-download-failed'];
    if (validChannels.includes(channel)) {
        ipcRenderer.removeAllListeners(channel);
    }
  }
});
