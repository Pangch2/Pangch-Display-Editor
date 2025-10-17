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

// --- 메인 스레드용 에셋 공급자 ---

function isNodeBufferLike(content: unknown): content is { type: 'Buffer'; data: number[] } {
    return !!content && typeof content === 'object' && (content as any).type === 'Buffer' && Array.isArray((content as any).data);
}

function decodeIpcContentToString(content: unknown): string {
    try {
        if (!content) return '';
        // Node Buffer 형태
        if (isNodeBufferLike(content)) {
            return new TextDecoder('utf-8').decode(new Uint8Array(content.data));
        }
        // 브라우저 Uint8Array
        if (content instanceof Uint8Array) {
            return new TextDecoder('utf-8').decode(content);
        }
        // 그 외 객체는 toString을 시도한다.
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
        // PNG 텍스처라면 워커에서 ImageBitmap을 만들 수 있도록 원본 바이트를 반환한다.
        if (/\.png$/i.test(assetPath)) {
            const content = result.content;
            if (isNodeBufferLike(content)) {
                return new Uint8Array(content.data);
            }
            if (content instanceof Uint8Array) return content;
            if (ArrayBuffer.isView(content)) return toUint8Array(content);
            if (content instanceof ArrayBuffer) return toUint8Array(content);
            if (typeof content === 'string') {
                // 문자열로 내려온 경우 바이너리처럼 취급해 바이트 배열을 만든다.
                const bytes = new Uint8Array(content.length);
                for (let i = 0; i < content.length; i++) bytes[i] = content.charCodeAt(i) & 0xff;
                return bytes;
            }
            return content; // 형식이 불명확하면 그대로 전달한다.
        }
        // JSON 또는 텍스트 에셋은 문자열로 변환한다.
        return decodeIpcContentToString(result.content);
    }
};



