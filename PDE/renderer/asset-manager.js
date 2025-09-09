const CACHE_NAME = 'pde-assets-v1';

// 에셋 준비 상태를 나타내는 Promise. initAssets()가 호출되면 생성됩니다.
let assetsReadyPromise = null;

/**
 * 에셋 캐시를 초기화하고, 필요한 경우 다운로드를 요청합니다.
 * 이 함수는 앱 시작 시 한 번만 호출되어야 합니다.
 * 이제 개발/프로덕션 환경 구분 없이 항상 파일 시스템 캐시를 사용합니다.
 */
function initAssets() {
  if (assetsReadyPromise) {
    return assetsReadyPromise;
  }

  assetsReadyPromise = new Promise((resolve, reject) => {
    console.log('Initializing file system cache...');

    // 메인 프로세스로부터 에셋 준비 완료(또는 실패) 이벤트 수신
    window.ipcApi.on('assets-downloaded', () => {
      console.log('File system cache is ready.');
      // 이벤트 리스너 정리
      window.ipcApi.removeAllListeners('assets-downloaded');
      window.ipcApi.removeAllListeners('assets-download-failed');
      resolve();
    });

    window.ipcApi.on('assets-download-failed', (error) => {
      console.error('Asset caching failed in main process:', error);
      window.ipcApi.removeAllListeners('assets-downloaded');
      window.ipcApi.removeAllListeners('assets-download-failed');
      reject(new Error(error));
    });

    // 메인 프로세스에 에셋 캐싱/준비 요청
    window.ipcApi.send('download-assets');
  });

  return assetsReadyPromise;
}

/**
 * 특정 에셋의 접근 가능한 URL을 가져옵니다.
 * 항상 파일 시스템 캐시를 사용합니다.
 * @param {string} assetPath - 가져올 에셋의 경로 (예: 'assets/minecraft/textures/block/stone.png')
 * @returns {Promise<string>} 에셋에 접근할 수 있는 Blob URL
 */
async function getAssetUrl(assetPath) {
  // initAssets가 완료될 때까지 기다림
  if (!assetsReadyPromise) {
    throw new Error('initAssets() must be called before getting an asset URL.');
  }
  await assetsReadyPromise;

  // IPC를 통해 메인 프로세스에서 파일 내용 요청
  const result = await window.ipcApi.getAssetContent(assetPath);
  if (result.success) {
    // Buffer/Uint8Array를 Blob으로 변환
    const blob = new Blob([result.content]);
    return URL.createObjectURL(blob);
  } else {
    console.error(`Failed to get asset from file system cache: ${assetPath}`, result.error);
    throw new Error(result.error);
  }
}

export { initAssets, getAssetUrl };
