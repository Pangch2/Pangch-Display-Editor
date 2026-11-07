import { Box3, BufferGeometry, InstancedBufferAttribute, InstancedMesh, Matrix4, Vector3, type BufferAttribute, type Color, type Group, type InterleavedBufferAttribute, type Material, type Object3D } from 'three/webgpu';
import { getInstanceModelTransform } from '../load-project/batching/instance-model-transform';
import type { ObjectStore } from './object-store';
import { dragSelectedAttributeName, entityVisibleAttributeName, setEntityStateAttributes } from '../entity-material';
import { transformInstanceRange } from '../controls/selection/instance-ranges';

/**
 * Object access. The slot functions read one object of a batch; the object functions address the same data
 * by uuid. Code reads per-object data (matrices, colors, per-instance values, count) only through here, so the
 * batch behind a handle can change from a content InstancedMesh to a store batch without touching the callers.
 */
declare const objectBatchBrand: unique symbol;
/**
 * A batch of objects: a child of the project root. Public: its Object3D side (matrixWorld, visible, userData
 * flags), its shape (geometry: vertex attributes, index, groups) and materials. Per-instance attributes are not.
 */
export type ObjectBatch = Object3D & { readonly geometry: BufferGeometry; readonly material: Material | Material[]; readonly [objectBatchBrand]: true };

/** True for a project's content batch (as opposed to overlays, helpers and plain meshes). */
export const isObjectBatch = (object: Object3D | null | undefined): object is ObjectBatch => (object as InstancedMesh | undefined)?.isInstancedMesh === true;
export type ObjectRef = { mesh: ObjectBatch; instanceId: number };

// shortcut: batches are still content InstancedMeshes (their data lives in pool rows once adopted); these two
// casts go if the batch becomes a class of its own (M7e). Code outside the store must not use batchMesh.
export const batchOf = (mesh: InstancedMesh): ObjectBatch => mesh as unknown as ObjectBatch;
export const batchMesh = (batch: ObjectBatch): InstancedMesh => batch as unknown as InstancedMesh;

// --- Slots: (batch, instanceId) ---

type ObjectData = { objectPivots?: Map<string, Vector3>; objectIsCustomPivot?: Map<string, boolean>; objectDisplayKinds?: Map<string, string> };

/** The project root's data and the slot's object uuid. Content meshes are direct children of the project root. */
function slotOwner(batch: ObjectBatch, instanceId: number): { data: ObjectData; uuid: string } | undefined {
    const root = batchMesh(batch).parent as Group | null;
    const uuid = root && objectUuidAt(root, batch, instanceId);
    if (uuid) return { data: root.userData as ObjectData, uuid };
    return undefined;
}

/** The project's content batches. */
export function objectBatches(root: Group): ObjectBatch[] {
    return root.children.filter(child => (child as InstancedMesh).isInstancedMesh) as unknown as ObjectBatch[];
}

/** One per-object value (a component of a per-instance attribute), or undefined when the batch has none. */
export function getInstanceValue(batch: ObjectBatch, instanceId: number, name: string, component = 0): number | undefined {
    const attribute = batchMesh(batch).geometry.getAttribute(name);
    return attribute ? attribute.getComponent(instanceId, component) : undefined;
}

/** Writes one per-object value and marks its row; false when the batch has no such value. */
export function setInstanceValue(batch: ObjectBatch, instanceId: number, name: string, value: number, component = 0): boolean {
    const attribute = batchMesh(batch).geometry.getAttribute(name);
    if (!attribute) return false;
    attribute.setComponent(instanceId, component, value);
    markInstanceRows(attribute, instanceId);
    return true;
}

// The visible slots of each batch, kept in step with setInstanceVisible; rebuilt when the batch's storage changes.
type VisibleSlots = { attribute: unknown; count: number; ids: Set<number>; snapshot?: number[] };
const visibleSlots = new WeakMap<ObjectBatch, VisibleSlots>();

/** The slots whose entityVisible value is not 0. */
export function getVisibleInstanceIds(batch: ObjectBatch): readonly number[] {
    const mesh = batchMesh(batch);
    const attribute = mesh.geometry.getAttribute(entityVisibleAttributeName);
    const cached = visibleSlots.get(batch);
    if (cached && cached.attribute === attribute && cached.count === mesh.count) return cached.snapshot ??= [...cached.ids];
    const ids = new Set<number>();
    for (let instanceId = 0; instanceId < mesh.count; instanceId++) if (attribute?.getX(instanceId) !== 0) ids.add(instanceId);
    const snapshot = [...ids];
    visibleSlots.set(batch, { attribute, count: mesh.count, ids, snapshot });
    return snapshot;
}

