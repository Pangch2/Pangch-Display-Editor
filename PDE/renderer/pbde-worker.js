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
    return /(chest|conduit|shulker|bed|banner)/i.test(p);
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
        // console.warn(`[Model] Missing or unreadable model ${modelId} at ${hardcodedFirst ? hardcodedPath : assetsPath}:`, e.message);
        cache.set(modelId, null);
        return null;
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
            // Use declared texture_size whenever explicit UVs are provided (including hardcoded models like banner)
            const useTexSize = hasExplicitFaceUV && !!texSize;
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
        const itemData = {
            type: 'itemDisplay',
            name: node.name,
            transform: worldTransform, // Use calculated world transform
            nbt: node.nbt,
            options: node.options,
            brightness: node.brightness
        };
        if (node.name.toLowerCase().startsWith('player_head')) {
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
        }
        renderItems.push(itemData);
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
        
        const identityMatrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
        const promises = processedChildren.map(node => processNode(node, identityMatrix));
        const renderList = (await Promise.all(promises)).flat();

        self.postMessage({ success: true, data: renderList });

    } catch (error) {
        self.postMessage({
            success: false,
            error: 'Worker Error: ' + String(error) + '\nStack: ' + (error ? error.stack : 'No stack available')
        });
    }
};