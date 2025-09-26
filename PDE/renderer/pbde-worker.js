import * as pako from 'pako';
import * as THREE from 'three/webgpu';
// tintColor is not a module, so it can't be imported directly in the worker.
// The getTextureColor function will be manually included.

// --- Copied from tintColor.js ---
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

function getTextureColor(modelResourceLocation, textureLayer, tintindex) {
  try {
    const isBlockModel = modelResourceLocation.startsWith('block/');
    const modelName = modelResourceLocation.split('/').slice(1).join('/');

    if (textureLayer == null && tintindex == null) {
      return 0xffffff;
    }

    // Grass tint: for item models tint applies even without tintindex
    if (
      blocksUsingDefaultGrassColors.includes(modelName) &&
      (!isBlockModel || tintindex === 0)
    ) {
      return 0x7cbd6b;
    }

    // Foliage tint
    if (
      blocksUsingDefaultFoliageColors.includes(modelName) &&
      (!isBlockModel || tintindex === 0)
    ) {
      // net.minecraft.world.biome.FoliageColors.getDefaultColor()
      return 0x48b518;
    }

    if (modelName === 'birch_leaves' && (!isBlockModel || tintindex === 0)) {
      // net.minecraft.world.biome.FoliageColors.getBirchColor()
      return 0x80a755;
    }
    if (modelName === 'spruce_leaves' && (!isBlockModel || tintindex === 0)) {
      // net.minecraft.world.biome.FoliageColors.getSpruceColor()
      return 0x619961;
    }

    // lily_pad
    if (modelName === 'lily_pad') {
      // For block display it uses a different color than wiki item code mentions
      return 0x71c35c;
    }

    // Melon/Pumpkin stems by age
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

    // Attached stem
    if (
      ['block/attached_melon_stem', 'block/attached_pumpkin_stem'].includes(modelResourceLocation)
    ) {
      return 0xe0c71c;
    }

    // Redstone wire (dust) item/block default tint when face tintindex 0
    if (modelResourceLocation.startsWith('block/redstone_dust_') && tintindex === 0) {
      return 0x4b0000;
    }

    return 0xffffff;
  } catch {
    return 0xffffff;
  }
}

// --- Worker Asset Provider ---

const assetCache = new Map();
const requestPromises = new Map();
let requestIdCounter = 0;

const workerAssetProvider = {
    getAsset(assetPath) {
        if (assetCache.has(assetPath)) {
            return Promise.resolve(assetCache.get(assetPath));
        }

        if (requestPromises.has(assetPath)) {
            return requestPromises.get(assetPath);
        }

        const promise = new Promise((resolve, reject) => {
            const requestId = requestIdCounter++;
            self.postMessage({ type: 'requestAsset', path: assetPath, requestId });

            const listener = (e) => {
                if (e.data.type === 'assetResponse' && e.data.requestId === requestId) {
                    self.removeEventListener('message', listener);
                    if (e.data.success) {
                        assetCache.set(assetPath, e.data.content);
                        requestPromises.delete(assetPath);
                        resolve(e.data.content);
                    } else {
                        requestPromises.delete(assetPath);
                        reject(new Error(e.data.error));
                    }
                }
            };
            self.addEventListener('message', listener);
        });

        requestPromises.set(assetPath, promise);
        return promise;
    }
};

// --- Block Processor Logic (from block-processor.js) ---

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

function nsAndPathFromId(id, defaultNs = 'minecraft') {
    if (!id) return { ns: defaultNs, path: '' };
    const [nsMaybe, restMaybe] = id.includes(':') ? id.split(':', 2) : [defaultNs, id];
    return { ns: nsMaybe, path: restMaybe };
}

function modelIdToAssetPath(modelId) {
    const { ns, path } = nsAndPathFromId(modelId);
    return `assets/${ns}/models/${path}.json`;
}

function textureIdToAssetPath(texId) {
    const { ns, path } = nsAndPathFromId(texId);
    return `assets/${ns}/textures/${path}.png`;
}

function hasHardcodedBlockstate(p) {
    if (!p) return false;
    // Only beds and trapped chests have hardcoded blockstates
    return /(bed|trapped_chest)/i.test(p);
}

function isHardcodedModelPath(p) {
    if (!p) return false;
    return /(chest|conduit|shulker|bed|banner|sign|decorated_pot|creeper_head|dragon_head|piglin_head|zombie_head|shield|trident)/i.test(p);
}

function isHardcodedModelId(modelId) {
    const { path } = nsAndPathFromId(modelId);
    return isHardcodedModelPath(path);
}

function modelIdToHardcodedPath(modelId) {
    const { path } = nsAndPathFromId(modelId);
    return `hardcoded/models/${path}.json`;
}

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

async function loadModelJson(assetPath) {
    return await readJsonAsset(assetPath);
}