/** Sets one object's entityVisible value; true when it changed. */
export function setInstanceVisible(batch: ObjectBatch, instanceId: number, visible: boolean): boolean {
    const mesh = batchMesh(batch);
    if (!mesh.geometry.getAttribute(entityVisibleAttributeName)) setEntityStateAttributes(mesh.geometry, mesh.instanceMatrix.count);
    if (getInstanceValue(batch, instanceId, entityVisibleAttributeName) === Number(visible)) return false;
    setInstanceValue(batch, instanceId, entityVisibleAttributeName, Number(visible));
    const cached = visibleSlots.get(batch);
    if (cached?.attribute === mesh.geometry.getAttribute(entityVisibleAttributeName) && cached.count === mesh.count) {
        if (visible) cached.ids.add(instanceId);
        else cached.ids.delete(instanceId);
        cached.snapshot = undefined;
    } else visibleSlots.delete(batch);
    return true;
}

/** All components of one per-object value, or undefined when the batch has none. */
export function getInstanceValues(batch: ObjectBatch, instanceId: number, name: string): number[] | undefined {
    const attribute = batchMesh(batch).geometry.getAttribute(name);
    return attribute && Array.from({ length: attribute.itemSize }, (_, component) => attribute.getComponent(instanceId, component));
}

/** Writes the leading components of one per-object value and marks its row; false when the batch has none. */
export function setInstanceValues(batch: ObjectBatch, instanceId: number, name: string, values: ArrayLike<number>): boolean {
    const attribute = batchMesh(batch).geometry.getAttribute(name);
    if (!attribute) return false;
    for (let component = 0; component < values.length; component++) attribute.setComponent(instanceId, component, values[component]);
    markInstanceRows(attribute, instanceId);
    return true;
}

/** The atlas tile [x, y] of an image-head object, undefined for others. */
export function getInstanceTile(batch: ObjectBatch, instanceId: number): [number, number] | undefined {
    return batchMesh(batch).userData.imageHeadTilePositions?.[instanceId];
}

export function setInstanceTile(batch: ObjectBatch, instanceId: number, tile: [number, number]): void {
    (batchMesh(batch).userData.imageHeadTilePositions ??= [])[instanceId] = tile;
}

/** True when the batch keeps an atlas tile per object (image heads). */
export function hasInstanceTiles(batch: ObjectBatch): boolean {
    return !!batchMesh(batch).userData.imageHeadTilePositions;
}

/** The number of components of a per-object value, 0 when the batch has none. */
export function instanceValueSize(batch: ObjectBatch, name: string): number {
    return batchMesh(batch).geometry.getAttribute(name)?.itemSize ?? 0;
}

export function getInstanceCount(batch: ObjectBatch): number {
    return batch ? batchMesh(batch).count : 0;
}

export function isInstanceValid(batch: ObjectBatch, instanceId: number): boolean {
    return !!batch && instanceId < batchMesh(batch).count;
}

/**
 * A mixedDisplayKinds batch holds block and item displays together; their kinds are kept by uuid in
 * root.userData.objectDisplayKinds. Other batches have one kind, userData.displayType.
 */
export function getDisplayType(batch: ObjectBatch, instanceId: number): string | undefined {
    if (!batch) return undefined;
    const { userData } = batchMesh(batch);
    if (userData.mixedDisplayKinds) {
        const owner = slotOwner(batch, instanceId);
        const kind = owner && owner.data.objectDisplayKinds?.get(owner.uuid);
        if (kind) return kind;
    }
    return userData.displayType;
}

/** The object's hat flag, undefined when the batch keeps none or has none for the slot. */
export function getInstanceHasHat(batch: ObjectBatch, instanceId: number): boolean | undefined {
    return batchMesh(batch).userData.hasHat?.[instanceId];
}

/** Sets the object's hat flag; the batch starts keeping hat flags if it had none. */
export function setInstanceHasHat(batch: ObjectBatch, instanceId: number, hasHat: boolean | undefined): void {
    (batchMesh(batch).userData.hasHat ??= [])[instanceId] = hasHat;
}

