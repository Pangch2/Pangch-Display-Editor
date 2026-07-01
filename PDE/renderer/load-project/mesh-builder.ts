import * as THREE from 'three/webgpu';
import { createEntityMaterial } from '../entityMaterial.js';
import { parsePbdeProject } from './scene-parser';
import { isNodeBufferLike, mainThreadAssetProvider, toUint8Array } from './pbde-assets';
import type { GeometryMeta, GroupChild, GroupData, HeadGeometrySet, OtherItem, TypedArrayConstructor, WorkerMetadata } from './pbde-types';
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

async function getBlockMaterial(texPath: string, tintHex: number | undefined, gen: number): Promise<THREE.Material> {
    // undefined는 흰색(0xffffff)으로 정규화하여 캐시 키 불일치를 방지한다.
    const effectiveTint = (tintHex ?? 0xffffff) >>> 0;
    const key = `${texPath}|${effectiveTint}`;
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
        const { material } = createEntityMaterial(tex, effectiveTint);
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
export function performSelection(newlyAddedSelectableMeshes: Set<THREE.Object3D>) {
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

        for (const mesh of newlyAddedSelectableMeshes) {
            if (!mesh) continue;
            const instancedMesh = mesh as THREE.InstancedMesh;

            if (!instancedMesh.isInstancedMesh) continue;

            const instanceCount = instancedMesh.count ?? 0;

            if (instanceCount <= 0) continue;

            let ids: Set<number> | null = null;
            for (let instanceId = 0; instanceId < instanceCount; instanceId++) {
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

export async function loadAndRenderPbde(file: File, isMerge: boolean, overrideGen?: number): Promise<Set<THREE.Object3D>> {
        const meshUploadStartMs = performance.now();

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

        const fileBuffer = await file.arrayBuffer();
        if (myGen !== currentLoadGen) {
            return new Set<THREE.Object3D>();
        }

        const { metadata, geometryBuffer } = await parsePbdeProject(fileBuffer, mainThreadAssetProvider);
        if (myGen !== currentLoadGen) {
            return new Set<THREE.Object3D>();
        }

                if (!(geometryBuffer instanceof ArrayBuffer)) {
                    console.error('[Debug] geometryBuffer is not an ArrayBuffer. Aborting render pipeline.');
                    return new Set<THREE.Object3D>();
                }
                const sharedBuffer = geometryBuffer as ArrayBuffer;
                if (!metadata || typeof metadata !== 'object') {
                    console.error('[Debug] Invalid metadata payload from parser.');
                    return new Set<THREE.Object3D>();
                }
                const metadataPayload = metadata as WorkerMetadata;
                if (!Array.isArray(metadataPayload.geometries) || !Array.isArray(metadataPayload.otherItems)) {
                    console.error('[Debug] Invalid metadata payload from parser.');
                    return new Set<THREE.Object3D>();
                }
                const { geometries: geometryMetas, otherItems, useUint32Indices, atlas, groups, sceneOrder } = metadataPayload;

                const newlyAddedSelectableMeshes = new Set<THREE.Object3D>();

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

                console.log(`[Debug] Processing ${geometryMetas.length + otherItems.length} items from parser (binary).`);

                // uuid → 표시 이름 맵 구성
                if (!isMerge) {
                    loadedObjectGroup.userData.objectNames = new Map<string, string>();
                    loadedObjectGroup.userData.objectIsItemDisplay = new Set<string>();
                    loadedObjectGroup.userData.objectDisplayTypes = new Map<string, string>();
                    loadedObjectGroup.userData.objectBlockProps = new Map<string, any>();
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
                }
                loadedObjectGroup.userData.objectNames = objectNamesMap;
                loadedObjectGroup.userData.objectIsItemDisplay = objectIsItemDisplay;
                loadedObjectGroup.userData.objectDisplayTypes = objectDisplayTypes;
                loadedObjectGroup.userData.objectBlockProps = objectBlockProps;

                // 로드 순서 보존 (merge 시는 덧붙임)
                const prevOrder: { type: 'group' | 'object', id: string }[] =
                    isMerge ? (loadedObjectGroup.userData.sceneOrder ?? []) : [];
                loadedObjectGroup.userData.sceneOrder = prevOrder.concat(sceneOrder ?? []);

                const instancedGeometries = new Map<string, THREE.BufferGeometry>();
                const instancedMaterials = new Map<string, THREE.Material>();
                const materialPromises = new Map<string, Promise<THREE.Material>>();
                
                // Grouping structure: itemId -> all renderable parts for that scene object.
                const blocks = new Map<string, GeometryMeta[]>();

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
                const signatureGroups = new Map<string, { parts: GeometryMeta[], matrices: THREE.Matrix4[], instanceMetas: { uuid: string, groupId: string | null }[] }>();

                for (const [_itemId, parts] of blocks) {
                    // Sort parts to keep geometry/material groups deterministic across matching objects.
                    parts.sort((a, b) => {
                        const geometryCompare = a.geometryId.localeCompare(b.geometryId);
                        if (geometryCompare !== 0) return geometryCompare;
                        return a.geometryIndex - b.geometryIndex;
                    });

                    // Create Signature (modelMatrix 포함하여 facing 등 blockstate 정보 반영)
                    const signature = parts.map(p =>
                        `${p.geometryId}|${p.geometryIndex}|${p.texPath}|${p.tintHex ?? 0xffffff}|${p.modelMatrix.join(',')}`
                    ).join('||');

                    let group = signatureGroups.get(signature);
                    if (!group) {
                        group = { parts: parts, matrices: [], instanceMetas: [] };
                        signatureGroups.set(signature, group);
                    }

                    // Reconstruct instance matrix
                    const matrix = new THREE.Matrix4().fromArray(parts[0].transform).transpose();
                    group.matrices.push(matrix);
                    group.instanceMetas.push({ uuid: parts[0].uuid, groupId: parts[0].groupId });
                }

                // Create InstancedMesh for each signature group
                for (const [signature, group] of signatureGroups) {
                        const representativeParts = group.parts;
                        const matrices = group.matrices;
                        const instanceMetas = group.instanceMetas;

                        // Merge Geometries
                        const geometriesToMerge: THREE.BufferGeometry[] = [];
                        const materials: THREE.Material[] = [];
                        const pendingMaterialSlots: Array<{ index: number; promise: Promise<THREE.Material> }> = [];

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
                                pendingMaterialSlots.push({ index: materials.length, promise: materialPromises.get(matKey)! });
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
                            
                            // Use parser metadata to determine display type.
                            if (representativeParts[0].isItemDisplayModel) {
                                instancedMesh.userData.displayType = 'item_display';
                            } else {
                                instancedMesh.userData.displayType = 'block_display';
                            }
                            
                            instancedMesh.frustumCulled = false;

                            for (let i = 0; i < matrices.length; i++) {
                                instancedMesh.setMatrixAt(i, matrices[i]);
                                const meta = instanceMetas[i];
                                registerObject(instancedMesh, i, meta.uuid, meta.groupId);
                            }
                            instancedMesh.instanceMatrix.needsUpdate = true;
                            instancedMesh.computeBoundingSphere();
                            loadedObjectGroup.add(instancedMesh);
                            newlyAddedSelectableMeshes.add(instancedMesh);

                            // Handle async material loading
                            if (pendingMaterialSlots.length > 0) {
                                Promise.all(pendingMaterialSlots.map(slot => slot.promise)).then(loadedMats => {
                                    if (myGen === currentLoadGen) {
                                        for (let i = 0; i < pendingMaterialSlots.length; i++) {
                                            materials[pendingMaterialSlots[i].index] = loadedMats[i];
                                        }
                                        instancedMesh.material = materials;
                                        // Check transparency
                                        if (materials.some(m => m.transparent)) {
                                            instancedMesh.renderOrder = 1;
                                        }
                                    }
                                }).catch(e => {
                                    console.warn(`[Texture] Error loading materials for ${signature}:`, e);
                                });
                            } else {
                                if (materials.some(m => m.transparent)) {
                                    instancedMesh.renderOrder = 1;
                                }
                            }
                        }
                    }

                const playerHeadItems: Array<OtherItem> = [];
                otherItems.forEach((item) => {
                    if (item.type === 'itemDisplay' && item.textureUrl) {
                        playerHeadItems.push(item);
                    }
                });

                if (playerHeadItems.length > 0) {
                    const playerHeadPromise = (async () => {
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
                            instancedMesh.layers.enable(2);
                            instancedMesh.computeBoundingSphere();

                            playerHeadItems.forEach((item, idx) => {
                                registerObject(instancedMesh, idx, item.uuid, item.groupId);
                            });

                            loadedObjectGroup.add(instancedMesh);
                            newlyAddedSelectableMeshes.add(instancedMesh);

                        } catch (err) {
                            console.error('Player head instancing failed:', err);
                        }
                    })();

                    try { await playerHeadPromise; } catch { /* ignore */ }
                }

                const meshUploadElapsedMs = performance.now() - meshUploadStartMs;
                console.log(`[PBDE] Mesh uploaded to scene in ${meshUploadElapsedMs.toFixed(2)} ms (${file.name}, ${newlyAddedSelectableMeshes.size} mesh roots, ${loadedObjectGroup.children.length} scene children).`);
                console.log(`[Debug] Finished processing. Total objects in group: ${loadedObjectGroup.children.length}`);
                return newlyAddedSelectableMeshes;

}
