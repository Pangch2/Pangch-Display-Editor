import { openWithAnimation, closeWithAnimation } from './ui-open-close.js';
import * as THREE from 'three/webgpu';
import PbdeWorker from './pbde-worker.js?worker&inline';
import { createEntityMaterial } from './entityMaterial.js';


let worker;
// 로드된 모든 객체를 담을 그룹
const loadedObjectGroup = new THREE.Group();

export { loadedObjectGroup };


// 텍스처 로더 및 캐시
const textureLoader = new THREE.TextureLoader();
const textureCache = new Map();

// --- 최적화: 지오메트리 미리 생성 ---
let headGeometries = null;

/*블록디스플레이 시작 */

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

async function readJsonAsset(assetPath) {
    const result = await window.ipcApi.getAssetContent(assetPath);
    if (!result.success) throw new Error(`Asset read failed: ${assetPath}: ${result.error}`);
    const text = decodeIpcContentToString(result.content);
    return JSON.parse(text);
}

function blockNameToBaseAndProps(fullName) {
    // e.g., "minecraft:oak_log[axis=y]" -> baseName, props
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
    // id like "minecraft:block/stone" or "block/stone"
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

function resolveTextureRef(value, textures, guard = 0) {
    // resolves "#key" chains to final "namespace:path" form
    if (!value) return null;
    if (guard > 10) return value; // avoid infinite loops
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
    const path = modelIdToAssetPath(modelId);
    let json;
    try {
        json = await loadModelJson(path);
    } catch (e) {
        // Some blockstates may point to missing models; report and continue
        console.warn(`[Model] Missing or unreadable model ${modelId} at ${path}:`, e.message);
        cache.set(modelId, null);
        return null;
    }

    let mergedTextures = { ...(json.textures || {}) };
    let elements = json.elements || null;
    let parentChain = [];

    if (json.parent) {
        const parentRes = await resolveModelTree(json.parent, cache);
        if (parentRes) {
            // Parent textures first, then override with child
            mergedTextures = { ...(parentRes.textures || {}), ...(mergedTextures || {}) };
            // Child elements replace parent's unless absent
            elements = elements || parentRes.elements || null;
            parentChain = [...parentRes.parentChain, json.parent];
        }
    }

    const resolved = { id: modelId, json, textures: mergedTextures, elements, parentChain };
    cache.set(modelId, resolved);
    return resolved;
}

function matchVariantKey(variantKey, props) {
    // variantKey like "axis=y" or "facing=north,half=top" or ""
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
    // Supports vanilla multipart "when" semantics:
    // - Simple object: {prop: value | [values], ...} -> all must match (AND)
    // - { OR: [ obj1, obj2, ... ] } -> any matches
    // - { AND: [ obj1, obj2, ... ] } -> all match
    // Also supports a top-level array as an OR of objects for convenience.
    if (!when) return true;
    // Treat array as OR of subconditions
    if (Array.isArray(when)) {
        return when.some(w => whenMatches(w, props));
    }
    if (typeof when === 'object') {
        // Handle explicit OR / AND keys if present
        if (Array.isArray(when.OR)) {
            return when.OR.some(w => whenMatches(w, props));
        }
        if (Array.isArray(when.AND)) {
            return when.AND.every(w => whenMatches(w, props));
        }
        // Default: all entries must match
        for (const [key, value] of Object.entries(when)) {
            // Skip logical keys already handled above
            if (key === 'OR' || key === 'AND') continue;

            const propValue = props[key] || 'false'; // Treat missing prop as "false"
            const conditionValues = String(value).split('|');

            if (!conditionValues.includes(propValue)) {
                return false;
            }
        }
        return true;
    }
    return false;
}

function gatherFacesTextureRefs(elements) {
    const refs = new Set();
    if (!elements) return refs;
    for (const el of elements) {
        const faces = el.faces || {};
        for (const face of Object.values(faces)) {
            if (face && face.texture) refs.add(face.texture);
        }
    }
    return refs;
}

async function processBlockDisplayAssets(item, mesh) {
    try {
        const blockstate = await readJsonAsset(item.blockstatePath);
        const { props } = blockNameToBaseAndProps(item.name);
        const modelCache = new Map();

        let modelsToBuild = [];

        // 1. Determine models from 'variants' or 'multipart'
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
                // Per user request, ignore weight and pick the first model if multiple are present.
                if (applyList.length > 0) {
                    modelsToBuild.push(applyList[0]);
                }
            }

        } else if (blockstate.multipart) {
            for (const part of blockstate.multipart) {
                if (!part) continue;
                if (!part.when || whenMatches(part.when, props)) {
                    const applyList = Array.isArray(part.apply) ? part.apply : [part.apply];
                    // Per user request, ignore weight and pick the first model.
                    if (applyList.length > 0) {
                        modelsToBuild.push(applyList[0]);
                    }
                }
            }
        }

        if (modelsToBuild.length === 0) {
            console.warn(`[Block] No matching model found for ${item.name} with props`, props);
            return;
        }

        // 2. Build the final group from the collected models
        const finalGroup = new THREE.Group();
        for (const apply of modelsToBuild) {
            if (!apply?.model) continue;

            const resolved = await resolveModelTree(apply.model, modelCache);
            if (!resolved || !resolved.elements) continue;

            const modelGroup = await buildBlockModelGroup(resolved, { 
                uvlock: !!apply.uvlock, 
                xRot: apply.x || 0, 
                yRot: apply.y || 0 
            });

            if (modelGroup) {
                applyBlockstateRotation(modelGroup, apply.x || 0, apply.y || 0);
                finalGroup.add(modelGroup);
            }
        }

        // 3. Replace placeholder mesh with the new group
        if (finalGroup.children.length > 0) {
            finalGroup.matrixAutoUpdate = false;
            finalGroup.matrix.copy(mesh.matrix);
            finalGroup.castShadow = true;
            finalGroup.receiveShadow = true;
            
            const parent = mesh.parent;
            if (parent) {
                parent.add(finalGroup);
                parent.remove(mesh);
                mesh.geometry.dispose();
                if(mesh.material.map) mesh.material.map.dispose();
                mesh.material.dispose();
            }
        }

    } catch (e) {
        console.warn(`[Block] Failed to process block display assets for ${item.name}:`, e);
    }
}