/** True when the batch keeps a hat flag per object (player heads). */
export function hasInstanceHatData(batch: ObjectBatch): boolean {
    return !!batchMesh(batch).userData.hasHat;
}

export function isItemDisplayHatEnabled(batch: ObjectBatch, instanceId: number): boolean {
    return getDisplayType(batch, instanceId) === 'item_display' && !!batchMesh(batch).userData.hasHat?.[instanceId];
}

export function getInstanceLocalOriginOffset(batch: ObjectBatch, instanceId: number, out = new Vector3()): Vector3 {
    out.set(0, isItemDisplayHatEnabled(batch, instanceId) ? 0.03125 : 0, 0);
    if (getDisplayType(batch, instanceId) === 'block_display') {
        out.applyMatrix4(getInstanceModelTransform(batchMesh(batch), instanceId).invert());
    }
    if (getDisplayType(batch, instanceId) === 'text_display') {
        const box = getInstanceLocalBox(batch, instanceId);
        if (box) out.x = (box.min.x + box.max.x) * 0.5;
    }
    return out;
}

export function getInstanceLocalBoxMin(batch: ObjectBatch, instanceId: number, out = new Vector3()): Vector3 | null {
    const box = getInstanceLocalBox(batch, instanceId);
    if (!box) return null;
    const modelTransform = getInstanceModelTransform(batchMesh(batch), instanceId);
    // Find the display-space corner before converting back to batch coordinates.
    out.copy(box.applyMatrix4(modelTransform).min);
    return out.applyMatrix4(modelTransform.invert());
}

export function getInstanceWorldMatrixForOrigin(batch: ObjectBatch, instanceId: number, outMatrix: Matrix4): Matrix4 {
    return getInstanceWorldMatrix(batch, instanceId, outMatrix);
}

export function getInstanceLocalBox(batch: ObjectBatch, instanceId: number): Box3 | null {
    if (!batch) return null;
    const { geometry, userData } = batchMesh(batch);
    if (!geometry) return null;
    if (!geometry.boundingBox) geometry.computeBoundingBox();
    if (!geometry.boundingBox) return null;

    const textLayout = geometry.getAttribute('textDisplayLayout');
    let box = geometry.boundingBox.clone();
    if (textLayout && instanceId < textLayout.count && !geometry.userData.textDisplayGeometryKey) {
        const centerX = (textLayout.getX(instanceId) + textLayout.getY(instanceId)) * 0.5;
        const halfWidth = textLayout.getW(instanceId) * 0.5;
        box.min.set(centerX - halfWidth, 0, geometry.boundingBox.min.z);
        box.max.set(centerX + halfWidth, textLayout.getZ(instanceId), geometry.boundingBox.max.z);
    }

    if (getDisplayType(batch, instanceId) === 'item_display' && userData.hasHat && !userData.hasHat[instanceId]) {
        const center = new Vector3();
        box.getCenter(center);
        box = new Box3().setFromCenterAndSize(center, new Vector3(1, 1, 1));
    }

    return box;
}

/** The batch-local matrix of one object. */
export function getInstanceMatrix(batch: ObjectBatch, instanceId: number, out: Matrix4): Matrix4 {
    batchMesh(batch).getMatrixAt(instanceId, out);
    return out;
}

// --- Rows: per-instance data may sit in the draw pool's interleaved rows ---
// Once the pool adopts a batch, its instanceMatrix, instanceColor and instanced attributes are views into one
// row buffer (stride = row size). Matrices are read and written through rowOf so both layouts work.

type InstanceArray = { array: ArrayLike<number> & { [index: number]: number }; offset?: number; data?: { array: Float32Array; stride: number }; itemSize: number };

/** Where an object's values start in the array behind a per-instance attribute (plain or interleaved). */
export function rowOf(attribute: InstanceArray, instanceId: number): number {
    return attribute.data ? instanceId * attribute.data.stride + attribute.offset! : instanceId * attribute.itemSize;
}

/** Row buffers the draw pool hands out as batch attribute views (it registers them when it adopts a batch). */
export const rowViewBuffers = new WeakSet<object>();

