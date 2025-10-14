import { openWithAnimation, closeWithAnimation } from '../ui-open-close.js';
import * as THREE from 'three/webgpu';
import PbdeWorker from './pbde-worker?worker&inline';
import { createEntityMaterial } from '../entityMaterial.js';

type AssetPayload = string | Uint8Array | ArrayBuffer | unknown;
type OptimizedTexture = THREE.Texture & { __optimizedSetupDone?: boolean };
type ModalOverlayElement = HTMLDivElement & { escHandler?: (event: KeyboardEvent) => void };

interface HeadGeometrySet {
    base: THREE.BufferGeometry;
    layer: THREE.BufferGeometry;
    merged: THREE.BufferGeometry | null;
}

// --- Asset Provider for Main Thread ---

function isNodeBufferLike(content: unknown): content is { type: 'Buffer'; data: number[] } {
    return !!content && typeof content === 'object' && (content as any).type === 'Buffer' && Array.isArray((content as any).data);
}

function decodeIpcContentToString(content: unknown): string {
    try {
        if (!content) return '';
        // Node Buffer-like
        if (isNodeBufferLike(content)) {
            return new TextDecoder('utf-8').decode(new Uint8Array(content.data));
        }
        // Browser Uint8Array
        if (content instanceof Uint8Array) {
            return new TextDecoder('utf-8').decode(content);
        }
        // Try generic
        if (typeof (content as { toString?: (encoding?: string) => string }).toString === 'function') {
            const toStringFn = (content as { toString: (encoding?: string) => string }).toString;
            try {
                return toStringFn.call(content, 'utf-8');
            } catch {
                return toStringFn.call(content);
            }
        }
        return String(content);
    } catch {
        return String(content);
    }
}

