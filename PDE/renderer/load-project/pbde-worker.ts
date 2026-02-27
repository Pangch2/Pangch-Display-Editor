import { decompressSync, strFromU8 } from 'fflate';
import * as THREE from 'three/webgpu';

type TexturePixelData = {
    w: number;
    h: number;
    data: Uint8ClampedArray;
};

interface ResolvedModel {
    id: string;
    json: any;
    textures: Record<string, string>;
    elements: any[] | null;
    parentChain: string[];
    texture_size: number[] | null;
    fromHardcoded: boolean;
    ignoreDisplayIds?: string[] | Set<string>;
}

interface GeometryData {
    positions: number[];
    normals: number[];
    uvs: number[];
    indices: number[];
    texPath: string;
    tintHex: number;
}

interface ModelData {
    modelMatrix: number[] | Float32Array;
    geometries: GeometryData[];
    geometryId: string;
}

interface RenderItem {
    type: 'blockDisplay' | 'itemDisplay' | 'itemDisplayModel';
    models?: ModelData[]; // For blockDisplay and itemDisplayModel
    uuid?: string;
    groupId?: string | null;
    transform?: number[] | Float32Array;
    name?: string;
    nbt?: string;
    options?: any;
    brightness?: any;
    displayType?: string;
    textureUrl?: string;
    tints?: number[];
    originalName?: string;
    [key: string]: any; // Allow for other dynamic properties for now
}

interface GroupData {
    id: string;
    isCollection: boolean;
    children: { type: 'group' | 'object', id: string }[];
    parent: string | null;
    name: string;
    position: { x: number, y: number, z: number };
    quaternion: { x: number, y: number, z: number, w: number };
    scale: { x: number, y: number, z: number };
    pivot: number[];
}

// tintColor 모듈을 워커에서 직접 불러올 수 없으므로 여기에서 구현을 포함한다.
// 아래 getTextureColor 함수는 메인 스레드와 동일하게 동작하도록 수동으로 삽입한다.

// --- tintColor.js에서 가져온 색상 계산 로직 ---
const blocksUsingDefaultGrassColors = [
  'grass_block',
  'short_grass',
  'tall_grass',
  'fern',
  'large_fern_top',
  'large_fern_bottom',
  'potted_fern',
];

const blocksUsingDefaultFoliageColors = [
  'oak_leaves',
  'jungle_leaves',
  'acacia_leaves',
  'dark_oak_leaves',
  'vine',
  'mangrove_leaves',
];

function getTextureColor(modelResourceLocation: string, textureLayer?: string | number, tintindex?: number) {
  try {
    const isBlockModel = modelResourceLocation.startsWith('block/');
    const modelName = modelResourceLocation.split('/').slice(1).join('/');

    if (textureLayer == null && tintindex == null) {
      return 0xffffff;
    }

    // 잔디 계열 텍스처는 tintindex 없이도 기본 잔디색이 적용된다.
    if (
      blocksUsingDefaultGrassColors.includes(modelName) &&
      (!isBlockModel || tintindex === 0)
    ) {
      return 0x7cbd6b;
    }
        // 잎사귀 계열 텍스처는 기본 수풀 색상을 사용한다.
        if (
            blocksUsingDefaultFoliageColors.includes(modelName) &&
            (!isBlockModel || tintindex === 0)
        ) {
            // 자바 에디션 기본 잎사귀 색상 상수
            return 0x48b518;
        }

        if (modelName === 'birch_leaves' && (!isBlockModel || tintindex === 0)) {
            // 자작나무 잎사귀 기본 색상 값
            return 0x80a755;
        }
        if (modelName === 'spruce_leaves' && (!isBlockModel || tintindex === 0)) {
            // 가문비나무 잎사귀 기본 색상 값
            return 0x619961;
        }

        // 연꽃잎은 고정된 수면 색상을 사용한다.
        if (modelName === 'lily_pad') {
            // 블록 디스플레이 기준 위키와 다른 색을 사용하므로 별도 상수를 유지한다.
            return 0x71c35c;
        }

    // 수박/호박 줄기는 성장 단계별로 색을 구분한다.
    if (/^block\/(melon|pumpkin)_stem_stage[0-7]$/.test(modelResourceLocation)) {
      const age = modelResourceLocation.slice(-1);
      switch (age) {
        case '0': return 0x00ff00;
        case '1': return 0x20f704;
        case '2': return 0x40ef08;
        case '3': return 0x60e70c;
        case '4': return 0x80df10;
        case '5': return 0xa0d714;
        case '6': return 0xc0cf18;
        case '7': return 0xe0c71c;
      }
    }

    // 연결된 줄기는 최대 성장 단계 색을 그대로 재사용한다.
    if (
      ['block/attached_melon_stem', 'block/attached_pumpkin_stem'].includes(modelResourceLocation)
    ) {
      return 0xe0c71c;
    }

    // 레드스톤 가루는 면 tintindex 0일 때 기본 붉은색을 적용한다.
    if (modelResourceLocation.startsWith('block/redstone_dust_') && tintindex === 0) {
      return 0x4b0000;
    }

    return 0xffffff;
  } catch {
    return 0xffffff;
  }
}

// --- 워커 내부 에셋 공급자 ---

const assetCache = new Map();
const requestPromises = new Map();
let requestIdCounter = 0;

const workerAssetProvider = {
    getAsset(assetPath) {
        // 캐시가 존재하면 메인 스레드 왕복 없이 즉시 반환한다.
        if (assetCache.has(assetPath)) {
            return Promise.resolve(assetCache.get(assetPath));
        }

        // 동일한 에셋에 대한 중복 요청은 기존 프라미스에 합류시킨다.
        if (requestPromises.has(assetPath)) {
            return requestPromises.get(assetPath);
        }

        const promise = new Promise((resolve, reject) => {
            const requestId = requestIdCounter++;
            let timeoutId = null;

            const listener = (e) => {
                if (e.data.type === 'assetResponse' && e.data.requestId === requestId) {
                    clearTimeout(timeoutId);
                    self.removeEventListener('message', listener);
                    requestPromises.delete(assetPath);
                    if (e.data.success) {
                        assetCache.set(assetPath, e.data.content);
                        resolve(e.data.content);
                    } else {
                        reject(new Error(e.data.error));
                    }
                }
            };

            // 워커에서 오래 대기하지 않도록 하드 타임아웃을 건다.
            timeoutId = setTimeout(() => {
                self.removeEventListener('message', listener);
                requestPromises.delete(assetPath);
                reject(new Error(`Asset request timed out for: ${assetPath}`));
            }, 15000); // 15초 안에 응답이 없으면 타임아웃으로 간주한다.

            self.addEventListener('message', listener);
            // 메인 스레드에 에셋 요청을 전달한다.
            self.postMessage({ type: 'requestAsset', path: assetPath, requestId });
        });

        requestPromises.set(assetPath, promise);
        return promise;
    }
};

// --- block-processor.js를 바탕으로 한 블록 처리 로직 ---

let assetProvider;

function initializeAssetProvider(provider) {
    assetProvider = provider;
}

async function readJsonAsset(assetPath) {
    if (!assetProvider) {
        throw new Error("Asset provider is not initialized!");
    }
    const text = await assetProvider.getAsset(assetPath);
    return JSON.parse(text);
}

// 블록 이름에서 기본 ID와 속성 키-값을 분리해 구조화한다.
function blockNameToBaseAndProps(fullName) {
    const name = fullName || '';
    const base = name.split('[')[0];
    const props = {};
    const m = name.match(/\[(.*)\]/);
    if (m && m[1]) {
        m[1].split(',').forEach(pair => {
            const [k, v] = pair.split('=');
            if (k && v) props[k.trim()] = v.trim();
        });
    }
    return { baseName: base, props };
}

// 네임스페이스가 포함된 ID를 받아 네임스페이스와 경로로 나눈다.
function nsAndPathFromId(id, defaultNs = 'minecraft') {
    if (!id) return { ns: defaultNs, path: '' };
    const [nsMaybe, restMaybe] = id.includes(':') ? id.split(':', 2) : [defaultNs, id];
    return { ns: nsMaybe, path: restMaybe };
}

// 모델 ID를 실제 모델 JSON 에셋 경로로 변환한다.
function modelIdToAssetPath(modelId) {
    const { ns, path } = nsAndPathFromId(modelId);
    return `assets/${ns}/models/${path}.json`;
}

// 텍스처 ID를 PNG 에셋 경로로 바꿔 로더가 찾을 수 있게 한다.
function textureIdToAssetPath(texId) {
    const { ns, path } = nsAndPathFromId(texId);
    return `assets/${ns}/textures/${path}.png`;
}

// 하드코딩된 블록스테이트 파일이 존재하는지 여부를 판정한다.
function hasHardcodedBlockstate(p) {
    if (!p) return false;
    // 침대와 트랩 상자만 고정 블록스테이트를 갖는다.
    return /(bed|trapped_chest)/i.test(p);
}

// 하드코딩된 모델 JSON을 사용해야 하는 경로인지 확인한다.
function isHardcodedModelPath(p) {
    if (!p) return false;
    return /(chest|conduit|shulker_box|bed|banner|sign|decorated_pot|creeper_head|dragon_head|piglin_head|zombie_head|wither_skeleton_skull|skeleton_skull|shield|trident|spyglass|copper_golem_statue)$/i.test(p);
}

// 모델 ID가 하드코딩 모델 목록에 해당하는지 검사한다.
function isHardcodedModelId(modelId) {
    const { path } = nsAndPathFromId(modelId);
    return isHardcodedModelPath(path);
}

// 주어진 모델 ID에서 가능한 하드코딩 파일 경로 후보를 생성한다.
function getHardcodedModelCandidates(modelId) {
    const { path } = nsAndPathFromId(modelId);
    if (!path) return [];
    const normalized = path.replace(/^\/+/, '');
    const candidates = new Set();

    const push = (suffix) => {
        if (suffix) candidates.add(`hardcoded/models/${suffix}.json`);
    };

    push(normalized);

    if (normalized.startsWith('item/')) {
        const withoutItem = normalized.slice('item/'.length);
        push(`block/${withoutItem}`);
        push(withoutItem);
    } else if (normalized.startsWith('block/')) {
        const withoutBlock = normalized.slice('block/'.length);
        push(`block/${withoutBlock}`);
    } else {
        push(`block/${normalized}`);
        push(`item/${normalized}`);
    }

    return Array.from(candidates);
}

// 동일 그룹의 모델 ID를 모두 무시 목록에 포함시키기 위한 그룹 정의다.
const DISPLAY_IGNORE_GROUPS = [
    ['builtin/generated', 'minecraft:item/generated', 'item/generated'],
    ['minecraft:item/block', 'item/block', 'minecraft:block/block', 'block/block'],
];

// 모델 ID가 속한 무시 그룹을 모아 display 탐색에서 제외한다.
function collectIgnoreDisplayIdsForModelId(modelId) {
    if (!modelId) return [];
    const matches = [];
    for (const group of DISPLAY_IGNORE_GROUPS) {
        if (group.includes(modelId)) {
            matches.push(...group);
        }
    }
    return matches;
}

