import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { ViewHelper } from 'three/examples/jsm/helpers/ViewHelper.js';
import { initGizmo } from './controls/gizmo/gizmo';
import type { InitGizmoResult, OrbitControlsLike } from './controls/gizmo/gizmo';
import {
    Group,
    BufferGeometry,
    LineBasicMaterial,
    Line,
    Vector3,
    Scene,
    Color,
    Camera,
    PerspectiveCamera,
    OrthographicCamera,
    WebGPURenderer,
    GridHelper,
    Renderer,
    Object3D,
    Clock,
    CanvasTexture,
    SpriteMaterial,
    SRGBColorSpace
} from 'three/webgpu';
import { initAssets } from './asset-manager';
import { loadedObjectGroup } from './load-project/upload-pbde';
import { openWithAnimation, closeWithAnimation } from './ui/ui-open-close';
import './ui/scene-panel';
import './ui/panel-layout';
import './ui/object-properties';

// 전역 변수로 선언
let scene: Scene;
let camera: Camera;
let renderer: WebGPURenderer;
let controls: OrbitControls;
let viewHelper: ViewHelper;
let floorGrid: Group;
let zSymbol: Group;
let viewHelperWasAnimating = false;
let cameraTypeBeforeViewHelper: 'perspective' | 'orthographic' | null = null;
let perspectiveDistanceBeforeOrthographic: number | null = null;
let gizmoModule: InitGizmoResult | null = null;
type GpuQueueLike = { onSubmittedWorkDone?: () => Promise<void> };
type WebGpuRendererWithBackend = { backend?: { device?: { queue?: GpuQueueLike } } };
type WebGpuRendererWithPipelines = { _pipelines?: { caches?: { size?: number } } };
type NodeBuilderLike = {
    object?: { instanceMatrix?: { array?: unknown } };
    getUniformFromNode: (node: { value?: unknown }, type: string, shaderStage: string, name?: string | null) => unknown;
};
type WebGpuBackendWithNodeBuilder = {
    createNodeBuilder?: (object: Object3D, renderer: Renderer) => NodeBuilderLike;
};
type ScenePrecompileTrace = {
    available: boolean;
    profileEnabled: boolean;
    compileMs: number;
    profileMs: number;
    fullCompileMs: number;
    gpuQueueWaitMs: number;
    pipelineCacheBefore: number;
    pipelineCacheAfter: number;
    objectTraces: ScenePrecompileObjectTrace[];
};
type ScenePrecompileObjectTrace = {
    index: number;
    name: string;
    compileMs: number;
    instanceCount: number;
    materialCount: number;
    attributeKey: string;
    vertexCount: number;
};
type RenderSettledFrameTrace = {
    index: number;
    frameIntervalMs: number;
    renderCpuMs: number;
    gpuQueueWaitMs: number;
    gpuQueueAvailable: boolean;
};
type RenderSettledTrace = {
    requestedFrames: number;
    renderedFrames: number;
    frameWaitMs: number;
    gpuWaitMs: number;
    totalMs: number;
    frameIntervalsMs: number[];
    frameTraces: RenderSettledFrameTrace[];
    gpuQueueAvailable: boolean;
    pipelineCacheBefore: number;
    pipelineCacheAfter: number;
};
type RenderSettledRequest = {
    requestedFrames: number;
    framesRemaining: number;
    renderedFrames: number;
    startMs: number;
    lastFrameEndMs: number;
    traceFrames: boolean;
    waitForGpu: boolean;
    frameTraces: RenderSettledFrameTrace[];
    queueWaitPromises: Promise<void>[];
    pipelineCacheBefore: number;
    resolve: (trace: RenderSettledTrace) => void;
};
const renderSettledRequests = new Set<RenderSettledRequest>();
let scenePrecompileInProgress = false;

window.addEventListener('pde:get-camera-state', (event: Event) => {
    if (!camera || !controls) return;
    const detail = (event as CustomEvent<{ state?: { position: [number, number, number]; target: [number, number, number]; zoom: number } }>).detail;
    detail.state = {
        position: camera.position.toArray(),
        target: controls.target.toArray(),
        zoom: camera.zoom
    };
});

window.addEventListener('pde:set-camera-state', (event: Event) => {
    if (!camera || !controls) return;
    const state = (event as CustomEvent<{ position: [number, number, number]; target: [number, number, number]; zoom: number }>).detail;
    camera.position.fromArray(state.position);
    controls.target.fromArray(state.target);
    camera.zoom = state.zoom;
    camera.updateProjectionMatrix();
    controls.update();
});

