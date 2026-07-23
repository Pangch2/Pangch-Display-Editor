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
const clientUrl = 'https://piston-data.mojang.com/v1/objects/0cda4b16710f5b42e532b20ed9b8965c105e77a8/client.jar';
const serverUrl = 'https://piston-data.mojang.com/v1/objects/bc881a3fc6e63c490e614ab3bf9c43adc0449ab2/server.jar';
// When packaged, __dirname points to app.asar contents. Files added via build.files are inside asar by default.
// For reading hardcoded JSON at runtime, prefer resolved path within the asar; when unpacked dev, use __dirname.
const APP_ROOT = path.dirname(__dirname);
const HARDCODED_DIR = path.join(APP_ROOT, 'hardcoded');
const blockColors = ['white', 'light_gray', 'gray', 'black', 'brown', 'red', 'orange', 'yellow', 'lime', 'green', 'cyan', 'light_blue', 'blue', 'purple', 'magenta', 'pink'];
const testBlockVariants = ['start', 'log', 'fail', 'accept'].map(mode => `test_block[mode=${mode}]`);
const lightVariants = Array.from({ length: 16 }, (_, index) => `light[level=${15 - index}]`);

type ConstantPoolEntry = [number, string | number, number?] | undefined;
type CreativeTab = { name?: string; items: string[] };
type RegistryTab = { name?: string; entries: string[] };
type RegistryList = {
  itemTabs?: RegistryTab[];
  blockTabs?: RegistryTab[];
  items: string[];
  blocks: string[];
  threeDimensionalItems: string[];
};

const registryNameOverrides: Record<string, string> = {
  dry_short_grass: 'short_dry_grass',
  dry_tall_grass: 'tall_dry_grass',
  cut_standstone_slab: 'cut_sandstone_slab',
  potted_azalea: 'potted_azalea_bush',
  potted_flowering_azalea: 'potted_flowering_azalea_bush'
};

function registryName(fieldName: string): string {
  const name = fieldName.toLowerCase();
  return registryNameOverrides[name] ?? name;
}

function expandStatefulBlocks(names: string[]): string[] {
  return names.flatMap(name => name === 'test_block' ? testBlockVariants : name === 'light' ? lightVariants : [name]);
}

async function includeHardcodedRegistryItems(registry: RegistryList): Promise<boolean> {
  const modelNames = (await fs.readdir(path.join(HARDCODED_DIR, 'models', 'block')))
    .filter(name => name.endsWith('.json'))
    .map(name => name.slice(0, -5));
  const itemNames = (await Promise.all(modelNames.map(async name => {
    try {
      await fs.access(path.join(CACHE_DIR, 'assets', 'minecraft', 'items', `${name}.json`));
      return name;
    } catch {
      return null;
    }
  }))).filter((name): name is string => !!name);
  const previousItems = registry.items.join('\0');
  const previousBlocks = registry.blocks.join('\0');
  const previousTabs = JSON.stringify([registry.itemTabs, registry.blockTabs]);
  registry.items = [...new Set(registry.items.map(registryName))];
  registry.blocks = [...new Set(registry.blocks.map(registryName))];
  registry.threeDimensionalItems = [...new Set(registry.threeDimensionalItems.map(registryName))];
  registry.itemTabs?.forEach(tab => tab.entries = [...new Set(tab.entries.map(registryName))]);
  registry.blockTabs?.forEach(tab => tab.entries = [...new Set(tab.entries.map(registryName))]);
  registry.items = [...new Set([...registry.items, ...registry.blocks, ...itemNames])].filter(name => !isRegistryExcluded(name, 'item'));
  const blockItemNames = (await Promise.all(registry.items.map(async name => {
    try {
      await fs.access(path.join(CACHE_DIR, 'assets', 'minecraft', 'blockstates', `${name}.json`));
      return name;
    } catch {
      return null;
    }
  }))).filter((name): name is string => !!name);
  const itemOrder = new Map(registry.items.map((name, index) => [name, index]));
  registry.blocks = [...new Set([...registry.blocks, ...itemNames, ...blockItemNames])]
    .filter(name => !isRegistryExcluded(name, 'block'))
    .sort((a, b) => (itemOrder.get(a) ?? Infinity) - (itemOrder.get(b) ?? Infinity));
  registry.blocks = expandStatefulBlocks(registry.blocks);
  registry.threeDimensionalItems = [...new Set([...registry.threeDimensionalItems, ...itemNames])];
  if (registry.itemTabs && registry.blockTabs) {
    registry.blockTabs.forEach(tab => tab.entries = expandStatefulBlocks(tab.entries));
    for (const [type, tabs] of [['items', registry.itemTabs], ['blocks', registry.blockTabs]] as const) {
      const etcTab = tabs.find(tab => tab.name === 'etc') ?? { name: 'etc', entries: [] };
      const searchItems = new Set(tabs.filter(tab => tab !== etcTab).flatMap(tab => tab.entries));
      etcTab.entries = registry[type].filter(name => !searchItems.has(name));
      if (!tabs.includes(etcTab)) tabs.push(etcTab);
    }
  }
  return registry.items.join('\0') !== previousItems
    || registry.blocks.join('\0') !== previousBlocks
    || JSON.stringify([registry.itemTabs, registry.blockTabs]) !== previousTabs;
}

