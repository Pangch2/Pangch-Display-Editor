import * as THREE from 'three/webgpu';
import { type GeometryMeta, type WorkerMetadata, type GeometryInstanceBatch } from '../pbde/pbde-types';
import { loadedObjectGroup, currentLoadGen } from './display-instancing';
import { isNodeBufferLike, toUint8Array } from '../pbde/pbde-assets';
import { createEndPortalMaterial, createEntityMaterial } from '../../entity-material';

// 블록 텍스처 및 머티리얼 캐시
const blockTextureCache = new Map<string, THREE.Texture>(); // 텍스처 경로별 THREE.Texture 매핑
const blockTexturePromiseCache = new Map<string, Promise<THREE.Texture>>(); // 텍스처 경로별 로드 프라미스 매핑
const blockMaterialCache = new Map<string, THREE.Material>(); // `${texPath}|${tintHex}` 조합별 머티리얼 캐시
const blockMaterialPromiseCache = new Map<string, Promise<THREE.Material>>(); // 동일 키에 대한 생성 프라미스 캐시
// Leave room for subsequently added color variants on the same texture page.
const BLOCK_ATLAS_MIN_PAGE_SIZE = 1024;
type BlockAtlasRegion = { x: number; y: number; width: number; height: number };
type BlockAtlasPage = {
    context: CanvasRenderingContext2D;
    texture: THREE.Texture;
    index: number;
    nextX: number;
    nextY: number;
    rowHeight: number;
    regions: Map<string, BlockAtlasRegion>;
};
const blockAtlasPages = new WeakMap<THREE.Texture, BlockAtlasPage>();

// 공유 플레이스홀더 자원
export let sharedPlaceholderMaterial: THREE.Material | null = null;

// 텍스처 디코더와 GC가 과부하되지 않도록 동시 디코딩을 제한한다.
const MAX_TEXTURE_DECODE_CONCURRENCY = 512;
let currentTextureSlots = 0;
const textureSlotQueue: Array<(value?: void) => void> = [];
function acquireTextureSlot() {
    if (currentTextureSlots < MAX_TEXTURE_DECODE_CONCURRENCY) {
        currentTextureSlots++;
        return Promise.resolve();
    }
    return new Promise(res => textureSlotQueue.push(res));
}
function releaseTextureSlot() {
    const next = textureSlotQueue.shift();
    if (next) {
        next();
    } else {
        currentTextureSlots = Math.max(0, currentTextureSlots - 1);
    }
}

export function getMaterialKey(part: Pick<GeometryMeta, 'texPath' | 'tintHex'>, instancedUvTransformCount: number, instancedUvTransformIndex = 0, instancedTintIndex = -1): string {
    return `${part.texPath}|${instancedTintIndex < 0 ? (part.tintHex ?? 0xffffff) >>> 0 : `tint${instancedTintIndex}`}|${instancedUvTransformCount > 0 ? `uvt${instancedUvTransformCount}:${instancedUvTransformIndex}` : 'base'}`;
}

function isAtlasTexturePath(texPath: string): boolean {
    return texPath.startsWith('__ATLAS__') || texPath.startsWith('__ATLAS_TRANSLUCENT__');
}

function isTranslucentAtlasTexturePath(texPath: string): boolean {
    return texPath.startsWith('__ATLAS_TRANSLUCENT__');
}

function getBlockAtlasTextures(): THREE.Texture[] {
    return (loadedObjectGroup.userData.blockAtlasTextures as THREE.Texture[] | undefined)
        ?? (loadedObjectGroup.userData.blockAtlasTextures = []);
}

function getBlockAtlasPage(texPath: string): BlockAtlasPage | undefined {
    const index = Number(/PAGE_(\d+)$/.exec(texPath)?.[1]);
    const texture = Number.isInteger(index) ? getBlockAtlasTextures()[index] : undefined;
    return texture ? blockAtlasPages.get(texture) : undefined;
}

