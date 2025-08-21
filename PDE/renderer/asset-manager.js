const CACHE_NAME = 'pde-assets-v1';

/**
 * 수신된 에셋 데이터를 브라우저 캐시에 저장합니다.
 * @param {Array<{path: string, content: Buffer}>} assets - 캐시할 에셋 데이터 배열
 */
async function cacheAssets(assets) {
  try {
    const cache = await caches.open(CACHE_NAME);
    console.log(`Caching ${assets.length} assets...`);

    for (const asset of assets) {
      // Buffer를 Response 객체로 변환하여 캐시에 저장
      // 파일 확장자에 따라 적절한 MIME 타입을 설정할 수 있습니다.
      const mimeType = asset.path.endsWith('.png') ? 'image/png' : 'application/octet-stream';
      const response = new Response(asset.content, {
        headers: { 'Content-Type': mimeType }
      });
      await cache.put(asset.path, response);
    }

    // 모든 에셋이 성공적으로 캐시되었음을 표시하는 플래그 저장
    await cache.put('assets-cached-flag', new Response('true'));
    console.log('Assets cached successfully.');

  } catch (error) {
    console.error('Failed to cache assets:', error);
  }
}

/**
 * 에셋 캐시를 초기화하고, 필요한 경우 다운로드를 요청합니다.
 */
async function initAssets() {
  const cache = await caches.open(CACHE_NAME);
  const isCached = await cache.match('assets-cached-flag');

  if (isCached) {
    console.log('Assets are already cached.');
    return;
  }

  console.log('Assets not found in cache. Requesting download...');

  // 메인 프로세스로부터 에셋 다운로드 완료 이벤트 수신
  window.ipcApi.on('assets-downloaded', (assets) => {
    cacheAssets(assets);
    // 이벤트 리스너 정리
    window.ipcApi.removeAllListeners('assets-downloaded');
    window.ipcApi.removeAllListeners('assets-download-failed');
  });

  // 에셋 다운로드 실패 이벤트 수신
  window.ipcApi.on('assets-download-failed', (error) => {
    console.error('Asset download failed in main process:', error);
    window.ipcApi.removeAllListeners('assets-downloaded');
    window.ipcApi.removeAllListeners('assets-download-failed');
  });

  // 메인 프로세스에 에셋 다운로드 요청
  window.ipcApi.send('download-assets');
}

export { initAssets };
