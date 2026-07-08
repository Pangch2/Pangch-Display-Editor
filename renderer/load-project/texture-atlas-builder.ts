export type TexturePixelData = {
    w: number;
    h: number;
    data: Uint8ClampedArray;
};

export type TextureAtlasInfo = {
    width: number;
    height: number;
    data: Uint8ClampedArray;
};

type GeometryLike = {
    texPath?: string;
    uvs: number[];
    uvTransform?: [number, number, number, number];
};

type ModelLike = {
    geometries: GeometryLike[];
    blockProps?: unknown;
    itemDisplayType?: unknown;
};

type RenderItemLike = {
    type: string;
    models?: ModelLike[];
    blockProps?: unknown;
    itemDisplayType?: unknown;
    displayType?: unknown;
};

type LoadedTexture = {
    path: string;
    pixels: TexturePixelData;
};

type PackedTextureInfo = { x: number; y: number; w: number; h: number };

type CachedAtlasBuild = TextureAtlasInfo & {
    packed: Map<string, PackedTextureInfo>;
    textureTypes: Map<string, number>;
};

const MAX_ATLAS_TEXTURE_LOAD_CONCURRENCY = 256;
const atlasBuildCache = new Map<string, CachedAtlasBuild>();

function getTransparencyType(pixels: TexturePixelData): number {
    const data = pixels.data;
    let hasAlpha = false;
    let hasIntermediateAlpha = false;
    for (let i = 3; i < data.length; i += 4) {
        const alpha = data[i];
        if (alpha < 255) {
            hasAlpha = true;
            if (alpha > 0) {
                hasIntermediateAlpha = true;
                break;
            }
        }
    }
    if (hasIntermediateAlpha) return 2;
    if (hasAlpha) return 1;
    return 0;
}

function isGeometryRenderItem(item: RenderItemLike): boolean {
    return item.type === 'blockDisplay' || item.type === 'itemDisplayModel';
}

function collectTexturePaths(renderList: RenderItemLike[]): string[] {
    const texturePaths = new Set<string>();
    for (const item of renderList) {
        if (!isGeometryRenderItem(item) || !item.models) continue;
        for (const model of item.models) {
            for (const geometry of model.geometries) {
                if (geometry.texPath) texturePaths.add(geometry.texPath);
            }
        }
    }
    return [...texturePaths].sort();
}

async function loadTexturesWithLimit(
    texturePaths: string[],
    loadTexturePixels: (texPath: string) => Promise<TexturePixelData | null>
): Promise<{ loadedTextures: LoadedTexture[]; textureTypes: Map<string, number> }> {
    const loadedTextures: LoadedTexture[] = [];
    const textureTypes = new Map<string, number>();
    let cursor = 0;

    const workerCount = Math.min(MAX_ATLAS_TEXTURE_LOAD_CONCURRENCY, texturePaths.length);
    const workers = Array.from({ length: workerCount }, async () => {
        while (cursor < texturePaths.length) {
            const path = texturePaths[cursor++];
            try {
                const pixels = await loadTexturePixels(path);
                if (!pixels) continue;
                loadedTextures.push({ path, pixels });
                textureTypes.set(path, getTransparencyType(pixels));
            } catch {
                // Missing or invalid textures are ignored so the project can still load.
            }
        }
    });

    await Promise.all(workers);
    return { loadedTextures, textureTypes };
}

export async function buildTextureAtlasForRenderList(
    renderList: RenderItemLike[],
    loadTexturePixels: (texPath: string) => Promise<TexturePixelData | null>
): Promise<TextureAtlasInfo | null> {
    const texturePaths = collectTexturePaths(renderList);
    if (texturePaths.length === 0) return null;

    const atlasCacheKey = texturePaths.join('|');
    const cachedAtlas = atlasBuildCache.get(atlasCacheKey);
    if (cachedAtlas) {
        applyAtlasUvTransforms(renderList, cachedAtlas.packed, cachedAtlas.textureTypes, cachedAtlas.width, cachedAtlas.height);
        return cachedAtlas;
    }

    const { loadedTextures, textureTypes } = await loadTexturesWithLimit(texturePaths, loadTexturePixels);
    if (loadedTextures.length === 0) return null;

    loadedTextures.sort((a, b) => b.pixels.h - a.pixels.h);

    const totalArea = loadedTextures.reduce((sum, texture) => sum + texture.pixels.w * texture.pixels.h, 0);
    let atlasW = Math.max(512, Math.pow(2, Math.ceil(Math.log2(Math.sqrt(totalArea)))));
    const maxW = Math.max(...loadedTextures.map(texture => texture.pixels.w));
    if (atlasW < maxW) atlasW = Math.pow(2, Math.ceil(Math.log2(maxW)));

    const packed = new Map<string, PackedTextureInfo>();
    let x = 0;
    let y = 0;
    let rowH = 0;

    for (const texture of loadedTextures) {
        const { w, h } = texture.pixels;
        if (x + w > atlasW) {
            x = 0;
            y += rowH;
            rowH = 0;
        }
        packed.set(texture.path, { x, y, w, h });
        x += w;
        rowH = Math.max(rowH, h);
    }

    const usedAtlasH = y + rowH;
    const atlasH = Math.pow(2, Math.ceil(Math.log2(usedAtlasH)));
    const atlasData = new Uint8ClampedArray(atlasW * atlasH * 4);

    for (const texture of loadedTextures) {
        const info = packed.get(texture.path);
        if (!info) continue;
        const src = texture.pixels.data;
        const { x: packedX, y: packedY, w, h } = info;
        for (let row = 0; row < h; row++) {
            const srcStart = row * w * 4;
            const dstStart = ((packedY + row) * atlasW + packedX) * 4;
            atlasData.set(src.subarray(srcStart, srcStart + w * 4), dstStart);
        }
    }

    applyAtlasUvTransforms(renderList, packed, textureTypes, atlasW, atlasH);

    const atlasInfo: CachedAtlasBuild = {
        width: atlasW,
        height: atlasH,
        data: atlasData,
        packed,
        textureTypes
    };
    atlasBuildCache.set(atlasCacheKey, atlasInfo);

    return atlasInfo;
}

function applyAtlasUvTransforms(
    renderList: RenderItemLike[],
    packed: Map<string, PackedTextureInfo>,
    textureTypes: Map<string, number>,
    atlasW: number,
    atlasH: number
): void {
    for (const item of renderList) {
        if (!isGeometryRenderItem(item) || !item.models) continue;
        for (const model of item.models) {
            for (const geometry of model.geometries) {
                const info = geometry.texPath ? packed.get(geometry.texPath) : null;
                if (!info) continue;
                const originalTexPath = geometry.texPath as string;
                const { x: packedX, y: packedY, w, h } = info;
                const scaleX = w / atlasW;
                const scaleY = h / atlasH;
                const offsetX = packedX / atlasW;
                const offsetY = (atlasH - packedY - h) / atlasH;
                for (let i = 0; i < geometry.uvs.length; i += 2) {
                    const u = geometry.uvs[i];
                    const v = geometry.uvs[i + 1];
                    geometry.uvs[i] = u * scaleX + offsetX;
                    geometry.uvs[i + 1] = v * scaleY + offsetY;
                }
                geometry.uvTransform = [scaleX, scaleY, offsetX, offsetY];
                geometry.texPath = textureTypes.get(originalTexPath) === 2 ? '__ATLAS_TRANSLUCENT__' : '__ATLAS__';
            }
            model.blockProps = item.blockProps;
            model.itemDisplayType = item.itemDisplayType || item.displayType;
        }
    }
}