function createBlockAtlasPage(width: number, height: number): BlockAtlasPage {
    const size = Math.max(BLOCK_ATLAS_MIN_PAGE_SIZE, 2 ** Math.ceil(Math.log2(Math.max(width, height))));
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('블록 아틀라스 캔버스를 만들 수 없습니다.');
    context.imageSmoothingEnabled = false;
    const texture = new THREE.CanvasTexture(canvas);
    texture.magFilter = THREE.NearestFilter;
    texture.minFilter = THREE.NearestFilter;
    texture.generateMipmaps = false;
    texture.colorSpace = THREE.SRGBColorSpace;
    const textures = getBlockAtlasTextures();
    const page: BlockAtlasPage = { context, texture, index: textures.length, nextX: 0, nextY: 0, rowHeight: 0, regions: new Map() };
    textures.push(texture);
    blockAtlasPages.set(texture, page);
    return page;
}

function placeBlockAtlas(page: BlockAtlasPage, key: string, width: number, height: number): BlockAtlasRegion | null {
    let x = page.nextX;
    let y = page.nextY;
    let rowHeight = page.rowHeight;
    if (x + width > page.context.canvas.width) {
        x = 0;
        y += rowHeight;
        rowHeight = 0;
    }
    if (y + height > page.context.canvas.height) return null;
    const region = { x, y, width, height };
    page.nextX = x + width;
    page.nextY = y;
    page.rowHeight = Math.max(rowHeight, height);
    page.regions.set(key, region);
    return region;
}

export function addProjectBlockAtlas(atlas: NonNullable<WorkerMetadata['atlas']>): { page: BlockAtlasPage; transform: [number, number, number, number] } {
    const pages = getBlockAtlasTextures().map(texture => blockAtlasPages.get(texture)).filter(page => page !== undefined);
    for (const page of pages) {
        const region = page.regions.get(atlas.key);
        if (region) return {
            page,
            transform: [region.width / page.context.canvas.width, region.height / page.context.canvas.height, region.x / page.context.canvas.width, (page.context.canvas.height - region.y - region.height) / page.context.canvas.height]
        };
    }

    // ponytail: pages are append-only; repack only if repeated merge/undo churn makes unused regions measurable.
    let page: BlockAtlasPage | undefined;
    let region: BlockAtlasRegion | null = null;
    for (const candidate of pages) {
        region = placeBlockAtlas(candidate, atlas.key, atlas.width, atlas.height);
        if (region) {
            page = candidate;
            break;
        }
    }
    if (!page || !region) {
        page = createBlockAtlasPage(atlas.width, atlas.height);
        region = placeBlockAtlas(page, atlas.key, atlas.width, atlas.height);
    }
    if (!region) throw new Error('Block atlas does not fit in a new page.');
    page.context.putImageData(new ImageData(new Uint8ClampedArray(atlas.data), atlas.width, atlas.height), region.x, region.y);
    page.texture.needsUpdate = true;
    return {
        page,
        transform: [region.width / page.context.canvas.width, region.height / page.context.canvas.height, region.x / page.context.canvas.width, (page.context.canvas.height - region.y - region.height) / page.context.canvas.height]
    };
}

function composeAtlasTransform(
    transform: [number, number, number, number],
    pageTransform: [number, number, number, number]
): [number, number, number, number] {
    return [
        transform[0] * pageTransform[0],
        transform[1] * pageTransform[1],
        transform[2] * pageTransform[0] + pageTransform[2],
        transform[3] * pageTransform[1] + pageTransform[3]
    ];
}

if (import.meta.env.DEV) {
    const testPage = {
        context: { canvas: { width: 16, height: 16 } },
        texture: {}, index: 0, nextX: 0, nextY: 0, rowHeight: 0, regions: new Map()
    } as unknown as BlockAtlasPage;
    const firstRegion = placeBlockAtlas(testPage, 'first', 12, 8);
    const wrappedRegion = placeBlockAtlas(testPage, 'wrapped', 8, 8);
    placeBlockAtlas(testPage, 'last', 8, 8);
    console.assert(
        firstRegion?.x === 0 && firstRegion.y === 0
        && wrappedRegion?.x === 0 && wrappedRegion.y === 8
        && placeBlockAtlas(testPage, 'overflow', 1, 1) === null
        && composeAtlasTransform([0.5, 0.5, 0.25, 0.25], [0.5, 0.5, 0.25, 0.25])
            .every((value, index) => value === [0.25, 0.25, 0.375, 0.375][index]),
        'Block atlas pages must wrap, overflow, and compose UV transforms correctly.'
    );
}