async function resolveModelTree(modelId, cache = new Map()) {
    if (cache.has(modelId)) return cache.get(modelId);
    // HACK: builtin/generated is not a real model file, but a marker for generated item models.
    // Intercept it and return a mock resolved model that can be processed by buildItemModelGeometryData.
    if (modelId && (modelId.endsWith('builtin/generated'))) {
        const resolved = {
            id: modelId,
            json: { parent: 'item/generated' },
            textures: {},
            elements: null,
            parentChain: ['item/generated'],
            texture_size: null,
            fromHardcoded: false,
        };
        cache.set(modelId, resolved);
        return resolved;
    }
    const hardcodedFirst = isHardcodedModelId(modelId);
    const assetsPath = modelIdToAssetPath(modelId);
    const hardcodedPath = modelIdToHardcodedPath(modelId);
    let json;
    let fromHardcoded = false;
    try {
        if (hardcodedFirst) {
            try {
                json = await loadModelJson(hardcodedPath);
                fromHardcoded = true;
            } catch (_) {
                json = await loadModelJson(assetsPath);
            }
        } else {
            json = await loadModelJson(assetsPath);
        }
    } catch (e) {
        // Attempt alternate non-standard directory 'models/items/' (some custom packs)
        try {
            const { path } = nsAndPathFromId(modelId);
            if (/^item\//.test(path)) {
                const alt = assetsPath.replace('/models/item/', '/models/items/');
                if (alt !== assetsPath) {
                    json = await loadModelJson(alt);
                }
            }
        } catch (e2) {
            // ignore fallback failure
        }
        if (!json) {
            cache.set(modelId, null);
            return null;
        }
    }

    let mergedTextures = { ...(json.textures || {}) };
    let textureSize = Array.isArray(json.texture_size) ? json.texture_size : null;
    let elements = json.elements || null;
    let parentChain = [];

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
        }
    }

    const resolved = { id: modelId, json, textures: mergedTextures, elements, parentChain, texture_size: textureSize, fromHardcoded };
    cache.set(modelId, resolved);
    return resolved;
}

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

function applyBlockstateRotation(matrix, rotX = 0, rotY = 0) {
    if (rotX === 0 && rotY === 0) return;
    const pivot = new THREE.Vector3(0.5, 0.5, 0.5);
    const t1 = new THREE.Matrix4().makeTranslation(-pivot.x, -pivot.y, -pivot.z);
    const t2 = new THREE.Matrix4().makeTranslation(pivot.x, pivot.y, pivot.z);
    // Note: In Minecraft blockstate, positive X rotation tilts the model toward the south (downward in +Z),
    // which corresponds to a negative rotation in our right-handed coordinate setup.
    // Using negative rotX here fixes facing up/down inversion seen in some block displays.
    const rx = new THREE.Matrix4().makeRotationX(THREE.MathUtils.degToRad(-rotX));
    const ry = new THREE.Matrix4().makeRotationY(THREE.MathUtils.degToRad(-rotY));
    const r = new THREE.Matrix4().multiply(rx).multiply(ry);
    const m = new THREE.Matrix4().multiply(t2).multiply(r).multiply(t1);
    matrix.premultiply(m);
}

function uvRotated(uv, rotation) {
    const r = ((rotation % 360) + 360) % 360;
    if (r === 0) return uv;
    if (r === 90) return [uv[3], uv[0], uv[1], uv[2]];
    if (r === 180) return [uv[2], uv[3], uv[0], uv[1]];
    if (r === 270) return [uv[1], uv[2], uv[3], uv[0]];
    return uv;
}

// 일부 하드코딩 모델(sign 등)은 texture_size(예: 32x32)를 정확히 적용해야 정상적인 UV 스케일이 됨.
// 기존에는 fromHardcoded 일 경우 texture_size 를 무시하여 표지판이 찌그러지는 문제가 있었음.
// 다른 하드코딩 블럭(침대/상자 등)에서는 texture_size 적용 시 UV 오류가 생겨서 기본 정책은 유지하고
// 예외 허용 목록(allow list)을 통해 필요한 모델만 texture_size 를 사용하도록 한다.
function shouldAllowHardcodedTextureSize(resolved) {
    if (!resolved || !resolved.id) return false;
    const id = resolved.id; // ex) minecraft:block/sign
    // sign / wall_sign / hanging_sign / standing variants 모두 포괄
    if (/([^:]*:)?block\/(?:.*_)?sign/.test(id)) return true;
    // 필요한 경우 추가 (예: 배너 등) -> if (/banner/.test(id)) return true;
    return false;
}

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

function flipUCorners(c) { return [c[1], c[0], c[3], c[2]]; }
function flipVCorners(c) { return [c[3], c[2], c[1], c[0]]; }

function pushQuad(buff, a, b, c, d, n, uvTL, uvTR, uvBR, uvBL) {
    const base = buff.positions.length / 3;
    buff.positions.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z, d.x, d.y, d.z);
    buff.normals.push(n.x, n.y, n.z, n.x, n.y, n.z, n.x, n.y, n.z, n.x, n.y, n.z);
    buff.uvs.push(uvTL[0], uvTL[1], uvTR[0], uvTR[1], uvBR[0], uvBR[1], uvBL[0], uvBL[1]);
    buff.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
}

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

