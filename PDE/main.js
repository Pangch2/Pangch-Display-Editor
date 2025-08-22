import { app, BrowserWindow, Menu, ipcMain } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';
import axios from 'axios';
import unzipper from 'unzipper';


const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 캐시 디렉토리 및 완료 플래그 경로 정의
const CACHE_DIR = path.join(app.getPath('userData'), 'pde-asset-cache-v1');
const CACHE_COMPLETE_FLAG = path.join(CACHE_DIR, '.cache-complete');

function createWindow() {
  const iconPath = app.isPackaged
    ? path.join(__dirname, 'resources', 'Pangch-Face.ico')
    : 'resources/Pangch-Face.ico';
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    icon: iconPath,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,         // ❗ import 쓰려면 false로
      contextIsolation: true,         // 보안상 true 권장
    experimentalFeatures: true,         
    }
  });

  // Vite에서 빌드한 파일 로드
  //win.loadFile(path.join(__dirname, 'dist', 'index.html'));  // ✅ 이 부분 수정

  if (process.env.NODE_ENV === 'development') {
    win.loadURL('http://localhost:5173');  // Vite 개발 서버 주소
    win.webContents.openDevTools();
  } else {
    win.loadFile(path.join(__dirname, 'dist', 'index.html'));
  }
  // 필요하면 메뉴 제거
  Menu.setApplicationMenu(null);

  // --- 파일 시스템 기반 에셋 캐싱 로직 ---

  // 1. 렌더러가 특정 에셋의 내용을 요청할 때 처리
  ipcMain.handle('get-asset-content', async (event, assetPath) => {
    const fullPath = path.join(CACHE_DIR, assetPath);
    try {
      // 보안: 요청된 경로가 캐시 디렉토리 내에 있는지 확인
      const resolvedPath = path.resolve(fullPath);
      if (!resolvedPath.startsWith(path.resolve(CACHE_DIR))) {
        throw new Error('Access denied: Asset path is outside the cache directory.');
      }
      const content = await fs.readFile(fullPath);
      return { success: true, content };
    } catch (error) {
      // 파일이 존재하지 않는 등 오류 발생 시
      console.error(`Failed to read cached asset '${assetPath}':`, error.code);
      return { success: false, error: error.message };
    }
  });

  // 2. 렌더러가 시작될 때 에셋 준비를 요청할 때 처리
  ipcMain.on('download-assets', async (event) => {
    try {
      // 캐시 완료 플래그 파일이 있는지 확인
      await fs.access(CACHE_COMPLETE_FLAG);
      console.log('Assets are already cached. Sending ready signal.');
      // 캐시가 이미 있으면, 다운로드 절차 없이 바로 완료 신호 전송
      event.sender.send('assets-downloaded', []);

    } catch {
      // 플래그 파일이 없으면 캐싱 절차 시작
      console.log('Cache not found. Starting asset download and caching process...');
      
      try {
        // 캐시 디렉토리 생성 (없으면)
        await fs.mkdir(CACHE_DIR, { recursive: true });

        const url = 'https://piston-data.mojang.com/v1/objects/f5f3b6aa26ad6790868d8506b071c6d6dad8d302/client.jar';
        const response = await axios({
          url,
          method: 'GET',
          responseType: 'stream'
        });

        const stream = response.data.pipe(unzipper.Parse({ forceStream: true }));
        const writePromises = [];

        for await (const entry of stream) {
          const assetPath = entry.path;
          const type = entry.type;

          const requiredPaths = [
            'assets/minecraft/items/',
            'assets/minecraft/blockstates/',
            'assets/minecraft/models/',
            'assets/minecraft/textures/item/',
            'assets/minecraft/textures/particle/',
            'assets/minecraft/textures/block/',
            'assets/minecraft/textures/font/'
          ];

          if (type === 'File' && requiredPaths.some(p => assetPath.startsWith(p))) {
            const fullPath = path.join(CACHE_DIR, assetPath);
            // 파일 저장을 위한 디렉토리 생성
            await fs.mkdir(path.dirname(fullPath), { recursive: true });
            // 파일 쓰기 프로미스를 배열에 추가
            writePromises.push(
              entry.buffer().then(buffer => fs.writeFile(fullPath, buffer))
            );
          } else {
            entry.autodrain();
          }
        }

        // 모든 파일 쓰기 작업이 완료될 때까지 기다림
        await Promise.all(writePromises);
        
        // 모든 작업 완료 후, 캐시 완료 플래그 파일 생성
        await fs.writeFile(CACHE_COMPLETE_FLAG, new Date().toISOString());
        
        console.log(`Asset caching complete. ${writePromises.length} assets saved.`);
        // 렌더러에 캐싱 완료 신호 전송
        event.sender.send('assets-downloaded', []);

      } catch (error) {
        console.error('Asset download and caching failed:', error);
        event.sender.send('assets-download-failed', error.message);
      }
    }
  });

  // 3. 렌더러가 로딩 아이콘을 요청할 때 처리
  ipcMain.handle('get-loading-icon', async () => {
    try {
      const iconPath = app.isPackaged
        ? path.join(process.resourcesPath, 'Pangch-Face.ico')
        : path.join(__dirname, 'resources', 'Pangch-Face.ico');
      const iconBuffer = await fs.readFile(iconPath);
      // ICO 파일을 Base64로 인코딩하여 Data URL로 만듭니다.
      const dataUrl = `data:image/x-icon;base64,${iconBuffer.toString('base64')}`;
      return { success: true, dataUrl };
    } catch (error) {
      console.error('Failed to read loading icon:', error);
      return { success: false, error: error.message };
    }
  });
}

// WebGPU 활성화를 위한 플래그 추가
//app.commandLine.appendSwitch('enable-unsafe-webgpu');
app.commandLine.appendSwitch('enable-features', 'WebGPU');
app.whenReady().then(createWindow);
