import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import * as THREE from 'three/webgpu';
import { initAssets } from './asset-manager.js';
import { loadedObjectGroup } from './load-project/upload-pbde.ts';
import { openWithAnimation, closeWithAnimation } from './ui-open-close.js';

// 전역 변수로 선언
let scene, camera, renderer, controls, transformControls;
let selectedObject = null;
let pivotMode = 'origin'; // 'origin' 또는 'center'
let currentSpace = 'world'; // 'world' 또는 'local'
let selectionOverlay = null; // 선택된 객체의 오버레이
let lastDirections = { X: null, Y: null, Z: null }; // 축 방향 감지 상태 추적
let gizmoLines = {
  X: { original: [], negative: [] },
  Y: { original: [], negative: [] },
  Z: { original: [], negative: [] }
}; // Gizmo 축 라인 저장

// 앱 시작 로직을 비동기 함수로 감싸기
async function startApp() {
  // --- 1. 로딩 화면 준비 ---
  const loadingOverlay = document.getElementById('loading-overlay');
  const loadingIcon = document.getElementById('loading-icon');

  // 메인 프로세스로부터 아이콘 Data URL 받아오기
  const iconResult = await window.ipcApi.getLoadingIcon();
  if (iconResult.success) {
    loadingIcon.src = iconResult.dataUrl;
  }

  // --- 2. 로딩 화면 표시 및 에셋 캐싱 ---
  openWithAnimation(loadingOverlay);
  loadingOverlay.classList.add('visible');

  try {
    // 에셋 캐싱/준비가 완료될 때까지 기다림
    await initAssets();
  } catch (error) {
    console.error("Asset initialization failed:", error);
    // 에러 발생 시 사용자에게 알림 (예: 로딩 텍스트 변경)
    document.getElementById('loading-text').textContent = '에셋 로딩 실패!';
    return; // 앱 시작 중단
  }

  // --- 3. 로딩 화면 숨기기 ---
  await closeWithAnimation(loadingOverlay);
  loadingOverlay.classList.remove('visible');

  // --- 4. Three.js 씬 초기화 (기존 코드) ---
  await initScene();
  animate();
  onWindowResize(); // 초기 뷰포트 크기 설정
}

// XYZ 축을 양/음 방향으로 모두 표시하는 헬퍼
function createFullAxesHelper(size = 50) {
    const axesGroup = new THREE.Group();

    const createAxisLine = (start, end, color) => {
        const geometry = new THREE.BufferGeometry().setFromPoints([start, end]);
        const material = new THREE.LineBasicMaterial({ color: color });
        return new THREE.Line(geometry, material);
    };

    // === X축 (빨강)
    axesGroup.add(createAxisLine(
        new THREE.Vector3(-size / 2, 0, 0),
        new THREE.Vector3(size / 2, 0, 0),
        0xEF3751
    ));

    // === Y축 (초록)
    axesGroup.add(createAxisLine(
        new THREE.Vector3(0, -size / 2, 0),
        new THREE.Vector3(0, size / 2, 0),
        0x6FA21C
    ));

    // === Z축 (파랑)
    axesGroup.add(createAxisLine(
        new THREE.Vector3(0, 0, -size / 2),
        new THREE.Vector3(0, 0, size / 2),
        0x437FD0
    ));
    return axesGroup;
}

// 'Z>' 모양을 XZ 평면(바닥) 위에 그리는 헬퍼
function createZGreaterSymbol(position = new THREE.Vector3(0.5, 0, 0.5), size = 0.5, color = 0x515151) {
    const group = new THREE.Group();
    group.position.copy(position);

    const material = new THREE.LineBasicMaterial({ color });

    const s = size;
    const half = s / 2;
    const gap = s * 0.15;           // Z와 > 사이 간격
    const arrowWidth = s * 0.45;    // > 화살표 가로 길이

    // Z: 위, 대각선, 아래
    const lines = [];

    const addLine = (ax, az, bx, bz) => {
        const geometry = new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(ax, 0, az),
            new THREE.Vector3(bx, 0, bz)
        ]);
        const line = new THREE.Line(geometry, material);
        group.add(line);
        lines.push(line);
    };

    // Top horizontal
    addLine(-half, -half, half, -half);
    // Diagonal
    addLine(half, -half, -half, half);
    // Bottom horizontal
    addLine(-half, half, half, half);

    // '>' 화살표 (Z 오른쪽에 배치)
    const rightStartX = half + gap;
    const arrowTipX = rightStartX + arrowWidth;
    // 위쪽 꼭짓점 -> 팁 -> 아래쪽 꼭짓점 (두 개의 선)
    addLine(rightStartX, -half, arrowTipX, 0);
    addLine(arrowTipX, 0, rightStartX, half);

    // 90도 Y축 회전
    group.rotation.y = Math.PI / 2;
    return group;
}

