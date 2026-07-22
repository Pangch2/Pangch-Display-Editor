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
const APP_ROOT = path.dirname(__dirname);
const HARDCODED_DIR = path.join(APP_ROOT, 'hardcoded');

type ConstantPoolEntry = [number, string | number, number?] | undefined;
type CreativeTab = { name: string; items: string[] };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function extractCreativeItems(classBytes: Uint8Array): { tabs: CreativeTab[]; items: string[]; blocks: string[] } {
  const view = new DataView(classBytes.buffer, classBytes.byteOffset, classBytes.byteLength);
  let offset = 0;
  const u1 = () => view.getUint8(offset++);
  const u2 = () => (offset += 2, view.getUint16(offset - 2));
  const u4 = () => (offset += 4, view.getUint32(offset - 4));

  if (u4() !== 0xcafebabe) throw new Error('Invalid CreativeModeTabs.class');
  u2();
  u2();

  const pool: ConstantPoolEntry[] = new Array(u2());
  for (let i = 1; i < pool.length; i++) {
    const tag = u1();
    if (tag === 1) {
      const length = u2();
      pool[i] = [tag, new TextDecoder().decode(classBytes.subarray(offset, offset + length))];
      offset += length;
    } else if (tag === 3 || tag === 4) {
      offset += 4;
    } else if (tag === 5 || tag === 6) {
      offset += 8;
      i++;
    } else if (tag === 7 || tag === 8 || tag === 16 || tag === 19 || tag === 20) {
      pool[i] = [tag, u2()];
    } else if ([9, 10, 11, 12, 17, 18].includes(tag)) {
      pool[i] = [tag, u2(), u2()];
    } else if (tag === 15) {
      offset += 3;
    } else {
      throw new Error(`Unsupported class constant tag: ${tag}`);
    }
  }

  const utf8 = (index: number): string | undefined => {
    const value = pool[index]?.[1];
    return typeof value === 'string' ? value : undefined;
  };
  const field = (index: number): { owner?: string; name?: string } | null => {
    const entry = pool[index];
    if (entry?.[0] !== 9) return null;
    return {
      owner: utf8(Number(pool[Number(entry[1])]?.[1])),
      name: utf8(Number(pool[Number(entry[2])]?.[1]))
    };
  };
  const skipAttributes = () => {
    for (let i = 0, count = u2(); i < count; i++) {
      u2();
      const length = u4();
      offset += length;
    }
  };

  u2();
  u2();
  u2();
  const interfaceCount = u2();
  offset += interfaceCount * 2;
  for (let i = 0, count = u2(); i < count; i++) {
    offset += 6;
    skipAttributes();
  }

  const tabs: CreativeTab[] = [];
  const fallbackTabs: CreativeTab[] = [];
  const allBlocks = new Set<string>();
  for (let i = 0, count = u2(); i < count; i++) {
    u2();
    const methodName = utf8(u2());
    u2();
    let code: Uint8Array | null = null;
    for (let j = 0, attributeCount = u2(); j < attributeCount; j++) {
      const attributeName = utf8(u2());
      const length = u4();
      if (attributeName === 'Code') {
        const end = offset + length;
        u2();
        u2();
        code = classBytes.subarray(offset + 4, offset + 4 + view.getUint32(offset));
        offset = end;
      } else {
        offset += length;
      }
    }
    if (!code) continue;

    const ordered: string[] = [];
    const seen = new Set<string>();
    for (let cursor = 0; cursor < code.length - 2; cursor++) {
      if (code[cursor] !== 0xb2) continue;
      const ref = field((code[cursor + 1] << 8) | code[cursor + 2]);
      if (!ref?.name) continue;
      const name = ref.name.toLowerCase();
      if (ref.owner === 'net/minecraft/world/item/Items') {
        if (!seen.has(name)) ordered.push(name);
        seen.add(name);
      } else if (ref.owner === 'net/minecraft/world/level/block/Blocks') {
        allBlocks.add(name);
      }
    }
    if (ordered.length === 0) continue;
    if (/^generate.+Tab$/.test(methodName)) {
      tabs.push({
        name: methodName.slice(8, -3).replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase(),
        items: ordered
      });
    } else if (/^lambda\$bootstrap\$\d+$/.test(methodName)) {
      fallbackTabs.push({ name: methodName, items: ordered });
    }
  }

  if (tabs.length === 0) {
    fallbackTabs.sort((a, b) => Number(a.name.match(/\d+$/)?.[0]) - Number(b.name.match(/\d+$/)?.[0]));
    tabs.push(...fallbackTabs.map((tab, index) => ({ name: `tab_${index + 1}`, items: tab.items })));
  }
  const orderedItems = [...new Set(tabs.flatMap(tab => tab.items))];
  if (tabs.length === 0 || orderedItems.length === 0) throw new Error('Creative tab item order was not found.');
  return { tabs, items: orderedItems, blocks: [...allBlocks] };
}