// 텍스처 참조 체인을 따라가 실제 경로를 찾는다.
function resolveTextureRef(value, textures, guard = 0) {
    if (!value) return null;
    if (guard > 10) return value;
    if (value.startsWith('#')) {
        const key = value.slice(1);
        const next = textures ? textures[key] : undefined;
        if (!next) return null;
        return resolveTextureRef(next, textures, guard + 1);
    }
    return value;
}

// 주어진 경로의 모델 JSON을 읽어 파싱한다.
async function loadModelJson(assetPath) {
    return await readJsonAsset(assetPath);
}

// 모델 ID를 기준으로 부모 체인과 텍스처 정보를 재귀적으로 해석한다.
async function resolveModelTree(modelId: string, cache = new Map<string, ResolvedModel | null>()): Promise<ResolvedModel | null> {
    if (typeof modelId !== 'string' || !modelId) {
        return null;
    }
    if (cache.has(modelId)) return cache.get(modelId) || null;
    // 특수 값인 builtin/generated 모델은 실제 파일이 아니므로 가짜 해석 결과를 반환한다.
    // 이렇게 하면 buildItemModelGeometryData 단계에서 일반 모델처럼 처리할 수 있다.
    if (modelId && (modelId.endsWith('builtin/generated'))) {
        const ignoreDisplayIds = collectIgnoreDisplayIdsForModelId('builtin/generated');
        const resolved: ResolvedModel = {
            id: modelId,
            json: { parent: 'item/generated' },
            textures: {},
            elements: null,
            parentChain: ['item/generated'],
            texture_size: null,
            fromHardcoded: false,
        };
        if (ignoreDisplayIds.length) {
            resolved.ignoreDisplayIds = ignoreDisplayIds;
        }
        cache.set(modelId, resolved);
        return resolved;
    }
    const hardcodedFirst = isHardcodedModelId(modelId);
    const assetsPath = modelIdToAssetPath(modelId);
    const hardcodedCandidates = getHardcodedModelCandidates(modelId);
    const loadHardcoded = async () => {
        for (const candidatePath of hardcodedCandidates) {
            try {
                const candidateJson = await loadModelJson(candidatePath);
                return { json: candidateJson, path: candidatePath };
            } catch (_) {
                // 실패하면 다음 후보 경로를 시도한다.
            }
        }
        return null;
    };
    let json;
    let fromHardcoded = false;
    try {
        if (hardcodedFirst) {
            const hardcodedRes = await loadHardcoded();
            if (hardcodedRes) {
                json = hardcodedRes.json;
                fromHardcoded = true;
            }
        }
        if (!json) {
            json = await loadModelJson(assetsPath);
        }
    } catch (e) {
    // 일부 커스텀 리소스팩에서 사용하는 models/items 경로로 재시도한다.
        try {
            const { path } = nsAndPathFromId(modelId);
            if (/^item\//.test(path)) {
                const alt = assetsPath.replace('/models/item/', '/models/items/');
                if (alt !== assetsPath) {
                    json = await loadModelJson(alt);
                }
            }
        } catch (e2) {
            // 재시도 실패는 무시한다.
        }
        if (!json && !hardcodedFirst) {
            const hardcodedRes = await loadHardcoded();
            if (hardcodedRes) {
                json = hardcodedRes.json;
                fromHardcoded = true;
            }
        }
        if (!json) {
            cache.set(modelId, null);
            return null;
        }
    }

    if (!fromHardcoded && isHardcodedModelId(modelId)) {
        const hardcodedRes = await loadHardcoded();
        if (hardcodedRes && hardcodedRes.json) {
            json = hardcodedRes.json;
            fromHardcoded = true;
        }
    }

    let mergedTextures = { ...(json.textures || {}) };
    let textureSize = Array.isArray(json.texture_size) ? json.texture_size : null;
    let elements = json.elements || null;
    let parentChain = [];
    let ignoreDisplayIds = [];

    if (json.parent) {
        const parentRes = await resolveModelTree(json.parent, cache);
        if (parentRes) {
            mergedTextures = { ...(parentRes.textures || {}), ...(mergedTextures || {}) };
            elements = elements || parentRes.elements || null;
            if (!textureSize && Array.isArray(parentRes.texture_size)) {
                textureSize = parentRes.texture_size;
            }
            parentChain = [...parentRes.parentChain, json.parent];
            fromHardcoded = fromHardcoded || !!parentRes.fromHardcoded;
            if (parentRes.ignoreDisplayIds) {
                if (Array.isArray(parentRes.ignoreDisplayIds)) {
                    ignoreDisplayIds.push(...parentRes.ignoreDisplayIds);
                } else if (parentRes.ignoreDisplayIds instanceof Set) {
                    ignoreDisplayIds.push(...parentRes.ignoreDisplayIds);
                }
            }
        }
    }

    if (Array.isArray(json.pbde_ignore_display_ids)) {
        ignoreDisplayIds.push(...json.pbde_ignore_display_ids);
    }

    ignoreDisplayIds.push(...collectIgnoreDisplayIdsForModelId(modelId));

    const ignoreDisplayIdsUnique = Array.from(new Set(ignoreDisplayIds.filter(Boolean)));

    const resolved: ResolvedModel = { id: modelId, json, textures: mergedTextures, elements, parentChain, texture_size: textureSize, fromHardcoded };
    if (ignoreDisplayIdsUnique.length) {
        resolved.ignoreDisplayIds = ignoreDisplayIdsUnique;
    }
    cache.set(modelId, resolved);
    return resolved;
}

// variant 키 문자열이 현재 속성(props)과 일치하는지 검사한다.
function matchVariantKey(variantKey, props) {
    if (variantKey === '') return true;
    const parts = variantKey.split(',').map(s => s.trim()).filter(Boolean);
    for (const p of parts) {
        const [k, v] = p.split('=');
        if (!k) continue;
        if (v === undefined) return false;
        if ((props[k] || '') !== v) return false;
    }
    return true;
}

// multipart 블록스테이트의 when 조건이 현재 속성에 부합하는지 판정한다.
function whenMatches(when, props) {
    if (!when) return true;
    if (Array.isArray(when)) {
        return when.some(w => whenMatches(w, props));
    }
    if (typeof when === 'object') {
        if (Array.isArray(when.OR)) {
            return when.OR.some(w => whenMatches(w, props));
        }
        if (Array.isArray(when.AND)) {
            return when.AND.every(w => whenMatches(w, props));
        }
        for (const [key, value] of Object.entries(when)) {
            if (key === 'OR' || key === 'AND') continue;
            const propValue = props[key] || 'false';
            const conditionValues = String(value).split('|');
            if (!conditionValues.includes(propValue)) {
                return false;
            }
        }
        return true;
    }
    return false;
}

// 블록스테이트 회전을 THREE 행렬에 적용한다.
function applyBlockstateRotation(matrix, rotX = 0, rotY = 0) {
    if (rotX === 0 && rotY === 0) return;
    const pivot = new THREE.Vector3(0.5, 0.5, 0.5);
    const t1 = new THREE.Matrix4().makeTranslation(-pivot.x, -pivot.y, -pivot.z);
    const t2 = new THREE.Matrix4().makeTranslation(pivot.x, pivot.y, pivot.z);

    const rx = new THREE.Matrix4().makeRotationX(THREE.MathUtils.degToRad(-rotX));
    const ry = new THREE.Matrix4().makeRotationY(THREE.MathUtils.degToRad(-rotY));
    const r = new THREE.Matrix4().multiply(ry).multiply(rx);
    const m = new THREE.Matrix4().multiply(t2).multiply(r).multiply(t1);
    matrix.premultiply(m);
}

// UV 좌표 배열을 90도 단위 회전 규칙에 맞춰 재배열한다.
function uvRotated(uv, rotation) {
    const r = ((rotation % 360) + 360) % 360;
    if (r === 0) return uv;
    if (r === 90) return [uv[3], uv[0], uv[1], uv[2]];
    if (r === 180) return [uv[2], uv[3], uv[0], uv[1]];
    if (r === 270) return [uv[1], uv[2], uv[3], uv[0]];
    return uv;
}

// 특정 하드코딩 모델(표지판 등)은 texture_size 정보를 반영해야 올바른 UV 비율을 유지한다.
// 반면 침대·상자 계열에서는 texture_size 적용 시 UV가 망가지므로 기본적으로 무시한다.
// 허용 목록에 포함된 모델만 예외적으로 texture_size를 사용하도록 제한한다.
function shouldAllowHardcodedTextureSize(resolved) {
    if (!resolved || !resolved.id) return false;
    const id = resolved.id; // 예: minecraft:block/sign
    // sign, wall_sign, hanging_sign 등 모든 표지판 변형을 포함한다.
    if (/([^:]*:)?block\/(?:.*_)?sign/.test(id)) return true;
    // 배너 등 추가 대상이 생기면 아래와 같이 조건을 확장할 수 있다: if (/banner/.test(id)) return true;
    return false;
}

// UV 사각형 네 꼭짓점을 지정한 피벗을 기준으로 회전시킨다.
function rotateCornersAroundPivot(corners, degreesCW, pivotU = 0.5, pivotV = 0.5) {
    const r = ((degreesCW % 360) + 360) % 360;
    if (r === 0) return corners;
    const rad = -r * Math.PI / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const rot = ([u, v]) => {
        const du = u - pivotU;
        const dv = v - pivotV;
        const ru = pivotU + du * cos - dv * sin;
        const rv = pivotV + du * sin + dv * cos;
        return [ru, rv];
    };
    return [rot(corners[0]), rot(corners[1]), rot(corners[2]), rot(corners[3])];
}

const FACE_UV_ADJUST = {
    north: { rot: 180,   flipU: false, flipV: true },
    south: { rot: 0,   flipU: true,  flipV: false },
    west:  { rot: 0,   flipU: true,  flipV: false },
    east:  { rot: 0,   flipU: true, flipV: false },
    up:    { rot: 90,  flipU: true, flipV: false  },
    down:  { rot: 90, flipU: false, flipV: true  },
};

// U 또는 V 축 대칭이 필요한 경우 코너 배열을 재배치한다.
function flipUCorners(c) { return [c[1], c[0], c[3], c[2]]; }
function flipVCorners(c) { return [c[3], c[2], c[1], c[0]]; }

// 큐브 면 하나를 버퍼에 추가한다.
function pushQuad(buff, a, b, c, d, n, uvTL, uvTR, uvBR, uvBL) {
    const base = buff.positions.length / 3;
    buff.positions.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z, d.x, d.y, d.z);
    buff.normals.push(n.x, n.y, n.z, n.x, n.y, n.z, n.x, n.y, n.z, n.x, n.y, n.z);
    buff.uvs.push(uvTL[0], uvTL[1], uvTR[0], uvTR[1], uvBR[0], uvBR[1], uvBL[0], uvBL[1]);
    buff.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
}