async function buildBlockModelGeometryData(resolved, opts = undefined) {
    const elements = resolved.elements;
    if (!elements || elements.length === 0) return null;

    const buffers = new Map();
    const addBuffer = (texPath, tintHex) => {
        const key = `${texPath}|${tintHex >>> 0}`;
        if (!buffers.has(key)) buffers.set(key, { positions: [], normals: [], uvs: [], indices: [], texPath, tintHex });
        return buffers.get(key);
    };

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

            // If this is a banner model and the element is the flag, override tint with bannerColorHex
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
            // Use declared texture_size whenever explicit UVs are provided
            // 기본적으로 하드코딩된 모델(fromHardcoded)은 texture_size를 무시(기존 동작)하되,
            // 표지판과 같이 예외 허용 목록에 포함된 모델은 texture_size를 사용한다.
            const allowHardcodedTexSize = resolved.fromHardcoded && shouldAllowHardcodedTextureSize(resolved);
            const useTexSize = hasExplicitFaceUV && texSize && (!resolved.fromHardcoded || allowHardcodedTexSize);
            const uvScaleU = useTexSize ? texSize[0] : 16;
            const uvScaleV = useTexSize ? texSize[1] : 16;
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
                if (adj.rot) corners = uvRotated(corners, adj.rot);
                if (adj.flipU) corners = flipUCorners(corners);
                if (adj.flipV) corners = flipVCorners(corners);
            }
            pushQuad(buff, v.a, v.b, v.c, v.d, v.n, corners[0], corners[1], corners[2], corners[3]);
        }
    }

    return Array.from(buffers.values());
}

async function processBlockDisplay(item) {
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
            // If banner blockstate is missing from assets, synthesize a minimal one that points to the banner model
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
            // console.warn(`[Block] No matching model found for ${item.name} with props`, props);
            return null;
        }

        const allGeometryData = [];
        // Detect banner color from item.name like "red_banner" or "red_wall_banner" and map to tint
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
                // NOTE: Do NOT center block_display geometries. User requested only item_display (block-like) gets -0.5 shift.
                allGeometryData.push({
                    modelMatrix: modelMatrix.elements,
                    geometries: geometryData
                });
            }
        }

        if (allGeometryData.length > 0) {
            return {
                type: 'blockDisplay',
                models: allGeometryData
            };
        }

        return null;
    } catch (e) {
        // console.warn(`[Block] Failed to process block display for ${item.name}:`, e);
        return null;
    }
}

// ===================== Item Model Processing (Phase 1) =====================

// Caches for item definitions and generated geometry
const modelTreeCache = new Map(); // modelId -> resolved model tree
const itemDefinitionCache = new Map(); // itemName -> definition json (assets/minecraft/items/{name}.json)
const itemModelGeometryCache = new Map(); // modelId|tint -> geometryData array
const itemModelHasElementsCache = new Map(); // modelId -> boolean (true if model had elements)

function parseItemName(raw) {
    if (!raw) return { baseName: '', displayType: null };
    const base = raw.split('[')[0];
    let displayType = null;
    const m = raw.match(/\[(.*)\]/);
    if (m && m[1]) {
        for (const part of m[1].split(',')) {
            const [k, v] = part.split('=').map(s => s && s.trim());
            if (k === 'display') displayType = v || null;
        }
    }
    return { baseName: base, displayType };
}

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

function isBuiltinModel(resolved) {
    if (!resolved) return false;
    if (resolved.id.startsWith('builtin/')) return true;
    return resolved.parentChain.some(p => p.startsWith('builtin/'));
}

function extractLayer0Texture(resolved) {
    if (!resolved) return null;
    const textures = resolved.textures || {};
    const layer0 = textures.layer0 || textures.texture || null;
    if (!layer0) return null;
    return resolveTextureRef(layer0, textures);
}

// Build a simple generated-plane (front/back) geometry when model has no elements.
function buildGeneratedPlaneGeometry(texId) {
    if (!texId) return [];
    const texPath = textureIdToAssetPath(texId);
    // Quad thickness epsilon (rendered as two quads for front/back to avoid culling issues)
    const from = [0, 0, 0];
    const to = [16, 16, 0];
    const positionsFront = [ // CCW winding facing +Z
        0, 1, 0,  1, 1, 0,  1, 0, 0,  0, 0, 0
    ];
    const positionsBack = [ // CCW winding facing -Z
        0, 1, 0,  0, 0, 0,  1, 0, 0,  1, 1, 0
    ];
    const normalsFront = [0,0,1, 0,0,1, 0,0,1, 0,0,1];
    const normalsBack = [0,0,-1, 0,0,-1, 0,0,-1, 0,0,-1];
    const uvsFront = [0,1, 1,1, 1,0, 0,0];
    // Re-map back face UVs so the texture appears upright (not vertically flipped) when viewed from behind.
    // Vertex order for back face: TL, BL, BR, TR (positionsBack). Provide matching oriented UVs.
    const uvsBack  = [0,1, 0,0, 1,0, 1,1];
    const indices = [0,2,1, 0,3,2]; // Flipped winding order to compensate for negative scale matrix

    // Scale positions from unit to 16x16 block space (already normalized pipeline expects /16 later? -> Our block builder divides by 16.
    // For simplicity keep them in 0..1 here, consistent with block builder output that already expects divided coordinates.)
    // Compose combined geometry arrays
    function push(buffers, pos, nor, uvArr) {
        const base = buffers.positions.length / 3;
        buffers.positions.push(...pos);
        buffers.normals.push(...nor);
        buffers.uvs.push(...uvArr);
        for (let i = 0; i < indices.length; i++) buffers.indices.push(base + indices[i]);
    }

    const tintHex = 0xffffff;
    const buffer = { positions: [], normals: [], uvs: [], indices: [], texPath, tintHex };
    push(buffer, positionsFront, normalsFront, uvsFront);
    push(buffer, positionsBack, normalsBack, uvsBack);
    return [buffer];
}

