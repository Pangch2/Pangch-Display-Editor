import { getAssetBytes } from '../asset-manager';

type DirectorySource = {
    type: 'minecraft:directory';
    source: string;
    prefix: string;
};

type SingleSource = {
    type: 'minecraft:single';
    resource: string;
    sprite?: string;
};

type PalettedPermutationsSource = {
    type: 'minecraft:paletted_permutations';
    textures: string[];
    palette_key: string;
    permutations: Record<string, string>;
    separator?: string;
};

type AtlasSource = DirectorySource | SingleSource | PalettedPermutationsSource;
type AtlasDefinition = { sources: AtlasSource[] };
type AnimationMetadata = {
    animation?: {
        width?: number;
        height?: number;
        frames?: Array<number | { index?: number }>;
    };
};
type PreparedSprite = {
    id: string;
    image: ImageBitmap;
    sourceX: number;
    sourceY: number;
    width: number;
    height: number;
};
type PackedSprite<T> = T & { x: number; y: number };

export type SpriteAtlasManifest = {
    atlas: string;
    width: number;
    height: number;
    sprites: Array<{ id: string; x: number; y: number; width: number; height: number }>;
};

const atlasDirectory = 'assets/minecraft/atlases';
const textureDirectory = 'assets/minecraft/textures';
const decodeConcurrency = 32;
let spriteAtlasesPromise: Promise<void> | null = null;

function readJson<T>(path: string): Promise<T> {
    return getAssetBytes(path).then(bytes => JSON.parse(new TextDecoder().decode(bytes)) as T);
}

async function listAssetFiles(path: string): Promise<string[]> {
    const result = await window.ipcApi.listAssetFiles(path);
    if (!result.success) throw new Error(result.error ?? `Asset directory read failed: ${path}`);
    return result.files;
}

function parseIdentifier(value: string): { id: string; namespace: string; path: string } {
    const separator = value.indexOf(':');
    const namespace = separator < 0 ? 'minecraft' : value.slice(0, separator);
    const resourcePath = separator < 0 ? value : value.slice(separator + 1);
    if (!/^[a-z0-9_.-]+$/.test(namespace) || !/^[a-z0-9_./-]+$/.test(resourcePath) || resourcePath.includes('..')) {
        throw new Error(`Invalid resource identifier: ${value}`);
    }
    return { id: `${namespace}:${resourcePath}`, namespace, path: resourcePath };
}

function texturePath(identifier: string): string {
    const resource = parseIdentifier(identifier);
    return `assets/${resource.namespace}/textures/${resource.path}.png`;
}

function palettePath(identifier: string): string {
    const resource = parseIdentifier(identifier);
    return `assets/${resource.namespace}/textures/palettes/${resource.path}.png`;
}

async function loadBitmap(path: string): Promise<ImageBitmap> {
    const bytes = await getAssetBytes(path);
    return createImageBitmap(new Blob([bytes as BlobPart], { type: 'image/png' }));
}

async function loadImageData(path: string): Promise<ImageData> {
    const bitmap = await loadBitmap(path);
    try {
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const context = canvas.getContext('2d', { willReadFrequently: true });
        if (!context) throw new Error(`Canvas context creation failed: ${path}`);
        context.drawImage(bitmap, 0, 0);
        return context.getImageData(0, 0, bitmap.width, bitmap.height);
    } finally {
        bitmap.close();
    }
}

function firstAnimationFrame(metadata: AnimationMetadata | null, imageWidth: number, imageHeight: number): {
    x: number;
    y: number;
    width: number;
    height: number;
} {
    const animation = metadata?.animation;
    if (!animation) return { x: 0, y: 0, width: imageWidth, height: imageHeight };

    const explicitWidth = Number.isInteger(animation.width) && animation.width! > 0 ? animation.width : undefined;
    const explicitHeight = Number.isInteger(animation.height) && animation.height! > 0 ? animation.height : undefined;
    const squareSize = Math.min(imageWidth, imageHeight);
    const width = explicitWidth ?? (explicitHeight ? imageWidth : squareSize);
    const height = explicitHeight ?? (explicitWidth ? imageHeight : squareSize);
    const firstFrame = animation.frames?.[0];
    const frameIndex = typeof firstFrame === 'number' ? firstFrame : firstFrame?.index ?? 0;
    const columns = Math.floor(imageWidth / width);
    const x = frameIndex % columns * width;
    const y = Math.floor(frameIndex / columns) * height;
    if (!columns || x + width > imageWidth || y + height > imageHeight) throw new Error('Invalid animation frame size.');
    return { x, y, width, height };
}

