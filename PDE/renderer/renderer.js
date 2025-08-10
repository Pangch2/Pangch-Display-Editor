import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';


let scene, camera, renderer, cube, controls;

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


// 커스텀 그리드 생성 함수
function createGrid(size = 10, divisions = 10, color = 0x3D3D3D, skipCenterLine = true) {
    const halfSize = size / 2;
    const step = size / divisions;

    const vertices = [];
    
    for (let i = -halfSize; i <= halfSize; i += step) {
        if (skipCenterLine && i === 0) continue; // 중심선 스킵

        // 수평선 (x 방향)
        vertices.push(-halfSize, 0, i, halfSize, 0, i);
        // 수직선 (z 방향)
        vertices.push(i, 0, -halfSize, i, 0, halfSize);
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));

    const material = new THREE.LineBasicMaterial({
        color: color,
        transparent: true,
        opacity: 0.5
    });

    return new THREE.LineSegments(geometry, material);
}



function init() {

    // 1. 장면(Scene)
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x1F1F1F); // 어두운 회색 배경

    // 2. 카메라(Camera)

    camera = new THREE.PerspectiveCamera(
        75,
        window.innerWidth / window.innerHeight,
        0.01,
        1000
    );
    camera.position.set(3, 3, 3);
    camera.lookAt(0, 0, 0);

    // 3. 렌더러(Renderer)
    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    document.body.appendChild(renderer.domElement);

    //카메라
    // 1. OrbitControls 생성
    controls = new OrbitControls(camera, renderer.domElement);
    
    // 2. 컨트롤 옵션 (선택사항)
    //controls.enableDamping = false; // 부드러운 움직임
    //controls.dampingFactor = 0.05;
    controls.screenSpacePanning = true;
    

    // 4. 조명(Lights)
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.8);
    scene.add(ambientLight);

    const dirLight = new THREE.DirectionalLight(0xffffff, 0.5);
    dirLight.position.set(5, 10, 7);
    scene.add(dirLight);

    // 5. 큐브(Object)
    //const geometry = new THREE.BoxGeometry();
    //const material = new THREE.MeshStandardMaterial({ color: 0x00ff00 });
    //cube = new THREE.Mesh(geometry, material);
    //scene.add(cube);

    // 6. 헬퍼(Helper)
    // 세부 격자
    const fineGrid = createGrid(10, 160, 0x2C2C2C, true);
    scene.add(fineGrid);
    // 큰 격자
    const customGrid = createGrid(10, 10, 0x3D3D3D, true);
    scene.add(customGrid);


    // 축
    const axes = createFullAxesHelper(150); // size: 150, radius, scaleY, scaleX
    scene.add(axes);

    // ===== lil-gui 기반 Custom UI =====
    // 화면 상단 전체에 고정된 상단 바 생성
    const topBar = document.createElement('div');
    topBar.style.position = 'fixed';
    topBar.style.top = '0';
    topBar.style.left = '0';
    topBar.style.width = '100vw';
    topBar.style.height = '3vh'; // 얇은 바 (조정 가능)
    topBar.style.background = '#161616';
    topBar.style.zIndex = '1001'; // customPanel보다 위에 표시되도록
    document.body.appendChild(topBar);

    // 오른쪽 패널 생성
    const customPanel = document.createElement('div');
    customPanel.style.position = 'fixed';
    customPanel.style.top = '3vh'; // 상단 바 바로 아래
    customPanel.style.right = '0';
    customPanel.style.width = '10vw';
    customPanel.style.height = '97vh'; // 나머지 화면을 채움
    customPanel.style.background = '#161616';
    customPanel.style.borderTopLeftRadius = '2px';
    customPanel.style.borderBottomLeftRadius = '2px';
    customPanel.style.zIndex = '1000';
    document.body.appendChild(customPanel);

    // 8. 렌더링 시작
    animate();
}

function animate() {
    //카메라
    controls.update();
    requestAnimationFrame(animate);

    // 큐브 회전
    //cube.rotation.x += 0.01;
    //cube.rotation.y += 0.01;

    renderer.render(scene, camera);
}
function resizeRendererArea() {
    const width = window.innerWidth * 0.9; // 오른쪽 10% 제외
    const height = window.innerHeight * 0.97; // 상단 3% 제외
    const x = 0;
    const y = window.innerHeight * 0.03;

    renderer.setSize(window.innerWidth, window.innerHeight); // 전체 사이즈 설정
    renderer.setViewport(x, y, width, height);
    renderer.setScissor(x, y, width, height);
    
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
}

function onWindowResize() {
    resizeRendererArea();
}


window.addEventListener('resize', onWindowResize, false);
init();
resizeRendererArea();