// Builtin item special geometry: two full planes (front/back) plus side faces only along outer opaque pixel border.
// 성능 최적화:
// 1) 이미지 디코딩 & 픽셀 읽기(loadTexturePixels) 1회로 공유
// 2) 경계 픽셀 계산 결과 캐시
// 3) 일정 개수(임계치) 이상 아이템이 있을 경우 Fast Mode 로 전환하여 경계 돌출을 생략하고 단순 평면만 생성
const BUILTIN_ITEM_DEPTH = 1/16; // total thickness between planes (adjust if too thick)
const builtinBorderGeometryCache = new Map(); // texPath -> geometry array
const texturePixelCache = new Map(); // texPath -> { w,h,data (Uint8ClampedArray) }
const texturePixelPromises = new Map(); // texPath -> promise
const textureBoundaryCache = new Map(); // texPath -> Set(index) of boundary pixels

let FAST_ITEM_MODEL_MODE = false; // large batch shortcut
const FAST_ITEM_MODEL_THRESHOLD = 300; // configurable threshold

async function loadTexturePixels(texPath) {
    if (texturePixelCache.has(texPath)) return texturePixelCache.get(texPath);
    if (texturePixelPromises.has(texPath)) return texturePixelPromises.get(texPath);
    const p = (async () => {
        try {
            const asset = await workerAssetProvider.getAsset(texPath);
            let bytes;
            if (asset instanceof Uint8Array) bytes = asset; else if (asset && typeof asset === 'object' && asset.type === 'Buffer' && Array.isArray(asset.data)) bytes = new Uint8Array(asset.data); else if (typeof asset === 'string') {
                bytes = new Uint8Array(asset.length); for (let i=0;i<asset.length;i++) bytes[i] = asset.charCodeAt(i) & 0xff;
            } else return null;
            const blob = new Blob([bytes], { type: 'image/png' });
            const bmp = await createImageBitmap(blob);
            const w = bmp.width, h = bmp.height;
            if (!w || !h) return null;
            // Reuse single OffscreenCanvas (resize as needed)
            if (!loadTexturePixels._canvas) loadTexturePixels._canvas = new OffscreenCanvas(w, h);
            const canvas = loadTexturePixels._canvas;
            if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
            const ctx = canvas.getContext('2d');
            ctx.clearRect(0,0,w,h);
            ctx.drawImage(bmp, 0, 0);
            const data = ctx.getImageData(0,0,w,h).data; // Uint8ClampedArray
            const record = { w, h, data };
            texturePixelCache.set(texPath, record);
            return record;
        } catch (e) {
            try { console.warn('[ItemModel] loadTexturePixels failed', texPath, e); } catch {}
            return null;
        } finally {
            texturePixelPromises.delete(texPath);
        }
    })();
    texturePixelPromises.set(texPath, p);
    return p;
}

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

async function buildBuiltinBorderBetweenPlanesGeometry(texId) {
    if (!texId) return [];
    const texPath = textureIdToAssetPath(texId);
    if (FAST_ITEM_MODEL_MODE) {
        // Fast mode: skip expensive boundary extrusion
        return buildGeneratedPlaneGeometry(texId);
    }
    if (builtinBorderGeometryCache.has(texPath)) return builtinBorderGeometryCache.get(texPath);
    try {
        const px = await loadTexturePixels(texPath);
        if (!px) return buildGeneratedPlaneGeometry(texId);
        const { w, h } = px;
        if (!w || !h) return buildGeneratedPlaneGeometry(texId);
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
            indices.push(base, base+2, base+1, base, base+3, base+2); // flipped winding
        };
        const dz = BUILTIN_ITEM_DEPTH / 2;
        // Front plane
        pushQuad([0,1,dz, 0,0,dz, 1,0,dz, 1,1,dz],[0,0,1],[0,1, 0,0, 1,0, 1,1]);
        // Back plane
        pushQuad([0,1,-dz, 1,1,-dz, 1,0,-dz, 0,0,-dz],[0,0,-1],[0,1, 1,1, 1,0, 0,0]);
        if (boundary && boundary.size) {
            for (const idx of boundary) {
                const y = Math.floor(idx / w);
                const x = idx - y*w;
                const x0 = x / w; const x1 = (x+1)/w;
                const yTop = 1 - y / h; const yBot = 1 - (y+1)/h;
                const u0 = x0; const u1 = x1; const v0 = yBot; const v1 = yTop;
                // West
                if (!opaque(x-1,y)) {
                    pushQuad([x0,yTop,dz, x0,yTop,-dz, x0,yBot,-dz, x0,yBot,dz],[1,0,0],[u1,v1, u0,v1, u0,v0, u1,v0]);
                }
                // East
                if (!opaque(x+1,y)) {
                    pushQuad([x1,yTop,-dz, x1,yTop,dz, x1,yBot,dz, x1,yBot,-dz],[-1,0,0],[u0,v1, u1,v1, u1,v0, u0,v0]);
                }
                // Top
                if (!opaque(x,y-1)) {
                    pushQuad([x0,yTop,dz, x1,yTop,dz, x1,yTop,-dz, x0,yTop,-dz],[0,1,0],[u0,v1, u1,v1, u1,v0, u0,v0]);
                }
                // Bottom
                if (!opaque(x,y+1)) {
                    pushQuad([x0,yBot,-dz, x1,yBot,-dz, x1,yBot,dz, x0,yBot,dz],[0,-1,0],[u0,v1, u1,v1, u1,v0, u0,v0]);
                }
            }
        }
        const geom = [{ positions, normals, uvs, indices, texPath, tintHex: 0xffffff }];
        builtinBorderGeometryCache.set(texPath, geom);
        return geom;
    } catch (e) {
        try { console.warn('[ItemModel] builtin border geometry failed for', texPath, e); } catch {}
        return buildGeneratedPlaneGeometry(texId);
    }
}

