import { Color, Group, InstancedMesh, Matrix4, StorageInstancedBufferAttribute, type InstancedBufferAttribute, type InterleavedBufferAttribute } from 'three/webgpu';
import { dragSelectedAttributeName } from '../entity-material';
import { restoreAtlasPartMaterials } from '../load-project/batching/atlas-part-material';
import { batchMesh, batchOf, cloneBatchGeometry, moveObjectSlot, type ObjectBatch } from './object-access';

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
function instanceValueNames(mesh: InstancedMesh): string[] {
    return [...(mesh.instanceColor ? ['instanceMatrix', 'instanceColor'] : ['instanceMatrix']),
        ...Object.entries(mesh.geometry.attributes).filter(([, attribute]) => isInstancedAttribute(attribute)).map(([name]) => name)];
}

function instanceValue(mesh: InstancedMesh, name: string): InstancedAttribute | undefined {
    if (name === 'instanceMatrix') return mesh.instanceMatrix;
    if (name === 'instanceColor') return mesh.instanceColor ?? undefined;
    const attribute = mesh.geometry.getAttribute(name);
    return isInstancedAttribute(attribute) ? attribute : undefined;
}

function capacityOf(mesh: InstancedMesh): number {
    let capacity = mesh.instanceMatrix.count;
    if (mesh.instanceColor) capacity = Math.min(capacity, mesh.instanceColor.count);
    for (const attribute of Object.values(mesh.geometry.attributes)) if (isInstancedAttribute(attribute)) capacity = Math.min(capacity, attribute.count);
    return capacity;
}

// --- Append ---

const tmpMatrix = new Matrix4();
const tmpColor = new Color();
const appendableChunks = new WeakMap<InstancedMesh, InstancedMesh>();

