import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import {
    Material,
    Mesh,
    Camera,
    Renderer,
    Scene,
    Object3D,
    Matrix4
} from 'three/webgpu';

/** 커스텀 opacity 저장을 위한 기즈모 머티리얼 인터페이스 */
export type GizmoMaterial = Material & {
    transparent: boolean;
    opacity: number;
    _opacity?: number;
    _pdeVisibleOpacity?: number;
};

/**
 * 기즈모 축별 원본 및 음수 방향 라인 세트
 */
export interface GizmoLineSet {
    original: Mesh[];
    negative: Mesh[];
}

export type GizmoPlaneDirection = '++' | '+-' | '-+' | '--';
export type GizmoPlaneName = 'XY' | 'YZ' | 'XZ';

/**
 * 기즈모 plane별 방향 variant 세트
 */
export interface GizmoPlaneSet {
    variants: Record<GizmoPlaneDirection, Mesh[]>;
}

/**
 * 전체 기즈모 라인 구조
 */
export interface GizmoLines {
    X: GizmoLineSet;
    Y: GizmoLineSet;
    Z: GizmoLineSet;
}

/**
 * 전체 기즈모 plane 구조
 */
export interface GizmoPlanes {
    XY: GizmoPlaneSet;
    YZ: GizmoPlaneSet;
    XZ: GizmoPlaneSet;
}

/**
 * 기즈모 설정 결과 인터페이스
 */
export interface GizmoSetupResult {
    transformControls: TransformControls;
    gizmoLines: GizmoLines;
    gizmoPlanes: GizmoPlanes;
}

export function createEmptyGizmoPlanes(): GizmoPlanes {
    const createPlaneSet = (): GizmoPlaneSet => ({
        variants: { '++': [], '+-': [], '-+': [], '--': [] }
    });

    return {
        XY: createPlaneSet(),
        YZ: createPlaneSet(),
        XZ: createPlaneSet()
    };
}

const planeNames = ['XY', 'YZ', 'XZ'] as const;
const planeDirections = ['++', '+-', '-+', '--'] as const;
const planeAxes: Record<GizmoPlaneName, ['X' | 'Y' | 'Z', 'X' | 'Y' | 'Z']> = {
    XY: ['X', 'Y'],
    YZ: ['Y', 'Z'],
    XZ: ['X', 'Z']
};

function getPlaneScale(planeName: GizmoPlaneName, direction: GizmoPlaneDirection): [number, number, number] {
    const scale: [number, number, number] = [1, 1, 1];
    const axes = planeAxes[planeName];
    axes.forEach((axis, index) => {
        const axisIndex = axis === 'X' ? 0 : axis === 'Y' ? 1 : 2;
        scale[axisIndex] = direction[index] === '+' ? 1 : -1;
    });
    return scale;
}

function clonePlaneVariant(originalPlane: Mesh, direction: GizmoPlaneDirection, visiblePlane: boolean): Mesh {
    const geometry = originalPlane.geometry.clone();
    const [scaleX, scaleY, scaleZ] = getPlaneScale(originalPlane.name as GizmoPlaneName, direction);
    geometry.applyMatrix4(new Matrix4().makeScale(scaleX, scaleY, scaleZ));

    const sourceMaterial = originalPlane.material as GizmoMaterial;
    const material = (originalPlane.material as Material).clone() as GizmoMaterial;
    if (visiblePlane) {
        material._pdeVisibleOpacity = sourceMaterial._pdeVisibleOpacity ?? sourceMaterial._opacity ?? sourceMaterial.opacity ?? 1;
        material.transparent = true;
        material._opacity = 0.001;
        material.opacity = 0.001;
    }

    const plane = new Mesh(geometry, material);
    plane.name = originalPlane.name;
    plane.renderOrder = originalPlane.renderOrder + 1;
    return plane;
}

/**
 * TransformControls를 초기화하고 음수 방향 보조 라인을 패치합니다.
 */
