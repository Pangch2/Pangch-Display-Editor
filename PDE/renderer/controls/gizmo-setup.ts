import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import * as THREE from 'three/webgpu';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface GizmoAxisLines {
    original: THREE.Mesh[];
    negative: THREE.Mesh[];
}

export interface GizmoLines {
    X: GizmoAxisLines;
    Y: GizmoAxisLines;
    Z: GizmoAxisLines;
}

export interface GizmoSetupResult {
    transformControls: TransformControls;
    gizmoLines: GizmoLines;
}

// ─── Setup ────────────────────────────────────────────────────────────────────

/**
 * TransformControls를 생성하고, 양방향 축 라인(positive/negative)을 패치해
 * 카메라 방향에 따라 가시성을 토글할 수 있도록 준비한다.
 */
export function setupGizmo(
    camera: THREE.Camera,
    renderer: THREE.WebGPURenderer,
    scene: THREE.Scene,
): GizmoSetupResult {
    const transformControls = new TransformControls(camera, renderer.domElement);
    transformControls.setMode('translate');
    transformControls.setSpace('world');
    transformControls.setColors(0xEF3751, 0x6FA21C, 0x437FD0, 0xfeff3e);
    scene.add(transformControls.getHelper());

    const gizmoLines: GizmoLines = {
        X: { original: [], negative: [] },
        Y: { original: [], negative: [] },
        Z: { original: [], negative: [] },
    };

    try {
        const gizmoRoot = transformControls.getHelper();
        const gizmoContainer = (gizmoRoot as any).children[0];
        const processedMeshes = new Set<THREE.Mesh>();

        for (const mode of ['translate', 'scale'] as const) {
            const modeGizmo = gizmoContainer?.gizmo?.[mode];
            if (!modeGizmo) continue;

            const originalLines: THREE.Mesh[] = [];
            modeGizmo.traverse((child: THREE.Object3D) => {
                const mesh = child as THREE.Mesh;
                if (mesh.isMesh && (mesh.name === 'X' || mesh.name === 'Y' || mesh.name === 'Z')) {
                    if (!processedMeshes.has(mesh)) {
                        originalLines.push(mesh);
                        processedMeshes.add(mesh);
                    }
                }
            });

            for (const originalLine of originalLines) {
                const axis = originalLine.name as 'X' | 'Y' | 'Z';
                const negativeGeometry = originalLine.geometry.clone();

                if (axis === 'X') negativeGeometry.rotateY(Math.PI);
                else if (axis === 'Y') negativeGeometry.rotateX(Math.PI);
                else if (axis === 'Z') negativeGeometry.rotateY(Math.PI);

                originalLine.material = (originalLine.material as THREE.Material).clone();
                const origMat = originalLine.material as any;
                origMat.transparent = true;
                origMat._opacity = origMat._opacity ?? 1;
                origMat.opacity = origMat._opacity;

                const negativeMaterial = origMat.clone();
                negativeMaterial.transparent = true;
                negativeMaterial._opacity = 0.001;
                negativeMaterial.opacity = 0.001;

                const negativeLine = new THREE.Mesh(negativeGeometry, negativeMaterial);
                negativeLine.name = axis;
                (negativeLine.material as any)._opacity = 0.001;
                negativeLine.renderOrder = originalLine.renderOrder + 1;
                originalLine.parent!.add(negativeLine);

                gizmoLines[axis].original.push(originalLine);
                gizmoLines[axis].negative.push(negativeLine);
            }
        }
    } catch (error) {
        console.error('TransformControls gizmo patch failed:', error);
    }

    return { transformControls, gizmoLines };
}