export function remapBlockAtlasMetadata(
    geometryMetas: GeometryMeta[],
    geometryBatches: GeometryInstanceBatch[] | null,
    geometryBuffer: ArrayBuffer,
    atlasKey: string,
    pageIndex: number,
    pageTransform: [number, number, number, number]
): void {
    const parts = geometryBatches ? geometryBatches.flatMap(batch => batch.parts) : geometryMetas;
    for (const part of parts) {
        if (!isAtlasTexturePath(part.texPath)) continue;
        const uvs = new Float32Array(geometryBuffer, part.uvByteOffset, part.uvLen);
        for (let index = 0; index < uvs.length; index += 2) {
            uvs[index] = uvs[index] * pageTransform[0] + pageTransform[2];
            uvs[index + 1] = uvs[index + 1] * pageTransform[1] + pageTransform[3];
        }
        if (part.uvTransform) part.uvTransform = composeAtlasTransform(part.uvTransform, pageTransform);
        part.atlasKey = atlasKey;
        part.texPath = `${isTranslucentAtlasTexturePath(part.texPath) ? '__ATLAS_TRANSLUCENT__' : '__ATLAS__'}PAGE_${pageIndex}`;
    }
    for (const batch of geometryBatches ?? []) for (const instance of batch.instances) {
        if (instance.atlasUvTransform) instance.atlasUvTransform = composeAtlasTransform(instance.atlasUvTransform, pageTransform);
        if (instance.atlasUvTransforms) instance.atlasUvTransforms = instance.atlasUvTransforms.map(transform => composeAtlasTransform(transform, pageTransform));
    }
}



export function disposeTexture(tex: THREE.Texture | null | undefined): void {
    if (!tex) return;
    try {
        const img = tex.image || tex.source?.data;
        if (img && typeof img.close === 'function') {
            try { img.close(); } catch { /* ignore */ }
        }
    } catch { /* ignore */ }
    try { tex.dispose(); } catch { /* ignore */ }
}

export function ensureSharedPlaceholder(): void {
    if (!sharedPlaceholderMaterial) {
        // 텍스처가 준비되기 전까지 메시마다 NodeMaterial을 만들지 않도록 가벼운 플레이스홀더를 사용한다.
        sharedPlaceholderMaterial = new THREE.MeshLambertMaterial({ transparent: true, opacity: 0 });
        sharedPlaceholderMaterial.toneMapped = false;
        sharedPlaceholderMaterial.fog = false;
        sharedPlaceholderMaterial.flatShading = true;
        sharedPlaceholderMaterial.alphaTest = 0.01; // 투명 플레이스홀더가 보이지 않도록 작은 alphaTest 값을 사용한다.
    }
}

function decodeIpcContentToUint8Array(content: unknown): Uint8Array {
    try {
        if (!content) return new Uint8Array();
        if (isNodeBufferLike(content)) {
            return new Uint8Array(content.data);
        }
        if (content instanceof Uint8Array) return content;
        if (ArrayBuffer.isView(content)) return toUint8Array(content);
        if (content instanceof ArrayBuffer) return toUint8Array(content);
    // 최후 수단으로 문자열로 변환한 뒤 다시 인코딩한다.
        const str = String(content);
        const enc = new TextEncoder();
        return enc.encode(str);
    } catch {
        return new Uint8Array();
    }
}

