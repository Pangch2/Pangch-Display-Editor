import { InstancedBufferAttribute, Matrix4, type InterleavedBufferAttribute } from 'three/webgpu';
import type { ObjectBatch } from '../../scene-store/object-batch';

const attributeName = 'pdeModelTransform';

/** Where an object's 16 values start in the attribute's array; interleaved rows have their own stride. */
function rowStart(attribute: InstancedBufferAttribute | InterleavedBufferAttribute, instanceId: number): number {
    const interleaved = attribute as InterleavedBufferAttribute;
    return interleaved.isInterleavedBufferAttribute ? instanceId * interleaved.data.stride + interleaved.offset : instanceId * 16;
}

export function setInstanceModelTransform(mesh: ObjectBatch, instanceId: number, transform?: ArrayLike<number>): void {
    let attribute = mesh.geometry.getAttribute(attributeName) as InstancedBufferAttribute | InterleavedBufferAttribute | undefined;
    if (!attribute && !transform) return;
    if (!attribute) {
        const count = mesh.instanceMatrix.count;
        const values = new Float32Array(count * 16);
        const identity = new Matrix4();
        for (let i = 0; i < count; i++) identity.toArray(values, i * 16);
        attribute = new InstancedBufferAttribute(values, 16);
        mesh.geometry.setAttribute(attributeName, attribute);
    }
    new Matrix4().fromArray(transform ?? new Matrix4().elements).toArray(attribute.array, rowStart(attribute, instanceId));
    attribute.needsUpdate = true;
}

export function getInstanceModelTransform(mesh: ObjectBatch, instanceId: number, out = new Matrix4()): Matrix4 {
    const attribute = mesh.geometry.getAttribute(attributeName) as InstancedBufferAttribute | InterleavedBufferAttribute | undefined;
    return attribute ? out.fromArray(attribute.array, rowStart(attribute, instanceId)) : out.identity();
}

export function removeInstanceModelTransform(mesh: ObjectBatch, instanceId: number, matrix: Matrix4): Matrix4 {
    return matrix.multiply(getInstanceModelTransform(mesh, instanceId).invert());
}

export function changeInstanceModelTransform(mesh: ObjectBatch, instanceId: number, matrix: Matrix4, oldModel: Matrix4, newModel: Matrix4): void {
    const base = new Matrix4().fromArray(mesh.userData.pbdeModelMatrix ?? oldModel.elements);
    const delta = base.clone().multiply(oldModel.clone().invert()).multiply(newModel).multiply(base.clone().invert());
    matrix.multiply(delta);
    setInstanceModelTransform(mesh, instanceId, getInstanceModelTransform(mesh, instanceId).multiply(delta).elements);
}