window.addEventListener('pde:precompile-scene', (event: Event) => {
    const detail = (event as CustomEvent<{ resolve?: (trace: ScenePrecompileTrace) => void }>).detail;
    if (!detail || typeof detail.resolve !== 'function') return;
    precompileScene().then(detail.resolve, () => {
        detail.resolve({ available: false, profileEnabled: false, compileMs: 0, profileMs: 0, fullCompileMs: 0, gpuQueueWaitMs: 0, pipelineCacheBefore: -1, pipelineCacheAfter: -1, objectTraces: [] });
    });
});

window.addEventListener('pde:wait-render-settled', (event: Event) => {
    const detail = (event as CustomEvent<{ frames?: number; traceFrames?: boolean; waitForGpu?: boolean; resolve?: (trace: RenderSettledTrace) => void }>).detail;
    if (!detail || typeof detail.resolve !== 'function') return;
    const requestedFrames = Math.max(1, detail.frames ?? 3);

    renderSettledRequests.add({
        requestedFrames,
        framesRemaining: requestedFrames,
        renderedFrames: 0,
        startMs: performance.now(),
        lastFrameEndMs: performance.now(),
        traceFrames: detail.traceFrames === true,
        waitForGpu: detail.waitForGpu === true,
        frameTraces: [],
        queueWaitPromises: [],
        pipelineCacheBefore: getPipelineCacheSize(),
        resolve: detail.resolve
    });
});

function getPipelineCacheSize(): number {
    const size = (renderer as unknown as WebGpuRendererWithPipelines)?._pipelines?.caches?.size;
    return typeof size === 'number' ? size : -1;
}

function stabilizeInstancedMatrixBindingNames(): void {
    const backend = (renderer as unknown as { backend?: WebGpuBackendWithNodeBuilder }).backend;
    const createNodeBuilder = backend?.createNodeBuilder;
    if (!backend || !createNodeBuilder) return;

    backend.createNodeBuilder = function (object, currentRenderer) {
        const builder = createNodeBuilder.call(this, object, currentRenderer);
        const prototype = Object.getPrototypeOf(builder) as NodeBuilderLike;
        const getUniformFromNode = prototype.getUniformFromNode;
        prototype.getUniformFromNode = function (node, type, shaderStage, name = null) {
            const instanceMatrix = this.object?.instanceMatrix;
            const stableName = (type === 'buffer' && node.value === instanceMatrix?.array)
                || (type === 'storageBuffer' && node.value === instanceMatrix)
                ? 'pdeInstanceMatrix'
                : name;
            return getUniformFromNode.call(this, node, type, shaderStage, stableName);
        };
        backend.createNodeBuilder = createNodeBuilder;
        return builder;
    };
}

async function precompileScene(): Promise<ScenePrecompileTrace> {
    if (!renderer || !scene || !camera || typeof renderer.compileAsync !== 'function') {
        return { available: false, profileEnabled: false, compileMs: 0, profileMs: 0, fullCompileMs: 0, gpuQueueWaitMs: 0, pipelineCacheBefore: -1, pipelineCacheAfter: -1, objectTraces: [] };
    }

    const profileEnabled = localStorage.getItem('pdePrecompileProfile') === '1';
    const pipelineCacheBefore = getPipelineCacheSize();
    const compileStartMs = performance.now();
    scenePrecompileInProgress = true;
    const objectTraces: ScenePrecompileObjectTrace[] = [];
    let profileMs = 0;
    let fullCompileMs = 0;
    try {
        if (profileEnabled) {
            const profileStartMs = performance.now();
            objectTraces.push(...await profileLoadedObjectPrecompile());
            profileMs = performance.now() - profileStartMs;
        }

        const fullCompileStartMs = performance.now();
        await renderer.compileAsync(scene, camera);
        fullCompileMs = performance.now() - fullCompileStartMs;
    } finally {
        scenePrecompileInProgress = false;
    }
    const compileMs = performance.now() - compileStartMs;
    const pipelineCacheAfter = getPipelineCacheSize();

    const queue = (renderer as unknown as WebGpuRendererWithBackend).backend?.device?.queue;
    const queueDone = queue?.onSubmittedWorkDone;
    if (typeof queueDone !== 'function') {
        return { available: true, profileEnabled, compileMs, profileMs, fullCompileMs, gpuQueueWaitMs: 0, pipelineCacheBefore, pipelineCacheAfter, objectTraces };
    }

    const queueStartMs = performance.now();
    try {
        await queueDone.call(queue);
    } catch {
        // Timing aid only; load flow should continue if the backend rejects the wait.
    }

    return {
        available: true,
        profileEnabled,
        compileMs,
        profileMs,
        fullCompileMs,
        gpuQueueWaitMs: performance.now() - queueStartMs,
        pipelineCacheBefore,
        pipelineCacheAfter,
        objectTraces
    };
}

