import { Color, Group, InstancedBufferAttribute, InstancedInterleavedBuffer, InterleavedBufferAttribute, Matrix4 } from 'three/webgpu';
import { dragSelectedAttributeName } from '../entity-material';
import { moveObjectSlot } from './object-access';
import { unsealBatch } from './row-store';
import { ObjectBatch } from './object-batch';

/**
 * Batch structure: appending copies, swap-removing slots and putting removed slots back. Callers keep the uuid
 * and group bookkeeping; slot moves stay in here and in the object table.
 */
type InstancedAttribute = InstancedBufferAttribute | InterleavedBufferAttribute;

function isInstancedAttribute(attribute: unknown): attribute is InstancedAttribute {
    const candidate = attribute as InstancedBufferAttribute & { isInterleavedBufferAttribute?: boolean; data?: { isInstancedInterleavedBuffer?: boolean } };
    return !!(candidate?.isInstancedBufferAttribute || (candidate?.isInterleavedBufferAttribute && candidate.data?.isInstancedInterleavedBuffer));
}

/** Every per-instance value of a batch by name: matrix, color and instanced attributes. Names outlive the attribute objects. */
function instanceValueNames(mesh: ObjectBatch): string[] {
    return [...(mesh.instanceColor ? ['instanceMatrix', 'instanceColor'] : ['instanceMatrix']),
        ...Object.entries(mesh.geometry.attributes).filter(([, attribute]) => isInstancedAttribute(attribute)).map(([name]) => name)];
}

function instanceValue(mesh: ObjectBatch, name: string): InstancedAttribute | undefined {
    if (name === 'instanceMatrix') return mesh.instanceMatrix;
    if (name === 'instanceColor') return mesh.instanceColor ?? undefined;
    const attribute = mesh.geometry.getAttribute(name);
    return isInstancedAttribute(attribute) ? attribute : undefined;
}

function capacityOf(mesh: ObjectBatch): number {
    let capacity = mesh.instanceMatrix.count;
    if (mesh.instanceColor) capacity = Math.min(capacity, mesh.instanceColor.count);
    for (const attribute of Object.values(mesh.geometry.attributes)) if (isInstancedAttribute(attribute)) capacity = Math.min(capacity, attribute.count);
    return capacity;
}

// --- Append ---

const tmpMatrix = new Matrix4();
const tmpColor = new Color();

function copyInstancedAttributes(source: ObjectBatch, sourceId: number, target: ObjectBatch, targetId: number, updated: Set<InstancedAttribute>): void {
    for (const [name, sourceAttribute] of Object.entries(source.geometry.attributes)) {
        if (!isInstancedAttribute(sourceAttribute)) continue;
        const targetAttribute = target.geometry.getAttribute(name);
        if (!isInstancedAttribute(targetAttribute)) continue;
        const itemSize = Math.min(sourceAttribute.itemSize, targetAttribute.itemSize);
        if (name === dragSelectedAttributeName) targetAttribute.setX(targetId, 0);
        else if (sourceAttribute.isInterleavedBufferAttribute || targetAttribute.isInterleavedBufferAttribute) {
            for (let component = 0; component < itemSize; component++) targetAttribute.setComponent(targetId, component, sourceAttribute.getComponent(sourceId, component));
        } else {
            const offset = sourceId * sourceAttribute.itemSize;
            targetAttribute.array.set(sourceAttribute.array.subarray(offset, offset + itemSize), targetId * targetAttribute.itemSize);
        }
        updated.add(targetAttribute);
    }
}

/** Moves the batch's per-instance values into arrays of `capacity` slots (out of its rows first); it re-seals on its next draw. */
function growBatch(batch: ObjectBatch, capacity: number): void {
    unsealBatch(batch);
    const buffers = new Map<object, InstancedInterleavedBuffer>();
    const grow = (attribute: InstancedAttribute): InstancedAttribute => {
        if (attribute.isInterleavedBufferAttribute) {
            const { data } = attribute;
            let grown = buffers.get(data);
            if (!grown) {
                const array = new Float32Array(capacity * data.stride);
                array.set((data.array as Float32Array).subarray(0, Math.min(array.length, data.array.length)));
                buffers.set(data, grown = new InstancedInterleavedBuffer(array, data.stride));
            }
            return new InterleavedBufferAttribute(grown, attribute.itemSize, attribute.offset, attribute.normalized);
        }
        const array = new Float32Array(capacity * attribute.itemSize);
        array.set((attribute.array as Float32Array).subarray(0, Math.min(array.length, attribute.array.length)));
        return new InstancedBufferAttribute(array, attribute.itemSize, attribute.normalized);
    };
    batch.instanceMatrix = grow(batch.instanceMatrix) as InstancedBufferAttribute;
    if (batch.instanceColor) batch.instanceColor = grow(batch.instanceColor) as InstancedBufferAttribute;
    for (const [name, attribute] of Object.entries(batch.geometry.attributes)) {
        if (isInstancedAttribute(attribute)) batch.geometry.setAttribute(name, grow(attribute));
    }
}

/**
 * Appends a copy of each listed slot (drag flag cleared) to the batch, growing it when full (1/8 room). Returns
 * the new slots, in order. Registering the copies is the caller's job.
 */