function applyBlockstateRotation(group, rotX = 0, rotY = 0) {
    if (rotX === 0 && rotY === 0) return;

    const pivot = new THREE.Vector3(0.5, 0.5, 0.5);
    const t1 = new THREE.Matrix4().makeTranslation(-pivot.x, -pivot.y, -pivot.z);
    const t2 = new THREE.Matrix4().makeTranslation(pivot.x, pivot.y, pivot.z);
    // Minecraft's Y-axis rotation is clockwise, while Three.js's is counter-clockwise.
    // Negating the angle aligns them.
    const rx = new THREE.Matrix4().makeRotationX(THREE.MathUtils.degToRad(rotX));
    const ry = new THREE.Matrix4().makeRotationY(THREE.MathUtils.degToRad(-rotY));
    
    // Apply Y then X, which is standard for Minecraft
    const r = new THREE.Matrix4().multiply(ry).multiply(rx);
    const m = new THREE.Matrix4().multiply(t2).multiply(r).multiply(t1);
    
    group.updateMatrix();
    group.applyMatrix4(m);
}

function uvRotated(uv, rotation) {
    // uv: [[u0,v0],[u1,v1],[u2,v2],[u3,v3]] in TL,TR,BR,BL order baseline; rotation in degrees 0/90/180/270 CW
    const r = ((rotation % 360) + 360) % 360;
    if (r === 0) return uv;
    if (r === 90) return [uv[3], uv[0], uv[1], uv[2]];
    if (r === 180) return [uv[2], uv[3], uv[0], uv[1]];
    if (r === 270) return [uv[1], uv[2], uv[3], uv[0]];
    return uv;
}