// Extrude only boundary (outer) opaque pixels of a 2D item texture into thin 3D voxels for a rim effect.
const EXTRUDE_ITEM_DEPTH = 1/16; // Thickness along Z
const extrudedItemGeometryCache = new Map(); // texPath -> geometry array
async function buildExtrudedBoundaryGeometry(texId) {
    if (!texId) return [];
    const texPath = textureIdToAssetPath(texId);
    if (extrudedItemGeometryCache.has(texPath)) return extrudedItemGeometryCache.get(texPath);
    try {
        const asset = await workerAssetProvider.getAsset(texPath);
        let bytes;
        if (asset instanceof Uint8Array) bytes = asset; else if (asset && typeof asset === 'object' && asset.type === 'Buffer' && Array.isArray(asset.data)) bytes = new Uint8Array(asset.data); else if (typeof asset === 'string') {
            // Fallback string decode (may not be raw binary but attempt)
            bytes = new Uint8Array(asset.length); for (let i=0;i<asset.length;i++) bytes[i] = asset.charCodeAt(i) & 0xff;
        } else return [];
        const blob = new Blob([bytes], { type: 'image/png' });
        const bmp = await createImageBitmap(blob);
        const w = bmp.width, h = bmp.height;
        if (!w || !h) return [];
        const canvas = new OffscreenCanvas(w, h);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(bmp, 0, 0);
        const data = ctx.getImageData(0,0,w,h).data;
        const isOpaque = (x,y) => {
            if (x < 0 || y < 0 || x >= w || y >= h) return false;
            return data[(y*w + x)*4 + 3] > 0;
        };
        const positions = [];
        const normals = [];
        const uvs = [];
        const indices = [];
        const pushQuad = (vx, vy, vz, nx, ny, nz, uvArr) => {
            const base = positions.length / 3;
            positions.push(...vx);
            for (let i=0;i<4;i++) normals.push(nx, ny, nz);
            uvs.push(...uvArr);
            indices.push(base, base+1, base+2, base, base+2, base+3);
        };
        const depth = EXTRUDE_ITEM_DEPTH / 2;
        // Pass 1: merged horizontal strips for front/back
        for (let y=0; y<h; y++) {
            let runStart = -1;
            for (let x=0; x<=w; x++) { // include sentinel at w
                const opaque = x < w && isOpaque(x,y);
                if (opaque && runStart === -1) {
                    runStart = x;
                } else if ((!opaque || x === w) && runStart !== -1) {
                    const runEnd = x; // exclusive
                    const x0 = runStart / w; const x1 = runEnd / w;
                    const yTop = 1 - y / h; const yBot = 1 - (y+1)/h;
                    const zF = depth; const zB = -depth;
                    const u0 = x0; const u1 = x1; const vTop = yTop; const vBot = yBot;
                    const stripUV = [u0,vTop, u1,vTop, u1,vBot, u0,vBot];
                    // Front strip
                    pushQuad([
                        x0,yTop,zF,  x1,yTop,zF,  x1,yBot,zF,  x0,yBot,zF
                    ], null, null, 0,0,1, stripUV);
                    // Back strip
                    pushQuad([
                        x1,yTop,zB,  x0,yTop,zB,  x0,yBot,zB,  x1,yBot,zB
                    ], null, null, 0,0,-1, stripUV);
                    runStart = -1;
                }
            }
        }

        // Pass 2: boundary side faces (unchanged logic, but without per-pixel front/back duplication)
        for (let y=0; y<h; y++) {
            for (let x=0; x<w; x++) {
                if (!isOpaque(x,y)) continue;
                const boundary = (!isOpaque(x-1,y) || !isOpaque(x+1,y) || !isOpaque(x,y-1) || !isOpaque(x,y+1));
                if (!boundary) continue;
                const x0 = x / w; const x1 = (x+1)/w;
                const yTop = 1 - y / h; const yBot = 1 - (y+1)/h;
                const zF = depth; const zB = -depth;
                const u0 = x0; const u1 = x1; const vTop = yTop; const vBot = yBot;
                if (!isOpaque(x-1,y)) {
                    pushQuad([
                        x0,yTop,zB, x0,yTop,zF, x0,yBot,zF, x0,yBot,zB
                    ], null, null, -1,0,0, [u0,vTop, u0,vTop, u0,vBot, u0,vBot]);
                }
                if (!isOpaque(x+1,y)) {
                    pushQuad([
                        x1,yTop,zF, x1,yTop,zB, x1,yBot,zB, x1,yBot,zF
                    ], null, null, 1,0,0, [u1,vTop, u1,vTop, u1,vBot, u1,vBot]);
                }
                if (!isOpaque(x,y-1)) {
                    pushQuad([
                        x0,yTop,zB, x1,yTop,zB, x1,yTop,zF, x0,yTop,zF
                    ], null, null, 0,1,0, [u0,vTop, u1,vTop, u1,vTop, u0,vTop]);
                }
                if (!isOpaque(x,y+1)) {
                    pushQuad([
                        x0,yBot,zF, x1,yBot,zF, x1,yBot,zB, x0,yBot,zB
                    ], null, null, 0,-1,0, [u0,vBot, u1,vBot, u1,vBot, u0,vBot]);
                }
            }
        }
        const geom = [{ positions, normals, uvs, indices, texPath, tintHex: 0xffffff }];
        extrudedItemGeometryCache.set(texPath, geom);
        return geom;
    } catch (e) {
        try { console.warn('[ItemModel] extrude failed, fallback plane', texPath, e); } catch {}
        return buildGeneratedPlaneGeometry(texId);
    }
}

