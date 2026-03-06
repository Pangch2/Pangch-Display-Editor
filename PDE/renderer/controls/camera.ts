/**
 * camera.ts — 카메라 포커스 및 뷰 제어 로직
 *
 * ── 호출 관계 ──
 *   입력 : gizmo.ts keydown F — focusCameraOnSelection() 호출
 *   파라미터:
 *     - hasAnySelection: select.ts::hasAnySelection()의 결과값을 gizmo가 주입
 *     - getSelectionBoundingBox: overlay.ts 기반으로 gizmo에서 생성한 람다
 *     - getSelectionCenterWorld: overlay.ts::calculateAvgOriginForChildren 기반 함수
 *   의존 : 없음 (Three.js 전용)
 */
import * as THREE from 'three/webgpu';

interface OrbitControlsLike {
    target: THREE.Vector3;
    update(): boolean;
}

export function focusCameraOnSelection(
    camera: THREE.PerspectiveCamera, 
    controls: OrbitControlsLike, 
    hasAnySelection: boolean, 
    getSelectionBoundingBox: () => THREE.Box3, 
    getSelectionCenterWorld: (target: THREE.Vector3) => THREE.Vector3
): void {
    const targetPosition = new THREE.Vector3();
    let distance = 5.2; 

    if (hasAnySelection) {
        const box = getSelectionBoundingBox();
        if (!box.isEmpty()) {
            box.getCenter(targetPosition);
            const size = new THREE.Vector3();
            box.getSize(size);
            const maxDim = Math.max(size.x, size.y, size.z);
            
            const fitSize = Math.max(maxDim, 1.0);
            const fov = camera.fov * (Math.PI / 180);
            distance = Math.abs(fitSize / (2 * Math.tan(fov / 2)));
            distance *= 1.6; 
        } else {
             getSelectionCenterWorld(targetPosition);
        }
    } else {
        targetPosition.set(0, 0, 0);
    }

    const direction = new THREE.Vector3().subVectors(camera.position, controls.target).normalize();
    
    if (direction.lengthSq() < 1e-6) {
        direction.set(1, 1, 1).normalize();
    }

    controls.target.copy(targetPosition);
    camera.position.copy(targetPosition).add(direction.multiplyScalar(distance));
    controls.update();
}