async function profileLoadedObjectPrecompile(): Promise<ScenePrecompileObjectTrace[]> {
    if (!renderer || !scene || !camera || loadedObjectGroup.children.length === 0) return [];

    const sceneVisibility = scene.children.map(child => ({ child, visible: child.visible }));
    const loadedVisibility = loadedObjectGroup.children.map(child => ({ child, visible: child.visible }));
    const traces: ScenePrecompileObjectTrace[] = [];

    try {
        for (const child of scene.children) {
            child.visible = child === loadedObjectGroup;
        }
        for (const child of loadedObjectGroup.children) {
            child.visible = false;
        }

        for (let i = 0; i < loadedObjectGroup.children.length; i++) {
            const child = loadedObjectGroup.children[i];
            child.visible = true;
            const startMs = performance.now();
            await renderer.compileAsync(scene, camera);
            traces.push(createPrecompileObjectTrace(child, i, performance.now() - startMs));
            child.visible = false;
        }
    } finally {
        for (const entry of sceneVisibility) {
            entry.child.visible = entry.visible;
        }
        for (const entry of loadedVisibility) {
            entry.child.visible = entry.visible;
        }
    }

    return traces;
}

function createPrecompileObjectTrace(object: Object3D, index: number, compileMs: number): ScenePrecompileObjectTrace {
    const meshLike = object as Object3D & {
        geometry?: { attributes?: Record<string, unknown>; getAttribute?: (name: string) => { count?: number } | undefined };
        material?: unknown;
        count?: number;
    };
    const attributes = meshLike.geometry?.attributes ?? {};
    const material = meshLike.material;
    const materialCount = Array.isArray(material) ? material.length : material ? 1 : 0;
    const position = meshLike.geometry?.getAttribute?.('position');

    return {
        index,
        name: object.name || object.type || 'Object3D',
        compileMs,
        instanceCount: typeof meshLike.count === 'number' ? meshLike.count : 0,
        materialCount,
        attributeKey: Object.keys(attributes).sort().join('+') || '-',
        vertexCount: typeof position?.count === 'number' ? position.count : 0
    };
}

function resolveRenderSettledRequests(renderStartMs: number, renderEndMs: number): void {
    if (!renderer || renderSettledRequests.size === 0) return;

    const queue = (renderer as unknown as WebGpuRendererWithBackend).backend?.device?.queue;
    const queueDone = queue?.onSubmittedWorkDone;
    const hasQueue = typeof queueDone === 'function';

    for (const request of [...renderSettledRequests]) {
        request.renderedFrames++;
        if (request.traceFrames) {
            request.frameTraces.push({
                index: request.renderedFrames,
                frameIntervalMs: renderEndMs - request.lastFrameEndMs,
                renderCpuMs: renderEndMs - renderStartMs,
                gpuQueueWaitMs: 0,
                gpuQueueAvailable: hasQueue
            });
        }
        request.lastFrameEndMs = renderEndMs;

        if (request.waitForGpu && hasQueue) {
            const frameTrace = request.frameTraces[request.frameTraces.length - 1];
            const queueWaitStartMs = performance.now();
            request.queueWaitPromises.push(
                queueDone.call(queue).then(
                    () => {
                        if (frameTrace) frameTrace.gpuQueueWaitMs = performance.now() - queueWaitStartMs;
                    },
                    () => {
                        if (frameTrace) frameTrace.gpuQueueWaitMs = performance.now() - queueWaitStartMs;
                    }
                )
            );
        }

        request.framesRemaining--;
        if (request.framesRemaining > 0) continue;

        renderSettledRequests.delete(request);
        const frameWaitMs = renderEndMs - request.startMs;
        const resolveWithTrace = () => {
            const totalMs = performance.now() - request.startMs;
            request.resolve({
                requestedFrames: request.requestedFrames,
                renderedFrames: request.renderedFrames,
                frameWaitMs,
                gpuWaitMs: totalMs - frameWaitMs,
                totalMs,
                frameIntervalsMs: request.frameTraces.map(trace => trace.frameIntervalMs),
                frameTraces: request.frameTraces,
                gpuQueueAvailable: request.waitForGpu && hasQueue,
                pipelineCacheBefore: request.pipelineCacheBefore,
                pipelineCacheAfter: getPipelineCacheSize()
            });
        };

        if (request.queueWaitPromises.length > 0) {
            Promise.allSettled(request.queueWaitPromises).then(resolveWithTrace, resolveWithTrace);
        } else {
            resolveWithTrace();
        }
    }
}