// 지정한 방향의 면을 구성하는 정점과 노멀을 계산한다.
function getFaceVertices(dir, from, to) {
    const x1 = from[0] / 16, y1 = from[1] / 16, z1 = from[2] / 16;
    const x2 = to[0] / 16,   y2 = to[1] / 16,   z2 = to[2] / 16;
    switch (dir) {
        case 'north': return { a: new THREE.Vector3(x1, y2, z1), b: new THREE.Vector3(x2, y2, z1), c: new THREE.Vector3(x2, y1, z1), d: new THREE.Vector3(x1, y1, z1), n: new THREE.Vector3(0, 0, -1) };
        case 'south': return { a: new THREE.Vector3(x2, y2, z2), b: new THREE.Vector3(x1, y2, z2), c: new THREE.Vector3(x1, y1, z2), d: new THREE.Vector3(x2, y1, z2), n: new THREE.Vector3(0, 0, 1) };
        case 'west':  return { a: new THREE.Vector3(x1, y2, z2), b: new THREE.Vector3(x1, y2, z1), c: new THREE.Vector3(x1, y1, z1), d: new THREE.Vector3(x1, y1, z2), n: new THREE.Vector3(-1, 0, 0) };
        case 'east':  return { a: new THREE.Vector3(x2, y2, z1), b: new THREE.Vector3(x2, y2, z2), c: new THREE.Vector3(x2, y1, z2), d: new THREE.Vector3(x2, y1, z1), n: new THREE.Vector3(1, 0, 0) };
        case 'up':    return { a: new THREE.Vector3(x1, y2, z1), b: new THREE.Vector3(x1, y2, z2), c: new THREE.Vector3(x2, y2, z2), d: new THREE.Vector3(x2, y2, z1), n: new THREE.Vector3(0, 1, 0) };
        case 'down':  return { a: new THREE.Vector3(x2, y1, z1), b: new THREE.Vector3(x2, y1, z2), c: new THREE.Vector3(x1, y1, z2), d: new THREE.Vector3(x1, y1, z1), n: new THREE.Vector3(0, -1, 0) };
    }
    return null;
}

// 블록 모델 요소를 순회하며 텍스처별 지오메트리 버퍼를 생성한다.
async function buildBlockModelGeometryData(resolved: ResolvedModel, opts: any = undefined): Promise<GeometryData[] | null> {
    const elements = resolved.elements;
    if (!elements || elements.length === 0) return null;

    // 🚀 최적화 3: 동일한 모델 ID는 캐시에서 재사용
    // const cacheKey = resolved.id + (opts ? JSON.stringify(opts) : '');
    // if (blockModelGeometryCache.has(cacheKey)) {
    //     return blockModelGeometryCache.get(cacheKey);
    // }

    const buffers = new Map<string, GeometryData>();
    // 텍스처 경로와 틴트 조합마다 독립된 버퍼를 생성한다.
    const addBuffer = (texPath: string, tintHex: number) => {
        const key = `${texPath}|${tintHex >>> 0}`;
        if (!buffers.has(key)) buffers.set(key, { positions: [], normals: [], uvs: [], indices: [], texPath, tintHex });
        return buffers.get(key)!;
    };

    // 각 요소의 여섯 면을 순회하면서 지오메트리를 조합한다.
    for (const el of elements) {
        const faces = el.faces || {};
        const from = el.from || [0,0,0];
        const to = el.to || [16,16,16];
        const rot = el.rotation || null;
        const hasRot = rot && typeof rot.angle === 'number' && rot.angle !== 0 && typeof rot.axis === 'string' && Array.isArray(rot.origin);
        const rescale = hasRot && rot.rescale === true;
        const pivot = hasRot ? new THREE.Vector3(rot.origin[0]/16, rot.origin[1]/16, rot.origin[2]/16) : null;
        const angleRad = hasRot ? (rot.angle * Math.PI) / 180 : 0;
        const rotMat = new THREE.Matrix4();
        const rotOnly = new THREE.Matrix4();
        if (hasRot) {
            // 마인크래프트 회전 정의를 THREE 행렬로 변환한다.
            const tNeg = new THREE.Matrix4().makeTranslation(-pivot.x, -pivot.y, -pivot.z);
            const tPos = new THREE.Matrix4().makeTranslation(pivot.x, pivot.y, pivot.z);
            switch (rot.axis) {
                case 'x': rotOnly.makeRotationX(angleRad); break;
                case 'y': rotOnly.makeRotationY(angleRad); break;
                case 'z': rotOnly.makeRotationZ(angleRad); break;
            }
            rotMat.copy(tPos).multiply(rotOnly);
            if (rescale) {
                const scaleFactor = 1.0 / Math.cos(angleRad);
                const scaleMat = new THREE.Matrix4();
                if (rot.axis === 'x') scaleMat.makeScale(1, scaleFactor, scaleFactor);
                else if (rot.axis === 'y') scaleMat.makeScale(scaleFactor, 1, scaleFactor);
                else if (rot.axis === 'z') scaleMat.makeScale(scaleFactor, scaleFactor, 1);
                rotMat.multiply(scaleMat);
            }
            rotMat.multiply(tNeg);
        }

        for (const dir of ['north','south','west','east','up','down']) {
            const face = faces[dir];
            if (!face || !face.texture) continue;
            const texId = resolveTextureRef(face.texture, resolved.textures);
            if (!texId) continue;
            const texAssetPath = textureIdToAssetPath(texId);

            let tintHex = 0xffffff;
            try {
                const modelResLoc = (resolved && resolved.id) ? resolved.id.split(':').slice(1).join(':') : '';
                const ti = (typeof face.tintindex === 'number') ? face.tintindex : undefined;
                tintHex = getTextureColor(modelResLoc, undefined, ti);
            } catch (_) { tintHex = 0xffffff; }

            // 배너 모델의 깃발 요소는 추출한 틴트 색상으로 덮어쓴다.
            if (opts && opts.bannerColorHex != null) {
                const elName = (el.name || '').toLowerCase();
                if (elName === 'flag') {
                    tintHex = opts.bannerColorHex >>> 0;
                }
            }

            const buff = addBuffer(texAssetPath, tintHex);
            const v = getFaceVertices(dir, from, to);
            if (!v) continue;

            let effectiveDir = dir;
            if (hasRot) {
                v.a.applyMatrix4(rotMat);
                v.b.applyMatrix4(rotMat);
                v.c.applyMatrix4(rotMat);
                v.d.applyMatrix4(rotMat);
                const n3 = new THREE.Matrix3().setFromMatrix4(rotOnly);
                v.n.applyMatrix3(n3).normalize();
                const { x, y, z } = v.n;
                if (Math.abs(x) > 0.99) effectiveDir = x > 0 ? 'east' : 'west';
                else if (Math.abs(y) > 0.99) effectiveDir = y > 0 ? 'up' : 'down';
                else if (Math.abs(z) > 0.99) effectiveDir = z > 0 ? 'south' : 'north';
            }

            const hasExplicitFaceUV = Array.isArray(face.uv) && face.uv.length === 4;
            let faceUV = face.uv;
            if (!faceUV) {
                switch (dir) {
                    case 'north': case 'south': faceUV = [from[0], from[1], to[0], to[1]]; break;
                    case 'west': case 'east': faceUV = [from[2], from[1], to[2], to[1]]; break;
                    case 'up': case 'down': faceUV = [from[0], from[2], to[0], to[2]]; break;
                    default: faceUV = [0, 0, 16, 16]; break;
                }
            }

            let extraUVRot = 0;
            if (opts && opts.uvlock) {
                const yRotNorm = ((opts.yRot || 0) % 360 + 360) % 360;
                const step = Math.round(yRotNorm / 90) * 90;
                if (dir === 'up') extraUVRot = step;
                else if (dir === 'down') extraUVRot = -step;
            }

            if ((dir === 'up' || dir === 'down') && !hasExplicitFaceUV) {
                const preAdjRot = (((face.rotation || 0) + extraUVRot) % 360 + 360) % 360;
                const geomW = Math.abs(to[0] - from[0]);
                const geomH = Math.abs(to[2] - from[2]);
                let ux0 = faceUV[0], vy0 = faceUV[1], ux1 = faceUV[2], vy1 = faceUV[3];
                const uw = Math.abs(ux1 - ux0);
                const vh = Math.abs(vy1 - vy0);
                let uTarget = (preAdjRot === 0 || preAdjRot === 180) ? geomW : geomH;
                let vTarget = (preAdjRot === 0 || preAdjRot === 180) ? geomH : geomW;
                const snapEven = (t) => Math.max(0, Math.min(16, Math.round(t / 2) * 2));
                uTarget = snapEven(uTarget);
                vTarget = snapEven(vTarget);
                if (Math.abs(uw - uTarget) > 1e-6 || Math.abs(vh - vTarget) > 1e-6) {
                    const uAsc = ux1 >= ux0, vAsc = vy1 >= vy0;
                    const uMin = Math.min(ux0, ux1), vMin = Math.min(vy0, vy1);
                    if (uAsc) { ux0 = uMin; ux1 = uMin + uTarget; } else { ux1 = uMin; ux0 = uMin + uTarget; }
                    if (vAsc) { vy0 = vMin; vy1 = vMin + vTarget; } else { vy1 = vMin; vy0 = vMin + vTarget; }
                    let uLo = Math.min(ux0, ux1), uHi = Math.max(ux0, ux1);
                    if (uLo < 0) { const s = -uLo; ux0 += s; ux1 += s; }
                    if (uHi > 16) { const s = uHi - 16; ux0 -= s; ux1 -= s; }
                    let vLo = Math.min(vy0, vy1), vHi = Math.max(vy0, vy1);
                    if (vLo < 0) { const s = -vLo; vy0 += s; vy1 += s; }
                    if (vHi > 16) { const s = vHi - 16; vy0 -= s; vy1 -= s; }
                    faceUV = [ux0, vy0, ux1, vy1];
                }
            }

            const uv = faceUV;
            const texSize = Array.isArray(resolved.texture_size)
                ? resolved.texture_size
                : (resolved.json && Array.isArray(resolved.json.texture_size))
                    ? resolved.json.texture_size
                    : null;
            // 명시된 UV가 있을 때 texture_size 정보를 사용할지 결정한다.
            // 하드코딩 모델은 원칙적으로 제외하지만 허용 목록 대상은 texture_size를 사용한다.
            const allowHardcodedTexSize = resolved.fromHardcoded && shouldAllowHardcodedTextureSize(resolved);
            const useTexSize = hasExplicitFaceUV && texSize && (!resolved.fromHardcoded || allowHardcodedTexSize);
            const uvScaleU = useTexSize ? texSize[0] : 16;
            const uvScaleV = useTexSize ? texSize[1] : 16;
            // UV 사각형을 0~1 범위로 정규화한다.
            const u0 = uv[0] / uvScaleU, v0 = 1 - uv[1] / uvScaleV;
            const u1 = uv[2] / uvScaleU, v1 = 1 - uv[3] / uvScaleV;
            let corners = [[u0, v0], [u1, v0], [u1, v1], [u0, v1]];
            const faceRotLocal = ((face.rotation || 0) % 360 + 360) % 360;
            corners = uvRotated(corners, faceRotLocal);
            if (extraUVRot) {
                corners = rotateCornersAroundPivot(corners, extraUVRot, 0.5, 0.5);
            }
            const adj = FACE_UV_ADJUST[effectiveDir];
            if (adj) {
                // 방향별 특수 처리로 UV 정렬과 플립을 맞춘다.
                if (adj.rot) corners = uvRotated(corners, adj.rot);
                if (adj.flipU) corners = flipUCorners(corners);
                if (adj.flipV) corners = flipVCorners(corners);
            }
            pushQuad(buff, v.a, v.b, v.c, v.d, v.n, corners[0], corners[1], corners[2], corners[3]);
        }
    }

    const result = Array.from(buffers.values());
    
    // 🚀 최적화 3: 결과를 캐시에 저장
    // blockModelGeometryCache.set(cacheKey, result);
    
    return result;
}