// Builtin / generated pixel-bounds cube: analyze alpha bounding box to size the cube.
async function buildBuiltinPixelBoundsCubeGeometry(texId) {
    if (!texId) return [];
    const texPath = textureIdToAssetPath(texId);
    try {
        const px = await loadTexturePixels(texPath);
        if (!px) return buildFallbackFullCube(texPath);
        const { w, h, data } = px;
        if (!w || !h) return buildFallbackFullCube(texPath);
        let minX=w, minY=h, maxX=-1, maxY=-1;
        for (let y=0;y<h;y++) {
            for (let x=0;x<w;x++) {
                const a = data[(y*w+x)*4+3];
                if (a>0) {
                    if (x<minX) minX=x; if (y<minY) minY=y; if (x>maxX) maxX=x; if (y>maxY) maxY=y;
                }
            }
        }
        if (maxX<minX || maxY<minY) return buildFallbackFullCube(texPath);
        const rectW=(maxX-minX+1)/w, rectH=(maxY-minY+1)/h; const size=Math.max(rectW, rectH);
        const centerX=(minX+maxX+1)/2/w, centerY=(minY+maxY+1)/2/h;
        const x0=centerX-size/2, x1=centerX+size/2, y0=centerY-size/2, y1=centerY+size/2; const z0=0, z1=size;
        const u0=minX/w, v0=1-(maxY+1)/h, u1=(maxX+1)/w, v1=1-minY/h;
        const faceUV=[u0,v1,u1,v1,u1,v0,u0,v0];
        const positions=[], normals=[], uvs=[], indices=[];
        const addFace=(verts, normal, uv)=>{ const base=positions.length/3; positions.push(...verts); for(let i=0;i<4;i++) normals.push(...normal); uvs.push(...uv); indices.push(base,base+1,base+2,base,base+2,base+3); };
        addFace([x0,y1,z1, x1,y1,z1, x1,y0,z1, x0,y0,z1],[0,0,1],faceUV); // front
        addFace([x1,y1,z0, x0,y1,z0, x0,y0,z0, x1,y0,z0],[0,0,-1],faceUV); // back
        addFace([x0,y1,z0, x0,y1,z1, x0,y0,z1, x0,y0,z0],[-1,0,0],faceUV); // left
        addFace([x1,y1,z1, x1,y1,z0, x1,y0,z0, x1,y0,z1],[1,0,0],faceUV); // right
        addFace([x0,y1,z0, x1,y1,z0, x1,y1,z1, x0,y1,z1],[0,1,0],faceUV); // top
        addFace([x0,y0,z1, x1,y0,z1, x1,y0,z0, x0,y0,z0],[0,-1,0],faceUV); // bottom
        return [{ positions, normals, uvs, indices, texPath, tintHex: 0xffffff }];
    } catch (e) { try { console.warn('[ItemModel] builtin pixel-bounds fallback', texPath, e); } catch {} return buildFallbackFullCube(texPath); }
}

function buildFallbackFullCube(texPath) {
    const positions=[], normals=[], uvs=[], indices=[]; const fullUV=[0,1,1,1,1,0,0,0];
    const addFace=(verts, normal)=>{ const base=positions.length/3; positions.push(...verts); for(let i=0;i<4;i++) normals.push(...normal); uvs.push(...fullUV); indices.push(base,base+1,base+2,base,base+2,base+3); };
    addFace([0,1,1,1,1,1,1,0,1,0,0,1],[0,0,1]);
    addFace([1,1,0,0,1,0,0,0,0,1,0,0],[0,0,-1]);
    addFace([0,1,0,0,1,1,0,0,1,0,0,0],[-1,0,0]);
    addFace([1,1,1,1,1,0,1,0,0,1,0,1],[1,0,0]);
    addFace([0,1,0,1,1,0,1,1,1,0,1,1],[0,1,0]);
    addFace([0,0,1,1,0,1,1,0,0,0,0,0],[0,-1,0]);
    return [{ positions, normals, uvs, indices, texPath, tintHex: 0xffffff }];
}