async function loadPreparedSprite(id: string, path: string, metadataPath?: string): Promise<PreparedSprite> {
    const [image, metadata] = await Promise.all([
        loadBitmap(path),
        metadataPath ? readJson<AnimationMetadata>(metadataPath) : Promise.resolve(null)
    ]);
    try {
        const frame = firstAnimationFrame(metadata, image.width, image.height);
        return { id: parseIdentifier(id).id, image, sourceX: frame.x, sourceY: frame.y, width: frame.width, height: frame.height };
    } catch (error) {
        image.close();
        throw error;
    }
}

function addSprite(sprites: Map<string, PreparedSprite>, sprite: PreparedSprite): void {
    sprites.get(sprite.id)?.image.close();
    sprites.set(sprite.id, sprite);
}

async function addDirectorySource(sprites: Map<string, PreparedSprite>, source: DirectorySource): Promise<void> {
    const sourcePath = source.source.replace(/^\/+|\/+$/g, '');
    const root = `${textureDirectory}${sourcePath ? `/${sourcePath}` : ''}`;
    const files = (await listAssetFiles(root)).map(file => file.replace(/\\/g, '/'));
    const fileSet = new Set(files);
    const pngFiles = files.filter(file => file.startsWith(`${root}/`) && file.endsWith('.png')).sort();

    for (let start = 0; start < pngFiles.length; start += decodeConcurrency) {
        const loaded = await Promise.allSettled(pngFiles.slice(start, start + decodeConcurrency).map(file => {
            const relative = file.slice(root.length + 1, -4);
            return loadPreparedSprite(`minecraft:${source.prefix}${relative}`, file, fileSet.has(`${file}.mcmeta`) ? `${file}.mcmeta` : undefined);
        }));
        const failed = loaded.find(result => result.status === 'rejected');
        if (failed) {
            loaded.forEach(result => {
                if (result.status === 'fulfilled') result.value.image.close();
            });
            throw failed.reason;
        }
        loaded.forEach(result => addSprite(sprites, (result as PromiseFulfilledResult<PreparedSprite>).value));
    }
}

async function addSingleSource(sprites: Map<string, PreparedSprite>, source: SingleSource): Promise<void> {
    addSprite(sprites, await loadPreparedSprite(source.sprite ?? source.resource, texturePath(source.resource)));
}

function paletteColors(image: ImageData): Uint8ClampedArray[] {
    const colors: Uint8ClampedArray[] = [];
    for (let offset = 0; offset < image.data.length; offset += 4) colors.push(image.data.slice(offset, offset + 4));
    return colors;
}

function applyPalette(image: ImageData, basePalette: Uint8ClampedArray[], targetPalette: Uint8ClampedArray[]): ImageData {
    if (basePalette.length !== targetPalette.length) throw new Error('Palette sizes do not match.');
    const colors = new Map<number, Uint8ClampedArray>();
    basePalette.forEach((color, index) => {
        if (color[3]) colors.set(color[0] << 16 | color[1] << 8 | color[2], targetPalette[index]);
    });
    const data = new Uint8ClampedArray(image.data);
    for (let offset = 0; offset < data.length; offset += 4) {
        if (!data[offset + 3]) continue;
        const color = colors.get(data[offset] << 16 | data[offset + 1] << 8 | data[offset + 2]);
        if (!color) continue;
        data[offset] = color[0];
        data[offset + 1] = color[1];
        data[offset + 2] = color[2];
        data[offset + 3] = Math.floor(data[offset + 3] * color[3] / 255);
    }
    return new ImageData(data, image.width, image.height);
}

async function addPalettedSource(sprites: Map<string, PreparedSprite>, source: PalettedPermutationsSource): Promise<void> {
    const basePalette = paletteColors(await loadImageData(palettePath(source.palette_key)));
    const palettes = await Promise.all(Object.entries(source.permutations).map(async ([name, identifier]) => [
        name,
        paletteColors(await loadImageData(palettePath(identifier)))
    ] as const));
    const separator = source.separator ?? '_';

    for (const texture of source.textures) {
        const resource = parseIdentifier(texture);
        const image = await loadImageData(texturePath(texture));
        for (const [name, palette] of palettes) {
            const bitmap = await createImageBitmap(applyPalette(image, basePalette, palette));
            addSprite(sprites, {
                id: `${resource.id}${separator}${name}`,
                image: bitmap,
                sourceX: 0,
                sourceY: 0,
                width: bitmap.width,
                height: bitmap.height
            });
        }
    }
}