// 스케일/전단 변형이 포함된 행렬에서 순수 회전 쿼터니언을 추출하는 헬퍼 함수
function getRotationFromMatrix(matrix) {
    const R = new THREE.Matrix4();
    // 기저 벡터(basis vectors) 추출
    const x = new THREE.Vector3().setFromMatrixColumn(matrix, 0);
    const y = new THREE.Vector3().setFromMatrixColumn(matrix, 1);
    const z = new THREE.Vector3().setFromMatrixColumn(matrix, 2);

    // X 기저 벡터 정규화
    x.normalize();

    // 그람-슈미트 직교화 (Y)
    const yDotX = y.dot(x);
    y.sub(x.clone().multiplyScalar(yDotX)).normalize();

    // Z는 X와 Y의 외적(cross product)
    z.crossVectors(x, y).normalize();

    // 직교화된 기저 벡터들로 회전 행렬 재구성
    R.makeBasis(x, y, z);

    // 쿼터니언 추출
    const quaternion = new THREE.Quaternion();
    quaternion.setFromRotationMatrix(R);
    return quaternion;
}

// 피벗 위치를 갱신하는 통합 헬퍼 함수
function updatePivot(wrapper) {
    if (!wrapper) return;
    const content = wrapper.children[0];
    if (!content) return;

    // 1. 목표 피벗의 로컬 좌표 결정
    let targetPivotLocal = new THREE.Vector3(0, 0, 0);
    if (pivotMode === 'center') {
        const box = new THREE.Box3();
        content.traverse(child => {
            if (child.isMesh) {
                if (!child.geometry.boundingBox) child.geometry.computeBoundingBox();
                box.union(child.geometry.boundingBox);
            }
        });
        box.getCenter(targetPivotLocal);
    }

    // 2. 목표 피벗의 월드 좌표 계산
    content.updateWorldMatrix(true, false);
    const targetPivotWorld = targetPivotLocal.clone().applyMatrix4(content.matrixWorld);

    // 3. 현재 피벗 위치(wrapper.position)에서 목표 위치까지의 차이(adjustment) 계산
    const adjustmentOffset = targetPivotWorld.clone().sub(wrapper.position);

    // 4. 조정이 필요한 경우에만 적용 (무한 루프 방지)
    if (adjustmentOffset.lengthSq() > 0.000001) {
        // Wrapper(피벗)를 새로운 목표 위치로 이동
        wrapper.position.add(adjustmentOffset);

        // Content가 시각적으로 움직이지 않도록 역으로 보정
        const localCounter = adjustmentOffset.clone().applyQuaternion(wrapper.quaternion.clone().invert());
        const inverseTranslate = new THREE.Matrix4().makeTranslation(-localCounter.x, -localCounter.y, -localCounter.z);
        content.matrix.premultiply(inverseTranslate);
        content.matrixWorldNeedsUpdate = true;
    }
}

