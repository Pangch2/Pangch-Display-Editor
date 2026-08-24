import * as THREE from 'three/webgpu';
import { compressSync, strToU8 } from 'fflate';
import { createEndPortalMaterial, createEntityMaterial, dragSelectedAttributeName, entityVisibleAttributeName, setEntityStateAttributes } from '../entity-material';
import { deleteSelectedItems } from '../controls/grouping/delete';
import * as GroupUtils from '../controls/grouping/group';
import * as Overlay from '../controls/selection/overlay';
import { getItemDisplayModelMatrix, getPlayerHeadDisplayMatrix, parsePbdeProject } from './scene-parser';
import { isNodeBufferLike, mainThreadAssetProvider, toUint8Array } from './pbde-assets';
import { isPbdeLogEnabled, pbdeLogNames } from './pbde-log';
import type { GeometryInstanceBatch, GeometryInstanceMeta, GeometryMeta, GroupData, HeadGeometrySet, OtherItem, TypedArrayConstructor, WorkerMetadata } from './pbde-types';
import { createTextDisplayTemplates, getTextDisplayTemplateKey, resetTextDisplayAtlases, textDisplayInstanceAttributeNames, type TextDisplayOptions } from './text-display';
import { getLinkedMirrorUuid, isMirrorModelingEnabled, replaceMirrorUuid } from '../controls/transform/mirroring';
import { isSceneHistoryResourceRetained } from '../controls/undo-redo/scene-history';
// 애니메이션 프레임이 있는 블록 텍스처를 첫 16x16 타일로 잘라낸다.
// function cropTextureToFirst16(tex) { ... } // Removed as per request

// 로드된 모든 객체를 담을 그룹
const loadedObjectGroup = new THREE.Group();

// --- 블록 텍스처 및 머티리얼 캐시(중복 로드 제거 + 재사용) ---
const blockTextureCache = new Map<string, THREE.Texture>(); // 텍스처 경로별 THREE.Texture 매핑
const blockTexturePromiseCache = new Map<string, Promise<THREE.Texture>>(); // 텍스처 경로별 로드 프라미스 매핑
const blockMaterialCache = new Map<string, THREE.Material>(); // `${texPath}|${tintHex}` 조합별 머티리얼 캐시
const blockMaterialPromiseCache = new Map<string, Promise<THREE.Material>>(); // 동일 키에 대한 생성 프라미스 캐시
const BLOCK_ATLAS_MIN_PAGE_SIZE = 512;
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

const PLAYER_HEAD_ATLAS_SIZE = 2048;
const PLAYER_HEAD_PART_SIZE = 8;
const PLAYER_HEAD_BLOCK_WIDTH = PLAYER_HEAD_PART_SIZE * 3;
const PLAYER_HEAD_BLOCK_HEIGHT = PLAYER_HEAD_PART_SIZE * 4;
const PLAYER_HEAD_BLOCKS_PER_ROW = Math.floor(PLAYER_HEAD_ATLAS_SIZE / PLAYER_HEAD_BLOCK_WIDTH);
const MAX_PLAYER_HEAD_SLOTS_PER_ATLAS = PLAYER_HEAD_BLOCKS_PER_ROW * Math.floor(PLAYER_HEAD_ATLAS_SIZE / PLAYER_HEAD_BLOCK_HEIGHT);
const PLAYER_HEAD_LAYER_SCALE = 1.0625;
const playerHeadFaceParts = {
    right: [16, 8], left: [0, 8], top: [8, 0], bottom: [16, 0], front: [24, 8], back: [8, 8],
    layer_right: [48, 8], layer_left: [32, 8], layer_top: [40, 0], layer_bottom: [48, 0], layer_front: [56, 8], layer_back: [40, 8]
} as const;
const playerHeadPartOrder = Object.keys(playerHeadFaceParts) as Array<keyof typeof playerHeadFaceParts>;
const playerHeadLayerRegions = [[48, 8, 8, 8], [32, 8, 8, 8], [40, 0, 8, 8], [48, 0, 8, 8], [56, 8, 8, 8], [40, 8, 8, 8]];
type PlayerHeadSkin = { slot: number; hasHat: boolean };
type PlayerHeadAtlas = {
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
};
type PlayerHeadAtlasSnapshot = {
    material: THREE.Material;
    nextSlot: number;
    freeSlots: number[];
    imageHeadNextTile?: number;
    imageHeadReservedSlots?: number;
    imageHeadTiles?: number[];
    imageHeadTileKeys?: Array<[string, number]>;
    skins: Map<string, PlayerHeadSkin>;
    slotUrls: Array<string | undefined>;
    regions: PlayerHeadAtlasRegionSnapshot[];
};
const playerHeadAtlases = new WeakMap<THREE.Material, PlayerHeadAtlas>();
let imageHeadBlackMaterial: THREE.Material | null = null;
export const deferredPlayerHeadTexture = 'pde:deferred-player-head-texture';

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

async function addTextDisplayItems(
    items: OtherItem[],
    registerObject: (mesh: THREE.InstancedMesh, instanceId: number, uuid: string, groupId: string | null) => void,
    selection?: LoadedSelection
): Promise<void> {
    const templates = await createTextDisplayTemplates(items);
    const reusableByMaterial = new Map<THREE.Material, THREE.InstancedMesh>();
    for (const child of loadedObjectGroup.children) {
        const mesh = child as THREE.InstancedMesh;
        if (!mesh.isInstancedMesh || !mesh.userData.textDisplayTemplateKeys || mesh.count >= getInstancedCapacity(mesh)) continue;
        reusableByMaterial.set(mesh.material as THREE.Material, mesh);
    }

    const groups = new Map<THREE.Material, Array<{ item: OtherItem; template: THREE.InstancedMesh; key: string }>>();
    const reusedMeshes = new Set<THREE.InstancedMesh>();
    const usedMaterials = new Set<THREE.Material>();
    for (const item of items) {
        const key = getTextDisplayTemplateKey(item);
        const template = templates.get(key)!;
        const material = template.material as THREE.Material;
        const mesh = reusableByMaterial.get(material);
        if (mesh && mesh.count < getInstancedCapacity(mesh)) {
            const instanceId = mesh.count++;
            mesh.setMatrixAt(instanceId, new THREE.Matrix4().fromArray(item.transform).transpose());
            for (const attributeName of textDisplayInstanceAttributeNames) {
                const attribute = mesh.geometry.getAttribute(attributeName);
                const source = template.geometry.getAttribute(attributeName);
                for (let component = 0; component < attribute.itemSize; component++) {
                    attribute.setComponent(instanceId, component, source.getComponent(0, component));
                }
                attribute.needsUpdate = true;
            }
            setInstanceSkyBrightness(mesh, instanceId, item.brightness as Brightness | undefined);
            (mesh.userData.textDisplayTemplateKeys as Map<number, string>).set(instanceId, key);
            registerObject(mesh, instanceId, item.uuid, item.groupId);
            if (selection) addLoadedInstance(selection, mesh, instanceId);
            reusedMeshes.add(mesh);
            usedMaterials.add(material);
            continue;
        }

        const group = groups.get(material) ?? [];
        group.push({ item, template, key });
        groups.set(material, group);
    }
    const usedGeometries = new Set<THREE.BufferGeometry>();
    for (const [material, group] of groups) {
        usedMaterials.add(material);
        const sourceGeometry = group[0].template.geometry;
        for (let start = 0; start < group.length; start += MAX_INSTANCES_PER_INSTANCED_MESH) {
            const chunk = group.slice(start, start + MAX_INSTANCES_PER_INSTANCED_MESH);
            const capacity = getAppendableInstanceCapacity(chunk.length);
            const geometry = start === 0 ? sourceGeometry : sourceGeometry.clone();
            usedGeometries.add(geometry);
            for (const attributeName of textDisplayInstanceAttributeNames) {
                const source = chunk[0].template.geometry.getAttribute(attributeName);
                const values = new Float32Array(capacity * source.itemSize);
                chunk.forEach(({ template }, instanceId) => {
                    const attribute = template.geometry.getAttribute(attributeName);
                    for (let component = 0; component < attribute.itemSize; component++) {
                        values[instanceId * attribute.itemSize + component] = attribute.getComponent(0, component);
                    }
                });
                geometry.setAttribute(attributeName, new THREE.InstancedBufferAttribute(values, source.itemSize));
            }
            geometry.boundingBox = chunk.reduce(
                (bounds, { template }) => bounds.union(template.geometry.boundingBox!),
                new THREE.Box3()
            );
            geometry.boundingSphere = geometry.boundingBox.getBoundingSphere(new THREE.Sphere());
            setEntityStateAttributes(geometry, capacity);
            const textMesh = new THREE.InstancedMesh(geometry, material, capacity);
            textMesh.instanceMatrix = new THREE.StorageInstancedBufferAttribute(capacity, 16);
            textMesh.count = chunk.length;
            textMesh.userData.displayType = 'text_display';
            textMesh.userData.textDisplayTemplateKeys = new Map<number, string>();
            textMesh.frustumCulled = false;
            textMesh.renderOrder = 1;
            textMesh.layers.enable(2);
            chunk.forEach(({ item, key }, instanceId) => {
                textMesh.setMatrixAt(instanceId, new THREE.Matrix4().fromArray(item.transform).transpose());
                setInstanceSkyBrightness(textMesh, instanceId, item.brightness as Brightness | undefined);
                textMesh.userData.textDisplayTemplateKeys.set(instanceId, key);
                registerObject(textMesh, instanceId, item.uuid, item.groupId);
                if (selection) addLoadedInstance(selection, textMesh, instanceId);
            });
            textMesh.instanceMatrix.needsUpdate = true;
            if (textMesh.instanceColor) textMesh.instanceColor.needsUpdate = true;
            textMesh.computeBoundingSphere();
            loadedObjectGroup.add(textMesh);
        }
    }
    for (const mesh of reusedMeshes) {
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
        mesh.computeBoundingSphere();
    }
    for (const template of templates.values()) {
        if (!usedGeometries.has(template.geometry)) template.geometry.dispose();
    }
    for (const material of new Set(Array.from(templates.values(), template => template.material as THREE.Material))) {
        if (usedMaterials.has(material)) continue;
        (material as THREE.MeshBasicNodeMaterial).map?.dispose();
        material.dispose();
    }
}

