import { app, BrowserWindow, Menu, ipcMain } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';
import axios from 'axios';
import { unzip } from 'fflate';
import pLimit from 'p-limit';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CACHE_DIR = path.join(app.getPath('userData'), 'pde-asset-cache-v1');
const CACHE_COMPLETE_FLAG = path.join(CACHE_DIR, '.cache-complete');
// When packaged, __dirname points to app.asar contents. Files added via build.files are inside asar by default.
// For reading hardcoded JSON at runtime, prefer resolved path within the asar; when unpacked dev, use __dirname.
const APP_ROOT = __dirname;
const HARDCODED_DIR = path.join(APP_ROOT, 'hardcoded');

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
      nodeIntegration: false,
      contextIsolation: true,
      experimentalFeatures: true
    }
  });

  win.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    const newHeaders = {
      ...details.responseHeaders,
      'Cross-Origin-Opener-Policy': ['same-origin'],
      'Cross-Origin-Embedder-Policy': ['require-corp']
    };
    callback({ responseHeaders: newHeaders });
  });

  if (process.env.NODE_ENV === 'development') {
    win.loadURL('http://localhost:5173');
    win.webContents.openDevTools();
  } else {
  win.loadFile(path.join(__dirname, 'renderer-dist', 'index.html'));
    //win.webContents.openDevTools();
  }

  Menu.setApplicationMenu(null);

  // ✅ 생성된 디렉토리 캐싱 (중복 mkdir 방지)
  const createdDirs = new Set();
  async function ensureDir(dirPath) {
    if (createdDirs.has(dirPath)) return;
    await fs.mkdir(dirPath, { recursive: true });
    createdDirs.add(dirPath);
  }

  ipcMain.handle('get-asset-content', async (event, assetPath) => {
    const fullPath = path.join(CACHE_DIR, assetPath);
    try {
      const resolvedPath = path.resolve(fullPath);
      if (!resolvedPath.startsWith(path.resolve(CACHE_DIR))) {
        throw new Error('Access denied: Asset path is outside the cache directory.');
      }
      const content = await fs.readFile(fullPath);
      return { success: true, content };
    } catch (error) {
      console.error(`Failed to read cached asset '${assetPath}':`, error.code);
      return { success: false, error: error.message };
    }
  });

  // Serve local hardcoded files from the packaged app directory
  ipcMain.handle('get-hardcoded-content', async (event, relPath) => {
    try {
      const safeRel = relPath.replace(/\\/g, '/');
      const fullPath = path.join(HARDCODED_DIR, safeRel);
      const resolvedPath = path.resolve(fullPath);
      if (!resolvedPath.startsWith(path.resolve(HARDCODED_DIR))) {
        throw new Error('Access denied: Path is outside the hardcoded directory.');
      }
      const content = await fs.readFile(resolvedPath);
      return { success: true, content };
    } catch (error) {
      console.error(`Failed to read hardcoded file '${relPath}':`, error.code || error.message);
      return { success: false, error: error.message };
    }
  });

  const requiredPrefixes = [
    'assets/minecraft/items/',
    'assets/minecraft/blockstates/',
    'assets/minecraft/models/',
    'assets/minecraft/textures/item/',
    'assets/minecraft/textures/particle/',
    'assets/minecraft/textures/block/',
    'assets/minecraft/textures/font/',
    'assets/minecraft/font/',
    'assets/minecraft/textures/entity/'
  ];

  ipcMain.handle('get-required-prefixes', () => {
    return requiredPrefixes;
  });

  ipcMain.on('download-assets', async (event) => {
    try {
      await fs.access(CACHE_COMPLETE_FLAG);
      console.log('Assets are already cached. Sending ready signal.');
      event.sender.send('assets-downloaded', []);
    } catch {
      console.log('Cache not found. Starting asset download and caching process...');
      try {
        await fs.mkdir(CACHE_DIR, { recursive: true });

        // ✅ client.jar 다운로드 (메모리 상에서 처리)
        const url = 'https://piston-data.mojang.com/v1/objects/26551033b7b935436f3407b85d14cac835e65640/client.jar';
        const response = await axios({
          url,
          method: 'GET',
          responseType: 'arraybuffer'
        });

  // ✅ fflate 으로 압축 열기 (Buffer/Uint8Array 직접 사용)
  const unzipped = await new Promise((resolve, reject) => {
    unzip(new Uint8Array(response.data), (err, data) => {
      if (err) reject(err);
      else resolve(data);
    });
  });

        // ✅ 사전 필터링 (디렉토리 엔트리 제외)
        const allNames = Object.keys(unzipped);
        const assetEntries = allNames.filter(name =>
          !name.endsWith('/') && requiredPrefixes.some(prefix => name.startsWith(prefix))
        );

        //병렬 제한 32
        const limit = pLimit(32);
        let savedCount = 0;

        await Promise.all(assetEntries.map(name =>
          limit(async () => {
            const relativePath = name.replace(/^client\/assets\//, 'assets/');
            const fullPath = path.join(CACHE_DIR, relativePath);

            await ensureDir(path.dirname(fullPath));

            const data = unzipped[name];
            await fs.writeFile(fullPath, data);

            savedCount++;
          })
        ));

  await fs.writeFile(CACHE_COMPLETE_FLAG, new Date().toISOString());
        console.log(`Asset caching complete. ${savedCount} assets saved.`);
        event.sender.send('assets-downloaded', []);

      } catch (error) {
        console.error('Asset download and caching failed:', error);
        event.sender.send('assets-download-failed', error.message);
      }
    }
  });

  ipcMain.handle('get-loading-icon', async () => {
    try {
      const iconPath = app.isPackaged
        ? path.join(process.resourcesPath, 'Pangch-Face.ico')
        : path.join(__dirname, 'resources', 'Pangch-Face.ico');
      const iconBuffer = await fs.readFile(iconPath);
      const dataUrl = `data:image/x-icon;base64,${iconBuffer.toString('base64')}`;
      return { success: true, dataUrl };
    } catch (error) {
      console.error('Failed to read loading icon:', error);
      return { success: false, error: error.message };
    }
  });
}

app.commandLine.appendSwitch('enable-features', 'WebGPU');
app.whenReady().then(createWindow);