// 선택된 객체에 오버레이를 생성하거나 업데이트하는 함수
function updateSelectionOverlay(wrapper) {
    // 기존 오버레이 제거
    if (selectionOverlay) {
        if (selectionOverlay.parent) {
            selectionOverlay.parent.remove(selectionOverlay);
        }
        selectionOverlay.traverse(child => {
            if (child.geometry) child.geometry.dispose();
            if (child.material) child.material.dispose();
        });
        selectionOverlay = null;
    }

    if (!wrapper) return;

    const content = wrapper.children[0];
    if (!content) return;

    // displayType에 따라 색상 결정
    const displayType = wrapper.userData?.displayType;
    let overlayColor;
    if (displayType === 'block_display') {
        overlayColor = 0xFFD147; // #FFD147
    } else if (displayType === 'item_display') {
        overlayColor = 0x2E87EC; // #2E87EC
    } else {
        return; // 타입을 알 수 없으면 오버레이를 표시하지 않음
    }

    // 로컬 좌표계 기준의 바운딩 박스 계산
    const localBox = new THREE.Box3();
    content.traverse(child => {
        if (child.isMesh && child.geometry) {
            if (!child.geometry.boundingBox) {
                child.geometry.computeBoundingBox();
            }
            // 자식의 지오메트리 바운딩 박스를 자식의 월드 변환을 적용하여 확장
            const childBox = child.geometry.boundingBox.clone();
            childBox.applyMatrix4(child.matrix);
            localBox.union(childBox);
        }
    });

    const size = new THREE.Vector3();
    localBox.getSize(size);
    const center = new THREE.Vector3();
    localBox.getCenter(center);

    // 지오메트리 생성 및 중심 맞춤
    const overlayGeometry = new THREE.BoxGeometry(size.x, size.y, size.z);
    overlayGeometry.translate(center.x, center.y, center.z);

    // 외곽선 생성
    const edges = new THREE.EdgesGeometry(overlayGeometry);
    const overlayMaterial = new THREE.LineBasicMaterial({
        color: overlayColor,
        depthTest: true,
        depthWrite: false,
        transparent: true,
        opacity: 0.9
    });

    selectionOverlay = new THREE.LineSegments(edges, overlayMaterial);
    selectionOverlay.renderOrder = 1000;
    selectionOverlay.matrixAutoUpdate = false; // 수동으로 매트릭스 업데이트

    scene.add(selectionOverlay);
}