export function setupGizmo(
    camera: Camera,
    renderer: Renderer,
    scene: Scene
): GizmoSetupResult {
    const transformControls = new TransformControls(camera, renderer.domElement);
    transformControls.setMode('translate');
    transformControls.setSpace('world');
    transformControls.setColors(0xEF3751, 0x6FA21C, 0x437FD0, 0xfeff3e);

    const gizmoRoot = transformControls.getHelper();
    scene.add(gizmoRoot);

    const gizmoLines: GizmoLines = {
        X: { original: [], negative: [] },
        Y: { original: [], negative: [] },
        Z: { original: [], negative: [] }
    };
    const gizmoPlanes = createEmptyGizmoPlanes();

    try {
        // @ts-ignore - TransformControls 내부 gizmo 컨테이너 접근
        const gizmoContainer = gizmoRoot.children[0] as any;
        const processedLines = new Set<Object3D>();
        const processedGizmoPlanes = new Set<Object3D>();
        const processedPickerPlanes = new Set<Object3D>();

        ['translate', 'scale'].forEach(mode => {
            const modeGizmo = gizmoContainer.gizmo[mode];
            const modePicker = gizmoContainer.picker[mode];

            if (modeGizmo) {
                const originalLines: Mesh[] = [];
                modeGizmo.traverse((child: Object3D) => {
                    if ((child as Mesh).isMesh && (child.name === 'X' || child.name === 'Y' || child.name === 'Z')) {
                        if (!processedLines.has(child)) {
                            originalLines.push(child as Mesh);
                            processedLines.add(child);
                        }
                    }
                });

                originalLines.forEach(originalLine => {
                    const negativeGeometry = originalLine.geometry.clone();
                    if (originalLine.name === 'X') {
                        negativeGeometry.rotateY(Math.PI);
                    } else if (originalLine.name === 'Y') {
                        negativeGeometry.rotateX(Math.PI);
                    } else if (originalLine.name === 'Z') {
                        negativeGeometry.rotateY(Math.PI);
                    }

                    // 재질 독립성 확보를 위해 클론
                    originalLine.material = (originalLine.material as Material).clone();
                    const originalMaterial = originalLine.material as GizmoMaterial;

                    const negativeMaterial = originalMaterial.clone() as GizmoMaterial;
                    negativeMaterial.transparent = true;
                    negativeMaterial._opacity = 0.001; // 초기 투명 상태
                    negativeMaterial.opacity = 0.001;

                    originalMaterial.transparent = true;
                    originalMaterial._opacity = originalMaterial._opacity || 1;
                    originalMaterial.opacity = originalMaterial._opacity;

                    const negativeLine = new Mesh(negativeGeometry, negativeMaterial);
                    negativeLine.name = originalLine.name;
                    // 커스텀 불투명도 속성 동기화
                    (negativeLine.material as GizmoMaterial)._opacity = (negativeLine.material as GizmoMaterial)._opacity ?? (negativeLine.material as GizmoMaterial).opacity;
                    negativeLine.renderOrder = originalLine.renderOrder + 1;
                    
                    if (originalLine.parent) {
                        originalLine.parent.add(negativeLine);
                    }

                    const lineName = originalLine.name as keyof GizmoLines;
                    if (gizmoLines[lineName]) {
                        gizmoLines[lineName].original.push(originalLine);
                        gizmoLines[lineName].negative.push(negativeLine);
                    }
                });

                const originalPlanes: Mesh[] = [];
                modeGizmo.traverse((child: Object3D) => {
                    if ((child as Mesh).isMesh && planeNames.includes(child.name as GizmoPlaneName)) {
                        if (!processedGizmoPlanes.has(child)) {
                            originalPlanes.push(child as Mesh);
                            processedGizmoPlanes.add(child);
                        }
                    }
                });

                originalPlanes.forEach(originalPlane => {
                    originalPlane.material = (originalPlane.material as Material).clone();
                    const originalMaterial = originalPlane.material as GizmoMaterial;
                    const visibleOpacity = originalMaterial._opacity || originalMaterial.opacity || 1;
                    originalMaterial.transparent = true;
                    originalMaterial._pdeVisibleOpacity = visibleOpacity;
                    originalMaterial._opacity = visibleOpacity;
                    originalMaterial.opacity = originalMaterial._opacity;

                    const planeName = originalPlane.name as GizmoPlaneName;
                    gizmoPlanes[planeName].variants['++'].push(originalPlane);

                    planeDirections.forEach(direction => {
                        if (direction === '++') return;
                        const plane = clonePlaneVariant(originalPlane, direction, true);
                        if (originalPlane.parent) originalPlane.parent.add(plane);
                        gizmoPlanes[planeName].variants[direction].push(plane);
                    });
                });
            }

            if (modePicker) {
                const pickerPlanes: Mesh[] = [];
                modePicker.traverse((child: Object3D) => {
                    if ((child as Mesh).isMesh && planeNames.includes(child.name as GizmoPlaneName)) {
                        if (!processedPickerPlanes.has(child)) {
                            pickerPlanes.push(child as Mesh);
                            processedPickerPlanes.add(child);
                        }
                    }
                });

                pickerPlanes.forEach(originalPlane => {
                    planeDirections.forEach(direction => {
                        if (direction === '++') return;
                        const plane = clonePlaneVariant(originalPlane, direction, false);
                        if (originalPlane.parent) originalPlane.parent.add(plane);
                    });
                });
            }
        });
    } catch (error) {
        console.error('TransformControls gizmo patch (clone method) failed:', error);
    }

    return { transformControls, gizmoLines, gizmoPlanes };
}