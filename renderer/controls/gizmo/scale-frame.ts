import { Matrix4, Quaternion, Vector3 } from 'three/webgpu';

export function getScaleFrame(initialMatrix: Matrix4, sourceMatrix?: Matrix4 | null): Matrix4 {
    const position = new Vector3();
    const rotation = new Quaternion();
    initialMatrix.decompose(position, rotation, new Vector3());
    const frame = new Matrix4().compose(position, rotation, new Vector3(1, 1, 1));
    if (!sourceMatrix) return frame;

    const x = new Vector3().setFromMatrixColumn(sourceMatrix, 0).normalize();
    const y = new Vector3().setFromMatrixColumn(sourceMatrix, 1).normalize();
    const z = new Vector3().setFromMatrixColumn(sourceMatrix, 2).normalize();
    if (Math.max(Math.abs(x.dot(y)), Math.abs(x.dot(z)), Math.abs(y.dot(z))) <= 1e-6) return frame;

    const sheared = new Matrix4().makeBasis(x, y, z).setPosition(position);
    return Math.abs(sheared.determinant()) > 1e-10 ? sheared : frame;
}