async function initScene() {
    // 1. 장면(Scene)
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x1F1F1F); // 어두운 회색 배경
    scene.add(loadedObjectGroup); // 로드된 객체 그룹을 씬에 추가

    // 2. 카메라(Camera)
    const mainContent = document.getElementById('main-content');
    camera = new THREE.PerspectiveCamera(
        80,
        mainContent.clientWidth / mainContent.clientHeight,
        0.05,
        1000
    );
    camera.position.set(3, 3, 3);
    camera.lookAt(0, 0, 0);

    // 3. 렌더러(Renderer)
    renderer = new THREE.WebGPURenderer({
        canvas: document.querySelector('#renderCanvas'),
        logarithmicDepthBuffer: true
    });
    renderer.setSize(mainContent.clientWidth, mainContent.clientHeight);
    await renderer.init();

    // 4. 컨트롤(Controls)
    controls = new OrbitControls(camera, renderer.domElement);
    controls.screenSpacePanning = true;

    // 5. TransformControls
    transformControls = new TransformControls(camera, renderer.domElement);
    transformControls.setMode('translate');
    transformControls.setSpace('world'); // 초기 공간은 월드
    transformControls.setColors(0xEF3751, 0x6FA21C, 0x437FD0);
    scene.add(transformControls.getHelper());

    // --- TransformControls Gizmo 축 라인 수정 (복제 방식) ---
    // 이 코드는 기존 축 라인을 복제하고 뒤집어서 음수 방향 축을 추가합니다.
    try {
        // transformControls.getHelper()는 TransformControlsRoot를 반환하고,
        // 그 첫 번째 자식이 TransformControlsGizmo 입니다.
        const gizmoRoot = transformControls.getHelper();
        const gizmoContainer = gizmoRoot.children[0];

        const processedMeshes = new Set(); // 중복 처리를 방지하기 위한 Set

        ['translate', 'scale'].forEach(mode => {
            const modeGizmo = gizmoContainer.gizmo[mode];
            if (modeGizmo) {
                const originalLines = [];
                modeGizmo.traverse((child) => {
                    if (child.isMesh && child.geometry instanceof THREE.CylinderGeometry && child.geometry.parameters.height === 0.5) {
                        if (!processedMeshes.has(child)) {
                           originalLines.push(child);
                           processedMeshes.add(child);
                        }
                    }
                });

                originalLines.forEach(originalLine => {
                    // 지오메트리를 복제합니다.
                    const negativeGeometry = originalLine.geometry.clone();

                    // 각 축의 방향에 맞게 지오메트리를 180도 회전시킵니다.
                    if (originalLine.name === 'X') {
                        negativeGeometry.rotateY(Math.PI); // Y축 기준으로 회전하여 -X 방향을 보게 함
                    } else if (originalLine.name === 'Y') {
                        negativeGeometry.rotateX(Math.PI); // X축 기준으로 회전하여 -Y 방향을 보게 함
                    } else if (originalLine.name === 'Z') {
                        negativeGeometry.rotateY(Math.PI); // Y축 기준으로 회전하여 -Z 방향을 보게 함
                    }

                    // 회전된 지오메트리로 새로운 메쉬를 생성합니다.
                    const negativeMaterial = originalLine.material.clone(); // material을 먼저 clone하여 원본 수정 전 상태 유지
                    const negativeLine = new THREE.Mesh(negativeGeometry, negativeMaterial);
                    negativeLine.name = originalLine.name;
                    
                    // 원본 메쉬의 부모에 새로운 메쉬를 추가합니다.
                    originalLine.parent.add(negativeLine);

                    // Y 축의 경우 원본에 투명 적용
                    if (originalLine.name === 'Y') {
                        // Y축 메쉬 저장 (투명도는 animate()에서 동적으로 적용)
                        gizmoLines.Y.original.push(originalLine);
                        gizmoLines.Y.negative.push(negativeLine);
                    }

                    // X 축 메쉬 저장
                    if (originalLine.name === 'X') {
                        gizmoLines.X.original.push(originalLine);
                        gizmoLines.X.negative.push(negativeLine);
                    }

                    // Z 축 메쉬 저장
                    if (originalLine.name === 'Z') {
                        gizmoLines.Z.original.push(originalLine);
                        gizmoLines.Z.negative.push(negativeLine);
                    }

                });
            }
        });
    } catch (error) {
        console.error("TransformControls gizmo patch (clone method) failed:", error);
    }
    // --- 수정 끝 ---
    const dragInitialMatrix = new THREE.Matrix4();
    const dragInitialQuaternion = new THREE.Quaternion();
    const dragInitialScale = new THREE.Vector3();
    let draggingMode = null;

    // --- 드래그 이벤트 핸들러 ---
    transformControls.addEventListener('dragging-changed', (event) => {
        controls.enabled = !event.value;

        const wrapper = transformControls.object;
        if (!wrapper) return;

        const content = wrapper.children[0];
        if (!content) return;

        if (event.value) { // 드래그 시작
            dragInitialMatrix.copy(content.matrix);
            dragInitialQuaternion.copy(wrapper.quaternion);
            dragInitialScale.copy(wrapper.scale);
            draggingMode = transformControls.mode;
        } else { // 드래그 끝
            if (!draggingMode) return;

            // 1. 객체 변형 적용
            if (currentSpace === 'local') {
                if (draggingMode === 'rotate') {
                    // 로컬 회전은 wrapper의 quaternion에 누적되므로, content matrix는 수정하지 않음
                } else if (draggingMode === 'scale') {
                    const finalScale = wrapper.scale.clone();
                    if (dragInitialScale.x !== 0 && dragInitialScale.y !== 0 && dragInitialScale.z !== 0) {
                        const deltaScale = finalScale.divide(dragInitialScale);
                        const deltaScaleMatrix = new THREE.Matrix4().makeScale(deltaScale.x, deltaScale.y, deltaScale.z);
                        content.matrix.copy(dragInitialMatrix).premultiply(deltaScaleMatrix);
                    }
                }
            } else { // WORLD SPACE
                if (draggingMode === 'scale') {
                    const finalScale = wrapper.scale.clone();
                    const deltaScale = finalScale.divide(dragInitialScale);
                    const deltaScaleMatrix = new THREE.Matrix4().makeScale(deltaScale.x, deltaScale.y, deltaScale.z);
                    content.matrix.copy(dragInitialMatrix).premultiply(deltaScaleMatrix);
                } else if (draggingMode === 'rotate') {
                    const finalQuaternion = wrapper.quaternion.clone();
                    const deltaQuaternion = finalQuaternion.multiply(dragInitialQuaternion.clone().invert());
                    const deltaRotationMatrix = new THREE.Matrix4().makeRotationFromQuaternion(deltaQuaternion);
                    content.matrix.copy(dragInitialMatrix).premultiply(deltaRotationMatrix);
                }
            }
            content.matrixWorldNeedsUpdate = true;

            // 2. Wrapper 상태 리셋
            wrapper.scale.set(1, 1, 1);
            if (!(draggingMode === 'rotate' && currentSpace === 'local')) {
                wrapper.quaternion.copy(dragInitialQuaternion);
            }

            // 3. 피벗 위치 갱신
            updatePivot(wrapper);
            
            draggingMode = null;
        }
    });

    // 6. 키보드 이벤트
    window.addEventListener('keydown', (event) => {
        if (event.target.tagName === 'INPUT' || event.target.tagName === 'TEXTAREA') return;

        // Gizmo 조작 중 모드/공간/피벗 변경 시, 진행 중인 조작을 먼저 완료시킵니다.
        const keysToHandle = ['t', 'r', 's', 'x', 'z'];
        if (transformControls.dragging && keysToHandle.includes(event.key.toLowerCase())) {
            // 1. TransformControls의 드래그를 먼저 정상적으로 종료시킵니다.
            transformControls.pointerUp({ button: 0 });

            // 2. OrbitControls의 내부 상태를 리셋하여 카메라 점프 현상을 해결합니다.
            // 가장 확실한 방법은 컨트롤을 재생성하는 것입니다.
            const oldTarget = controls.target.clone();
            controls.dispose(); // 기존 컨트롤의 이벤트 리스너 제거

            controls = new OrbitControls(camera, renderer.domElement); // 컨트롤 재생성
            controls.screenSpacePanning = true; // 기존 설정 다시 적용
            controls.target.copy(oldTarget); // 기존 타겟 복원
            controls.update(); // 타겟 변경사항 적용
        }

        const wrapper = transformControls.object;

        switch (event.key.toLowerCase()) {
            case 't':
                transformControls.setMode('translate');
                break;
            case 'r':
                transformControls.setMode('rotate');
                break;
            case 's':
                transformControls.setMode('scale');
                break;
            case 'x': { // 공간 전환 (World/Local)
                currentSpace = currentSpace === 'world' ? 'local' : 'world';
                transformControls.setSpace(currentSpace);
                console.log('TransformControls Space:', currentSpace);

                if (wrapper) {
                    const content = wrapper.children[0];
                    if (currentSpace === 'local') {
                        content.updateWorldMatrix(true, false);
                        const quaternion = getRotationFromMatrix(content.matrixWorld);
                        wrapper.quaternion.copy(quaternion);
                        const inverseQuaternion = quaternion.clone().invert();
                        const inverseRotationMatrix = new THREE.Matrix4().makeRotationFromQuaternion(inverseQuaternion);
                        content.matrix.premultiply(inverseRotationMatrix);
                        content.matrixWorldNeedsUpdate = true;
                    } else { // 'world'
                        const quaternion = wrapper.quaternion.clone(); 
                        const rotationMatrix = new THREE.Matrix4().makeRotationFromQuaternion(quaternion);
                        content.matrix.premultiply(rotationMatrix);
                        content.matrixWorldNeedsUpdate = true;
                        wrapper.quaternion.set(0, 0, 0, 1);
                    }
                    // 피벗 위치 갱신
                    updatePivot(wrapper);
                }
                break;
            }
            case 'z': { // 피벗 전환 (Origin/Center)
                pivotMode = pivotMode === 'origin' ? 'center' : 'origin';
                console.log('Pivot Mode:', pivotMode);
                if (wrapper) {
                    updatePivot(wrapper);
                }
                break;
            }
        }
    });

    // 7. Raycaster로 객체 선택
    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();
    let mouseDownPos = null;

    function resetSelectionAndDeselect() {
        if (selectedObject) {
            const wrapper = transformControls.object;
            if (wrapper) {
                if (currentSpace === 'local') {
                    const quaternion = wrapper.quaternion.clone();
                    const rotationMatrix = new THREE.Matrix4().makeRotationFromQuaternion(quaternion);
                    const content = wrapper.children[0];
                    if (content) {
                        content.matrix.premultiply(rotationMatrix);
                        content.matrixWorldNeedsUpdate = true;
                    }
                }
                wrapper.quaternion.set(0, 0, 0, 1);
                wrapper.scale.set(1, 1, 1);
            }
            transformControls.detach();
            selectedObject = null;
            
            // 오버레이 제거
            updateSelectionOverlay(null);
            
            // 축 방향 감지 상태 리셋
            lastDirections = { X: null, Y: null, Z: null };
            
            console.log('선택 해제');
        }
    }

    loadedObjectGroup.userData.resetSelection = resetSelectionAndDeselect;

    renderer.domElement.addEventListener('pointerdown', (event) => {
        if (event.button !== 0) return;
        if (transformControls.dragging) return;
        mouseDownPos = { x: event.clientX, y: event.clientY };
    });

    renderer.domElement.addEventListener('pointerup', (event) => {
        if (!mouseDownPos) return;
        const dist = Math.sqrt((event.clientX - mouseDownPos.x) ** 2 + (event.clientY - mouseDownPos.y) ** 2);
        if (dist > 5) {
            mouseDownPos = null;
            return;
        }
        mouseDownPos = null;

        const rect = renderer.domElement.getBoundingClientRect();
        mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

        raycaster.setFromCamera(mouse, camera);
        const intersects = raycaster.intersectObjects(loadedObjectGroup.children, true);

        if (intersects.length > 0) {
            let targetObject = null;
            for (const intersect of intersects) {
                let obj = intersect.object;
                let isGizmo = false;
                let checkParent = obj;
                while (checkParent) {
                    if (checkParent === transformControls || checkParent.isTransformControlsGizmo) {
                        isGizmo = true;
                        break;
                    }
                    checkParent = checkParent.parent;
                }
                if (!isGizmo) {
                    targetObject = obj;
                    break;
                }
            }
            
            if (targetObject) {
                while (targetObject.parent && targetObject.parent !== loadedObjectGroup) {
                    targetObject = targetObject.parent;
                }

                if (selectedObject !== targetObject) {
                    // 다른 객체를 선택하기 전에, 이전에 선택된 객체가 있었다면 먼저 상태를 정상적으로 리셋(Deselect)합니다.
                    // 이렇게 하지 않으면 Local Space 모드에서 이전 객체의 회전 상태가 불안정하게 남는 문제가 발생합니다.
                    if (selectedObject) {
                        resetSelectionAndDeselect();
                    }

                    selectedObject = targetObject;
                    transformControls.attach(selectedObject);
                    
                    if (currentSpace === 'local') {
                        const content = selectedObject.children[0];
                        content.updateWorldMatrix(true, false);
                        const quaternion = getRotationFromMatrix(content.matrixWorld);
                        selectedObject.quaternion.copy(quaternion);
                        const inverseQuaternion = quaternion.clone().invert();
                        const inverseRotationMatrix = new THREE.Matrix4().makeRotationFromQuaternion(inverseQuaternion);
                        content.matrix.premultiply(inverseRotationMatrix);
                        content.matrixWorldNeedsUpdate = true;
                    }
                    
                    // 피벗 위치 갱신
                    updatePivot(selectedObject);
                    
                    // 오버레이 생성
                    updateSelectionOverlay(selectedObject);
                    
                    console.log('선택된 객체:', selectedObject);
                }
            }
        } else {
            if (selectedObject) {
                resetSelectionAndDeselect();
            }
        }
    });

    // 8. 헬퍼(Helper)
    const axes = createFullAxesHelper(150);
    axes.renderOrder = 1;
    scene.add(axes);

    const detailGrid = new THREE.GridHelper(20, 320, 0x2C2C2C, 0x2C2C2C);
    detailGrid.renderOrder = -2; // 큐브보다 먼저 그리기
    scene.add(detailGrid);

    const Grid = new THREE.GridHelper(20, 20, 0x3D3D3D, 0x3D3D3D);
    Grid.renderOrder = -1; // 큐브보다 먼저 그리기
    scene.add(Grid);
    
    renderer.shadowMap.enabled = false;
    
    [detailGrid, Grid].forEach(helper => {
        const materials = Array.isArray(helper.material) ? helper.material : [helper.material];
        materials.forEach(m => { m.depthWrite = false; });
    });

    const zSymbol = createZGreaterSymbol(new THREE.Vector3(0.5, 0, -0.25), 0.125, 0x515151);
    zSymbol.renderOrder = 10;
    scene.add(zSymbol);
}