/** A copy of a batch geometry whose per-instance attributes own their arrays again: row views are copied out. */
export function cloneBatchGeometry(geometry: BufferGeometry): BufferGeometry {
    const clone = geometry.clone();
    let capacity = -1;
    for (const [name, attribute] of Object.entries(geometry.attributes) as Array<[string, InterleavedBufferAttribute]>) {
        if (!attribute.isInterleavedBufferAttribute || !rowViewBuffers.has(attribute.data)) continue;
        capacity = attribute.count;
        if (name === entityVisibleAttributeName || name === dragSelectedAttributeName) continue;
        const values = new Float32Array(capacity * attribute.itemSize);
        for (let id = 0; id < capacity; id++) for (let component = 0; component < attribute.itemSize; component++) {
            values[id * attribute.itemSize + component] = attribute.getComponent(id, component);
        }
        clone.setAttribute(name, new InstancedBufferAttribute(values, attribute.itemSize, attribute.normalized));
    }
    // The pool reads the drag/visible pair from a stride-2 buffer of its own; this copies the values into one.
    if (capacity >= 0 && clone.getAttribute(entityVisibleAttributeName)) setEntityStateAttributes(clone, capacity);
    return clone;
}

const matrixWrites = new WeakMap<object, number>();
const bumpMatrixWrites = (mesh: object): void => { matrixWrites.set(mesh, (matrixWrites.get(mesh) ?? 0) + 1); };

let rowAccessorsInstalled = false;

/**
 * Lets InstancedMesh read and write matrices and colors that are interleaved row views; plain attributes behave
 * as before. Matrix writes also bump the batch's matrix version (the shared row version moves on any write).
 */
export function installInstanceRowAccessors(): void {
    if (rowAccessorsInstalled) return;
    rowAccessorsInstalled = true;
    const proto = InstancedMesh.prototype;
    proto.getMatrixAt = function (this: InstancedMesh, index: number, matrix: Matrix4) {
        return matrix.fromArray(this.instanceMatrix.array, rowOf(this.instanceMatrix as unknown as InstanceArray, index));
    };
    proto.setMatrixAt = function (this: InstancedMesh, index: number, matrix: Matrix4) {
        matrix.toArray(this.instanceMatrix.array, rowOf(this.instanceMatrix as unknown as InstanceArray, index));
        bumpMatrixWrites(this);
        return this;
    };
    const setColorAt = proto.setColorAt;
    proto.getColorAt = function (this: InstancedMesh, index: number, color: Color) {
        return color.fromArray(this.instanceColor!.array, rowOf(this.instanceColor as unknown as InstanceArray, index));
    };
    proto.setColorAt = function (this: InstancedMesh, index: number, color: Color) {
        // A batch without colors gets three's own white-filled attribute first.
        if (this.instanceColor === null) return setColorAt.call(this, index, color);
        color.toArray(this.instanceColor.array, rowOf(this.instanceColor as unknown as InstanceArray, index));
        return this;
    };
}

/** The batch's world matrix (the project root's): instance matrices are relative to it. */
export function getBatchWorldMatrix(batch: ObjectBatch): Matrix4 {
    return batchMesh(batch).matrixWorld;
}

export function getInstanceWorldMatrix(batch: ObjectBatch, instanceId: number, outMatrix: Matrix4): Matrix4 {
    outMatrix.identity();
    if (!batch) return outMatrix;
    const mesh = batchMesh(batch);
    mesh.getMatrixAt(instanceId, outMatrix);
    return outMatrix.premultiply(mesh.matrixWorld);
}

if (import.meta.env.DEV) {
    const geometry = new BufferGeometry();
    geometry.boundingBox = new Box3(new Vector3(-1, 0, 0), new Vector3(3, 1, 0));
    const mesh = new InstancedMesh(geometry, undefined, 1);
    mesh.userData.displayType = 'text_display';
    console.assert(getInstanceLocalOriginOffset(batchOf(mesh), 0).equals(new Vector3(1, 0, 0)), 'Text display origin must stay horizontally centered.');
}

// --- Pivots: one local pivot and one custom-pivot flag per object ---
// Kept by uuid on the project root (objectPivots, objectIsCustomPivot), so slot moves never touch them.
// The slot functions find the root through the batch: content batches are direct children of it.

type PivotData = { objectPivots?: Map<string, Vector3>; objectIsCustomPivot?: Map<string, boolean> };