// --- Minecraft vs Three.js UV alignment helpers ---
// Some Minecraft block faces may look rotated/flipped when compared to a default Three.js cube UV expectation.
// You can control each face below without touching the model building logic.
// - rot: additional rotation in degrees (0, 90, 180, 270) applied AFTER model/uvlock rotations
// - flipU: swaps left/right on the face UVs
// - flipV: swaps top/bottom on the face UVs
// Tweak these if you find a face looking mirrored or rotated compared to vanilla.
const FACE_UV_ADJUST = {
    // Front/back
    north: { rot: 180,   flipU: false, flipV: true },//west
    south: { rot: 0,   flipU: true,  flipV: false },//east
    // Left/right
    west:  { rot: 0,   flipU: true,  flipV: false },//south
    east:  { rot: 0,   flipU: true, flipV: false },//north
    // Top/bottom: swap U/V; adjust V so it increases southwards like MC
    up:    { rot: 90,  flipU: true, flipV: false  },//up
    down:  { rot: 90, flipU: false, flipV: true  },//down
};

function flipUCorners(c) {
    // TL,TR,BR,BL -> TR,TL,BL,BR
    return [c[1], c[0], c[3], c[2]];
}

function flipVCorners(c) {
    // TL,TR,BR,BL -> BL,BR,TR,TL
    return [c[3], c[2], c[1], c[0]];
}

function pushQuad(buff, a, b, c, d, n, uvTL, uvTR, uvBR, uvBL) {
    const base = buff.positions.length / 3;
    buff.positions.push(
        a.x, a.y, a.z,
        b.x, b.y, b.z,
        c.x, c.y, c.z,
        d.x, d.y, d.z
    );
    buff.normals.push(
        n.x, n.y, n.z,
        n.x, n.y, n.z,
        n.x, n.y, n.z,
        n.x, n.y, n.z
    );
    buff.uvs.push(
        uvTL[0], uvTL[1],
        uvTR[0], uvTR[1],
        uvBR[0], uvBR[1],
        uvBL[0], uvBL[1]
    );
    buff.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
}

function getFaceVertices(dir, from, to) {
    const x1 = from[0] / 16, y1 = from[1] / 16, z1 = from[2] / 16;
    const x2 = to[0] / 16,   y2 = to[1] / 16,   z2 = to[2] / 16;
    switch (dir) {
        case 'north': // -Z
            return {
                a: new THREE.Vector3(x1, y2, z1),
                b: new THREE.Vector3(x2, y2, z1),
                c: new THREE.Vector3(x2, y1, z1),
                d: new THREE.Vector3(x1, y1, z1),
                n: new THREE.Vector3(0, 0, -1)
            };
        case 'south': // +Z
            return {
                a: new THREE.Vector3(x2, y2, z2),
                b: new THREE.Vector3(x1, y2, z2),
                c: new THREE.Vector3(x1, y1, z2),
                d: new THREE.Vector3(x2, y1, z2),
                n: new THREE.Vector3(0, 0, 1)
            };
        case 'west': // -X
            return {
                a: new THREE.Vector3(x1, y2, z2),
                b: new THREE.Vector3(x1, y2, z1),
                c: new THREE.Vector3(x1, y1, z1),
                d: new THREE.Vector3(x1, y1, z2),
                n: new THREE.Vector3(-1, 0, 0)
            };
        case 'east': // +X
            return {
                a: new THREE.Vector3(x2, y2, z1),
                b: new THREE.Vector3(x2, y2, z2),
                c: new THREE.Vector3(x2, y1, z2),
                d: new THREE.Vector3(x2, y1, z1),
                n: new THREE.Vector3(1, 0, 0)
            };
        case 'up': // +Y
            return {
                a: new THREE.Vector3(x1, y2, z1),
                b: new THREE.Vector3(x1, y2, z2),
                c: new THREE.Vector3(x2, y2, z2),
                d: new THREE.Vector3(x2, y2, z1),
                n: new THREE.Vector3(0, 1, 0)
            };
        case 'down': // -Y
            return {
                a: new THREE.Vector3(x2, y1, z1),
                b: new THREE.Vector3(x2, y1, z2),
                c: new THREE.Vector3(x1, y1, z2),
                d: new THREE.Vector3(x1, y1, z1),
                n: new THREE.Vector3(0, -1, 0)
            };
    }
    return null;
}