//fps표시용1
let lastTime = performance.now();
let frameCount = 0;
const fpsCounterElement = document.getElementById('fps-counter');

function animate() {
    requestAnimationFrame(animate);
    //fps표시용2
    const currentTime = performance.now();
    frameCount++;
    if (currentTime - lastTime >= 1000) {
        const fps = frameCount;
        if (fpsCounterElement) {
            fpsCounterElement.textContent = `FPS: ${fps}`;
        }
        frameCount = 0;
        lastTime = currentTime;
    }
    
    // 선택된 객체가 있으면 오버레이 위치 업데이트
    if (selectedObject && selectionOverlay) {
        const content = selectedObject.children[0];
        if (content) {
            content.updateWorldMatrix(true, false);
            selectionOverlay.matrix.copy(content.matrixWorld);
        }
    }
    
    // 축 방향 감지: translate 또는 scale 모드에서 Gizmo 위치 기준 카메라 축 비교
    if (selectedObject && (transformControls.mode === 'translate' || transformControls.mode === 'scale')) {
        const gizmoPos = transformControls.object.position;
        const camPos = camera.position;
        const direction = camPos.clone().sub(gizmoPos).normalize();

        // Local space에서는 방향을 로컬 좌표계로 변환
        if (currentSpace === 'local') {
            direction.applyQuaternion(transformControls.object.quaternion.clone().invert());
        }

        const axesConfig = {
            X: { positive: 'right', negative: 'left', originalLines: gizmoLines.X.original, negativeLines: gizmoLines.X.negative, getDirection: () => direction.x > 0 },
            Y: { positive: 'up', negative: 'down', originalLines: gizmoLines.Y.original, negativeLines: gizmoLines.Y.negative, getDirection: () => direction.y > 0 },
            Z: { positive: 'front', negative: 'back', originalLines: gizmoLines.Z.original, negativeLines: gizmoLines.Z.negative, getDirection: () => direction.z > 0 }
        };

        for (const axis in axesConfig) {
            const { positive, negative, originalLines, negativeLines, getDirection } = axesConfig[axis];
            const isPositive = getDirection();
            const currentDirection = isPositive ? positive : negative;
            if (currentDirection !== lastDirections[axis]) {
                lastDirections[axis] = currentDirection;
                if (isPositive) {
                    // 양수 방향: 원본 투명 0.1, 음수 투명 1
                    originalLines.forEach(line => {
                        const clonedMat = line.material.clone();
                        line.material = clonedMat;
                        clonedMat.opacity = 1;
                    });
                    negativeLines.forEach(line => {
                        const clonedMat = line.material.clone();
                        line.material = clonedMat;

                        clonedMat.opacity = 0.001;
                    });
                } else {
                    // 음수 방향: 음수 투명 0.1, 원본 투명 1
                    negativeLines.forEach(line => {
                        const clonedMat = line.material.clone();
                        line.material = clonedMat;
                        clonedMat.opacity = 1;
                    });
                    originalLines.forEach(line => {
                        const clonedMat = line.material.clone();
                        line.material = clonedMat;
                        clonedMat.opacity = 0.001;
                    });
                }
            }
        }
    }
    
    if (renderer && scene && camera) {
        renderer.render(scene, camera);
    }
}

function onWindowResize() {
    const mainContent = document.getElementById('main-content');
    if (!mainContent || mainContent.clientWidth === 0 || mainContent.clientHeight === 0) return;

    if (camera && renderer) {
        camera.aspect = mainContent.clientWidth / mainContent.clientHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(mainContent.clientWidth, mainContent.clientHeight);
    }
}

export { scene };
window.addEventListener('resize', onWindowResize, false);

// 앱 시작!
startApp();