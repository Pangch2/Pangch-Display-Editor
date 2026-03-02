import * as THREE from 'three/webgpu';

export function focusCameraOnSelection(
    camera, 
    controls, 
    hasAnySelection, 
    getSelectionBoundingBox, 
    getSelectionCenterWorld
) {
    let targetPosition = new THREE.Vector3();
    let distance = 5.2; // Default distance for origin (approx sqrt(27))

    if (hasAnySelection) {
        const box = getSelectionBoundingBox();
        if (!box.isEmpty()) {
            box.getCenter(targetPosition);
            const size = new THREE.Vector3();
            box.getSize(size);
            const maxDim = Math.max(size.x, size.y, size.z);
            
            // Fit to view distance
            // Ensure we don't zoom in infinitely on 0-size objects
            const fitSize = Math.max(maxDim, 1.0);
            const fov = camera.fov * (Math.PI / 180);
            distance = Math.abs(fitSize / (2 * Math.tan(fov / 2)));
            distance *= 1.6; // Add some margin
        } else {
             getSelectionCenterWorld(targetPosition);
        }
    } else {
        targetPosition.set(0, 0, 0);
    }

    const direction = new THREE.Vector3().subVectors(camera.position, controls.target).normalize();
    
    // Fallback if camera is exactly at target
    if (direction.lengthSq() < 1e-6) {
        direction.set(1, 1, 1).normalize();
    }

    controls.target.copy(targetPosition);
    camera.position.copy(targetPosition).add(direction.multiplyScalar(distance));
    controls.update();
}