async function collectSprites(definition: AtlasDefinition): Promise<Map<string, PreparedSprite>> {
    const sprites = new Map<string, PreparedSprite>();
    try {
        for (const source of definition.sources) {
            if (source.type === 'minecraft:directory') await addDirectorySource(sprites, source);
            else if (source.type === 'minecraft:single') await addSingleSource(sprites, source);
            else if (source.type === 'minecraft:paletted_permutations') await addPalettedSource(sprites, source);
            else throw new Error(`Unsupported atlas source: ${(source as { type?: unknown }).type}`);
        }
        return sprites;
    } catch (error) {
        sprites.forEach(sprite => sprite.image.close());
        throw error;
    }
}

function nextPowerOfTwo(value: number): number {
    return 2 ** Math.ceil(Math.log2(Math.max(1, value)));
}

function packSprites<T extends { width: number; height: number }>(sprites: T[]): {
    width: number;
    height: number;
    sprites: Array<PackedSprite<T>>;
} {
    const totalArea = sprites.reduce((area, sprite) => area + sprite.width * sprite.height, 0);
    const width = nextPowerOfTwo(Math.max(Math.ceil(Math.sqrt(totalArea)), ...sprites.map(sprite => sprite.width)));
    const packed: Array<PackedSprite<T>> = [];
    let x = 0;
    let y = 0;
    let rowHeight = 0;
    for (const sprite of [...sprites].sort((left, right) => right.height - left.height || right.width - left.width)) {
        if (x + sprite.width > width) {
            x = 0;
            y += rowHeight;
            rowHeight = 0;
        }
        packed.push({ ...sprite, x, y });
        x += sprite.width;
        rowHeight = Math.max(rowHeight, sprite.height);
    }
    return { width, height: nextPowerOfTwo(y + rowHeight), sprites: packed };
}

function canvasPng(canvas: HTMLCanvasElement): Promise<Uint8Array> {
    return new Promise((resolve, reject) => canvas.toBlob(blob => {
        if (!blob) return reject(new Error('Sprite atlas PNG encoding failed.'));
        void blob.arrayBuffer().then(buffer => resolve(new Uint8Array(buffer)), reject);
    }, 'image/png'));
}

async function createSpriteAtlas(name: string, definitionPath: string): Promise<void> {
    const sprites = await collectSprites(await readJson<AtlasDefinition>(definitionPath));
    try {
        if (!sprites.size) throw new Error(`Sprite atlas is empty: ${name}`);
        const packed = packSprites([...sprites.values()]);
        const canvas = document.createElement('canvas');
        canvas.width = packed.width;
        canvas.height = packed.height;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Canvas context creation failed.');
        context.imageSmoothingEnabled = false;
        packed.sprites.forEach(sprite => context.drawImage(
            sprite.image,
            sprite.sourceX,
            sprite.sourceY,
            sprite.width,
            sprite.height,
            sprite.x,
            sprite.y,
            sprite.width,
            sprite.height
        ));
        const manifest: SpriteAtlasManifest = {
            atlas: `minecraft:${name}`,
            width: packed.width,
            height: packed.height,
            sprites: packed.sprites.map(({ id, x, y, width, height }) => ({ id, x, y, width, height })).sort((left, right) => left.id.localeCompare(right.id))
        };
        const saved = await window.ipcApi.saveSpriteAtlas(name, await canvasPng(canvas), manifest);
        if (!saved.success) throw new Error(saved.error ?? `Sprite atlas save failed: ${name}`);
    } finally {
        sprites.forEach(sprite => sprite.image.close());
    }
}

async function createMissingSpriteAtlases(): Promise<void> {
    const definitionPaths = (await listAssetFiles(atlasDirectory))
        .filter(path => path.startsWith(`${atlasDirectory}/`) && path.endsWith('.json') && !path.slice(atlasDirectory.length + 1).includes('/'))
        .sort();
    if (!definitionPaths.length) throw new Error('Minecraft sprite atlas definitions were not found.');
    const statuses = await Promise.all(definitionPaths.map(async path => {
        const name = path.slice(atlasDirectory.length + 1, -5);
        const status = await window.ipcApi.hasSpriteAtlas(name);
        if (!status.success) throw new Error(status.error ?? `Sprite atlas status failed: ${name}`);
        return { name, path, missing: !status.exists };
    }));
    const missing = statuses.filter(status => status.missing);
    if (!missing.length) return;

    window.dispatchEvent(new Event('pde:creating-icon-atlases'));
    for (const atlas of missing) await createSpriteAtlas(atlas.name, atlas.path);
}

export function ensureSpriteAtlases(): Promise<void> {
    return spriteAtlasesPromise ??= createMissingSpriteAtlases();
}

if (import.meta.env.DEV) {
    const packed = packSprites([{ width: 8, height: 8 }, { width: 4, height: 4 }]);
    console.assert(
        packed.width === 16 && packed.height === 8
        && packed.sprites[0].x + packed.sprites[0].width <= packed.sprites[1].x,
        'Sprite atlas packing failed.'
    );
}
