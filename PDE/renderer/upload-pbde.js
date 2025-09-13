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

// ---- Blockstate/Model/Texture resolve helpers ----

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
    // when can be {prop: value|[values], ...} or { OR: [ ... ] } in some packs; we support basic object
    if (!when) return true;
    // If when has 'OR' array (non-standard in vanilla, but used sometimes), support a simple any-match
    if (Array.isArray(when)) {
        // Some syntaxes use array directly as OR of objects
        return when.some(w => whenMatches(w, props));
    }
    if (typeof when === 'object') {
        // Multi-condition AND
        for (const [k, v] of Object.entries(when)) {
            if (Array.isArray(v)) {
                if (!v.includes(props[k])) return false;
            } else {
                if ((props[k] || '') !== v) return false;
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

        // Collect candidate models from variants or multipart
        const modelIds = [];
        if (blockstate.variants) {
            // Find best-matching key
            // Try exact matches; if none, try empty key ""
            const entries = Object.entries(blockstate.variants);
            // Prefer keys with more conditions that match
            let best = null;
            for (const [key, val] of entries) {
                if (matchVariantKey(key, props)) {
                    const weight = key.split(',').filter(Boolean).length; // heuristic
                    if (!best || weight > best.weight) best = { key, val, weight };
                }
            }
            const picked = best ? best.val : blockstate.variants[''];
            if (picked) {
                if (Array.isArray(picked)) {
                    // Weighted list; pick the first for now
                    if (picked[0]?.model) modelIds.push(picked[0].model);
                } else if (picked.model) {
                    modelIds.push(picked.model);
                }
            }
        } else if (blockstate.multipart) {
            for (const part of blockstate.multipart) {
                if (!part) continue;
                if (!part.when || whenMatches(part.when, props)) {
                    const apply = part.apply;
                    if (Array.isArray(apply)) {
                        for (const a of apply) if (a?.model) modelIds.push(a.model);
                    } else if (apply?.model) {
                        modelIds.push(apply.model);
                    }
                }
            }
        }

        if (modelIds.length === 0) {
            //console.warn(`[Blockstate] No model resolved for ${item.name} (${item.blockstatePath})`);
            return;
        }

        // Resolve models and their textures
        const modelCache = new Map();
        for (const modelId of modelIds) {
            const resolved = await resolveModelTree(modelId, modelCache);
            if (!resolved) continue;
            const faceRefs = gatherFacesTextureRefs(resolved.elements);
            const concreteTextureIds = [];
            for (const ref of faceRefs) {
                const tid = resolveTextureRef(ref, resolved.textures);
                if (tid) concreteTextureIds.push(tid);
            }
            // Deduplicate and convert to asset paths
            const texAssetPaths = [...new Set(concreteTextureIds)].map(textureIdToAssetPath);
            //console.log(`[Model] ${item.name} uses model '${modelId}' with textures:`, texAssetPaths);

            // Optionally, load the first texture and apply to the mesh with entity material
            if (texAssetPaths.length > 0) {
                try {
                    const texResult = await window.ipcApi.getAssetContent(texAssetPaths[0]);
                    if (texResult.success) {
                        const blob = new Blob([texResult.content], { type: 'image/png' });
                        const url = URL.createObjectURL(blob);
                        const loader = new THREE.TextureLoader();
                        loader.load(url, (tex) => {
                            tex.magFilter = THREE.NearestFilter;
                            tex.minFilter = THREE.NearestFilter;
                            tex.colorSpace = THREE.SRGBColorSpace;
                            const matData = createEntityMaterial(tex);
                            // keep basic flags similar to item display setup
                            matData.material.toneMapped = false;
                            mesh.material = matData.material;
                            mesh.material.needsUpdate = true;
                            // cleanup temp url
                            URL.revokeObjectURL(url);
                        });
                    } else {
                        console.warn(`[Texture] Failed to load ${texAssetPaths[0]}: ${texResult.error}`);
                    }
                } catch (e) {
                    console.warn(`[Texture] Error while loading ${texAssetPaths[0]}:`, e);
                }
            }
        }
    } catch (e) {
        console.warn(`[Block] Failed to process block display assets for ${item.name}:`, e);
    }
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