export function appendInstanceCopies(batch: ObjectBatch, instanceIds: number[]): Array<{ mesh: ObjectBatch; instanceId: number }> {
    if (!batch.geometry || instanceIds.length === 0) return [];
    const needed = batch.count + instanceIds.length;
    if (needed > capacityOf(batch)) growBatch(batch, needed + Math.ceil(needed / 8));
    const slots: Array<{ mesh: ObjectBatch; instanceId: number }> = [];
    const updatedAttributes = new Set<InstancedAttribute>();
    for (const instanceId of instanceIds) {
        const targetId = batch.count;
        batch.setMatrixAt(targetId, batch.getMatrixAt(instanceId, tmpMatrix));
        copyInstancedAttributes(batch, instanceId, batch, targetId, updatedAttributes);
        if (batch.instanceColor) batch.setColorAt(targetId, batch.getColorAt(instanceId, tmpColor));
        slots.push({ mesh: batch, instanceId: targetId });
        batch.count++;
    }
    batch.instanceMatrix.needsUpdate = true;
    if (batch.instanceColor) batch.instanceColor.needsUpdate = true;
    for (const attribute of updatedAttributes) attribute.needsUpdate = true;
    return slots;
}

// --- Remove ---

const tmpRemoveMatrix = new Matrix4();
const tmpRemoveColor = new Color();

/** Swap-removes the given slots (sorted descending): the last slot fills each hole. An emptied batch leaves the scene. */
export function removeInstances(root: Group, batch: ObjectBatch, instanceIdsDescending: number[]): void {
    const mesh = batch;
    const uvOffset = mesh.geometry.attributes.instancedUvOffset as InstancedAttribute | undefined;
    const swap = (from: number, to: number) => {
        mesh.setMatrixAt(to, mesh.getMatrixAt(from, tmpRemoveMatrix));
        for (const attribute of Object.values(mesh.geometry.attributes)) {
            if (!isInstancedAttribute(attribute)) continue;
            if (attribute.isInterleavedBufferAttribute) {
                for (let component = 0; component < attribute.itemSize; component++) attribute.setComponent(to, component, attribute.getComponent(from, component));
            } else attribute.array.copyWithin(to * attribute.itemSize, from * attribute.itemSize, (from + 1) * attribute.itemSize);
            attribute.needsUpdate = true;
        }
        if (mesh.instanceColor) mesh.setColorAt(to, mesh.getColorAt(from, tmpRemoveColor));
    };
    for (const instanceId of instanceIdsDescending) {
        const last = mesh.count - 1;
        if (instanceId < last) {
            swap(last, instanceId);
            moveObjectSlot(root, batch, last, instanceId);
        }
        mesh.count--;
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    if (uvOffset) uvOffset.needsUpdate = true;
    if (mesh.count === 0) mesh.removeFromParent();
}

type SlotState = { instanceId: number; values: Array<{ name: string; values: number[] }> };

/** What putting a batch's removed slots back needs: its place in the scene, count and the overwritten slots. */
export type BatchRemovalState = {
    batch: ObjectBatch;
    parent: Group | null;
    childIndex: number;
    visible: boolean;
    count: number;
    /** All slots go: the batch leaves the scene. */
    detachedWhole: boolean;
    /** The removed slots and the last ones that fill them. */
    touched: number[];
    slots: SlotState[];
};

/** Snapshot before removeInstances(ids): the removed slots and the last ones that fill them. */
export function captureBatchRemoval(batch: ObjectBatch, instanceIds: Set<number>, withSlots: boolean): BatchRemovalState {
    const mesh = batch;
    const parent = mesh.parent as Group | null;
    const touched = new Set(instanceIds);
    let remaining = mesh.count;
    for (let index = 0; index < instanceIds.size; index++) touched.add(--remaining);
    const names = instanceValueNames(mesh);
    const slots = !withSlots ? [] : [...touched].map(instanceId => ({
        instanceId,
        values: names.map(name => {
            const attribute = instanceValue(mesh, name)!;
            return { name, values: Array.from({ length: attribute.itemSize }, (_, component) => attribute.getComponent(instanceId, component)) };
        })
    }));
    return { batch, parent, childIndex: parent?.children.indexOf(mesh) ?? -1, visible: mesh.visible, count: mesh.count,
        detachedWhole: instanceIds.size === mesh.count, touched: [...touched], slots };
}

/** Puts a captured batch back as it was before the removal. */
export function restoreBatchRemoval(state: BatchRemovalState): void {
    const mesh = state.batch;
    mesh.visible = state.visible;
    if (state.parent && !mesh.parent) {
        state.parent.add(mesh);
        if (state.childIndex >= 0) state.parent.children.splice(state.childIndex, 0, state.parent.children.pop()!);
    }
    mesh.count = state.count;
    for (const slot of state.slots) {
        for (const { name, values } of slot.values) {
            const attribute = instanceValue(mesh, name);
            if (!attribute) continue;
            values.forEach((value, component) => attribute.setComponent(slot.instanceId, component, value));
            attribute.needsUpdate = true;
        }
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    // Bounds are recomputed on demand.
    mesh.boundingBox = mesh.boundingSphere = null;
}

/** Frees the rows of a batch a dropped removal emptied. */
export function disposeRemovedBatch(state: BatchRemovalState): void {
    if (state.detachedWhole && !state.batch.parent) state.batch.dispose();
}

if (import.meta.env.DEV) {
    const source = new ObjectBatch(undefined, undefined, 2);
    source.setMatrixAt(1, new Matrix4().makeTranslation(3, 0, 0));
    // A full batch grows in place: copies keep their source's values.
    const copies = appendInstanceCopies(source, [1, 1]);
    console.assert(copies.every(copy => copy.mesh === source) && source.count === 4 && source.instanceMatrix.count >= 4
        && source.getMatrixAt(3, new Matrix4()).elements[12] === 3, 'Copies must grow their own batch.');
}
