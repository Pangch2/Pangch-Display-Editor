import { openWithAnimation, closeWithAnimation } from './ui-open-close.js';
import * as THREE from 'three/webgpu';
import { scene } from './renderer.js'; // renderer.js에서 scene을 export 해야 함

let worker;
// 로드된 모든 객체를 담을 그룹
const loadedObjectGroup = new THREE.Group();
scene.add(loadedObjectGroup);

//여기가 시작
// 텍스처 로더 및 캐시
const textureLoader = new THREE.TextureLoader();
const textureCache = new Map();
/**
 * 두 개의 4x4 행렬(1차원 배열)을 곱합니다.
 * @param {number[]} parent - 부모 행렬 (16개 요소)
 * @param {number[]} child - 자식 행렬 (16개 요소)
 * @returns {number[]} 결과 행렬 (16개 요소)
 */
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

/**
 * JSON 데이터의 children 배열을 순회하며 조건에 맞게 데이터를 필터링하고 정제합니다.
 * @param {Array} children - 원본 children 배열
 * @returns {Array} 처리된 children 배열
 */


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

/**
 * 재귀적으로 모델 계층을 순회하며 각 객체의 최종 월드 변환 행렬을 계산하여
 * 평탄화된 렌더링 목록을 생성합니다.
 * @param {Array} nodes - 처리할 노드 배열
 * @param {number[]} parentTransform - 부모의 월드 변환 행렬
 * @param {Array} renderList - 최종 렌더링 목록 (평탄화된 배열)
 */
function processNodesAndFlatten(nodes, parentTransform, renderList) {
    if (!nodes) return;

    for (const node of nodes) {
        // 노드의 로컬 변환 행렬과 부모의 월드 변환 행렬을 곱하여 현재 노드의 월드 변환 행렬을 계산합니다.
        const worldTransform = apply_transforms(parentTransform, node.transforms);

        // 렌더링이 필요한 객체만(isBlockDisplay 등) 최종 목록에 추가합니다.
        if (node.isBlockDisplay || node.isItemDisplay || node.isTextDisplay) {
            renderList.push({
                name: node.name,
                transform: worldTransform, // 최종 계산된 월드 변환 행렬
                nbt: node.nbt,
                isBlockDisplay: node.isBlockDisplay,
                isItemDisplay: node.isItemDisplay,
                isTextDisplay: node.isTextDisplay,
                tagHead: node.tagHead,
                options: node.options,
                paintTexture: node.paintTexture,
                textureValueList: node.textureValueList,
                brightness: node.brightness
            });
        }

        // 자식 노드가 있으면, 현재 계산된 월드 변환 행렬을 부모 행렬로 하여 재귀 호출합니다.
        if (node.children) {
            processNodesAndFlatten(node.children, worldTransform, renderList);
        }
    }
}
//여기까지

/**
 * WebGPU에 최적화된 마인크래프트 머리 모델을 생성합니다.
 * 단일 재질과 커스텀 UV를 사용하여 성능을 극대화합니다.
 * @param {THREE.Texture} texture - 64x64 머리 텍스처
 * @param {boolean} isLayer - 오버레이 레이어(모자)인지 여부
 * @returns {THREE.Mesh} 최적화된 머리 메시 객체
 */