async function loadBlockTexture(texPath: string, gen: number): Promise<THREE.Texture> {
    if (isAtlasTexturePath(texPath)) {
        const page = getBlockAtlasPage(texPath);
        if (page) return page.texture;
        throw new Error("Atlas requested but not loaded");
    }
    // 동일 텍스처의 중복 로드를 방지한다.
    if (blockTextureCache.has(texPath) && gen === currentLoadGen) return blockTextureCache.get(texPath)!;
    const promiseKey = `${gen}|${texPath}`;
    if (blockTexturePromiseCache.has(promiseKey)) return blockTexturePromiseCache.get(promiseKey)!;

    const p = (async () => {
        await acquireTextureSlot();
        const texResult = await window.ipcApi.getAssetContent(texPath);
        if (!texResult.success) throw new Error(`[Texture] Failed to load ${texPath}: ${texResult.error}`);
        const bytes = decodeIpcContentToUint8Array(texResult.content);
        const blob = new Blob([bytes as unknown as BlobPart], { type: 'image/png' });
    // ImageBitmap 디코딩은 가능하면 메인 스레드 밖에서 더 빠르게 처리된다.
        try {
            const imageBitmap = await createImageBitmap(blob);
            let tex = new THREE.Texture(imageBitmap);
            const isEntityTex = texPath.includes('/textures/entity/');
            
            tex.magFilter = THREE.NearestFilter;
            tex.minFilter = THREE.NearestFilter;
            tex.generateMipmaps = false;
            tex.colorSpace = THREE.SRGBColorSpace;
            if (isEntityTex) {
                tex.anisotropy = 1;
                tex.wrapS = THREE.ClampToEdgeWrapping;
                tex.wrapT = THREE.ClampToEdgeWrapping;
            }
            tex.needsUpdate = true;

            // 로딩 중 세대 토큰이 바뀌면 폐기하고 캐시에 저장하지 않는다.
            if (gen !== currentLoadGen) {
                disposeTexture(tex);
                throw new Error('Stale generation');
            }
            blockTextureCache.set(texPath, tex);
            return tex;
        } finally {
            releaseTextureSlot();
        }
    })();

    blockTexturePromiseCache.set(promiseKey, p);
    try {
        const tex = await p;
        return tex;
    } finally {
        blockTexturePromiseCache.delete(promiseKey);
    }
}

enum TransparencyType {
    Opaque = 0,
    Cutout = 1,
    Translucent = 2
}

function analyzeTextureTransparency(texture: THREE.Texture): TransparencyType {
    if (texture.userData.transparencyType !== undefined) {
        return texture.userData.transparencyType;
    }

    try {
        const image = texture.image;
        if (!image || !image.width || !image.height) return TransparencyType.Opaque;

        const width = image.width;
        const height = image.height;
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        
        if (!ctx) return TransparencyType.Opaque;
        
        ctx.drawImage(image, 0, 0);
        const imgData = ctx.getImageData(0, 0, width, height);
        const data = imgData.data;
        
        let hasAlpha = false;
        let hasIntermediateAlpha = false;

        for (let i = 3; i < data.length; i += 4) {
            const alpha = data[i];
            if (alpha < 255) {
                hasAlpha = true;
                if (alpha > 0 && alpha < 250) { 
                    hasIntermediateAlpha = true;
                    break; 
                }
            }
        }

        let type = TransparencyType.Opaque;
        if (hasIntermediateAlpha) {
            type = TransparencyType.Translucent;
        } else if (hasAlpha) {
            type = TransparencyType.Cutout;
        }

        texture.userData.transparencyType = type;
        return type;

    } catch (e) {
        console.warn("Texture analysis failed:", e);
        return TransparencyType.Opaque;
    }
}