function createWindow() {
  const iconPath = app.isPackaged
    ? path.join(APP_ROOT, 'resources', 'Pangch-Face.ico')
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
  
    win.webContents.on('before-input-event', (event, input) => {
      if (input.key === 'F12' && input.type === 'keyDown') {
        win.webContents.toggleDevTools();
        event.preventDefault();
      }
    });
  
  } else {
    win.loadFile(path.join(APP_ROOT, 'renderer-dist', 'index.html'));
  }

  Menu.setApplicationMenu(null);

  // ✅ 생성된 디렉토리 캐싱 (중복 mkdir 방지)
  const createdDirs = new Set<string>();
  async function ensureDir(dirPath: string): Promise<void> {
    if (createdDirs.has(dirPath)) return;
    await fs.mkdir(dirPath, { recursive: true });
    createdDirs.add(dirPath);
  }

  ipcMain.handle('get-asset-content', async (_event, assetPath: string) => {
    const fullPath = path.join(CACHE_DIR, assetPath);
    try {
      const resolvedPath = path.resolve(fullPath);
      if (!resolvedPath.startsWith(path.resolve(CACHE_DIR))) {
        throw new Error('Access denied: Asset path is outside the cache directory.');
      }
      const content = await fs.readFile(fullPath);
      return { success: true, content };
    } catch (error) {
      return { success: false, error: errorMessage(error) };
    }
  });

  ipcMain.handle('save-icon-atlas', async (_event, name: string, data: Uint8Array) => {
    try {
      if (!['block-atlas.png', 'item-atlas.png'].includes(name)) throw new Error('Invalid atlas name.');
      if (!(data instanceof Uint8Array)) throw new TypeError('Atlas data must be a Uint8Array.');
      await fs.writeFile(path.join(CACHE_DIR, name), data);
      return { success: true };
    } catch (error) {
      return { success: false, error: errorMessage(error) };
    }
  });

  // Serve local hardcoded files from the packaged app directory
  ipcMain.handle('get-hardcoded-content', async (_event, relPath: string) => {
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
      //console.error(`Failed to read hardcoded file '${relPath}':`, error.code || error.message);
      return { success: false, error: errorMessage(error) };
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
      const list = JSON.parse(await fs.readFile(path.join(CACHE_DIR, 'item-block-list.json'), 'utf8'));
      if (!Array.isArray(list.tabs) || list.tabs.length === 0 || !Array.isArray(list.items) || list.items.length === 0) {
        throw new Error('Creative tab order cache is outdated.');
      }
      console.log('Assets are already cached. Sending ready signal.');
      event.sender.send('assets-downloaded', []);
    } catch {
      console.log('Cache not found. Starting asset download and caching process...');
      try {
        await fs.mkdir(CACHE_DIR, { recursive: true });

        const startTime = Date.now();

        // client.jar 다운로드
        const url = 'https://piston-data.mojang.com/v1/objects/647abf5c48ac9211f7fa26b137519880b36b20a8/client.jar';
        console.log('Downloading client.jar...');
        const response = await axios<ArrayBuffer>({
          url,
          method: 'GET',
          responseType: 'arraybuffer'
        });
        console.log(`Download complete: ${(response.data.byteLength / 1024 / 1024).toFixed(2)} MB`);

        // assets 폴더만 선택적으로 압축 해제
        console.log('Unzipping assets only...');
        const unzipStart = Date.now();
        
        const unzipped = await new Promise<Record<string, Uint8Array>>((resolve, reject) => {
          unzip(new Uint8Array(response.data), {
            filter(file) {
              return file.name === 'net/minecraft/world/item/CreativeModeTabs.class'
                || (file.name.startsWith('assets/minecraft/') && !file.name.endsWith('/'));
            }
          }, (err, data) => {
            if (err) reject(err);
            else resolve(data);
          });
        });
        
        console.log(`Unzip complete in ${Date.now() - unzipStart}ms`);

        // 필요한 prefix만 추가 필터링
        const allNames = Object.keys(unzipped);
        const assetEntries = allNames.filter(name =>
          requiredPrefixes.some(prefix => name.startsWith(prefix))
        );

        console.log(`Saving ${assetEntries.length} assets to disk...`);

        // 병렬 파일 쓰기 (제한 64)
        const limit = pLimit(64);
        let savedCount = 0;
        const writeStart = Date.now();

        await Promise.all(assetEntries.map(name =>
          limit(async () => {
            const relativePath = name.replace(/^client\/assets\//, 'assets/');
            const fullPath = path.join(CACHE_DIR, relativePath);

            await ensureDir(path.dirname(fullPath));
            await fs.writeFile(fullPath, unzipped[name]);

            savedCount++;
            if (savedCount % 1000 === 0) {
              console.log(`Saved ${savedCount}/${assetEntries.length} assets...`);
            }
          })
        ));

        console.log(`File writing complete in ${Date.now() - writeStart}ms`);

        const creativeItems = extractCreativeItems(unzipped['net/minecraft/world/item/CreativeModeTabs.class']);
        const assetNames = new Set(assetEntries);
        creativeItems.blocks = creativeItems.items.filter(name =>
          assetNames.has(`assets/minecraft/blockstates/${name}.json`)
        );
        await fs.writeFile(
          path.join(CACHE_DIR, 'item-block-list.json'),
          JSON.stringify(creativeItems)
        );

        await fs.writeFile(CACHE_COMPLETE_FLAG, new Date().toISOString());
        const totalTime = Date.now() - startTime;
        console.log(`Asset caching complete. ${savedCount} assets saved in ${(totalTime / 1000).toFixed(2)}s`);
        event.sender.send('assets-downloaded', []);

      } catch (error) {
        console.error('Asset download and caching failed:', error);
        event.sender.send('assets-download-failed', errorMessage(error));
      }
    }
  });

  ipcMain.handle('get-loading-icon', async () => {
    try {
      const iconPath = app.isPackaged
        ? path.join(process.resourcesPath, 'Pangch-Face.ico')
        : path.join(APP_ROOT, 'resources', 'Pangch-Face.ico');
      const iconBuffer = await fs.readFile(iconPath);
      const dataUrl = `data:image/x-icon;base64,${iconBuffer.toString('base64')}`;
      return { success: true, dataUrl };
    } catch (error) {
      console.error('Failed to read loading icon:', error);
      return { success: false, error: errorMessage(error) };
    }
  });
}

app.commandLine.appendSwitch('enable-features', 'WebGPU');
app.whenReady().then(createWindow);