const registryExcludes = {
  item: new Set(['air', '*_air', 'moving_piston', '*_wall_sign', '*_wall_hanging_sign', 'player_head', 'bubble_column', '*_wall_head','*_wall_skull', 'wool', 'end_portal', 'end_gateway']),
  block: new Set(['air', '*_air', 'moving_piston', '*_wall_sign', '*_wall_hanging_sign', 'player_head', 'water', 'lava', 'barrier', 'bubble_column', '*_wall_head', '*_wall_skull', 'wool', 'end_portal', 'end_gateway'])
};

function isRegistryExcluded(id: string, registry: keyof typeof registryExcludes): boolean {
  return [...registryExcludes[registry]].some(exclude => exclude.startsWith('*') ? id.endsWith(exclude.slice(1)) : id === exclude);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function weatheringCopperNames(name: string, methods: string[], hasItem: (name: string) => boolean): string[] {
  const prefixes = methods.includes('unaffected')
    ? [methods.includes('waxed') ? 'waxed_' : '']
    : methods.includes('waxed')
      ? ['waxed_', 'waxed_exposed_', 'waxed_weathered_', 'waxed_oxidized_']
      : methods.includes('weathering')
        ? ['', 'exposed_', 'weathered_', 'oxidized_']
        : ['', 'exposed_', 'weathered_', 'oxidized_', 'waxed_', 'waxed_exposed_', 'waxed_weathered_', 'waxed_oxidized_'];
  return prefixes.map(prefix => `${prefix}${name}`).filter(hasItem);
}

if (process.env.NODE_ENV === 'development') {
  console.assert(registryName('POTTED_AZALEA') === 'potted_azalea_bush', 'Registry name override failed.');
  console.assert(
    expandStatefulBlocks(['stone', 'test_block']).join(',') ===
      'stone,test_block[mode=start],test_block[mode=log],test_block[mode=fail],test_block[mode=accept]',
    'Test block variant expansion failed.'
  );
  console.assert(
    expandStatefulBlocks(['light']).join(',') === Array.from({ length: 16 }, (_, index) => `light[level=${15 - index}]`).join(','),
    'Light block variant expansion failed.'
  );
  console.assert(
    weatheringCopperNames('copper_chest', ['forEach'], name => !name.startsWith('waxed_oxidized_')).join(',') ===
      'copper_chest,exposed_copper_chest,weathered_copper_chest,oxidized_copper_chest,waxed_copper_chest,waxed_exposed_copper_chest,waxed_weathered_copper_chest',
    'Weathering copper item expansion failed.'
  );
}

function extractRegistryNames(classBytes: Uint8Array, registry: keyof typeof registryExcludes): string[] {
  const view = new DataView(classBytes.buffer, classBytes.byteOffset, classBytes.byteLength);
  let offset = 0;
  const u1 = () => view.getUint8(offset++);
  const u2 = () => (offset += 2, view.getUint16(offset - 2));
  const u4 = () => (offset += 4, view.getUint32(offset - 4));

  if (u4() !== 0xcafebabe) throw new Error(`Invalid ${registry} registry class.`);
  u2();
  u2();
  const utf8 = new Map<number, string>();
  for (let i = 1, count = u2(); i < count; i++) {
    const tag = u1();
    if (tag === 1) {
      const length = u2();
      utf8.set(i, new TextDecoder().decode(classBytes.subarray(offset, offset + length)));
      offset += length;
    } else if (tag === 3 || tag === 4) offset += 4;
    else if (tag === 5 || tag === 6) { offset += 8; i++; }
    else if (tag === 7 || tag === 8 || tag === 16 || tag === 19 || tag === 20) offset += 2;
    else if ([9, 10, 11, 12, 17, 18].includes(tag)) offset += 4;
    else if (tag === 15) offset += 3;
    else throw new Error(`Unsupported class constant tag: ${tag}`);
  }

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

  const descriptorSuffix = registry === 'item' ? 'Item;' : 'Block;';
  const names: string[] = [];
  for (let i = 0, count = u2(); i < count; i++) {
    const access = u2();
    const name = utf8.get(u2());
    const descriptor = utf8.get(u2());
    skipAttributes();
    if ((access & 0x19) === 0x19 && name && descriptor?.endsWith(descriptorSuffix)) {
      const id = registryName(name);
      if (!isRegistryExcluded(id, registry)) names.push(id);
    }
  }
  if (!names.includes('stone')) throw new Error(`${registry} registry was not found in the server jar.`);
  return names.sort();
}

function extractCreativeItems(classBytes: Uint8Array, hasItem = (_name: string) => true): { tabs: CreativeTab[]; items: string[]; blocks: string[]; coloredItems: string[] } {
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
  const field = (index: number): { owner?: string; name?: string; descriptor?: string } | null => {
    const entry = pool[index];
    if (entry?.[0] !== 9) return null;
    return {
      owner: utf8(Number(pool[Number(entry[1])]?.[1])),
      name: utf8(Number(pool[Number(entry[2])]?.[1])),
      descriptor: utf8(Number(pool[Number(entry[2])]?.[2]))
    };
  };
  const memberMethodName = (index: number): string | undefined => {
    const entry = pool[index];
    return entry && (entry[0] === 10 || entry[0] === 11)
      ? utf8(Number(pool[Number(entry[2])]?.[1]))
      : undefined;
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
  const coloredItems = new Set<string>();
  const copperFamilies: string[] = [];
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
      const name = registryName(ref.name);
      if (ref.owner === 'net/minecraft/world/item/Items') {
        const isColorCollection = ref.descriptor?.endsWith('/ColorCollection;');
        const isWeatheringCopperCollection = ref.descriptor?.endsWith('/WeatheringCopperCollection;');
        if (methodName === 'copperBlockFamilies' && isWeatheringCopperCollection) copperFamilies.push(name);
        const methods: string[] = [];
        for (let look = cursor + 3; look < code.length - 2; look++) {
          if (code[look] === 0xb2 && field((code[look + 1] << 8) | code[look + 2])) break;
          if (code[look] === 0xb6 || code[look] === 0xb9) {
            const called = memberMethodName((code[look + 1] << 8) | code[look + 2]);
            if (called) methods.push(called);
          }
        }
        const names = isColorCollection
          ? blockColors.map(color => `${color}_${name.replace(/^dyed_/, '')}`)
          : isWeatheringCopperCollection
            ? weatheringCopperNames(name, methods, hasItem)
            : [name];
        names.forEach(itemName => {
          if (!seen.has(itemName)) ordered.push(itemName);
          seen.add(itemName);
          if (isColorCollection) coloredItems.add(itemName);
          if (isWeatheringCopperCollection) allBlocks.add(itemName);
        });
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
    tabs.push(...fallbackTabs.map(tab => ({ items: tab.items })));
  }
  const buildingBlocks = tabs.find(tab => tab.name === 'building_blocks') ?? tabs.find(tab => tab.items.includes('netherite_block'));
  if (buildingBlocks && copperFamilies.length) {
    const copperItems = [
      ...copperFamilies.flatMap(name => weatheringCopperNames(name, ['weathering'], hasItem)),
      ...copperFamilies.flatMap(name => weatheringCopperNames(name, ['waxed'], hasItem))
    ];
    buildingBlocks.items.splice(buildingBlocks.items.indexOf('netherite_block') + 1, 0, ...copperItems);
    copperItems.forEach(name => allBlocks.add(name));
  }
  const orderedItems = [...new Set(tabs.flatMap(tab => tab.items))];
  if (tabs.length === 0 || orderedItems.length === 0) throw new Error('Creative tab item order was not found.');
  return { tabs, items: orderedItems, blocks: [...allBlocks], coloredItems: [...coloredItems] };
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

  ipcMain.on('log-atlas-generation-time', (_event, duration: number) => {
    if (Number.isFinite(duration)) console.log(`Icon atlases generated in ${Math.round(duration)}ms`);
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
      const registryPath = path.join(CACHE_DIR, 'item-block-list.json');
      const registry = JSON.parse(await fs.readFile(registryPath, 'utf8')) as RegistryList;
      if (!registry.itemTabs || !registry.blockTabs || !registry.threeDimensionalItems) {
        throw new Error('Cached registry has no creative item model rules.');
      }
      if (await includeHardcodedRegistryItems(registry)) {
        await fs.writeFile(registryPath, JSON.stringify(registry));
      }
      console.log('Assets are already cached. Sending ready signal.');
      event.sender.send('assets-downloaded', []);
    } catch {
      console.log('Cache not found. Starting asset download and caching process...');
      try {
        await fs.mkdir(CACHE_DIR, { recursive: true });

        const startTime = Date.now();

        console.log('Downloading client.jar and server.jar...');
        const [clientResponse, serverResponse] = await Promise.all([
          axios<ArrayBuffer>({ url: clientUrl, method: 'GET', responseType: 'arraybuffer' }),
          axios<ArrayBuffer>({ url: serverUrl, method: 'GET', responseType: 'arraybuffer' })
        ]);
        console.log(`Download complete: ${((clientResponse.data.byteLength + serverResponse.data.byteLength) / 1024 / 1024).toFixed(2)} MB`);

        // assets 폴더만 선택적으로 압축 해제
        console.log('Unzipping assets only...');
        const unzipStart = Date.now();
        
        const unzipped = await new Promise<Record<string, Uint8Array>>((resolve, reject) => {
          unzip(new Uint8Array(clientResponse.data), {
            filter(file) {
              return file.name.startsWith('assets/minecraft/') && !file.name.endsWith('/');
            }
          }, (err, data) => {
            if (err) reject(err);
            else resolve(data);
          });
        });
        
        console.log(`Unzip complete in ${Date.now() - unzipStart}ms`);

        const serverBundle = await new Promise<Record<string, Uint8Array>>((resolve, reject) => {
          unzip(new Uint8Array(serverResponse.data), {
            filter: file => /^META-INF\/versions\/.+\/server-.+\.jar$/.test(file.name)
          }, (err, data) => err ? reject(err) : resolve(data));
        });
        const bundledServer = Object.values(serverBundle)[0];
        if (!bundledServer) throw new Error('Bundled server jar was not found.');
        const serverClasses = await new Promise<Record<string, Uint8Array>>((resolve, reject) => {
          unzip(bundledServer, {
            filter: file => [
              'net/minecraft/world/item/CreativeModeTabs.class',
              'net/minecraft/world/item/Items.class',
              'net/minecraft/world/level/block/Blocks.class'
            ].includes(file.name)
          }, (err, data) => err ? reject(err) : resolve(data));
        });

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

        const registryStart = Date.now();
        const itemRegistry = extractRegistryNames(serverClasses['net/minecraft/world/item/Items.class'], 'item');
        const blockRegistry = extractRegistryNames(serverClasses['net/minecraft/world/level/block/Blocks.class'], 'block');
        const creativeItems = extractCreativeItems(
          serverClasses['net/minecraft/world/item/CreativeModeTabs.class'],
          name => !!unzipped[`assets/minecraft/items/${name}.json`]
        );
        itemRegistry.push(...creativeItems.coloredItems);
        blockRegistry.push(...creativeItems.coloredItems.filter(name => unzipped[`assets/minecraft/blockstates/${name}.json`]));
        const searchItems = new Set(creativeItems.items);
        const searchOrder = new Map(creativeItems.items.map((name, index) => [name, index]));
        const bySearchOrder = (a: string, b: string) => (searchOrder.get(a) ?? Infinity) - (searchOrder.get(b) ?? Infinity);
        const items = [...creativeItems.items, ...[...new Set([...itemRegistry, ...blockRegistry])].filter(name => !searchItems.has(name))];
        const blocks = [...new Set([...blockRegistry, ...creativeItems.blocks])].sort(bySearchOrder);
        const blockNames = new Set(blocks);
        const registry: RegistryList = {
          itemTabs: [...creativeItems.tabs.map(tab => ({ name: tab.name, entries: tab.items })), { name: 'etc', entries: [] }],
          blockTabs: [
            ...creativeItems.tabs.map(tab => ({ name: tab.name, entries: tab.items.filter(name => blockNames.has(name)) })).filter(tab => tab.entries.length),
            { name: 'etc', entries: [] }
          ],
          items,
          blocks,
          threeDimensionalItems: creativeItems.blocks
        };
        await includeHardcodedRegistryItems(registry);
        await fs.writeFile(
          path.join(CACHE_DIR, 'item-block-list.json'),
          JSON.stringify({ registry: 'server-jar', ...registry })
        );
        console.log(`item-block-list.json generated in ${Date.now() - registryStart}ms`);

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
