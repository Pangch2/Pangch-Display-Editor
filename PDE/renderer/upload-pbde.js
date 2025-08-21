import { openWithAnimation, closeWithAnimation } from './ui-open-close.js';
import * as THREE from 'three/webgpu';
import { scene } from './renderer.js'; // renderer.js에서 scene을 export 해야 함

let worker;
// 로드된 모든 객체를 담을 그룹
const loadedObjectGroup = new THREE.Group();

export { loadedObjectGroup };


// 텍스처 로더 및 캐시
const textureLoader = new THREE.TextureLoader();
const textureCache = new Map();


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
    
    // BoxGeometry의 면 순서: left, right, top, bottom, front, back
    const order = ['left', 'right', 'top', 'bottom', 'front', 'back'];
    const uvAttr = geometry.getAttribute('uv');
    
    for (let i = 0; i < order.length; i++) {
        const faceName = order[i];
        const [x, y, width, height] = uvs[faceName];

    // UV 좌표 계산
    //const inset = 1/128;
    const inset = 0.0078125
        
    // 픽셀 좌표(x, y, width, height)에 inset을 먼저 적용하고
    const u0 = (x + inset) / w;
    const v0 = 1 - (y + height - inset) / h;
    const u1 = (x + width - inset) / w;
    const v1 = 1 - (y + inset) / h;

        // 각 면에 해당하는 4개의 정점에 대한 UV 설정
        const faceIndex = i * 4;
        
        if (faceName === 'top') {
            // top: 180-degree rotated and horizontally flipped
            uvAttr.setXY(faceIndex + 0, u1, v0);
            uvAttr.setXY(faceIndex + 1, u0, v0);
            uvAttr.setXY(faceIndex + 2, u1, v1);
            uvAttr.setXY(faceIndex + 3, u0, v1);
        } else if (faceName === 'bottom') {
            // bottom: initial state (original mapping, no flip)
            uvAttr.setXY(faceIndex + 0, u1, v1);
            uvAttr.setXY(faceIndex + 1, u0, v1);
            uvAttr.setXY(faceIndex + 2, u1, v0);
            uvAttr.setXY(faceIndex + 3, u0, v0);
        } else {
            // all other faces: original mapping, horizontally flipped
            uvAttr.setXY(faceIndex + 0, u0, v1);
            uvAttr.setXY(faceIndex + 1, u1, v1);
            uvAttr.setXY(faceIndex + 2, u0, v0);
            uvAttr.setXY(faceIndex + 3, u1, v0);
        }
    }
    uvAttr.needsUpdate = true;

    const material = new THREE.MeshLambertMaterial({
        map: texture,
        transparent: isLayer,
        alphaTest: 0.5,
        depthWrite: true
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
        if (e.data.success) {
          const flatRenderList = e.data.data;
          console.log("Main Thread: Received flattened render list.", flatRenderList);
        //if (e.data.success) {
        //    // 1. 메인 스레드에서 JSON 파싱
        //    const jsonData = JSON.parse(e.data.data);
     
            flatRenderList.forEach(item => {
                if (item.isBlockDisplay) {
                    const geometry = new THREE.BoxGeometry(1, 1, 1);
                    geometry.translate(0.5, 0.5, 0.5);
                    const material = new THREE.MeshStandardMaterial({ color: 0x00ff00 ,transparent: true});
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
                    if (item.textureUrl) { // 워커가 전달해준 textureUrl 사용
                        const headGroup = new THREE.Group();
                        headGroup.userData.isPlayerHead = true;

                        const onTextureLoad = (texture) => {
                            headGroup.add(createOptimizedHead(texture, false)); // Base
                            headGroup.add(createOptimizedHead(texture, true));  // Layer
                        };

                        // --- 단순화된 텍스처 로드 및 캐싱 --- 
                        if (textureCache.has(item.textureUrl)) {
                            const cached = textureCache.get(item.textureUrl);
                            if (cached instanceof THREE.Texture) {
                                onTextureLoad(cached);
                            } else { // 로딩 중
                                cached.callbacks.push(onTextureLoad);
                            }
                        } else { // 새로 로드
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

                        // --- 행렬 적용 ---
                        const finalMatrix = new THREE.Matrix4();
                        finalMatrix.fromArray(item.transform);
                        finalMatrix.transpose();
                        const scaleMatrix = new THREE.Matrix4().makeScale(0.5, 0.5, 0.5);
                        finalMatrix.multiply(scaleMatrix);
                        headGroup.matrixAutoUpdate = false;
                        headGroup.matrix.copy(finalMatrix);

                        loadedObjectGroup.add(headGroup);
                    } else { // 그 외 다른 아이템 디스플레이 처리 (player_head가 아닌 경우)
                        const geometry = new THREE.BoxGeometry(1, 1, 1);
                        const material = new THREE.MeshStandardMaterial({ color: 0x0000ff ,transparent: true}); // 파란색
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