function missingOwner(batch: ObjectBatch, instanceId: number): void {
    if (import.meta.env.DEV) console.warn('[object-access] Pivot write for an unregistered object was dropped.', batch.uuid, instanceId);
}

export function getInstancePivot(batch: ObjectBatch, instanceId: number): Vector3 | undefined {
    const owner = slotOwner(batch, instanceId);
    return owner && owner.data.objectPivots?.get(owner.uuid);
}

/** Sets the object's local pivot, or removes it for undefined. */
export function setInstancePivot(batch: ObjectBatch, instanceId: number, pivot: Vector3 | undefined): void {
    const owner = slotOwner(batch, instanceId);
    if (owner) setPivotData(owner.data, owner.uuid, pivot);
    else if (pivot) missingOwner(batch, instanceId);
}

export function getInstanceIsCustomPivot(batch: ObjectBatch, instanceId: number): boolean | undefined {
    const owner = slotOwner(batch, instanceId);
    return owner && owner.data.objectIsCustomPivot?.get(owner.uuid);
}

/** Sets the custom-pivot flag, or removes it for undefined. */
export function setInstanceIsCustomPivot(batch: ObjectBatch, instanceId: number, value: boolean | undefined): void {
    const owner = slotOwner(batch, instanceId);
    if (owner) setIsCustomPivotData(owner.data, owner.uuid, value);
    else if (value !== undefined) missingOwner(batch, instanceId);
}

function setPivotData(data: PivotData, uuid: string, pivot: Vector3 | undefined): void {
    if (pivot) (data.objectPivots ??= new Map()).set(uuid, pivot);
    else data.objectPivots?.delete(uuid);
}

function setIsCustomPivotData(data: PivotData, uuid: string, value: boolean | undefined): void {
    if (value === undefined) data.objectIsCustomPivot?.delete(uuid);
    else (data.objectIsCustomPivot ??= new Map()).set(uuid, value);
}

// --- Writes: per-object buffer rows ---
// The draw pool copies changed rows of each per-instance buffer into its own. Writes marked here tell it which
// rows; a buffer changed any other way since the pool's last copy (needsUpdate alone) is copied whole.

type RowSource = { version: number; needsUpdate: boolean };
type RowMarks = { rows: Array<[number, number]>; version: number; whole: boolean; takenVersion: number };
const rowMarks = new WeakMap<object, RowMarks>();

/** Records that rows [start, start + count) of a per-instance attribute (plain or interleaved) changed. */
export function markInstanceRows(attribute: BufferAttribute | InterleavedBufferAttribute, start: number, count = 1): void {
    const source: RowSource = (attribute as InterleavedBufferAttribute).isInterleavedBufferAttribute
        ? (attribute as InterleavedBufferAttribute).data : attribute as BufferAttribute;
    let marks = rowMarks.get(source);
    // Unknown history counts as an unmarked change.
    if (!marks) rowMarks.set(source, marks = { rows: [], version: -1, whole: true, takenVersion: -1 });
    else if (source.version !== marks.version && source.version !== marks.takenVersion) marks.whole = true;
    if (!marks.whole) {
        let from = start, to = start + count;
        // Past a few dozen spans one covering span is cheaper to copy.
        if (marks.rows.length >= 64) {
            for (const [first, last] of marks.rows) { from = Math.min(from, first); to = Math.max(to, last); }
            marks.rows.length = 0;
        }
        marks.rows.push([from, to]);
    }
    source.needsUpdate = true;
    marks.version = source.version;
}

/** The rows marked since the last call, or null when the whole buffer must be copied. Clears the marks. */
export function takeInstanceRows(source: object): Array<[number, number]> | null {
    const marks = rowMarks.get(source);
    if (!marks) return null;
    const { version } = source as RowSource;
    const rows = !marks.whole && version === marks.version ? marks.rows : null;
    rowMarks.set(source, { rows: [], version: marks.version, whole: false, takenVersion: version });
    return rows;
}

/** Sets one object's batch-local matrix. */
export function setInstanceMatrix(batch: ObjectBatch, instanceId: number, matrix: Matrix4): void {
    const mesh = batchMesh(batch);
    mesh.setMatrixAt(instanceId, matrix);
    markInstanceRows(mesh.instanceMatrix, instanceId);
}

