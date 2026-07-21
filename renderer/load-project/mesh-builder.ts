import * as THREE from 'three/webgpu';
import { compressSync, strToU8 } from 'fflate';
import { createEntityMaterial, dragSelectedAttributeName } from '../entityMaterial.js';
import { deleteSelectedItems } from '../controls/grouping/delete';
import * as Overlay from '../controls/selection/overlay';
import { getItemDisplayModelMatrix, getPlayerHeadDisplayMatrix, parsePbdeProject } from './scene-parser';
import { isNodeBufferLike, mainThreadAssetProvider, toUint8Array } from './pbde-assets';
import { isPbdeLogEnabled, pbdeLogNames } from './pbde-log';
import type { GeometryInstanceBatch, GeometryInstanceMeta, GeometryMeta, GroupChild, GroupData, HeadGeometrySet, OtherItem, TypedArrayConstructor, WorkerMetadata } from './pbde-types';
// 애니메이션 프레임이 있는 블록 텍스처를 첫 16x16 타일로 잘라낸다.
// function cropTextureToFirst16(tex) { ... } // Removed as per request

// 로드된 모든 객체를 담을 그룹
const loadedObjectGroup = new THREE.Group();

// --- 블록 텍스처 및 머티리얼 캐시(중복 로드 제거 + 재사용) ---
const blockTextureCache = new Map<string, THREE.Texture>(); // 텍스처 경로별 THREE.Texture 매핑
const blockTexturePromiseCache = new Map<string, Promise<THREE.Texture>>(); // 텍스처 경로별 로드 프라미스 매핑
const blockMaterialCache = new Map<string, THREE.Material>(); // `${texPath}|${tintHex}` 조합별 머티리얼 캐시
const blockMaterialPromiseCache = new Map<string, Promise<THREE.Material>>(); // 동일 키에 대한 생성 프라미스 캐시
let currentAtlasTexture: THREE.Texture | null = null;

const PLAYER_HEAD_ATLAS_SIZE = 2048;
const PLAYER_HEAD_PART_SIZE = 8;
const PLAYER_HEAD_BLOCK_WIDTH = PLAYER_HEAD_PART_SIZE * 3;
const PLAYER_HEAD_BLOCK_HEIGHT = PLAYER_HEAD_PART_SIZE * 4;
const PLAYER_HEAD_BLOCKS_PER_ROW = Math.floor(PLAYER_HEAD_ATLAS_SIZE / PLAYER_HEAD_BLOCK_WIDTH);
const playerHeadFaceParts = {
    right: [16, 8], left: [0, 8], top: [8, 0], bottom: [16, 0], front: [24, 8], back: [8, 8],
    layer_right: [48, 8], layer_left: [32, 8], layer_top: [40, 0], layer_bottom: [48, 0], layer_front: [56, 8], layer_back: [40, 8]
} as const;
const playerHeadPartOrder = Object.keys(playerHeadFaceParts) as Array<keyof typeof playerHeadFaceParts>;
const playerHeadLayerRegions = [[48, 8, 8, 8], [32, 8, 8, 8], [40, 0, 8, 8], [48, 0, 8, 8], [56, 8, 8, 8], [40, 8, 8, 8]];
const playerHeadAtlases = new WeakMap<THREE.Material, { context: CanvasRenderingContext2D; texture: THREE.Texture; nextSlot: number }>();

export function getPlayerHeadRenderMatrix(displayType?: string): THREE.Matrix4 {
    return (getPlayerHeadDisplayMatrix(displayType) ?? new THREE.Matrix4())
        .multiply(new THREE.Matrix4().makeScale(0.5, 0.5, 0.5));
}

// 공유 플레이스홀더 자원
let sharedPlaceholderMaterial: THREE.Material | null = null;

// 텍스처 디코더와 GC가 과부하되지 않도록 동시 디코딩을 제한한다.
const MAX_TEXTURE_DECODE_CONCURRENCY = 512;
const MAX_INSTANCES_PER_INSTANCED_MESH = 32768;
const INITIAL_INSTANCES_PER_INSTANCED_MESH = MAX_INSTANCES_PER_INSTANCED_MESH >> 1;
const MAX_PART_UV_TRANSFORMS = 8;
let currentTextureSlots = 0;
const textureSlotQueue: Array<(value?: void) => void> = [];
const signatureHashScratch = new ArrayBuffer(8);
const signatureHashView = new DataView(signatureHashScratch);
const instanceBrightnessColor = new THREE.Color();
type Brightness = { sky?: number; block?: number };
export type GlobalBrightness = { enabled: boolean; sky: number; block: number };

type SignatureGroup = {
    parts: GeometryMeta[];
    instances: GeometryInstanceMeta[];
    geometryKey: string;
    instancedUvTransformCount: number;
};
type MaterialUpdate = {
    instancedMesh: THREE.InstancedMesh;
    materials: THREE.Material[];
    pendingMaterialSlots: Array<{ index: number; promise: Promise<THREE.Material> }>;
    signature: string;
};
export type LoadedSelection = Map<THREE.Object3D, Set<number>>;

const skyLightColors = [
    0x2c2621, 0x302a25, 0x342e2a, 0x39332f,
    0x3f3934, 0x453f3a, 0x4c4641, 0x544e49,
    0x5e5853, 0x69635e, 0x77716d, 0x87817c,
    0x9c9691, 0xb6b0ac, 0xdad4cf, 0xfcfcfc
];

function effectiveBrightness(brightness?: Brightness): Brightness {
    const global = loadedObjectGroup.userData.globalBrightness as GlobalBrightness | undefined;
    return global?.enabled && (brightness?.sky ?? 15) === 15 && (brightness?.block ?? 0) === 0 ? global : brightness ?? {};
}

function setInstanceSkyBrightness(mesh: THREE.InstancedMesh, instanceId: number, brightness?: Brightness): void {
    const level = Math.round(THREE.MathUtils.clamp(effectiveBrightness(brightness).sky ?? 15, 0, 15));
    mesh.setColorAt(instanceId, instanceBrightnessColor.setHex(skyLightColors[level]));
    mesh.instanceColor!.setUsage(THREE.DynamicDrawUsage);
}

function addLoadedInstance(selection: LoadedSelection, mesh: THREE.Object3D, instanceId: number): void {
    let ids = selection.get(mesh);
    if (!ids) selection.set(mesh, ids = new Set<number>());
    ids.add(instanceId);
}

function getInstancedCapacity(mesh: THREE.InstancedMesh): number {
    let capacity = mesh.instanceMatrix.count;
    if (mesh.instanceColor) capacity = Math.min(capacity, mesh.instanceColor.count);
    for (const attribute of Object.values(mesh.geometry.attributes)) {
        const instancedAttribute = attribute as THREE.InstancedBufferAttribute;
        if (instancedAttribute.isInstancedBufferAttribute) capacity = Math.min(capacity, instancedAttribute.count);
    }
    return capacity;
}

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

function mixHash(hash: number, value: number): number {
    hash ^= value >>> 0;
    return Math.imul(hash, 16777619) >>> 0;
}

function hashString(hash: number, value: string): number {
    for (let i = 0; i < value.length; i++) {
        hash = mixHash(hash, value.charCodeAt(i));
    }
    return mixHash(hash, value.length);
}

function hashNumber(hash: number, value: number): number {
    signatureHashView.setFloat64(0, value, true);
    hash = mixHash(hash, signatureHashView.getUint32(0, true));
    return mixHash(hash, signatureHashView.getUint32(4, true));
}

function buildPartHashKeys(parts: GeometryMeta[]): { signature: string; geometryKey: string } {
    let signatureHashA = 2166136261;
    let signatureHashB = 16777619;
    let geometryHashA = 2166136261;
    let geometryHashB = 16777619;

    signatureHashA = mixHash(signatureHashA, parts.length);
    signatureHashB = mixHash(signatureHashB, parts.length);
    geometryHashA = mixHash(geometryHashA, parts.length);
    geometryHashB = mixHash(geometryHashB, parts.length);

    for (const part of parts) {
        const geometryBufferKey = getGeometryBufferKey(part);
        signatureHashA = hashString(signatureHashA, part.geometryId);
        signatureHashA = hashString(signatureHashA, geometryBufferKey);
        signatureHashA = mixHash(signatureHashA, part.geometryIndex);
        signatureHashA = hashString(signatureHashA, part.texPath);
        signatureHashA = mixHash(signatureHashA, (part.tintHex ?? 0xffffff) >>> 0);
        signatureHashB = hashString(signatureHashB, part.texPath);
        signatureHashB = mixHash(signatureHashB, (part.tintHex ?? 0xffffff) >>> 0);
        signatureHashB = hashString(signatureHashB, part.geometryId);
        signatureHashB = hashString(signatureHashB, geometryBufferKey);
        signatureHashB = mixHash(signatureHashB, part.geometryIndex);

        geometryHashA = hashString(geometryHashA, part.geometryId);
        geometryHashA = hashString(geometryHashA, geometryBufferKey);
        geometryHashA = mixHash(geometryHashA, part.geometryIndex);
        geometryHashB = mixHash(geometryHashB, part.geometryIndex);
        geometryHashB = hashString(geometryHashB, part.geometryId);
        geometryHashB = hashString(geometryHashB, geometryBufferKey);

        for (let i = 0; i < part.modelMatrix.length; i++) {
            signatureHashA = hashNumber(signatureHashA, part.modelMatrix[i]);
            signatureHashB = hashNumber(signatureHashB, part.modelMatrix[part.modelMatrix.length - 1 - i]);
            geometryHashA = hashNumber(geometryHashA, part.modelMatrix[i]);
            geometryHashB = hashNumber(geometryHashB, part.modelMatrix[part.modelMatrix.length - 1 - i]);
        }
    }

    return {
        signature: `${parts.length}|${signatureHashA.toString(36)}|${signatureHashB.toString(36)}`,
        geometryKey: `${parts.length}|${geometryHashA.toString(36)}|${geometryHashB.toString(36)}`
    };
}

