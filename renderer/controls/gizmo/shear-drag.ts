import { Box3, Matrix4, Plane, Triangle, Vector3 } from 'three/webgpu';

export const maxShearAngle = 85 * Math.PI / 180;

export function getShearFixedFace(pivot: Vector3, box: Box3, frame: Matrix4, pointStart: Vector3): Plane | null {
    if (box.isEmpty() || frame.determinant() === 0) return null;
    const localPivot = pivot.clone().applyMatrix4(frame.clone().invert());
    if ([0, 1, 2].every(axis => Math.abs(localPivot.getComponent(axis)
        - (box.min.getComponent(axis) + box.max.getComponent(axis)) / 2)
        <= (box.max.getComponent(axis) - box.min.getComponent(axis)) * 1e-6)) return null;
    const tolerance = box.clone().applyMatrix4(frame).getSize(new Vector3()).length() * 1e-8;
    const direction = pointStart.clone().normalize();
    const triangle = new Triangle();
    const closestPoint = new Vector3();
    let closest: Plane | null = null;
    let closestDistance = Infinity;
    let closestAlignment = -1;
    for (let axis = 0; axis < 3; axis++) {
        const min = box.min.getComponent(axis);
        const max = box.max.getComponent(axis);
        for (const fixed of [min, max]) {
            const corners = [[0, 0], [1, 0], [1, 1], [0, 1]].map(([a, b]) => box.min.clone().setComponent(axis, fixed)
                .setComponent((axis + 1) % 3, (a ? box.max : box.min).getComponent((axis + 1) % 3))
                .setComponent((axis + 2) % 3, (b ? box.max : box.min).getComponent((axis + 2) % 3)).applyMatrix4(frame));
            const distance = Math.min(
                triangle.set(corners[0], corners[1], corners[2]).closestPointToPoint(pivot, closestPoint).distanceTo(pivot),
                triangle.set(corners[0], corners[2], corners[3]).closestPointToPoint(pivot, closestPoint).distanceTo(pivot)
            );
            const face = new Plane(new Vector3().setComponent(axis, 1), -fixed).applyMatrix4(frame);
            const alignment = Math.abs(face.normal.dot(direction));
            if (distance < closestDistance - tolerance
                || (Math.abs(distance - closestDistance) <= tolerance && alignment > closestAlignment)) {
                closest = face;
                closestDistance = distance;
                closestAlignment = alignment;
            }
        }
    }
    return closest;
}

export function getShearDragDelta(
    pivot: Vector3,
    rotationAxis: Vector3,
    pointStart: Vector3,
    angle: number,
    out = new Matrix4(),
    fixedFace?: Plane | null
): Matrix4 {
    out.identity();
    if (!Number.isFinite(angle)) return out;
    const axis = rotationAxis.clone().normalize();
    const radial = pointStart.clone().addScaledVector(axis, -pointStart.dot(axis)).normalize();
    if (fixedFace) radial.copy(fixedFace.normal);
    if (axis.lengthSq() === 0 || radial.lengthSq() === 0) return out;
    const tangent = new Vector3().crossVectors(axis, radial);
    if (fixedFace) {
        // A ring parallel to the fixed face still drags along that face.
        if (tangent.lengthSq() < 1e-12) tangent.crossVectors(axis, pointStart);
        tangent.addScaledVector(radial, -tangent.dot(radial)).normalize();
        if (tangent.lengthSq() === 0) return out;
    }
    // Keep tan(angle) finite as the dragged face approaches a right angle.
    const amount = Math.tan(Math.max(-maxShearAngle, Math.min(maxShearAngle, angle)));
    const e = out.elements;
    for (let column = 0; column < 3; column++) {
        for (let row = 0; row < 3; row++) {
            e[column * 4 + row] += amount * tangent.getComponent(row) * radial.getComponent(column);
        }
    }
    // The plane equation avoids subtracting large external-pivot coordinates.
    if (fixedFace) return out.setPosition(tangent.multiplyScalar(amount * fixedFace.constant));
    return out.setPosition(pivot.clone().sub(pivot.clone().applyMatrix4(out)));
}