async function buildBlockModelGroup(resolved, opts = undefined) {
    const elements = resolved.elements;
    if (!elements || elements.length === 0) return null;

    // buffers per textureAssetPath
    const buffers = new Map();
    const addBuffer = (texPath) => {
        if (!buffers.has(texPath)) buffers.set(texPath, { positions: [], normals: [], uvs: [], indices: [] });
        return buffers.get(texPath);
    };
    const usedTextures = new Set();

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
        const tNeg = new THREE.Matrix4();
        const tPos = new THREE.Matrix4();
        if (hasRot) {
            switch (rot.axis) {
                case 'x': rotOnly.makeRotationX(angleRad); break;
                case 'y': rotOnly.makeRotationY(angleRad); break;
                case 'z': rotOnly.makeRotationZ(angleRad); break;
                default: rotOnly.identity(); break;
            }
            tNeg.makeTranslation(-pivot.x, -pivot.y, -pivot.z);
            tPos.makeTranslation(pivot.x, pivot.y, pivot.z);

            rotMat.copy(tPos).multiply(rotOnly);

            if (rescale) {
                const scaleFactor = 1.0 / Math.cos(angleRad);
                const scaleMat = new THREE.Matrix4();
                if (rot.axis === 'x') {
                    scaleMat.makeScale(1, scaleFactor, scaleFactor);
                } else if (rot.axis === 'y') {
                    scaleMat.makeScale(scaleFactor, 1, scaleFactor);
                } else if (rot.axis === 'z') {
                    scaleMat.makeScale(scaleFactor, scaleFactor, 1);
                }
                rotMat.multiply(scaleMat);
            }
            
            rotMat.multiply(tNeg);
        } else {
            rotOnly.identity();
            rotMat.identity();
        }
        for (const dir of ['north','south','west','east','up','down']) {
            const face = faces[dir];
            if (!face || !face.texture) continue;
            const texId = resolveTextureRef(face.texture, resolved.textures);
            if (!texId) continue;
            const texAssetPath = textureIdToAssetPath(texId);
            usedTextures.add(texAssetPath);
            const buff = addBuffer(texAssetPath);
            const v = getFaceVertices(dir, from, to);
            if (!v) continue;

            let effectiveDir = dir;

            // Apply element rotation to vertices and normal
            if (hasRot) {
                v.a.applyMatrix4(rotMat);
                v.b.applyMatrix4(rotMat);
                v.c.applyMatrix4(rotMat);
                v.d.applyMatrix4(rotMat);
                const n3 = new THREE.Matrix3().setFromMatrix4(rotOnly);
                v.n.applyMatrix3(n3).normalize();

                const { x, y, z } = v.n;
                if      (Math.abs(x) > 0.99) effectiveDir = x > 0 ? 'east' : 'west';
                else if (Math.abs(y) > 0.99) effectiveDir = y > 0 ? 'up' : 'down';
                else if (Math.abs(z) > 0.99) effectiveDir = z > 0 ? 'south' : 'north';
            }

            let faceUV = face.uv;
            if (!faceUV) {
                switch (dir) {
                    case 'north':
                    case 'south':
                        faceUV = [from[0], from[1], to[0], to[1]];
                        break;
                    case 'west':
                    case 'east':
                        faceUV = [from[2], from[1], to[2], to[1]];
                        break;
                    case 'up':
                    case 'down':
                        faceUV = [from[0], from[2], to[0], to[2]];
                        break;
                    default:
                        faceUV = [0, 0, 16, 16];
                        break;
                }
            }

            // Compute uvlock-driven extra rotation once
            let extraUVRot = 0;
            if (opts && opts.uvlock) {
                const yRotNorm = ((opts.yRot || 0) % 360 + 360) % 360;
                const xRotNorm = ((opts.xRot || 0) % 360 + 360) % 360;
                if (dir === 'north' || dir === 'south' || dir === 'east' || dir === 'west') {
                    extraUVRot = Math.round(xRotNorm / 90) * 90;
                }
                if (dir === 'up' || dir === 'down') {
                    extraUVRot = -Math.round(yRotNorm / 90) * 90;
                }
            }

            // On up/down faces, adjust UV rect to match the geometry's texel extents based on final rotation.
            // Snap target sizes to even texel counts (2-unit steps) and anchor from the min edge (cut "backwards").
            if (dir === 'up' || dir === 'down') {
                const preAdjRot = (((face.rotation || 0) + extraUVRot) % 360 + 360) % 360;
                const geomW = Math.abs(to[0] - from[0]); // X extent in texels
                const geomH = Math.abs(to[2] - from[2]); // Z extent in texels
                let ux0 = faceUV[0], vy0 = faceUV[1], ux1 = faceUV[2], vy1 = faceUV[3];
                const uw = Math.abs(ux1 - ux0);
                const vh = Math.abs(vy1 - vy0);

                // When rotated 0/180: U maps to X (geomW), V maps to Z (geomH)
                // When rotated 90/270: U maps to Z (geomH), V maps to X (geomW)
                let uTarget = (preAdjRot === 0 || preAdjRot === 180) ? geomW : geomH;
                let vTarget = (preAdjRot === 0 || preAdjRot === 180) ? geomH : geomW;

                // Snap to even texel counts (2-unit steps)
                const snapEven = (t) => Math.max(0, Math.min(16, Math.round(t / 2) * 2));
                uTarget = snapEven(uTarget);
                vTarget = snapEven(vTarget);

                if (Math.abs(uw - uTarget) > 1e-6 || Math.abs(vh - vTarget) > 1e-6) {
                    // Anchor each axis to its min edge and extend in the original orientation
                    const uAsc = ux1 >= ux0; // orientation along U
                    const vAsc = vy1 >= vy0; // orientation along V
                    const uMin = Math.min(ux0, ux1);
                    const vMin = Math.min(vy0, vy1);

                    if (uAsc) { ux0 = uMin; ux1 = uMin + uTarget; }
                    else      { ux1 = uMin; ux0 = uMin + uTarget; }

                    if (vAsc) { vy0 = vMin; vy1 = vMin + vTarget; }
                    else      { vy1 = vMin; vy0 = vMin + vTarget; }

                    // Shift U into [0,16] without changing size
                    let uLo = Math.min(ux0, ux1), uHi = Math.max(ux0, ux1);
                    if (uLo < 0) { const s = -uLo; ux0 += s; ux1 += s; uLo = 0; uHi += s; }
                    if (uHi > 16) { const s = uHi - 16; ux0 -= s; ux1 -= s; }

                    // Shift V into [0,16] without changing size
                    let vLo = Math.min(vy0, vy1), vHi = Math.max(vy0, vy1);
                    if (vLo < 0) { const s = -vLo; vy0 += s; vy1 += s; vLo = 0; vHi += s; }
                    if (vHi > 16) { const s = vHi - 16; vy0 -= s; vy1 -= s; }

                    faceUV = [ux0, vy0, ux1, vy1];
                }
            }

            const uv = faceUV;
            const u0 = uv[0] / 16, v0 = 1 - uv[1] / 16;
            const u1 = uv[2] / 16, v1 = 1 - uv[3] / 16;
            let corners = [
                [u0, v0], // TL
                [u1, v0], // TR
                [u1, v1], // BR
                [u0, v1]  // BL
            ];

            const faceRot = ((face.rotation || 0) + extraUVRot) % 360;
            corners = uvRotated(corners, faceRot);

            const adj = FACE_UV_ADJUST[effectiveDir];
            if (adj) {
                if (adj.rot) corners = uvRotated(corners, adj.rot);
                if (adj.flipU) corners = flipUCorners(corners);
                if (adj.flipV) corners = flipVCorners(corners);
            }

            pushQuad(buff, v.a, v.b, v.c, v.d, v.n, corners[0], corners[1], corners[2], corners[3]);
        }
    }

    const group = new THREE.Group();
    // build meshes per texture and start async texture loading to swap materials
    for (const [texAssetPath, buff] of buffers.entries()) {
        const geom = new THREE.BufferGeometry();
        geom.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(buff.positions), 3));
        geom.setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array(buff.normals), 3));
        geom.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(buff.uvs), 2));
        geom.setIndex(buff.indices);
        geom.computeBoundingBox();
        geom.computeBoundingSphere();

        const placeholderTex = new THREE.DataTexture(new Uint8Array([255,255,255,255]), 1, 1);
        placeholderTex.needsUpdate = true;
        const { material } = createEntityMaterial(placeholderTex);
        material.toneMapped = false;

        const mesh = new THREE.Mesh(geom, material);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        group.add(mesh);

        // async load actual texture and replace material (crop to 16x16 if needed)
            (async () => {
                try {
                    const texResult = await window.ipcApi.getAssetContent(texAssetPath);
                    if (!texResult.success) {
                        console.warn(`[Texture] Failed to load ${texAssetPath}: ${texResult.error}`);
                        return;
                    }
                    const blob = new Blob([texResult.content], { type: 'image/png' });
                    const url = URL.createObjectURL(blob);
                    const loader = new THREE.TextureLoader();
                    loader.load(url, (tex) => {
                        const tex16 = cropTextureToFirst16(tex);
                        const matData = createEntityMaterial(tex16);
                        matData.material.toneMapped = false;
                        mesh.material = matData.material;
                        mesh.material.needsUpdate = true;
                        URL.revokeObjectURL(url);
                        if (tex16 !== tex) {
                            tex.dispose();
                        }
                    });
                } catch (e) {
                    console.warn(`[Texture] Error while loading ${texAssetPath}:`, e);
                }
            })();
    }

    return group;
}