function copyInstancedAttributes(source: InstancedMesh, sourceId: number, target: InstancedMesh, targetId: number, updated: Set<InstancedAttribute>): void {
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

function copyInstanceUserData(source: InstancedMesh, sourceId: number, target: InstancedMesh, targetId: number): void {
    if (source.userData.hasHat?.[sourceId] !== undefined) (target.userData.hasHat ??= [])[targetId] = source.userData.hasHat[sourceId];
    const tile = source.userData.imageHeadTilePositions?.[sourceId] as [number, number] | undefined;
    if (tile) {
        target.userData.imageHeadLayer = source.userData.imageHeadLayer;
        (target.userData.imageHeadTilePositions ??= [])[targetId] = [...tile];
    }
}

/** An empty batch drawing like `source`, for copies that do not fit into it. */
function createChunk(root: Group, source: InstancedMesh): InstancedMesh {
    const capacity = Math.max(1, capacityOf(source));
    const material = Array.isArray(source.material) ? [...source.material] : source.material;
    const chunk = new InstancedMesh(cloneBatchGeometry(source.geometry), material, capacity);
    chunk.instanceMatrix = new StorageInstancedBufferAttribute(capacity, 16);
    if (source.instanceColor) chunk.instanceColor = source.instanceColor.clone();
    chunk.count = 0;
    chunk.userData.pdeDuplicateChunk = true;
    chunk.userData.displayType = source.userData.displayType;
    // Chunks gather copies from one source batch, so they can mix kinds like it.
    chunk.userData.mixedDisplayKinds = true;
    if (source.userData.textDisplayBatch) chunk.userData.textDisplayBatch = true;
    if (source.userData.pbdeModelMatrix) chunk.userData.pbdeModelMatrix = [...source.userData.pbdeModelMatrix];
    if (source.geometry.userData.atlasBatch) chunk.userData.pbdeSignature = source.userData.pbdeSignature;
    if (source.userData.hasHat) chunk.userData.hasHat = [];
    if (source.userData.imageHeadLayer !== undefined) {
        chunk.userData.imageHeadLayer = source.userData.imageHeadLayer;
        chunk.userData.imageHeadTilePositions = [];
    }
    chunk.frustumCulled = source.frustumCulled;
    chunk.renderOrder = source.renderOrder;
    chunk.visible = false;
    chunk.layers.mask = source.layers.mask;
    root.add(chunk);
    return chunk;
}

function appendableChunk(root: Group, source: InstancedMesh): InstancedMesh {
    const chunk = appendableChunks.get(source);
    if (chunk?.parent === root && chunk.count < capacityOf(chunk) && chunk.geometry.userData.atlasBatch === source.geometry.userData.atlasBatch) return chunk;
    const created = createChunk(root, source);
    appendableChunks.set(source, created);
    return created;
}

/**
 * Appends a copy of each listed slot of `batch` (drag flag cleared) to the batch itself while it has room, then
 * to chunks drawing like it. Returns where each copy landed, in order. Registering the copies is the caller's job.
 */
export function appendInstanceCopies(root: Group, batch: ObjectBatch, instanceIds: number[]): Array<{ mesh: ObjectBatch; instanceId: number }> {
    const source = batchMesh(batch);
    if (!source.geometry || instanceIds.length === 0) return [];
    restoreAtlasPartMaterials(source);
    let target = source;
    let capacity = capacityOf(target);
    const slots: Array<{ mesh: ObjectBatch; instanceId: number }> = [];
    const updated = new Set<InstancedMesh>(), updatedColors = new Set<InstancedMesh>(), updatedAttributes = new Set<InstancedAttribute>();
    for (const instanceId of instanceIds) {
        if (target.count >= capacity) {
            target = appendableChunk(root, source);
            capacity = capacityOf(target);
        }
        const targetId = target.count;
        source.getMatrixAt(instanceId, tmpMatrix);
        target.setMatrixAt(targetId, tmpMatrix);
        copyInstancedAttributes(source, instanceId, target, targetId, updatedAttributes);
        if (source.instanceColor) {
            source.getColorAt(instanceId, tmpColor);
            target.setColorAt(targetId, tmpColor);
            updatedColors.add(target);
        }
        copyInstanceUserData(source, instanceId, target, targetId);
        slots.push({ mesh: batchOf(target), instanceId: targetId });
        target.count++;
        updated.add(target);
    }
    for (const mesh of updated) {
        mesh.instanceMatrix.needsUpdate = true;
        mesh.visible = source.visible;
    }
    for (const mesh of updatedColors) if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    for (const attribute of updatedAttributes) attribute.needsUpdate = true;
    return slots;
}

// --- Remove ---

const tmpRemoveMatrix = new Matrix4();
const tmpRemoveColor = new Color();

/** Swap-removes the given slots (sorted descending): the last slot fills each hole. An emptied batch leaves the scene. */
export function removeInstances(root: Group, batch: ObjectBatch, instanceIdsDescending: number[]): void {
    const mesh = batchMesh(batch);
    const uvOffset = mesh.geometry.attributes.instancedUvOffset as InstancedAttribute | undefined;
    const hasHat = mesh.userData.hasHat as boolean[] | undefined;
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
        if (Array.isArray(hasHat)) hasHat[to] = hasHat[from];
        const tiles = mesh.userData.imageHeadTilePositions as Array<[number, number]> | undefined;
        if (tiles) {
            if (from in tiles) tiles[to] = tiles[from];
            else delete tiles[to];
            delete tiles[from];
        }
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

type EntryState<V> = { has: boolean; value?: V };
type SlotState = {
    instanceId: number;
    values: Array<{ name: string; values: number[] }>;
    hasHat: EntryState<boolean>;
    imageHeadTilePosition: EntryState<[number, number]>;
};

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
    const mesh = batchMesh(batch);
    const parent = mesh.parent as Group | null;
    const touched = new Set(instanceIds);
    let remaining = mesh.count;
    for (let index = 0; index < instanceIds.size; index++) touched.add(--remaining);
    const names = instanceValueNames(mesh);
    const entry = <V>(values: V[] | undefined, id: number): EntryState<V> => ({ has: Array.isArray(values) && id in values, value: values?.[id] });
    const slots = !withSlots ? [] : [...touched].map(instanceId => ({
        instanceId,
        values: names.map(name => {
            const attribute = instanceValue(mesh, name)!;
            return { name, values: Array.from({ length: attribute.itemSize }, (_, component) => attribute.getComponent(instanceId, component)) };
        }),
        hasHat: entry(mesh.userData.hasHat as boolean[] | undefined, instanceId),
        imageHeadTilePosition: entry(mesh.userData.imageHeadTilePositions as Array<[number, number]> | undefined, instanceId)
    }));
    return { batch, parent, childIndex: parent?.children.indexOf(mesh) ?? -1, visible: mesh.visible, count: mesh.count,
        detachedWhole: instanceIds.size === mesh.count, touched: [...touched], slots };
}

/** Puts a captured batch back as it was before the removal. */
export function restoreBatchRemoval(state: BatchRemovalState): void {
    const mesh = batchMesh(state.batch);
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
        const hasHat = mesh.userData.hasHat as boolean[] | undefined;
        if (hasHat) slot.hasHat.has ? hasHat[slot.instanceId] = slot.hasHat.value! : delete hasHat[slot.instanceId];
        const tiles = mesh.userData.imageHeadTilePositions as Array<[number, number]> | undefined;
        if (tiles) slot.imageHeadTilePosition.has ? tiles[slot.instanceId] = slot.imageHeadTilePosition.value! : delete tiles[slot.instanceId];
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingBox();
    mesh.computeBoundingSphere();
}

/** Frees a batch that a kept removal emptied, when nothing else owns it (duplicate chunks). */
export function disposeRemovedBatch(state: BatchRemovalState): void {
    const mesh = batchMesh(state.batch);
    if (!state.detachedWhole || mesh.parent || !mesh.userData.pdeDuplicateChunk) return;
    mesh.dispose();
    mesh.geometry.dispose();
}


if (import.meta.env.DEV) {
    const root = new Group();
    const source = new InstancedMesh(undefined, undefined, 2);
    root.add(source);
    // A full source sends both copies to one chunk: the second reuses the partly filled one.
    const copies = appendInstanceCopies(root, batchOf(source), [0, 1]);
    console.assert(copies[0].mesh === copies[1].mesh && copies[0].mesh !== batchOf(source) && root.children.length === 2, 'Copies must reuse a partly filled chunk.');
}
