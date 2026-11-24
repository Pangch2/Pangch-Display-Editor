import { Matrix4, Quaternion, type Euler } from 'three/webgpu';

export function normalizeTransformInput(value: number, rotation = false): number {
    if (rotation) {
        value %= 360;
        if (value > 180) value -= 360;
        else if (value < -180) value += 360;
    }
    const rounded = Number(value.toFixed(6));
    return rounded === 0 ? 0 : rounded;
}

/**
 * Turns `current` by the step from the shown angles `from` to the typed angles `to`, in front of the matrix as the gizmo does:
 * rebuilding from position/rotation/scale would drop shear. The step comes from the angles, not the decomposed quaternion,
 * which is not unit length for a sheared matrix.
 */
export function turnMatrix(current: Matrix4, from: Euler, to: Euler): Matrix4 {
    const turn = new Quaternion().setFromEuler(to).multiply(new Quaternion().setFromEuler(from).invert());
    return current.clone().premultiply(new Matrix4().makeRotationFromQuaternion(turn)).copyPosition(current);
}
