import { app, BrowserWindow, Menu, ipcMain } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';
import unzipper from 'unzipper';


const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    icon: path.join(__dirname, 'resources', 'Pangch-Face.ico'),
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

  // .jar 파일 다운로드 및 압축 해제 요청 처리
  ipcMain.on('download-assets', async (event) => {
    const url = 'https://piston-data.mojang.com/v1/objects/f5f3b6aa26ad6790868d8506b071c6d6dad8d302/client.jar';
    console.log('Asset download started...');

    try {
      const response = await axios({
        url,
        method: 'GET',
        responseType: 'stream'
      });

      const assetPromises = [];
      const stream = response.data.pipe(unzipper.Parse({ forceStream: true }));

      for await (const entry of stream) {
        const path = entry.path;
        const type = entry.type; // 'Directory' or 'File'

        // 원하는 경로의 파일만 필터링
        const requiredPaths = [
          'assets/minecraft/items/',
          'assets/minecraft/blockstates/',
          'assets/minecraft/models/',
          'assets/minecraft/textures/item/',
          'assets/minecraft/textures/particle/',
          'assets/minecraft/textures/block/',
          'assets/minecraft/textures/font/'
        ];

        if (type === 'File' && requiredPaths.some(p => path.startsWith(p))) {
          const promise = entry.buffer().then(buffer => ({
            path: path,
            content: buffer
          }));
          assetPromises.push(promise);
        } else {
          entry.autodrain();
        }
      }

      const assets = await Promise.all(assetPromises);
      console.log(`Filtered ${assets.length} assets.`);
      event.sender.send('assets-downloaded', assets);

    } catch (error) {
      console.error('Asset download failed:', error);
      event.sender.send('assets-download-failed', error.message);
    }
  });
}

// WebGPU 활성화를 위한 플래그 추가
//app.commandLine.appendSwitch('enable-unsafe-webgpu');
app.commandLine.appendSwitch('enable-features', 'WebGPU');
app.whenReady().then(createWindow);
