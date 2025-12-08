import { openWithAnimation, closeWithAnimation } from '../ui-open-close.js';
import * as THREE from 'three/webgpu';
import PbdeWorker from './pbde-worker?worker&inline';
import { createEntityMaterial } from '../entityMaterial.js';

type AssetPayload = string | Uint8Array | ArrayBuffer | unknown;
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
// function cropTextureToFirst16(tex) { ... } // Removed as per request

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
let currentAtlasTexture: THREE.Texture | null = null;

// 공유 플레이스홀더 자원
let sharedPlaceholderMaterial: THREE.Material | null = null;

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
    if (texPath === '__ATLAS__' || texPath === '__ATLAS_TRANSLUCENT__') {
        if (currentAtlasTexture) return currentAtlasTexture;
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
        const blob = new Blob([bytes as any], { type: 'image/png' });
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

async function getBlockMaterial(texPath: string, tintHex: number | undefined, gen: number): Promise<THREE.Material> {
    const key = `${texPath}|${(tintHex >>> 0)}`;
    if (blockMaterialCache.has(key) && gen === currentLoadGen) {
        const mat = blockMaterialCache.get(key)!;
        // 아틀라스 텍스처가 변경되었는지 확인 (프로젝트 병합 시 발생 가능)
        if (texPath.includes('__ATLAS__') && mat.map !== currentAtlasTexture) {
            // 캐시된 머티리얼이 이전 아틀라스를 사용 중이므로 무시하고 새로 생성
        } else {
            return mat;
        }
    }
    const promiseKey = `${gen}|${key}`;
    if (blockMaterialPromiseCache.has(promiseKey)) return blockMaterialPromiseCache.get(promiseKey)!;

    const p = (async () => {
        const tex = await loadBlockTexture(texPath, gen);
        const { material } = createEntityMaterial(tex, tintHex ?? 0xffffff);
        material.toneMapped = false;
        material.fog = false;
        material.flatShading = true;

        // 텍스처 분석을 통한 투명도 및 렌더링 설정 자동화
        let transparencyType = TransparencyType.Opaque;
        if (texPath === '__ATLAS__') {
            transparencyType = TransparencyType.Cutout;
        } else if (texPath === '__ATLAS_TRANSLUCENT__') {
            transparencyType = TransparencyType.Translucent;
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

// --- 최적화: 지오메트리 미리 생성 ---
let headGeometries: HeadGeometrySet | null = null;

// 🚀 최적화 3: 지오메트리 공유 - 동일한 블록 모델 재사용
const geometryCache = new Map<string, THREE.BufferGeometry>();
const geometryCachePromises = new Map<string, Promise<THREE.BufferGeometry>>();

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

    // 병합 지오메트리 생성 (indexed)
    try {
        const merged = mergeIndexedGeometries([base, layer]);
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
 * 텍스처의 특정 UV 영역이 완전히 투명한지 확인합니다.
 * @param texture - 검사할 텍스처
 * @param uvRegions - 검사할 UV 좌표 배열 [x, y, width, height]
 * @returns 모든 픽셀이 투명하면 true
 */
function isLayerTransparent(img: HTMLImageElement, uvRegions: number[][]): boolean {
    try {
        if (!img || !img.width || !img.height) return false;

        // Canvas를 사용하여 픽셀 데이터 추출
        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) return false;

        ctx.drawImage(img, 0, 0);
        
        // 각 UV 영역을 검사
        for (const [x, y, width, height] of uvRegions) {
            const imageData = ctx.getImageData(x, y, width, height);
            const data = imageData.data;
            
            // 알파 채널 검사 (RGBA의 A)
            for (let i = 3; i < data.length; i += 4) {
                if (data[i] > 0) {
                    // 투명하지 않은 픽셀 발견
                    return false;
                }
            }
        }
        
        return true; // 모든 픽셀이 투명함
    } catch (err) {
        console.warn('Layer transparency check failed:', err);
        return false; // 오류 발생 시 투명하지 않다고 가정
    }
}

/**
 * PBDE 파일을 로드하고 3D 씬에 객체를 배치합니다.
 * @param {File} file - 불러올 .pbde 또는 .bde 파일
 */
function _clearSceneAndCaches(): void {
    // 1-1. 캐시된 텍스처 및 리소스 완벽 해제
    if (currentAtlasTexture) {
        currentAtlasTexture.dispose();
        currentAtlasTexture = null;
    }
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



    // 1-1-d. 지오메트리 캐시 해제
    geometryCache.forEach((geo) => { try { geo.dispose(); } catch {} });
    geometryCache.clear();
    geometryCachePromises.clear();

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
}

function _loadAndRenderPbde(file: File, isMerge: boolean): void {
    // 0. 새 프로젝트를 로드하기 전에 현재 선택 상태를 리셋합니다.
    if (loadedObjectGroup.userData.resetSelection) {
        loadedObjectGroup.userData.resetSelection();
    }

    const myGen = ++currentLoadGen;

    if (!isMerge) {
        _clearSceneAndCaches();
    } else {
        // 프로젝트 병합 시, 머티리얼 캐시를 초기화하여 새로운 아틀라스가 적용되도록 한다.
        // 기존 객체들은 이미 생성된 머티리얼을 참조하고 있으므로 영향받지 않는다.
        blockMaterialCache.clear();
        blockMaterialPromiseCache.clear();
        
        // 이전 프로젝트의 아틀라스 텍스처 참조를 제거
        currentAtlasTexture = null;
        // 이전 프로젝트의 아틀라스 텍스처 참조를 제거하여, 새 프로젝트 로드 실패 시 이전 아틀라스를 사용하는 것을 방지
        currentAtlasTexture = null;
    }
    
    if (worker) {
        worker.terminate();
    }
    
    worker = new PbdeWorker();

    createHeadGeometries();

    worker.onmessage = async (e) => {
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
            const metadataPayload = metadata as { geometries: any[]; otherItems: any[]; useUint32Indices?: boolean; atlas?: any };
            if (!Array.isArray(metadataPayload.geometries) || !Array.isArray(metadataPayload.otherItems)) {
                console.error('[Debug] Invalid metadata payload from worker.');
                return;
            }
            const { geometries: geometryMetas, otherItems, useUint32Indices, atlas } = metadataPayload;

            if (atlas) {
                try {
                    const imageData = new ImageData(new Uint8ClampedArray(atlas.data), atlas.width, atlas.height);
                    const tex = new THREE.Texture(await createImageBitmap(imageData));
                    tex.magFilter = THREE.NearestFilter;
                    tex.minFilter = THREE.NearestFilter;
                    tex.generateMipmaps = false;
                    tex.colorSpace = THREE.SRGBColorSpace;
                    tex.needsUpdate = true;
                    currentAtlasTexture = tex;
                } catch (e) {
                    console.warn("Failed to create atlas texture", e);
                }
            }

            console.log(`[Debug] Processing ${geometryMetas.length + otherItems.length} items from worker (binary).`);

            const instancedGeometries = new Map<string, THREE.BufferGeometry>();
            const instancedMaterials = new Map<string, THREE.Material>();
            const materialPromises = new Map<string, Promise<THREE.Material>>();
            
            // Grouping structure: GeometryId -> InstanceTransformString -> PartMeta[]
            const blocks = new Map<string, Map<string, any[]>>();

            ensureSharedPlaceholder();
            const placeholderMaterial = sharedPlaceholderMaterial as THREE.Material;

            for (const meta of geometryMetas) {
                const geomKey = `${meta.geometryId}|${meta.geometryIndex}`;
                let geometry = instancedGeometries.get(geomKey);

                if (!geometry) {
                    geometry = new THREE.BufferGeometry();
                    const positions = new Float32Array(sharedBuffer, meta.posByteOffset, meta.posLen);
                    const normals = new Float32Array(sharedBuffer, meta.normByteOffset, meta.normLen);
                    const uvs = new Float32Array(sharedBuffer, meta.uvByteOffset, meta.uvLen);
                    const indices = useUint32Indices
                        ? new Uint32Array(sharedBuffer, meta.indicesByteOffset, meta.indicesLen)
                        : new Uint16Array(sharedBuffer, meta.indicesByteOffset, meta.indicesLen);

                    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
                    geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
                    geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
                    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
                    geometry.computeBoundingSphere();
                    instancedGeometries.set(geomKey, geometry);
                }

                const geomId = meta.geometryId;
                // Use itemId as key to identify the instance uniquely
                const instanceKey = String(meta.itemId);
                
                let geomGroup = blocks.get(geomId);
                if (!geomGroup) {
                    geomGroup = new Map();
                    blocks.set(geomId, geomGroup);
                }
                
                let instanceParts = geomGroup.get(instanceKey);
                if (!instanceParts) {
                    instanceParts = [];
                    geomGroup.set(instanceKey, instanceParts);
                }
                instanceParts.push(meta);
            }

            // --- BatchedMesh Logic for Atlas ---
            if (currentAtlasTexture) {
                const batchGroups = {
                    opaque: { parts: [] as any[], maxVerts: 0, maxIndices: 0, geometries: new Map<string, THREE.BufferGeometry>() },
                    translucent: { parts: [] as any[], maxVerts: 0, maxIndices: 0, geometries: new Map<string, THREE.BufferGeometry>() }
                };

                // 1. Collect parts and calculate requirements
                // blocks: Map<geomId, Map<instanceKey, PartMeta[]>>
                // We iterate safely and remove parts that are moved to batch
                
                const partsToMerge = new Map<string, { type: 'opaque' | 'translucent', parts: any[] }>();

                for (const [geomId, instancesMap] of blocks) {
                    for (const [instanceKey, parts] of instancesMap) {
                        const keepParts = [];
                        for (const part of parts) {
                            let type: 'opaque' | 'translucent' | null = null;
                            if (part.texPath === '__ATLAS__') type = 'opaque';
                            else if (part.texPath === '__ATLAS_TRANSLUCENT__') type = 'translucent';

                            if (type) {
                                // Group key: itemId + type + tint
                                const key = `${instanceKey}|${type}|${part.tintHex ?? 0xffffff}`;
                                if (!partsToMerge.has(key)) {
                                    partsToMerge.set(key, { type, parts: [] });
                                }
                                partsToMerge.get(key)!.parts.push(part);
                            } else {
                                keepParts.push(part);
                            }
                        }
                        
                        if (keepParts.length > 0) {
                            instancesMap.set(instanceKey, keepParts);
                        } else {
                            instancesMap.delete(instanceKey);
                        }
                    }
                    if (instancesMap.size === 0) {
                        blocks.delete(geomId);
                    }
                }

                // Process merged parts and add to batchGroups
                for (const [key, { type, parts }] of partsToMerge) {
                    const targetGroup = type === 'opaque' ? batchGroups.opaque : batchGroups.translucent;
                    
                    if (parts.length === 1) {
                        // Single part, no merge needed
                        const part = parts[0];
                        targetGroup.parts.push(part);
                        const geomKey = `${part.geometryId}|${part.geometryIndex}`;
                        if (!targetGroup.geometries.has(geomKey)) {
                            const geo = instancedGeometries.get(geomKey)!;
                            targetGroup.geometries.set(geomKey, geo);
                            targetGroup.maxVerts += geo.attributes.position.count;
                            targetGroup.maxIndices += (geo.index ? geo.index.count : 0);
                        }
                    } else {
                        // Merge needed
                        const geometriesToMerge: THREE.BufferGeometry[] = [];
                        for (const part of parts) {
                            const geomKey = `${part.geometryId}|${part.geometryIndex}`;
                            const geo = instancedGeometries.get(geomKey)!;
                            const clone = geo.clone();
                            if (part.modelMatrix) {
                                const m = new THREE.Matrix4().fromArray(part.modelMatrix);
                                clone.applyMatrix4(m);
                            }
                            geometriesToMerge.push(clone);
                        }
                        
                        const mergedGeo = mergeIndexedGeometries(geometriesToMerge);
                        if (mergedGeo) {
                            const uniqueId = `merged|${key}`;
                            const finalGeomKey = `${uniqueId}|0`;
                            instancedGeometries.set(finalGeomKey, mergedGeo);
                            
                            const firstPart = parts[0];
                            const newPart = {
                                ...firstPart,
                                geometryId: uniqueId,
                                geometryIndex: 0,
                                modelMatrix: null // Baked into geometry
                            };
                            
                            targetGroup.parts.push(newPart);
                            
                            if (!targetGroup.geometries.has(finalGeomKey)) {
                                targetGroup.geometries.set(finalGeomKey, mergedGeo);
                                targetGroup.maxVerts += mergedGeo.attributes.position.count;
                                targetGroup.maxIndices += (mergedGeo.index ? mergedGeo.index.count : 0);
                            }
                        }
                    }
                }

                // 2. Create BatchedMeshes
                const createBatchedMesh = async (group: typeof batchGroups.opaque, texPath: string) => {
                    if (group.parts.length === 0) return;

                    try {
                        const material = await getBlockMaterial(texPath, undefined, myGen);
                        // BatchedMesh(maxInstanceCount, maxVertexCount, maxIndexCount, material)
                        const batch = new THREE.BatchedMesh(group.parts.length, group.maxVerts, group.maxIndices, material);
                        batch.frustumCulled = false;
                        batch.userData.displayType = 'block_display'; 
                        batch.userData.displayTypes = new Map();
                        batch.userData.geometryBounds = new Map();
                        batch.userData.instanceGeometryIds = [];
                        batch.userData.itemIds = new Map();
                        batch.userData.localMatrices = new Map();

                        // Register geometries
                        const geomIdMap = new Map<string, number>();
                        for (const [key, geo] of group.geometries) {
                            // Use raw geometry without baking modelMatrix
                            // modelMatrix (blockstate rotation, display transform) will be applied to instance matrix
                            const batchGeomId = batch.addGeometry(geo);
                            geomIdMap.set(key, batchGeomId);

                            if (!geo.boundingBox) geo.computeBoundingBox();
                            batch.userData.geometryBounds.set(batchGeomId, geo.boundingBox.clone());
                        }

                        // Add instances
                        const dummyMatrix = new THREE.Matrix4();
                        const localMatrix = new THREE.Matrix4();
                        const color = new THREE.Color();
                        
                        for (const part of group.parts) {
                            const geomKey = `${part.geometryId}|${part.geometryIndex}`;
                            const batchGeomId = geomIdMap.get(geomKey);
                            if (batchGeomId === undefined) continue;

                            const instanceId = batch.addInstance(batchGeomId);
                            batch.userData.instanceGeometryIds[instanceId] = batchGeomId;
                            
                            // part.transform is the instance matrix (world transform, row-major from worker -> transpose)
                            dummyMatrix.fromArray(part.transform).transpose();
                            
                            // part.modelMatrix is the local transform (blockstate, display settings, column-major)
                            if (part.modelMatrix) {
                                localMatrix.fromArray(part.modelMatrix);
                                dummyMatrix.multiply(localMatrix);

                                batch.userData.localMatrices.set(instanceId, localMatrix.clone());
                            }

                            batch.setMatrixAt(instanceId, dummyMatrix);

                            const tint = part.tintHex ?? 0xffffff;
                            color.setHex(tint);
                            batch.setColorAt(instanceId, color);

                            if (batch.userData.displayTypes) {
                                batch.userData.displayTypes.set(instanceId, part.isItemDisplayModel ? 'item_display' : 'block_display');
                            }
                            if (batch.userData.itemIds && part.itemId !== undefined) {
                                batch.userData.itemIds.set(instanceId, part.itemId);
                            }
                        }

                        loadedObjectGroup.add(batch);
                        
                        if (material.transparent) {
                            batch.renderOrder = 1;
                        }

                    } catch (e) {
                        console.error("Failed to create BatchedMesh", e);
                    }
                };

                await createBatchedMesh(batchGroups.opaque, '__ATLAS__');
                await createBatchedMesh(batchGroups.translucent, '__ATLAS_TRANSLUCENT__');
            }

            // Process grouped blocks
            for (const [geomId, instancesMap] of blocks) {
                // Group instances by Signature (combination of parts and materials)
                const signatureGroups = new Map<string, { parts: any[], matrices: THREE.Matrix4[] }>();

                for (const [matrixStr, parts] of instancesMap) {
                    // Sort parts by geometryIndex to ensure consistent order
                    parts.sort((a, b) => a.geometryIndex - b.geometryIndex);

                    // Create Signature (modelMatrix 포함하여 facing 등 blockstate 정보 반영)
                    const signature = parts.map(p => 
                        `${p.geometryIndex}|${p.texPath}|${p.tintHex ?? 0xffffff}|${p.modelMatrix.join(',')}`
                    ).join('||');

                    let group = signatureGroups.get(signature);
                    if (!group) {
                        group = { parts: parts, matrices: [] };
                        signatureGroups.set(signature, group);
                    }
                    
                    // Reconstruct instance matrix
                    const matrix = new THREE.Matrix4().fromArray(parts[0].transform).transpose();
                    group.matrices.push(matrix);
                }

                // Create InstancedMesh for each signature group
                for (const [sig, group] of signatureGroups) {
                    const representativeParts = group.parts;
                    const matrices = group.matrices;

                    // Merge Geometries
                    const geometriesToMerge: THREE.BufferGeometry[] = [];
                    const materials: THREE.Material[] = [];
                    const matPromisesForMesh: Promise<THREE.Material>[] = [];

                    for (const part of representativeParts) {
                        const geomKey = `${part.geometryId}|${part.geometryIndex}`;
                        const baseGeo = instancedGeometries.get(geomKey)!;
                        
                        // Clone and apply local transform (modelMatrix)
                        const clonedGeo = baseGeo.clone();
                        const localMatrix = new THREE.Matrix4().fromArray(part.modelMatrix);
                        clonedGeo.applyMatrix4(localMatrix);
                        geometriesToMerge.push(clonedGeo);

                        // Prepare Material
                        const matKey = `${part.texPath}|${(part.tintHex ?? 0xffffff) >>> 0}`;
                        let material = instancedMaterials.get(matKey);
                        
                        if (!material) {
                            // If not loaded, use placeholder and load it
                            material = placeholderMaterial;
                            if (!materialPromises.has(matKey)) {
                                const p = getBlockMaterial(part.texPath, part.tintHex, myGen).then(m => {
                                    if (myGen === currentLoadGen) {
                                        instancedMaterials.set(matKey, m);
                                    }
                                    return m;
                                });
                                materialPromises.set(matKey, p);
                            }
                            matPromisesForMesh.push(materialPromises.get(matKey)!);
                        } else {
                            matPromisesForMesh.push(Promise.resolve(material));
                        }
                        materials.push(material);
                    }

                    const mergedGeo = mergeIndexedGeometries(geometriesToMerge);
                    if (mergedGeo) {
                        // Add groups for multi-material support
                        let start = 0;
                        for (let i = 0; i < geometriesToMerge.length; i++) {
                            const count = geometriesToMerge[i].getIndex()!.count;
                            mergedGeo.addGroup(start, count, i);
                            start += count;
                        }

                        const instancedMesh = new THREE.InstancedMesh(mergedGeo, materials, matrices.length);
                        
                        // Use metadata from worker to determine display type
                        if (representativeParts[0].isItemDisplayModel) {
                            instancedMesh.userData.displayType = 'item_display';
                        } else {
                            instancedMesh.userData.displayType = 'block_display';
                        }
                        
                        instancedMesh.frustumCulled = false;

                        for (let i = 0; i < matrices.length; i++) {
                            instancedMesh.setMatrixAt(i, matrices[i]);
                        }
                        instancedMesh.instanceMatrix.needsUpdate = true;
                        instancedMesh.computeBoundingSphere();
                        loadedObjectGroup.add(instancedMesh);

                        // Handle async material loading
                        if (matPromisesForMesh.length > 0) {
                            Promise.all(matPromisesForMesh).then(loadedMats => {
                                if (myGen === currentLoadGen) {
                                    instancedMesh.material = loadedMats;
                                    // Check transparency
                                    if (loadedMats.some(m => m.transparent)) {
                                        instancedMesh.renderOrder = 1;
                                    }
                                }
                            }).catch(e => {
                                console.warn(`[Texture] Error loading materials for ${geomId}:`, e);
                            });
                        } else {
                             if (materials.some(m => m.transparent)) {
                                instancedMesh.renderOrder = 1;
                            }
                        }
                    }
                }
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
                        if (!headGeometries || !headGeometries.merged) {
                            console.error("Head geometries not available for instancing.");
                            return;
                        }

                        const uniqueUrls = [...new Set(playerHeadItems.map(item => item.textureUrl))];
                        
                        const ATLAS_SIZE = 2048;
                        const PART_SIZE = 8;
                        const PART_BLOCK_WIDTH = PART_SIZE * 3;
                        const PART_BLOCK_HEIGHT = PART_SIZE * 4;
                        const BLOCKS_PER_ROW = Math.floor(ATLAS_SIZE / PART_BLOCK_WIDTH);

                        const atlasCanvas = document.createElement('canvas');
                        atlasCanvas.width = ATLAS_SIZE;
                        atlasCanvas.height = ATLAS_SIZE;
                        const atlasCtx = atlasCanvas.getContext('2d');
                        if (!atlasCtx) return;
                        atlasCtx.imageSmoothingEnabled = false;

                        const skinLayouts = new Map<string, { x: number, y: number }>();
                        const skinTransparency = new Map<string, boolean>(); // URL -> isLayerTransparent
                        
                        const faceParts = {
                            right:  { s: [16, 8] }, left:   { s: [0, 8] },
                            top:    { s: [8, 0] },  bottom: { s: [16, 0] },
                            front:  { s: [24, 8] }, back:   { s: [8, 8] },
                            layer_right:  { s: [48, 8] }, layer_left:   { s: [32, 8] },
                            layer_top:    { s: [40, 0] }, layer_bottom: { s: [48, 0] },
                            layer_front:  { s: [56, 8] }, layer_back:   { s: [40, 8] }
                        };
                        const partOrder = Object.keys(faceParts);

                        const layerRegions = [
                            [48, 8, 8, 8], [32, 8, 8, 8],
                            [40, 0, 8, 8], [48, 0, 8, 8],
                            [56, 8, 8, 8], [40, 8, 8, 8]
                        ];

                        const imagePromises = uniqueUrls.map((url, index) => {
                            return new Promise<void>((resolve, reject) => {
                                const img = new Image();
                                img.crossOrigin = 'anonymous';
                                img.onload = () => {
                                    const blockX = (index % BLOCKS_PER_ROW) * PART_BLOCK_WIDTH;
                                    const blockY = Math.floor(index / BLOCKS_PER_ROW) * PART_BLOCK_HEIGHT;
                                    skinLayouts.set(url, { x: blockX, y: blockY });
                                    
                                    // Check transparency
                                    const isTransparent = isLayerTransparent(img, layerRegions);
                                    skinTransparency.set(url, isTransparent);

                                    partOrder.forEach((key, i) => {
                                        const part = faceParts[key as keyof typeof faceParts];
                                        const dx = (i % 3) * PART_SIZE;
                                        const dy = Math.floor(i / 3) * PART_SIZE;
                                        atlasCtx.drawImage(img, part.s[0], part.s[1], 8, 8, blockX + dx, blockY + dy, 8, 8);
                                    });
                                    resolve();
                                };
                                img.onerror = (e) => reject(new Error(`Failed to load image: ${url}, error: ${e}`));
                                img.src = url.replace('http://', 'https://');
                            });
                        });

                        await Promise.all(imagePromises);

                        const atlasTexture = new THREE.Texture(atlasCanvas);
                        atlasTexture.needsUpdate = true;
                        atlasTexture.magFilter = THREE.NearestFilter;
                        atlasTexture.minFilter = THREE.NearestFilter;
                        atlasTexture.colorSpace = THREE.SRGBColorSpace;
                        
                        const atlasMaterial = createEntityMaterial(atlasTexture, 0xffffff, true).material;
                        atlasMaterial.toneMapped = false;
                        atlasMaterial.fog = false;
                        atlasMaterial.flatShading = true;
                        atlasMaterial.side = THREE.DoubleSide;
                        
                        const sharedGeometry = (headGeometries.merged as THREE.BufferGeometry).clone();
                        const newUvAttr = sharedGeometry.getAttribute('uv') as THREE.BufferAttribute;

                        const baseFaceOrder = ['left', 'right', 'top', 'bottom', 'front', 'back']; // BoxGeometry order
                        const allFaceKeys = [...baseFaceOrder, ...baseFaceOrder.map(k => `layer_${k}`)];

                        for (let faceIdx = 0; faceIdx < 12; faceIdx++) {
                            const partKey = allFaceKeys[faceIdx];
                            const partIndex = partOrder.indexOf(partKey);

                            if (partIndex === -1) continue;

                            const dx = (partIndex % 3) * PART_SIZE;
                            const dy = Math.floor(partIndex / 3) * PART_SIZE;
                            
                            const inset = 0;
                            const u0 = (dx + inset) / ATLAS_SIZE;
                            const u1 = (dx + PART_SIZE - inset) / ATLAS_SIZE;

                            const v1 = (PART_BLOCK_HEIGHT - dy - inset) / ATLAS_SIZE;
                            const v0 = (PART_BLOCK_HEIGHT - (dy + PART_SIZE) - inset) / ATLAS_SIZE;
                            
                            const baseFaceName = baseFaceOrder[faceIdx % 6];
                            const uvWriteIndex = faceIdx * 4;
                            
                            if (baseFaceName === 'top') {
                                newUvAttr.setXY(uvWriteIndex + 0, u1, v0);
                                newUvAttr.setXY(uvWriteIndex + 1, u0, v0);
                                newUvAttr.setXY(uvWriteIndex + 2, u1, v1);
                                newUvAttr.setXY(uvWriteIndex + 3, u0, v1);
                            } else if (baseFaceName === 'bottom') {
                                newUvAttr.setXY(uvWriteIndex + 0, u1, v1);
                                newUvAttr.setXY(uvWriteIndex + 1, u0, v1);
                                newUvAttr.setXY(uvWriteIndex + 2, u1, v0);
                                newUvAttr.setXY(uvWriteIndex + 3, u0, v0);
                            } else {
                                newUvAttr.setXY(uvWriteIndex + 0, u0, v1);
                                newUvAttr.setXY(uvWriteIndex + 1, u1, v1);
                                newUvAttr.setXY(uvWriteIndex + 2, u0, v0);
                                newUvAttr.setXY(uvWriteIndex + 3, u1, v0);
                            }
                        }
                        newUvAttr.needsUpdate = true;

                        const totalInstances = playerHeadItems.length;
                        const matrices = new Float32Array(totalInstances * 16);
                        const uvOffsets = new Float32Array(totalInstances * 2);
                        const hasHatArray = new Array(totalInstances).fill(false);

                        let i = 0;
                        for (const item of playerHeadItems) {
                            const matrix = new THREE.Matrix4().fromArray(item.transform).transpose();
                            const scaleMatrix = new THREE.Matrix4().makeScale(0.5, 0.5, 0.5);
                            matrix.multiply(scaleMatrix);
                            matrix.toArray(matrices, i * 16);

                            const skinBlockPos = skinLayouts.get(item.textureUrl);
                            if (skinBlockPos) {
                                const uOffset = skinBlockPos.x / ATLAS_SIZE;
                                const vOffset = 1.0 - (skinBlockPos.y + PART_BLOCK_HEIGHT) / ATLAS_SIZE;
                                
                                uvOffsets[i * 2 + 0] = uOffset;
                                uvOffsets[i * 2 + 1] = vOffset;
                            }

                            const isTransparent = skinTransparency.get(item.textureUrl);
                            // If layer is NOT transparent, it has a hat.
                            hasHatArray[i] = !isTransparent;

                            i++;
                        }
                        
                        sharedGeometry.setAttribute('instancedUvOffset', new THREE.InstancedBufferAttribute(uvOffsets, 2));

                        const instancedMesh = new THREE.InstancedMesh(sharedGeometry, atlasMaterial, totalInstances);
                        instancedMesh.userData.displayType = 'item_display';
                        instancedMesh.userData.hasHat = hasHatArray; // Store hat info for gizmo
                        instancedMesh.instanceMatrix.needsUpdate = true;
                        instancedMesh.frustumCulled = false;
                        instancedMesh.instanceMatrix.array = matrices;
                        instancedMesh.frustumCulled = false;
                        instancedMesh.layers.enable(2);
                        instancedMesh.computeBoundingSphere();

                        loadedObjectGroup.add(instancedMesh);

                    } catch (err) {
                        console.error('Player head instancing failed:', err);
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

function loadpbde(file: File): void {
    _loadAndRenderPbde(file, false);
}

function mergepbde(file: File): void {
    _loadAndRenderPbde(file, true);
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
                mergepbde(file);
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