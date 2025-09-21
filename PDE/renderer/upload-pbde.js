import { openWithAnimation, closeWithAnimation } from './ui-open-close.js';
import * as THREE from 'three/webgpu';
import PbdeWorker from './pbde-worker.js?worker&inline';
import { createEntityMaterial } from './entityMaterial.js';

// --- Asset Provider for Main Thread ---

function decodeIpcContentToString(content) {
    try {
        if (!content) return '';
        // Node Buffer-like
        if (typeof content === 'object' && content.type === 'Buffer' && Array.isArray(content.data)) {
            return new TextDecoder('utf-8').decode(new Uint8Array(content.data));
        }
        // Browser Uint8Array
        if (content instanceof Uint8Array) {
            return new TextDecoder('utf-8').decode(content);
        }
        // Try generic
        if (typeof content.toString === 'function') {
            return content.toString('utf-8');
        }
        return String(content);
    } catch {
        return String(content);
    }
}

const mainThreadAssetProvider = {
    async getAsset(assetPath) {
        const isHardcoded = assetPath.startsWith('hardcoded/');
        const result = isHardcoded
            ? await window.ipcApi.getHardcodedContent(assetPath.replace(/^hardcoded\//, ''))
            : await window.ipcApi.getAssetContent(assetPath);
        if (!result.success) throw new Error(`Asset read failed: ${assetPath}: ${result.error}`);
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

let worker;
// 로드된 모든 객체를 담을 그룹
const loadedObjectGroup = new THREE.Group();

// 텍스처 로더 및 캐시
const textureLoader = new THREE.TextureLoader();
const textureCache = new Map();

// --- Block texture/material caches (dedupe loads + reuse materials) ---
const blockTextureCache = new Map(); // texPath -> THREE.Texture
const blockTexturePromiseCache = new Map(); // texPath -> Promise<THREE.Texture>
const blockMaterialCache = new Map(); // key: `${texPath}|${tintHex}` -> THREE.Material
const blockMaterialPromiseCache = new Map(); // same key -> Promise<THREE.Material>

// Shared placeholder assets
let sharedPlaceholderMaterial = null;

// Limit concurrent texture decodes to avoid overwhelming the decoder/GC
const MAX_TEXTURE_DECODE_CONCURRENCY = 8;
let currentTextureSlots = 0;
const textureSlotQueue = [];
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
const headTextureCache = new Map(); // url -> THREE.Texture
const headTexturePromiseCache = new Map(); // `${gen}|${url}` -> Promise<THREE.Texture>

function dataUrlToBlob(dataUrl) {
    try {
        const m = dataUrl.match(/^data:([^;]+);base64,(.*)$/);
        if (!m) return null;
        const mime = m[1] || 'image/png';
        const b64 = m[2] || '';
        const bin = atob(b64);
        const len = bin.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
        return new Blob([bytes], { type: mime });
    } catch {
        return null;
    }
}

async function loadPlayerHeadTexture(url, gen) {
    if (headTextureCache.has(url) && gen === currentLoadGen) return headTextureCache.get(url);
    const promiseKey = `${gen}|${url}`;
    if (headTexturePromiseCache.has(promiseKey)) return headTexturePromiseCache.get(promiseKey);

    const p = (async () => {
        await acquireTextureSlot();
        try {
            let blob;
            if (url.startsWith('data:')) {
                blob = dataUrlToBlob(url);
                if (!blob) throw new Error('Invalid data URL');
            } else {
                const resp = await fetch(url, { mode: 'cors' });
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                const buf = await resp.arrayBuffer();
                const ctype = resp.headers.get('content-type') || 'image/png';
                blob = new Blob([buf], { type: ctype });
            }

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

function disposeTexture(tex) {
    if (!tex) return;
    try {
        const img = tex.image || tex.source?.data;
        if (img && typeof img.close === 'function') {
            try { img.close(); } catch { /* ignore */ }
        }
    } catch { /* ignore */ }
    try { tex.dispose(); } catch { /* ignore */ }
}

function ensureSharedPlaceholder() {
    if (!sharedPlaceholderMaterial) {
        // Lightweight placeholder material to avoid creating NodeMaterial per mesh before texture loads
        sharedPlaceholderMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff });
        sharedPlaceholderMaterial.toneMapped = false;
        sharedPlaceholderMaterial.transparent = true;
        sharedPlaceholderMaterial.alphaTest = 0.1;
    }
}

function decodeIpcContentToUint8Array(content) {
    try {
        if (!content) return new Uint8Array();
        if (typeof content === 'object' && content.type === 'Buffer' && Array.isArray(content.data)) {
            return new Uint8Array(content.data);
        }
        if (content instanceof Uint8Array) return content;
        if (ArrayBuffer.isView(content)) return new Uint8Array(content.buffer);
        if (content instanceof ArrayBuffer) return new Uint8Array(content);
        // Fallback: try toString and encode
        const str = String(content);
        const enc = new TextEncoder();
        return enc.encode(str);
    } catch {
        return new Uint8Array();
    }
}

async function loadBlockTexture(texPath, gen) {
    // Deduplicate concurrent loads
    if (blockTextureCache.has(texPath) && gen === currentLoadGen) return blockTextureCache.get(texPath);
    const promiseKey = `${gen}|${texPath}`;
    if (blockTexturePromiseCache.has(promiseKey)) return blockTexturePromiseCache.get(promiseKey);

    const p = (async () => {
        await acquireTextureSlot();
        const texResult = await window.ipcApi.getAssetContent(texPath);
        if (!texResult.success) throw new Error(`[Texture] Failed to load ${texPath}: ${texResult.error}`);
        const bytes = decodeIpcContentToUint8Array(texResult.content);
        const blob = new Blob([bytes], { type: 'image/png' });
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

async function getBlockMaterial(texPath, tintHex, gen) {
    const key = `${texPath}|${(tintHex >>> 0)}`;
    if (blockMaterialCache.has(key) && gen === currentLoadGen) return blockMaterialCache.get(key);
    const promiseKey = `${gen}|${key}`;
    if (blockMaterialPromiseCache.has(promiseKey)) return blockMaterialPromiseCache.get(promiseKey);

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
let headGeometries = null;

export { loadedObjectGroup };

// Merge multiple indexed BufferGeometries with identical attribute layouts
function mergeIndexedGeometries(geometries) {
    if (!geometries || geometries.length === 0) return null;
    const first = geometries[0];
    const merged = new THREE.BufferGeometry();

    // Collect attribute names
    const attrNames = Object.keys(first.attributes);

    // Compute total vertex count
    let totalVertices = 0;
    const itemSizes = {};
    const arrayTypes = {};
    for (const g of geometries) {
        const pos = g.getAttribute('position');
        const count = pos.count; // number of vertices
        totalVertices += count;
        for (const name of attrNames) {
            const attr = g.getAttribute(name);
            itemSizes[name] = attr.itemSize;
            arrayTypes[name] = attr.array.constructor;
        }
    }

    // Merge attributes
    for (const name of attrNames) {
        const itemSize = itemSizes[name];
        const ArrayType = arrayTypes[name] || Float32Array;
        const totalLen = totalVertices * itemSize;
        const mergedArray = new ArrayType(totalLen);
        let offset = 0;
        for (const g of geometries) {
            const attr = g.getAttribute(name);
            mergedArray.set(attr.array, offset);
            offset += attr.array.length;
        }
        merged.setAttribute(name, new THREE.BufferAttribute(mergedArray, itemSize));
    }

    // Merge indices with offsets
    let vertexOffset = 0;
    const indexArrays = [];
    let totalIndexCount = 0;
    for (const g of geometries) {
        const index = g.getIndex();
        const idxArray = index.array;
        totalIndexCount += idxArray.length;
    }
    const useUint32 = totalVertices > 65535;
    const mergedIndex = useUint32 ? new Uint32Array(totalIndexCount) : new Uint16Array(totalIndexCount);
    let idxOffset = 0;
    for (const g of geometries) {
        const index = g.getIndex();
        const idxArray = index.array;
        const pos = g.getAttribute('position');
        const vertCount = pos.count;
        for (let i = 0; i < idxArray.length; i++) {
            mergedIndex[idxOffset + i] = idxArray[i] + vertexOffset;
        }
        idxOffset += idxArray.length;
        vertexOffset += vertCount;
    }
    merged.setIndex(new THREE.BufferAttribute(mergedIndex, 1));

    // Provide an approximate bounding sphere
    merged.boundingSphere = new THREE.Sphere(new THREE.Vector3(0.5, 0.5, 0.5), 0.9);
    return merged;
}

function createBlockDisplayFromData(data, gen) {
    const finalGroup = new THREE.Group();
    finalGroup.matrixAutoUpdate = false;
    const finalMatrix = new THREE.Matrix4();
    finalMatrix.fromArray(data.transform);
    finalMatrix.transpose();
    finalGroup.matrix.copy(finalMatrix);
    ensureSharedPlaceholder();

    // Helper: apply a matrix to position and normal attributes in-place
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
        // Recompute accurate bounds for proper frustum culling of non-1x1 blocks (e.g., beds)
        geom.computeBoundingBox();
        geom.computeBoundingSphere();
    };

    // Collect and bake transforms across ALL models, then group by material
    const groups = new Map(); // key -> { texPath, tintHex, geoms: [] }
    for (const model of data.models) {
        const modelMatrix = new THREE.Matrix4();
        modelMatrix.fromArray(model.modelMatrix);
        for (const geomData of model.geometries) {
            const geom = new THREE.BufferGeometry();
            geom.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(geomData.positions), 3));
            geom.setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array(geomData.normals), 3));
            geom.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(geomData.uvs), 2));
            geom.setIndex(geomData.indices);
            applyMatrixToGeometry(geom, modelMatrix);

            const key = `${geomData.texPath}|${(geomData.tintHex ?? 0xffffff) >>> 0}`;
            let entry = groups.get(key);
            if (!entry) {
                entry = { texPath: geomData.texPath, tintHex: geomData.tintHex ?? 0xffffff, geoms: [] };
                groups.set(key, entry);
            }
            entry.geoms.push(geom);
        }
    }

    // Create one mesh per material (merged), minimizing draw calls
    for (const entry of groups.values()) {
        const mergedGeom = entry.geoms.length > 1 ? mergeIndexedGeometries(entry.geoms) : entry.geoms[0];
        if (mergedGeom && entry.geoms.length > 1) {
            for (const g of entry.geoms) if (g !== mergedGeom) g.dispose();
        }
        // Ensure merged geometry has proper bounds
        if (!mergedGeom.boundingBox) mergedGeom.computeBoundingBox();
        if (!mergedGeom.boundingSphere) mergedGeom.computeBoundingSphere();
        const mesh = new THREE.Mesh(mergedGeom, sharedPlaceholderMaterial);
        mesh.castShadow = false;
        mesh.receiveShadow = false;
        finalGroup.add(mesh);

        (async () => {
            try {
                const mat = await getBlockMaterial(entry.texPath, entry.tintHex, gen);
                if (gen !== currentLoadGen) {
                    return; // stale
                }
                mesh.material = mat;
                mesh.material.needsUpdate = true;
            } catch (e) {
                console.warn(`[Texture] Error while loading ${entry.texPath}:`, e);
            }
        })();
    }

    return finalGroup;
}
/**
 * 주의: BoxGeometry는 인덱스가 있는 BufferGeometry를 반환합니다.
 * 병합을 위해 toNonIndexed()로 변환한 뒤 attribute들을 concat 합니다.
 */
function mergeNonIndexedGeometries(geometries) {
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

        for (let g of geometries) {
            const attr = g.getAttribute(name);
            if (!attr) {
                console.warn(`mergeNonIndexedGeometries: geometry missing attribute ${name}`);
                continue;
            }
            arrays.push(attr.array);
            itemSize = attr.itemSize;
            ArrayType = attr.array.constructor; // 유지되는 typed array 타입 사용
        }

        // 총 길이 계산
        let totalLen = arrays.reduce((s, a) => s + a.length, 0);
        const mergedArray = new ArrayType(totalLen);
        let offset = 0;
        for (let a of arrays) {
            mergedArray.set(a, offset);
            offset += a.length;
        }
        merged.setAttribute(name, new THREE.BufferAttribute(mergedArray, itemSize));
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

    const createGeometry = (isLayer) => {
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

        const uvs = isLayer ? layerUVs : faceUVs;
        const order = ['left', 'right', 'top', 'bottom', 'front', 'back'];
        const uvAttr = geometry.getAttribute('uv');

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
const materialCache = new WeakMap();


/**
 * 병합된(merged) 지오메트리를 사용하는 단일 메시 생성 (base+layer -> 1 draw call)
 */
function createOptimizedHeadMerged(texture) {
    const geometry = headGeometries.merged || headGeometries.base;

    // 텍스처 필터 및 컬러스페이스는 최초 1회만 설정
    if (!texture.__optimizedSetupDone) {
        texture.magFilter = THREE.NearestFilter;
        texture.minFilter = THREE.NearestFilter;
        texture.generateMipmaps = false;
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.__optimizedSetupDone = true;
    }

    let material = materialCache.get(texture);
    if (!material) {
        const matData = createEntityMaterial(texture);
        material = matData.material;

        material.toneMapped = false;
        // material.alphaTest = 0.5;

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
function loadpbde(file) {
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
            const renderList = msg.data;
            
            if (!renderList || renderList.length === 0) {
                console.warn("[Debug] Worker returned success, but the render list is empty. Nothing to render.");
            } else {
                console.log(`[Debug] Processing ${renderList.length} items from worker.`);
            }

            renderList.forEach((item) => {
                if (item.type === 'blockDisplay') {
                    const finalGroup = createBlockDisplayFromData(item, myGen);
                    loadedObjectGroup.add(finalGroup);
                } else if (item.type === 'itemDisplay') {
                    if (item.textureUrl) {
                        const headGroup = new THREE.Group();
                        headGroup.userData.isPlayerHead = true;
                        headGroup.userData.gen = myGen;

                        (async () => {
                            try {
                                const tex = await loadPlayerHeadTexture(item.textureUrl, myGen);
                                if (myGen !== currentLoadGen) {
                                    // stale
                                    try { disposeTexture(tex); } catch {}
                                    return;
                                }
                                headGroup.add(createOptimizedHeadMerged(tex));
                            } catch (err) {
                                console.error('플레이어 헤드 텍스처 로드 실패:', err);
                            }
                        })();

                        const finalMatrix = new THREE.Matrix4();
                        finalMatrix.fromArray(item.transform);
                        finalMatrix.transpose();
                        const scaleMatrix = new THREE.Matrix4().makeScale(0.5, 0.5, 0.5);
                        finalMatrix.multiply(scaleMatrix);
                        headGroup.matrixAutoUpdate = false;
                        headGroup.matrix.copy(finalMatrix);
                        loadedObjectGroup.add(headGroup);
                    } else {
                        const geometry = new THREE.BoxGeometry(1, 1, 1);
                        const material = new THREE.MeshStandardMaterial({ color: 0x0000ff ,transparent: true});
                        material.toneMapped = false;
                        const cube = new THREE.Mesh(geometry, material);
                        cube.castShadow = true;
                        cube.receiveShadow = true;

                        const finalMatrix = new THREE.Matrix4();
                        finalMatrix.fromArray(item.transform);
                        finalMatrix.transpose();

                        cube.matrixAutoUpdate = false;
                        cube.matrix.copy(finalMatrix);

                        loadedObjectGroup.add(cube);
                    }
                }
            });

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
    reader.onload = (event) => {
        if (myGen === currentLoadGen) {
            worker.postMessage(event.target.result);
        }
    };
    reader.readAsText(file);
}


// 파일 드래그 앤 드롭 처리 로직

function createDropModal(file) {
    const existingModal = document.getElementById('drop-modal-overlay');
    if (existingModal) {
        existingModal.remove();
    }
    const modalOverlay = document.createElement('div');
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
    const handleEscKey = (e) => {
        if (e.key === 'Escape') {
            closeDropModal();
        }
    };
    modalOverlay.escHandler = handleEscKey;
    document.addEventListener('keydown', handleEscKey);

    document.getElementById('new-project-btn').addEventListener('click', () => {
        loadpbde(file);
        closeDropModal();
    });

    document.getElementById('merge-project-btn').addEventListener('click', () => {
        loadpbde(file);
        closeDropModal();
    });
}

function closeDropModal() {
    const modal = document.getElementById('drop-modal-overlay');
    if (modal) {
        if (modal.escHandler) {
            document.removeEventListener('keydown', modal.escHandler);
        }

        const modalContent = modal.querySelector('div');
        closeWithAnimation(modalContent).then(() => {
            modal.remove();
        });
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
                createDropModal();
                break;
            }
        }
    }

    if (droppedFile) {
        createDropModal(droppedFile);
    }
});