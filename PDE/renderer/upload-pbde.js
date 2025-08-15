import { openWithAnimation, closeWithAnimation } from './ui-open-close.js';
import * as THREE from 'three';
import { scene } from './renderer.js'; // renderer.js에서 scene을 export 해야 함

let worker;
// 로드된 모든 객체를 담을 그룹
const loadedObjectGroup = new THREE.Group();
scene.add(loadedObjectGroup);

// 텍스처 로더 및 캐시
const textureLoader = new THREE.TextureLoader();
const textureCache = new Map();


/**
 * 마인크래프트 머리 텍스처를 위한 재질 배열을 생성합니다.
 * 텍스처의 각 부분을 잘라내어 큐브의 6개 면에 매핑합니다.
 * @param {THREE.Texture} texture - 64x64 머리 텍스처
 * @param {boolean} isLayer - 오버레이 레이어(모자)인지 여부
 * @returns {THREE.MeshStandardMaterial[]} 큐브의 각 면에 적용될 6개의 재질 배열
 */
function createHeadMaterials(texture, isLayer = false) {
    texture.magFilter = THREE.NearestFilter;
    texture.minFilter = THREE.NearestFilter;
    const w = 64; // 텍스처 너비
    const h = 64; // 텍스처 높이
    // UV 좌표 계산 함수
    const uv = (x, y, width, height) => new THREE.Vector2(x / w, 1 - (y + height) / h);
    const uvSize = (width, height) => new THREE.Vector2(width / w, height / h);
    // 각 면의 UV 좌표 (x, y, 너비, 높이)
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
    const order = ['right', 'left', 'top', 'bottom', 'back', 'front'];
    return order.map(face => {
        const [x, y, width, height] = uvs[face];
        const material = new THREE.MeshLambertMaterial({
            map: texture.clone(),
            transparent: isLayer,
            flatShading: true
        });
        //마크다운 그래픽 가져오기
        material.toneMapped = false;
        material.map.colorSpace = THREE.SRGBColorSpace;
        material.map.offset = uv(x, y, width, height);
        material.map.repeat = uvSize(width, height);
        if (face === 'top' || face === 'bottom') {
            // For 'top' and 'bottom' faces, flip horizontally
            material.map.repeat.x *= -1;
            material.map.offset.x += (width / w);
        
            // Only for the 'top' face, also flip vertically
            if (face === 'top') {
                material.map.repeat.y *= -1;
                material.map.offset.y += (width / w);
            }
        }

        return material;
    });
}


/**
 * PBDE 파일을 로드하고 3D 씬에 객체를 배치합니다.
 * @param {File} file - 불러올 .pbde 또는 .bde 파일
 */
function loadpbde(file) {
    // 1. 새 파일 로드 전, 이전에 있던 객체들의 리소스를 해제
    loadedObjectGroup.traverse(object => {
        if (object.isMesh) {
            if (object.geometry) {
                object.geometry.dispose();
            }
            if (object.material) {
                // 재질이 배열인 경우와 아닌 경우 모두 처리
                const materials = Array.isArray(object.material) ? object.material : [object.material];

                materials.forEach(material => {
                    // ✨ 가장 중요: 재질이 사용하던 텍스처를 명시적으로 해제합니다.
                    if (material.map) {
                        material.map.dispose();
                    }
                    // 다른 맵 타입(normalMap 등)도 있다면 여기서 해제해야 합니다.

                    // 재질 자체를 해제합니다.
                    material.dispose();
                });
            }
        }
    });

    // 2. 그룹에서 모든 자식 객체들을 제거 (이 부분은 원래 코드도 잘 동작합니다)
    while(loadedObjectGroup.children.length > 0){
        loadedObjectGroup.remove(loadedObjectGroup.children[0]);
    }

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

            flatRenderList.forEach(item => {
                if (item.isBlockDisplay) {
                    const geometry = new THREE.BoxGeometry(1, 1, 1);
                    geometry.translate(0.5, 0.5, 0.5);
                    const material = new THREE.MeshStandardMaterial({ color: 0x00ff00 });
                    material.toneMapped = false;
                    const cube = new THREE.Mesh(geometry, material);

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
                        if (item.nbt) nbtData = JSON.parse(item.nbt);
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
                            const headMaterials = createHeadMaterials(texture, false);
                            const headGeometry = new THREE.BoxGeometry(1, 1, 1);
                            headGeometry.translate(0, -0.5, 0);
                            const headCube = new THREE.Mesh(headGeometry, headMaterials);
                            headGroup.add(headCube);

                            // 머리 레이어
                            const layerMaterials = createHeadMaterials(texture, true);
                            const layerGeometry = new THREE.BoxGeometry(1.0625, 1.0625, 1.0625);
                            layerGeometry.translate(0, -0.5, 0);
                            const layerCube = new THREE.Mesh(layerGeometry, layerMaterials);
                            headGroup.add(layerCube);
                    };

                    if (textureCache.has(textureUrl)) {
                        onTextureLoad(textureCache.get(textureUrl));
                    } else {
                        textureLoader.load(textureUrl, (texture) => {
                            textureCache.set(textureUrl, texture);
                            onTextureLoad(texture);
                        }, undefined, (err) => {
                            console.error('텍스처 로드 실패:', err);
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
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            closeDropModal();
        }
    });

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
