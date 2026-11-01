import { Vector3, Camera, Box3, Matrix4 } from 'three/webgpu';

interface OrbitControlsLike {
    target: Vector3;
    update(): boolean;
}

export function focusCameraOnSelection(
    camera: Camera,
    controls: OrbitControlsLike, 
    hasAnySelection: boolean, 
    getSelectionBoundingBox: () => Box3, 
    getSelectionCenterWorld: (target: Vector3) => Vector3
): void {
    const minDistance = 0.1;
    const targetPosition = new Vector3();
    const direction = new Vector3().subVectors(camera.position, controls.target).normalize();
    if (direction.lengthSq() < 1e-6) {
        direction.set(1, 1, 1).normalize();
    }
    let distance = 3.12;

    if (hasAnySelection) {
        const box = getSelectionBoundingBox();
        if (!box.isEmpty()) {
            box.getCenter(targetPosition);
            if (camera.isPerspectiveCamera || camera.isOrthographicCamera) {
                const isPerspective = camera.isPerspectiveCamera;
                const viewHeight = isPerspective
                    ? 2 * Math.tan(camera.getEffectiveFOV() * Math.PI / 360)
                    : camera.top - camera.bottom;
                const viewWidth = isPerspective ? viewHeight * camera.aspect : camera.right - camera.left;
                if (isPerspective) {
                    distance = minDistance;
                } else {
                    camera.zoom = Math.min(viewWidth, viewHeight) / minDistance;
                    distance = camera.position.distanceTo(controls.target);
                }

                const viewRotation = new Matrix4().lookAt(direction, new Vector3(), camera.up).invert();
                const corner = new Vector3();
                // Check depth as well as width/height so angled selections stay inside the view.
                for (let i = 0; i < 8; i++) {
                    corner.set(i & 1 ? box.max.x : box.min.x,
                        i & 2 ? box.max.y : box.min.y,
                        i & 4 ? box.max.z : box.min.z).sub(targetPosition).applyMatrix4(viewRotation);
                    const fit = 2 * 1.05 * Math.max(Math.abs(corner.x) / viewWidth, Math.abs(corner.y) / viewHeight);
                    distance = Math.max(distance, corner.z + camera.near * 1.05);
                    if (isPerspective) {
                        distance = Math.max(distance, corner.z + fit);
                    } else if (fit > 0) {
                        camera.zoom = Math.min(camera.zoom, 1 / fit);
                    }
                }
                if (!isPerspective) camera.updateProjectionMatrix();
            }
        } else {
             getSelectionCenterWorld(targetPosition);
        }
    } else {
        targetPosition.set(0, 0, 0);
    }

    controls.target.copy(targetPosition);
    camera.position.copy(targetPosition).add(direction.multiplyScalar(Math.max(distance, minDistance)));
    controls.update();
}
