import { Vector3, PerspectiveCamera, Box3 } from 'three/webgpu';

interface OrbitControlsLike {
    target: Vector3;
    update(): boolean;
}

export function focusCameraOnSelection(
    camera: PerspectiveCamera, 
    controls: OrbitControlsLike, 
    hasAnySelection: boolean, 
    getSelectionBoundingBox: () => Box3, 
    getSelectionCenterWorld: (target: Vector3) => Vector3
): void {
    const targetPosition = new Vector3();
    let distance = 5.2; 

    if (hasAnySelection) {
        const box = getSelectionBoundingBox();
        if (!box.isEmpty()) {
            box.getCenter(targetPosition);
            const size = new Vector3();
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

    const direction = new Vector3().subVectors(camera.position, controls.target).normalize();
    
    if (direction.lengthSq() < 1e-6) {
        direction.set(1, 1, 1).normalize();
    }

    controls.target.copy(targetPosition);
    camera.position.copy(targetPosition).add(direction.multiplyScalar(distance));
    controls.update();
}
