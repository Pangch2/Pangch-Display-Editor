import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import * as THREE from 'three/webgpu';
import { initAssets } from './asset-manager.js';
import { loadedObjectGroup } from './upload-pbde.js';
import { openWithAnimation, closeWithAnimation } from './ui-open-close.js';

// 전역 변수로 선언
let scene, camera, renderer, controls;

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

  // --- 임시 코드: requiredPrefixes 접근 및 파일 접근 테스트 ---
  try {
    const prefixes = await window.ipcApi.getRequiredPrefixes();
    console.log('✅ Received required prefixes:', prefixes);

    if (Array.isArray(prefixes) && prefixes.length > 0) {
      // 테스트용으로 첫 번째 프리픽스와 임의의 파일 이름을 조합
      const testAssetPath = `${prefixes[0]}acacia_boat.json`;
      console.log(`'${testAssetPath}'에 대한 접근을 시도합니다...`);

      // testAssetPath가 문자열인지 확인
      if (typeof testAssetPath === 'string') {
        const result = await window.ipcApi.getAssetContent(testAssetPath);
        if (result.success) {
          console.log(`✅ Success: Asset content received for ${testAssetPath}.`);
        } else {
          console.warn(`⚠️  Could not access asset '${testAssetPath}': ${result.error}`);
        }
      } else {
        console.error('❌ testAssetPath is not a string:', testAssetPath);
      }
    }
  } catch (error) {
    console.error('❌ Failed to test asset access:', error);
  }
  // --- 임시 코드 끝 ---

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
// position: 중심 위치(Vector3), size: 전체 높이/폭 스칼라, color: 라인 색상
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


    // 6. 헬퍼(Helper)
    const axes = createFullAxesHelper(150);
    axes.renderOrder = 1;
    scene.add(axes);

    const detailGrid = new THREE.GridHelper(20, 320, 0x2C2C2C, 0x2C2C2C);
    detailGrid.renderOrder = -2; // 큐브보다 먼저 그리기
    scene.add(detailGrid);

    const Grid = new THREE.GridHelper(20, 20, 0x3D3D3D, 0x3D3D3D);
    Grid.renderOrder = -1; // 큐브보다 먼저 그리기
    scene.add(Grid);
    
    // 그림자 비활성화(문제생기면 끄기)
    renderer.shadowMap.enabled = false;
    

    // 격자 라인이 깊이 버퍼를 덮지 않도록 하여 뒤에 있도록 (큐브가 항상 위에)
    [detailGrid, Grid].forEach(helper => {
        const materials = Array.isArray(helper.material) ? helper.material : [helper.material];
        materials.forEach(m => { m.depthWrite = false; });
    });

    // 7. 사용자 정의 기호(Z>): 격자 위 (0.5, 0, -0.25) 위치에 'Z>' 모양 라인 추가
    const zSymbol = createZGreaterSymbol(new THREE.Vector3(0.5, 0, -0.25), 0.125, 0x515151);
    zSymbol.renderOrder = 10; // 그리드/객체 위로 UI 표시성 높임
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

    if (controls) controls.update();
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