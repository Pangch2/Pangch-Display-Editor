import * as THREE from 'three/webgpu';
import { type HeadUvEntry, resetHeadAtlasUvs, createHeadAtlasUvTexture, captureHeadAtlasUvs, setHeadAtlasUvRect, readHeadAtlasRegion } from '../../ui/head-atlas-uv';
import { getPlayerHeadDisplayMatrix } from '../scene/scene-parser';
import { type HeadGeometrySet, type TypedArrayConstructor } from '../pbde/pbde-types';
import { createEntityMaterial, setEntityStateAttributes } from '../../entity-material';
import { loadedObjectGroup } from './display-instancing';
import { MAX_INSTANCES_PER_INSTANCED_MESH } from './display-instancing';
import { isApplying } from '../../controls/undo-redo/undo-redo';

export const PLAYER_HEAD_ATLAS_SIZE = 2048;
const PLAYER_HEAD_PART_SIZE = 8;
export const PLAYER_HEAD_BLOCK_WIDTH = PLAYER_HEAD_PART_SIZE * 3;
export const PLAYER_HEAD_BLOCK_HEIGHT = PLAYER_HEAD_PART_SIZE * 4;
export const PLAYER_HEAD_BLOCKS_PER_ROW = Math.floor(PLAYER_HEAD_ATLAS_SIZE / PLAYER_HEAD_BLOCK_WIDTH);
const MAX_PLAYER_HEAD_SLOTS_PER_ATLAS = PLAYER_HEAD_BLOCKS_PER_ROW * Math.floor(PLAYER_HEAD_ATLAS_SIZE / PLAYER_HEAD_BLOCK_HEIGHT);
export const PLAYER_HEAD_LAYER_SCALE = 1.0625;
const playerHeadFaceParts = {
    right: [16, 8], left: [0, 8], top: [8, 0], bottom: [16, 0], front: [24, 8], back: [8, 8],
    layer_right: [48, 8], layer_left: [32, 8], layer_top: [40, 0], layer_bottom: [48, 0], layer_front: [56, 8], layer_back: [40, 8]
} as const;
const playerHeadPartOrder = Object.keys(playerHeadFaceParts) as Array<keyof typeof playerHeadFaceParts>;
const playerHeadLayerRegions = [[48, 8, 8, 8], [32, 8, 8, 8], [40, 0, 8, 8], [48, 0, 8, 8], [56, 8, 8, 8], [40, 8, 8, 8]];
export type PlayerHeadSkin = { slot: number; hasHat: boolean };
export type PlayerHeadAtlas = {
    context: CanvasRenderingContext2D;
    texture: THREE.Texture;
    material: THREE.Material;
    nextSlot: number;
    freeSlots: number[];
    imageHeadNextTile?: number;
    imageHeadReservedSlots?: number;
    imageHeadTiles?: Set<number>;
    imageHeadTileKeys?: Map<string, number>;
    skins: Map<string, PlayerHeadSkin>;
    slotUrls: Array<string | undefined>;
};
type PlayerHeadAtlasRegionSnapshot = {
    x: number;
    y: number;
    width: number;
    height: number;
    data: Uint8ClampedArray;
    uvs?: HeadUvEntry[];
};
type PlayerHeadAtlasSnapshot = {
    material: THREE.Material;
    targeted?: boolean;
    nextSlot?: number;
    freeSlots?: number[];
    imageHeadNextTile?: number;
    imageHeadReservedSlots?: number;
    imageHeadTiles?: number[];
    imageHeadTileKeys?: Array<[string, number]>;
    skins?: Map<string, PlayerHeadSkin>;
    slotUrls?: Array<string | undefined>;
    slotEntries?: Array<{ slot: number; url?: string; skin?: PlayerHeadSkin }>;
    instances?: Array<{ uuid: string; offset: [number, number]; flip?: [number, number]; texture?: string; hasHat?: boolean; tile?: [number, number]; knifeScale?: [number, number, number]; knifeOffset?: [number, number, number] }>;
    regions: PlayerHeadAtlasRegionSnapshot[];
};
const playerHeadAtlases = new WeakMap<THREE.Material, PlayerHeadAtlas>();
let imageHeadBlackMaterial: THREE.Material | null = null;
export const deferredPlayerHeadTexture = 'pde:deferred-player-head-texture';

export function getPlayerHeadRenderMatrix(displayType?: string): THREE.Matrix4 {
    return (getPlayerHeadDisplayMatrix(displayType) ?? new THREE.Matrix4())
        .multiply(new THREE.Matrix4().makeScale(0.5, 0.5, 0.5));
}


export type PlayerHeadPaintSurface = {
    mesh: THREE.InstancedMesh;
    instanceId: number;
    objectUuid: string;
    context: CanvasRenderingContext2D;
    texture: THREE.Texture;
    slot: number;
    x: number;
    y: number;
    denseLayer?: 0 | 1;
};

// --- 최적화: 지오메트리 미리 생성 ---
export let headGeometries: HeadGeometrySet | null = null;


