import { InstancedBufferAttribute, Matrix4, type InstancedMesh } from 'three/webgpu';

const attributeName = 'pdeModelTransform';

export function setInstanceModelTransform(mesh: InstancedMesh, instanceId: number, transform?: ArrayLike<number>): void {
    let attribute = mesh.geometry.getAttribute(attributeName) as InstancedBufferAttribute | undefined;
    if (!attribute && !transform) return;
    if (!attribute) {
        const count = mesh.instanceMatrix.count;
        const values = new Float32Array(count * 16);
        const identity = new Matrix4();
        for (let i = 0; i < count; i++) identity.toArray(values, i * 16);
        attribute = new InstancedBufferAttribute(values, 16);
        mesh.geometry.setAttribute(attributeName, attribute);
    }
    new Matrix4().fromArray(transform ?? new Matrix4().elements).toArray(attribute.array, instanceId * 16);
    attribute.needsUpdate = true;
}

export function getInstanceModelTransform(mesh: InstancedMesh, instanceId: number): Matrix4 {
    const attribute = mesh.geometry.getAttribute(attributeName);
    return attribute ? new Matrix4().fromArray(attribute.array, instanceId * 16) : new Matrix4();
}

export function removeInstanceModelTransform(mesh: InstancedMesh, instanceId: number, matrix: Matrix4): Matrix4 {
    return matrix.multiply(getInstanceModelTransform(mesh, instanceId).invert());
}

export function changeInstanceModelTransform(mesh: InstancedMesh, instanceId: number, matrix: Matrix4, oldModel: Matrix4, newModel: Matrix4): void {
    const base = new Matrix4().fromArray(mesh.userData.pbdeModelMatrix ?? oldModel.elements);
    const delta = base.clone().multiply(oldModel.clone().invert()).multiply(newModel).multiply(base.clone().invert());
    matrix.multiply(delta);
    setInstanceModelTransform(mesh, instanceId, getInstanceModelTransform(mesh, instanceId).multiply(delta).elements);
}