// block_display 엔티티 노드를 Minecraft 블록 모델 지오메트리로 변환한다.
async function processBlockDisplay(item: any): Promise<RenderItem | null> {
    try {
        const { baseName, props } = blockNameToBaseAndProps(item.name);
        const { path } = nsAndPathFromId(baseName);
        const hasHardcodedState = hasHardcodedBlockstate(path);
        const blockstatePath = `assets/minecraft/blockstates/${path}.json`;
        const hardcodedStatePath = `hardcoded/blockstates/${path}.json`;

        let blockstate;
        const isBannerBlock = /(?:^|_|:)banner$/.test(path) || /(?:^|_)wall_banner$/.test(path) || /_banner$/.test(path);
        try {
            if (hasHardcodedState) {
                try {
                    blockstate = await readJsonAsset(hardcodedStatePath);
                } catch (_) {
                    blockstate = await readJsonAsset(blockstatePath);
                }
            } else {
                blockstate = await readJsonAsset(blockstatePath);
            }
        } catch (e) {
            // 배너 블록스테이트가 없으면 최소 구성을 만들어 배너 모델을 가리키게 한다.
            if (isBannerBlock) {
                blockstate = { variants: { "": { model: 'minecraft:block/banner' } } };
            } else {
                return null;
            }
        }
        
        const modelCache = new Map();

        let modelsToBuild = [];
        if (blockstate.variants) {
            const entries = Object.entries(blockstate.variants);
            let bestMatch = null;
            for (const [key, value] of entries) {
                if (matchVariantKey(key, props)) {
                    const specificity = key.split(',').filter(Boolean).length;
                    if (!bestMatch || specificity > bestMatch.specificity) {
                        bestMatch = { value, specificity };
                    }
                }
            }
            const picked = bestMatch ? bestMatch.value : blockstate.variants[''];
            if (picked) {
                const applyList = Array.isArray(picked) ? picked : [picked];
                if (applyList.length > 0) {
                    modelsToBuild.push(applyList[0]);
                }
            }
        } else if (blockstate.multipart) {
            for (const part of blockstate.multipart) {
                if (!part) continue;
                if (!part.when || whenMatches(part.when, props)) {
                    const applyList = Array.isArray(part.apply) ? part.apply : [part.apply];
                    if (applyList.length > 0) {
                        modelsToBuild.push(applyList[0]);
                    }
                }
            }
        }

        if (modelsToBuild.length === 0) {
            // 디버그 시 아래 경고를 출력하여 매칭 실패 원인을 추적할 수 있다.
            return null;
        }

        const allGeometryData = [];
        // 항목명에서 "red_banner" 형태의 문자열을 분석해 틴트 색상을 추출한다.
        let bannerColorHex = null;
        try {
            const nameLower = String(item.name || '').toLowerCase();
            const m = nameLower.match(/(?:^|\W)(white|orange|magenta|light_blue|yellow|lime|pink|gray|light_gray|cyan|purple|blue|brown|green|red|black)_(?:wall_)?banner(?:$|\W)/);
            if (m) {
                const colorName = m[1];
                const dyeMap = {
                    white: 0xf9fffe,
                    orange: 0xf9801d,
                    magenta: 0xc74ebd,
                    light_blue: 0x3ab3da,
                    yellow: 0xfed83d,
                    lime: 0x80c71f,
                    pink: 0xf38baa,
                    gray: 0x474f52,
                    light_gray: 0x9d9d97,
                    cyan: 0x169c9c,
                    purple: 0x8932b8,
                    blue: 0x3c44aa,
                    brown: 0x835432,
                    green: 0x5e7c16,
                    red: 0xb02e26,
                    black: 0x1d1d21,
                };
                bannerColorHex = dyeMap[colorName] ?? null;
            }
        } catch { /* ignore */ }
        for (const apply of modelsToBuild) {
            if (!apply?.model) continue;
            const resolved = await resolveModelTree(apply.model, modelCache);
            if (!resolved || !resolved.elements) continue;
            
            const modelMatrix = new THREE.Matrix4();
            applyBlockstateRotation(modelMatrix, apply.x || 0, apply.y || 0);

            const geometryData = await buildBlockModelGeometryData(resolved, { 
                uvlock: !!apply.uvlock, 
                xRot: apply.x || 0, 
                yRot: apply.y || 0,
                bannerColorHex: bannerColorHex,
            });

            if (geometryData && geometryData.length > 0) {
                // block_display 지오메트리는 별도 중심 이동을 하지 않는다. 아이템 디스플레이만 -0.5 보정을 적용한다.
                allGeometryData.push({
                    modelMatrix: modelMatrix.elements,
                    geometries: geometryData,
                    geometryId: resolved.id
                });
            }
        }

        if (allGeometryData.length > 0) {
            return {
                type: 'blockDisplay',
                models: allGeometryData,
                blockProps: props
            };
        }

        return null;
    } catch (e) {
        // 필요하면 위 경고를 활성화해 블록 디스플레이 오류를 확인한다.
        return null;
    }
}

// ===================== 아이템 모델 처리 1단계 =====================

// 아이템 정의와 지오메트리 결과를 캐싱하여 중복 계산을 줄인다.
const modelTreeCache = new Map(); // 모델 ID별로 해석한 트리를 보관한다.
const itemDefinitionCache = new Map(); // 아이템 이름별 정의 JSON을 캐싱한다.
const itemModelGeometryCache = new Map(); // 모델 ID와 틴트 조합으로 생성된 지오메트리를 저장한다.
const itemModelHasElementsCache = new Map(); // 모델 ID별 요소 존재 여부를 기록한다.

// 🚀 최적화 3: 블록 모델 지오메트리 캐싱 (같은 블록 타입은 재사용)
const blockModelGeometryCache = new Map(); // 모델 ID별 지오메트리 캐시

// 플레이어 머리 아이템 전용 디스플레이 변환. 값을 바꾸면 즉시 반영된다.
const PLAYER_HEAD_DISPLAY_TRANSFORMS = {
    thirdperson_righthand: {
        rotation: [-45, 45, 0],
        translation: [0, 3, 0],
        scale: [0.5, 0.5, 0.5],
    },
    ground: {
        translation: [0, 3, 0],
        scale: [0.5, 0.5, 0.5],
    },
    gui: {
        rotation: [30, 45, 0],
        translation: [0, 3, 0],
    },
    fixed: {
        rotation: [0, 180, 0],
        translation: [0, 4, 0],
    },
};

const DEFAULT_ITEM_DISPLAY_TRANSFORMS = {
    item: {
        ground: {
            "rotation": [ 0, 0, 0 ],
            "translation": [ 0, 2, 0],
            "scale":[ 0.5, 0.5, 0.5 ]
        },
        head: {
            "rotation": [ 0, 180, 0 ],
            "translation": [ 0, 13, -7],
            "scale":[ 1, 1, 1]
        },
        thirdperson_righthand: {
            "rotation": [ 0, 0, 0 ],
            "translation": [ 0, 3, -1 ],
            "scale": [ 0.55, 0.55, 0.55 ]
        },
        firstperson_righthand: {
            "rotation": [ 0, -90, -25 ],
            "translation": [ -1.13, 3.2, -1.13],
            "scale": [ 0.68, 0.68, 0.68 ]
        },
        fixed: {
            "rotation": [ 0, 180, 0 ],
            "scale": [ 1, 1, 1 ]
        },
    },
    block: {
        gui: {
            rotation: [30, 225, 0],
            translation: [0, 0, 0],
            scale: [0.625, 0.625, 0.625],
        },
        ground: {
            rotation: [0, 0, 0],
            translation: [0, 3, 0],
            scale: [0.25, 0.25, 0.25],
        },
        fixed: {
            rotation: [0, 0, 0],
            translation: [0, 0, 0],
            scale: [0.5, 0.5, 0.5],
        },
        on_shelf: {
            rotation: [0, 180, 0],
            translation: [0, 0, 0],
            scale: [1, 1, 1],
        },
        thirdperson_righthand: {
            rotation: [75, 45, 0],
            translation: [0, 2.5, 0],
            scale: [0.375, 0.375, 0.375],
        },
        firstperson_righthand: {
            rotation: [0, -45, 0],
            translation: [0, 0, 0],
            scale: [0.4, 0.4, 0.4],
        },
        firstperson_lefthand: {
            rotation: [0, 225, 0],
            translation: [0, 0, 0],
            scale: [0.4, 0.4, 0.4],
        },
    },
};

const ITEM_DISPLAY_LEFT_HAND_FALLBACK = {
    thirdperson_lefthand: 'thirdperson_righthand',
    firstperson_lefthand: 'firstperson_righthand',
};

// display 항목 구조를 안전하게 복제하면서 숫자만 남긴다.
function cloneDisplayTransform(def) {
    if (!def || typeof def !== 'object') return null;
    const rotSrc = Array.isArray(def.rotation) ? def.rotation : [];
    const transSrc = Array.isArray(def.translation) ? def.translation : [];
    const scaleSrc = Array.isArray(def.scale) ? def.scale : [];

    const coerce = (val, fallback) => {
        const n = Number(val);
        return Number.isFinite(n) ? n : fallback;
    };

    const rotation = [
        coerce(rotSrc[0], 0),
        coerce(rotSrc[1], 0),
        coerce(rotSrc[2], 0),
    ];
    const translation = [
        coerce(transSrc[0], 0),
        coerce(transSrc[1], 0),
        coerce(transSrc[2], 0),
    ];
    const scale = [
        coerce(scaleSrc[0], 1),
        coerce(scaleSrc[1], 1),
        coerce(scaleSrc[2], 1),
    ];

    return { rotation, translation, scale };
}

// 오른손 기준 변환을 좌측 손 형태로 반전한다.
function mirrorRightHandDisplayTransform(def) {
    const cloned = cloneDisplayTransform(def);
    if (!cloned) return null;
    cloned.translation[0] = -(cloned.translation[0] || 0);
    cloned.rotation[1] = -(cloned.rotation[1] || 0);
    cloned.rotation[2] = -(cloned.rotation[2] || 0);
    return cloned;
}