function createOptimizedHead(texture, isLayer = false) {
    texture.magFilter = THREE.NearestFilter;
    texture.minFilter = THREE.NearestFilter;

    const scale = isLayer ? 1.0625 : 1.0;
    const geometry = new THREE.BoxGeometry(scale, scale, scale);
    geometry.translate(0, -0.5, 0);

    const w = 64; // 텍스처 너비
    const h = 64; // 텍스처 높이

    const faceUVs = {
        right:  [0, 8, 8, 8],
        left:   [16, 8, 8, 8],
        top:    [8, 0, 8, 8],
        bottom: [16, 0, 8, 8],
        front:  [8, 8, 8, 8],
        back:   [24, 8, 8, 8]
    };

    const layerUVs = {
        right:  [32, 8, 8, 8],
        left:   [48, 8, 8, 8],
        top:    [40, 0, 8, 8],
        bottom: [48, 0, 8, 8],
        front:  [40, 8, 8, 8],
        back:   [56, 8, 8, 8]
    };

    const uvs = isLayer ? layerUVs : faceUVs;
    
    // BoxGeometry의 면 순서: right, left, top, bottom, front, back
    const order = ['right', 'left', 'top', 'bottom', 'front', 'back'];
    const uvAttr = geometry.getAttribute('uv');
    
    for (let i = 0; i < order.length; i++) {
        const faceName = order[i];
        const [x, y, width, height] = uvs[faceName];

        // UV 좌표 계산
        const u0 = x / w;
        const v0 = 1 - (y + height) / h;
        const u1 = (x + width) / w;
        const v1 = 1 - y / h;

        // 각 면에 해당하는 4개의 정점에 대한 UV 설정
        // 정점 순서: (1,1), (0,1), (1,0), (0,0) -> 텍스처 좌표계
        const faceIndex = i * 4;
        uvAttr.setXY(faceIndex, u1, v1);
        uvAttr.setXY(faceIndex + 1, u0, v1);
        uvAttr.setXY(faceIndex + 2, u1, v0);
        uvAttr.setXY(faceIndex + 3, u0, v0);
    }
    uvAttr.needsUpdate = true;

    const material = new THREE.MeshStandardMaterial({
        map: texture,
        transparent: isLayer,
        roughness: 0.8, // 거칠기를 높여 빛 반사를 줄임 (마인크래프트 스타일)
        metalness: 0.0  // 비금속
    });

    material.toneMapped = false;
    if (material.map) {
        material.map.colorSpace = THREE.SRGBColorSpace;
    }

    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;

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
        // 로딩 플레이스홀더가 아닌, 실제 THREE.Texture 객체만 dispose
        if (cachedItem && cachedItem instanceof THREE.Texture) {
            cachedItem.dispose();
        }
    });
    textureCache.clear();

    // 1-2. 씬에 있는 객체의 지오메트리 및 재질 해제
    loadedObjectGroup.traverse(object => {
        if (object.isMesh) {
            if (object.geometry) {
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
        worker.terminate(); // 기존 워커가 있다면 종료
    }
    // 2. 웹 워커 생성
    worker = new Worker('./pbde-worker.js', { type: 'module' });

    // 3. 워커로부터 메시지(처리된 데이터) 수신
    worker.onmessage = (e) => {
        //if (e.data.success) {
        //    const flatRenderList = e.data.data;
        //    //console.log("Main Thread: Received flattened render list.", flatRenderList);
        if (e.data.success) {
            // 1. 메인 스레드에서 JSON 파싱
            const jsonData = JSON.parse(e.data.data);
        
            // 2. 데이터 정제 및 평탄화 (이 함수들을 메인 스레드로 이동)
            const processedChildren = split_children(jsonData[0].children);
            const flatRenderList = [];
            const identityMatrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
            processNodesAndFlatten(processedChildren, identityMatrix, flatRenderList);

            flatRenderList.forEach(item => {
                if (item.isBlockDisplay) {
                    const geometry = new THREE.BoxGeometry(1, 1, 1);
                    geometry.translate(0.5, 0.5, 0.5);
                    const material = new THREE.MeshStandardMaterial({ color: 0x00ff00 });
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
                } else if (item.isItemDisplay) {
                    if (item.name.toLowerCase().startsWith('player_head')) {
                        const headGroup = new THREE.Group(); // headGroup을 여기서 선언
                        headGroup.userData.isPlayerHead = true;

                    // --- 텍스처 로드 로직 ---
                    let textureUrl = null;
                    const defaultTextureValue = 'eyJ0ZXh0dXJlcyI6eyJTS0lOIjp7InVybCI6Imh0dHA6Ly90ZXh0dXJlcy5taW5lY3JhZnQubmV0L3RleHR1cmUvZDk0ZTE2ODZhZGI2NzgyM2M3ZTUxNDhjMmMwNmUyZDk1YzFiNjYzNzQ0MDllOTZiMzJkYzEzMTAzOTdlMTcxMSJ9fX0=';
                    let nbtData = {};
                    try {
                        if (item.nbt) nbtData = item.nbt;
                    } catch (err) { console.error("NBT 파싱 오류:", err); }

                        if (item.tagHead && item.tagHead.Value) {
                            try {
                                textureUrl = JSON.parse(atob(item.tagHead.Value)).textures.SKIN.url;
                            } catch (err) { console.error("tagHead 처리 오류:", err); }
                        // item 객체에서 직접 paintTexture를 찾습니다.
                        } else if (item.paintTexture) {
                            // item.paintTexture가 이미 완전한 data URL 형식인지 확인합니다.
                            if (item.paintTexture.startsWith('data:image')) {
                                // 이미 URL 형식이므로 그대로 사용합니다.
                                textureUrl = item.paintTexture;
                            } else {
                                // 순수한 base64 데이터이므로 접두사를 추가합니다.
                                textureUrl = `data:image/png;base64,${item.paintTexture}`;
                            }
                        }

                    if (!textureUrl) {
                        try {
                            const decodedDefault = atob(defaultTextureValue);            
                            textureUrl = JSON.parse(atob(defaultTextureValue)).textures.SKIN.url;
                        } catch (err) { console.error("기본 텍스처 처리 오류:", err); }
                    }
                    
                    // --- 텍스처 적용 및 큐브 생성 ---
                        const onTextureLoad = (texture) => {
                            // 기본 머리
                            const headCube = createOptimizedHead(texture, false);
                            headGroup.add(headCube);

                            // 머리 레이어
                            const layerCube = createOptimizedHead(texture, true);
                            headGroup.add(layerCube);
                    };

                    if (textureCache.has(textureUrl)) {
                        const cached = textureCache.get(textureUrl);
                        if (cached instanceof THREE.Texture) {
                            // 텍스처가 완전히 로드된 경우, 즉시 사용
                            onTextureLoad(cached);
                        } else {
                            // 텍스처가 현재 로딩 중인 경우, 콜백을 대기열에 추가
                            cached.callbacks.push(onTextureLoad);
                        }
                    } else {
                        // 텍스처가 캐시에도 없고 로딩 중도 아니므로, 로딩 시작
                        const loadingPlaceholder = { callbacks: [onTextureLoad] };
                        textureCache.set(textureUrl, loadingPlaceholder); // 로딩 시작을 알리는 플레이스홀더를 즉시 캐시에 저장

                        textureLoader.load(textureUrl, (texture) => {
                            textureCache.set(textureUrl, texture); // 플레이스홀더를 실제 텍스처로 교체
                            // 이 텍스처를 기다리던 모든 콜백들을 실행
                            loadingPlaceholder.callbacks.forEach(callback => callback(texture));
                        }, undefined, (err) => {
                            console.error('텍스처 로드 실패:', err);
                            textureCache.delete(textureUrl); // 에러 발생 시 캐시에서 플레이스홀더 제거
                        });
                    }

                    // --- 행렬 적용 ---
                    const finalMatrix = new THREE.Matrix4();
                    finalMatrix.fromArray(item.transform);
                    finalMatrix.transpose();
                    const scaleMatrix = new THREE.Matrix4().makeScale(0.5, 0.5, 0.5);
                    finalMatrix.multiply(scaleMatrix);
                    headGroup.matrixAutoUpdate = false;
                    headGroup.matrix.copy(finalMatrix);

                    loadedObjectGroup.add(headGroup);
                } else { // 그 외 다른 아이템 디스플레이 처리
                    const geometry = new THREE.BoxGeometry(1, 1, 1);
                    const material = new THREE.MeshStandardMaterial({ color: 0x0000ff }); // 파란색
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
    } else {
        console.error("Worker Error:", e.data.error);
    }
    worker.terminate();
    worker = null;
};

    worker.onerror = (error) => {
        //console.error("Worker Error:", error);
        worker.terminate();
        worker = null;
    };

    // 5. 파일을 읽어 워커로 전송
    const reader = new FileReader();
    reader.onload = (event) => {
        worker.postMessage(event.target.result);
    };
    reader.readAsText(file);
}


// 파일 드래그 앤 드롭 처리 로직

// 모달(팝업) 생성
function createDropModal(file) {
    // 함수가 호출될 때마다 기존 모달이 있으면 즉시 제거
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
        zIndex: 10000,
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
    
    openWithAnimation(modalContent); // 열기 애니메이션 적용

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

    // 모달 외부 클릭 시 닫기
    modalOverlay.addEventListener('click', (e) => {
        if (e.target === modalOverlay) {
            closeDropModal();
        }
    });
    // ESC 키 눌렀을 때 모달 닫기
    const handleEscKey = (e) => {
        if (e.key === 'Escape') {
            closeDropModal();
        }
    };
    modalOverlay.escHandler = handleEscKey; // 핸들러를 DOM 요소에 저장
    document.addEventListener('keydown', handleEscKey);

    // 버튼 이벤트 리스너
    document.getElementById('new-project-btn').addEventListener('click', () => {
        //console.log('새 프로젝트 열기 선택');
        loadpbde(file); // 파일 로드 함수 호출
        closeDropModal();
    });

    document.getElementById('merge-project-btn').addEventListener('click', () => {
        //console.log('프로젝트 합치기 선택');
        loadpbde(file); // 우선 동일하게 로드 (추후 합치기 로직 구현 필요)
        closeDropModal();
    });
}

function closeDropModal() {
    const modal = document.getElementById('drop-modal-overlay');
    if (modal) {
        // 등록된 ESC 키 핸들러가 있다면 제거하여 메모리 누수 방지
        if (modal.escHandler) {
            document.removeEventListener('keydown', modal.escHandler);
        }

        //애니메이션 끝
        const modalContent = modal.querySelector('div');
        closeWithAnimation(modalContent).then(() => {
            modal.remove();
        });
    }
}

// 파일 드롭 이벤트 처리
window.addEventListener('dragover', (e) => {
    e.preventDefault(); // 기본 동작 방지
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