export async function getBlockMaterial(texPath: string, tintHex: number | undefined, gen: number, instancedUvTransformCount = 0, instancedUvTransformIndex = 0, instancedTintIndex = -1): Promise<THREE.Material> {
    // undefined는 흰색(0xffffff)으로 정규화하여 캐시 키 불일치를 방지한다.
    const effectiveTint = (tintHex ?? 0xffffff) >>> 0;
    const key = getMaterialKey({ texPath, tintHex }, instancedUvTransformCount, instancedUvTransformIndex, instancedTintIndex);
    if (blockMaterialCache.has(key) && gen === currentLoadGen) {
        const mat = blockMaterialCache.get(key)!;
        // 아틀라스 텍스처가 변경되었으면 stale 항목을 캐시에서 제거하고 재생성한다.
        if (isAtlasTexturePath(texPath) && mat.map !== getBlockAtlasPage(texPath)?.texture) {
            blockMaterialCache.delete(key);
        } else {
            return mat;
        }
    }
    const promiseKey = `${gen}|${key}`;
    if (blockMaterialPromiseCache.has(promiseKey)) return blockMaterialPromiseCache.get(promiseKey)!;

    const p = (async () => {
        const endPortalLayerCount = effectiveTint === 0xffffffff ? 16 : effectiveTint === 0xfeffffff ? 15 : 0;
        if (endPortalLayerCount) {
            const [endSkyTexture, endPortalTexture] = await Promise.all([
                loadBlockTexture('assets/minecraft/textures/environment/end_sky.png', gen),
                loadBlockTexture('assets/minecraft/textures/entity/end_portal/end_portal.png', gen)
            ]);
            for (const texture of [endSkyTexture, endPortalTexture]) {
                texture.wrapS = THREE.RepeatWrapping;
                texture.wrapT = THREE.RepeatWrapping;
                texture.needsUpdate = true;
            }
            const material = createEndPortalMaterial(endSkyTexture, endPortalTexture, endPortalLayerCount, true);
            blockMaterialCache.set(key, material);
            return material;
        }

        const tex = await loadBlockTexture(texPath, gen);
        const { material } = createEntityMaterial(tex, effectiveTint, false, instancedUvTransformCount > 0, instancedUvTransformCount, instancedUvTransformIndex, false, true, undefined, instancedTintIndex);
        material.toneMapped = false;
        material.fog = false;
        material.flatShading = true;
        material.vertexColors = true; // Bake tint into geometry

        // 텍스처 분석을 통한 투명도 및 렌더링 설정 자동화
        let transparencyType = TransparencyType.Opaque;
        if (isTranslucentAtlasTexturePath(texPath)) {
            transparencyType = TransparencyType.Translucent;
        } else if (isAtlasTexturePath(texPath)) {
            transparencyType = TransparencyType.Cutout;
        } else {
            transparencyType = analyzeTextureTransparency(tex);
        }
        
        if (transparencyType === TransparencyType.Translucent) {
            // 반투명 (유리, 물, 얼음 등)
            material.transparent = true;
            material.depthWrite = true; 
            material.alphaTest = 0;
        } else if (transparencyType === TransparencyType.Cutout) {
            // 컷아웃 (잔디, 꽃, 묘목, 나뭇잎 등)
            material.transparent = false; 
            material.depthWrite = true;
            material.alphaTest = 0.1;
        } else {
            // 불투명 (일반 블록)
            material.transparent = false;
            material.depthWrite = true;
            material.alphaTest = 0;
            material.side = THREE.FrontSide;
        }

        if (gen !== currentLoadGen) {
            // 오래된 세대 결과면 즉시 폐기하고 캐시에 넣지 않는다.
            try { material.dispose(); } catch {}
            throw new Error('Stale generation');
        }
        blockMaterialCache.set(key, material);
        return material;
    })();

    blockMaterialPromiseCache.set(promiseKey, p);
    try {
        const m = await p;
        return m;
    } finally {
        blockMaterialPromiseCache.delete(promiseKey);
    }
}



export function clearBlockRenderResources(): void {
    blockMaterialCache.forEach(mat => { try { mat.dispose(); } catch {} });
    blockMaterialCache.clear();
    blockMaterialPromiseCache.clear();
    blockTextureCache.forEach(tex => { try { disposeTexture(tex); } catch {} });
    blockTextureCache.clear();
    blockTexturePromiseCache.clear();
    if (sharedPlaceholderMaterial) { try { sharedPlaceholderMaterial.dispose(); } catch {} }
    sharedPlaceholderMaterial = null;
}

export function clearBlockMaterialPromises(): void {
    blockMaterialPromiseCache.clear();
}