/*블록디스플레이 끝 */

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
    
    // 1-1. 캐시된 텍스처 및 리소스 완벽 해제
    textureCache.forEach(cachedItem => {
        if (cachedItem && cachedItem instanceof THREE.Texture) {
            cachedItem.dispose();
        }
    });
    textureCache.clear();

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

    // 3. 워커로부터 메시지(처리된 데이터) 수신
    worker.onmessage = (e) => {
        console.log("[Debug] Message received from worker:", e.data);

        if (e.data.success) {
            const flatRenderList = e.data.data;
            
            if (!flatRenderList || flatRenderList.length === 0) {
                console.warn("[Debug] Worker returned success, but the render list is empty. Nothing to render.");
            } else {
                console.log(`[Debug] Processing ${flatRenderList.length} items from worker.`);
            }

            flatRenderList.forEach((item) => {
                if (item.isBlockDisplay) {
                    const geometry = new THREE.BoxGeometry(1, 1, 1);
                    geometry.translate(0.5, 0.5, 0.5);
                    // Placeholder 1x1 white texture for initial entity material
                    const placeholderTex = new THREE.DataTexture(new Uint8Array([255,255,255,255]), 1, 1);
                    placeholderTex.needsUpdate = true;
                    const { material: entityMat } = createEntityMaterial(placeholderTex);
                    entityMat.toneMapped = false;
                    const cube = new THREE.Mesh(geometry, entityMat);
                    cube.castShadow = true;
                    cube.receiveShadow = true;

                    const finalMatrix = new THREE.Matrix4();
                    finalMatrix.fromArray(item.transform);
                    finalMatrix.transpose();

                    cube.matrixAutoUpdate = false;
                    cube.matrix.copy(finalMatrix);

                    // 블록스테이트/모델/텍스처 해석 및 로그 출력 + 엔티티 머티리얼 텍스처 적용
                    if (item.blockstatePath) {
                        processBlockDisplayAssets(item, cube);
                    }

                    loadedObjectGroup.add(cube);
                } else if (item.isItemDisplay) {
                    if (item.textureUrl) {
                        const headGroup = new THREE.Group();
                        headGroup.userData.isPlayerHead = true;

                        const onTextureLoad = (texture) => {
                            // 변경점: base + layer 를 각각 추가하지 않고,
                            // 병합된 하나의 메시(merged geometry)만 추가해서 draw call 1회로 줄입니다.
                            headGroup.add(createOptimizedHeadMerged(texture));
                        };

                        if (textureCache.has(item.textureUrl)) {
                            const cached = textureCache.get(item.textureUrl);
                            if (cached instanceof THREE.Texture) {
                                onTextureLoad(cached);
                            } else {
                                cached.callbacks.push(onTextureLoad);
                            }
                        } else {
                            const loadingPlaceholder = { callbacks: [onTextureLoad] };
                            textureCache.set(item.textureUrl, loadingPlaceholder);

                            textureLoader.load(item.textureUrl, (texture) => {
                                textureCache.set(item.textureUrl, texture);
                                loadingPlaceholder.callbacks.forEach(cb => cb(texture));
                            }, undefined, (err) => {
                                console.error('텍스처 로드 실패:', err);
                                textureCache.delete(item.textureUrl);
                            });
                        }

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
            console.error("[Debug] Worker reported an error:", e.data.error);
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
        worker.postMessage(event.target.result);
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