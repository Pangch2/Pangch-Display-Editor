import fs from 'node:fs/promises';
import { writeFile } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { unzip } from 'fflate';
import pLimit from 'p-limit';

const writeFileAsync = promisify(writeFile);

export const minecraftAssetPrefixes = [
  'assets/minecraft/items/',
  'assets/minecraft/blockstates/',
  'assets/minecraft/models/',
  'assets/minecraft/atlases/',
  'assets/minecraft/font/',
  'assets/minecraft/textures/item/',
  'assets/minecraft/textures/font/',
  'assets/minecraft/textures/particle/',
  'assets/minecraft/textures/block/',
  'assets/minecraft/textures/environment/end_sky.png',
  'assets/minecraft/textures/environment/celestial/',
  'assets/minecraft/textures/gui/sprites/',
  'assets/minecraft/textures/map/decorations/',
  'assets/minecraft/textures/mob_effect/',
  'assets/minecraft/textures/painting/',
  'assets/minecraft/textures/palettes/',
  'assets/minecraft/textures/trims/items/',
  'assets/minecraft/textures/entity/'
];

export function unzipMinecraftFiles(
  data: ArrayBuffer | Uint8Array,
  filter: (name: string) => boolean
): Promise<Record<string, Uint8Array>> {
  // Axios returns a Buffer in Electron; keep its existing backing storage.
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  return new Promise((resolve, reject) => {
    unzip(bytes, { filter: file => !file.name.endsWith('/') && filter(file.name) },
      (error, files) => error ? reject(error) : resolve(files));
  });
}

export async function writeMinecraftAssets(files: Record<string, Uint8Array>, cacheDir: string): Promise<void> {
  const cacheRoot = path.resolve(cacheDir);
  const entries = Object.keys(files).map(name => {
    const fullPath = path.resolve(cacheRoot, name);
    const relativePath = path.relative(cacheRoot, fullPath);
    if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
      throw new Error(`Asset path is outside the cache directory: ${name}`);
    }
    return { name, fullPath };
  });
  const limit = pLimit(64);
  const writeStart = Date.now();
  console.log(`Saving ${entries.length} assets to disk...`);

  // Create each directory once, before any files are written into it.
  const directories = new Set(entries.map(entry => path.dirname(entry.fullPath)));
  await Promise.all([...directories].map(directory => limit(() => fs.mkdir(directory, { recursive: true }))));
  let savedCount = 0;
  await Promise.all(entries.map(({ name, fullPath }) => limit(async () => {
    await writeFileAsync(fullPath, files[name]);
    delete files[name];
    if (++savedCount % 1000 === 0) console.log(`Saved ${savedCount}/${entries.length} assets...`);
  })));
  console.log(`File writing complete in ${Date.now() - writeStart}ms`);
}