async function buildItemModelGeometryData(resolved) {
    if (!resolved) return null;
    if (resolved.elements && resolved.elements.length > 0) {
        return await buildBlockModelGeometryData(resolved);
    }
    // generated / builtin cases: revert to simple flat front/back quad (no extrusion, no pixel-bounds cube)
    const layer0 = extractLayer0Texture(resolved);
    if (!layer0) return null;
    // Heuristic: treat true builtin OR classic generated/handheld parents as needing border geometry
    const useBorder = isBuiltinModel(resolved) || resolved.parentChain.some(p => /item\/(generated|handheld)/.test(p));
    if (useBorder) {
        if (FAST_ITEM_MODEL_MODE) {
            // Fast mode: skip expensive border building
            return buildGeneratedPlaneGeometry(layer0);
        }
        try { console.log('[ItemModel] using builtin border geometry for', resolved.id); } catch {}
        return await buildBuiltinBorderBetweenPlanesGeometry(layer0);
    }
    return buildGeneratedPlaneGeometry(layer0);
}

async function processItemModelDisplay(node) {
    try {
        const { baseName, displayType } = parseItemName(node.name);
        if (!baseName) return null;
        try { console.log('[ItemModel] start', node.name, 'base', baseName); } catch {}
        const definition = await loadItemDefinition(baseName);
        let modelId;
        let tintList = null;
        if (definition && definition.model) {
            if (typeof definition.model === 'string') {
                modelId = definition.model;
            } else if (definition.model && typeof definition.model === 'object') {
                // Expected shape: { type: 'minecraft:model', model: 'minecraft:block/grass_block', tints: [...] }
                modelId = definition.model.model || `minecraft:item/${baseName}`;
                if (Array.isArray(definition.model.tints)) tintList = definition.model.tints.slice();
            }
        }
        if (!modelId) modelId = `minecraft:item/${baseName}`;
        try { console.log('[ItemModel] definition', definition ? 'yes' : 'no', 'modelId', modelId, 'tints', tintList ? tintList.length : 0); } catch {}
        const cacheKey = modelId;
        let geomData = itemModelGeometryCache.get(cacheKey);
        let hasElements = itemModelHasElementsCache.get(cacheKey) || false;
        if (!geomData) {
            const resolved = await resolveModelTree(modelId, modelTreeCache);
            if (!resolved) {
                try { console.warn('[ItemModel] resolve failed', modelId); } catch {}
                return null;
            }
            hasElements = !!(resolved.elements && resolved.elements.length > 0);
            try { console.log('[ItemModel] resolved', modelId, 'elements', hasElements ? resolved.elements.length : 0, 'parent', resolved.parent || 'none'); } catch {}
            geomData = await buildItemModelGeometryData(resolved);
            if (geomData && geomData.length) {
                itemModelGeometryCache.set(cacheKey, geomData);
                itemModelHasElementsCache.set(cacheKey, hasElements);
            }
        }
        if (!geomData || geomData.length === 0) {
            try { console.warn('[ItemModel] empty geometry', modelId); } catch {}
            return null;
        }
        try { console.log('[ItemModel] geometry buffers', geomData.length, 'for', modelId, 'hasElements', hasElements); } catch {}
        const modelMatrix = new THREE.Matrix4();
        if (hasElements) {
            // Block-like item model: shift to center only (no rotation)
            modelMatrix.multiply(new THREE.Matrix4().makeTranslation(-0.5, -0.5, -0.5));
            try { console.log('[ItemModel] applied block-like centering', modelId); } catch {}
        } else {
            // Flat item: center only (no Y180) so front (+Z) plane remains facing camera; previous Y180 caused front/back inversion.
            const translateCenter = new THREE.Matrix4().makeTranslation(-0.5, -0.5, 0);
            modelMatrix.multiply(translateCenter);
            // Apply horizontal flip
            modelMatrix.premultiply(new THREE.Matrix4().makeScale(-1, 1, 1));
            try { console.log('[ItemModel] applied flat full centering and horizontal flip', modelId); } catch {}
        }
        return {
            type: 'itemDisplayModel',
            name: baseName,
            originalName: node.name,
            displayType: displayType || null,
            tints: tintList || null,
            models: [{ modelMatrix: modelMatrix.elements.slice(), geometries: geomData }],
            transform: node.transform || node.transforms || null
        };
    } catch (e) {
        try { console.warn('[ItemModel] error', node.name, e); } catch {}
        return null;
    }
}

// --- Original Worker Logic ---

function apply_transforms(parent, child) {
    const result = new Array(16);
    for (let i = 0; i < 4; i++) {
        for (let j = 0; j < 4; j++) {
            result[i * 4 + j] =
                parent[i * 4 + 0] * child[0 + j] +
                parent[i * 4 + 1] * child[4 + j] +
                parent[i * 4 + 2] * child[8 + j] +
                parent[i * 4 + 3] * child[12 + j];
        }
    }
    return result;
}