function getGeometryBufferKey(part: GeometryMeta): string {
    return part.geometryBufferKey ?? `${part.geometryId}|${part.geometryIndex}`;
}

function getRelativeUvTransform(
    base: [number, number, number, number] | undefined,
    current: [number, number, number, number] | undefined
): [number, number, number, number] {
    if (!base || !current) return [1, 1, 0, 0];

    const scaleX = base[0] !== 0 ? current[0] / base[0] : 1;
    const scaleY = base[1] !== 0 ? current[1] / base[1] : 1;
    return [
        scaleX,
        scaleY,
        current[2] - base[2] * scaleX,
        current[3] - base[3] * scaleY
    ];
}

function getInstancePartUvTransform(
    meta: GeometryInstanceMeta,
    partIndex: number
): [number, number, number, number] | undefined {
    return meta.atlasUvTransforms?.[partIndex] ?? meta.atlasUvTransform;
}

function getInstancedUvTransformCount(parts: GeometryMeta[], instances: GeometryInstanceMeta[]): number {
    if (!parts[0]?.uvTransform) return 0;

    let transformCount = 0;
    for (const instance of instances) {
        transformCount = Math.max(
            transformCount,
            instance.atlasUvTransforms?.length ?? (instance.atlasUvTransform ? 1 : 0)
        );
    }
    return transformCount === 0
        ? 0
        : Math.min(MAX_PART_UV_TRANSFORMS, Math.max(parts.length, transformCount));
}

function getInstanceDisplayType(instance: GeometryInstanceMeta, part?: GeometryMeta): 'item_display' | 'block_display' {
    return (instance.isItemDisplayModel ?? part?.isItemDisplayModel) ? 'item_display' : 'block_display';
}

function getAppendableInstanceCapacity(count: number): number {
    return Math.max(count, Math.min(MAX_INSTANCES_PER_INSTANCED_MESH, Math.max(256, count * 2)));
}

function getMaterialKey(part: GeometryMeta, instancedUvTransformCount: number, instancedUvTransformIndex = 0): string {
    return `${part.texPath}|${(part.tintHex ?? 0xffffff) >>> 0}|${instancedUvTransformCount > 0 ? `uvt${instancedUvTransformCount}:${instancedUvTransformIndex}` : 'base'}`;
}


// 리로드 이후 늦게 도착한 비동기 결과를 무시하기 위한 세대 토큰
let currentLoadGen = 0;

export function beginPbdeLoadGeneration(): number {
    return ++currentLoadGen;
}

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

