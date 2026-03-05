import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import * as THREE from 'three/webgpu';

/**
 * 기즈모 축별 원본 및 음수 방향 라인 세트
 */
export interface GizmoLineSet {
    original: THREE.Mesh[];
    negative: THREE.Mesh[];
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
 * 기즈모 설정 결과 인터페이스
 */
export interface GizmoSetupResult {
    transformControls: TransformControls;
    gizmoLines: GizmoLines;
}

/**
 * TransformControls를 초기화하고 음수 방향 보조 라인을 패치합니다.
 */
export function setupGizmo(
    camera: THREE.Camera,
    renderer: THREE.Renderer,
    scene: THREE.Scene
): GizmoSetupResult {
    const transformControls = new TransformControls(camera, (renderer as any).domElement || (renderer as any).canvas);
    transformControls.setMode('translate');
    transformControls.setSpace('world');
    transformControls.setColors(0xEF3751, 0x6FA21C, 0x437FD0, 0xfeff3e);
    
    // Mandate: TransformControls 사용 시 반드시 getHelper()를 씬에 추가
    scene.add(transformControls.getHelper());

    const gizmoLines: GizmoLines = {
        X: { original: [], negative: [] },
        Y: { original: [], negative: [] },
        Z: { original: [], negative: [] }
    };

    try {
        const gizmoRoot = transformControls.getHelper();
        // @ts-ignore - TransformControls 내부 gizmo 컨테이너 접근
        const gizmoContainer = gizmoRoot.children[0] as any;
        const processedMeshes = new Set<THREE.Object3D>();

        ['translate', 'scale'].forEach(mode => {
            const modeGizmo = gizmoContainer.gizmo[mode];
            if (modeGizmo) {
                const originalLines: THREE.Mesh[] = [];
                modeGizmo.traverse((child: THREE.Object3D) => {
                    if ((child as THREE.Mesh).isMesh && (child.name === 'X' || child.name === 'Y' || child.name === 'Z')) {
                        if (!processedMeshes.has(child)) {
                            originalLines.push(child as THREE.Mesh);
                            processedMeshes.add(child);
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
                    originalLine.material = (originalLine.material as THREE.Material).clone();
                    const originalMaterial = originalLine.material as any;

                    const negativeMaterial = originalMaterial.clone();
                    negativeMaterial.transparent = true;
                    negativeMaterial._opacity = 0.001; // 초기 투명 상태
                    negativeMaterial.opacity = 0.001;

                    originalMaterial.transparent = true;
                    originalMaterial._opacity = originalMaterial._opacity || 1;
                    originalMaterial.opacity = originalMaterial._opacity;

                    const negativeLine = new THREE.Mesh(negativeGeometry, negativeMaterial);
                    negativeLine.name = originalLine.name;
                    // 커스텀 불투명도 속성 동기화
                    (negativeLine.material as any)._opacity = (negativeLine.material as any)._opacity || (negativeLine.material as any).opacity;
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
            }
        });
    } catch (error) {
        console.error('TransformControls gizmo patch (clone method) failed:', error);
    }

    return { transformControls, gizmoLines };
}