// 모델이 block 계열인지 판별해 중심 이동 여부를 결정한다.
function isBlockLikeItemModel(resolved) {
    if (!resolved) return false;
    const checkId = (id) => typeof id === 'string' && id.includes('block/');
    if (checkId(resolved.id)) return true;
    if (Array.isArray(resolved.parentChain)) {
        return resolved.parentChain.some(checkId);
    }
    return false;
}

// 모델 상속 체인에서 원하는 display 변환을 탐색한다.
async function findDisplayTransformInHierarchy(resolved, displayType, cache) {
    if (!resolved || !displayType) return null;
    const ignoreDisplayIds = (() => {
        const ignore = resolved.ignoreDisplayIds;
        if (!ignore) return null;
        if (ignore instanceof Set) return ignore;
        if (Array.isArray(ignore)) return new Set(ignore);
        return new Set([ignore]);
    })();
    const idsToCheck = [];
    if (resolved.id) idsToCheck.push(resolved.id);
    if (Array.isArray(resolved.parentChain) && resolved.parentChain.length > 0) {
        for (let i = resolved.parentChain.length - 1; i >= 0; i--) {
            const parentId = resolved.parentChain[i];
            if (parentId) idsToCheck.push(parentId);
        }
    }

    for (const id of idsToCheck) {
        if (ignoreDisplayIds && ignoreDisplayIds.has(id)) {
            continue;
        }
        let candidate;
        if (id === resolved.id) {
            candidate = resolved;
        } else if (cache.has(id)) {
            candidate = cache.get(id);
        } else {
            candidate = await resolveModelTree(id, cache);
        }

        if (!candidate || !candidate.json) continue;
        const display = candidate.json.display;
        if (display && display[displayType]) {
            return cloneDisplayTransform(display[displayType]);
        }
    }
    return null;
}

// display 타입에 맞는 변환 매트릭스를 찾고 기본값 또는 좌우 대체를 적용한다.
async function getDisplayTransformForItem(resolved, displayType, cache) {
    if (!displayType) return null;
    const defaultsRoot = isBlockLikeItemModel(resolved)
        ? (DEFAULT_ITEM_DISPLAY_TRANSFORMS.block || {})
        : (DEFAULT_ITEM_DISPLAY_TRANSFORMS.item || {});

    let transform = await findDisplayTransformInHierarchy(resolved, displayType, cache);

    if (!transform && defaultsRoot[displayType]) {
        transform = cloneDisplayTransform(defaultsRoot[displayType]);
    }

    if (!transform && ITEM_DISPLAY_LEFT_HAND_FALLBACK[displayType]) {
        const fallbackKey = ITEM_DISPLAY_LEFT_HAND_FALLBACK[displayType];
        let fallback = await findDisplayTransformInHierarchy(resolved, fallbackKey, cache);
        if (!fallback && defaultsRoot[fallbackKey]) {
            fallback = cloneDisplayTransform(defaultsRoot[fallbackKey]);
        }
        if (fallback) {
            transform = mirrorRightHandDisplayTransform(fallback);
        }
    }

    return transform;
}

// display 구성을 THREE Matrix4로 변환한다.
function buildDisplayTransformMatrix(transform) {
    if (!transform) return null;
    const rotation = Array.isArray(transform.rotation) ? transform.rotation : [0, 0, 0];
    const translation = Array.isArray(transform.translation) ? transform.translation : [0, 0, 0];
    const scale = Array.isArray(transform.scale) ? transform.scale : [1, 1, 1];

    const tx = (translation[0] || 0) / 16;
    const ty = (translation[1] || 0) / 16;
    const tz = (translation[2] || 0) / 16;

    const rx = THREE.MathUtils.degToRad(rotation[0] || 0);
    const ry = THREE.MathUtils.degToRad(rotation[1] || 0);
    const rz = THREE.MathUtils.degToRad(rotation[2] || 0);

    const sx = scale[0] == null ? 1 : scale[0];
    const sy = scale[1] == null ? 1 : scale[1];
    const sz = scale[2] == null ? 1 : scale[2];

    const translationVec = new THREE.Vector3(tx, ty, tz);
    const rotationEuler = new THREE.Euler(rx, ry, rz, 'XYZ');
    const rotationQuat = new THREE.Quaternion().setFromEuler(rotationEuler);
    const scaleVec = new THREE.Vector3(sx, sy, sz);

    const matrix = new THREE.Matrix4();
    matrix.compose(translationVec, rotationQuat, scaleVec);
    return matrix;
}

// 아이템 문자열에서 기본 이름과 display 타입을 추출한다.
function parseItemName(raw) {
    if (!raw) return { baseName: '', displayType: null };

    const start = raw.indexOf('[');
    if (start === -1) return { baseName: raw, displayType: null };

    const baseName = raw.slice(0, start);
    const end = raw.indexOf(']', start);
    if (end === -1) return { baseName, displayType: null };

    const inside = raw.slice(start + 1, end); // "display=gui"
    const parts = inside.split(','); // 단일 display만 있다고 확신 가능

    let displayType = null;
    for (let i = 0; i < parts.length; i++) {
        if (parts[i].startsWith('display=')) {
            displayType = parts[i].slice(8); // "display=".length === 8
            break;
        }
    }

    return { baseName, displayType };
}


// items 디렉터리에서 아이템 정의 JSON을 읽어 캐싱한다.
async function loadItemDefinition(itemName) {
    if (itemDefinitionCache.has(itemName)) return itemDefinitionCache.get(itemName);
    const path = `assets/minecraft/items/${itemName}.json`;
    try {
        const json = await readJsonAsset(path);
        itemDefinitionCache.set(itemName, json);
        return json;
    } catch (_) {
        itemDefinitionCache.set(itemName, null);
        return null;
    }
}

// builtin/ 계열 모델인지 여부를 확인해 전용 지오메트리를 선택한다.
function isBuiltinModel(resolved) {
    if (!resolved) return false;
    if (resolved.id.startsWith('builtin/')) return true;
    return resolved.parentChain.some(p => p.startsWith('builtin/'));
}

// 아이템 모델에서 첫 번째 레이어 텍스처 ID를 꺼낸다.
function extractLayer0Texture(resolved) {
    if (!resolved) return null;
    const textures = resolved.textures || {};
    const layer0 = textures.layer0 || textures.texture || null;
    if (!layer0) return null;
    return resolveTextureRef(layer0, textures);
}

// 요소가 없는 모델은 앞·뒤 두 장의 평면으로 단순 지오메트리를 구성한다.
function buildGeneratedPlaneGeometry(texId, tintHex = 0xffffff) {
    if (!texId) return [];
    const texPath = textureIdToAssetPath(texId);

    const positionsFront = [ // +Z 방향을 바라보는 반시계 정점 배열
        0, 1, 0,  1, 1, 0,  1, 0, 0,  0, 0, 0
    ];
    const positionsBack = [ // -Z 방향을 바라보는 반시계 정점 배열
        0, 1, 0,  0, 0, 0,  1, 0, 0,  1, 1, 0
    ];
    const normalsFront = [0,0,1, 0,0,1, 0,0,1, 0,0,1];
    const normalsBack = [0,0,-1, 0,0,-1, 0,0,-1, 0,0,-1];
    const uvsFront = [0,1, 1,1, 1,0, 0,0];
    // 뒤쪽 면 UV를 재배치해 후면에서도 텍스처가 뒤집히지 않도록 맞춘다.
    // 후면 정점 순서는 TL, BL, BR, TR 이므로 동일한 방향의 UV를 제공한다.
    const uvsBack  = [0,1, 0,0, 1,0, 1,1];
    const indices = [0,2,1, 0,3,2]; // 음수 스케일 보정 때문에 시계 방향 인덱스를 사용한다.

    // 최종 버퍼에 포지션·법선·UV를 밀어 넣는다.
    function push(buffers, pos, nor, uvArr) {
        const base = buffers.positions.length / 3;
        buffers.positions.push(...pos);
        buffers.normals.push(...nor);
        buffers.uvs.push(...uvArr);
        for (let i = 0; i < indices.length; i++) buffers.indices.push(base + indices[i]);
    }

    const buffer = { positions: [], normals: [], uvs: [], indices: [], texPath, tintHex };
    push(buffer, positionsFront, normalsFront, uvsFront);
    push(buffer, positionsBack, normalsBack, uvsBack);
    return [buffer];
}

// 내장 아이템은 앞뒤 평면과 외곽 경계만 돌출한 특수 지오메트리를 사용한다.
// 성능 최적화: 이미지 디코딩 결과와 경계 계산을 캐싱하여 반복 작업을 줄인다.
const BUILTIN_ITEM_DEPTH = 1/16; // 두 평면 사이 두께는 1/16 블록 단위로 유지한다.
const builtinBorderGeometryCache = new Map(); // 텍스처 경로별로 계산된 지오메트리를 캐싱한다.
const texturePixelCache = new Map(); // 텍스처 경로에 대한 픽셀 데이터(w,h,data)를 저장한다.
const texturePixelPromises = new Map(); // 중복 요청을 막기 위해 진행 중인 비동기 작업을 기록한다.
const textureBoundaryCache = new Map(); // 경계 픽셀 집합을 텍스처 경로별로 저장한다.

type LoadTexturePixelsFn = {
    (texPath: string): Promise<TexturePixelData | null>;
    _canvas?: OffscreenCanvas | null;
};

const loadTexturePixels: LoadTexturePixelsFn = Object.assign(
    async function loadTexturePixelsInner(texPath: string): Promise<TexturePixelData | null> {
        if (texturePixelCache.has(texPath)) return texturePixelCache.get(texPath) ?? null;
        if (texturePixelPromises.has(texPath)) return texturePixelPromises.get(texPath) ?? null;
        const p = (async () => {
            try {
                const asset = await workerAssetProvider.getAsset(texPath);
                let bytes: Uint8Array | null = null;
                if (asset instanceof Uint8Array) bytes = asset;
                else if (asset && typeof asset === 'object' && 'type' in asset && (asset as any).type === 'Buffer' && Array.isArray((asset as any).data)) bytes = new Uint8Array((asset as any).data);
                else if (typeof asset === 'string') {
                    bytes = new Uint8Array(asset.length);
                    for (let i = 0; i < asset.length; i++) bytes[i] = asset.charCodeAt(i) & 0xff;
                } else {
                    return null;
                }
                if (!bytes) return null;
                const blob = new Blob([bytes as any], { type: 'image/png' });
                let bmp: ImageBitmap | null = null;
                try {
                    bmp = await createImageBitmap(blob);
                    const w = bmp.width;
                    let h = bmp.height;
                    // If height > width, assume animation strip and crop to top square
                    if (h > w) h = w;

                    if (!w || !h) return null;
                    if (!loadTexturePixels._canvas) loadTexturePixels._canvas = new OffscreenCanvas(w, h);
                    const canvas = loadTexturePixels._canvas;
                    if (!canvas) return null;
                    if (canvas.width !== w || canvas.height !== h) {
                        canvas.width = w;
                        canvas.height = h;
                    }
                    const ctx = canvas.getContext('2d', { willReadFrequently: true });
                    if (!ctx) return null;
                    ctx.clearRect(0, 0, w, h);
                    ctx.drawImage(bmp, 0, 0);
                    const data = ctx.getImageData(0, 0, w, h).data;
                    const record: TexturePixelData = { w, h, data };
                    texturePixelCache.set(texPath, record);
                    return record;
                } finally {
                    if (bmp && typeof bmp.close === 'function') {
                        bmp.close();
                    }
                }
            } catch (e) {
                ////try { console.warn('[ItemModel] loadTexturePixels failed', texPath, e); } catch {}
                return null;
            } finally {
                texturePixelPromises.delete(texPath);
            }
        })();
        texturePixelPromises.set(texPath, p);
        return p;
    },
    { _canvas: null as OffscreenCanvas | null }
);

