const { contextBridge, ipcRenderer } = require('electron');

// 렌더러 프로세스의 window 객체에 안전하게 API 노출
contextBridge.exposeInMainWorld('ipcApi', {
  // Main -> Renderer (수신)
  on: (channel, callback) => {
    const validChannels = ['assets-downloaded', 'assets-download-failed'];
    if (validChannels.includes(channel)) {
      // 유효한 채널에 대해서만 콜백 등록
      ipcRenderer.on(channel, (event, ...args) => callback(...args));
    }
  },
  // Renderer -> Main (송신)
  send: (channel, data) => {
    const validChannels = ['download-assets'];
    if (validChannels.includes(channel)) {
      ipcRenderer.send(channel, data);
    }
  },
  // Renderer -> Main (양방향 통신, 요청-응답)
  invoke: (channel, ...args) => {
    const validChannels = ['get-asset-content', 'get-loading-icon'];
    if (validChannels.includes(channel)) {
      return ipcRenderer.invoke(channel, ...args);
    }
    // 허용되지 않은 채널에 대한 호출은 거부하거나 에러 처리
    return Promise.reject(new Error(`Invalid invoke channel: ${channel}`));
  },
  // 리스너 정리 (메모리 누수 방지)
  removeAllListeners: (channel) => {
    const validChannels = ['assets-downloaded', 'assets-download-failed'];
    if (validChannels.includes(channel)) {
        ipcRenderer.removeAllListeners(channel);
    }
  }
});