function toUint8Array(input: ArrayBuffer | ArrayBufferView): Uint8Array {
    if (input instanceof ArrayBuffer) {
        return new Uint8Array(input);
    }
    const view = input as ArrayBufferView;
    const copy = new Uint8Array(view.byteLength);
    copy.set(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
    return copy;
}

const mainThreadAssetProvider: { getAsset(assetPath: string): Promise<AssetPayload> } = {
    async getAsset(assetPath: string): Promise<AssetPayload> {
        const isHardcoded = assetPath.startsWith('hardcoded/');
        const result = isHardcoded
            ? await window.ipcApi.getHardcodedContent(assetPath.replace(/^hardcoded\//, ''))
            : await window.ipcApi.getAssetContent(assetPath);
        if (!result.success) throw new Error(`Asset read failed: ${assetPath}: ${result.error}`);
        // If this is a PNG texture, return raw binary so the worker can create ImageBitmap
        if (/\.png$/i.test(assetPath)) {
            const content = result.content;
            if (isNodeBufferLike(content)) {
                return new Uint8Array(content.data);
            }
            if (content instanceof Uint8Array) return content;
            if (ArrayBuffer.isView(content)) return toUint8Array(content);
            if (content instanceof ArrayBuffer) return toUint8Array(content);
            if (typeof content === 'string') {
                // Fallback: treat as binary string
                const bytes = new Uint8Array(content.length);
                for (let i = 0; i < content.length; i++) bytes[i] = content.charCodeAt(i) & 0xff;
                return bytes;
            }
            return content; // Unknown but pass through
        }
        // JSON / text assets
        return decodeIpcContentToString(result.content);
    }
};



// Crop any block texture to the first 16x16 tile (e.g., when a texture is 16x64 with repeated 16x16 frames)
function cropTextureToFirst16(tex) {
    try {
        const img = tex && tex.image;
        const w = img && img.width;
        const h = img && img.height;
        // If already 16x16, just enforce pixel-art settings and return
        if (w === 16 && h === 16) {
            tex.magFilter = THREE.NearestFilter;
            tex.minFilter = THREE.NearestFilter;
            tex.generateMipmaps = false;
            tex.colorSpace = THREE.SRGBColorSpace;
            tex.needsUpdate = true;
            return tex;
        }
        // Create a 16x16 canvas and draw the top-left tile without smoothing
        const canvas = document.createElement('canvas');
        canvas.width = 16;
        canvas.height = 16;
        const ctx = canvas.getContext('2d');
        if (ctx) {
            ctx.imageSmoothingEnabled = false;
            if (img && w && h) {
                // Copy the source image (up to 16x16) without stretching
                const sWidth = Math.min(w || 0, 16);
                const sHeight = Math.min(h || 0, 16);
                ctx.drawImage(img, 0, 0, sWidth, sHeight, 0, 0, sWidth, sHeight);
            }
        }
        const newTex = new THREE.Texture(canvas);
        newTex.magFilter = THREE.NearestFilter;
        newTex.minFilter = THREE.NearestFilter;
        newTex.generateMipmaps = false;
        newTex.colorSpace = THREE.SRGBColorSpace;
        newTex.needsUpdate = true;
        return newTex;
    } catch (e) {
        if (tex) {
            tex.magFilter = THREE.NearestFilter;
            tex.minFilter = THREE.NearestFilter;
            tex.generateMipmaps = false;
            tex.colorSpace = THREE.SRGBColorSpace;
            tex.needsUpdate = true;
        }
        return tex;
    }
}

let worker: Worker | null = null;
// 로드된 모든 객체를 담을 그룹
const loadedObjectGroup = new THREE.Group();

// 텍스처 로더 및 캐시
const textureCache = new Map<string, THREE.Texture>();

// --- Block texture/material caches (dedupe loads + reuse materials) ---
const blockTextureCache = new Map<string, THREE.Texture>(); // texPath -> THREE.Texture
const blockTexturePromiseCache = new Map<string, Promise<THREE.Texture>>(); // texPath -> Promise<THREE.Texture>
const blockMaterialCache = new Map<string, THREE.Material>(); // key: `${texPath}|${tintHex}` -> THREE.Material
const blockMaterialPromiseCache = new Map<string, Promise<THREE.Material>>(); // same key -> Promise<THREE.Material>

// Shared placeholder assets
let sharedPlaceholderMaterial: THREE.Material | null = null;

// Limit concurrent texture decodes to avoid overwhelming the decoder/GC
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

// --- Player head texture caches ---
const headTextureCache = new Map<string, THREE.Texture>(); // url -> THREE.Texture
const headTexturePromiseCache = new Map<string, Promise<THREE.Texture>>(); // `${gen}|${url}` -> Promise<THREE.Texture>

const dataUrlBlobCache = new Map<string, Blob | null>();
const dataUrlBlobPromiseCache = new Map<string, Promise<Blob | null>>();
const MAX_DATA_URL_BLOBS = 32;

async function dataUrlToBlob(dataUrl: string): Promise<Blob | null> {
    if (!dataUrl) return null;
    if (dataUrlBlobCache.has(dataUrl)) return dataUrlBlobCache.get(dataUrl);
    if (dataUrlBlobPromiseCache.has(dataUrl)) return dataUrlBlobPromiseCache.get(dataUrl);
    const p = (async () => {
        try {
            const response = await fetch(dataUrl);
            if (!response.ok) return null;
            const blob = await response.blob();
            dataUrlBlobCache.set(dataUrl, blob);
            if (dataUrlBlobCache.size > MAX_DATA_URL_BLOBS) {
                const oldestKey = dataUrlBlobCache.keys().next().value as string | undefined;
                if (oldestKey) {
                    dataUrlBlobCache.delete(oldestKey);
                }
            }
            return blob;
        } catch {
            return null;
        } finally {
            dataUrlBlobPromiseCache.delete(dataUrl);
        }
    })();
    dataUrlBlobPromiseCache.set(dataUrl, p);
    return p;
}

const PLAYER_HEAD_WARMUP_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAGgwJ/lWdftQAAAABJRU5ErkJggg=='
let playerHeadWarmupPromise: Promise<boolean> | null = null;

function ensurePlayerHeadImageBitmapWarmup(): Promise<boolean> {
    if (playerHeadWarmupPromise) return playerHeadWarmupPromise;
    if (typeof createImageBitmap !== 'function') {
        playerHeadWarmupPromise = Promise.resolve(false);
        return playerHeadWarmupPromise;
    }
    playerHeadWarmupPromise = (async () => {
        try {
            const blob = await dataUrlToBlob(PLAYER_HEAD_WARMUP_DATA_URL);
            if (!blob) return false;
            const bitmap = await createImageBitmap(blob);
            if (bitmap && typeof bitmap.close === 'function') {
                try { bitmap.close(); } catch { /* ignore */ }
            }
            return true;
        } catch {
            return false;
        }
    })();
    return playerHeadWarmupPromise;
}

// Kick off the warmup as soon as the module loads so the first real decode is faster.
ensurePlayerHeadImageBitmapWarmup();

async function loadPlayerHeadTexture(url: string, gen: number): Promise<THREE.Texture> {
    if (headTextureCache.has(url) && gen === currentLoadGen) return headTextureCache.get(url)!;
    const promiseKey = `${gen}|${url}`;
    if (headTexturePromiseCache.has(promiseKey)) return headTexturePromiseCache.get(promiseKey)!;

    const p = (async () => {
        await ensurePlayerHeadImageBitmapWarmup();
        await acquireTextureSlot();
        try {
            let blob: Blob | null;
            if (url.startsWith('data:')) {
                blob = await dataUrlToBlob(url);
                if (!blob) throw new Error('Invalid data URL');
            } else {
                const resp = await fetch(url, { mode: 'cors', cache: 'no-store' });
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                blob = await resp.blob();
            }
            if (!blob) throw new Error('Texture decode failed: empty blob');

            const imageBitmap = await createImageBitmap(blob);
            const tex = new THREE.Texture(imageBitmap);
            // Entity texture settings
            tex.magFilter = THREE.NearestFilter;
            tex.minFilter = THREE.NearestFilter;
            tex.generateMipmaps = false;
            tex.anisotropy = 1;
            tex.colorSpace = THREE.SRGBColorSpace;
            tex.wrapS = THREE.ClampToEdgeWrapping;
            tex.wrapT = THREE.ClampToEdgeWrapping;
            tex.needsUpdate = true;

            if (gen !== currentLoadGen) {
                disposeTexture(tex);
                throw new Error('Stale generation');
            }
            headTextureCache.set(url, tex);
            return tex;
        } finally {
            releaseTextureSlot();
        }
    })();

    headTexturePromiseCache.set(promiseKey, p);
    try {
        return await p;
    } finally {
        headTexturePromiseCache.delete(promiseKey);
    }
}

// Load generation token to ignore late async results after reload
let currentLoadGen = 0;

function disposeTexture(tex: THREE.Texture | null | undefined): void {
    if (!tex) return;
    try {
        const img = tex.image || tex.source?.data;
        if (img && typeof img.close === 'function') {
            try { img.close(); } catch { /* ignore */ }
        }
    } catch { /* ignore */ }
    try { tex.dispose(); } catch { /* ignore */ }
}

function ensureSharedPlaceholder(): void {
    if (!sharedPlaceholderMaterial) {
        // Lightweight placeholder material to avoid creating NodeMaterial per mesh before texture loads
        sharedPlaceholderMaterial = new THREE.MeshLambertMaterial({ transparent: true, opacity: 0 });
        sharedPlaceholderMaterial.toneMapped = false;
        sharedPlaceholderMaterial.alphaTest = 0.01; // Use a small alphaTest for transparent placeholders
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
        // Fallback: try toString and encode
        const str = String(content);
        const enc = new TextEncoder();
        return enc.encode(str);
    } catch {
        return new Uint8Array();
    }
}

async function loadBlockTexture(texPath: string, gen: number): Promise<THREE.Texture> {
    // Deduplicate concurrent loads
    if (blockTextureCache.has(texPath) && gen === currentLoadGen) return blockTextureCache.get(texPath)!;
    const promiseKey = `${gen}|${texPath}`;
    if (blockTexturePromiseCache.has(promiseKey)) return blockTexturePromiseCache.get(promiseKey)!;

    const p = (async () => {
        await acquireTextureSlot();
        const texResult = await window.ipcApi.getAssetContent(texPath);
        if (!texResult.success) throw new Error(`[Texture] Failed to load ${texPath}: ${texResult.error}`);
        const bytes = decodeIpcContentToUint8Array(texResult.content);
        const blob = new Blob([bytes as any], { type: 'image/png' });
        // ImageBitmap decode is faster and off-main-thread where possible
        try {
            const imageBitmap = await createImageBitmap(blob);
            let tex = new THREE.Texture(imageBitmap);
            const isEntityTex = texPath.includes('/textures/entity/');
            if (!isEntityTex) {
                // Crop to 16x16 tile for block atlases with animation frames
                const cropped = cropTextureToFirst16(tex);
                if (cropped !== tex) {
                    disposeTexture(tex);
                    tex = cropped;
                }
            } else {
                tex.magFilter = THREE.NearestFilter;
                tex.minFilter = THREE.NearestFilter;
                tex.generateMipmaps = false;
                tex.anisotropy = 1;
                tex.colorSpace = THREE.SRGBColorSpace;
                tex.wrapS = THREE.ClampToEdgeWrapping;
                tex.wrapT = THREE.ClampToEdgeWrapping;
                tex.needsUpdate = true;
            }
            // If generation changed while loading, dispose and abort caching
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

async function getBlockMaterial(texPath: string, tintHex: number | undefined, gen: number): Promise<THREE.Material> {
    const key = `${texPath}|${(tintHex >>> 0)}`;
    if (blockMaterialCache.has(key) && gen === currentLoadGen) return blockMaterialCache.get(key)!;
    const promiseKey = `${gen}|${key}`;
    if (blockMaterialPromiseCache.has(promiseKey)) return blockMaterialPromiseCache.get(promiseKey)!;

    const p = (async () => {
        const tex = await loadBlockTexture(texPath, gen);
        const { material } = createEntityMaterial(tex, tintHex ?? 0xffffff);
        material.toneMapped = false;
        if (gen !== currentLoadGen) {
            // Stale: dispose immediately (do not cache)
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

// --- 최적화: 지오메트리 미리 생성 ---
let headGeometries: HeadGeometrySet | null = null;

export { loadedObjectGroup };

// Merge multiple indexed BufferGeometries with identical attribute layouts
function mergeIndexedGeometries(geometries: THREE.BufferGeometry[]): THREE.BufferGeometry | null {
    if (!geometries || geometries.length === 0) return null;
    const first = geometries[0];
    const merged = new THREE.BufferGeometry();

    const attrNames = Object.keys(first.attributes);

    let totalVertices = 0;
    const itemSizes: Record<string, number> = {};
    const arrayTypes: Record<string, any> = {};
    for (const g of geometries) {
        const pos = g.getAttribute('position') as THREE.BufferAttribute;
        const count = pos.count;
        totalVertices += count;
        for (const name of attrNames) {
            const attr = g.getAttribute(name) as THREE.BufferAttribute;
            itemSizes[name] = attr.itemSize;
            arrayTypes[name] = attr.array.constructor;
        }
    }

    for (const name of attrNames) {
        const itemSize = itemSizes[name];
        const ArrayType = arrayTypes[name] || Float32Array;
        const totalLen = totalVertices * itemSize;
        const mergedArray = new ArrayType(totalLen);
        let offset = 0;
        for (const g of geometries) {
            const attr = g.getAttribute(name) as THREE.BufferAttribute;
            mergedArray.set(attr.array, offset);
            offset += attr.array.length;
        }
        merged.setAttribute(name, new THREE.BufferAttribute(mergedArray, itemSize));
    }

    let vertexOffset = 0;
    let totalIndexCount = 0;
    for (const g of geometries) {
        const index = g.getIndex();
        if (!index) continue;
        totalIndexCount += index.array.length;
    }
    const useUint32 = totalVertices > 65535;
    const mergedIndex = useUint32 ? new Uint32Array(totalIndexCount) : new Uint16Array(totalIndexCount);
    let idxOffset = 0;
    for (const g of geometries) {
        const index = g.getIndex();
        if (!index) continue;
        const idxArray = index.array;
        const pos = g.getAttribute('position') as THREE.BufferAttribute;
        const vertCount = pos.count;
        for (let i = 0; i < idxArray.length; i++) {
            mergedIndex[idxOffset + i] = idxArray[i] + vertexOffset;
        }
        idxOffset += idxArray.length;
        vertexOffset += vertCount;
    }
    merged.setIndex(new THREE.BufferAttribute(mergedIndex, 1));

    merged.boundingSphere = new THREE.Sphere(new THREE.Vector3(0.5, 0.5, 0.5), 0.9);
    return merged;
}


/**
 * 주의: BoxGeometry는 인덱스가 있는 BufferGeometry를 반환합니다.
 * 병합을 위해 toNonIndexed()로 변환한 뒤 attribute들을 concat 합니다.
 */
function mergeNonIndexedGeometries(geometries: THREE.BufferGeometry[]): THREE.BufferGeometry | null {
    // 모든 geometry는 non-indexed 상태여야 한다 (toNonIndexed()로 보장)
    if (!geometries || geometries.length === 0) return null;

    const first = geometries[0];
    const merged = new THREE.BufferGeometry();

    // 합쳐야 할 attribute 이름 목록을 수집 (position, normal, uv 등)
    const attrNames = Object.keys(first.attributes);

    attrNames.forEach(name => {
        const arrays = [];
        let itemSize = null;
        let ArrayType = Float32Array;

        for (const g of geometries) {
            const attr = g.getAttribute(name) as THREE.BufferAttribute | null;
            if (!attr) {
                console.warn(`mergeNonIndexedGeometries: geometry missing attribute ${name}`);
                continue;
            }
            arrays.push(attr.array);
            itemSize = attr.itemSize;
            ArrayType = attr.array.constructor; // 유지되는 typed array 타입 사용
        }

        // 총 길이 계산
        const totalLen = arrays.reduce((s, a) => s + a.length, 0);
        const mergedArray = new ArrayType(totalLen);
        let offset = 0;
        for (const a of arrays) {
            mergedArray.set(a, offset);
            offset += a.length;
        }
        if (itemSize != null) {
            merged.setAttribute(name, new THREE.BufferAttribute(mergedArray, itemSize));
        }
    });

    // 인덱스는 이미 non-indexed 이므로 설정할 필요 없음
    merged.computeBoundingBox();
    merged.computeBoundingSphere();
    return merged;
}

/**
 * 재사용 가능한 머리 지오메트리들을 생성하고 UV를 한 번만 설정합니다.
 */
function createHeadGeometries() {
    if (headGeometries) return; // 이미 생성되었다면 실행하지 않음

    const createGeometry = (isLayer: boolean): THREE.BoxGeometry => {
        const scale = isLayer ? 1.0625 : 1.0;
        const geometry = new THREE.BoxGeometry(scale, scale, scale);
        geometry.translate(0, -0.5, 0);
        

        const w = 64; // 텍스처 너비
        const h = 64; // 텍스처 높이

        const faceUVs = {
            right:  [16, 8, 8, 8],
            left:   [0, 8, 8, 8],
            top:    [8, 0, 8, 8],
            bottom: [16, 0, 8, 8],
            front:  [24, 8, 8, 8],
            back:   [8, 8, 8, 8]
        };

        const layerUVs = {
            right:  [48, 8, 8, 8],
            left:   [32, 8, 8, 8],
            top:    [40, 0, 8, 8],
            bottom: [48, 0, 8, 8],
            front:  [56, 8, 8, 8],
            back:   [40, 8, 8, 8]
        };

    const uvs = (isLayer ? layerUVs : faceUVs) as typeof faceUVs;
        const order: Array<keyof typeof faceUVs> = ['left', 'right', 'top', 'bottom', 'front', 'back'];
        const uvAttr = geometry.getAttribute('uv') as THREE.BufferAttribute;

        for (let i = 0; i < order.length; i++) {
            const faceName = order[i];
            const [x, y, width, height] = uvs[faceName];
            const inset = 0.0078125;
            
            const u0 = (x + inset) / w;
            const v0 = 1 - (y + height - inset) / h;
            const u1 = (x + width - inset) / w;
            const v1 = 1 - (y + inset) / h;

            const faceIndex = i * 4;
            
            if (faceName === 'top') {
                uvAttr.setXY(faceIndex + 0, u1, v0);
                uvAttr.setXY(faceIndex + 1, u0, v0);
                uvAttr.setXY(faceIndex + 2, u1, v1);
                uvAttr.setXY(faceIndex + 3, u0, v1);
            } else if (faceName === 'bottom') {
                uvAttr.setXY(faceIndex + 0, u1, v1);
                uvAttr.setXY(faceIndex + 1, u0, v1);
                uvAttr.setXY(faceIndex + 2, u1, v0);
                uvAttr.setXY(faceIndex + 3, u0, v0);
            } else {
                uvAttr.setXY(faceIndex + 0, u0, v1);
                uvAttr.setXY(faceIndex + 1, u1, v1);
                uvAttr.setXY(faceIndex + 2, u0, v0);
                uvAttr.setXY(faceIndex + 3, u1, v0);
            }
        }
        // uvAttr.needsUpdate는 최초 한 번만 설정하면 됩니다.
        // three.js가 내부적으로 처리하므로 매번 true로 설정할 필요가 없습니다.
        return geometry;
    };

    const base = createGeometry(false);
    const layer = createGeometry(true);

    // 병합 지오메트리 생성 (non-indexed로 변환 후 concat)
    try {
        const baseNI = base.toNonIndexed();
        const layerNI = layer.toNonIndexed();
        const merged = mergeNonIndexedGeometries([baseNI, layerNI]);
        headGeometries = {
            base: base,
            layer: layer,
            merged: merged
        };
    } catch (err) {
        console.warn("createHeadGeometries: merge failed, falling back to separate geometries", err);
        headGeometries = {
            base: base,
            layer: layer,
            merged: null
        };
    }
}


/**
 * WebGPU에 최적화된 마인크래프트 머리 모델을 생성합니다.
 * 미리 생성된 지오메트리를 사용하여 성능을 향상시킵니다.
 * @param {THREE.Texture} texture - 64x64 머리 텍스처
 * @param {boolean} isLayer - (호환용) true면 layer 지오메트리, false면 base 지오메트리 반환
 * @returns {THREE.Mesh} 최적화된 머리 메시 객체
 */
const materialCache = new WeakMap<THREE.Texture, THREE.Material>();


/**
 * 병합된(merged) 지오메트리를 사용하는 단일 메시 생성 (base+layer -> 1 draw call)
 */
function createOptimizedHeadMerged(texture: THREE.Texture): THREE.Mesh {
    if (!headGeometries) {
        createHeadGeometries();
    }
    const geometry = (headGeometries?.merged || headGeometries?.base) ?? new THREE.BoxGeometry(1, 1, 1);

    const tex = texture as OptimizedTexture;
    if (!tex.__optimizedSetupDone) {
        tex.magFilter = THREE.NearestFilter;
        tex.minFilter = THREE.NearestFilter;
        tex.generateMipmaps = false;
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.__optimizedSetupDone = true;
    }

    let material = materialCache.get(texture);
    if (!material) {
        const matData = createEntityMaterial(texture);
        material = matData.material;
        material.toneMapped = false;
        materialCache.set(texture, material);
    }

    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    return mesh;
}


/**
 * PBDE 파일을 로드하고 3D 씬에 객체를 배치합니다.
 * @param {File} file - 불러올 .pbde 또는 .bde 파일
 */
function loadpbde(file: File): void {
    // 1. 이전 객체 및 리소스 완벽 해제
    const myGen = ++currentLoadGen;
    
    // 1-1. 캐시된 텍스처 및 리소스 완벽 해제
    textureCache.forEach(cachedItem => {
        if (cachedItem && cachedItem instanceof THREE.Texture) {
            cachedItem.dispose();
        }
    });
    textureCache.clear();

    // 1-1-b. 블럭 텍스처/머티리얼 캐시 해제 및 초기화
    blockMaterialCache.forEach((mat) => { try { mat.dispose(); } catch {} });
    blockMaterialCache.clear();
    blockMaterialPromiseCache.clear();
    blockTextureCache.forEach((tex) => { try { disposeTexture(tex); } catch {} });
    blockTextureCache.clear();
    blockTexturePromiseCache.clear();

    // 1-1-c. 플레이어 헤드 텍스처 캐시 해제 및 초기화
    headTextureCache.forEach((tex) => { try { disposeTexture(tex); } catch {} });
    headTextureCache.clear();
    headTexturePromiseCache.clear();

    // Dispose shared placeholder material so it doesn't accumulate
    if (sharedPlaceholderMaterial) { try { sharedPlaceholderMaterial.dispose(); } catch {} }
    sharedPlaceholderMaterial = null;

    // 1-2. 씬에 있는 객체의 지오메트리 및 재질 해제
    loadedObjectGroup.traverse(object => {
        if (object.isMesh) {
            // 최적화: 재사용되는 지오메트리는 dispose하지 않도록 예외 처리
            if (object.geometry && object.geometry !== headGeometries?.base && object.geometry !== headGeometries?.layer && object.geometry !== headGeometries?.merged) {
                object.geometry.dispose();
            }
            if (object.material) {
                const materials = Array.isArray(object.material) ? object.material : [object.material];
                materials.forEach(material => {
                    if (material.map) {
                        material.map.dispose();
                    }
                    material.dispose();
                });
            }
        }
    });

    // 1-3. 그룹에서 모든 자식 객체 제거
    while (loadedObjectGroup.children.length > 0) {
        loadedObjectGroup.remove(loadedObjectGroup.children[0]);
    }

    // 1-4. Three.js 전역 캐시 비우기
    THREE.Cache.clear();

    if (worker) {
        worker.terminate();
    }
    // 2. 웹 워커 생성
    worker = new PbdeWorker();

    // --- 최적화: 머리 지오메트리 생성 (필요한 경우) ---
    createHeadGeometries();
    ensurePlayerHeadImageBitmapWarmup();

    worker.onmessage = (e) => {
        const msg = e.data;

        if (msg.type === 'requestAsset') {
            mainThreadAssetProvider.getAsset(msg.path)
                .then(content => {
                    worker.postMessage({ 
                        type: 'assetResponse', 
                        requestId: msg.requestId, 
                        path: msg.path, 
                        content: content, 
                        success: true 
                    });
                })
                .catch(error => {
                    worker.postMessage({ 
                        type: 'assetResponse', 
                        requestId: msg.requestId, 
                        path: msg.path, 
                        error: error.message, 
                        success: false 
                    });
                });
            return;
        }

        if (msg.success) {
            const { metadata: metadataString, geometryBuffer } = msg;
            const { geometries: geometryMetas, otherItems, useUint32Indices } = JSON.parse(metadataString);

            console.log(`[Debug] Processing ${geometryMetas.length + otherItems.length} items from worker (binary).`);

            const applyMatrixToGeometry = (geom, mat4) => {
                const pos = geom.getAttribute('position');
                const nor = geom.getAttribute('normal');
                const v = new THREE.Vector3();
                const n = new THREE.Vector3();
                const normalMat = new THREE.Matrix3().getNormalMatrix(mat4);
                for (let i = 0; i < pos.count; i++) {
                    v.fromBufferAttribute(pos, i).applyMatrix4(mat4);
                    pos.setXYZ(i, v.x, v.y, v.z);
                    if (nor) {
                        n.fromBufferAttribute(nor, i).applyMatrix3(normalMat).normalize();
                        nor.setXYZ(i, n.x, n.y, n.z);
                    }
                }
                pos.needsUpdate = true;
                if (nor) nor.needsUpdate = true;
                geom.computeBoundingBox();
                geom.computeBoundingSphere();
            };

            const itemsById = new Map();
            for (const meta of geometryMetas) {
                if (!itemsById.has(meta.itemId)) {
                    itemsById.set(meta.itemId, []);
                }
                itemsById.get(meta.itemId).push(meta);
            }

            for (const [itemId, metasForThisItem] of itemsById.entries()) {
                const finalGroup = new THREE.Group();
                finalGroup.matrixAutoUpdate = false;
                const finalMatrix = new THREE.Matrix4();
                finalMatrix.fromArray(metasForThisItem[0].transform);
                finalMatrix.transpose();
                finalGroup.matrix.copy(finalMatrix);
                ensureSharedPlaceholder();

                const materialGroups = new Map();

                for (const meta of metasForThisItem) {
                    const geom = new THREE.BufferGeometry();

                    const positions = new Float32Array(geometryBuffer, meta.posByteOffset, meta.posLen);
                    const normals = new Float32Array(geometryBuffer, meta.normByteOffset, meta.normLen);
                    const uvs = new Float32Array(geometryBuffer, meta.uvByteOffset, meta.uvLen);
                    const indices = useUint32Indices
                        ? new Uint32Array(geometryBuffer, meta.indicesByteOffset, meta.indicesLen)
                        : new Uint16Array(geometryBuffer, meta.indicesByteOffset, meta.indicesLen);

                    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
                    geom.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
                    geom.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
                    geom.setIndex(new THREE.BufferAttribute(indices, 1));

                    const modelMatrix = new THREE.Matrix4().fromArray(meta.modelMatrix);
                    applyMatrixToGeometry(geom, modelMatrix);

                    const key = `${meta.texPath}|${(meta.tintHex ?? 0xffffff) >>> 0}`;
                    let entry = materialGroups.get(key);
                    if (!entry) {
                        entry = { texPath: meta.texPath, tintHex: meta.tintHex ?? 0xffffff, geoms: [] };
                        materialGroups.set(key, entry);
                    }
                    entry.geoms.push(geom);
                }

                for (const entry of materialGroups.values()) {
                    const mergedGeom = entry.geoms.length > 1 ? mergeIndexedGeometries(entry.geoms) : entry.geoms[0];
                    if (mergedGeom && entry.geoms.length > 1) {
                        for (const g of entry.geoms) if (g !== mergedGeom) g.dispose();
                    }
                    if (mergedGeom) {
                        if (!mergedGeom.boundingBox) mergedGeom.computeBoundingBox();
                        if (!mergedGeom.boundingSphere) mergedGeom.computeBoundingSphere();

                        const placeholderMaterial = (sharedPlaceholderMaterial as THREE.Material);
                        const mesh = new THREE.Mesh(mergedGeom, placeholderMaterial);
                        mesh.castShadow = false;
                        mesh.receiveShadow = false;
                        finalGroup.add(mesh);

                        (async () => {
                            try {
                                const mat = await getBlockMaterial(entry.texPath, entry.tintHex, myGen);
                                if (myGen !== currentLoadGen) return; // stale
                                mesh.material = mat;
                                mesh.material.needsUpdate = true;
                            } catch (e) {
                                console.warn(`[Texture] Error while loading ${entry.texPath}:`, e);
                            }
                        })();
                    }
                }
                loadedObjectGroup.add(finalGroup);
            }

            const playerHeadItems: Array<any> = [];
            otherItems.forEach((item) => {
                if (item.type === 'itemDisplay' && item.textureUrl) {
                    playerHeadItems.push(item);
                }
            });

            if (playerHeadItems.length > 0) {
                (async () => {
                    try {
                        const headGroups = await Promise.all(playerHeadItems.map(async (item) => {
                            const headGroup = new THREE.Group();
                            headGroup.userData.isPlayerHead = true;
                            headGroup.userData.gen = myGen;

                            const finalMatrix = new THREE.Matrix4();
                            finalMatrix.fromArray(item.transform);
                            finalMatrix.transpose();
                            const scaleMatrix = new THREE.Matrix4().makeScale(0.5, 0.5, 0.5);
                            finalMatrix.multiply(scaleMatrix);
                            headGroup.matrixAutoUpdate = false;
                            headGroup.matrix.copy(finalMatrix);

                            try {
                                const tex = await loadPlayerHeadTexture(item.textureUrl, myGen);
                                headGroup.add(createOptimizedHeadMerged(tex));
                            } catch (err) {
                                console.error('플레이어 헤드 텍스처 로드 실패:', err);
                            }

                            return headGroup;
                        }));

                        if (myGen !== currentLoadGen) {
                            return;
                        }

                        headGroups.forEach((group) => {
                            if (group) {
                                loadedObjectGroup.add(group);
                            }
                        });
                    } catch (err) {
                        console.error('플레이어 헤드 생성 처리 실패:', err);
                    }
                })();
            }

            console.log(`[Debug] Finished processing. Total objects in group: ${loadedObjectGroup.children.length}`);
        } else {
            console.error("[Debug] Worker reported an error:", msg.error);
        }

        console.log("[Debug] Terminating worker.");
        worker.terminate();
        worker = null;
    };

    worker.onerror = (error) => {
        console.error("Worker Error:", error);
        worker.terminate();
        worker = null;
    };

    const reader = new FileReader();
    reader.onload = (event: ProgressEvent<FileReader>) => {
        if (myGen !== currentLoadGen) {
            return;
        }
        const result = event.target?.result;
        if (typeof result === 'string' && worker) {
            worker.postMessage(result);
        }
    };
    reader.readAsText(file);
}


// 파일 드래그 앤 드롭 처리 로직

function createDropModal(file?: File) {
    const existingModal = document.getElementById('drop-modal-overlay');
    if (existingModal) {
        existingModal.remove();
    }
    const modalOverlay = document.createElement('div') as ModalOverlayElement;
    modalOverlay.id = 'drop-modal-overlay';
    Object.assign(modalOverlay.style, {
        position: 'fixed',
        top: 0,
        left: 0,
        width: '100%',
        height: '100%',
        background: 'rgba(0, 0, 0, 0.6)',
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        zIndex: 10000
    });

    const modalContent = document.createElement('div');
    Object.assign(modalContent.style, {
        background: '#2a2a2e',
        padding: '30px',
        borderRadius: '12px',
        border: '1px solid #3a3a3e',
        textAlign: 'center',
        boxShadow: '0 5px 15px rgba(0,0,0,0.3)',
    });
    
    openWithAnimation(modalContent);

    modalContent.innerHTML = `
        <h3 style="margin-top: 0; color: #f0f0f0;">프로젝트 파일 감지됨</h3>
        <p style="color: #aaa; margin-bottom: 25px;">어떻게 열건가요?</p>
        <div style="display: flex; gap: 15px;">
            <button id="new-project-btn" class="ui-button">프로젝트 열기</button>
            <button id="merge-project-btn" class="ui-button">프로젝트 합치기</button>
        </div>
    `;

    modalOverlay.appendChild(modalContent);
    document.body.appendChild(modalOverlay);

    modalOverlay.addEventListener('click', (e) => {
        if (e.target === modalOverlay) {
            closeDropModal();
        }
    });
    const handleEscKey = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
            closeDropModal();
        }
    };
    modalOverlay.escHandler = handleEscKey;
    document.addEventListener('keydown', handleEscKey);

    const newProjectBtn = document.getElementById('new-project-btn') as HTMLButtonElement | null;
    if (newProjectBtn) {
        newProjectBtn.addEventListener('click', () => {
            if (file) {
                loadpbde(file);
            }
            closeDropModal();
        });
    }

    const mergeProjectBtn = document.getElementById('merge-project-btn') as HTMLButtonElement | null;
    if (mergeProjectBtn) {
        mergeProjectBtn.addEventListener('click', () => {
            if (file) {
                loadpbde(file);
            }
            closeDropModal();
        });
    }
}

function closeDropModal() {
    const modal = document.getElementById('drop-modal-overlay') as ModalOverlayElement | null;
    if (modal) {
        if (modal.escHandler) {
            document.removeEventListener('keydown', modal.escHandler);
        }

        const modalContent = modal.querySelector('div');
        if (modalContent) {
            closeWithAnimation(modalContent).then(() => {
                modal.remove();
            });
        } else {
            modal.remove();
        }
    }
}

window.addEventListener('dragover', (e) => {
    e.preventDefault();
});

window.addEventListener('drop', (e) => {
    e.preventDefault();
    
    let droppedFile = null;
    if (e.dataTransfer.items) {
        for (const item of e.dataTransfer.items) {
            if (item.kind === 'file') {
                const file = item.getAsFile();
                const extension = file.name.split('.').pop().toLowerCase();
                if (extension === 'bdengine' || extension === 'pdengine') {
                    droppedFile = file;
                    break; 
                }
            }
        }
    } else {
        for (const file of e.dataTransfer.files) {
            const extension = file.name.split('.').pop().toLowerCase();
            if (extension === 'bdengine' || extension === 'pdengine') {
                droppedFile = file;
                break;
            }
        }
    }

    if (droppedFile) {
        createDropModal(droppedFile);
    }
});