// 애니메이션 프레임이 있는 블록 텍스처를 첫 16x16 타일로 잘라낸다.
function cropTextureToFirst16(tex) {
    try {
        const img = tex && tex.image;
        const w = img && img.width;
        const h = img && img.height;
        // 이미 16x16이면 픽셀 아트 설정만 적용한다.
        if (w === 16 && h === 16) {
            tex.magFilter = THREE.NearestFilter;
            tex.minFilter = THREE.NearestFilter;
            tex.generateMipmaps = false;
            tex.colorSpace = THREE.SRGBColorSpace;
            tex.needsUpdate = true;
            return tex;
        }
        // 16x16 캔버스에 좌상단 타일을 보간 없이 복사한다.
        const canvas = document.createElement('canvas');
        canvas.width = 16;
        canvas.height = 16;
        const ctx = canvas.getContext('2d');
        if (ctx) {
            ctx.imageSmoothingEnabled = false;
            if (img && w && h) {
                // 원본 이미지의 상단 좌측 타일만 크기 변환 없이 복사한다.
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

// --- 블록 텍스처 및 머티리얼 캐시(중복 로드 제거 + 재사용) ---
const blockTextureCache = new Map<string, THREE.Texture>(); // 텍스처 경로별 THREE.Texture 매핑
const blockTexturePromiseCache = new Map<string, Promise<THREE.Texture>>(); // 텍스처 경로별 로드 프라미스 매핑
const blockMaterialCache = new Map<string, THREE.Material>(); // `${texPath}|${tintHex}` 조합별 머티리얼 캐시
const blockMaterialPromiseCache = new Map<string, Promise<THREE.Material>>(); // 동일 키에 대한 생성 프라미스 캐시

// 공유 플레이스홀더 자원
let sharedPlaceholderMaterial: THREE.Material | null = null;

// 텍스처 디코더와 GC가 과부하되지 않도록 동시 디코딩을 제한한다.
const MAX_TEXTURE_DECODE_CONCURRENCY = 200;
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

// --- 플레이어 머리 텍스처 캐시 ---
const headTextureCache = new Map<string, THREE.Texture>(); // 텍스처 URL별 THREE.Texture 캐시
const headTexturePromiseCache = new Map<string, Promise<THREE.Texture>>(); // `${gen}|${url}` 키별 로드 프라미스 캐시

const dataUrlBlobCache = new Map<string, Blob | null>();
const dataUrlBlobPromiseCache = new Map<string, Promise<Blob | null>>();
const MAX_DATA_URL_BLOBS = 16;

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

// 모듈이 로드되면 바로 워밍업을 실행해 첫 디코딩 지연을 줄인다.
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
            // 엔티티 텍스처에 맞는 필터 설정을 적용한다.
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

// 리로드 이후 늦게 도착한 비동기 결과를 무시하기 위한 세대 토큰
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
        // 텍스처가 준비되기 전까지 메시마다 NodeMaterial을 만들지 않도록 가벼운 플레이스홀더를 사용한다.
        sharedPlaceholderMaterial = new THREE.MeshLambertMaterial({ transparent: true, opacity: 0 });
        sharedPlaceholderMaterial.toneMapped = false;
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
    // 동일 텍스처의 중복 로드를 방지한다.
    if (blockTextureCache.has(texPath) && gen === currentLoadGen) return blockTextureCache.get(texPath)!;
    const promiseKey = `${gen}|${texPath}`;
    if (blockTexturePromiseCache.has(promiseKey)) return blockTexturePromiseCache.get(promiseKey)!;

    const p = (async () => {
        await acquireTextureSlot();
        const texResult = await window.ipcApi.getAssetContent(texPath);
        if (!texResult.success) throw new Error(`[Texture] Failed to load ${texPath}: ${texResult.error}`);
        const bytes = decodeIpcContentToUint8Array(texResult.content);
        const blob = new Blob([bytes as any], { type: 'image/png' });
    // ImageBitmap 디코딩은 가능하면 메인 스레드 밖에서 더 빠르게 처리된다.
        try {
            const imageBitmap = await createImageBitmap(blob);
            let tex = new THREE.Texture(imageBitmap);
            const isEntityTex = texPath.includes('/textures/entity/');
            if (!isEntityTex) {
                // 애니메이션 프레임이 있다면 첫 16x16 타일만 사용한다.
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

// --- 최적화: 지오메트리 미리 생성 ---
let headGeometries: HeadGeometrySet | null = null;

export { loadedObjectGroup };

// 동일한 속성 구성을 가진 인덱스 지오메트리를 하나로 병합한다.
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

    // 공유 플레이스홀더 머티리얼이 누적되지 않도록 폐기한다.
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
            const { metadata, geometryBuffer } = msg;
            if (!(geometryBuffer instanceof SharedArrayBuffer)) {
                console.error('[Debug] geometryBuffer is not a SharedArrayBuffer. Aborting render pipeline.');
                return;
            }
            const sharedBuffer = geometryBuffer as SharedArrayBuffer;
            if (!metadata || typeof metadata !== 'object') {
                console.error('[Debug] Invalid metadata payload from worker.');
                return;
            }
            const metadataPayload = metadata as { geometries: any[]; otherItems: any[]; useUint32Indices?: boolean };
            if (!Array.isArray(metadataPayload.geometries) || !Array.isArray(metadataPayload.otherItems)) {
                console.error('[Debug] Invalid metadata payload from worker.');
                return;
            }
            const { geometries: geometryMetas, otherItems, useUint32Indices } = metadataPayload;

            console.log(`[Debug] Processing ${geometryMetas.length + otherItems.length} items from worker (binary).`);

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

                // 같은 텍스처·틴트 조합끼리 모아 한 번에 머티리얼을 할당한다.
                const materialGroups = new Map();

                for (const meta of metasForThisItem) {
                    const geom = new THREE.BufferGeometry();

                    const positions = new Float32Array(sharedBuffer, meta.posByteOffset, meta.posLen);
                    const normals = new Float32Array(sharedBuffer, meta.normByteOffset, meta.normLen);
                    const uvs = new Float32Array(sharedBuffer, meta.uvByteOffset, meta.uvLen);
                    const indices = useUint32Indices
                        ? new Uint32Array(sharedBuffer, meta.indicesByteOffset, meta.indicesLen)
                        : new Uint16Array(sharedBuffer, meta.indicesByteOffset, meta.indicesLen);

                    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
                    geom.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
                    geom.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
                    geom.setIndex(new THREE.BufferAttribute(indices, 1));

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
                                if (myGen !== currentLoadGen) return; // 오래된 결과 무시
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