/** Sets one object's instance color (its lighting) and marks the row. */
export function setInstanceColor(batch: ObjectBatch, instanceId: number, color: Color): void {
    const mesh = batchMesh(batch);
    mesh.setColorAt(instanceId, color);
    markInstanceRows(mesh.instanceColor!, instanceId);
}

/** Bumped by every write to a per-instance value of the batch; -1 when the batch has none. */
export function getInstanceValueVersion(batch: ObjectBatch, name: string): number {
    const attribute = batchMesh(batch).geometry.getAttribute(name) as BufferAttribute | InterleavedBufferAttribute | undefined;
    return attribute ? ((attribute as InterleavedBufferAttribute).isInterleavedBufferAttribute ? (attribute as InterleavedBufferAttribute).data : attribute as BufferAttribute).version : -1;
}

/** Bumped by every change to the batch's matrices; equal versions mean no matrix moved. */
export function getBatchMatrixVersion(batch: ObjectBatch): number {
    const { instanceMatrix } = batchMesh(batch);
    // Plain matrices keep their own version; a row view shares one with every other per-instance value.
    return ((instanceMatrix as unknown as InstanceArray).data ? 0 : instanceMatrix.version) + (matrixWrites.get(batch) ?? 0);
}

/** The object's model transform: the display-space offset between its logical and batch matrices. */
export function getInstanceModelMatrix(batch: ObjectBatch, instanceId: number, out = new Matrix4()): Matrix4 {
    return getInstanceModelTransform(batchMesh(batch), instanceId, out);
}

/** Copies one object's batch-local matrix (16 floats, column-major) into `target` at `offset`. */
export function readInstanceMatrix(batch: ObjectBatch, instanceId: number, target: Float32Array, offset = 0): void {
    const { instanceMatrix } = batchMesh(batch);
    const start = rowOf(instanceMatrix as unknown as InstanceArray, instanceId);
    target.set((instanceMatrix.array as Float32Array).subarray(start, start + 16), offset);
}

/** Writes 16 floats of `source` from `offset` as one object's matrix. Unmarked: call markInstanceMatrices after a run of writes. */
export function writeInstanceMatrix(batch: ObjectBatch, instanceId: number, source: Float32Array, offset = 0): void {
    const { instanceMatrix } = batchMesh(batch);
    (instanceMatrix.array as Float32Array).set(source.subarray(offset, offset + 16), rowOf(instanceMatrix as unknown as InstanceArray, instanceId));
    bumpMatrixWrites(batch);
}

/** Premultiplies the batch-local matrices of slots [start, start + count) by `delta` and marks them. */
export function transformInstanceMatrices(batch: ObjectBatch, delta: Matrix4, start: number, count: number): void {
    const { instanceMatrix } = batchMesh(batch);
    const view = instanceMatrix as unknown as InstanceArray;
    transformInstanceRange(instanceMatrix.array as Float32Array, delta, start, count, view.data?.stride ?? 16, view.data ? view.offset! : 0);
    markInstanceRows(instanceMatrix, start, count);
    bumpMatrixWrites(batch);
}

/** Records that the matrices of slots [start, start + count) changed. */
export function markInstanceMatrices(batch: ObjectBatch, start: number, count = 1): void {
    markInstanceRows(batchMesh(batch).instanceMatrix, start, count);
    bumpMatrixWrites(batch);
}

/** Drops the batch's cached bounds after its matrices moved; picking recomputes them. */
export function invalidateBatchBounds(batch: ObjectBatch): void {
    const mesh = batchMesh(batch);
    mesh.boundingBox = null;
    mesh.boundingSphere = null;
}

// --- Objects: uuid ---

export function objectRef(root: Group, uuid: string): ObjectRef | undefined {
    return (root.userData.objectUuidToInstance as ObjectStore<ObjectRef> | undefined)?.get(uuid);
}

/** The uuid of the object in a batch slot. */
export function objectUuidAt(root: Group, batch: ObjectBatch, instanceId: number): string | undefined {
    return (root.userData.objectUuidToInstance as ObjectStore | undefined)?.uuidAt(batch, instanceId);
}

/** Records that the object in slot `from` moved to slot `to` of the same batch, as a swap-remove does. */
export function moveObjectSlot(root: Group, batch: ObjectBatch, from: number, to: number): void {
    (root.userData.objectUuidToInstance as ObjectStore | undefined)?.moveSlot(batch, from, to);
}