function split_children(children) {
    if (!children) return [];
    return children.map(item => {
        const newItem = {};

        // 조건 1: 특정 display 키 포함
        if (item.isCollection) newItem.isCollection = true;
        if (item.isItemDisplay) newItem.isItemDisplay = true;
        if (item.isBlockDisplay) newItem.isBlockDisplay = true;
        if (item.isTextDisplay) newItem.isTextDisplay = true;

        // 조건 2: name, nbt 항상 포함
        newItem.name = item.name || "";
        newItem.nbt = item.nbt || "";

        // 조건 3: brightness 조건부 포함
        if (item.brightness && (item.brightness.sky !== 15 || item.brightness.block !== 0)) {
            newItem.brightness = item.brightness;
        }

        // 조건 4: tagHead, options, paintTexture, textureValueList 조건부 포함
        if (item.tagHead) newItem.tagHead = item.tagHead;
        if (item.options) newItem.options = item.options;
        if (item.paintTexture) newItem.paintTexture = item.paintTexture;
        if (item.textureValueList) newItem.textureValueList = item.textureValueList;



        // 조건 5: transforms 항상 포함
        newItem.transforms = item.transforms || "";

        // 조건 6: children 재귀적 포함
        if (item.children) {
            newItem.children = split_children(item.children);
        }
        //console.log("split_children 결과:", JSON.stringify(newItem, null, 2));
        return newItem;
    });
}

async function processNode(node, parentTransform) {
    const worldTransform = apply_transforms(parentTransform, node.transforms);
    let renderItems = [];

    if (node.isBlockDisplay) {
        const modelData = await processBlockDisplay(node);
        if (modelData) {
            modelData.transform = worldTransform; // Assign the calculated world transform
            renderItems.push(modelData);
        }
    } else if (node.isItemDisplay) {
        // Player head special-case (existing behavior)
        if (node.name.toLowerCase().startsWith('player_head')) {
            const itemData = {
                type: 'itemDisplay',
                name: node.name,
                transform: worldTransform,
                nbt: node.nbt,
                options: node.options,
                brightness: node.brightness
            };
            let textureUrl = null;
            const defaultTextureValue = 'http://textures.minecraft.net/texture/d94e1686adb67823c7e5148c2c06e2d95c1b66374409e96b32dc1310397e1711';
            if (node.tagHead && node.tagHead.Value) {
                try {
                    textureUrl = JSON.parse(atob(node.tagHead.Value)).textures.SKIN.url;
                } catch (err) { /* ignore */ }
            } else if (node.paintTexture) {
                textureUrl = node.paintTexture.startsWith('data:image') ? node.paintTexture : `data:image/png;base64,${node.paintTexture}`;
            }
            itemData.textureUrl = textureUrl || defaultTextureValue;
            renderItems.push(itemData);
        } else {
            const modelDisplay = await processItemModelDisplay({
                name: node.name,
                transform: worldTransform
            });
            if (modelDisplay) {
                modelDisplay.transform = worldTransform;
                renderItems.push(modelDisplay);
            } else {
                // Fallback placeholder (maintain previous cube fallback path via simple itemDisplay object)
                renderItems.push({
                    type: 'itemDisplay',
                    name: node.name,
                    transform: worldTransform,
                    nbt: node.nbt,
                    options: node.options,
                    brightness: node.brightness
                });
            }
        }
    } else if (node.isTextDisplay) {
        // Future: handle text display
    }

    if (node.children) {
        const childPromises = node.children.map(child => processNode(child, worldTransform));
        const childRenderItems = await Promise.all(childPromises);
        renderItems = renderItems.concat(childRenderItems.flat());
    }

    return renderItems;
}

self.onmessage = async (e) => {
    // Clear all caches to prevent memory leaks between processing different files
    assetCache.clear();
    requestPromises.clear();
    modelTreeCache.clear();
    itemDefinitionCache.clear();
    itemModelGeometryCache.clear();
    itemModelHasElementsCache.clear();
    builtinBorderGeometryCache.clear();
    extrudedItemGeometryCache.clear();
    texturePixelCache.clear();
    textureBoundaryCache.clear();
    FAST_ITEM_MODEL_MODE = false; // reset each task

    const fileContent = e.data;
    if (typeof fileContent !== 'string') return; // Ignore asset responses

    initializeAssetProvider(workerAssetProvider);

    try {
        const decodedData = atob(fileContent);
        const uint8Array = new Uint8Array(decodedData.length);
        for (let i = 0; i < decodedData.length; i++) {
            uint8Array[i] = decodedData.charCodeAt(i);
        }
        const inflatedData = pako.inflate(uint8Array, { to: 'string' });
        const jsonData = JSON.parse(inflatedData);

        const processedChildren = split_children(jsonData[0].children);

        // 미리 itemDisplay 개수 세어 Fast Mode 여부 결정
        function countItemDisplays(list){
            if (!list) return 0; let c=0; for (const n of list){ if (n.isItemDisplay) c++; if (n.children) c+=countItemDisplays(n.children); } return c; }
        const itemCount = countItemDisplays(processedChildren);
        if (itemCount > FAST_ITEM_MODEL_THRESHOLD) {
            FAST_ITEM_MODEL_MODE = true;
            try { console.log('[ItemModel] FAST MODE ENABLED - item count', itemCount, 'threshold', FAST_ITEM_MODEL_THRESHOLD); } catch {}
        }
        
        const identityMatrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
        const promises = processedChildren.map(node => processNode(node, identityMatrix));
        const renderList = (await Promise.all(promises)).flat();

    self.postMessage({ success: true, data: renderList, fastMode: FAST_ITEM_MODEL_MODE, itemCount });

    } catch (error) {
        self.postMessage({
            success: false,
            error: 'Worker Error: ' + String(error) + '\nStack: ' + (error ? error.stack : 'No stack available')
        });
    }
};