// 텍스처의 불투명 경계 픽셀을 찾아 외곽 라인을 만든다.
function computeBoundaryMask(texPath, px) {
    if (!px) return null;
    if (textureBoundaryCache.has(texPath)) return textureBoundaryCache.get(texPath);
    const { w, h, data } = px;
    const boundary = new Set();
    const alphaAt = (x,y) => data[(y*w + x)*4 + 3];
    const opaque = (x,y) => x>=0 && y>=0 && x<w && y<h && alphaAt(x,y) > 0;
    for (let y=0;y<h;y++) {
        for (let x=0;x<w;x++) {
            if (!opaque(x,y)) continue;
            if (!opaque(x-1,y) || !opaque(x+1,y) || !opaque(x,y-1) || !opaque(x,y+1)) {
                boundary.add(y*w + x);
            }
        }
    }
    textureBoundaryCache.set(texPath, boundary);
    return boundary;
}

async function buildBuiltinBorderBetweenPlanesGeometry(texId, tintHex = 0xffffff) {
    if (!texId) return [];
    const texPath = textureIdToAssetPath(texId);
    if (builtinBorderGeometryCache.has(texPath)) {
        const data = builtinBorderGeometryCache.get(texPath);
        return [{ ...data, texPath, tintHex }];
    }
    try {
        const px = await loadTexturePixels(texPath);
        if (!px) return buildGeneratedPlaneGeometry(texId, tintHex);
        const { w, h } = px;
        if (!w || !h) return buildGeneratedPlaneGeometry(texId, tintHex);
        const boundary = computeBoundaryMask(texPath, px);
        const data = px.data;
        const alphaAt = (x,y) => data[(y*w + x)*4 + 3];
        const opaque = (x,y) => x>=0 && y>=0 && x<w && y<h && alphaAt(x,y) > 0;
        const positions = []; const normals = []; const uvs = []; const indices = [];
        const pushQuad = (verts, normal, uvArr) => {
            const base = positions.length / 3;
            positions.push(...verts);
            for (let i=0;i<4;i++) normals.push(...normal);
            uvs.push(...uvArr);
            indices.push(base, base+2, base+1, base, base+3, base+2); // 역방향 도형 보정을 위해 인덱스 순서를 뒤집는다.
        };
        const dz = BUILTIN_ITEM_DEPTH / 2;
    // 앞면 평면을 추가한다.
        pushQuad([0,1,dz, 0,0,dz, 1,0,dz, 1,1,dz],[0,0,1],[0,1, 0,0, 1,0, 1,1]);
    // 뒷면 평면을 추가한다.
        pushQuad([0,1,-dz, 1,1,-dz, 1,0,-dz, 0,0,-dz],[0,0,-1],[0,1, 1,1, 1,0, 0,0]);
        if (boundary && boundary.size) {
            for (const idx of boundary) {
                const y = Math.floor(idx / w);
                const x = idx - y*w;
                const x0 = x / w; const x1 = (x+1)/w;
                const yTop = 1 - y / h; const yBot = 1 - (y+1)/h;
                const u0 = x0; const u1 = x1; const v0 = yBot; const v1 = yTop;
                // 서쪽 면
                if (!opaque(x-1,y)) {
                    pushQuad([x0,yTop,dz, x0,yTop,-dz, x0,yBot,-dz, x0,yBot,dz],[1,0,0],[u1,v1, u0,v1, u0,v0, u1,v0]);
                }
                // 동쪽 면
                if (!opaque(x+1,y)) {
                    pushQuad([x1,yTop,-dz, x1,yTop,dz, x1,yBot,dz, x1,yBot,-dz],[-1,0,0],[u0,v1, u1,v1, u1,v0, u0,v0]);
                }
                // 윗면
                if (!opaque(x,y-1)) {
                    pushQuad([x0,yTop,dz, x1,yTop,dz, x1,yTop,-dz, x0,yTop,-dz],[0,1,0],[u0,v1, u1,v1, u1,v0, u0,v0]);
                }
                // 아랫면
                if (!opaque(x,y+1)) {
                    pushQuad([x0,yBot,-dz, x1,yBot,-dz, x1,yBot,dz, x0,yBot,dz],[0,-1,0],[u0,v1, u1,v1, u1,v0, u0,v0]);
                }
            }
        }
        const geomData = { positions, normals, uvs, indices };
        builtinBorderGeometryCache.set(texPath, geomData);
        return [{ ...geomData, texPath, tintHex }];
    } catch (e) {
        //try { console.warn('[ItemModel] builtin border geometry failed for', texPath, e); } catch {}
        return buildGeneratedPlaneGeometry(texId, tintHex);
    }
}

// 불투명 경계 픽셀만 얇게 돌출해 림 효과를 주는 용도다.
const extrudedItemGeometryCache = new Map(); // 텍스처 경로별로 돌출 지오메트리를 캐싱한다.

async function buildItemModelGeometryData(resolved) {
    if (!resolved) return null;
    if (resolved.elements && resolved.elements.length > 0) {
        // 큐브 요소가 존재하면 블록 모델 경로를 재사용한다.
        return await buildBlockModelGeometryData(resolved);
    }
    // generated 또는 builtin 계열은 단순 평면 지오메트리로 처리한다.
    const layer0 = extractLayer0Texture(resolved);
    if (!layer0) return null;

    let tintHex = 0xffffff;
    try {
        const modelResLoc = (resolved && resolved.id) ? resolved.id.split(':').slice(1).join(':') : '';
        tintHex = getTextureColor(modelResLoc, undefined, 0);
    } catch (_) { tintHex = 0xffffff; }

    // builtin 모델이거나 generated/handheld 부모를 가진 경우 외곽 테두리 지오메트리를 사용한다.
    const useBorder = isBuiltinModel(resolved) || resolved.parentChain.some(p => /item\/(generated|handheld)/.test(p));
    if (useBorder) {
        //try { console.log('[ItemModel] using builtin border geometry for', resolved.id); } catch {}
        return await buildBuiltinBorderBetweenPlanesGeometry(layer0, tintHex);
    }
    return buildGeneratedPlaneGeometry(layer0, tintHex);
}

// item_display 노드를 분석해 모델 지오메트리와 display 변환을 계산한다.
async function processItemModelDisplay(node: any): Promise<RenderItem | null> {
    try {
        const { baseName, displayType } = parseItemName(node.name);
        if (!baseName) return null;
        //try { console.log('[ItemModel] start', node.name, 'base', baseName); } catch {}
        const definition = await loadItemDefinition(baseName);
        let modelId;
        let tintList = null;
        if (definition && definition.model) {
            if (typeof definition.model === 'string') {
                modelId = definition.model;
            } else if (definition.model && typeof definition.model === 'object') {
                // 예상 구조: { type: 'minecraft:model', model: 'minecraft:block/grass_block', tints: [...] }
                if (typeof definition.model.model === 'string') {
                    modelId = definition.model.model;
                }
                if (Array.isArray(definition.model.tints)) tintList = definition.model.tints.slice();
            }
        }
        if (!modelId) modelId = `minecraft:item/${baseName}`;
        //try { console.log('[ItemModel] definition', definition ? 'yes' : 'no', 'modelId', modelId, 'tints', tintList ? tintList.length : 0); } catch {}
        // 모델 ID 단위로 지오메트리를 캐싱해 반복 연산을 줄인다.
        // const cacheKey = modelId;
        // let geomData = itemModelGeometryCache.get(cacheKey);
        // let hasElements = itemModelHasElementsCache.get(cacheKey) || false;
        let geomData = null;
        let hasElements = false;
        let resolved = null;
        if (!geomData) {
            resolved = await resolveModelTree(modelId, modelTreeCache);
            if (!resolved) {
                //try { console.warn('[ItemModel] resolve failed', modelId); } catch {}
                return null;
            }
            hasElements = !!(resolved.elements && resolved.elements.length > 0);
            //try { console.log('[ItemModel] resolved', modelId, 'elements', hasElements ? resolved.elements.length : 0, 'parent', resolved.parent || 'none'); } catch {}
            geomData = await buildItemModelGeometryData(resolved);
            // if (geomData && geomData.length) {
            //     itemModelGeometryCache.set(cacheKey, geomData);
            //     itemModelHasElementsCache.set(cacheKey, hasElements);
            // }
        }
        if (!resolved) {
            resolved = await resolveModelTree(modelId, modelTreeCache);
        }
        if (!resolved) {
            //try { console.warn('[ItemModel] resolve failed (post-cache)', modelId); } catch {}
            return null;
        }
        if (!geomData || geomData.length === 0) {
            //try { console.warn('[ItemModel] empty geometry', modelId); } catch {}
            return null;
        }
        //try { console.log('[ItemModel] geometry buffers', geomData.length, 'for', modelId, 'hasElements', hasElements); } catch {}
        const modelMatrix = new THREE.Matrix4();
        if (hasElements) {
            // 블록형 아이템은 중심을 -0.5로 이동해 월드 좌표계와 정렬한다.
            modelMatrix.multiply(new THREE.Matrix4().makeTranslation(-0.5, -0.5, -0.5));
            //try { console.log('[ItemModel] applied block-like centering', modelId); } catch {}
        } else {
            // 평면 아이템은 Y축 180도 회전 없이 중심만 이동해 앞면이 +Z를 바라보게 유지한다.
            const translateCenter = new THREE.Matrix4().makeTranslation(-0.5, -0.5, 0);
            modelMatrix.multiply(translateCenter);
            // 좌우 반전으로 UV와 노멀 방향을 일치시킨다.
            modelMatrix.premultiply(new THREE.Matrix4().makeScale(-1, 1, 1));
            //try { console.log('[ItemModel] applied flat full centering and horizontal flip', modelId); } catch {}
        }

        if (displayType) {
            if (baseName === 'player_head') {
                const override = PLAYER_HEAD_DISPLAY_TRANSFORMS[displayType];
                const overrideMatrix = buildDisplayTransformMatrix(override);
                if (overrideMatrix) {
                    modelMatrix.premultiply(overrideMatrix);
                }
            } else {
                try {
                    const displayTransform = await getDisplayTransformForItem(resolved, displayType, modelTreeCache);
                    const displayMatrix = buildDisplayTransformMatrix(displayTransform);
                    if (displayMatrix) {
                        modelMatrix.premultiply(displayMatrix);
                    }
                } catch (err) {
                    //try { console.warn('[ItemModel] display transform error', modelId, displayType, err); } catch {}
                }
            }
        }
        return {
            type: 'itemDisplayModel',
            name: baseName,
            originalName: node.name,
            displayType: displayType || null,
            tints: tintList || null,
            models: [{ modelMatrix: modelMatrix.elements.slice(), geometries: geomData, geometryId: modelId }],
            transform: node.transform || node.transforms || null,
            itemDisplayType: displayType || null
        };
    } catch (e) {
        //try { console.warn('[ItemModel] error', node.name, e); } catch {}
        return null;
    }
}