/** The current slots of the given objects, grouped by batch. Unknown uuids are skipped. */
export function objectSlots(root: Group, uuids: Iterable<string>): Map<ObjectBatch, Set<number>> {
    const slots = new Map<ObjectBatch, Set<number>>();
    for (const uuid of uuids) {
        const ref = objectRef(root, uuid);
        if (!ref) continue;
        let ids = slots.get(ref.mesh);
        if (!ids) slots.set(ref.mesh, ids = new Set());
        ids.add(ref.instanceId);
    }
    return slots;
}

export function objectDisplayType(root: Group, uuid: string): string | undefined {
    const ref = objectRef(root, uuid);
    return ref && getDisplayType(ref.mesh, ref.instanceId);
}

/** The object's instance matrix in world space, or null for an unknown uuid. */
export function objectWorldMatrix(root: Group, uuid: string, out: Matrix4): Matrix4 | null {
    const ref = objectRef(root, uuid);
    return ref ? getInstanceWorldMatrix(ref.mesh, ref.instanceId, out) : null;
}

export function objectLocalBox(root: Group, uuid: string): Box3 | null {
    const ref = objectRef(root, uuid);
    return ref ? getInstanceLocalBox(ref.mesh, ref.instanceId) : null;
}

export function objectModelTransform(root: Group, uuid: string, out = new Matrix4()): Matrix4 {
    const ref = objectRef(root, uuid);
    return ref ? getInstanceModelTransform(batchMesh(ref.mesh), ref.instanceId, out) : out.identity();
}

export function objectPivot(root: Group, uuid: string): Vector3 | undefined {
    return (root.userData as PivotData).objectPivots?.get(uuid);
}

export function setObjectPivot(root: Group, uuid: string, pivot: Vector3 | undefined): void {
    setPivotData(root.userData, uuid, pivot);
}

export function objectIsCustomPivot(root: Group, uuid: string): boolean | undefined {
    return (root.userData as PivotData).objectIsCustomPivot?.get(uuid);
}

export function setObjectIsCustomPivot(root: Group, uuid: string, value: boolean | undefined): void {
    setIsCustomPivotData(root.userData, uuid, value);
}

const headValueAttributes = [['uvFlip', 'instancedUvFlip'], ['knifeUvScale', 'instancedKnifeUvScale'], ['knifeUvOffset', 'instancedKnifeUvOffset']] as const;
export type ObjectHeadValues = { uvFlip?: number[]; knifeUvScale?: number[]; knifeUvOffset?: number[]; headLayerVisible?: number };

/** The head values the object's batch carries, in save order. */
export function objectHeadValues(root: Group, uuid: string): ObjectHeadValues {
    const values: ObjectHeadValues = {};
    const ref = objectRef(root, uuid);
    if (!ref) return values;
    const { geometry } = batchMesh(ref.mesh);
    for (const [key, name] of headValueAttributes) {
        const attribute = geometry.getAttribute(name);
        if (attribute) values[key] = Array.from({ length: attribute.itemSize }, (_, component) => attribute.getComponent(ref.instanceId, component));
    }
    const layer = geometry.getAttribute('headLayerVisible');
    if (layer) values.headLayerVisible = layer.getX(ref.instanceId);
    return values;
}

/** Writes the given head values into the attributes the object's batch carries. */
export function setObjectHeadValues(root: Group, uuid: string, values: ObjectHeadValues): void {
    const ref = objectRef(root, uuid);
    if (!ref) return;
    const { geometry } = batchMesh(ref.mesh);
    for (const [key, name] of headValueAttributes) {
        const attribute = geometry.getAttribute(name);
        if (!values[key] || !attribute) continue;
        values[key].forEach((value, component) => attribute.setComponent(ref.instanceId, component, value));
        attribute.needsUpdate = true;
    }
    const layer = geometry.getAttribute('headLayerVisible');
    if (layer && values.headLayerVisible !== undefined) {
        layer.setX(ref.instanceId, values.headLayerVisible);
        layer.needsUpdate = true;
    }
}

export function objectHasHat(root: Group, uuid: string): boolean | undefined {
    const ref = objectRef(root, uuid);
    return ref && batchMesh(ref.mesh).userData.hasHat?.[ref.instanceId];
}
