import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import * as THREE from 'three/webgpu'
import { initAssets } from './asset-manager.js';
import { loadedObjectGroup } from './upload-pbde.js';

let scene, camera, renderer, controls;

// XYZ 축을 양/음 방향으로 모두 표시하는 헬퍼
function createFullAxesHelper(size = 50) {
    const axesGroup = new THREE.Group();

    const createAxisLine = (start, end, color) => {
        const geometry = new THREE.BufferGeometry().setFromPoints([start, end]);
        const material = new THREE.LineBasicMaterial({ color: color , depthTest: false, depthWrite: false });
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



async function init() {

    // 에셋 초기화 (캐시 확인 및 다운로드 요청)
    await initAssets();

    // 1. 장면(Scene)
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x1F1F1F); // 어두운 회색 배경
    scene.add(loadedObjectGroup); // 로드된 객체 그룹을 씬에 추가

    // 2. 카메라(Camera)

    camera = new THREE.PerspectiveCamera(
        80,
        window.innerWidth / window.innerHeight,
        0.05,
        1000
    );
    camera.position.set(3, 3, 3);
    camera.lookAt(0, 0, 0);

    // 3. 렌더러(Renderer)
    renderer = new THREE.WebGPURenderer({
        //antialias: true,
        canvas: document.querySelector('#renderCanvas'),
        logarithmicDepthBuffer: true // ✨ 깊이 정밀도 문제 해결을 위한 옵션
        });
    renderer.setSize(window.innerWidth, window.innerHeight);
    await renderer.init();
    // document.body.appendChild(renderer.domElement);

    //카메라
    // 1. OrbitControls 생성
    controls = new OrbitControls(camera, renderer.domElement);
    
    // 2. 컨트롤 옵션 (선택사항)
    //controls.enableDamping = false; // 부드러운 움직임
    //controls.dampingFactor = 0.05;
    controls.screenSpacePanning = true;
    

    // 4. 조명(Lights)
    const ambientLight = new THREE.AmbientLight(0x6c6c6c, 2.83);
    scene.add(ambientLight);

    const dirLight1 = new THREE.DirectionalLight(0x6c6c6c, 7.7);
    dirLight1.position.set(0, 0, 100);
    scene.add(dirLight1);

    const dirLight2 = new THREE.DirectionalLight(0x6c6c6c, 7.7);
    dirLight2.position.set(0, 0, -100);
    scene.add(dirLight2);

    const dirLight3 = new THREE.DirectionalLight(0x6c6c6c, 15.0);
    dirLight3.position.set(0, 100, 0);
    scene.add(dirLight3);
    
    // 6. 헬퍼(Helper)
    // 축
    const axes = createFullAxesHelper(150); // size: 150, radius, scaleY, scaleX
    axes.renderOrder = 1; // 축 렌더 순서 설정
    scene.add(axes);

    // 세부 격자 - 기본 GridHelper로 대체
    const detailGrid = new THREE.GridHelper(20, 320, 0x2C2C2C, 0x2C2C2C);
    detailGrid.renderOrder = 0;
    scene.add(detailGrid);
        
    // 큰 격자 - 기본 GridHelper로 대체
    const Grid = new THREE.GridHelper(20, 20, 0x3D3D3D, 0x3D3D3D);
    Grid.renderOrder = 2;
    scene.add(Grid);

    // 8. 렌더링 시작
    animate();
}

function animate() {
    //카메라
    controls.update();
    requestAnimationFrame(animate);
    renderer.render(scene, camera);
}

function onWindowResize() {
    const mainContent = document.getElementById('main-content');
    if (!mainContent || mainContent.clientWidth === 0 || mainContent.clientHeight === 0) return;

    // camera와 renderer가 초기화되었는지 확인
    if (camera && renderer) {
        camera.aspect = mainContent.clientWidth / mainContent.clientHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(mainContent.clientWidth, mainContent.clientHeight);
    }
}

export { scene };
window.addEventListener('resize', onWindowResize, false);

// init()이 완료된 후 onWindowResize를 호출하도록 수정
init().then(() => {
    onWindowResize(); // 초기 로드 시 뷰포트 크기 강제 조정
});