// 반복 실행 시 캐시와 임시 리소스를 초기화한다.
function resetWorkerCaches(options: { clearCanvas?: boolean } = {}) {
    const { clearCanvas = true } = options;
    assetCache.clear();
    requestPromises.clear();
    requestIdCounter = 0;
    modelTreeCache.clear();
    itemDefinitionCache.clear();
    itemModelGeometryCache.clear();
    itemModelHasElementsCache.clear();
    blockModelGeometryCache.clear(); // 🚀 최적화 3: 블록 지오메트리 캐시 초기화
    builtinBorderGeometryCache.clear();
    extrudedItemGeometryCache.clear();
    texturePixelCache.clear();
    textureBoundaryCache.clear();
    texturePixelPromises.clear();
    assetProvider = undefined;
    if (clearCanvas && loadTexturePixels._canvas) {
        loadTexturePixels._canvas.width = 1;
        loadTexturePixels._canvas.height = 1;
        loadTexturePixels._canvas = null;
    }
}

// --- 원본 워커 흐름 제어 로직 ---

function generateUUID() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
        return crypto.randomUUID();
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

let groups = new Map<string, GroupData>();
let sceneOrder: { rootIndex: number, type: 'group' | 'object', id: string }[] = [];

// 두 개의 4x4 행렬을 곱해 누적 변환을 계산한다.
function apply_transforms(parent: Float32Array | number[], child: Float32Array | number[]) {
    const result = new Float32Array(16);
    for (let i = 0; i < 4; i++) {
        for (let j = 0; j < 4; j++) {
            result[i * 4 + j] =
                parent[i * 4 + 0] * child[0 * 4 + j] +
                parent[i * 4 + 1] * child[1 * 4 + j] +
                parent[i * 4 + 2] * child[2 * 4 + j] +
                parent[i * 4 + 3] * child[3 * 4 + j];
        }
    }
    return result;
}


// 렌더링에 필요한 필드만 남기며 자식 노드를 얕게 복제한다.
function split_children(children: any): any[] {
    if (!children) return [];
    return children.map((item: any) => {
        const newItem: any = {};

        // display 유형 플래그는 그대로 복사해 후속 로직이 구분할 수 있게 한다.
        if (item.isCollection) newItem.isCollection = true;
        if (item.isItemDisplay) newItem.isItemDisplay = true;
        if (item.isBlockDisplay) newItem.isBlockDisplay = true;
        if (item.isTextDisplay) newItem.isTextDisplay = true;

        // name과 nbt는 기본 정보이므로 항상 포함한다.
        newItem.name = item.name || "";
        newItem.nbt = item.nbt || "";

        // 밝기 정보는 기본값과 다를 때만 보존한다.
        if (item.brightness && (item.brightness.sky !== 15 || item.brightness.block !== 0)) {
            newItem.brightness = item.brightness;
        }

        // 선택 속성들은 존재할 때만 전달한다.
        if (item.tagHead) newItem.tagHead = item.tagHead;
        if (item.options) newItem.options = item.options;
        if (item.paintTexture) newItem.paintTexture = item.paintTexture;
        if (item.textureValueList) newItem.textureValueList = item.textureValueList;
        if (item.pivotCustom) newItem.pivotCustom = item.pivotCustom;

        // 변환 행렬은 빈 문자열이라도 항상 유지한다.
        newItem.transforms = item.transforms || "";

        // 자식 노드는 재귀적으로 동일한 규칙을 적용해 복제한다.
        if (item.children) {
            newItem.children = split_children(item.children);
        }
        // 필요하면 아래 로그를 복구해 변환 결과를 확인할 수 있다.
        return newItem;
    });
}

// 씬 그래프 노드를 재귀적으로 순회하며 렌더 항목을 만든다.
async function processNode(node: any, parentTransform: Float32Array | number[], parentGroupId: string | null = null): Promise<RenderItem[]> {
    const worldTransform = apply_transforms(parentTransform, node.transforms);
    let renderItems: RenderItem[] = [];

    let currentGroupId = parentGroupId;

    if (node.isCollection) {
        const newGroupId = generateUUID();

        const m = new THREE.Matrix4().fromArray(worldTransform).transpose();
        const position = new THREE.Vector3();
        const quaternion = new THREE.Quaternion();
        const scale = new THREE.Vector3();
        m.decompose(position, quaternion, scale);

        const pivot = node.pivotCustom || [0.5, 0.5, 0.5];

        groups.set(newGroupId, {
            id: newGroupId,
            isCollection: true,
            children: [],
            parent: parentGroupId,
            name: node.name || 'Group',
            position: { x: position.x, y: position.y, z: position.z },
            quaternion: { x: quaternion.x, y: quaternion.y, z: quaternion.z, w: quaternion.w },
            scale: { x: scale.x, y: scale.y, z: scale.z },
            pivot: pivot
        });

        if (parentGroupId === null && (node as any)._rootIndex !== undefined) {
            sceneOrder.push({ rootIndex: (node as any)._rootIndex, type: 'group', id: newGroupId });
        }

        if (parentGroupId) {
            const parentGroup = groups.get(parentGroupId);
            if (parentGroup) {
                parentGroup.children.push({ type: 'group', id: newGroupId });
            }
        }
        currentGroupId = newGroupId;
    }

    if (node.isBlockDisplay) {
        const modelData = await processBlockDisplay(node);
        if (modelData) {
            (modelData as any).transform = worldTransform; // 계산된 월드 변환 행렬을 결과에 포함한다.
            (modelData as any).name = node.name;
            
            const uuid = generateUUID();
            (modelData as any).uuid = uuid;
            (modelData as any).groupId = currentGroupId;
            
            if (currentGroupId) {
                const g = groups.get(currentGroupId);
                if (g) g.children.push({ type: 'object', id: uuid });
            } else if ((node as any)._rootIndex !== undefined) {
                sceneOrder.push({ rootIndex: (node as any)._rootIndex, type: 'object', id: uuid });
            }

            renderItems.push(modelData);
        }
    } else if (node.isItemDisplay) {
        // 플레이어 머리 아이템은 별도의 처리 경로를 따른다.
        if (node.name.startsWith('player_head')) {
            let adjustedTransform = worldTransform;
            let displayType = null;
            try {
                const parsed = parseItemName(node.name);
                if (parsed && parsed.displayType) {
                    displayType = String(parsed.displayType).toLowerCase();
                }
            } catch {/* ignore parse errors */}

            if (displayType) {
                const override = PLAYER_HEAD_DISPLAY_TRANSFORMS[displayType];
                const overrideMatrix = buildDisplayTransformMatrix(override);
                if (overrideMatrix && worldTransform) {
                    const worldMatrix = new THREE.Matrix4().fromArray(worldTransform).transpose();
                    worldMatrix.multiply(overrideMatrix);
                    const rowMajor = worldMatrix.clone().transpose().elements;
                    adjustedTransform = new Float32Array(rowMajor);
                }
            }

            const itemData: RenderItem = {
                type: 'itemDisplay',
                name: node.name,
                transform: adjustedTransform,
                nbt: node.nbt,
                options: node.options,
                brightness: node.brightness
            };
            if (displayType) itemData.displayType = displayType;
            let textureUrl = null;
            const defaultTextureValue = 'https://textures.minecraft.net/texture/d94e1686adb67823c7e5148c2c06e2d95c1b66374409e96b32dc1310397e1711';
            if (node.tagHead && node.tagHead.Value) {
                try {
                    // JSON 파싱 중 문자열 변환을 거치도록 수정된 구간이다.
                    const decoded = atob(node.tagHead.Value);
                    const skinMarker = '"SKIN":{"url":"';
                    const urlIndex = decoded.indexOf(skinMarker);
                    let parsedUrl = null;
                    if (urlIndex !== -1) {
                        const startIndex = urlIndex + skinMarker.length;
                        const endIndex = decoded.indexOf('"', startIndex);
                        if (endIndex !== -1) {
                            parsedUrl = decoded.substring(startIndex, endIndex);
                        }
                    }
                    
                    if (parsedUrl) {
                        textureUrl = parsedUrl;
                    } else {
                        let url = JSON.parse(decoded).textures.SKIN.url;
                        textureUrl = url.replace('http://', 'https://');
                    }
                } catch (err) { /* ignore */ }
            } else if (node.paintTexture) {
                textureUrl = node.paintTexture.startsWith('data:image') ? node.paintTexture : `data:image/png;base64,${node.paintTexture}`;
            }
            itemData.textureUrl = textureUrl || defaultTextureValue;

            const uuid = generateUUID();
            itemData.uuid = uuid;
            itemData.groupId = currentGroupId;
            if (currentGroupId) {
                const g = groups.get(currentGroupId);
                if (g) g.children.push({ type: 'object', id: uuid });
            } else if ((node as any)._rootIndex !== undefined) {
                sceneOrder.push({ rootIndex: (node as any)._rootIndex, type: 'object', id: uuid });
            }

            renderItems.push(itemData);
        } else {
            const modelDisplay = await processItemModelDisplay({
                name: node.name,
                transform: worldTransform
            });
            if (modelDisplay) {
                (modelDisplay as any).transform = worldTransform;
                (modelDisplay as any).name = node.name;

                const uuid = generateUUID();
                (modelDisplay as any).uuid = uuid;
                (modelDisplay as any).groupId = currentGroupId;
                if (currentGroupId) {
                    const g = groups.get(currentGroupId);
                    if (g) g.children.push({ type: 'object', id: uuid });
                } else if ((node as any)._rootIndex !== undefined) {
                    sceneOrder.push({ rootIndex: (node as any)._rootIndex, type: 'object', id: uuid });
                }

                renderItems.push(modelDisplay);
            } else {
                const itemData: RenderItem = {
                    type: 'itemDisplay',
                    name: node.name,
                    transform: worldTransform,
                    nbt: node.nbt,
                    options: node.options,
                    brightness: node.brightness
                };

                const uuid = generateUUID();
                itemData.uuid = uuid;
                itemData.groupId = currentGroupId;
                if (currentGroupId) {
                    const g = groups.get(currentGroupId);
                    if (g) g.children.push({ type: 'object', id: uuid });
                } else if ((node as any)._rootIndex !== undefined) {
                    sceneOrder.push({ rootIndex: (node as any)._rootIndex, type: 'object', id: uuid });
                }

                renderItems.push(itemData);
            }
        }
    } else if (node.isTextDisplay) {
        // 텍스트 디스플레이는 향후 별도 로직으로 처리한다.
    }

    if (node.children) {
        const childPromises = node.children.map(child => processNode(child, worldTransform, currentGroupId));
        const childRenderItems = await Promise.all(childPromises);
        renderItems = renderItems.concat(childRenderItems.flat());
    }

    return renderItems;
}