// 앱 시작 로직을 비동기 함수로 감싸기
async function startApp(): Promise<void> {
  // --- 1. 로딩 화면 준비 ---
  const loadingOverlay = document.getElementById('loading-overlay');
  const loadingIcon = document.getElementById('loading-icon') as HTMLImageElement;

  if (!loadingOverlay || !loadingIcon) return;

  // 메인 프로세스로부터 아이콘 Data URL 받아오기
  const iconResult = await window.ipcApi.getLoadingIcon?.();
  if (iconResult && iconResult.success && iconResult.dataUrl) {
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
    const loadingText = document.getElementById('loading-text');
    if (loadingText) loadingText.textContent = '에셋 로딩 실패!';
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
function createFullAxesHelper(size: number = 50): Group {
    const axesGroup = new Group();

    const createAxisLine = (start: Vector3, end: Vector3, color: number): Line => {
        const geometry = new BufferGeometry().setFromPoints([start, end]);
        const material = new LineBasicMaterial({ color: color });
        return new Line(geometry, material);
    };

    // === X축 (빨강)
    axesGroup.add(createAxisLine(
        new Vector3(-size / 2, 0, 0),
        new Vector3(size / 2, 0, 0),
        0xEF3751
    ));

    // === Y축 (초록)
    axesGroup.add(createAxisLine(
        new Vector3(0, -size / 2, 0),
        new Vector3(0, size / 2, 0),
        0x6FA21C
    ));

    // === Z축 (파랑)
    axesGroup.add(createAxisLine(
        new Vector3(0, 0, -size / 2),
        new Vector3(0, 0, size / 2),
        0x437FD0
    ));
    return axesGroup;
}

// 'Z>' 모양을 XZ 평면(바닥) 위에 그리는 헬퍼
function createZGreaterSymbol(position: Vector3 = new Vector3(0.5, 0, 0.5), size: number = 0.5, color: number = 0x515151): Group {
    const group = new Group();
    group.position.copy(position);

    const material = new LineBasicMaterial({ color });

    const s = size;
    const half = s / 2;
    const gap = s * 0.15;           // Z와 > 사이 간격
    const arrowWidth = s * 0.45;    // > 화살표 가로 길이

    const addLine = (ax: number, az: number, bx: number, bz: number): void => {
        const geometry = new BufferGeometry().setFromPoints([
            new Vector3(ax, 0, az),
            new Vector3(bx, 0, bz)
        ]);
        const line = new Line(geometry, material);
        group.add(line);
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

async function initScene(): Promise<void> {
    // 1. 장면(Scene)
    scene = new Scene();
    scene.background = new Color(0x1F1F1F); // 어두운 회색 배경
    scene.add(loadedObjectGroup); // 로드된 객체 그룹을 씬에 추가

    // 2. 카메라(Camera)
    const mainContent = document.getElementById('main-content');
    if (!mainContent) return;

    camera = new PerspectiveCamera(
        80,
        mainContent.clientWidth / mainContent.clientHeight,
        0.05,
        1000
    );
    camera.position.set(3, 3, 3);
    camera.lookAt(0, 0, 0);

    // 3. 렌더러(Renderer)
    renderer = new WebGPURenderer({
        canvas: document.querySelector('#renderCanvas') as HTMLCanvasElement,
        logarithmicDepthBuffer: true
    });
    renderer.setSize(mainContent.clientWidth, mainContent.clientHeight);
    await renderer.init();
    stabilizeInstancedMatrixBindingNames();

    // 4. 컨트롤(Controls)
    controls = new OrbitControls(camera, renderer.domElement);
    controls.screenSpacePanning = true;

    initCameraContextMenu();

    viewHelper = new ViewHelper(camera, renderer.domElement);
    viewHelper.setLabels('X', 'Y', 'Z');
    const viewHelperAxisColors = { X: '#EF3751', Y: '#6FA21C', Z: '#437FD0' };
    viewHelper.children.forEach((child, index) => {
        const type = String(child.userData.type);
        const axis = type.slice(-1) as keyof typeof viewHelperAxisColors;
        if (index < 3) {
            const axisLine = child as Object3D & { geometry: BufferGeometry; material: { color: Color; opacity: number; transparent: boolean } };
            const material = axisLine.material;
            material.color.set(viewHelperAxisColors[['X', 'Z', 'Y'][index] as keyof typeof viewHelperAxisColors]);
            material.opacity = 0.8;
            material.transparent = true;
            return;
        }

        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 128;
        const context = canvas.getContext('2d')!;
        context.fillStyle = viewHelperAxisColors[axis];
        context.beginPath();
        context.arc(64, 64, 28, 0, Math.PI * 2);
        context.fill();
        if (type.startsWith('pos')) {
            context.font = '48px Arial';
            context.textAlign = 'center';
            context.fillStyle = '#000000';
            context.fillText(axis, 64, 82);
        }

        const texture = new CanvasTexture(canvas);
        texture.colorSpace = SRGBColorSpace;
        (child as Object3D & { material: SpriteMaterial }).material = new SpriteMaterial({ map: texture, opacity: 0.8, transparent: true, toneMapped: false });
    });
    renderer.domElement.addEventListener('pointerup', event => {
        if (event.button !== 0) return;
        viewHelperWasAnimating = viewHelper.handleClick(event);
        if (viewHelperWasAnimating) {
            cameraTypeBeforeViewHelper ??= camera.isPerspectiveCamera ? 'perspective' : 'orthographic';
            setCameraType('orthographic');
            zSymbol.visible = false;
        }
    });
    let leftPointerDownPosition = { x: 0, y: 0 };
    renderer.domElement.addEventListener('pointerdown', event => {
        if (event.button === 0) leftPointerDownPosition = { x: event.clientX, y: event.clientY };
    });
    renderer.domElement.addEventListener('pointermove', event => {
        if ((event.buttons & 1) && Math.hypot(event.clientX - leftPointerDownPosition.x, event.clientY - leftPointerDownPosition.y) > 5) {
            if (cameraTypeBeforeViewHelper) {
                setCameraType(cameraTypeBeforeViewHelper);
                cameraTypeBeforeViewHelper = null;
            }
            floorGrid.rotation.set(0, 0, 0);
            zSymbol.visible = true;
        }
    });

    // Initialize gizmo module after creating controls
    gizmoModule = initGizmo({ 
        scene, 
        camera, 
        renderer: renderer as unknown as Renderer, 
        controls: controls as unknown as OrbitControlsLike, 
        loadedObjectGroup, 
        setControls: (c: OrbitControlsLike) => { controls = c as unknown as OrbitControls; } 
    });

    // 8. 헬퍼(Helper)
    const axes = createFullAxesHelper(150);
    axes.renderOrder = 1;
    scene.add(axes);

    const detailGrid = new GridHelper(20, 320, 0x2C2C2C, 0x2C2C2C);
    detailGrid.renderOrder = -2; 

    const Grid = new GridHelper(20, 20, 0x3D3D3D, 0x3D3D3D);
    Grid.renderOrder = -1; 
    zSymbol = createZGreaterSymbol(new Vector3(0.5, 0, -0.25), 0.125, 0x515151);
    zSymbol.renderOrder = 10;
    floorGrid = new Group();
    floorGrid.add(detailGrid, Grid, zSymbol);
    scene.add(floorGrid);
    
    [detailGrid, Grid].forEach(helper => {
        const materials = Array.isArray(helper.material) ? helper.material : [helper.material];
        materials.forEach(m => { (m as any).depthWrite = false; });
    });
}

function setCameraType(type: 'perspective' | 'orthographic'): void {
    if ((type === 'perspective') === camera.isPerspectiveCamera) return;

    const mainContent = document.getElementById('main-content')!;
    const aspect = mainContent.clientWidth / mainContent.clientHeight;
    const position = camera.position.clone();
    const quaternion = camera.quaternion.clone();
    const distance = position.distanceTo(controls.target);
    const halfHeight = Math.max(distance * Math.tan(40 * Math.PI / 180), 10.5);
    const nextCamera = type === 'perspective'
        ? new PerspectiveCamera(80, aspect, 0.05, 1000)
        : new OrthographicCamera(-halfHeight * aspect, halfHeight * aspect, halfHeight, -halfHeight, 0.05, 1000);

    if (type === 'orthographic') {
        perspectiveDistanceBeforeOrthographic = distance;
        position.sub(controls.target).setLength(Math.max(distance, 20)).add(controls.target);
    } else if (perspectiveDistanceBeforeOrthographic !== null) {
        position.sub(controls.target).setLength(perspectiveDistanceBeforeOrthographic).add(controls.target);
        perspectiveDistanceBeforeOrthographic = null;
    }
    nextCamera.position.copy(position);
    nextCamera.quaternion.copy(quaternion);
    camera = nextCamera;
    controls.object = camera;
    viewHelper.camera = camera;
    gizmoModule?.setCamera(camera);
    camera.updateProjectionMatrix();
    controls.update();
}

function initCameraContextMenu(): void {
    const menu = document.createElement('div');
    let pointerDownPosition = { x: 0, y: 0 };
    menu.className = 'camera-context-menu';
    menu.hidden = true;
    menu.innerHTML = `<div class="camera-menu-parent"><span class="lucide-icon">&#xE17C;</span>카메라<span class="camera-menu-arrow">›</span><div class="camera-submenu"><button data-camera="perspective"><span class="lucide-icon">&#xE064;</span>원근 카메라</button><button data-camera="orthographic"><span class="lucide-icon">&#xE064;</span>직교 카메라</button></div></div>`;
    document.body.appendChild(menu);
    const closeMenu = (): void => {
        if (menu.hidden) return;
        void closeWithAnimation(menu).then(() => {
            if (menu.style.animation.startsWith('uiClose')) menu.hidden = true;
        });
    };

    renderer.domElement.addEventListener('pointerdown', event => {
        if (event.button === 2) pointerDownPosition = { x: event.clientX, y: event.clientY };
    });
    renderer.domElement.addEventListener('contextmenu', event => {
        event.preventDefault();
        if (Math.hypot(event.clientX - pointerDownPosition.x, event.clientY - pointerDownPosition.y) > 5) return;
        menu.hidden = false;
        menu.style.left = `${Math.min(event.clientX, innerWidth - menu.offsetWidth)}px`;
        menu.style.top = `${Math.min(event.clientY, innerHeight - menu.offsetHeight)}px`;
        openWithAnimation(menu);
    });
    menu.addEventListener('click', event => {
        const button = (event.target as Element).closest<HTMLButtonElement>('[data-camera]');
        if (!button) return;
        setCameraType(button.dataset.camera as 'perspective' | 'orthographic');
        closeMenu();
    });
    window.addEventListener('pointerdown', event => {
        if (!menu.contains(event.target as Node)) closeMenu();
    });
}

//fps표시용1
let lastTime = performance.now();
let frameCount = 0;
const fpsCounterElement = document.getElementById('fps-counter');
const viewHelperClock = new Clock();

function animate(): void {
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
    
    // Update gizmo: overlay and axis orientation
    if (gizmoModule) gizmoModule.updateGizmo();
    if (renderer && scene && camera && !scenePrecompileInProgress) {
        viewHelper.center.copy(controls.target);
        if (viewHelper.animating) viewHelper.update(viewHelperClock.getDelta());
        else viewHelperClock.getDelta();
        if (viewHelperWasAnimating && !viewHelper.animating) {
            const direction = camera.position.clone().sub(controls.target).normalize().round();
            floorGrid.rotation.set(Math.abs(direction.z) * Math.PI / 2, 0, -Math.abs(direction.x) * Math.PI / 2);
            viewHelperWasAnimating = false;
        }
        const renderStartMs = performance.now();
        renderer.render(scene, camera);
        renderer.autoClear = false;
        viewHelper.render(renderer);
        renderer.autoClear = true;
        resolveRenderSettledRequests(renderStartMs, performance.now());
    }
}

function onWindowResize(): void {
    const mainContent = document.getElementById('main-content');
    if (!mainContent || mainContent.clientWidth === 0 || mainContent.clientHeight === 0) return;

    if (camera && renderer) {
        const aspect = mainContent.clientWidth / mainContent.clientHeight;
        if (camera.isPerspectiveCamera) camera.aspect = aspect;
        else if (camera.isOrthographicCamera) {
            const halfHeight = (camera.top - camera.bottom) / 2;
            camera.left = -halfHeight * aspect;
            camera.right = halfHeight * aspect;
        }
        camera.updateProjectionMatrix();
        renderer.setSize(mainContent.clientWidth, mainContent.clientHeight);
        if (scene && !scenePrecompileInProgress) {
            renderer.render(scene, camera);
            renderer.autoClear = false;
            viewHelper.render(renderer);
            renderer.autoClear = true;
        }
    }
}

export { scene };
window.addEventListener('resize', onWindowResize, false);

// 앱 시작!
startApp();