type InstancedGeometryAttribute = THREE.InstancedBufferAttribute | THREE.InterleavedBufferAttribute;

function isInstancedGeometryAttribute(attribute: unknown): attribute is InstancedGeometryAttribute {
    const candidate = attribute as THREE.InstancedBufferAttribute & {
        isInterleavedBufferAttribute?: boolean;
        data?: { isInstancedInterleavedBuffer?: boolean };
    };
    return !!(candidate?.isInstancedBufferAttribute
        || (candidate?.isInterleavedBufferAttribute && candidate.data?.isInstancedInterleavedBuffer));
}

function getInstancedCapacity(mesh: THREE.InstancedMesh): number {
    let capacity = mesh.instanceMatrix.count;
    if (mesh.instanceColor) capacity = Math.min(capacity, mesh.instanceColor.count);
    for (const attribute of Object.values(mesh.geometry.attributes)) {
        if (isInstancedGeometryAttribute(attribute)) capacity = Math.min(capacity, attribute.count);
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
        signatureHashA = hashString(signatureHashA, part.atlasKey ?? '');
        signatureHashA = mixHash(signatureHashA, (part.tintHex ?? 0xffffff) >>> 0);
        signatureHashB = hashString(signatureHashB, part.texPath);
        signatureHashB = hashString(signatureHashB, part.atlasKey ?? '');
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

function addProjectBlockAtlas(atlas: NonNullable<WorkerMetadata['atlas']>): { page: BlockAtlasPage; transform: [number, number, number, number] } {
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

function remapBlockAtlasMetadata(
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

async function getBlockMaterial(texPath: string, tintHex: number | undefined, gen: number, instancedUvTransformCount = 0, instancedUvTransformIndex = 0): Promise<THREE.Material> {
    // undefined는 흰색(0xffffff)으로 정규화하여 캐시 키 불일치를 방지한다.
    const effectiveTint = (tintHex ?? 0xffffff) >>> 0;
    const key = `${texPath}|${effectiveTint}|${instancedUvTransformCount > 0 ? `uvt${instancedUvTransformCount}:${instancedUvTransformIndex}` : 'base'}`;
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
        const { material } = createEntityMaterial(tex, effectiveTint, false, instancedUvTransformCount > 0, instancedUvTransformCount, instancedUvTransformIndex, false, true);
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

function createPlayerHeadAtlasGeometry(): THREE.BufferGeometry {
    createHeadGeometries();
    if (!headGeometries?.merged) throw new Error('Head geometries not available for instancing.');
    const geometry = headGeometries.merged.clone();
    const uvs = geometry.getAttribute('uv') as THREE.BufferAttribute;
    const uvMirrorCenters = new Float32Array(uvs.count * 2);
    const faceOrder = ['left', 'right', 'top', 'bottom', 'front', 'back'];

    [...faceOrder, ...faceOrder.map(face => `layer_${face}`)].forEach((key, faceIndex) => {
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
    const geometry = createPlayerHeadAtlasGeometry();
    const blackUvs = geometry.getAttribute('uv') as THREE.BufferAttribute;
    for (let vertex = 0; vertex < blackUvs.count; vertex++) blackUvs.setXY(vertex, 1 - 4 / PLAYER_HEAD_ATLAS_SIZE, 1 - 4 / PLAYER_HEAD_ATLAS_SIZE);
    const scale = layer ? PLAYER_HEAD_LAYER_SCALE : 1;
    const overlay = new THREE.PlaneGeometry(scale, scale);
    overlay.translate(0, -0.5, scale / 2 + 0.0001);
    const partIndex = layer ? 10 : 4;
    const x = (partIndex % 3) * PLAYER_HEAD_PART_SIZE;
    const y = Math.floor(partIndex / 3) * PLAYER_HEAD_PART_SIZE;
    const u0 = x / PLAYER_HEAD_ATLAS_SIZE;
    const u1 = (x + PLAYER_HEAD_PART_SIZE) / PLAYER_HEAD_ATLAS_SIZE;
    const v0 = (PLAYER_HEAD_BLOCK_HEIGHT - y - PLAYER_HEAD_PART_SIZE) / PLAYER_HEAD_ATLAS_SIZE;
    const v1 = (PLAYER_HEAD_BLOCK_HEIGHT - y) / PLAYER_HEAD_ATLAS_SIZE;
    const uvs = overlay.getAttribute('uv') as THREE.BufferAttribute;
    uvs.setXY(0, u0, v1); uvs.setXY(1, u1, v1);
    uvs.setXY(2, u0, v0); uvs.setXY(3, u1, v0);
    overlay.setAttribute('headLayer', new THREE.BufferAttribute(new Float32Array(4).fill(layer), 1));
    const centers = new Float32Array(8);
    for (let vertex = 0; vertex < 4; vertex++) centers.set([(u0 + u1) / 2, (v0 + v1) / 2], vertex * 2);
    overlay.setAttribute('uvMirrorCenter', new THREE.BufferAttribute(centers, 2));

    const merged = mergeIndexedGeometries([geometry, overlay]);
    geometry.dispose();
    overlay.dispose();
    if (!merged) throw new Error('Image head geometry could not be created.');
    merged.clearGroups();
    merged.addGroup(0, 72, 1);
    merged.addGroup(72, 6, 0);
    return merged;
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

function getProjectPlayerHeadAtlases(): PlayerHeadAtlas[] {
    const materials = (loadedObjectGroup.userData.playerHeadAtlasMaterials as THREE.Material[] | undefined)
        ?? (loadedObjectGroup.userData.playerHeadAtlasMaterials = []);
    return materials.map(material => playerHeadAtlases.get(material)).filter(atlas => atlas !== undefined);
}

export function notifyPlayerHeadAtlasesChanged(): void {
    window.dispatchEvent(new CustomEvent('pde:player-head-atlases-changed', {
        detail: getProjectPlayerHeadAtlases().map(atlas => atlas.context.canvas)
    }));
}

function findAvailablePlayerHeadAtlas<T extends { nextSlot: number; freeSlots?: number[] }>(atlases: T[]): T | undefined {
    return atlases.find(atlas => !!atlas.freeSlots?.length || atlas.nextSlot < MAX_PLAYER_HEAD_SLOTS_PER_ATLAS);
}

function getOrCreatePlayerHeadAtlas<T extends { nextSlot: number; freeSlots?: number[] }>(atlases: T[], create: () => T): T {
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

function createPlayerHeadAtlas(notify = true): PlayerHeadAtlas {
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

    const material = createEntityMaterial(texture, 0xffffff, true, false, 1, 0, true, true).material;
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

function takePlayerHeadSlot(atlas: PlayerHeadAtlas): number | undefined {
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

/**
 * PBDE 파일을 로드하고 3D 씬에 객체를 배치합니다.
 * @param {File} file - 불러올 .pbde 또는 .bde 파일
 */
function _clearSceneAndCaches(): void {
    // 1-1. 캐시된 텍스처 및 리소스 완벽 해제
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
    const disposedGeometries = new Set<THREE.BufferGeometry>();
    const disposedMaterials = new Set<THREE.Material>();
    const disposedTextures = new Set<THREE.Texture>();
    loadedObjectGroup.traverse(object => {
        if (object.isMesh) {
            // 최적화: 재사용되는 지오메트리는 dispose하지 않도록 예외 처리
            if (object.geometry && !disposedGeometries.has(object.geometry) && object.geometry !== headGeometries?.base && object.geometry !== headGeometries?.layer && object.geometry !== headGeometries?.merged) {
                object.geometry.dispose();
                disposedGeometries.add(object.geometry);
            }
            if (object.material) {
                const materials = Array.isArray(object.material) ? object.material : [object.material];
                materials.forEach(material => {
                    if (material.map && !disposedTextures.has(material.map)) {
                        material.map.dispose();
                        disposedTextures.add(material.map);
                    }
                    if (!disposedMaterials.has(material)) {
                        material.dispose();
                        disposedMaterials.add(material);
                    }
                });
            }
        }
    });

    // 1-3. 그룹에서 모든 자식 객체 제거
    imageHeadBlackMaterial = null;
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
export function performSelection(newlyAddedSelectableMeshes: LoadedSelection, anchorMode = 'center') {
    if (loadedObjectGroup.userData.headPainterActive) return;
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
            selectGroupsObjectsFn(groupIds, meshToIds, { anchorMode, primaryIsRangeStart: true });
        } else if (typeof selectObjectsFn === 'function') {
            // Fallback: select raw objects if gizmo API is not available.
            selectObjectsFn(meshToIds, { anchorMode });
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
            resetTextDisplayAtlases();
            loadedObjectGroup.userData.blockAtlasTextures = [];
        } else {
            blockMaterialPromiseCache.clear();
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

                const groupObjectChildIndices = new WeakMap<GroupData, Map<string, number>>();

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
                        let childIndices = groupObjectChildIndices.get(group);
                        if (!childIndices) {
                            childIndices = new Map<string, number>();
                            for (let index = 0; index < group.children.length; index++) {
                                const child = group.children[index];
                                if (child?.type === 'object' && child.id !== undefined && !childIndices.has(child.id)) {
                                    childIndices.set(child.id, index);
                                }
                            }
                            groupObjectChildIndices.set(group, childIndices);
                        }
                        const childIndex = childIndices.get(uuid);
                        if (childIndex !== undefined) {
                            group.children[childIndex] = { type: 'object', mesh: mesh, instanceId: instanceId, id: uuid };
                        }
                    }
                }

                const atlasStartMs = performance.now();
                if (atlas) {
                    try {
                        const { page, transform } = addProjectBlockAtlas(atlas);
                        remapBlockAtlasMetadata(geometryMetas, activeGeometryBatches, sharedBuffer, atlas.key, page.index, transform);
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
                    loadedObjectGroup.userData.objectLabels = new Map<string, string>();
                    loadedObjectGroup.userData.objectIsItemDisplay = new Set<string>();
                    loadedObjectGroup.userData.objectDisplayTypes = new Map<string, string>();
                    loadedObjectGroup.userData.objectBlockProps = new Map<string, any>();
                    loadedObjectGroup.userData.objectTextDisplayOptions = new Map<string, TextDisplayOptions>();
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
                const objectLabels: Map<string, string> =
                    (loadedObjectGroup.userData.objectLabels as Map<string, string>) ?? new Map<string, string>();
                const objectIsItemDisplay: Set<string> =
                    (loadedObjectGroup.userData.objectIsItemDisplay as Set<string>) ?? new Set<string>();
                const objectDisplayTypes: Map<string, string> =
                    (loadedObjectGroup.userData.objectDisplayTypes as Map<string, string>) ?? new Map<string, string>();
                const objectBlockProps: Map<string, any> =
                    (loadedObjectGroup.userData.objectBlockProps as Map<string, any>) ?? new Map<string, any>();
                const objectTextDisplayOptions: Map<string, TextDisplayOptions> =
                    (loadedObjectGroup.userData.objectTextDisplayOptions as Map<string, TextDisplayOptions>) ?? new Map<string, TextDisplayOptions>();
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
                    if (item.uuid && !objectNamesMap.has(item.uuid) && (item.type === 'textDisplay' || (item as any).name)) {
                        objectNamesMap.set(item.uuid, (item as any).name ?? '');
                    }
                    if (item.uuid && item.type === 'itemDisplay') {
                        objectIsItemDisplay.add(item.uuid);
                        if (item.displayType) {
                            objectDisplayTypes.set(item.uuid, item.displayType);
                        }
                    }
                    if (item.uuid && item.type === 'textDisplay') {
                        if (!objectLabels.has(item.uuid)) objectLabels.set(item.uuid, 'text_display');
                        objectTextDisplayOptions.set(item.uuid, { ...((item.options as TextDisplayOptions | undefined) ?? {}) });
                    }
                    if (item.uuid) objectNbt.set(item.uuid, typeof item.nbt === 'string' ? item.nbt : '');
                    if (item.uuid && item.brightness) objectBrightness.set(item.uuid, item.brightness);
                    if (item.uuid && item.textureUrl) objectTextures.set(item.uuid, item.textureUrl);
                }
                loadedObjectGroup.userData.objectNames = objectNamesMap;
                loadedObjectGroup.userData.objectLabels = objectLabels;
                loadedObjectGroup.userData.objectIsItemDisplay = objectIsItemDisplay;
                loadedObjectGroup.userData.objectDisplayTypes = objectDisplayTypes;
                loadedObjectGroup.userData.objectBlockProps = objectBlockProps;
                loadedObjectGroup.userData.objectTextDisplayOptions = objectTextDisplayOptions;
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
                    if (instancedUvTransformCount === 0 && reusableCapacity >= group.instances.length) continue;
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
                        const hasReusableSignature = !usesAtlasUvTransform;
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
                                setEntityStateAttributes(meshGeometry, chunkCapacity);
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
                if (!isMerge) {
                    loadedObjectGroup.userData.playerHeadAtlasMaterials = [];
                    notifyPlayerHeadAtlasesChanged();
                }
                if (playerHeadItems.length > 0) {
                    const playerHeadPromise = (async () => {
                        try {
                            if (!headGeometries || !headGeometries.merged) {
                                console.error("Head geometries not available for instancing.");
                                return;
                            }

                            const atlases = getProjectPlayerHeadAtlases();
                            const skinAssignments = new Map<string, { atlas: PlayerHeadAtlas; skin: PlayerHeadSkin }>();
                            const uniqueUrls = [...new Set(playerHeadItems.map(item => item.textureUrl!))];
                            const missingUrls: string[] = [];
                            for (const url of uniqueUrls) {
                                const atlas = atlases.find(candidate => candidate.skins.has(url));
                                const skin = atlas?.skins.get(url);
                                if (atlas && skin) skinAssignments.set(url, { atlas, skin });
                                else missingUrls.push(url);
                            }

                            const loadedSkins = await Promise.all(missingUrls.map(async url => ({ url, image: await loadPlayerHeadImage(url) })));
                            for (const { url, image } of loadedSkins) {
                                const atlas = getOrCreatePlayerHeadAtlas(atlases, createPlayerHeadAtlas);
                                const slot = takePlayerHeadSlot(atlas)!;
                                const skin = { slot, hasHat: drawPlayerHeadSlot(atlas.context, image, slot) };
                                atlas.skins.set(url, skin);
                                atlas.slotUrls[slot] = url;
                                atlas.texture.needsUpdate = true;
                                skinAssignments.set(url, { atlas, skin });
                            }

                            const atlasItems = new Map<PlayerHeadAtlas, Array<{ item: OtherItem; skin: PlayerHeadSkin }>>();
                            for (const item of playerHeadItems) {
                                const assignment = skinAssignments.get(item.textureUrl!);
                                if (!assignment) continue;
                                let items = atlasItems.get(assignment.atlas);
                                if (!items) atlasItems.set(assignment.atlas, items = []);
                                items.push({ item, skin: assignment.skin });
                            }
                            
                            const sharedGeometry = createPlayerHeadAtlasGeometry();

                            let firstAtlas = true;
                            for (const [atlas, entries] of atlasItems) {
                                const geometry = firstAtlas ? sharedGeometry : sharedGeometry.clone();
                                firstAtlas = false;
                                const totalInstances = entries.length;
                                const headCapacity = Math.max(INITIAL_INSTANCES_PER_INSTANCED_MESH, getAppendableInstanceCapacity(totalInstances));
                                const matrices = new Float32Array(headCapacity * 16);
                                const uvData = new Float32Array(headCapacity * 11);
                                const interleavedUvData = new THREE.InstancedInterleavedBuffer(uvData, 11);
                                const uvOffsets = new THREE.InterleavedBufferAttribute(interleavedUvData, 2, 0);
                                const uvFlips = new THREE.InterleavedBufferAttribute(interleavedUvData, 2, 2);
                                const knifeUvScales = new THREE.InterleavedBufferAttribute(interleavedUvData, 3, 4);
                                const knifeUvOffsets = new THREE.InterleavedBufferAttribute(interleavedUvData, 3, 7);
                                const headLayerVisible = new THREE.InterleavedBufferAttribute(interleavedUvData, 1, 10);
                                const hasHatArray = new Array(totalInstances).fill(false);

                                for (let index = 0; index < headCapacity; index++) {
                                    knifeUvScales.setXYZ(index, 1, 1, 1);
                                    headLayerVisible.setX(index, 1);
                                }

                                entries.forEach(({ item, skin }, index) => {
                                    const matrix = new THREE.Matrix4().fromArray(item.transform).transpose();
                                    matrix.multiply(getPlayerHeadRenderMatrix(item.displayType));
                                    matrix.toArray(matrices, index * 16);
                                    const x = (skin.slot % PLAYER_HEAD_BLOCKS_PER_ROW) * PLAYER_HEAD_BLOCK_WIDTH;
                                    const y = Math.floor(skin.slot / PLAYER_HEAD_BLOCKS_PER_ROW) * PLAYER_HEAD_BLOCK_HEIGHT;
                                    uvOffsets.setXY(index, x / PLAYER_HEAD_ATLAS_SIZE, 1 - (y + PLAYER_HEAD_BLOCK_HEIGHT) / PLAYER_HEAD_ATLAS_SIZE);
                                    hasHatArray[index] = skin.hasHat;
                                });

                                geometry.setAttribute('instancedUvOffset', uvOffsets);
                                geometry.setAttribute('instancedUvFlip', uvFlips);
                                geometry.setAttribute('headLayerVisible', headLayerVisible);
                                geometry.setAttribute('instancedKnifeUvScale', knifeUvScales);
                                geometry.setAttribute('instancedKnifeUvOffset', knifeUvOffsets);
                                setEntityStateAttributes(geometry, headCapacity);

                                const instancedMesh = new THREE.InstancedMesh(geometry, atlas.material, headCapacity);
                                instancedMesh.instanceMatrix = new THREE.StorageInstancedBufferAttribute(matrices, 16);
                                instancedMesh.count = totalInstances;
                                instancedMesh.userData.displayType = 'item_display';
                                instancedMesh.userData.hasHat = hasHatArray;
                                instancedMesh.instanceMatrix.needsUpdate = true;
                                instancedMesh.frustumCulled = false;
                                instancedMesh.layers.enable(2);
                                instancedMesh.computeBoundingSphere();

                                entries.forEach(({ item }, index) => {
                                    setInstanceSkyBrightness(instancedMesh, index, item.brightness as Brightness | undefined);
                                    registerObject(instancedMesh, index, item.uuid, item.groupId);
                                    addLoadedInstance(newlyAddedSelectableMeshes, instancedMesh, index);
                                });
                                if (instancedMesh.instanceColor) instancedMesh.instanceColor.needsUpdate = true;
                                loadedObjectGroup.add(instancedMesh);
                            }

                        } catch (err) {
                            console.error('Player head instancing failed:', err);
                        }
                    })();

                    try { await playerHeadPromise; } catch { /* ignore */ }
                }

                const textItems = otherItems.filter(item => item.type === 'textDisplay');
                await addTextDisplayItems(textItems, registerObject, newlyAddedSelectableMeshes);
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

function collectPlayerHeadAtlasUsage(): {
    slots: Map<THREE.Material, Set<number>>;
    imageTiles: Map<THREE.Material, Set<number>>;
} {
    const slots = new Map<THREE.Material, Set<number>>();
    const imageTiles = new Map<THREE.Material, Set<number>>();
    loadedObjectGroup.traverse(object => {
        if (!(object as THREE.InstancedMesh).isInstancedMesh) return;
        const mesh = object as THREE.InstancedMesh;
        const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
        if (!playerHeadAtlases.has(material)) return;
        const tilePositions = mesh.userData.imageHeadTilePositions as Array<[number, number]> | undefined;
        if (tilePositions) {
            const used = imageTiles.get(material) ?? new Set<number>();
            for (let instanceId = 0; instanceId < mesh.count; instanceId++) {
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
        for (let instanceId = 0; instanceId < mesh.count; instanceId++) used.add(getPlayerHeadSlot(offsets, instanceId));
        slots.set(material, used);
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

function capturePlayerHeadAtlasState(): PlayerHeadAtlasSnapshot[] {
    const usage = collectPlayerHeadAtlasUsage();
    return getProjectPlayerHeadAtlases().map(atlas => {
        const regions: PlayerHeadAtlasRegionSnapshot[] = [];
        const addRegion = (x: number, y: number, width: number, height: number): void => {
            regions.push({ x, y, width, height, data: atlas.context.getImageData(x, y, width, height).data.slice() });
        };
        [...(usage.slots.get(atlas.material) ?? [])].sort((a, b) => a - b).forEach(slot => addRegion(
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
            nextSlot: atlas.nextSlot,
            freeSlots: [...atlas.freeSlots],
            imageHeadNextTile: atlas.imageHeadNextTile,
            imageHeadReservedSlots: atlas.imageHeadReservedSlots,
            imageHeadTiles: imageTiles,
            imageHeadTileKeys: [...(atlas.imageHeadTileKeys ?? [])].filter(([, tile]) => usedImageTiles.has(tile)),
            skins: new Map(Array.from(atlas.skins, ([url, skin]) => [url, { ...skin }])),
            slotUrls: [...atlas.slotUrls],
            regions
        };
    });
}

function restorePlayerHeadAtlasState(value: unknown): void {
    const states = Array.isArray(value) ? value as PlayerHeadAtlasSnapshot[] : [];
    for (const state of states) {
        const atlas = playerHeadAtlases.get(state.material);
        if (!atlas) continue;
        atlas.context.clearRect(0, 0, PLAYER_HEAD_ATLAS_SIZE, PLAYER_HEAD_ATLAS_SIZE);
        state.regions.forEach(region => atlas.context.putImageData(
            new ImageData(new Uint8ClampedArray(region.data), region.width, region.height),
            region.x,
            region.y
        ));
        atlas.nextSlot = state.nextSlot;
        atlas.freeSlots = [...state.freeSlots].sort((a, b) => b - a);
        atlas.imageHeadNextTile = state.imageHeadNextTile;
        atlas.imageHeadReservedSlots = state.imageHeadReservedSlots;
        atlas.imageHeadTiles = new Set(state.imageHeadTiles);
        atlas.imageHeadTileKeys = new Map(state.imageHeadTileKeys);
        atlas.skins = new Map(Array.from(state.skins, ([url, skin]) => [url, { ...skin }]));
        atlas.slotUrls = [...state.slotUrls];
        atlas.texture.needsUpdate = true;
    }
    notifyPlayerHeadAtlasesChanged();
}

function cleanupUnusedPlayerHeadAtlasSlots(): void {
    let changed = false;
    const usage = collectPlayerHeadAtlasUsage();
    for (const atlas of getProjectPlayerHeadAtlases()) {
        for (let slot = 0; slot < atlas.slotUrls.length; slot++) {
            const url = atlas.slotUrls[slot];
            if (!url || usage.slots.get(atlas.material)?.has(slot)) continue;
            if (atlas.skins.get(url)?.slot === slot) atlas.skins.delete(url);
            atlas.slotUrls[slot] = undefined;
            if (!atlas.freeSlots.includes(slot)) atlas.freeSlots.push(slot);
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
                atlas.context.putImageData(atlas.context.getImageData(x, y, PLAYER_HEAD_PART_SIZE, PLAYER_HEAD_PART_SIZE), nextX, nextY);
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
        atlas.context.putImageData(atlas.context.getImageData(oldX, oldY, PLAYER_HEAD_BLOCK_WIDTH, PLAYER_HEAD_BLOCK_HEIGHT), nextX, nextY);
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
    if (surface.denseLayer === undefined) return surface.context.getImageData(surface.x, surface.y, PLAYER_HEAD_BLOCK_WIDTH, PLAYER_HEAD_BLOCK_HEIGHT);
    const packed = new ImageData(PLAYER_HEAD_BLOCK_WIDTH, PLAYER_HEAD_BLOCK_HEIGHT);
    const blackRows = PLAYER_HEAD_BLOCK_HEIGHT / 2;
    for (let pixel = 0; pixel < PLAYER_HEAD_BLOCK_WIDTH * blackRows; pixel++) packed.data[pixel * 4 + 3] = 255;
    const tile = surface.context.getImageData(surface.x, surface.y, PLAYER_HEAD_PART_SIZE, PLAYER_HEAD_PART_SIZE);
    const partY = surface.denseLayer ? 24 : 8;
    for (let y = 0; y < 8; y++) {
        const sourceStart = y * 8 * 4;
        packed.data.set(tile.data.subarray(sourceStart, sourceStart + 32), ((partY + y) * PLAYER_HEAD_BLOCK_WIDTH + 8) * 4);
    }
    return packed;
}

export function writePlayerHeadPaint(surface: PlayerHeadPaintSurface, packed: ImageData, updateTexture = true): void {
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
    if (atlas && surface.denseLayer === undefined) {
        if (oldUrl && atlas.skins.get(oldUrl)?.slot === surface.slot) atlas.skins.delete(oldUrl);
        atlas.skins.set(dataUrl, { slot: surface.slot, hasHat });
        atlas.slotUrls[surface.slot] = dataUrl;
    }
    (loadedObjectGroup.userData.objectTextures as Map<string, string> | undefined)?.set(surface.objectUuid, dataUrl);
}

export function getPlayerHeadTexture(objectUuid: string): string | undefined {
    const textures = loadedObjectGroup.userData.objectTextures as Map<string, string> | undefined;
    const texture = textures?.get(objectUuid);
    if (texture !== deferredPlayerHeadTexture) return texture;
    const ref = (loadedObjectGroup.userData.objectUuidToInstance as Map<string, { mesh: THREE.InstancedMesh; instanceId: number }> | undefined)?.get(objectUuid);
    if (!ref) return undefined;
    const surface = getPlayerHeadPaintSurface(ref.mesh, ref.instanceId);
    if (!surface) return undefined;
    commitPlayerHeadPaint(surface);
    return textures?.get(objectUuid);
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
    window.dispatchEvent(new CustomEvent('pde:scene-updated'));
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

function disposeUnusedTextDisplayResources(geometry: THREE.BufferGeometry, material: THREE.Material): void {
    let geometryUsed = false;
    let materialUsed = false;
    let textureUsed = false;
    const texture = (material as THREE.Material & { map?: THREE.Texture | null }).map;
    loadedObjectGroup.traverse(object => {
        if (!(object as THREE.Mesh).isMesh) return;
        const mesh = object as THREE.Mesh;
        geometryUsed ||= mesh.geometry === geometry;
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        materialUsed ||= materials.includes(material);
        textureUsed ||= !!texture && materials.some(candidate => (
            candidate as THREE.Material & { map?: THREE.Texture | null }
        ).map === texture);
    });
    if (!geometryUsed && !isSceneHistoryResourceRetained(geometry)) geometry.dispose();
    const atlasMaterial = !!material.userData.textDisplayAtlas;
    if (!materialUsed && !atlasMaterial && !isSceneHistoryResourceRetained(material)) material.dispose();
    if (texture && !textureUsed && !atlasMaterial && !isSceneHistoryResourceRetained(texture)) texture.dispose();
}

export function isolateTextDisplay(objectUuid: string): void {
    const userData = loadedObjectGroup.userData;
    const refs = userData.objectUuidToInstance as Map<string, { mesh: THREE.InstancedMesh; instanceId: number }> | undefined;
    const ref = refs?.get(objectUuid);
    if (!ref || ref.mesh.count <= 1 || Overlay.getDisplayType(ref.mesh, ref.instanceId) !== 'text_display') return;

    const oldMesh = ref.mesh;
    const oldInstanceId = ref.instanceId;
    const oldLastInstanceId = oldMesh.count - 1;
    const geometry = oldMesh.geometry.clone();
    for (const attributeName of textDisplayInstanceAttributeNames) {
        const source = oldMesh.geometry.getAttribute(attributeName);
        const values = new Float32Array(source.itemSize);
        for (let component = 0; component < source.itemSize; component++) {
            values[component] = source.getComponent(oldInstanceId, component);
        }
        geometry.setAttribute(attributeName, new THREE.InstancedBufferAttribute(values, source.itemSize));
    }
    geometry.boundingBox = Overlay.getInstanceLocalBox(oldMesh, oldInstanceId)?.clone() ?? geometry.boundingBox;
    if (geometry.boundingBox) geometry.boundingSphere = geometry.boundingBox.getBoundingSphere(new THREE.Sphere());
    setEntityStateAttributes(geometry, 1, [oldMesh.geometry.getAttribute(entityVisibleAttributeName)?.getX(oldInstanceId) ?? 1]);
    const mesh = new THREE.InstancedMesh(geometry, oldMesh.material, 1);
    mesh.instanceMatrix = new THREE.StorageInstancedBufferAttribute(1, 16);
    const matrix = new THREE.Matrix4();
    oldMesh.getMatrixAt(oldInstanceId, matrix);
    mesh.setMatrixAt(0, matrix);
    mesh.instanceMatrix.needsUpdate = true;
    mesh.userData.displayType = 'text_display';
    mesh.frustumCulled = oldMesh.frustumCulled;
    mesh.renderOrder = oldMesh.renderOrder;
    mesh.visible = oldMesh.visible;
    mesh.layers.mask = oldMesh.layers.mask;

    const brightness = (userData.objectBrightness as Map<string, Brightness> | undefined)?.get(objectUuid);
    setInstanceSkyBrightness(mesh, 0, brightness);
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    for (const key of ['customPivots', 'localMatrices', 'displayTypes', 'textDisplayTemplateKeys'] as const) {
        const values = oldMesh.userData[key] as Map<number, unknown> | undefined;
        const value = values?.get(oldInstanceId);
        if (value !== undefined) mesh.userData[key] = new Map([[0, value]]);
    }

    const oldKey = GroupUtils.getGroupKey(oldMesh, oldInstanceId);
    const newKey = GroupUtils.getGroupKey(mesh, 0);
    const keyToUuid = userData.instanceKeyToObjectUuid as Map<string, string>;
    keyToUuid.delete(oldKey);
    keyToUuid.set(newKey, objectUuid);
    refs!.set(objectUuid, { mesh, instanceId: 0 });
    const objectToGroup = userData.objectToGroup as Map<string, string> | undefined;
    const groupId = objectToGroup?.get(oldKey);
    objectToGroup?.delete(oldKey);
    if (groupId) {
        objectToGroup!.set(newKey, groupId);
        const group = (userData.groups as Map<string, GroupData> | undefined)?.get(groupId);
        const child = group?.children.find(candidate => candidate.type === 'object' && candidate.id === objectUuid);
        if (child?.type === 'object') {
            child.mesh = mesh;
            child.instanceId = 0;
        }
    }

    if (oldInstanceId < oldLastInstanceId) {
        oldMesh.getMatrixAt(oldLastInstanceId, matrix);
        oldMesh.setMatrixAt(oldInstanceId, matrix);
        if (oldMesh.instanceColor) {
            const color = new THREE.Color();
            oldMesh.getColorAt(oldLastInstanceId, color);
            oldMesh.setColorAt(oldInstanceId, color);
        }
        for (const attribute of Object.values(oldMesh.geometry.attributes)) {
            if (!isInstancedGeometryAttribute(attribute)) continue;
            const instanced = attribute;
            if (instanced.isInterleavedBufferAttribute) {
                for (let component = 0; component < instanced.itemSize; component++) {
                    instanced.setComponent(oldInstanceId, component, instanced.getComponent(oldLastInstanceId, component));
                }
            } else {
                const source = oldLastInstanceId * instanced.itemSize;
                const target = oldInstanceId * instanced.itemSize;
                instanced.array.copyWithin(target, source, source + instanced.itemSize);
            }
            instanced.needsUpdate = true;
        }
        for (const key of ['customPivots', 'localMatrices', 'displayTypes', 'textDisplayTemplateKeys'] as const) {
            const values = oldMesh.userData[key] as Map<number, unknown> | undefined;
            values?.delete(oldInstanceId);
            if (values?.has(oldLastInstanceId)) values.set(oldInstanceId, values.get(oldLastInstanceId));
            values?.delete(oldLastInstanceId);
        }
        GroupUtils.updateGroupReferenceForMovedInstance(loadedObjectGroup, oldMesh, oldLastInstanceId, oldInstanceId);
    } else {
        for (const key of ['customPivots', 'localMatrices', 'displayTypes', 'textDisplayTemplateKeys'] as const) {
            (oldMesh.userData[key] as Map<number, unknown> | undefined)?.delete(oldInstanceId);
        }
    }
    oldMesh.count--;
    oldMesh.instanceMatrix.needsUpdate = true;
    if (oldMesh.instanceColor) oldMesh.instanceColor.needsUpdate = true;
    oldMesh.computeBoundingBox();
    oldMesh.computeBoundingSphere();
    mesh.computeBoundingBox();
    mesh.computeBoundingSphere();
    loadedObjectGroup.add(mesh);

    window.dispatchEvent(new CustomEvent('pde:replace-object-selection', { detail: [{
        oldMesh,
        oldInstanceId,
        oldLastInstanceId,
        mesh,
        instanceId: 0
    }] }));
}

export async function updateTextDisplay(objectUuid: string, name: string, options: TextDisplayOptions): Promise<void> {
    const userData = loadedObjectGroup.userData;
    const refs = userData.objectUuidToInstance as Map<string, { mesh: THREE.InstancedMesh; instanceId: number }> | undefined;
    let ref = refs?.get(objectUuid);
    if (!ref || Overlay.getDisplayType(ref.mesh, ref.instanceId) !== 'text_display') {
        throw new Error('변경할 텍스트 디스플레이를 찾을 수 없습니다.');
    }

    const templateKey = getTextDisplayTemplateKey({ name, options });
    const replacement = (await createTextDisplayTemplates([{ name, options, atlasKey: objectUuid }])).get(templateKey)!;
    const replacementMaterial = replacement.material as THREE.MeshBasicNodeMaterial;
    if (ref.mesh.material === replacementMaterial) {
        for (const attributeName of textDisplayInstanceAttributeNames) {
            const target = ref.mesh.geometry.getAttribute(attributeName);
            const source = replacement.geometry.getAttribute(attributeName);
            for (let component = 0; component < target.itemSize; component++) {
                target.setComponent(ref.instanceId, component, source.getComponent(0, component));
            }
            target.needsUpdate = true;
        }
        ref.mesh.geometry.boundingBox?.union(replacement.geometry.boundingBox!);
        if (ref.mesh.geometry.boundingBox) ref.mesh.geometry.boundingSphere = ref.mesh.geometry.boundingBox.getBoundingSphere(new THREE.Sphere());
        ref.mesh.computeBoundingSphere();
        replacement.geometry.dispose();
        (userData.objectNames as Map<string, string>).set(objectUuid, name);
        const optionMap = (userData.objectTextDisplayOptions as Map<string, TextDisplayOptions> | undefined)
            ?? (userData.objectTextDisplayOptions = new Map<string, TextDisplayOptions>());
        optionMap.set(objectUuid, { ...options });
        const templateKeys = (ref.mesh.userData.textDisplayTemplateKeys as Map<number, string> | undefined)
            ?? (ref.mesh.userData.textDisplayTemplateKeys = new Map<number, string>());
        templateKeys.set(ref.instanceId, templateKey);
        Overlay.updateSelectionOverlayObject(ref.mesh, ref.instanceId);
        return;
    }

    isolateTextDisplay(objectUuid);
    ref = refs?.get(objectUuid);
    if (!ref) throw new Error('변경할 텍스트 디스플레이를 찾을 수 없습니다.');
    const oldGeometry = ref.mesh.geometry;
    const oldMaterial = ref.mesh.material as THREE.Material;
    const oldBounds = oldGeometry.boundingBox?.clone();
    const currentMaterial = oldMaterial as THREE.MeshBasicNodeMaterial;
    const boundsUnchanged = !!oldBounds?.equals(replacement.geometry.boundingBox!);
    if (
        boundsUnchanged
        && ref.mesh.userData.textDisplayMaterialOwned
        && !replacementMaterial.userData.textDisplayAtlas
        && currentMaterial.map
        && replacementMaterial.map
        && currentMaterial.map.image.width === replacementMaterial.map.image.width
        && currentMaterial.map.image.height === replacementMaterial.map.image.height
    ) {
        const pipelineChanged = currentMaterial.depthWrite !== replacementMaterial.depthWrite
            || currentMaterial.alphaTest !== replacementMaterial.alphaTest;
        currentMaterial.map.image = replacementMaterial.map.image;
        currentMaterial.map.needsUpdate = true;
        currentMaterial.depthWrite = replacementMaterial.depthWrite;
        currentMaterial.alphaTest = replacementMaterial.alphaTest;
        currentMaterial.visible = replacementMaterial.visible;
        if (pipelineChanged) currentMaterial.needsUpdate = true;
        replacement.geometry.dispose();
        replacementMaterial.map.dispose();
        replacementMaterial.dispose();
    } else {
        setEntityStateAttributes(replacement.geometry, 1, [
            oldGeometry.getAttribute(entityVisibleAttributeName)?.getX(ref.instanceId) ?? 1
        ]);
        replacement.geometry.getAttribute(dragSelectedAttributeName).setX(
            0,
            oldGeometry.getAttribute(dragSelectedAttributeName)?.getX(ref.instanceId) ?? 0
        );
        if (import.meta.env.DEV) console.assert(
            replacement.geometry.getAttribute(dragSelectedAttributeName) !== oldGeometry.getAttribute(dragSelectedAttributeName)
            && replacement.geometry.getAttribute(entityVisibleAttributeName) !== oldGeometry.getAttribute(entityVisibleAttributeName),
            'Text display replacement must own its entity state attributes.'
        );
        ref.mesh.geometry = replacement.geometry;
        ref.mesh.material = replacementMaterial;
        ref.mesh.userData.textDisplayMaterialOwned = !replacementMaterial.userData.textDisplayAtlas;
        ref.mesh.computeBoundingBox();
        ref.mesh.computeBoundingSphere();
        // ponytail: retained resources live with history; add command cleanup hooks if history GPU memory becomes measurable.
        disposeUnusedTextDisplayResources(oldGeometry, oldMaterial);
    }
    (userData.objectNames as Map<string, string>).set(objectUuid, name);
    const optionMap = (userData.objectTextDisplayOptions as Map<string, TextDisplayOptions> | undefined)
        ?? (userData.objectTextDisplayOptions = new Map<string, TextDisplayOptions>());
    optionMap.set(objectUuid, { ...options });
    (ref.mesh.userData.textDisplayTemplateKeys as Map<number, string> | undefined)
        ?.set(ref.instanceId, templateKey);
    Overlay.updateSelectionOverlayObject(ref.mesh, ref.instanceId);
}

window.addEventListener('pde:history-restored', event => {
    if (!(event as CustomEvent<{ scene?: boolean }>).detail?.scene) return;
    const userData = loadedObjectGroup.userData;
    const options = userData.objectTextDisplayOptions as Map<string, TextDisplayOptions> | undefined;
    const names = userData.objectNames as Map<string, string> | undefined;
    if (!options || !names) return;
    void Promise.all([...options].map(([uuid, value]) => updateTextDisplay(uuid, names.get(uuid) ?? '', value)))
        .catch(error => console.error('텍스트 디스플레이 복원에 실패했습니다.', error));
});

export async function replaceDisplayObjects(requests: Array<{
    objectUuid: string;
    name: string;
    transformContext?: { pivotMode: string; pivotWorld?: THREE.Vector3 };
    isItemDisplay?: boolean;
    isTextDisplay?: boolean;
    options?: TextDisplayOptions;
}>, syncMirror = true): Promise<string[]> {
    if (requests.length === 0) return [];
    const requestedCount = requests.length;
    if (syncMirror && isMirrorModelingEnabled()) {
        const requestedUuids = new Set(requests.map(request => request.objectUuid));
        requests = requests.concat(requests.flatMap(request => {
            const partnerUuid = getLinkedMirrorUuid(loadedObjectGroup, request.objectUuid);
            if (!partnerUuid || requestedUuids.has(partnerUuid)) return [];
            requestedUuids.add(partnerUuid);
            return [{
                ...request,
                objectUuid: partnerUuid,
                transformContext: request.transformContext && { pivotMode: request.transformContext.pivotMode }
            }];
        }));
    }
    const ud = loadedObjectGroup.userData;
    const refs = ud.objectUuidToInstance as Map<string, { mesh: THREE.InstancedMesh; instanceId: number }>;
    const preserveVisibleSize = localStorage.getItem('pdeObjectReplaceMode') === 'preserve-visible-size';
    const getOverlaySize = (mesh: THREE.InstancedMesh, instanceId: number, instanceMatrix: THREE.Matrix4): THREE.Vector3 | null => {
        const box = Overlay.getInstanceLocalBox(mesh, instanceId);
        if (!box) return null;
        const matrix = instanceMatrix.clone().scale(box.getSize(new THREE.Vector3())).premultiply(mesh.matrixWorld);
        return new THREE.Vector3(
            new THREE.Vector3().setFromMatrixColumn(matrix, 0).length(),
            new THREE.Vector3().setFromMatrixColumn(matrix, 1).length(),
            new THREE.Vector3().setFromMatrixColumn(matrix, 2).length()
        );
    };
    const previousSceneOrder = (ud.sceneOrder as Array<{ type: 'group' | 'object'; id: string }> | undefined)?.slice();
    const sceneIndexes = new Map(previousSceneOrder?.map((entry, index) => [entry.type === 'object' ? entry.id : '', index]) ?? []);
    const previousGroupChildren = new Map<string, GroupData['children']>();
    const replacements = requests.map(({ objectUuid, name, transformContext, isItemDisplay: requestedItemDisplay, isTextDisplay = false, options }) => {
        const oldRef = refs?.get(objectUuid);
        if (!oldRef?.mesh?.isInstancedMesh) throw new Error('교체할 오브젝트를 찾을 수 없습니다.');

        const oldMatrix = new THREE.Matrix4();
        oldRef.mesh.getMatrixAt(oldRef.instanceId, oldMatrix);
        const displayedMatrix = oldMatrix.clone();
        const oldOverlaySize = preserveVisibleSize ? getOverlaySize(oldRef.mesh, oldRef.instanceId, displayedMatrix) : null;
        const oldName = (ud.objectNames as Map<string, string> | undefined)?.get(objectUuid) ?? '';
        const wasPlayerHead = oldName.startsWith('player_head');
        const isPlayerHead = name.startsWith('player_head');
        const oldDisplayType = (ud.objectDisplayTypes as Map<string, string> | undefined)?.get(objectUuid);
        const oldGeometryDisplayType = Overlay.getDisplayType(oldRef.mesh, oldRef.instanceId);
        const oldPlayerHeadScale = wasPlayerHead && Overlay.isItemDisplayHatEnabled(oldRef.mesh, oldRef.instanceId) ? PLAYER_HEAD_LAYER_SCALE : 1;
        if (isPlayerHead) oldMatrix.multiply(getPlayerHeadRenderMatrix(oldDisplayType).invert());
        const groupId = (ud.objectToGroup as Map<string, string> | undefined)?.get(`${oldRef.mesh.uuid}_${oldRef.instanceId}`);
        const group = groupId ? (ud.groups as Map<string, GroupData> | undefined)?.get(groupId) : undefined;
        if (groupId && group && !previousGroupChildren.has(groupId)) previousGroupChildren.set(groupId, [...group.children]);
        const wasItemDisplay = (ud.objectIsItemDisplay as Set<string> | undefined)?.has(objectUuid) ?? false;
        const isItemDisplay = !isTextDisplay && (requestedItemDisplay ?? wasItemDisplay);
        const displayTypeChanged = oldGeometryDisplayType !== (isTextDisplay ? 'text_display' : isItemDisplay ? 'item_display' : 'block_display');
        const customPivot = (oldRef.mesh.userData.customPivots as Map<number, THREE.Vector3> | undefined)?.get(oldRef.instanceId)?.clone();
        const pivot = transformContext?.pivotMode === 'center' || displayTypeChanged
            ? Overlay.getInstanceLocalBox(oldRef.mesh, oldRef.instanceId)?.getCenter(new THREE.Vector3())
            : customPivot ?? (oldGeometryDisplayType === 'block_display' && !wasPlayerHead && !isPlayerHead
                ? Overlay.getInstanceLocalBoxMin(oldRef.mesh, oldRef.instanceId)
                : Overlay.getInstanceLocalBox(oldRef.mesh, oldRef.instanceId)?.getCenter(new THREE.Vector3()));
        const pivotParent = transformContext?.pivotWorld ? undefined : pivot?.clone().applyMatrix4(displayedMatrix);
        const pivotWorld = transformContext?.pivotWorld?.clone()
            ?? pivotParent?.clone().applyMatrix4(oldRef.mesh.matrixWorld);
        const replacementUuid = THREE.MathUtils.generateUUID();
        const label = (ud.objectLabels as Map<string, string> | undefined)?.get(objectUuid);
        const texture = getPlayerHeadTexture(objectUuid);
        return {
            objectUuid, replacementUuid, label, groupId, oldMesh: oldRef.mesh, oldInstanceId: oldRef.instanceId,
            sceneIndex: sceneIndexes.get(objectUuid) ?? -1,
            customPivot,
            customPivotParent: customPivot?.clone().applyMatrix4(displayedMatrix),
            pivotParent,
            pivotWorld,
            displayedMatrix,
            oldOverlaySize,
            oldPlayerHeadScale,
            displayTypeChanged,
            transformContext,
            node: {
                uuid: replacementUuid,
                name,
                nbt: (ud.objectNbt as Map<string, string> | undefined)?.get(objectUuid) ?? '',
                transforms: oldMatrix.clone().transpose().toArray(),
                brightness: (ud.objectBrightness as Map<string, unknown> | undefined)?.get(objectUuid),
                tagHead: texture ? { Value: btoa(JSON.stringify({ textures: { SKIN: { url: texture } } })) } : undefined,
                isBlockDisplay: !isTextDisplay && !isItemDisplay,
                isItemDisplay,
                isTextDisplay,
                options: isTextDisplay ? options : undefined
            }
        };
    });
    if (import.meta.env.DEV) console.assert(
        replacements.every((replacement, index) => replacement.objectUuid === requests[index].objectUuid),
        'Display replacement batch order changed.'
    );
    const directTextItems: OtherItem[] | null = replacements.every(state => state.node.isTextDisplay && state.displayTypeChanged)
        ? replacements.map(({ node }) => ({
            type: 'textDisplay',
            uuid: node.uuid,
            groupId: null,
            transform: node.transforms,
            name: node.name,
            nbt: node.nbt,
            brightness: node.brightness,
            options: node.options
        }))
        : null;
    if (directTextItems) {
        const keyToUuid = ud.instanceKeyToObjectUuid as Map<string, string>;
        await addTextDisplayItems(directTextItems, (mesh, instanceId, uuid) => {
            keyToUuid.set(GroupUtils.getGroupKey(mesh, instanceId), uuid);
            refs.set(uuid, { mesh, instanceId });
        });
        const names = ud.objectNames as Map<string, string>;
        const labels = ud.objectLabels as Map<string, string>;
        const textOptions = ud.objectTextDisplayOptions as Map<string, TextDisplayOptions>;
        const objectNbt = ud.objectNbt as Map<string, string>;
        const brightness = ud.objectBrightness as Map<string, unknown>;
        for (const item of directTextItems) {
            names.set(item.uuid, item.name ?? '');
            labels.set(item.uuid, 'text_display');
            textOptions.set(item.uuid, { ...((item.options as TextDisplayOptions | undefined) ?? {}) });
            objectNbt.set(item.uuid, typeof item.nbt === 'string' ? item.nbt : '');
            if (item.brightness) brightness.set(item.uuid, item.brightness);
        }
        if (import.meta.env.DEV) console.assert(
            directTextItems.every(item => refs.has(item.uuid)),
            'Direct text display replacement did not register every object.'
        );
    } else {
        const json = strToU8(JSON.stringify([{ children: replacements.map(({ node }) => node) }]));
        const raw = new Uint8Array(18 + json.length);
        raw.set([80, 82, 74, 50], 0);
        raw.set(strToU8('scene.json'), 4);
        new DataView(raw.buffer).setUint32(14, json.length, true);
        raw.set(json, 18);
        const added = await loadAndRenderPbde(new File([compressSync(raw)], 'object-update.pbde'), true);
        if (replacements.some(state => !refs.has(state.replacementUuid))) {
            deleteSelectedItems(loadedObjectGroup, {
                groups: new Set(),
                objects: new Map([...added].filter(([object]) => (object as THREE.Mesh).isMesh)) as Map<THREE.Mesh, Set<number>>
            }, { resetSelectionAndDeselect: () => {} });
            if (previousSceneOrder) ud.sceneOrder = previousSceneOrder;
            if (import.meta.env.DEV) console.assert(
                replacements.every(state => refs.has(state.objectUuid) && !refs.has(state.replacementUuid)),
                'Failed display replacement must preserve the original objects.'
            );
            throw new Error('선택한 속성 조합은 표시할 모델이 없어 적용할 수 없습니다.');
        }
    }
    const deletionStates = new Map<THREE.InstancedMesh, typeof replacements>();
    const boundsDirtyMeshes = new Set<THREE.InstancedMesh>();
    for (const state of replacements) {
        const states = deletionStates.get(state.oldMesh) ?? [];
        states.push(state);
        deletionStates.set(state.oldMesh, states);
    }
    const selectionReplacements: Array<{
        oldMesh: THREE.InstancedMesh;
        oldInstanceId: number;
        oldLastInstanceId: number;
        mesh: THREE.InstancedMesh;
        instanceId: number;
    }> = [];
    const deletionOrder = Array.from(deletionStates, ([mesh, states]) => {
        let oldLastInstanceId = mesh.count - 1;
        return states.sort((a, b) => b.oldInstanceId - a.oldInstanceId)
            .map(state => ({ state, oldLastInstanceId: oldLastInstanceId-- }));
    }).flat();
    deleteSelectedItems(loadedObjectGroup, {
        groups: new Set(),
        objects: new Map(Array.from(deletionStates, ([mesh, states]) => [mesh, new Set(states.map(state => state.oldInstanceId))]))
    }, { resetSelectionAndDeselect: () => {} });

    const replacementUuids = new Map(replacements.map(state => [state.objectUuid, state.replacementUuid]));
    if (previousSceneOrder) {
        const nextSceneOrder = previousSceneOrder.map(entry => {
            const replacementUuid = entry.type === 'object' ? replacementUuids.get(entry.id) : undefined;
            return replacementUuid ? { type: 'object' as const, id: replacementUuid } : entry;
        });
        for (const state of replacements) {
            if (state.sceneIndex < 0) nextSceneOrder.push({ type: 'object', id: state.replacementUuid });
        }
        ud.sceneOrder = nextSceneOrder;
        if (import.meta.env.DEV) console.assert(previousSceneOrder.every((entry, index) => (
            nextSceneOrder[index].id === (entry.type === 'object' ? replacementUuids.get(entry.id) ?? entry.id : entry.id)
        )), 'Display replacement changed scene order.');
    }
    for (const [groupId, children] of previousGroupChildren) {
        const group = (ud.groups as Map<string, GroupData>).get(groupId);
        group.children = children.map(child => {
            const replacementUuid = child.type === 'object' && child.id ? replacementUuids.get(child.id) : undefined;
            if (!replacementUuid) return child;
            const replacement = refs.get(replacementUuid);
            if (!replacement) throw new Error('변경한 오브젝트 모델을 만들 수 없습니다.');
            (ud.objectToGroup as Map<string, string>).set(`${replacement.mesh.uuid}_${replacement.instanceId}`, groupId);
            return { ...child, id: replacementUuid, mesh: replacement.mesh, instanceId: replacement.instanceId };
        });
    }

    for (const state of replacements) {
        if (state.label !== undefined) (ud.objectLabels as Map<string, string>).set(state.replacementUuid, state.label);

        const replacement = refs.get(state.replacementUuid);
        if (!replacement) throw new Error('변경한 오브젝트 모델을 만들 수 없습니다.');
        const playerHeadLayerScale = state.oldPlayerHeadScale / (
            state.node.name.startsWith('player_head') && Overlay.isItemDisplayHatEnabled(replacement.mesh, replacement.instanceId)
                ? PLAYER_HEAD_LAYER_SCALE : 1
        );
        const scaleReplacementMatrix = (replacementMatrix: THREE.Matrix4): void => {
            replacementMatrix.scale(new THREE.Vector3().setScalar(playerHeadLayerScale));
            if (!state.oldOverlaySize) return;
            const newOverlaySize = getOverlaySize(replacement.mesh, replacement.instanceId, replacementMatrix);
            if (!newOverlaySize) return;
            const ratio = new THREE.Vector3(
                newOverlaySize.x > 1e-10 && state.oldOverlaySize.x > 1e-10 ? state.oldOverlaySize.x / newOverlaySize.x : 1,
                newOverlaySize.y > 1e-10 && state.oldOverlaySize.y > 1e-10 ? state.oldOverlaySize.y / newOverlaySize.y : 1,
                newOverlaySize.z > 1e-10 && state.oldOverlaySize.z > 1e-10 ? state.oldOverlaySize.z / newOverlaySize.z : 1
            );
            replacementMatrix.scale(ratio);
            if (import.meta.env.DEV && Math.min(...state.oldOverlaySize.toArray(), ...newOverlaySize.toArray()) > 1e-10) {
                console.assert(getOverlaySize(replacement.mesh, replacement.instanceId, replacementMatrix)!.distanceTo(state.oldOverlaySize) < 1e-6, 'Replacement overlay size changed.');
            }
        };
        if (state.displayTypeChanged) {
            const replacementMatrix = state.displayedMatrix.clone();
            scaleReplacementMatrix(replacementMatrix);
            const offset = new THREE.Vector3();
            if (state.pivotWorld) {
                const replacementPivot = Overlay.getInstanceLocalBox(replacement.mesh, replacement.instanceId)?.getCenter(new THREE.Vector3());
                if (replacementPivot) {
                    const target = state.pivotParent?.clone()
                        ?? state.pivotWorld.clone().applyMatrix4(replacement.mesh.matrixWorld.clone().invert());
                    offset.copy(target.sub(replacementPivot.applyMatrix4(replacementMatrix)));
                }
            }
            replacementMatrix.elements[12] += offset.x;
            replacementMatrix.elements[13] += offset.y;
            replacementMatrix.elements[14] += offset.z;
            replacement.mesh.setMatrixAt(replacement.instanceId, replacementMatrix);
            replacement.mesh.instanceMatrix.needsUpdate = true;
            boundsDirtyMeshes.add(replacement.mesh);
        } else if (state.pivotWorld && (!state.customPivot || state.transformContext?.pivotMode === 'center')) {
            const replacementMatrix = new THREE.Matrix4();
            replacement.mesh.getMatrixAt(replacement.instanceId, replacementMatrix);
            scaleReplacementMatrix(replacementMatrix);
            const replacementDisplayType = Overlay.getDisplayType(replacement.mesh, replacement.instanceId);
            const replacementPivot = state.transformContext?.pivotMode === 'center'
                ? Overlay.getInstanceLocalBox(replacement.mesh, replacement.instanceId)?.getCenter(new THREE.Vector3())
                : replacementDisplayType === 'block_display'
                ? Overlay.getInstanceLocalBoxMin(replacement.mesh, replacement.instanceId)
                : Overlay.getInstanceLocalBox(replacement.mesh, replacement.instanceId)?.getCenter(new THREE.Vector3());
            if (replacementPivot) {
                const target = state.pivotParent?.clone()
                    ?? state.pivotWorld.clone().applyMatrix4(replacement.mesh.matrixWorld.clone().invert());
                const offset = target.sub(replacementPivot.applyMatrix4(replacementMatrix));
                replacementMatrix.elements[12] += offset.x;
                replacementMatrix.elements[13] += offset.y;
                replacementMatrix.elements[14] += offset.z;
                replacement.mesh.setMatrixAt(replacement.instanceId, replacementMatrix);
                replacement.mesh.instanceMatrix.needsUpdate = true;
            }
        } else if (playerHeadLayerScale !== 1 || state.oldOverlaySize) {
            const replacementMatrix = new THREE.Matrix4();
            replacement.mesh.getMatrixAt(replacement.instanceId, replacementMatrix);
            scaleReplacementMatrix(replacementMatrix);
            replacement.mesh.setMatrixAt(replacement.instanceId, replacementMatrix);
            replacement.mesh.instanceMatrix.needsUpdate = true;
        }
        if (state.customPivotParent) {
            if (!replacement.mesh.userData.customPivots) replacement.mesh.userData.customPivots = new Map<number, THREE.Vector3>();
            const replacementMatrix = new THREE.Matrix4();
            replacement.mesh.getMatrixAt(replacement.instanceId, replacementMatrix);
            replacement.mesh.userData.customPivots.set(
                replacement.instanceId,
                state.customPivotParent.applyMatrix4(replacementMatrix.invert())
            );
        }

    }
    for (const mesh of boundsDirtyMeshes) {
        mesh.computeBoundingBox();
        mesh.computeBoundingSphere();
    }
    for (const state of replacements) replaceMirrorUuid(loadedObjectGroup, state.objectUuid, state.replacementUuid);
    for (const { state, oldLastInstanceId } of deletionOrder) {
        const replacement = refs.get(state.replacementUuid)!;
        selectionReplacements.push({
            oldMesh: state.oldMesh, oldInstanceId: state.oldInstanceId, oldLastInstanceId,
            mesh: replacement.mesh, instanceId: replacement.instanceId
        });
    }
    window.dispatchEvent(new CustomEvent('pde:replace-object-selection', { detail: selectionReplacements }));
    window.dispatchEvent(new CustomEvent('pde:scene-updated'));
    return replacements.slice(0, requestedCount).map(({ replacementUuid }) => replacementUuid);
}

export async function addDisplayObject(name: string, isItemDisplay: boolean): Promise<string> {
    const uuid = THREE.MathUtils.generateUUID();
    const transforms = name === 'player_head'
        ? new THREE.Matrix4().compose(
            new THREE.Vector3(0, 0.5, 0),
            new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI, 0, -Math.PI)),
            new THREE.Vector3(1, 1, 1)
        ).transpose().toArray()
        : new THREE.Matrix4().toArray();
    const json = strToU8(JSON.stringify([{ children: [{
        uuid,
        name,
        nbt: '',
        transforms,
        isBlockDisplay: !isItemDisplay,
        isItemDisplay
    }] }]));
    const raw = new Uint8Array(18 + json.length);
    raw.set([80, 82, 74, 50], 0);
    raw.set(strToU8('scene.json'), 4);
    new DataView(raw.buffer).setUint32(14, json.length, true);
    raw.set(json, 18);

    performSelection(
        await loadAndRenderPbde(new File([compressSync(raw)], 'object-add.pbde'), true),
        'default'
    );
    window.dispatchEvent(new CustomEvent('pde:scene-updated'));
    return uuid;
}

export async function addTextDisplay(objectUuids: string[] = []): Promise<string> {
    const options: TextDisplayOptions = {
        color: '#FFFFFF', alpha: 1, backgroundColor: '#000000', backgroundAlpha: 1,
        bold: false, italic: false, underline: false, strikeThrough: false, obfuscated: false,
        lineLength: 50, align: 'center', font: 'minecraft:default'
    };
    if (objectUuids.length) {
        return (await replaceDisplayObjects(objectUuids.map(objectUuid => ({
            objectUuid, name: '텍스트 입력', isTextDisplay: true, options
        }))))[0];
    }
    const uuid = THREE.MathUtils.generateUUID();
    const json = strToU8(JSON.stringify([{ children: [{
        uuid,
        name: '텍스트 입력',
        nbt: '',
        transforms: new THREE.Matrix4().toArray(),
        isTextDisplay: true,
        options
    }] }]));
    const raw = new Uint8Array(18 + json.length);
    raw.set([80, 82, 74, 50], 0);
    raw.set(strToU8('scene.json'), 4);
    new DataView(raw.buffer).setUint32(14, json.length, true);
    raw.set(json, 18);

    const pivotMode = (loadedObjectGroup.userData.getPivotMode as (() => string) | undefined)?.();
    performSelection(
        await loadAndRenderPbde(new File([compressSync(raw)], 'text-display-add.pbde'), true),
        pivotMode === 'center' ? 'center' : 'default'
    );
    window.dispatchEvent(new CustomEvent('pde:scene-updated'));
    return uuid;
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