function getTransparencyType(pixels: TexturePixelData) {
    const data = pixels.data;
    let hasAlpha = false;
    let hasIntermediateAlpha = false;
    for (let i = 3; i < data.length; i += 4) {
        const a = data[i];
        if (a < 255) {
            hasAlpha = true;
            if (a > 0) {
                hasIntermediateAlpha = true;
                break;
            }
        }
    }
    if (hasIntermediateAlpha) return 2; // Translucent
    if (hasAlpha) return 1; // Cutout
    return 0; // Opaque
}

// 메인 스레드에서 전송된 PBDE 프로젝트 데이터를 수신해 처리한다.
self.onmessage = async (e) => {
    const fileContent = e.data;
    if (typeof fileContent !== 'string') return; // 에셋 응답 메시지는 렌더링 로직에서 무시한다.

    resetWorkerCaches({ clearCanvas: true });
    initializeAssetProvider(workerAssetProvider);
    groups = new Map();
    sceneOrder = [];

    try {
        // 전달받은 PBDE 파일을 디코딩하고 JSON으로 변환한다.
        const decodedData = atob(fileContent);
        const uint8Array = new Uint8Array(decodedData.length);
        for (let i = 0; i < decodedData.length; i++) {
            uint8Array[i] = decodedData.charCodeAt(i);
        }
    const jsonData = JSON.parse(strFromU8(decompressSync(uint8Array)));

        // 렌더링에 필요한 필드만 남기도록 씬 트리를 단순화한다.
        const processedChildren = split_children(jsonData[0].children);

        const identityMatrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
        // 루트 자식 노드를 병렬로 처리해 렌더 항목을 구성한다.
        // 루트 노드에 순서 인덱스를 태깅한 뒤 병렬 처리한다.
        processedChildren.forEach((node: any, i: number) => { node._rootIndex = i; });
        const promises = processedChildren.map((node: any) => processNode(node, identityMatrix, null));
        const renderList: RenderItem[] = (await Promise.all(promises)).flat();
        // 루트 인덱스 기준으로 sceneOrder 정렬
        sceneOrder.sort((a, b) => a.rootIndex - b.rootIndex);

        // --- Atlas Generation Start ---
        let atlasInfo = null;
        try {
            const texturePaths = new Set<string>();
            for (const item of renderList) {
                if (item.type === 'blockDisplay' || item.type === 'itemDisplayModel') {
                    if (item.models) {
                        for (const model of item.models) {
                            for (const geom of model.geometries) {
                                if (geom.texPath) texturePaths.add(geom.texPath);
                            }
                        }
                    }
                }
            }

            if (texturePaths.size > 0) {
                const loadedTextures = [];
                const textureTypes = new Map();
                for (const path of texturePaths) {
                    try {
                        const pixels = await loadTexturePixels(path as string);
                        if (pixels) {
                            loadedTextures.push({ path, pixels });
                            textureTypes.set(path, getTransparencyType(pixels));
                        }
                    } catch (e) { /* ignore */ }
                }

                if (loadedTextures.length > 0) {
                    // Sort by height desc
                    loadedTextures.sort((a, b) => b.pixels.h - a.pixels.h);

                    const totalArea = loadedTextures.reduce((sum, t) => sum + t.pixels.w * t.pixels.h, 0);
                    let atlasW = Math.max(512, Math.pow(2, Math.ceil(Math.log2(Math.sqrt(totalArea)))));
                    const maxW = Math.max(...loadedTextures.map(t => t.pixels.w));
                    if (atlasW < maxW) atlasW = Math.pow(2, Math.ceil(Math.log2(maxW)));

                    let atlasH = 0;
                    const packed = new Map();
                    
                    let x = 0;
                    let y = 0;
                    let rowH = 0;

                    for (const t of loadedTextures) {
                        const w = t.pixels.w;
                        const h = t.pixels.h;
                        if (x + w > atlasW) {
                            x = 0;
                            y += rowH;
                            rowH = 0;
                        }
                        packed.set(t.path, { x, y, w, h });
                        x += w;
                        rowH = Math.max(rowH, h);
                    }
                    atlasH = y + rowH;
                    atlasH = Math.pow(2, Math.ceil(Math.log2(atlasH)));

                    const atlasData = new Uint8ClampedArray(atlasW * atlasH * 4);
                    for (const t of loadedTextures) {
                        const info = packed.get(t.path);
                        const src = t.pixels.data;
                        const { x, y, w, h } = info;
                        for (let r = 0; r < h; r++) {
                            const srcStart = r * w * 4;
                            const dstStart = ((y + r) * atlasW + x) * 4;
                            atlasData.set(src.subarray(srcStart, srcStart + w * 4), dstStart);
                        }
                    }

                    for (const item of renderList) {
                        if (item.type === 'blockDisplay' || item.type === 'itemDisplayModel') {
                            for (const model of item.models) {
                                for (const geom of model.geometries) {
                                    const info = packed.get(geom.texPath);
                                    if (info) {
                                        const { x, y, w, h } = info;
                                        for (let i = 0; i < geom.uvs.length; i += 2) {
                                            const u = geom.uvs[i];
                                            const v = geom.uvs[i+1];
                                            geom.uvs[i] = (u * w + x) / atlasW;
                                            geom.uvs[i+1] = (v * h + (atlasH - y - h)) / atlasH;
                                        }
                                        const type = textureTypes.get(geom.texPath);
                                        if (type === 2) {
                                            geom.texPath = '__ATLAS_TRANSLUCENT__';
                                        } else {
                                            geom.texPath = '__ATLAS__';
                                        }
                                    }
                                }
                                // geometryMeta에 추가 속성 주입 (onmessage 루프 내 renderList 처리 부분)
                                (model as any).blockProps = item.blockProps;
                                (model as any).itemDisplayType = item.itemDisplayType;
                            }
                        }
                    }

                    atlasInfo = {
                        width: atlasW,
                        height: atlasH,
                        data: atlasData
                    };
                }
            }
        } catch (e) {
            // console.warn('Atlas generation failed', e);
        }
        // --- Atlas Generation End ---

        const geometryItems: RenderItem[] = [];
        const otherItems: RenderItem[] = [];
        for (const item of renderList) {
            if (item.type === 'blockDisplay' || item.type === 'itemDisplayModel') {
                geometryItems.push(item);
            } else {
                otherItems.push(item);
            }
        }

        let totalPositions = 0;
        let totalNormals = 0;
        let totalUvs = 0;
        let totalIndices = 0;
        let totalVertices = 0;
        let itemId = 0;

        // 전체 버퍼 크기를 미리 계산해 단일 ArrayBuffer에 데이터를 적재한다.
        for (const item of geometryItems) {
            if (item.models) {
                for (const model of item.models) {
                    for (const geomData of model.geometries) {
                        totalPositions += geomData.positions.length;
                        totalNormals += geomData.normals.length;
                        totalUvs += geomData.uvs.length;
                        totalIndices += geomData.indices.length;
                        totalVertices += geomData.positions.length / 3;
                    }
                }
            }
        }

        const useUint32Indices = totalVertices > 65535;
        const indexElementSize = useUint32Indices ? 4 : 2;

        const posByteLength = totalPositions * 4;
        const normByteLength = totalNormals * 4;
        const uvByteLength = totalUvs * 4;
        const indicesByteLength = totalIndices * indexElementSize;

        const normByteOffset = posByteLength;
        const uvByteOffset = normByteOffset + normByteLength;
        const indicesByteOffset = uvByteOffset + uvByteLength;
        const totalByteLength = indicesByteOffset + indicesByteLength;

        const geometryBuffer = new SharedArrayBuffer(totalByteLength);
        const metadata = [];

        const posView = new Float32Array(geometryBuffer, 0, totalPositions);
        const normView = new Float32Array(geometryBuffer, normByteOffset, totalNormals);
        const uvView = new Float32Array(geometryBuffer, uvByteOffset, totalUvs);
        const indicesView = useUint32Indices
            ? new Uint32Array(geometryBuffer, indicesByteOffset, totalIndices)
            : new Uint16Array(geometryBuffer, indicesByteOffset, totalIndices);

        let posCursor = 0;
        let normCursor = 0;
        let uvCursor = 0;
        let indicesCursor = 0;

        // 개별 지오메트리 버퍼를 연속 메모리 공간에 복사한다.
        for (const item of geometryItems) {
            itemId++;
            if (item.models) {
                for (const model of item.models) {
                    const matrixArray = (Array.isArray(model.modelMatrix) || ArrayBuffer.isView(model.modelMatrix))
                        ? model.modelMatrix
                        : identityMatrix;

                    model.geometries.forEach((geomData, geomIndex) => {
                    const { positions, normals, uvs, indices } = geomData;

                    const posStart = posCursor;
                    const normStart = normCursor;
                    const uvStart = uvCursor;
                    const idxStart = indicesCursor;

                    posView.set(positions, posCursor);
                    posCursor += positions.length;

                    normView.set(normals, normCursor);
                    normCursor += normals.length;

                    uvView.set(uvs, uvCursor);
                    uvCursor += uvs.length;

                    indicesView.set(indices, indicesCursor);
                    indicesCursor += indices.length;

                    metadata.push({
                        itemId: itemId,
                        transform: item.transform,
                        modelMatrix: matrixArray,
                        geometryId: model.geometryId,
                        geometryIndex: geomIndex,
                        texPath: geomData.texPath,
                        tintHex: geomData.tintHex,
                        isItemDisplayModel: item.type === 'itemDisplayModel',
                        posByteOffset: posStart * 4,
                        posLen: positions.length,
                        normByteOffset: normByteOffset + normStart * 4,
                        normLen: normals.length,
                        uvByteOffset: uvByteOffset + uvStart * 4,
                        uvLen: uvs.length,
                        indicesByteOffset: indicesByteOffset + idxStart * indexElementSize,
                        indicesLen: indices.length,
                        uuid: item.uuid,
                        groupId: item.groupId,
                        name: (item as any).name ?? null,
                        blockProps: (model as any).blockProps || item.blockProps,
                        itemDisplayType: (model as any).itemDisplayType || item.displayType
                    });
                });
            }
        }
    }

        const metadataPayload = {
            geometries: metadata,
            otherItems: otherItems,
            useUint32Indices: useUint32Indices,
            atlas: atlasInfo,
            groups: groups,
            sceneOrder: sceneOrder.map(({ type, id }) => ({ type, id }))
        };

        // 메타데이터와 지오메트리 버퍼를 메인 스레드로 전송한다.
        self.postMessage({
            success: true,
            metadata: metadataPayload,
            geometryBuffer: geometryBuffer
        });

    } catch (error) {
        self.postMessage({
            success: false,
            error: 'Worker Error: ' + String(error) + '\nStack: ' + (error ? error.stack : 'No stack available')
        });
    } finally {
        resetWorkerCaches({ clearCanvas: true });
    }
};