// 동일한 속성 구성을 가진 인덱스 지오메트리를 하나로 병합한다.
export function mergeIndexedGeometries(geometries: THREE.BufferGeometry[]): THREE.BufferGeometry | null {
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
export function createHeadGeometries() {
    if (headGeometries) return; // 이미 생성되었다면 실행하지 않음

    const createGeometry = (isLayer: boolean): THREE.BoxGeometry => {
        const scale = isLayer ? PLAYER_HEAD_LAYER_SCALE : 1.0;
        const geometry = new THREE.BoxGeometry(scale, scale, scale);
        geometry.translate(0, -0.5, 0);
        geometry.setAttribute('headLayer', new THREE.BufferAttribute(
            new Float32Array((geometry.getAttribute('position') as THREE.BufferAttribute).count).fill(isLayer ? 1 : 0), 1
        ));
        

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

export function createPlayerHeadAtlasGeometry(includeLayer = true): THREE.BufferGeometry {
    createHeadGeometries();
    if (!headGeometries?.merged) throw new Error('Head geometries not available for instancing.');
    const geometry = (includeLayer ? headGeometries.merged : headGeometries.base).clone();
    const uvs = geometry.getAttribute('uv') as THREE.BufferAttribute;
    const uvMirrorCenters = new Float32Array(uvs.count * 2);
    const faceOrder = ['left', 'right', 'top', 'bottom', 'front', 'back'];

    [...faceOrder, ...(includeLayer ? faceOrder.map(face => `layer_${face}`) : [])].forEach((key, faceIndex) => {
        const partIndex = playerHeadPartOrder.indexOf(key as keyof typeof playerHeadFaceParts);
        const x = (partIndex % 3) * PLAYER_HEAD_PART_SIZE;
        const y = Math.floor(partIndex / 3) * PLAYER_HEAD_PART_SIZE;
        const u0 = x / PLAYER_HEAD_ATLAS_SIZE;
        const u1 = (x + PLAYER_HEAD_PART_SIZE) / PLAYER_HEAD_ATLAS_SIZE;
        const v0 = (PLAYER_HEAD_BLOCK_HEIGHT - y - PLAYER_HEAD_PART_SIZE) / PLAYER_HEAD_ATLAS_SIZE;
        const v1 = (PLAYER_HEAD_BLOCK_HEIGHT - y) / PLAYER_HEAD_ATLAS_SIZE;
        const offset = faceIndex * 4;
        for (let vertex = 0; vertex < 4; vertex++) {
            uvMirrorCenters[(offset + vertex) * 2] = (u0 + u1) / 2;
            uvMirrorCenters[(offset + vertex) * 2 + 1] = (v0 + v1) / 2;
        }
        if (key.endsWith('top')) {
            uvs.setXY(offset, u1, v0); uvs.setXY(offset + 1, u0, v0);
            uvs.setXY(offset + 2, u1, v1); uvs.setXY(offset + 3, u0, v1);
        } else if (key.endsWith('bottom')) {
            uvs.setXY(offset, u1, v1); uvs.setXY(offset + 1, u0, v1);
            uvs.setXY(offset + 2, u1, v0); uvs.setXY(offset + 3, u0, v0);
        } else {
            uvs.setXY(offset, u0, v1); uvs.setXY(offset + 1, u1, v1);
            uvs.setXY(offset + 2, u0, v0); uvs.setXY(offset + 3, u1, v0);
        }
    });
    geometry.setAttribute('uvMirrorCenter', new THREE.BufferAttribute(uvMirrorCenters, 2));
    return geometry;
}

function createImageHeadAtlasGeometry(layer: 0 | 1): THREE.BufferGeometry {
    const geometry = createPlayerHeadAtlasGeometry(layer === 1);
    const blackUvs = geometry.getAttribute('uv') as THREE.BufferAttribute;
    const frontFace = layer ? 10 : 4;
    for (let vertex = 0; vertex < blackUvs.count; vertex++) {
        if (Math.floor(vertex / 4) !== frontFace) blackUvs.setXY(vertex, 1 - 4 / PLAYER_HEAD_ATLAS_SIZE, 1 - 4 / PLAYER_HEAD_ATLAS_SIZE);
    }
    const frontIndex = frontFace * 6;
    geometry.clearGroups();
    geometry.addGroup(0, frontIndex, 1);
    geometry.addGroup(frontIndex, 6, 0);
    geometry.addGroup(frontIndex + 6, geometry.getIndex()!.count - frontIndex - 6, 1);
    if (import.meta.env.DEV) console.assert(
        geometry.getIndex()!.count === (layer ? 72 : 36) && geometry.groups[1].start === frontIndex,
        'Image head layer geometry is invalid.'
    );
    return geometry;
}

function getImageHeadBlackMaterial(texture: THREE.Texture): THREE.Material {
    if (imageHeadBlackMaterial) return imageHeadBlackMaterial;
    imageHeadBlackMaterial = createEntityMaterial(texture, 0xffffff, false, false, 1, 0, true, true).material;
    return imageHeadBlackMaterial;
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

export function loadPlayerHeadImage(url: string): Promise<HTMLImageElement> {
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

export function drawPlayerHeadSlot(context: CanvasRenderingContext2D, image: HTMLImageElement, slot: number): boolean {
    const blockX = (slot % PLAYER_HEAD_BLOCKS_PER_ROW) * PLAYER_HEAD_BLOCK_WIDTH;
    const blockY = Math.floor(slot / PLAYER_HEAD_BLOCKS_PER_ROW) * PLAYER_HEAD_BLOCK_HEIGHT;
    resetHeadAtlasUvs(context.canvas, { x: blockX, y: blockY, width: PLAYER_HEAD_BLOCK_WIDTH, height: PLAYER_HEAD_BLOCK_HEIGHT });
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

export function getProjectPlayerHeadAtlases(): PlayerHeadAtlas[] {
    const materials = (loadedObjectGroup.userData.playerHeadAtlasMaterials as THREE.Material[] | undefined)
        ?? (loadedObjectGroup.userData.playerHeadAtlasMaterials = []);
    return materials.map(material => playerHeadAtlases.get(material)).filter(atlas => atlas !== undefined);
}

export function notifyPlayerHeadAtlasesChanged(): void {
    window.dispatchEvent(new CustomEvent('pde:player-head-atlases-changed', {
        detail: getProjectPlayerHeadAtlases().map(atlas => atlas.context.canvas)
    }));
}

export type PlayerHeadAtlasFace = { x: number; y: number; name: string; surfaces: PlayerHeadPaintSurface[] };

export function getPlayerHeadAtlasFaces(canvas: HTMLCanvasElement): PlayerHeadAtlasFace[] {
    const faces = new Map<string, PlayerHeadAtlasFace>();
    const names = ['오른쪽', '왼쪽', '위', '아래', '앞', '뒤'];
    collectPlayerHeadAtlasUsage(undefined, (mesh, instanceId, material) => {
        if (playerHeadAtlases.get(material)?.context.canvas !== canvas) return;
        const surface = getPlayerHeadPaintSurface(mesh, instanceId);
        if (!surface) return;
        const parts = surface.denseLayer === undefined ? playerHeadPartOrder.map((_, index) => index) : [4 + surface.denseLayer * 6];
        for (const part of parts) {
            const x = surface.x + (surface.denseLayer === undefined ? part % 3 * 8 : 0);
            const y = surface.y + (surface.denseLayer === undefined ? Math.floor(part / 3) * 8 : 0);
            const key = `${x},${y}`;
            let face = faces.get(key);
            if (!face) {
                face = { x, y, name: `${part < 6 ? '기본' : '겉'} ${names[part % 6]}`, surfaces: [] };
                faces.set(key, face);
            }
            face.surfaces.push(surface);
        }
    });
    return [...faces.values()];
}

function findAvailablePlayerHeadAtlas<T extends { nextSlot: number; freeSlots?: number[] }>(atlases: T[]): T | undefined {
    return atlases.find(atlas => !!atlas.freeSlots?.length || atlas.nextSlot < MAX_PLAYER_HEAD_SLOTS_PER_ATLAS);
}

export function getOrCreatePlayerHeadAtlas<T extends { nextSlot: number; freeSlots?: number[] }>(atlases: T[], create: () => T): T {
    const atlas = findAvailablePlayerHeadAtlas(atlases) ?? create();
    if (!atlases.includes(atlas)) atlases.push(atlas);
    return atlas;
}

if (import.meta.env.DEV) {
    const full = { nextSlot: MAX_PLAYER_HEAD_SLOTS_PER_ATLAS };
    const created = { nextSlot: 0 };
    const atlases = [full];
    console.assert(getOrCreatePlayerHeadAtlas(atlases, () => created) === created && atlases[1] === created, 'Player head atlas rollover is broken.');
    const reusable = { nextSlot: MAX_PLAYER_HEAD_SLOTS_PER_ATLAS, freeSlots: [3] } as PlayerHeadAtlas;
    console.assert(findAvailablePlayerHeadAtlas([reusable]) === reusable && takePlayerHeadSlot(reusable) === 3, 'Player head atlas slot reuse is broken.');
    const dense = { imageHeadNextTile: 0, imageHeadReservedSlots: 1, imageHeadTiles: new Set([3]) } as PlayerHeadAtlas;
    console.assert(takeImageHeadTile(dense, 256 * 256) === 4, 'Occupied image head atlas tiles must append after the used range.');
    const tile = new Uint8ClampedArray(PLAYER_HEAD_PART_SIZE * PLAYER_HEAD_PART_SIZE * 4);
    tile[0] = 255;
    const tileCopy = tile.slice();
    console.assert(getImageHeadTileHash(tile, PLAYER_HEAD_PART_SIZE, 0, 0) === getImageHeadTileHash(tileCopy, PLAYER_HEAD_PART_SIZE, 0, 0)
        && imageHeadTileMatches(tile, PLAYER_HEAD_PART_SIZE, 0, 0, tileCopy), 'Image head tile deduplication failed.');
    tileCopy[0] = 0;
    console.assert(!imageHeadTileMatches(tile, PLAYER_HEAD_PART_SIZE, 0, 0, tileCopy), 'Different image head tiles were deduplicated.');
}

export function createPlayerHeadAtlas(notify = true): PlayerHeadAtlas {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = PLAYER_HEAD_ATLAS_SIZE;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('플레이어 헤드 아틀라스 캔버스를 만들 수 없습니다.');
    context.imageSmoothingEnabled = false;

    const texture = new THREE.Texture(canvas);
    texture.needsUpdate = true;
    texture.magFilter = THREE.NearestFilter;
    texture.minFilter = THREE.NearestFilter;
    texture.colorSpace = THREE.SRGBColorSpace;

    const headUvTexture = createHeadAtlasUvTexture(canvas);
    texture.addEventListener('dispose', () => headUvTexture.dispose());
    const material = createEntityMaterial(texture, 0xffffff, true, false, 1, 0, true, true, headUvTexture).material;
    material.toneMapped = false;
    material.fog = false;
    material.flatShading = true;
    material.side = THREE.DoubleSide;

    const atlas: PlayerHeadAtlas = { context, texture, material, nextSlot: 0, freeSlots: [], skins: new Map(), slotUrls: [] };
    playerHeadAtlases.set(material, atlas);
    (loadedObjectGroup.userData.playerHeadAtlasMaterials as THREE.Material[]).push(material);
    loadedObjectGroup.userData.cleanupUnusedPlayerHeadAtlasSlots = cleanupUnusedPlayerHeadAtlasSlots;
    loadedObjectGroup.userData.capturePlayerHeadAtlasState = capturePlayerHeadAtlasState;
    loadedObjectGroup.userData.restorePlayerHeadAtlasState = restorePlayerHeadAtlasState;
    if (notify) notifyPlayerHeadAtlasesChanged();
    return atlas;
}

export function takePlayerHeadSlot(atlas: PlayerHeadAtlas): number | undefined {
    let slot: number | undefined;
    while ((slot = atlas.freeSlots.pop()) !== undefined) {
        if (!atlas.slotUrls?.[slot]) return slot;
    }
    while (atlas.nextSlot < MAX_PLAYER_HEAD_SLOTS_PER_ATLAS && atlas.slotUrls[atlas.nextSlot]) atlas.nextSlot++;
    return atlas.nextSlot < MAX_PLAYER_HEAD_SLOTS_PER_ATLAS ? atlas.nextSlot++ : undefined;
}

function takeImageHeadTile(atlas: PlayerHeadAtlas, tilesPerAtlas: number): number | undefined {
    const allocated = atlas.imageHeadTiles ??= new Set<number>();
    let tile = atlas.imageHeadNextTile ?? 0;
    while (tile < tilesPerAtlas && (allocated.has(tile) || isReservedImageHeadTile(atlas, tile))) tile++;
    if (tile >= tilesPerAtlas) {
        atlas.imageHeadNextTile = tilesPerAtlas;
        return undefined;
    }
    allocated.add(tile);
    atlas.imageHeadNextTile = tile + 1;
    return tile;
}

function getImageHeadTileHash(pixels: Uint8ClampedArray, width: number, x: number, y: number): string {
    let hashA = 2166136261;
    let hashB = 0x9e3779b9;
    for (let row = 0; row < PLAYER_HEAD_PART_SIZE; row++) {
        let offset = ((y + row) * width + x) * 4;
        for (let byte = 0; byte < PLAYER_HEAD_PART_SIZE * 4; byte++, offset++) {
            hashA = Math.imul(hashA ^ pixels[offset], 16777619);
            hashB = Math.imul(hashB ^ pixels[offset], 2246822519);
        }
    }
    return `${hashA >>> 0}:${hashB >>> 0}`;
}

function imageHeadTileMatches(
    source: Uint8ClampedArray,
    sourceWidth: number,
    sourceX: number,
    sourceY: number,
    candidate: Uint8ClampedArray
): boolean {
    for (let row = 0; row < PLAYER_HEAD_PART_SIZE; row++) {
        const sourceOffset = ((sourceY + row) * sourceWidth + sourceX) * 4;
        const candidateOffset = row * PLAYER_HEAD_PART_SIZE * 4;
        for (let byte = 0; byte < PLAYER_HEAD_PART_SIZE * 4; byte++) {
            if (source[sourceOffset + byte] !== candidate[candidateOffset + byte]) return false;
        }
    }
    return true;
}

// ponytail: generated image heads keep only their editable front tile; promote one to a regular head before replacing all six faces.
export function createImageHeadAtlasMeshes(
    source: HTMLCanvasElement,
    columns: number,
    rows: number,
    layer: 0 | 1
): THREE.InstancedMesh[] {
    const meshes: THREE.InstancedMesh[] = [];
    const total = columns * rows;
    const spacing = layer ? 0.5 * PLAYER_HEAD_LAYER_SCALE : 0.5;
    const tilesPerRow = PLAYER_HEAD_ATLAS_SIZE / PLAYER_HEAD_PART_SIZE;
    const tilesPerAtlas = tilesPerRow * tilesPerRow;
    const matrix = new THREE.Matrix4();
    const atlases = getProjectPlayerHeadAtlases();
    const sourceContext = source.getContext('2d', { willReadFrequently: true });
    if (!sourceContext) throw new Error('Image head source canvas is unavailable.');
    const sourcePixels = sourceContext.getImageData(0, 0, source.width, source.height).data;
    const tilePixelCache = new WeakMap<PlayerHeadAtlas, Map<number, Uint8ClampedArray>>();
    const atlasEntries = new Map<PlayerHeadAtlas, Array<{ index: number; tile: number }>>();
    const keyedTiles = new Map<string, Array<{ atlas: PlayerHeadAtlas; tile: number }>>();
    for (const atlas of atlases) for (const [key, tile] of atlas.imageHeadTileKeys ?? []) {
        const candidates = keyedTiles.get(key) ?? [];
        candidates.push({ atlas, tile });
        keyedTiles.set(key, candidates);
    }
    let blackMaterial = imageHeadBlackMaterial;

    const prepareAtlas = (atlas: PlayerHeadAtlas): void => {
        atlas.imageHeadReservedSlots ??= atlas.nextSlot;
        atlas.imageHeadNextTile ??= 0;
        atlas.imageHeadTileKeys ??= new Map();
        atlas.nextSlot = MAX_PLAYER_HEAD_SLOTS_PER_ATLAS;
    };
    const allocateTile = (): { atlas: PlayerHeadAtlas; tile: number } => {
        let atlas = atlases.find(candidate => candidate.imageHeadNextTile !== undefined && candidate.imageHeadNextTile < tilesPerAtlas)
            ?? atlases.find(candidate => candidate.imageHeadNextTile === undefined
                && (!!candidate.freeSlots.length || candidate.nextSlot < MAX_PLAYER_HEAD_SLOTS_PER_ATLAS));
        if (!atlas) {
            atlas = createPlayerHeadAtlas(false);
            atlases.push(atlas);
        }
        prepareAtlas(atlas);
        const tile = takeImageHeadTile(atlas, tilesPerAtlas);
        if (tile === undefined) return allocateTile();
        return { atlas, tile };
    };
    const candidatePixels = (atlas: PlayerHeadAtlas, tile: number): Uint8ClampedArray => {
        let cache = tilePixelCache.get(atlas);
        if (!cache) tilePixelCache.set(atlas, cache = new Map());
        let pixels = cache.get(tile);
        if (!pixels) {
            pixels = atlas.context.getImageData(
                tile % tilesPerRow * PLAYER_HEAD_PART_SIZE,
                Math.floor(tile / tilesPerRow) * PLAYER_HEAD_PART_SIZE,
                PLAYER_HEAD_PART_SIZE,
                PLAYER_HEAD_PART_SIZE
            ).data;
            cache.set(tile, pixels);
        }
        return pixels;
    };

    for (let index = 0; index < total; index++) {
        const x = index % columns;
        const y = Math.floor(index / columns);
        const sourceX = x * PLAYER_HEAD_PART_SIZE;
        const sourceY = y * PLAYER_HEAD_PART_SIZE;
        const hash = getImageHeadTileHash(sourcePixels, source.width, sourceX, sourceY);
        let collision = 0;
        let assignment: { atlas: PlayerHeadAtlas; tile: number } | undefined;
        while (!assignment) {
            const key = collision ? `${hash}:${collision}` : hash;
            const candidates = keyedTiles.get(key) ?? [];
            for (const { atlas, tile } of candidates) {
                if (imageHeadTileMatches(sourcePixels, source.width, sourceX, sourceY, candidatePixels(atlas, tile))) {
                    assignment = { atlas, tile };
                    break;
                }
            }
            if (!assignment && candidates.length === 0) {
                const { atlas, tile } = allocateTile();
                atlas.imageHeadTileKeys!.set(key, tile);
                keyedTiles.set(key, [{ atlas, tile }]);
                atlas.context.drawImage(source, sourceX, sourceY, PLAYER_HEAD_PART_SIZE, PLAYER_HEAD_PART_SIZE,
                    tile % tilesPerRow * PLAYER_HEAD_PART_SIZE, Math.floor(tile / tilesPerRow) * PLAYER_HEAD_PART_SIZE,
                    PLAYER_HEAD_PART_SIZE, PLAYER_HEAD_PART_SIZE);
                atlas.texture.needsUpdate = true;
                assignment = { atlas, tile };
            }
            collision++;
        }
        const entries = atlasEntries.get(assignment.atlas) ?? [];
        entries.push({ index, tile: assignment.tile });
        atlasEntries.set(assignment.atlas, entries);
    }

    for (const [atlas, entries] of atlasEntries) {
        prepareAtlas(atlas);
        if (!blackMaterial) {
            atlas.context.fillRect(PLAYER_HEAD_ATLAS_SIZE - PLAYER_HEAD_PART_SIZE, 0, PLAYER_HEAD_PART_SIZE, PLAYER_HEAD_PART_SIZE);
            blackMaterial = getImageHeadBlackMaterial(atlas.texture);
        }
        for (let start = 0; start < entries.length; start += MAX_INSTANCES_PER_INSTANCED_MESH) {
            const chunk = entries.slice(start, start + MAX_INSTANCES_PER_INSTANCED_MESH);
            const count = chunk.length;
            const tilePositions = chunk.map(({ tile }) => [
                tile % tilesPerRow * PLAYER_HEAD_PART_SIZE,
                Math.floor(tile / tilesPerRow) * PLAYER_HEAD_PART_SIZE
            ] as [number, number]);
            const geometry = createImageHeadAtlasGeometry(layer);
            const uvData = new Float32Array(count * 11);
            const interleaved = new THREE.InstancedInterleavedBuffer(uvData, 11);
            const uvOffsets = new THREE.InterleavedBufferAttribute(interleaved, 2, 0);
            geometry.setAttribute('instancedUvOffset', uvOffsets);
            geometry.setAttribute('instancedUvFlip', new THREE.InterleavedBufferAttribute(interleaved, 2, 2));
            const knifeUvScales = new THREE.InterleavedBufferAttribute(interleaved, 3, 4);
            geometry.setAttribute('instancedKnifeUvScale', knifeUvScales);
            geometry.setAttribute('instancedKnifeUvOffset', new THREE.InterleavedBufferAttribute(interleaved, 3, 7));
            const layerVisible = new THREE.InterleavedBufferAttribute(interleaved, 1, 10);
            geometry.setAttribute('headLayerVisible', layerVisible);
            setEntityStateAttributes(geometry, count);

            const matrices = new Float32Array(count * 16);
            for (let localIndex = 0; localIndex < count; localIndex++) {
                const index = chunk[localIndex].index;
                const x = index % columns;
                const y = Math.floor(index / columns);
                const [tileX, tileY] = tilePositions[localIndex];
                const partY = layer ? 24 : 8;
                uvOffsets.setXY(localIndex,
                    (tileX - 8) / PLAYER_HEAD_ATLAS_SIZE,
                    1 - (tileY + 8) / PLAYER_HEAD_ATLAS_SIZE - (PLAYER_HEAD_BLOCK_HEIGHT - partY - 8) / PLAYER_HEAD_ATLAS_SIZE
                );
                knifeUvScales.setXYZ(localIndex, 1, 1, 1);
                layerVisible.setX(localIndex, layer);
                matrix.makeTranslation(x * spacing, (rows - y) * spacing, 0)
                    .multiply(getPlayerHeadRenderMatrix('none')).toArray(matrices, localIndex * 16);
            }
            atlas.texture.needsUpdate = true;

            const mesh = new THREE.InstancedMesh(geometry, [atlas.material, blackMaterial], count);
            mesh.instanceMatrix = new THREE.StorageInstancedBufferAttribute(matrices, 16);
            mesh.name = 'player_head[display=none]';
            mesh.userData.displayType = 'item_display';
            mesh.userData.hasHat = new Array(count).fill(layer === 1);
            mesh.userData.imageHeadLayer = layer;
            mesh.userData.imageHeadTilePositions = tilePositions;
            mesh.instanceMatrix.needsUpdate = true;
            mesh.frustumCulled = false;
            mesh.layers.enable(2);
            mesh.computeBoundingBox();
            mesh.computeBoundingSphere();
            meshes.push(mesh);
            if (import.meta.env.DEV) console.assert(tilePositions.every(([x, y]) =>
                !(x === PLAYER_HEAD_ATLAS_SIZE - PLAYER_HEAD_PART_SIZE && y === 0)
                && (x >= PLAYER_HEAD_BLOCKS_PER_ROW * PLAYER_HEAD_BLOCK_WIDTH
                    || Math.floor(y / PLAYER_HEAD_BLOCK_HEIGHT) * PLAYER_HEAD_BLOCKS_PER_ROW
                        + Math.floor(x / PLAYER_HEAD_BLOCK_WIDTH) >= atlas.imageHeadReservedSlots!)
            ), 'Image heads overlapped reserved player head atlas slots.');
        }
    }

    notifyPlayerHeadAtlasesChanged();
    if (import.meta.env.DEV) console.assert(meshes.reduce((sum, mesh) => sum + mesh.count, 0) === total, 'Image head atlas count failed.');
    return meshes;
}

type PlayerHeadMirrorAxis = 'x' | 'y' | 'z';

function mirroredPlayerHeadFace(key: keyof typeof playerHeadFaceParts, axis: PlayerHeadMirrorAxis): keyof typeof playerHeadFaceParts {
    const [negative, positive] = axis === 'x' ? ['right', 'left']
        : axis === 'y' ? ['top', 'bottom'] : ['front', 'back'];
    return (key.endsWith(negative) ? key.replace(negative, positive)
        : key.endsWith(positive) ? key.replace(positive, negative) : key) as keyof typeof playerHeadFaceParts;
}

function playerHeadFaceFlip(key: keyof typeof playerHeadFaceParts, axis: PlayerHeadMirrorAxis): [boolean, boolean] {
    if (axis === 'x') return [true, false];
    const horizontalFace = key.endsWith('top') || key.endsWith('bottom');
    return axis === 'y' ? [false, !horizontalFace] : [!horizontalFace, horizontalFace];
}

export function mirrorPlayerHeadPaint(packed: ImageData, axis: PlayerHeadMirrorAxis): ImageData {
    const mirrored = new ImageData(packed.width, packed.height);
    playerHeadPartOrder.forEach((key, targetPart) => {
        const sourcePart = playerHeadPartOrder.indexOf(mirroredPlayerHeadFace(key, axis));
        const [flipX, flipY] = playerHeadFaceFlip(key, axis);
        for (let y = 0; y < PLAYER_HEAD_PART_SIZE; y++) {
            for (let x = 0; x < PLAYER_HEAD_PART_SIZE; x++) {
                const sourceX = sourcePart % 3 * PLAYER_HEAD_PART_SIZE + (flipX ? PLAYER_HEAD_PART_SIZE - 1 - x : x);
                const sourceY = Math.floor(sourcePart / 3) * PLAYER_HEAD_PART_SIZE + (flipY ? PLAYER_HEAD_PART_SIZE - 1 - y : y);
                const targetX = targetPart % 3 * PLAYER_HEAD_PART_SIZE + x;
                const targetY = Math.floor(targetPart / 3) * PLAYER_HEAD_PART_SIZE + y;
                const sourceOffset = (sourceY * packed.width + sourceX) * 4;
                mirrored.data.set(packed.data.subarray(sourceOffset, sourceOffset + 4), (targetY * packed.width + targetX) * 4);
            }
        }
    });
    return mirrored;
}

function playerHeadTextureDataUrl(image: HTMLImageElement, axis: PlayerHeadMirrorAxis | null): string | null {
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('플레이어 헤드 텍스처 캔버스를 만들 수 없습니다.');
    context.imageSmoothingEnabled = false;
    context.drawImage(image, 0, 0);
    const originalPixels = axis ? context.getImageData(0, 0, canvas.width, canvas.height).data : null;
    if (axis) {
        for (const [key, [x, y]] of Object.entries(playerHeadFaceParts)) {
            const face = key as keyof typeof playerHeadFaceParts;
            const sourceKey = mirroredPlayerHeadFace(face, axis);
            const [sourceX, sourceY] = playerHeadFaceParts[sourceKey];
            const [flipX, flipY] = playerHeadFaceFlip(face, axis);
            context.save();
            context.translate(x + (flipX ? PLAYER_HEAD_PART_SIZE : 0), y + (flipY ? PLAYER_HEAD_PART_SIZE : 0));
            context.scale(flipX ? -1 : 1, flipY ? -1 : 1);
            context.drawImage(image, sourceX, sourceY, PLAYER_HEAD_PART_SIZE, PLAYER_HEAD_PART_SIZE, 0, 0, PLAYER_HEAD_PART_SIZE, PLAYER_HEAD_PART_SIZE);
            context.restore();
        }
    }
    const mirroredPixels = axis ? context.getImageData(0, 0, canvas.width, canvas.height).data : null;
    if (!axis || originalPixels?.every((value, index) => value === mirroredPixels![index])) return null;
    const dataUrl = canvas.toDataURL('image/png');
    if (import.meta.env.DEV) console.assert(dataUrl.startsWith('data:image/png;base64,'), 'Player head reflection did not produce a PNG data URL.');
    return dataUrl;
}

if (import.meta.env.DEV) {
    console.assert(mirroredPlayerHeadFace('right', 'x') === 'left'
        && mirroredPlayerHeadFace('top', 'y') === 'bottom'
        && mirroredPlayerHeadFace('front', 'z') === 'back'
        && playerHeadFaceFlip('front', 'y').join() === 'false,true'
        && playerHeadFaceFlip('top', 'z').join() === 'false,true', 'Player head reflection used the wrong axis face mapping.');
    const paint = new ImageData(PLAYER_HEAD_BLOCK_WIDTH, PLAYER_HEAD_BLOCK_HEIGHT);
    paint.data.forEach((_, index) => { paint.data[index] = index % 251; });
    for (const axis of ['x', 'y', 'z'] as const) {
        const restored = mirrorPlayerHeadPaint(mirrorPlayerHeadPaint(paint, axis), axis);
        console.assert(restored.data.every((value, index) => value === paint.data[index]), `${axis.toUpperCase()}-axis player head reflection is not reversible.`);
    }
}

function getPlayerHeadSlot(uvOffsets: THREE.BufferAttribute | THREE.InterleavedBufferAttribute, instanceId: number): number {
    return Math.round(uvOffsets.getX(instanceId) * PLAYER_HEAD_ATLAS_SIZE / PLAYER_HEAD_BLOCK_WIDTH)
        + Math.round((1 - uvOffsets.getY(instanceId)) * PLAYER_HEAD_ATLAS_SIZE / PLAYER_HEAD_BLOCK_HEIGHT - 1) * PLAYER_HEAD_BLOCKS_PER_ROW;
}

function getPlayerHeadSlotUsage(material: THREE.Material, slot: number): number {
    let count = 0;
    loadedObjectGroup.traverse(object => {
        if (!(object as THREE.InstancedMesh).isInstancedMesh) return;
        const mesh = object as THREE.InstancedMesh;
        const meshMaterial = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
        const offsets = mesh.geometry.getAttribute('instancedUvOffset') as THREE.BufferAttribute | THREE.InterleavedBufferAttribute | undefined;
        if (meshMaterial !== material || !offsets) return;
        for (let instanceId = 0; instanceId < mesh.count; instanceId++) {
            if (getPlayerHeadSlot(offsets, instanceId) === slot) count++;
        }
    });
    return count;
}

function getImageHeadTileUsage(material: THREE.Material, tile: number): number {
    const tilesPerRow = PLAYER_HEAD_ATLAS_SIZE / PLAYER_HEAD_PART_SIZE;
    let count = 0;
    loadedObjectGroup.traverse(object => {
        if (!(object as THREE.InstancedMesh).isInstancedMesh) return;
        const mesh = object as THREE.InstancedMesh;
        const meshMaterial = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
        if (meshMaterial !== material) return;
        const positions = mesh.userData.imageHeadTilePositions as Array<[number, number]> | undefined;
        if (!positions) return;
        for (let instanceId = 0; instanceId < mesh.count; instanceId++) {
            const position = positions[instanceId];
            if (position && position[1] / PLAYER_HEAD_PART_SIZE * tilesPerRow + position[0] / PLAYER_HEAD_PART_SIZE === tile) count++;
        }
    });
    return count;
}

type PlayerHeadAtlasTargets = Iterable<string> | Map<THREE.InstancedMesh, Iterable<number>>;

function collectPlayerHeadAtlasUsage(targets?: PlayerHeadAtlasTargets, onInstance?: (mesh: THREE.InstancedMesh, instanceId: number, material: THREE.Material) => void): {
    slots: Map<THREE.Material, Set<number>>;
    imageTiles: Map<THREE.Material, Set<number>>;
} {
    const slots = new Map<THREE.Material, Set<number>>();
    const imageTiles = new Map<THREE.Material, Set<number>>();
    const collect = (mesh: THREE.InstancedMesh, instanceIds: Iterable<number>): void => {
        const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
        if (!playerHeadAtlases.has(material)) return;
        const tilePositions = mesh.userData.imageHeadTilePositions as Array<[number, number]> | undefined;
        if (tilePositions) {
            const used = imageTiles.get(material) ?? new Set<number>();
            for (const instanceId of instanceIds) {
                onInstance?.(mesh, instanceId, material);
                const tile = tilePositions[instanceId];
                if (tile) used.add(tile[1] / PLAYER_HEAD_PART_SIZE * (PLAYER_HEAD_ATLAS_SIZE / PLAYER_HEAD_PART_SIZE)
                    + tile[0] / PLAYER_HEAD_PART_SIZE);
            }
            imageTiles.set(material, used);
            return;
        }
        const offsets = mesh.geometry.getAttribute('instancedUvOffset') as THREE.BufferAttribute | THREE.InterleavedBufferAttribute | undefined;
        if (!offsets) return;
        const used = slots.get(material) ?? new Set<number>();
        for (const instanceId of instanceIds) {
            used.add(getPlayerHeadSlot(offsets, instanceId));
            onInstance?.(mesh, instanceId, material);
        }
        slots.set(material, used);
    };
    if (targets instanceof Map) targets.forEach((ids, mesh) => collect(mesh, ids));
    else if (targets) {
        const refs = loadedObjectGroup.userData.objectUuidToInstance as Map<string, { mesh: THREE.InstancedMesh; instanceId: number }> | undefined;
        const byMesh = new Map<THREE.InstancedMesh, Set<number>>();
        for (const uuid of targets) {
            const ref = refs?.get(uuid);
            if (!ref?.mesh?.isInstancedMesh) continue;
            const ids = byMesh.get(ref.mesh) ?? new Set<number>();
            ids.add(ref.instanceId);
            byMesh.set(ref.mesh, ids);
        }
        byMesh.forEach((ids, mesh) => collect(mesh, ids));
    } else loadedObjectGroup.traverse(object => {
        if ((object as THREE.InstancedMesh).isInstancedMesh) collect(
            object as THREE.InstancedMesh,
            Array.from({ length: (object as THREE.InstancedMesh).count }, (_, instanceId) => instanceId)
        );
    });
    return { slots, imageTiles };
}

function isReservedImageHeadTile(atlas: PlayerHeadAtlas, tile: number): boolean {
    const tilesPerRow = PLAYER_HEAD_ATLAS_SIZE / PLAYER_HEAD_PART_SIZE;
    if (tile === tilesPerRow - 1) return true;
    const column = tile % tilesPerRow;
    const row = Math.floor(tile / tilesPerRow);
    return column < PLAYER_HEAD_BLOCKS_PER_ROW * 3
        && Math.floor(row / 4) * PLAYER_HEAD_BLOCKS_PER_ROW + Math.floor(column / 3) < (atlas.imageHeadReservedSlots ?? 0);
}

export function capturePlayerHeadAtlasState(targets?: PlayerHeadAtlasTargets): PlayerHeadAtlasSnapshot[] {
    const instances = new Map<THREE.Material, NonNullable<PlayerHeadAtlasSnapshot['instances']>>();
    const usage = collectPlayerHeadAtlasUsage(targets, (mesh, instanceId, material) => {
        const uuid = loadedObjectGroup.userData.instanceKeyToObjectUuid?.get(`${mesh.uuid}_${instanceId}`);
        const offset = mesh.geometry.getAttribute('instancedUvOffset');
        if (!uuid || !offset) return;
        const flip = mesh.geometry.getAttribute('instancedUvFlip');
        const knifeScale = mesh.geometry.getAttribute('instancedKnifeUvScale');
        const knifeOffset = mesh.geometry.getAttribute('instancedKnifeUvOffset');
        const tile = mesh.userData.imageHeadTilePositions?.[instanceId];
        const entries = instances.get(material) ?? [];
        entries.push({
            uuid,
            offset: [offset.getX(instanceId), offset.getY(instanceId)],
            flip: flip ? [flip.getX(instanceId), flip.getY(instanceId)] : undefined,
            texture: loadedObjectGroup.userData.objectTextures?.get(uuid),
            hasHat: mesh.userData.hasHat?.[instanceId],
            tile: tile ? [...tile] as [number, number] : undefined,
            knifeScale: knifeScale ? [knifeScale.getX(instanceId), knifeScale.getY(instanceId), knifeScale.getZ(instanceId)] : undefined,
            knifeOffset: knifeOffset ? [knifeOffset.getX(instanceId), knifeOffset.getY(instanceId), knifeOffset.getZ(instanceId)] : undefined
        });
        instances.set(material, entries);
    });
    const targeted = targets !== undefined;
    const states = getProjectPlayerHeadAtlases().map(atlas => {
        const regions: PlayerHeadAtlasRegionSnapshot[] = [];
        const addRegion = (x: number, y: number, width: number, height: number): void => {
            regions.push({ x, y, width, height, data: atlas.context.getImageData(x, y, width, height).data.slice(),
                uvs: captureHeadAtlasUvs(atlas.context.canvas, { x, y, width, height }) });
        };
        const usedSlots = [...(usage.slots.get(atlas.material) ?? [])].sort((a, b) => a - b);
        usedSlots.forEach(slot => addRegion(
            (slot % PLAYER_HEAD_BLOCKS_PER_ROW) * PLAYER_HEAD_BLOCK_WIDTH,
            Math.floor(slot / PLAYER_HEAD_BLOCKS_PER_ROW) * PLAYER_HEAD_BLOCK_HEIGHT,
            PLAYER_HEAD_BLOCK_WIDTH,
            PLAYER_HEAD_BLOCK_HEIGHT
        ));
        const tilesPerRow = PLAYER_HEAD_ATLAS_SIZE / PLAYER_HEAD_PART_SIZE;
        const usedImageTiles = usage.imageTiles.get(atlas.material) ?? new Set<number>();
        const imageTiles = [...usedImageTiles].sort((a, b) => a - b);
        imageTiles.forEach(tile => addRegion(
            tile % tilesPerRow * PLAYER_HEAD_PART_SIZE,
            Math.floor(tile / tilesPerRow) * PLAYER_HEAD_PART_SIZE,
            PLAYER_HEAD_PART_SIZE,
            PLAYER_HEAD_PART_SIZE
        ));
        if (imageTiles.length > 0) addRegion(
            PLAYER_HEAD_ATLAS_SIZE - PLAYER_HEAD_PART_SIZE,
            0,
            PLAYER_HEAD_PART_SIZE,
            PLAYER_HEAD_PART_SIZE
        );
        return {
            material: atlas.material,
            instances: instances.get(atlas.material),
            targeted,
            nextSlot: targeted ? undefined : atlas.nextSlot,
            freeSlots: targeted ? undefined : [...atlas.freeSlots],
            imageHeadNextTile: targeted && imageTiles.length === 0 ? undefined : atlas.imageHeadNextTile,
            imageHeadReservedSlots: targeted && imageTiles.length === 0 ? undefined : atlas.imageHeadReservedSlots,
            imageHeadTiles: imageTiles,
            imageHeadTileKeys: [...(atlas.imageHeadTileKeys ?? [])].filter(([, tile]) => usedImageTiles.has(tile)),
            skins: targeted ? undefined : new Map(Array.from(atlas.skins, ([url, skin]) => [url, { ...skin }])),
            slotUrls: targeted ? undefined : [...atlas.slotUrls],
            slotEntries: targeted ? usedSlots.map(slot => {
                const url = atlas.slotUrls[slot];
                const skin = url ? atlas.skins.get(url) : undefined;
                return { slot, url, skin: skin ? { ...skin } : undefined };
            }) : undefined,
            regions
        };
    });
    return targeted ? states.filter(state => state.regions.length > 0) : states;
}

export function restorePlayerHeadAtlasState(value: unknown): void {
    const states = Array.isArray(value) ? value as PlayerHeadAtlasSnapshot[] : [];
    for (const state of states) {
        const atlas = playerHeadAtlases.get(state.material);
        if (!atlas) continue;
        if (!state.targeted) resetHeadAtlasUvs(atlas.context.canvas, { x: 0, y: 0, width: PLAYER_HEAD_ATLAS_SIZE, height: PLAYER_HEAD_ATLAS_SIZE });
        for (const region of state.regions) {
            resetHeadAtlasUvs(atlas.context.canvas, region);
            for (const entry of region.uvs ?? []) setHeadAtlasUvRect(atlas.context.canvas, entry.x, entry.y, entry.rect);
        }
        if (!state.targeted) atlas.context.clearRect(0, 0, PLAYER_HEAD_ATLAS_SIZE, PLAYER_HEAD_ATLAS_SIZE);
        else state.regions.forEach(region => atlas.context.clearRect(region.x, region.y, region.width, region.height));
        state.regions.forEach(region => atlas.context.putImageData(
            new ImageData(new Uint8ClampedArray(region.data), region.width, region.height),
            region.x,
            region.y
        ));
        for (const instance of state.instances ?? []) {
            const ref = loadedObjectGroup.userData.objectUuidToInstance?.get(instance.uuid);
            if (!ref) continue;
            const offset = ref.mesh.geometry.getAttribute('instancedUvOffset');
            const flip = ref.mesh.geometry.getAttribute('instancedUvFlip');
            if (offset) {
                offset.setXY(ref.instanceId, ...instance.offset);
                offset.needsUpdate = true;
            }
            if (flip && instance.flip) {
                flip.setXY(ref.instanceId, ...instance.flip);
                flip.needsUpdate = true;
            }
            if (instance.tile) ref.mesh.userData.imageHeadTilePositions[ref.instanceId] = [...instance.tile];
            for (const [name, value] of [
                ['instancedKnifeUvScale', instance.knifeScale],
                ['instancedKnifeUvOffset', instance.knifeOffset]
            ] as const) {
                const attribute = ref.mesh.geometry.getAttribute(name);
                if (attribute && value) {
                    attribute.setXYZ(ref.instanceId, ...value);
                    attribute.needsUpdate = true;
                }
            }
            if (ref.mesh.userData.hasHat) ref.mesh.userData.hasHat[ref.instanceId] = instance.hasHat;
            const textures = loadedObjectGroup.userData.objectTextures;
            if (instance.texture === undefined) textures?.delete(instance.uuid);
            else textures?.set(instance.uuid, instance.texture);
        }
        if (state.targeted) {
            for (const { slot, url, skin } of state.slotEntries ?? []) {
                const oldUrl = atlas.slotUrls[slot];
                if (oldUrl && oldUrl !== url && atlas.skins.get(oldUrl)?.slot === slot) atlas.skins.delete(oldUrl);
                atlas.freeSlots = atlas.freeSlots.filter(freeSlot => freeSlot !== slot);
                atlas.slotUrls[slot] = url;
                if (url && skin) atlas.skins.set(url, { ...skin });
            }
            if (state.imageHeadTiles?.length) {
                atlas.imageHeadNextTile = state.imageHeadNextTile;
                atlas.imageHeadReservedSlots = state.imageHeadReservedSlots;
                atlas.imageHeadTiles ??= new Set();
                state.imageHeadTiles.forEach(tile => atlas.imageHeadTiles!.add(tile));
                const restoredTiles = new Set(state.imageHeadTiles);
                for (const [key, tile] of atlas.imageHeadTileKeys ?? []) {
                    if (restoredTiles.has(tile)) atlas.imageHeadTileKeys!.delete(key);
                }
                atlas.imageHeadTileKeys ??= new Map();
                state.imageHeadTileKeys?.forEach(([key, tile]) => atlas.imageHeadTileKeys!.set(key, tile));
            }
            atlas.texture.needsUpdate = true;
            continue;
        }
        atlas.nextSlot = state.nextSlot!;
        atlas.freeSlots = [...state.freeSlots!].sort((a, b) => b - a);
        atlas.imageHeadNextTile = state.imageHeadNextTile;
        atlas.imageHeadReservedSlots = state.imageHeadReservedSlots;
        atlas.imageHeadTiles = new Set(state.imageHeadTiles);
        atlas.imageHeadTileKeys = new Map(state.imageHeadTileKeys);
        atlas.skins = new Map(Array.from(state.skins!, ([url, skin]) => [url, { ...skin }]));
        atlas.slotUrls = [...state.slotUrls!];
        atlas.texture.needsUpdate = true;
    }
    notifyPlayerHeadAtlasesChanged();
}

export function cleanupUnusedPlayerHeadAtlasSlots(): void {
    let changed = false;
    const usage = collectPlayerHeadAtlasUsage();
    for (const atlas of getProjectPlayerHeadAtlases()) {
        for (let slot = 0; slot < atlas.slotUrls.length; slot++) {
            const url = atlas.slotUrls[slot];
            if (!url || usage.slots.get(atlas.material)?.has(slot)) continue;
            if (atlas.skins.get(url)?.slot === slot) atlas.skins.delete(url);
            atlas.slotUrls[slot] = undefined;
            if (!atlas.freeSlots.includes(slot)) atlas.freeSlots.push(slot);
            resetHeadAtlasUvs(atlas.context.canvas, {
                x: (slot % PLAYER_HEAD_BLOCKS_PER_ROW) * PLAYER_HEAD_BLOCK_WIDTH,
                y: Math.floor(slot / PLAYER_HEAD_BLOCKS_PER_ROW) * PLAYER_HEAD_BLOCK_HEIGHT,
                width: PLAYER_HEAD_BLOCK_WIDTH, height: PLAYER_HEAD_BLOCK_HEIGHT
            });
            atlas.context.clearRect(
                (slot % PLAYER_HEAD_BLOCKS_PER_ROW) * PLAYER_HEAD_BLOCK_WIDTH,
                Math.floor(slot / PLAYER_HEAD_BLOCKS_PER_ROW) * PLAYER_HEAD_BLOCK_HEIGHT,
                PLAYER_HEAD_BLOCK_WIDTH,
                PLAYER_HEAD_BLOCK_HEIGHT
            );
            atlas.texture.needsUpdate = true;
            changed = true;
        }
        atlas.freeSlots.sort((a, b) => b - a);

        if (atlas.imageHeadNextTile === undefined) continue;
        const allocated = atlas.imageHeadTiles ??= new Set(Array.from(
            { length: atlas.imageHeadNextTile },
            (_, tile) => tile
        ).filter(tile => !isReservedImageHeadTile(atlas, tile)));
        const used = usage.imageTiles.get(atlas.material) ?? new Set<number>();
        const tilesPerRow = PLAYER_HEAD_ATLAS_SIZE / PLAYER_HEAD_PART_SIZE;
        for (const tile of allocated) {
            if (used.has(tile)) continue;
            resetHeadAtlasUvs(atlas.context.canvas, { x: tile % tilesPerRow * PLAYER_HEAD_PART_SIZE,
                y: Math.floor(tile / tilesPerRow) * PLAYER_HEAD_PART_SIZE, width: PLAYER_HEAD_PART_SIZE, height: PLAYER_HEAD_PART_SIZE });
            atlas.context.clearRect(
                tile % tilesPerRow * PLAYER_HEAD_PART_SIZE,
                Math.floor(tile / tilesPerRow) * PLAYER_HEAD_PART_SIZE,
                PLAYER_HEAD_PART_SIZE,
                PLAYER_HEAD_PART_SIZE
            );
            allocated.delete(tile);
            for (const [key, mappedTile] of atlas.imageHeadTileKeys ?? []) {
                if (mappedTile === tile) atlas.imageHeadTileKeys!.delete(key);
            }
            atlas.texture.needsUpdate = true;
            changed = true;
        }
        let nextTile = 0;
        allocated.forEach(tile => { nextTile = Math.max(nextTile, tile + 1); });
        atlas.imageHeadNextTile = nextTile;
    }
    if (changed) notifyPlayerHeadAtlasesChanged();
}

export function getPlayerHeadPaintSurface(
    mesh: THREE.InstancedMesh,
    instanceId: number,
    exclusive = false
): PlayerHeadPaintSurface | null {
    const material = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as THREE.Material;
    const atlas = playerHeadAtlases.get(material);
    const uvOffsets = mesh.geometry.getAttribute('instancedUvOffset') as THREE.BufferAttribute | THREE.InterleavedBufferAttribute | undefined;
    const objectUuid = (loadedObjectGroup.userData.instanceKeyToObjectUuid as Map<string, string> | undefined)?.get(`${mesh.uuid}_${instanceId}`);
    if (!atlas || !uvOffsets || !objectUuid || instanceId < 0 || instanceId >= mesh.count) return null;
    const denseLayer = mesh.userData.imageHeadLayer as 0 | 1 | undefined;
    const denseTile = (mesh.userData.imageHeadTilePositions as Array<[number, number]> | undefined)?.[instanceId];
    if (denseLayer !== undefined && denseTile) {
        let [x, y] = denseTile;
        if (exclusive) {
            const tilesPerRow = PLAYER_HEAD_ATLAS_SIZE / PLAYER_HEAD_PART_SIZE;
            const oldTile = y / PLAYER_HEAD_PART_SIZE * tilesPerRow + x / PLAYER_HEAD_PART_SIZE;
            const usage = getImageHeadTileUsage(material, oldTile);
            if (usage > 1) {
                const nextTile = takeImageHeadTile(atlas, tilesPerRow * tilesPerRow);
                if (nextTile === undefined) throw new Error('Player head paint atlas is full.');
                const nextX = nextTile % tilesPerRow * PLAYER_HEAD_PART_SIZE;
                const nextY = Math.floor(nextTile / tilesPerRow) * PLAYER_HEAD_PART_SIZE;
                const region = { x, y, width: PLAYER_HEAD_PART_SIZE, height: PLAYER_HEAD_PART_SIZE };
                atlas.context.putImageData(readHeadAtlasRegion(atlas.context, region), nextX, nextY);
                resetHeadAtlasUvs(atlas.context.canvas, { ...region, x: nextX, y: nextY });
                x = nextX;
                y = nextY;
                (mesh.userData.imageHeadTilePositions as Array<[number, number]>)[instanceId] = [x, y];
                const partY = denseLayer ? 24 : 8;
                uvOffsets.setXY(instanceId,
                    (x - 8) / PLAYER_HEAD_ATLAS_SIZE,
                    1 - (y + 8) / PLAYER_HEAD_ATLAS_SIZE - (PLAYER_HEAD_BLOCK_HEIGHT - partY - 8) / PLAYER_HEAD_ATLAS_SIZE
                );
                uvOffsets.needsUpdate = true;
                atlas.texture.needsUpdate = true;
            } else {
                for (const [key, tile] of atlas.imageHeadTileKeys ?? []) {
                    if (tile === oldTile) atlas.imageHeadTileKeys!.delete(key);
                }
            }
        }
        return {
            mesh, instanceId, objectUuid, context: atlas.context, texture: atlas.texture,
            slot: -1, x, y, denseLayer
        };
    }

    let slot = getPlayerHeadSlot(uvOffsets, instanceId);
    if (exclusive && getPlayerHeadSlotUsage(material, slot) > 1) {
        const nextSlot = takePlayerHeadSlot(atlas);
        if (nextSlot === undefined) throw new Error('Player head paint atlas is full.');
        const oldX = (slot % PLAYER_HEAD_BLOCKS_PER_ROW) * PLAYER_HEAD_BLOCK_WIDTH;
        const oldY = Math.floor(slot / PLAYER_HEAD_BLOCKS_PER_ROW) * PLAYER_HEAD_BLOCK_HEIGHT;
        const nextX = (nextSlot % PLAYER_HEAD_BLOCKS_PER_ROW) * PLAYER_HEAD_BLOCK_WIDTH;
        const nextY = Math.floor(nextSlot / PLAYER_HEAD_BLOCKS_PER_ROW) * PLAYER_HEAD_BLOCK_HEIGHT;
        atlas.context.putImageData(readHeadAtlasRegion(atlas.context, { x: oldX, y: oldY, width: PLAYER_HEAD_BLOCK_WIDTH, height: PLAYER_HEAD_BLOCK_HEIGHT }), nextX, nextY);
        resetHeadAtlasUvs(atlas.context.canvas, { x: nextX, y: nextY, width: PLAYER_HEAD_BLOCK_WIDTH, height: PLAYER_HEAD_BLOCK_HEIGHT });
        slot = nextSlot;
        uvOffsets.setXY(instanceId, nextX / PLAYER_HEAD_ATLAS_SIZE, 1 - (nextY + PLAYER_HEAD_BLOCK_HEIGHT) / PLAYER_HEAD_ATLAS_SIZE);
        uvOffsets.needsUpdate = true;
        atlas.texture.needsUpdate = true;
    }
    return {
        mesh,
        instanceId,
        objectUuid,
        context: atlas.context,
        texture: atlas.texture,
        slot,
        x: (slot % PLAYER_HEAD_BLOCKS_PER_ROW) * PLAYER_HEAD_BLOCK_WIDTH,
        y: Math.floor(slot / PLAYER_HEAD_BLOCKS_PER_ROW) * PLAYER_HEAD_BLOCK_HEIGHT
    };
}

export function readPlayerHeadPaint(surface: PlayerHeadPaintSurface): ImageData {
    if (surface.denseLayer === undefined) return readHeadAtlasRegion(surface.context, { x: surface.x, y: surface.y, width: PLAYER_HEAD_BLOCK_WIDTH, height: PLAYER_HEAD_BLOCK_HEIGHT });
    const packed = new ImageData(PLAYER_HEAD_BLOCK_WIDTH, PLAYER_HEAD_BLOCK_HEIGHT);
    const blackRows = PLAYER_HEAD_BLOCK_HEIGHT / 2;
    for (let pixel = 0; pixel < PLAYER_HEAD_BLOCK_WIDTH * blackRows; pixel++) packed.data[pixel * 4 + 3] = 255;
    const tile = readHeadAtlasRegion(surface.context, { x: surface.x, y: surface.y, width: PLAYER_HEAD_PART_SIZE, height: PLAYER_HEAD_PART_SIZE });
    const partY = surface.denseLayer ? 24 : 8;
    for (let y = 0; y < 8; y++) {
        const sourceStart = y * 8 * 4;
        packed.data.set(tile.data.subarray(sourceStart, sourceStart + 32), ((partY + y) * PLAYER_HEAD_BLOCK_WIDTH + 8) * 4);
    }
    return packed;
}

export function writePlayerHeadPaint(surface: PlayerHeadPaintSurface, packed: ImageData, updateTexture = true): void {
    resetHeadAtlasUvs(surface.context.canvas, { x: surface.x, y: surface.y,
        width: surface.denseLayer === undefined ? PLAYER_HEAD_BLOCK_WIDTH : PLAYER_HEAD_PART_SIZE,
        height: surface.denseLayer === undefined ? PLAYER_HEAD_BLOCK_HEIGHT : PLAYER_HEAD_PART_SIZE });
    if (surface.denseLayer === undefined) surface.context.putImageData(packed, surface.x, surface.y);
    else {
        const partY = surface.denseLayer ? 24 : 8;
        surface.context.putImageData(packed, surface.x - 8, surface.y - partY, 8, partY, 8, 8);
    }
    if (updateTexture) surface.texture.needsUpdate = true;
}

export function commitPlayerHeadPaint(surface: PlayerHeadPaintSurface): void {
    const packed = readPlayerHeadPaint(surface);
    let hasHat = false;
    for (let y = PLAYER_HEAD_PART_SIZE * 2; y < PLAYER_HEAD_BLOCK_HEIGHT && !hasHat; y++) {
        for (let x = 0; x < PLAYER_HEAD_BLOCK_WIDTH; x++) {
            if (packed.data[(y * PLAYER_HEAD_BLOCK_WIDTH + x) * 4 + 3] > 0) {
                hasHat = true;
                break;
            }
        }
    }
    surface.mesh.userData.hasHat[surface.instanceId] = hasHat;
    surface.texture.needsUpdate = true;

    const skin = document.createElement('canvas');
    skin.width = skin.height = 64;
    const context = skin.getContext('2d');
    if (!context) return;
    context.imageSmoothingEnabled = false;
    playerHeadPartOrder.forEach((key, index) => {
        const [dx, dy] = playerHeadFaceParts[key];
        const sourceX = (index % 3) * PLAYER_HEAD_PART_SIZE;
        const sourceY = Math.floor(index / 3) * PLAYER_HEAD_PART_SIZE;
        context.putImageData(packed, dx - sourceX, dy - sourceY, sourceX, sourceY, PLAYER_HEAD_PART_SIZE, PLAYER_HEAD_PART_SIZE);
    });
    const dataUrl = skin.toDataURL('image/png');
    const material = (Array.isArray(surface.mesh.material) ? surface.mesh.material[0] : surface.mesh.material) as THREE.Material;
    const atlas = playerHeadAtlases.get(material);
    const oldUrl = atlas?.slotUrls[surface.slot];
    if (atlas && surface.denseLayer !== undefined) {
        const tile = surface.y / PLAYER_HEAD_PART_SIZE * (PLAYER_HEAD_ATLAS_SIZE / PLAYER_HEAD_PART_SIZE) + surface.x / PLAYER_HEAD_PART_SIZE;
        for (const [key, value] of atlas.imageHeadTileKeys ?? []) if (value === tile) atlas.imageHeadTileKeys!.delete(key);
    }
    if (atlas && surface.denseLayer === undefined) {
        if (oldUrl && atlas.skins.get(oldUrl)?.slot === surface.slot) atlas.skins.delete(oldUrl);
        if (!captureHeadAtlasUvs(surface.context.canvas, { x: surface.x, y: surface.y, width: PLAYER_HEAD_BLOCK_WIDTH, height: PLAYER_HEAD_BLOCK_HEIGHT }).length) {
            atlas.skins.set(dataUrl, { slot: surface.slot, hasHat });
        }
        atlas.slotUrls[surface.slot] = dataUrl;
    }
    (loadedObjectGroup.userData.objectTextures as Map<string, string> | undefined)?.set(surface.objectUuid, dataUrl);
}

export function getPlayerHeadTexture(objectUuid: string): string | undefined {
    const textures = loadedObjectGroup.userData.objectTextures as Map<string, string> | undefined;
    const texture = textures?.get(objectUuid);
    const ref = (loadedObjectGroup.userData.objectUuidToInstance as Map<string, { mesh: THREE.InstancedMesh; instanceId: number }> | undefined)?.get(objectUuid);
    if (!ref) return texture;
    const surface = getPlayerHeadPaintSurface(ref.mesh, ref.instanceId);
    if (!surface) return texture;
    if (texture !== deferredPlayerHeadTexture && !captureHeadAtlasUvs(surface.context.canvas, {
        x: surface.x, y: surface.y, width: surface.denseLayer === undefined ? PLAYER_HEAD_BLOCK_WIDTH : PLAYER_HEAD_PART_SIZE,
        height: surface.denseLayer === undefined ? PLAYER_HEAD_BLOCK_HEIGHT : PLAYER_HEAD_PART_SIZE
    }).length) return texture;
    commitPlayerHeadPaint(surface);
    return textures?.get(objectUuid);
}

// A hosted copy changes the reference only; keep dense image tiles, knife UVs and mirrored UVs intact.
export function replacePlayerHeadTextureReference(objectUuid: string, previous: string, next: string): boolean {
    const textures = loadedObjectGroup.userData.objectTextures as Map<string, string> | undefined;
    if (textures?.get(objectUuid) !== previous) return false;
    const ref = (loadedObjectGroup.userData.objectUuidToInstance as Map<string, { mesh: THREE.InstancedMesh; instanceId: number }> | undefined)?.get(objectUuid);
    if (!ref) return false;
    const surface = getPlayerHeadPaintSurface(ref.mesh, ref.instanceId);
    if (!surface) return false;
    const material = (Array.isArray(ref.mesh.material) ? ref.mesh.material[0] : ref.mesh.material) as THREE.Material;
    const atlas = playerHeadAtlases.get(material);
    if (atlas && surface.denseLayer === undefined && atlas.slotUrls[surface.slot] === previous) {
        const skin = atlas.skins.get(previous);
        if (skin?.slot === surface.slot) atlas.skins.delete(previous);
        atlas.slotUrls[surface.slot] = next;
        if (!atlas.skins.has(next)) atlas.skins.set(next, { slot: surface.slot, hasHat: !!ref.mesh.userData.hasHat[ref.instanceId] });
    }
    textures.set(objectUuid, next);
    return true;
}

export function setPlayerHeadLayerVisible(visible: boolean): void {
    loadedObjectGroup.traverse(object => {
        if (!(object as THREE.InstancedMesh).isInstancedMesh) return;
        const mesh = object as THREE.InstancedMesh;
        const attribute = mesh.geometry.getAttribute('headLayerVisible') as THREE.InstancedBufferAttribute | undefined;
        if (!attribute) return;
        for (let instanceId = 0; instanceId < mesh.count; instanceId++) attribute.setX(instanceId, visible ? 1 : 0);
        attribute.needsUpdate = true;
    });
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

    const oldSlot = Math.round(oldU * PLAYER_HEAD_ATLAS_SIZE / PLAYER_HEAD_BLOCK_WIDTH)
        + Math.round((1 - oldV) * PLAYER_HEAD_ATLAS_SIZE / PLAYER_HEAD_BLOCK_HEIGHT - 1) * PLAYER_HEAD_BLOCKS_PER_ROW;
    const storedUrl = image.src === DEFAULT_PLAYER_HEAD_TEXTURE ? DEFAULT_PLAYER_HEAD_TEXTURE : textureUrl;
    const existing = atlas.skins.get(storedUrl);
    let slot = existing?.slot ?? oldSlot;
    let hasHat = existing?.hasHat;
    if (!existing) {
        if (usageCount > 1) {
            const nextSlot = takePlayerHeadSlot(atlas);
            if (nextSlot === undefined) throw new Error('플레이어 헤드 아틀라스 슬롯이 부족합니다.');
            slot = nextSlot;
        } else {
            const oldUrl = atlas.slotUrls[oldSlot];
            if (oldUrl && atlas.skins.get(oldUrl)?.slot === oldSlot) atlas.skins.delete(oldUrl);
        }
        hasHat = drawPlayerHeadSlot(atlas.context, image, slot);
        atlas.skins.set(storedUrl, { slot, hasHat });
        atlas.slotUrls[slot] = storedUrl;
    }

    ref.mesh.userData.hasHat[ref.instanceId] = hasHat;
    uvOffsets.setXY(
        ref.instanceId,
        (slot % PLAYER_HEAD_BLOCKS_PER_ROW) * PLAYER_HEAD_BLOCK_WIDTH / PLAYER_HEAD_ATLAS_SIZE,
        1 - (Math.floor(slot / PLAYER_HEAD_BLOCKS_PER_ROW) + 1) * PLAYER_HEAD_BLOCK_HEIGHT / PLAYER_HEAD_ATLAS_SIZE
    );
    uvOffsets.needsUpdate = true;
    atlas.texture.needsUpdate = true;
    (userData.objectTextures as Map<string, string> | undefined)?.set(objectUuid, storedUrl);
}

export async function updatePlayerHeadTexture(objectUuid: string, textureUrl: string): Promise<void> {
    applyPlayerHeadTexture(objectUuid, textureUrl, await loadPlayerHeadImage(textureUrl));
    if (!isApplying()) window.dispatchEvent(new CustomEvent('pde:scene-updated'));
}

export async function flipPlayerHeadTextures(objectUuids: string[], axis: PlayerHeadMirrorAxis): Promise<void> {
    const userData = loadedObjectGroup.userData;
    const refs = userData.objectUuidToInstance as Map<string, { mesh: THREE.InstancedMesh; instanceId: number }> | undefined;
    const prepared = (await Promise.all(objectUuids.map(async objectUuid => {
        const ref = refs?.get(objectUuid);
        const flips = ref?.mesh.geometry.getAttribute('instancedUvFlip') as THREE.InstancedBufferAttribute | undefined;
        if (!ref || !flips) return null;
        const texture = getPlayerHeadTexture(objectUuid) ?? DEFAULT_PLAYER_HEAD_TEXTURE;
        const image = await loadPlayerHeadImage(texture);
        const dataUrl = playerHeadTextureDataUrl(image, flips.getX(ref.instanceId) < 0.5 ? axis : null);
        return { objectUuid, ref, flips, dataUrl, image: dataUrl ? await loadPlayerHeadImage(dataUrl) : null };
    }))).filter(prepared => prepared !== null);
    for (const { objectUuid, ref, flips, dataUrl, image } of prepared) {
        if (dataUrl && image) applyPlayerHeadTexture(objectUuid, dataUrl, image);
        flips.setX(ref.instanceId, 0);
        flips.needsUpdate = true;
    }
}


export function clearImageHeadBlackMaterial(): void {
    imageHeadBlackMaterial = null;
}