async function getBlockMaterial(texPath: string, tintHex: number | undefined, gen: number, instancedUvTransformCount = 0, instancedUvTransformIndex = 0): Promise<THREE.Material> {
    // undefined는 흰색(0xffffff)으로 정규화하여 캐시 키 불일치를 방지한다.
    const effectiveTint = (tintHex ?? 0xffffff) >>> 0;
    const key = `${texPath}|${effectiveTint}|${instancedUvTransformCount > 0 ? `uvt${instancedUvTransformCount}:${instancedUvTransformIndex}` : 'base'}`;
    if (blockMaterialCache.has(key) && gen === currentLoadGen) {
        const mat = blockMaterialCache.get(key)!;
        // 아틀라스 텍스처가 변경되었으면 stale 항목을 캐시에서 제거하고 재생성한다.
        if (texPath.includes('__ATLAS__') && mat.map !== currentAtlasTexture) {
            blockMaterialCache.delete(key);
        } else {
            return mat;
        }
    }
    const promiseKey = `${gen}|${key}`;
    if (blockMaterialPromiseCache.has(promiseKey)) return blockMaterialPromiseCache.get(promiseKey)!;

    const p = (async () => {
        const tex = await loadBlockTexture(texPath, gen);
        const { material } = createEntityMaterial(tex, effectiveTint, false, instancedUvTransformCount > 0, instancedUvTransformCount, instancedUvTransformIndex);
        material.toneMapped = false;
        material.fog = false;
        material.flatShading = true;
        material.vertexColors = true; // Bake tint into geometry

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

export { loadedObjectGroup };

// 동일한 속성 구성을 가진 인덱스 지오메트리를 하나로 병합한다.
function mergeIndexedGeometries(geometries: THREE.BufferGeometry[]): THREE.BufferGeometry | null {
    if (!geometries || geometries.length === 0) return null;
    const first = geometries[0];
    const merged = new THREE.BufferGeometry();

    const attrNames = Object.keys(first.attributes);

    let totalVertices = 0;
    const itemSizes: Record<string, number> = {};
    const arrayTypes: Record<string, TypedArrayConstructor> = {};
    for (const g of geometries) {
        const pos = g.getAttribute('position') as THREE.BufferAttribute;
        const count = pos.count;
        totalVertices += count;
        for (const name of attrNames) {
            const attr = g.getAttribute(name) as THREE.BufferAttribute;
            itemSizes[name] = attr.itemSize;
            arrayTypes[name] = attr.array.constructor as TypedArrayConstructor;
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

const DEFAULT_PLAYER_HEAD_TEXTURE = 'https://textures.minecraft.net/texture/d94e1686adb67823c7e5148c2c06e2d95c1b66374409e96b32dc1310397e1711';

function loadPlayerHeadImage(url: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
        const image = new Image();
        image.crossOrigin = 'anonymous';
        image.onload = () => resolve(image);
        image.onerror = () => {
            if (image.src !== DEFAULT_PLAYER_HEAD_TEXTURE) {
                image.src = DEFAULT_PLAYER_HEAD_TEXTURE;
                return;
            }
            reject(new Error(`Failed to load image: ${url}`));
        };
        image.src = url.replace('http://', 'https://');
    });
}

function drawPlayerHeadSlot(context: CanvasRenderingContext2D, image: HTMLImageElement, slot: number): boolean {
    const blockX = (slot % PLAYER_HEAD_BLOCKS_PER_ROW) * PLAYER_HEAD_BLOCK_WIDTH;
    const blockY = Math.floor(slot / PLAYER_HEAD_BLOCKS_PER_ROW) * PLAYER_HEAD_BLOCK_HEIGHT;
    context.clearRect(blockX, blockY, PLAYER_HEAD_BLOCK_WIDTH, PLAYER_HEAD_BLOCK_HEIGHT);
    playerHeadPartOrder.forEach((key, index) => {
        const [sx, sy] = playerHeadFaceParts[key];
        context.drawImage(
            image, sx, sy, 8, 8,
            blockX + (index % 3) * PLAYER_HEAD_PART_SIZE,
            blockY + Math.floor(index / 3) * PLAYER_HEAD_PART_SIZE,
            8, 8
        );
    });
    return !isLayerTransparent(image, playerHeadLayerRegions);
}

function mirroredPlayerHeadFace(key: keyof typeof playerHeadFaceParts): keyof typeof playerHeadFaceParts {
    return (key.endsWith('right') ? key.replace('right', 'left')
        : key.endsWith('left') ? key.replace('left', 'right') : key) as keyof typeof playerHeadFaceParts;
}

function playerHeadTextureDataUrl(image: HTMLImageElement, mirrored: boolean): string | null {
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('플레이어 헤드 텍스처 캔버스를 만들 수 없습니다.');
    context.imageSmoothingEnabled = false;
    context.drawImage(image, 0, 0);
    const originalPixels = mirrored ? context.getImageData(0, 0, canvas.width, canvas.height).data : null;
    if (mirrored) {
        for (const [key, [x, y]] of Object.entries(playerHeadFaceParts)) {
            const sourceKey = mirroredPlayerHeadFace(key as keyof typeof playerHeadFaceParts);
            const [sourceX, sourceY] = playerHeadFaceParts[sourceKey];
            context.save();
            context.translate(2 * x + PLAYER_HEAD_PART_SIZE, 0);
            context.scale(-1, 1);
            context.drawImage(image, sourceX, sourceY, PLAYER_HEAD_PART_SIZE, PLAYER_HEAD_PART_SIZE, x, y, PLAYER_HEAD_PART_SIZE, PLAYER_HEAD_PART_SIZE);
            context.restore();
        }
    }
    const mirroredPixels = mirrored ? context.getImageData(0, 0, canvas.width, canvas.height).data : null;
    if (!mirrored || originalPixels?.every((value, index) => value === mirroredPixels![index])) return null;
    const dataUrl = canvas.toDataURL('image/png');
    if (import.meta.env.DEV) console.assert(dataUrl.startsWith('data:image/png;base64,'), 'Player head reflection did not produce a PNG data URL.');
    return dataUrl;
}

if (import.meta.env.DEV) {
    console.assert(mirroredPlayerHeadFace('right') === 'left'
        && mirroredPlayerHeadFace('layer_left') === 'layer_right'
        && mirroredPlayerHeadFace('front') === 'front', 'Player head reflection mapped a face to the wrong texture region.');
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
    // 1-1-b. 블럭 텍스처/머티리얼 캐시 해제 및 초기화
    blockMaterialCache.forEach((mat) => { try { mat.dispose(); } catch {} });
    blockMaterialCache.clear();
    blockMaterialPromiseCache.clear();
    blockTextureCache.forEach((tex) => { try { disposeTexture(tex); } catch {} });
    blockTextureCache.clear();
    blockTexturePromiseCache.clear();


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

/**
 * Newly added helper to perform selection on a set of meshes.
 * Extracted from _loadAndRenderPbde to allow batch selection control.
 */
export function performSelection(newlyAddedSelectableMeshes: LoadedSelection) {
    const selectGroupsObjectsFn = (loadedObjectGroup.userData as Record<string, unknown>)?.replaceSelectionWithGroupsAndObjects as
        | undefined
        | ((groupIds: Set<string>, meshToIds: Map<THREE.Object3D, Set<number>>, opts?: unknown) => void);
    const selectObjectsFn = (loadedObjectGroup.userData as Record<string, unknown>)?.replaceSelectionWithObjectsMap as
        | undefined
        | ((meshToIds: Map<THREE.Object3D, Set<number>>, opts?: unknown) => void);

    if (newlyAddedSelectableMeshes.size > 0) {
        const groupsMap = (loadedObjectGroup.userData.groups as Map<string, GroupData>) ?? new Map<string, GroupData>();
        const objectToGroupMap = (loadedObjectGroup.userData.objectToGroup as Map<string, string>) ?? new Map<string, string>();

        const resolveRootGroupId = (groupId: string | null | undefined): string | null => {
            if (!groupId) return null;
            let current = groupId;
            for (let i = 0; i < 128; i++) {
                const g = groupsMap.get(current);
                if (!g) break;
                const parent = g.parent;
                if (!parent) break;
                current = parent;
            }
            return current || null;
        };

        const groupIds = new Set<string>();
        const meshToIds = new Map<any, Set<number>>();

        for (const [mesh, instanceIds] of newlyAddedSelectableMeshes) {
            if (!mesh) continue;
            const instancedMesh = mesh as THREE.InstancedMesh;

            if (!instancedMesh.isInstancedMesh) continue;

            if (instanceIds.size === 0) continue;

            let ids: Set<number> | null = null;
            for (const instanceId of instanceIds) {
                const key = `${mesh.uuid}_${instanceId}`;
                const immediateGroupId = objectToGroupMap.get(key);
                if (immediateGroupId) {
                    const root = resolveRootGroupId(immediateGroupId) ?? immediateGroupId;
                    if (root) groupIds.add(root);
                    continue;
                }

                if (!ids) ids = new Set<number>();
                ids.add(instanceId);
            }

            if (ids && ids.size > 0) {
                meshToIds.set(mesh, ids);
            }
        }

        // Group-priority selection: if an instance belongs to a group, select the (root) group instead.
        if (typeof selectGroupsObjectsFn === 'function') {
            selectGroupsObjectsFn(groupIds, meshToIds, { anchorMode: 'center' });
        } else if (typeof selectObjectsFn === 'function') {
            // Fallback: select raw objects if gizmo API is not available.
            selectObjectsFn(meshToIds, { anchorMode: 'center' });
        }
    }
}

export async function loadAndRenderPbde(file: File, isMerge: boolean, overrideGen?: number): Promise<LoadedSelection> {
        const meshUploadStartMs = performance.now();
        const setupStartMs = meshUploadStartMs;

        // 0. 새 프로젝트를 로드하기 전에 현재 선택 상태를 리셋합니다.
        // Single file open case or first file of batch open.
        if (!isMerge && loadedObjectGroup.userData.resetSelection) {
            loadedObjectGroup.userData.resetSelection();
        }

        const myGen = overrideGen !== undefined ? overrideGen : ++currentLoadGen;

        if (!isMerge) {
            _clearSceneAndCaches();
        } else {
            // 프로젝트 병합 시, 머티리얼 캐시를 초기화하여 새로운 아틀라스가 적용되도록 한다.
            // 기존 객체들은 이미 생성된 머티리얼을 참조하고 있으므로 영향받지 않는다.
            blockMaterialCache.clear();
            blockMaterialPromiseCache.clear();
            
            // 이전 프로젝트의 아틀라스 텍스처 참조를 제거
            currentAtlasTexture = null;
        }
        
        createHeadGeometries();
        const setupElapsedMs = performance.now() - setupStartMs;

        const fileReadStartMs = performance.now();
        const fileBuffer = await file.arrayBuffer();
        const fileReadElapsedMs = performance.now() - fileReadStartMs;
        if (myGen !== currentLoadGen) {
            return new Map<THREE.Object3D, Set<number>>();
        }

        const parseStartMs = performance.now();
        const { metadata, geometryBuffer } = await parsePbdeProject(fileBuffer, mainThreadAssetProvider);
        const parseElapsedMs = performance.now() - parseStartMs;
        if (myGen !== currentLoadGen) {
            return new Map<THREE.Object3D, Set<number>>();
        }

                if (!(geometryBuffer instanceof ArrayBuffer)) {
                    console.error('[Debug] geometryBuffer is not an ArrayBuffer. Aborting render pipeline.');
                    return new Map<THREE.Object3D, Set<number>>();
                }
                const sharedBuffer = geometryBuffer as ArrayBuffer;
                if (!metadata || typeof metadata !== 'object') {
                    console.error('[Debug] Invalid metadata payload from parser.');
                    return new Map<THREE.Object3D, Set<number>>();
                }
                const metadataPayload = metadata as WorkerMetadata;
                if (!Array.isArray(metadataPayload.geometries) || !Array.isArray(metadataPayload.otherItems)) {
                    console.error('[Debug] Invalid metadata payload from parser.');
                    return new Map<THREE.Object3D, Set<number>>();
                }
                const { geometries: geometryMetas, geometryBatches, otherItems, useUint32Indices, atlas, groups, sceneOrder, projectDetails } = metadataPayload;
                if (!isMerge) loadedObjectGroup.userData.projectDetails = projectDetails;
                const activeGeometryBatches = Array.isArray(geometryBatches) && geometryBatches.length > 0 ? geometryBatches : null;

                const newlyAddedSelectableMeshes: LoadedSelection = new Map();

                // Grouping Setup
                const incomingGroups = groups;
                const groupIdRemap = new Map<string, string>();

                // Keep existing group maps on merge; replace on fresh load.
                if (!loadedObjectGroup.userData.groups) loadedObjectGroup.userData.groups = new Map<string, GroupData>();
                if (!loadedObjectGroup.userData.objectToGroup) loadedObjectGroup.userData.objectToGroup = new Map<string, string>();

                const effectiveGroups: Map<string, GroupData> = isMerge
                    ? (loadedObjectGroup.userData.groups as Map<string, GroupData>)
                    : (incomingGroups ?? new Map<string, GroupData>());

                const objectToGroup: Map<string, string> = isMerge
                    ? (loadedObjectGroup.userData.objectToGroup as Map<string, string>)
                    : new Map<string, string>();

                loadedObjectGroup.userData.groups = effectiveGroups;
                loadedObjectGroup.userData.objectToGroup = objectToGroup;

                if (incomingGroups) {
                    // Precompute ID remaps (very unlikely, but safe on merge)
                    if (isMerge) {
                        for (const [id] of incomingGroups) {
                            if (effectiveGroups.has(id)) {
                                groupIdRemap.set(id, THREE.MathUtils.generateUUID());
                            }
                        }
                    }

                    // Merge incoming groups into effectiveGroups
                    for (const [origId, group] of incomingGroups) {
                        const newId = groupIdRemap.get(origId) ?? origId;
                        if (newId !== origId) group.id = newId;

                        if (group.parent && groupIdRemap.has(group.parent)) {
                            group.parent = groupIdRemap.get(group.parent);
                        }
                        if (Array.isArray(group.children)) {
                            for (const child of group.children) {
                                if (child && child.type === 'group' && child.id && groupIdRemap.has(child.id)) {
                                    child.id = groupIdRemap.get(child.id);
                                }
                            }
                        }

                        // Restore THREE objects for group transforms
                        if (group.quaternion) {
                            const q = group.quaternion;
                            if (!(q instanceof THREE.Quaternion)) {
                                const x = q._x !== undefined ? q._x : q.x;
                                const y = q._y !== undefined ? q._y : q.y;
                                const z = q._z !== undefined ? q._z : q.z;
                                const w = q._w !== undefined ? q._w : q.w;
                                group.quaternion = new THREE.Quaternion(x, y, z, w);
                            }
                        }
                        if (group.scale) {
                            const s = group.scale;
                            if (!(s instanceof THREE.Vector3)) {
                                group.scale = new THREE.Vector3(s.x, s.y, s.z);
                            }
                        }
                        if (group.position) {
                            const p = group.position;
                            if (!(p instanceof THREE.Vector3)) {
                                group.position = new THREE.Vector3(p.x, p.y, p.z);
                            }
                        }
                        if (group.pivot && !(group.pivot instanceof THREE.Vector3)) {
                            group.pivot = new THREE.Vector3(group.pivot[0], group.pivot[1], group.pivot[2]);
                        }

                        effectiveGroups.set(newId, group);
                    }
                }

                function registerObject(mesh: THREE.Object3D, instanceId: number, uuid: string, groupId: string) {
                    const key = `${mesh.uuid}_${instanceId}`;
                    // Always store reverse lookup: instanceKey → custom uuid
                    (loadedObjectGroup.userData.instanceKeyToObjectUuid as Map<string, string>).set(key, uuid);
                    // Forward reverse lookup: custom uuid → { mesh, instanceId }
                    (loadedObjectGroup.userData.objectUuidToInstance as Map<string, { mesh: THREE.Object3D; instanceId: number }>)
                        .set(uuid, { mesh, instanceId });

                    if (!groupId || !incomingGroups) return;
                    const finalGroupId = groupIdRemap.get(groupId) ?? groupId;
                    objectToGroup.set(key, finalGroupId);

                    const group = effectiveGroups.get(finalGroupId);
                    if (group && Array.isArray(group.children)) {
                        const childIndex = group.children.findIndex((c: GroupChild) => c && c.type === 'object' && c.id === uuid);
                        if (childIndex !== -1) {
                            group.children[childIndex] = { type: 'object', mesh: mesh, instanceId: instanceId, id: uuid };
                        }
                    }
                }

                const atlasStartMs = performance.now();
                if (atlas) {
                    try {
                        const imageData = new ImageData(atlas.data, atlas.width, atlas.height);
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
                const atlasElapsedMs = performance.now() - atlasStartMs;

                const geometryItemCount = activeGeometryBatches
                    ? activeGeometryBatches.reduce((sum, batch) => sum + batch.instances.length, 0)
                    : geometryMetas.length;
                if (isPbdeLogEnabled(pbdeLogNames.processingItems)) {
                    console.log(`[Debug] Processing ${geometryItemCount + otherItems.length} items from parser (binary).`);
                }

                // uuid → 표시 이름 맵 구성
                if (!isMerge) {
                    loadedObjectGroup.userData.objectNames = new Map<string, string>();
                    loadedObjectGroup.userData.objectIsItemDisplay = new Set<string>();
                    loadedObjectGroup.userData.objectDisplayTypes = new Map<string, string>();
                    loadedObjectGroup.userData.objectBlockProps = new Map<string, any>();
                    loadedObjectGroup.userData.objectBrightness = new Map<string, unknown>();
                    loadedObjectGroup.userData.objectTextures = new Map<string, string>();
                    loadedObjectGroup.userData.instanceKeyToObjectUuid = new Map<string, string>();
                    loadedObjectGroup.userData.objectUuidToInstance = new Map<string, { mesh: THREE.Object3D; instanceId: number }>();
                } else {
                    if (!loadedObjectGroup.userData.instanceKeyToObjectUuid)
                        loadedObjectGroup.userData.instanceKeyToObjectUuid = new Map<string, string>();
                    if (!loadedObjectGroup.userData.objectUuidToInstance)
                        loadedObjectGroup.userData.objectUuidToInstance = new Map<string, { mesh: THREE.Object3D; instanceId: number }>();
                }
                const objectNamesMap: Map<string, string> =
                    (loadedObjectGroup.userData.objectNames as Map<string, string>) ?? new Map<string, string>();
                const objectIsItemDisplay: Set<string> =
                    (loadedObjectGroup.userData.objectIsItemDisplay as Set<string>) ?? new Set<string>();
                const objectDisplayTypes: Map<string, string> =
                    (loadedObjectGroup.userData.objectDisplayTypes as Map<string, string>) ?? new Map<string, string>();
                const objectBlockProps: Map<string, any> =
                    (loadedObjectGroup.userData.objectBlockProps as Map<string, any>) ?? new Map<string, any>();
                const objectNbt: Map<string, string> =
                    (loadedObjectGroup.userData.objectNbt as Map<string, string>) ?? new Map<string, string>();
                const objectBrightness: Map<string, unknown> =
                    (loadedObjectGroup.userData.objectBrightness as Map<string, unknown>) ?? new Map<string, unknown>();
                const objectTextures: Map<string, string> =
                    (loadedObjectGroup.userData.objectTextures as Map<string, string>) ?? new Map<string, string>();

                if (activeGeometryBatches) {
                    for (const batch of activeGeometryBatches) {
                        const firstPart = batch.parts[0];
                        for (const instance of batch.instances) {
                            if (instance.uuid && !objectNamesMap.has(instance.uuid) && instance.name) {
                                objectNamesMap.set(instance.uuid, instance.name);
                            }
                            const instanceIsItemDisplay = (instance as any).isItemDisplayModel ?? firstPart?.isItemDisplayModel;
                            const instanceItemDisplayType = (instance as any).itemDisplayType ?? (firstPart as any)?.itemDisplayType;
                            if (instance.uuid && instanceIsItemDisplay) {
                                objectIsItemDisplay.add(instance.uuid);
                                if (instanceItemDisplayType) {
                                    objectDisplayTypes.set(instance.uuid, instanceItemDisplayType);
                                }
                            }
                            const instanceBlockProps = (instance as any).blockProps ?? (firstPart as any)?.blockProps;
                            if (instance.uuid && firstPart && !instanceIsItemDisplay && instanceBlockProps) {
                                objectBlockProps.set(instance.uuid, instanceBlockProps);
                            }
                            if (instance.uuid) objectNbt.set(instance.uuid, instance.nbt ?? '');
                            if (instance.uuid && instance.brightness) objectBrightness.set(instance.uuid, instance.brightness);
                        }
                    }
                } else {
                    for (const meta of geometryMetas) {
                        if (meta.uuid && !objectNamesMap.has(meta.uuid) && meta.name) {
                            objectNamesMap.set(meta.uuid, meta.name);
                        }
                        if (meta.uuid && meta.isItemDisplayModel) {
                            objectIsItemDisplay.add(meta.uuid);
                            if ((meta as any).itemDisplayType) {
                                objectDisplayTypes.set(meta.uuid, (meta as any).itemDisplayType);
                            }
                        }
                        if (meta.uuid && !meta.isItemDisplayModel && (meta as any).blockProps) {
                            objectBlockProps.set(meta.uuid, (meta as any).blockProps);
                        }
                        if (meta.uuid) objectNbt.set(meta.uuid, meta.nbt ?? '');
                        if (meta.uuid && (meta as any).brightness) objectBrightness.set(meta.uuid, (meta as any).brightness);
                    }
                }
                for (const item of otherItems) {
                    if (item.uuid && !objectNamesMap.has(item.uuid) && (item as any).name) {
                        objectNamesMap.set(item.uuid, (item as any).name);
                    }
                    if (item.uuid && item.type === 'itemDisplay') {
                        objectIsItemDisplay.add(item.uuid);
                        if (item.displayType) {
                            objectDisplayTypes.set(item.uuid, item.displayType);
                        }
                    }
                    if (item.uuid) objectNbt.set(item.uuid, typeof item.nbt === 'string' ? item.nbt : '');
                    if (item.uuid && item.brightness) objectBrightness.set(item.uuid, item.brightness);
                    if (item.uuid && item.textureUrl) objectTextures.set(item.uuid, item.textureUrl);
                }
                loadedObjectGroup.userData.objectNames = objectNamesMap;
                loadedObjectGroup.userData.objectIsItemDisplay = objectIsItemDisplay;
                loadedObjectGroup.userData.objectDisplayTypes = objectDisplayTypes;
                loadedObjectGroup.userData.objectBlockProps = objectBlockProps;
                loadedObjectGroup.userData.objectNbt = objectNbt;
                loadedObjectGroup.userData.objectBrightness = objectBrightness;
                loadedObjectGroup.userData.objectTextures = objectTextures;

                // 로드 순서 보존 (merge 시는 덧붙임)
                const prevOrder: { type: 'group' | 'object', id: string }[] =
                    isMerge ? (loadedObjectGroup.userData.sceneOrder ?? []) : [];
                loadedObjectGroup.userData.sceneOrder = prevOrder.concat(sceneOrder ?? []);

                const instancedGeometries = new Map<string, THREE.BufferGeometry>();
                const mergedGeometryCache = new Map<string, THREE.BufferGeometry>();
                const instancedMaterials = new Map<string, THREE.Material>();
                const materialPromises = new Map<string, Promise<THREE.Material>>();
                const materialUpdates: MaterialUpdate[] = [];
                let createdInstancedMeshCount = 0;
                
                // Grouping structure: itemId -> all renderable parts for that scene object.
                const blocks = new Map<string, GeometryMeta[]>();

                ensureSharedPlaceholder();
                const placeholderMaterial = sharedPlaceholderMaterial as THREE.Material;

                const ensureInstancedMaterialPromise = (
                    part: GeometryMeta,
                    instancedUvTransformCount: number,
                    instancedUvTransformIndex: number
                ): Promise<THREE.Material> => {
                    const matKey = getMaterialKey(part, instancedUvTransformCount, instancedUvTransformIndex);
                    const cachedMaterial = instancedMaterials.get(matKey);
                    if (cachedMaterial) return Promise.resolve(cachedMaterial);

                    let promise = materialPromises.get(matKey);
                    if (!promise) {
                        promise = getBlockMaterial(part.texPath, part.tintHex, myGen, instancedUvTransformCount, instancedUvTransformIndex).then(material => {
                            if (myGen === currentLoadGen) {
                                instancedMaterials.set(matKey, material);
                            }
                            return material;
                        });
                        materialPromises.set(matKey, promise);
                    }
                    return promise;
                };

                const ensureBufferGeometry = (meta: GeometryMeta): void => {
                    const geomKey = getGeometryBufferKey(meta);
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
                        instancedGeometries.set(geomKey, geometry);
                    }
                };

                for (const meta of geometryMetas) {
                    ensureBufferGeometry(meta);

                    const instanceKey = String(meta.itemId);

                    let instanceParts = blocks.get(instanceKey);
                    if (!instanceParts) {
                        instanceParts = [];
                        blocks.set(instanceKey, instanceParts);
                    }
                    instanceParts.push(meta);
                }

                // Process grouped blocks
                // Group instances by Signature (combination of geometries, local transforms, and materials)
                const signatureStartMs = performance.now();
                const signatureGroups = new Map<string, SignatureGroup>();

                const addSignatureGroup = (parts: GeometryMeta[], instances: GeometryInstanceMeta[]) => {
                    parts.sort((a, b) => {
                        const geometryCompare = a.geometryId.localeCompare(b.geometryId);
                        if (geometryCompare !== 0) return geometryCompare;
                        return a.geometryIndex - b.geometryIndex;
                    });

                    for (const part of parts) {
                        ensureBufferGeometry(part);
                    }

                    const { signature: partSignature, geometryKey } = buildPartHashKeys(parts);
                    const signature = `${instances[0]?.isItemDisplayModel ? 'item' : 'block'}|${partSignature}`;
                    let group = signatureGroups.get(signature);
                    if (!group) {
                        group = { parts, instances: instances.slice(), geometryKey, instancedUvTransformCount: 0 };
                        signatureGroups.set(signature, group);
                    } else {
                        for (const instance of instances) group.instances.push(instance);
                    }
                };

                if (activeGeometryBatches) {
                    for (const batch of activeGeometryBatches as GeometryInstanceBatch[]) {
                        addSignatureGroup(batch.parts, batch.instances);
                    }
                } else {
                    for (const [_itemId, parts] of blocks) {
                        addSignatureGroup(parts, [{ transform: parts[0].transform, uuid: parts[0].uuid, groupId: parts[0].groupId }]);
                    }
                }
                const signatureElapsedMs = performance.now() - signatureStartMs;

                const reusableMeshes = new Map<string, THREE.InstancedMesh[]>();
                if (isMerge) {
                    for (const child of loadedObjectGroup.children) {
                        const mesh = child as THREE.InstancedMesh;
                        const signature = mesh.isInstancedMesh ? mesh.userData.pbdeSignature as string | undefined : undefined;
                        if (!signature) continue;
                        const meshes = reusableMeshes.get(signature) ?? [];
                        meshes.push(mesh);
                        reusableMeshes.set(signature, meshes);
                    }
                }

                const materialAwaitStartMs = performance.now();
                const materialPreloadPromises = new Set<Promise<THREE.Material>>();
                for (const [signature, group] of signatureGroups) {
                    const instancedUvTransformCount = getInstancedUvTransformCount(group.parts, group.instances);
                    group.instancedUvTransformCount = instancedUvTransformCount;
                    const reusableCapacity = reusableMeshes.get(signature)?.reduce(
                        (sum, mesh) => sum + Math.max(0, getInstancedCapacity(mesh) - mesh.count), 0
                    ) ?? 0;
                    if (instancedUvTransformCount === 0
                        && group.parts.every(part => !part.texPath.includes('__ATLAS__'))
                        && reusableCapacity >= group.instances.length) continue;
                    for (const [partIndex, part] of group.parts.entries()) {
                        materialPreloadPromises.add(ensureInstancedMaterialPromise(part, instancedUvTransformCount, partIndex));
                    }
                }
                const materialPreloadResults = await Promise.allSettled(materialPreloadPromises);
                const failedMaterialPreloads = materialPreloadResults.filter(result => result.status === 'rejected').length;
                if (failedMaterialPreloads > 0) {
                    console.warn(`[PBDE] Material preload failed for ${failedMaterialPreloads} slot${failedMaterialPreloads === 1 ? '' : 's'}; falling back to async material updates.`);
                }
                let materialAwaitElapsedMs = performance.now() - materialAwaitStartMs;

                // Create InstancedMesh for each signature group
                const meshBuildStartMs = performance.now();
                for (const [signature, group] of signatureGroups) {
                        const representativeParts = group.parts;
                        const instances = group.instances;
                        const instancedUvTransformCount = group.instancedUvTransformCount;
                        const usesAtlasUvTransform = instancedUvTransformCount > 0;
                        const hasReusableSignature = !usesAtlasUvTransform
                            && representativeParts.every(part => !part.texPath.includes('__ATLAS__'));
                        const canReuseExisting = isMerge && hasReusableSignature;
                        const instanceMatrix = new THREE.Matrix4();
                        let transformStart = 0;

                        if (canReuseExisting) {
                            for (const instancedMesh of reusableMeshes.get(signature) ?? []) {
                                const appendCount = Math.min(getInstancedCapacity(instancedMesh) - instancedMesh.count, instances.length - transformStart);
                                if (appendCount <= 0) continue;
                                for (let i = 0; i < appendCount; i++) {
                                    const sourceIndex = transformStart + i;
                                    const instanceId = instancedMesh.count + i;
                                    const meta = instances[sourceIndex];
                                    instanceMatrix.fromArray(meta.transform).transpose();
                                    instancedMesh.setMatrixAt(instanceId, instanceMatrix);
                                    setInstanceSkyBrightness(instancedMesh, instanceId, meta.brightness);
                                    registerObject(instancedMesh, instanceId, meta.uuid, meta.groupId);
                                    instancedMesh.userData.displayTypes.set(instanceId, getInstanceDisplayType(meta, representativeParts[0]));
                                    addLoadedInstance(newlyAddedSelectableMeshes, instancedMesh, instanceId);
                                }
                                instancedMesh.count += appendCount;
                                instancedMesh.instanceMatrix.needsUpdate = true;
                                if (instancedMesh.instanceColor) instancedMesh.instanceColor.needsUpdate = true;
                                instancedMesh.computeBoundingSphere();
                                transformStart += appendCount;
                                if (transformStart === instances.length) break;
                            }
                        }

                        if (transformStart === instances.length) continue;

                        // Merge Geometries
                        const materials: THREE.Material[] = [];
                        const pendingMaterialSlots: Array<{ index: number; promise: Promise<THREE.Material> }> = [];
                        let mergedGeo = mergedGeometryCache.get(group.geometryKey);

                        if (!mergedGeo) {
                            const geometriesToMerge: THREE.BufferGeometry[] = [];
                            const localMatrix = new THREE.Matrix4();

                            for (const part of representativeParts) {
                                const geomKey = getGeometryBufferKey(part);
                                const baseGeo = instancedGeometries.get(geomKey)!;
                                
                                // Clone and apply local transform (modelMatrix)
                                const clonedGeo = baseGeo.clone();
                                localMatrix.fromArray(part.modelMatrix);
                                clonedGeo.applyMatrix4(localMatrix);
                                geometriesToMerge.push(clonedGeo);
                            }

                            mergedGeo = mergeIndexedGeometries(geometriesToMerge) ?? undefined;
                            if (mergedGeo) {
                                // Add groups for multi-material support
                                let start = 0;
                                for (let i = 0; i < geometriesToMerge.length; i++) {
                                    const count = geometriesToMerge[i].getIndex()!.count;
                                    mergedGeo.addGroup(start, count, i);
                                    start += count;
                                }
                                mergedGeometryCache.set(group.geometryKey, mergedGeo);
                            }

                            for (const geometry of geometriesToMerge) {
                                geometry.dispose();
                            }
                        }

                        for (const [partIndex, part] of representativeParts.entries()) {
                            // Prepare Material
                            const matKey = getMaterialKey(part, instancedUvTransformCount, partIndex);
                            let material = instancedMaterials.get(matKey);
                            
                            if (!material) {
                                material = placeholderMaterial;
                                ensureInstancedMaterialPromise(part, instancedUvTransformCount, partIndex);
                                pendingMaterialSlots.push({ index: materials.length, promise: materialPromises.get(matKey)! });
                            }
                            materials.push(material);
                        }

                        if (mergedGeo) {
                            for (let chunkStart = transformStart; chunkStart < instances.length; chunkStart += INITIAL_INSTANCES_PER_INSTANCED_MESH) {
                                const chunkCount = Math.min(INITIAL_INSTANCES_PER_INSTANCED_MESH, instances.length - chunkStart);
                                const chunkCapacity = getAppendableInstanceCapacity(chunkCount);
                                const meshGeometry = mergedGeo.clone();
                                if (usesAtlasUvTransform) {
                                    for (let partIndex = 0; partIndex < instancedUvTransformCount; partIndex++) {
                                        const baseUvTransform = representativeParts[partIndex]?.uvTransform ?? representativeParts[0]?.uvTransform;
                                        const uvTransforms = new Float32Array(chunkCapacity * 4);
                                        for (let i = 0; i < chunkCount; i++) {
                                            const sourceIndex = chunkStart + i;
                                            const currentUvTransform = getInstancePartUvTransform(instances[sourceIndex], partIndex);
                                            const relativeUvTransform = getRelativeUvTransform(baseUvTransform, currentUvTransform);
                                            uvTransforms.set(relativeUvTransform, i * 4);
                                        }
                                        const attributeName = instancedUvTransformCount === 1
                                            ? 'instancedUvTransform'
                                            : `instancedUvTransform${partIndex}`;
                                        meshGeometry.setAttribute(attributeName, new THREE.InstancedBufferAttribute(uvTransforms, 4));
                                    }
                                }
                                meshGeometry.setAttribute(dragSelectedAttributeName, new THREE.InstancedBufferAttribute(new Float32Array(chunkCapacity), 1));
                                const instancedMesh = new THREE.InstancedMesh(meshGeometry, materials, chunkCapacity);
                                instancedMesh.instanceMatrix = new THREE.StorageInstancedBufferAttribute(chunkCapacity, 16);
                                instancedMesh.count = chunkCount;
                                
                                instancedMesh.userData.displayType = getInstanceDisplayType(instances[chunkStart], representativeParts[0]);
                                instancedMesh.userData.displayTypes = new Map<number, 'block_display' | 'item_display'>();
                                if (hasReusableSignature) instancedMesh.userData.pbdeSignature = signature;
                                
                                instancedMesh.frustumCulled = false;

                                for (let i = 0; i < chunkCount; i++) {
                                    const sourceIndex = chunkStart + i;
                                    const meta = instances[sourceIndex];
                                    instanceMatrix.fromArray(meta.transform).transpose();
                                    instancedMesh.setMatrixAt(i, instanceMatrix);
                                    setInstanceSkyBrightness(instancedMesh, i, meta.brightness);
                                    registerObject(instancedMesh, i, meta.uuid, meta.groupId);
                                    instancedMesh.userData.displayTypes.set(i, getInstanceDisplayType(meta, representativeParts[0]));
                                    addLoadedInstance(newlyAddedSelectableMeshes, instancedMesh, i);
                                }
                                instancedMesh.instanceMatrix.needsUpdate = true;
                                if (instancedMesh.instanceColor) instancedMesh.instanceColor.needsUpdate = true;
                                instancedMesh.computeBoundingSphere();
                                loadedObjectGroup.add(instancedMesh);
                                createdInstancedMeshCount++;

                                // Handle async material loading
                                if (pendingMaterialSlots.length > 0) {
                                    materialUpdates.push({ instancedMesh, materials, pendingMaterialSlots, signature });
                                } else {
                                    if (materials.some(m => m.transparent)) {
                                        instancedMesh.renderOrder = 1;
                                    }
                                }
                            }
                        }
                    }
                const meshBuildElapsedMs = performance.now() - meshBuildStartMs;

                if (materialUpdates.length > 0) {
                    const materialUpdateStartMs = performance.now();
                    await Promise.all(materialUpdates.map(async update => {
                        try {
                            const loadedMats = await Promise.all(update.pendingMaterialSlots.map(slot => slot.promise));
                            if (myGen !== currentLoadGen) return;
                            for (let i = 0; i < update.pendingMaterialSlots.length; i++) {
                                update.materials[update.pendingMaterialSlots[i].index] = loadedMats[i];
                            }
                            update.instancedMesh.material = update.materials;
                            if (update.materials.some(m => m.transparent)) {
                                update.instancedMesh.renderOrder = 1;
                            }
                        } catch (e) {
                            console.warn(`[Texture] Error loading materials for ${update.signature}:`, e);
                        }
                    }));
                    materialAwaitElapsedMs += performance.now() - materialUpdateStartMs;
                }

                const playerHeadItems: Array<OtherItem> = [];
                otherItems.forEach((item) => {
                    if (item.type === 'itemDisplay' && item.textureUrl) {
                        playerHeadItems.push(item);
                    }
                });

                const playerHeadStartMs = performance.now();
                if (playerHeadItems.length > 0) {
                    const playerHeadPromise = (async () => {
                        try {
                            if (!headGeometries || !headGeometries.merged) {
                                console.error("Head geometries not available for instancing.");
                                return;
                            }

                            const uniqueUrls = [...new Set(playerHeadItems.map(item => item.textureUrl))];
                            
                            const atlasCanvas = document.createElement('canvas');
                            atlasCanvas.width = PLAYER_HEAD_ATLAS_SIZE;
                            atlasCanvas.height = PLAYER_HEAD_ATLAS_SIZE;
                            const atlasCtx = atlasCanvas.getContext('2d');
                            if (!atlasCtx) return;
                            atlasCtx.imageSmoothingEnabled = false;

                            const skinLayouts = new Map<string, { x: number, y: number }>();
                            const skinTransparency = new Map<string, boolean>(); // URL -> isLayerTransparent
                            
                            const imagePromises = uniqueUrls.map((url, index) => {
                                return loadPlayerHeadImage(url).then(image => {
                                    const blockX = (index % PLAYER_HEAD_BLOCKS_PER_ROW) * PLAYER_HEAD_BLOCK_WIDTH;
                                    const blockY = Math.floor(index / PLAYER_HEAD_BLOCKS_PER_ROW) * PLAYER_HEAD_BLOCK_HEIGHT;
                                    skinLayouts.set(url, { x: blockX, y: blockY });
                                    skinTransparency.set(url, !drawPlayerHeadSlot(atlasCtx, image, index));
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
                            playerHeadAtlases.set(atlasMaterial, { context: atlasCtx, texture: atlasTexture, nextSlot: uniqueUrls.length });
                            
                            const sharedGeometry = (headGeometries.merged as THREE.BufferGeometry).clone();
                            const newUvAttr = sharedGeometry.getAttribute('uv') as THREE.BufferAttribute;
                            const uvMirrorCenters = new Float32Array(newUvAttr.count * 2);

                            const baseFaceOrder = ['left', 'right', 'top', 'bottom', 'front', 'back']; // BoxGeometry order
                            const allFaceKeys = [...baseFaceOrder, ...baseFaceOrder.map(k => `layer_${k}`)];

                            for (let faceIdx = 0; faceIdx < 12; faceIdx++) {
                                const partKey = allFaceKeys[faceIdx];
                                const partIndex = playerHeadPartOrder.indexOf(partKey as keyof typeof playerHeadFaceParts);

                                if (partIndex === -1) continue;

                                const dx = (partIndex % 3) * PLAYER_HEAD_PART_SIZE;
                                const dy = Math.floor(partIndex / 3) * PLAYER_HEAD_PART_SIZE;
                                
                                const inset = 0;
                                const u0 = (dx + inset) / PLAYER_HEAD_ATLAS_SIZE;
                                const u1 = (dx + PLAYER_HEAD_PART_SIZE - inset) / PLAYER_HEAD_ATLAS_SIZE;

                                const v1 = (PLAYER_HEAD_BLOCK_HEIGHT - dy - inset) / PLAYER_HEAD_ATLAS_SIZE;
                                const v0 = (PLAYER_HEAD_BLOCK_HEIGHT - (dy + PLAYER_HEAD_PART_SIZE) - inset) / PLAYER_HEAD_ATLAS_SIZE;
                                
                                const baseFaceName = baseFaceOrder[faceIdx % 6];
                                const uvWriteIndex = faceIdx * 4;
                                for (let vertex = 0; vertex < 4; vertex++) {
                                    uvMirrorCenters[(uvWriteIndex + vertex) * 2] = (u0 + u1) / 2;
                                    uvMirrorCenters[(uvWriteIndex + vertex) * 2 + 1] = (v0 + v1) / 2;
                                }
                                
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
                            sharedGeometry.setAttribute('uvMirrorCenter', new THREE.BufferAttribute(uvMirrorCenters, 2));

                            const totalInstances = playerHeadItems.length;
                            const headCapacity = getAppendableInstanceCapacity(totalInstances);
                            const matrices = new Float32Array(headCapacity * 16);
                            const uvOffsets = new Float32Array(headCapacity * 2);
                            const uvFlips = new Float32Array(headCapacity * 2);
                            const hasHatArray = new Array(totalInstances).fill(false);

                            let i = 0;
                            for (const item of playerHeadItems) {
                                const matrix = new THREE.Matrix4().fromArray(item.transform).transpose();
                                matrix.multiply(getPlayerHeadRenderMatrix(item.displayType));
                                matrix.toArray(matrices, i * 16);

                                const skinBlockPos = skinLayouts.get(item.textureUrl);
                                if (skinBlockPos) {
                                    const uOffset = skinBlockPos.x / PLAYER_HEAD_ATLAS_SIZE;
                                    const vOffset = 1.0 - (skinBlockPos.y + PLAYER_HEAD_BLOCK_HEIGHT) / PLAYER_HEAD_ATLAS_SIZE;
                                    
                                    uvOffsets[i * 2 + 0] = uOffset;
                                    uvOffsets[i * 2 + 1] = vOffset;
                                }

                                const isTransparent = skinTransparency.get(item.textureUrl);
                                // If layer is NOT transparent, it has a hat.
                                hasHatArray[i] = !isTransparent;

                                i++;
                            }
                            
                            sharedGeometry.setAttribute('instancedUvOffset', new THREE.InstancedBufferAttribute(uvOffsets, 2));
                            sharedGeometry.setAttribute('instancedUvFlip', new THREE.InstancedBufferAttribute(uvFlips, 2));
                            sharedGeometry.setAttribute(dragSelectedAttributeName, new THREE.InstancedBufferAttribute(new Float32Array(headCapacity), 1));

                            const instancedMesh = new THREE.InstancedMesh(sharedGeometry, atlasMaterial, headCapacity);
                            instancedMesh.instanceMatrix = new THREE.StorageInstancedBufferAttribute(matrices, 16);
                            instancedMesh.count = totalInstances;
                            instancedMesh.userData.displayType = 'item_display';
                            instancedMesh.userData.hasHat = hasHatArray; // Store hat info for gizmo
                            instancedMesh.instanceMatrix.needsUpdate = true;
                            instancedMesh.frustumCulled = false;
                            instancedMesh.layers.enable(2);
                            instancedMesh.computeBoundingSphere();

                            playerHeadItems.forEach((item, idx) => {
                                setInstanceSkyBrightness(instancedMesh, idx, item.brightness as Brightness | undefined);
                                registerObject(instancedMesh, idx, item.uuid, item.groupId);
                                addLoadedInstance(newlyAddedSelectableMeshes, instancedMesh, idx);
                            });
                            if (instancedMesh.instanceColor) instancedMesh.instanceColor.needsUpdate = true;

                            loadedObjectGroup.add(instancedMesh);

                        } catch (err) {
                            console.error('Player head instancing failed:', err);
                        }
                    })();

                    try { await playerHeadPromise; } catch { /* ignore */ }
                }
                const playerHeadElapsedMs = performance.now() - playerHeadStartMs;

                const meshUploadElapsedMs = performance.now() - meshUploadStartMs;
                if (isPbdeLogEnabled(pbdeLogNames.loadTimings)) {
                    console.log(
                        `[PBDE] Load timings: setup=${setupElapsedMs.toFixed(2)}ms, file=${fileReadElapsedMs.toFixed(2)}ms, parse=${parseElapsedMs.toFixed(2)}ms, atlas=${atlasElapsedMs.toFixed(2)}ms, signatures=${signatureElapsedMs.toFixed(2)}ms, meshBuild=${meshBuildElapsedMs.toFixed(2)}ms, materials=${materialAwaitElapsedMs.toFixed(2)}ms, playerHeads=${playerHeadElapsedMs.toFixed(2)}ms.`
                    );
                }
                if (isPbdeLogEnabled(pbdeLogNames.geometryStats)) {
                    console.log(
                        `[PBDE] Geometry stats: geometryItems=${geometryItemCount}, batches=${activeGeometryBatches?.length ?? 0}, signatures=${signatureGroups.size}, sourceGeometries=${instancedGeometries.size}, mergedGeometries=${mergedGeometryCache.size}, materials=${materialPromises.size}, materialUpdates=${materialUpdates.length}, instancedMeshes=${createdInstancedMeshCount}.`
                    );
                }
                if (isPbdeLogEnabled(pbdeLogNames.meshUploaded)) {
                    console.log(`[PBDE] Mesh uploaded to scene in ${meshUploadElapsedMs.toFixed(2)} ms (${file.name}, ${newlyAddedSelectableMeshes.size} mesh roots, ${loadedObjectGroup.children.length} scene children).`);
                }
                if (isPbdeLogEnabled(pbdeLogNames.finishedProcessing)) {
                    console.log(`[Debug] Finished processing. Total objects in group: ${loadedObjectGroup.children.length}`);
                }
                return newlyAddedSelectableMeshes;

}

function applyPlayerHeadTexture(objectUuid: string, textureUrl: string, image: HTMLImageElement): void {
    const userData = loadedObjectGroup.userData;
    const ref = (userData.objectUuidToInstance as Map<string, { mesh: THREE.InstancedMesh; instanceId: number }> | undefined)?.get(objectUuid);
    if (!ref) throw new Error('텍스처를 변경할 플레이어 헤드를 찾을 수 없습니다.');

    const material = (Array.isArray(ref.mesh.material) ? ref.mesh.material[0] : ref.mesh.material) as THREE.Material;
    const atlas = playerHeadAtlases.get(material);
    const uvOffsets = ref.mesh.geometry.getAttribute('instancedUvOffset') as THREE.InstancedBufferAttribute | undefined;
    if (!atlas || !uvOffsets) throw new Error('플레이어 헤드 아틀라스를 찾을 수 없습니다.');

    const oldU = uvOffsets.getX(ref.instanceId);
    const oldV = uvOffsets.getY(ref.instanceId);
    let usageCount = 0;
    loadedObjectGroup.traverse(object => {
        if (!(object as THREE.InstancedMesh).isInstancedMesh) return;
        const mesh = object as THREE.InstancedMesh;
        const meshMaterial = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
        if (meshMaterial !== material) return;
        const offsets = mesh.geometry.getAttribute('instancedUvOffset') as THREE.InstancedBufferAttribute | undefined;
        if (!offsets) return;
        for (let index = 0; index < mesh.count; index++) {
            if (offsets.getX(index) === oldU && offsets.getY(index) === oldV) usageCount++;
        }
    });

    let slot = Math.round(oldU * PLAYER_HEAD_ATLAS_SIZE / PLAYER_HEAD_BLOCK_WIDTH)
        + Math.round((1 - oldV) * PLAYER_HEAD_ATLAS_SIZE / PLAYER_HEAD_BLOCK_HEIGHT - 1) * PLAYER_HEAD_BLOCKS_PER_ROW;
    if (usageCount > 1) slot = atlas.nextSlot++;
    const maxSlots = PLAYER_HEAD_BLOCKS_PER_ROW * Math.floor(PLAYER_HEAD_ATLAS_SIZE / PLAYER_HEAD_BLOCK_HEIGHT);
    if (slot >= maxSlots) throw new Error('플레이어 헤드 아틀라스 슬롯이 부족합니다.');

    ref.mesh.userData.hasHat[ref.instanceId] = drawPlayerHeadSlot(atlas.context, image, slot);
    uvOffsets.setXY(
        ref.instanceId,
        (slot % PLAYER_HEAD_BLOCKS_PER_ROW) * PLAYER_HEAD_BLOCK_WIDTH / PLAYER_HEAD_ATLAS_SIZE,
        1 - (Math.floor(slot / PLAYER_HEAD_BLOCKS_PER_ROW) + 1) * PLAYER_HEAD_BLOCK_HEIGHT / PLAYER_HEAD_ATLAS_SIZE
    );
    uvOffsets.needsUpdate = true;
    atlas.texture.needsUpdate = true;
    (userData.objectTextures as Map<string, string> | undefined)?.set(
        objectUuid,
        image.src === DEFAULT_PLAYER_HEAD_TEXTURE ? DEFAULT_PLAYER_HEAD_TEXTURE : textureUrl
    );
}

export async function updatePlayerHeadTexture(objectUuid: string, textureUrl: string): Promise<void> {
    applyPlayerHeadTexture(objectUuid, textureUrl, await loadPlayerHeadImage(textureUrl));
    window.dispatchEvent(new CustomEvent('pde:scene-updated'));
}

export async function flipPlayerHeadTextures(objectUuids: string[]): Promise<void> {
    const userData = loadedObjectGroup.userData;
    const refs = userData.objectUuidToInstance as Map<string, { mesh: THREE.InstancedMesh; instanceId: number }> | undefined;
    const prepared = (await Promise.all(objectUuids.map(async objectUuid => {
        const ref = refs?.get(objectUuid);
        const flips = ref?.mesh.geometry.getAttribute('instancedUvFlip') as THREE.InstancedBufferAttribute | undefined;
        if (!ref || !flips) return null;
        const texture = (userData.objectTextures as Map<string, string> | undefined)?.get(objectUuid) ?? DEFAULT_PLAYER_HEAD_TEXTURE;
        const image = await loadPlayerHeadImage(texture);
        const dataUrl = playerHeadTextureDataUrl(image, flips.getX(ref.instanceId) < 0.5);
        return { objectUuid, ref, flips, dataUrl, image: dataUrl ? await loadPlayerHeadImage(dataUrl) : null };
    }))).filter(prepared => prepared !== null);
    for (const { objectUuid, ref, flips, dataUrl, image } of prepared) {
        if (dataUrl && image) applyPlayerHeadTexture(objectUuid, dataUrl, image);
        flips.setX(ref.instanceId, 0);
        flips.needsUpdate = true;
    }
}

export async function updateDisplayObjectMatrix(objectUuid: string, name: string): Promise<void> {
    const userData = loadedObjectGroup.userData;
    const ref = (userData.objectUuidToInstance as Map<string, { mesh: THREE.InstancedMesh; instanceId: number }> | undefined)?.get(objectUuid);
    if (!ref) throw new Error('변경할 디스플레이 오브젝트를 찾을 수 없습니다.');

    const names = userData.objectNames as Map<string, string>;
    const displayTypes = userData.objectDisplayTypes as Map<string, string>;
    const oldName = names.get(objectUuid) ?? name;
    const oldDisplayType = displayTypes.get(objectUuid);
    const newDisplayType = /\bdisplay=([^,\]]+)/.exec(name)?.[1];
    const matrix = new THREE.Matrix4();
    ref.mesh.getMatrixAt(ref.instanceId, matrix);

    if (name.startsWith('player_head')) {
        matrix.multiply(getPlayerHeadRenderMatrix(oldDisplayType).invert()).multiply(getPlayerHeadRenderMatrix(newDisplayType));
    } else {
        const [oldModelMatrix, newModelMatrix] = await Promise.all([
            getItemDisplayModelMatrix(oldName),
            getItemDisplayModelMatrix(name)
        ]);
        if (!oldModelMatrix || !newModelMatrix) throw new Error('디스플레이 행렬을 계산할 수 없습니다.');
        matrix.multiply(newModelMatrix.multiply(oldModelMatrix.invert()));
    }

    const pivot = (ref.mesh.userData.customPivots as Map<number, THREE.Vector3> | undefined)?.get(ref.instanceId)?.clone()
        ?? Overlay.getInstanceLocalBox(ref.mesh, ref.instanceId)?.getCenter(new THREE.Vector3());
    if (ref.mesh.userData.hasHat) pivot?.setY(Overlay.isItemDisplayHatEnabled(ref.mesh, ref.instanceId) ? 0.03125 : 0);
    if (pivot) {
        const oldMatrix = new THREE.Matrix4();
        ref.mesh.getMatrixAt(ref.instanceId, oldMatrix);
        const target = pivot.clone().applyMatrix4(oldMatrix);
        const offset = target.sub(pivot.clone().applyMatrix4(matrix));
        matrix.elements[12] += offset.x;
        matrix.elements[13] += offset.y;
        matrix.elements[14] += offset.z;
    }

    ref.mesh.setMatrixAt(ref.instanceId, matrix);
    ref.mesh.instanceMatrix.needsUpdate = true;
    ref.mesh.computeBoundingBox();
    ref.mesh.computeBoundingSphere();
    names.set(objectUuid, name);
    if (newDisplayType) displayTypes.set(objectUuid, newDisplayType);
    else displayTypes.delete(objectUuid);
    window.dispatchEvent(new CustomEvent('pde:scene-updated'));
}

export async function replaceDisplayObjects(requests: Array<{
    objectUuid: string;
    name: string;
    transformContext?: { pivotMode: string; pivotWorld?: THREE.Vector3 };
}>): Promise<string[]> {
    if (requests.length === 0) return [];
    const ud = loadedObjectGroup.userData;
    const refs = ud.objectUuidToInstance as Map<string, { mesh: THREE.InstancedMesh; instanceId: number }>;
    const replacements = requests.map(({ objectUuid, name, transformContext }) => {
        const oldRef = refs?.get(objectUuid);
        if (!oldRef?.mesh?.isInstancedMesh) throw new Error('교체할 오브젝트를 찾을 수 없습니다.');

        const oldMatrix = new THREE.Matrix4();
        oldRef.mesh.getMatrixAt(oldRef.instanceId, oldMatrix);
        const displayedMatrix = oldMatrix.clone();
        const oldDisplayType = (ud.objectDisplayTypes as Map<string, string> | undefined)?.get(objectUuid);
        const oldGeometryDisplayType = Overlay.getDisplayType(oldRef.mesh, oldRef.instanceId);
        if (name.startsWith('player_head')) oldMatrix.multiply(getPlayerHeadRenderMatrix(oldDisplayType).invert());
        const groupId = (ud.objectToGroup as Map<string, string> | undefined)?.get(`${oldRef.mesh.uuid}_${oldRef.instanceId}`);
        const group = groupId ? (ud.groups as Map<string, GroupData> | undefined)?.get(groupId) : undefined;
        const customPivot = (oldRef.mesh.userData.customPivots as Map<number, THREE.Vector3> | undefined)?.get(oldRef.instanceId)?.clone();
        const pivot = transformContext?.pivotMode === 'center'
            ? Overlay.getInstanceLocalBox(oldRef.mesh, oldRef.instanceId)?.getCenter(new THREE.Vector3())
            : customPivot ?? (oldGeometryDisplayType === 'block_display'
                ? Overlay.getInstanceLocalBoxMin(oldRef.mesh, oldRef.instanceId)
                : Overlay.getInstanceLocalBox(oldRef.mesh, oldRef.instanceId)?.getCenter(new THREE.Vector3()));
        if (oldGeometryDisplayType === 'item_display' && oldRef.mesh.userData.hasHat) pivot?.setY(Overlay.isItemDisplayHatEnabled(oldRef.mesh, oldRef.instanceId) ? 0.03125 : 0);
        const pivotWorld = transformContext?.pivotWorld?.clone()
            ?? pivot?.clone().applyMatrix4(oldRef.mesh.matrixWorld.clone().multiply(displayedMatrix));
        const replacementUuid = THREE.MathUtils.generateUUID();
        const label = (ud.objectLabels as Map<string, string> | undefined)?.get(objectUuid);
        const isItemDisplay = (ud.objectIsItemDisplay as Set<string> | undefined)?.has(objectUuid) ?? false;
        const texture = (ud.objectTextures as Map<string, string> | undefined)?.get(objectUuid);
        return {
            objectUuid, replacementUuid, label, groupId, group,
            groupIndex: group?.children.findIndex(child => child.type === 'object' && child.id === objectUuid) ?? -1,
            sceneIndex: (ud.sceneOrder as Array<{ type: 'group' | 'object'; id: string }> | undefined)
                ?.findIndex(entry => entry.type === 'object' && entry.id === objectUuid) ?? -1,
            customPivot,
            customPivotWorld: customPivot?.clone().applyMatrix4(oldRef.mesh.matrixWorld.clone().multiply(displayedMatrix)),
            pivotWorld,
            transformContext,
            node: {
                uuid: replacementUuid,
                name,
                nbt: (ud.objectNbt as Map<string, string> | undefined)?.get(objectUuid) ?? '',
                transforms: oldMatrix.clone().transpose().toArray(),
                brightness: (ud.objectBrightness as Map<string, unknown> | undefined)?.get(objectUuid),
                tagHead: texture ? { Value: btoa(JSON.stringify({ textures: { SKIN: { url: texture } } })) } : undefined,
                isBlockDisplay: !isItemDisplay,
                isItemDisplay
            }
        };
    });
    if (import.meta.env.DEV) console.assert(
        replacements.every((replacement, index) => replacement.objectUuid === requests[index].objectUuid),
        'Display replacement batch order changed.'
    );
    const json = strToU8(JSON.stringify([{ children: replacements.map(({ node }) => node) }]));
    const raw = new Uint8Array(18 + json.length);
    raw.set([80, 82, 74, 50], 0);
    raw.set(strToU8('scene.json'), 4);
    new DataView(raw.buffer).setUint32(14, json.length, true);
    raw.set(json, 18);

    await loadAndRenderPbde(new File([compressSync(raw)], 'object-update.pbde'), true);
    for (const state of replacements) {
        const oldRef = refs.get(state.objectUuid);
        if (!oldRef) throw new Error('변경한 오브젝트 모델을 만들 수 없습니다.');
        if (state.label !== undefined) (ud.objectLabels as Map<string, string>).set(state.replacementUuid, state.label);
        const oldLastInstanceId = oldRef.mesh.count - 1;

        deleteSelectedItems(loadedObjectGroup, {
            groups: new Set(),
            objects: new Map([[oldRef.mesh, new Set([oldRef.instanceId])]])
        }, { resetSelectionAndDeselect: () => {} });

        const replacement = refs.get(state.replacementUuid);
        if (!replacement) throw new Error('변경한 오브젝트 모델을 만들 수 없습니다.');
        const replacementKey = `${replacement.mesh.uuid}_${replacement.instanceId}`;
        if (state.groupId && state.group) {
            (ud.objectToGroup as Map<string, string>).set(replacementKey, state.groupId);
            const child = { type: 'object' as const, id: state.replacementUuid, mesh: replacement.mesh, instanceId: replacement.instanceId };
            if (state.groupIndex >= 0) state.group.children.splice(state.groupIndex, 0, child);
            else state.group.children.push(child);
        }
        const nextSceneOrder = ud.sceneOrder as Array<{ type: 'group' | 'object'; id: string }> | undefined;
        if (nextSceneOrder) {
            const replacementIndex = nextSceneOrder.findIndex(entry => entry.type === 'object' && entry.id === state.replacementUuid);
            if (replacementIndex >= 0) nextSceneOrder.splice(replacementIndex, 1);
            nextSceneOrder.splice(state.sceneIndex >= 0 ? state.sceneIndex : nextSceneOrder.length, 0, { type: 'object', id: state.replacementUuid });
        }
        if (state.pivotWorld && (!state.customPivot || state.transformContext?.pivotMode === 'center')) {
            const replacementMatrix = new THREE.Matrix4();
            replacement.mesh.getMatrixAt(replacement.instanceId, replacementMatrix);
            const replacementDisplayType = Overlay.getDisplayType(replacement.mesh, replacement.instanceId);
            const replacementPivot = state.transformContext?.pivotMode === 'center'
                ? Overlay.getInstanceLocalBox(replacement.mesh, replacement.instanceId)?.getCenter(new THREE.Vector3())
                : replacementDisplayType === 'block_display'
                ? Overlay.getInstanceLocalBoxMin(replacement.mesh, replacement.instanceId)
                : Overlay.getInstanceLocalBox(replacement.mesh, replacement.instanceId)?.getCenter(new THREE.Vector3());
            if (replacementDisplayType === 'item_display' && replacement.mesh.userData.hasHat) replacementPivot?.setY(Overlay.isItemDisplayHatEnabled(replacement.mesh, replacement.instanceId) ? 0.03125 : 0);
            if (replacementPivot) {
                const target = state.pivotWorld.applyMatrix4(replacement.mesh.matrixWorld.clone().invert());
                const offset = target.sub(replacementPivot.applyMatrix4(replacementMatrix));
                replacementMatrix.elements[12] += offset.x;
                replacementMatrix.elements[13] += offset.y;
                replacementMatrix.elements[14] += offset.z;
                replacement.mesh.setMatrixAt(replacement.instanceId, replacementMatrix);
                replacement.mesh.instanceMatrix.needsUpdate = true;
            }
        }
        if (state.customPivotWorld) {
            if (!replacement.mesh.userData.customPivots) replacement.mesh.userData.customPivots = new Map<number, THREE.Vector3>();
            const replacementMatrix = new THREE.Matrix4();
            replacement.mesh.getMatrixAt(replacement.instanceId, replacementMatrix);
            replacement.mesh.userData.customPivots.set(
                replacement.instanceId,
                state.customPivotWorld.applyMatrix4(replacement.mesh.matrixWorld.clone().multiply(replacementMatrix).invert())
            );
        }

        window.dispatchEvent(new CustomEvent('pde:replace-object-selection', {
            detail: {
                oldMesh: oldRef.mesh,
                oldInstanceId: oldRef.instanceId,
                oldLastInstanceId,
                mesh: replacement.mesh,
                instanceId: replacement.instanceId
            }
        }));
    }
    window.dispatchEvent(new CustomEvent('pde:scene-updated'));
    return replacements.map(({ replacementUuid }) => replacementUuid);
}

export async function replaceDisplayObject(
    objectUuid: string,
    name: string,
    transformContext?: { pivotMode: string; pivotWorld?: THREE.Vector3 }
): Promise<string> {
    return (await replaceDisplayObjects([{ objectUuid, name, transformContext }]))[0];
}

export function updateObjectBrightness(objectUuid: string, brightness: { sky: number; block: number }): void {
    const ud = loadedObjectGroup.userData;
    const ref = (ud.objectUuidToInstance as Map<string, { mesh: THREE.InstancedMesh; instanceId: number }> | undefined)?.get(objectUuid);
    if (!ref?.mesh?.isInstancedMesh) return;
    (ud.objectBrightness as Map<string, { sky: number; block: number }>).set(objectUuid, brightness);
    setInstanceSkyBrightness(ref.mesh, ref.instanceId, brightness);
    if (ref.mesh.instanceColor) ref.mesh.instanceColor.needsUpdate = true;
    window.dispatchEvent(new CustomEvent('pde:scene-updated'));
}

export function updateGlobalBrightness(brightness: GlobalBrightness): void {
    const ud = loadedObjectGroup.userData;
    ud.globalBrightness = brightness;
    const objectBrightness = ud.objectBrightness as Map<string, Brightness> | undefined;
    for (const [uuid, ref] of (ud.objectUuidToInstance as Map<string, { mesh: THREE.InstancedMesh; instanceId: number }> | undefined) ?? []) {
        if (!ref.mesh.isInstancedMesh) continue;
        setInstanceSkyBrightness(ref.mesh, ref.instanceId, objectBrightness?.get(uuid));
        if (ref.mesh.instanceColor) ref.mesh.instanceColor.needsUpdate = true;
    }
    window.dispatchEvent(new CustomEvent('pde:scene-updated'));
}
