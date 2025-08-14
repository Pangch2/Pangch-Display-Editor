import { openWithAnimation, closeWithAnimation } from './ui-open-close.js';
import * as THREE from 'three';
import { scene } from './renderer.js'; // renderer.js에서 scene을 export 해야 함

let worker;
// 로드된 모든 객체를 담을 그룹
const loadedObjectGroup = new THREE.Group();
scene.add(loadedObjectGroup);

/**
 * PBDE 파일을 로드하고 3D 씬에 객체를 배치합니다.
 * @param {File} file - 불러올 .pbde 또는 .bde 파일
 */
function loadpbde(file) {
    // 1. 새 파일 로드 전, 이전에 있던 객체들의 리소스를 해제하고 그룹에서 삭제
    loadedObjectGroup.traverse(object => {
        if (object.isMesh) {
            if (object.geometry) {
                object.geometry.dispose();
            }
            if (object.material) {
                // 재질이 배열인 경우 각각 해제
                if (Array.isArray(object.material)) {
                    object.material.forEach(material => material.dispose());
                } else {
                    object.material.dispose();
                }
            }
        }
    });
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
            //console.log("Main Thread: Received flattened render list.", flatRenderList);

            // 4. 평탄화된 리스트를 순회하며 큐브 생성
            flatRenderList.forEach(item => {
                if (item.isBlockDisplay) {
                    const geometry = new THREE.BoxGeometry(1, 1, 1);
                    geometry.translate(0.5, 0.5, 0.5);
                    const material = new THREE.MeshStandardMaterial({ color: 0x00ff00 });
                    const cube = new THREE.Mesh(geometry, material);

                    const finalMatrix = new THREE.Matrix4();
                    finalMatrix.fromArray(item.transform);
                    finalMatrix.transpose();

                    cube.matrixAutoUpdate = false;
                    cube.matrix.copy(finalMatrix);
                    loadedObjectGroup.add(cube);

                } else if (item.isItemDisplay) {
                    // 'player_head'의 경우 특별 처리
                    if (item.name.toLowerCase().startsWith('player_head')) {
                        const headGroup = new THREE.Group();
                        headGroup.userData.isPlayerHead = true; // 나중에 식별하기 쉽도록 userData에 표시

                        // 기본 머리 큐브
                        const headGeometry = new THREE.BoxGeometry(1, 1, 1);
                        headGeometry.translate(0, -0.5, 0); // 기준점을 상단 중앙으로
                        const headMaterial = new THREE.MeshStandardMaterial({ color: 0x0000ff }); // 파란색
                        const headCube = new THREE.Mesh(headGeometry, headMaterial);
                        headGroup.add(headCube);

                        // 머리 레이어 큐브 (1.0625배 크게)
                        const layerGeometry = new THREE.BoxGeometry(1.0625, 1.0625, 1.0625);
                        layerGeometry.translate(0, -0.5, 0); // 기준점을 상단 중앙으로
                        const layerMaterial = new THREE.MeshStandardMaterial({ 
                            color: 0x0000ff, // 같은 파란색 또는 다른 색
                            transparent: true, // 투명도 설정이 필요할 수 있음
                            opacity: 0.8 
                        });
                        const layerCube = new THREE.Mesh(layerGeometry, layerMaterial);
                        headGroup.add(layerCube);

                        // --- 행렬 적용 ---
                        const finalMatrix = new THREE.Matrix4();
                        finalMatrix.fromArray(item.transform);
                        finalMatrix.transpose();

                        // 스케일링 적용
                        const scaleMatrix = new THREE.Matrix4().makeScale(0.5, 0.5, 0.5);
                        finalMatrix.multiply(scaleMatrix);

                        headGroup.matrixAutoUpdate = false;
                        headGroup.matrix.copy(finalMatrix);

                        loadedObjectGroup.add(headGroup);

                    } else { // 'player_head'가 아닌 다른 아이템
                        const geometry = new THREE.BoxGeometry(1, 1, 1);
                        const material = new THREE.MeshStandardMaterial({ color: 0x0000ff }); // 파란색
                        const cube = new THREE.Mesh(geometry, material);

                        // --- 행렬 적용 ---
                        const finalMatrix = new THREE.Matrix4();
                        finalMatrix.fromArray(item.transform);
                        finalMatrix.transpose();

                        cube.matrixAutoUpdate = false;
                        cube.matrix.copy(finalMatrix);

                        loadedObjectGroup.add(cube);
                    }
                } else {
                    return; // 블록 또는 아이템 디스플레이가 아니면 건너뜀
                }
            });

        } else {
            console.error("Worker Error:", e.data.error);
        }
        worker.terminate(); // 작업 완료 후 워커 종료
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
