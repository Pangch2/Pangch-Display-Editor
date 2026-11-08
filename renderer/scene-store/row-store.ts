import { BufferGeometry, InstancedBufferAttribute, InstancedInterleavedBuffer, InterleavedBufferAttribute } from 'three/webgpu';
import { dragSelectedAttributeName, entityVisibleAttributeName, setEntityStateAttributes } from '../entity-material';
import type { ObjectBatch } from './object-batch';

/**
 * Row storage of content batches. A batch is sealed into a row layout the first time it is drawn: its matrix,
 * color and instanced attributes are copied into the layout's rows once and become views of them. The draw pool
 * uploads these arrays as they are; nothing is copied back. A row = matrix (16) + color (3) + each instanced
 * buffer of the batch whole; batches with the same vertex and row layout share one array.
 */
type InstanceSource = { array: Float32Array; count?: number; needsUpdate?: boolean };
type SourceDesc = { source: InstanceSource; stride: number; rowOffset: number };
type LayoutDesc = { key: string; vertex: [string, number][]; sources: SourceDesc[]; offsets: Map<string, number>; rowStride: number };

export const rowColorOffset = 16;

/** Row buffers handed out as batch attribute views. */
export const rowViewBuffers = new WeakSet<object>();

export const isInstancedAttribute = (attribute): boolean => attribute?.isInstancedBufferAttribute === true || attribute?.data?.isInstancedInterleavedBuffer === true;

// WebGPU's default storage binding limit; installGpuDraw raises it to the device's.
let rowBindingLimit = 128 * 2 ** 20;

/** The largest rows array one layout may hold (the device's storage binding limit). */
export function setRowBindingLimit(bytes: number): void {
    rowBindingLimit = bytes;
}

/** One batch's slots in a layout. `start` moves when the layout compacts; `released` once they are freed. */
export type RowRange = { layout: RowLayout; start: number; capacity: number; view: InstancedInterleavedBuffer; batch: WeakRef<ObjectBatch>; released: boolean };

// A batch dropped without dispose() gives its slots back when it is collected.
const collected = new FinalizationRegistry<RowRange>(range => range.layout.free(range));

/** Rows of every batch sharing one vertex and row layout, and their slot allocation. */
export class RowLayout {
    readonly key: string;
    readonly vertex: [string, number][];
    readonly rowStride: number;
    /** Row offset of each instanced attribute. */
    readonly offsets: Map<string, number>;
    rows = new Float32Array(0);
    capacity = 0;
    /** One past the last used slot. */
    end = 0;
    readonly ranges = new Set<RowRange>();
    /** Bumped when slots are allocated, freed or moved, or the array is replaced. */
    version = 0;
    /** Bumped when compaction moves rows within the array. */
    moves = 0;
    private grew = false;

    constructor(desc: LayoutDesc, key: string) {
        this.key = key;
        this.vertex = desc.vertex;
        this.rowStride = desc.rowStride;
        this.offsets = desc.offsets;
    }

    private bytes(slots: number): number {
        return slots * this.rowStride * 4;
    }

    private resize(capacity: number): void {
        const rows = new Float32Array(capacity * this.rowStride);
        rows.set(this.rows.subarray(0, Math.min(this.end, capacity) * this.rowStride));
        this.rows = rows;
        this.capacity = capacity;
        for (const range of this.ranges) this.point(range);
        this.version++;
    }

    private point(range: RowRange): void {
        range.view.array = this.rows.subarray(range.start * this.rowStride, (range.start + range.capacity) * this.rowStride);
    }

    /** First slot of `count` new slots (zeroed), or null past the binding limit. */
    allocate(count: number): number | null {
        const end = this.end + count;
        if (end > this.capacity) {
            let capacity = Math.max(end, this.capacity * 2);
            if (this.bytes(capacity) > rowBindingLimit) capacity = end;
            if (this.bytes(capacity) > rowBindingLimit) return null;
            this.resize(capacity);
            this.grew = true;
        }
        const start = this.end;
        this.end = end;
        this.rows.fill(0, start * this.rowStride, end * this.rowStride);
        this.version++;
        return start;
    }

    add(range: RowRange): void {
        this.ranges.add(range);
        this.point(range);
    }

    free(range: RowRange): void {
        if (range.released) return;
        range.released = true;
        this.ranges.delete(range);
        let used = 0, end = 0;
        for (const live of this.ranges) { used += live.capacity; end = Math.max(end, live.start + live.capacity); }
        this.end = end;
        this.version++;
        // Past half free, move the live ranges down.
        if (used * 2 < end) this.compact();
    }

    private compact(): void {
        let end = 0;
        for (const range of [...this.ranges].sort((a, b) => a.start - b.start)) {
            if (range.start !== end) {
                this.rows.copyWithin(end * this.rowStride, range.start * this.rowStride, (range.start + range.capacity) * this.rowStride);
                range.start = end;
                this.point(range);
            }
            end += range.capacity;
        }
        this.rows.fill(0, end * this.rowStride, this.end * this.rowStride);
        this.end = end;
        this.moves++;
        this.version++;
    }

    /** After a burst of allocations: trims the doubling slack to 1/8. */
    fit(): void {
        if (!this.grew) return;
        this.grew = false;
        const fitted = Math.ceil(Math.max(this.end * 9 / 8, 1));
        if (fitted < this.capacity) this.resize(fitted);
    }
}

const layouts = new Map<string, RowLayout>();

/** Row = matrix (16) + color (3) + each instanced buffer whole; null when the batch can't be stored in rows. */
function describe(batch: ObjectBatch): LayoutDesc | null {
    const { geometry, instanceMatrix, instanceColor } = batch;
    if (!(instanceMatrix.array instanceof Float32Array) || (instanceColor && !(instanceColor.array instanceof Float32Array))) return null;
    if (geometry.getAttribute('position')?.itemSize !== 3) return null;
    const vertex: [string, number][] = [];
    const buffers = new Map<InstanceSource, { stride: number; views: [string, number, number][] }>();
    for (const name of Object.keys(geometry.attributes).sort()) {
        const attribute = geometry.attributes[name];
        if (!isInstancedAttribute(attribute)) {
            vertex.push([name, attribute.itemSize]);
            continue;
        }
        const interleaved = attribute.isInterleavedBufferAttribute === true;
        const source = interleaved ? attribute.data : attribute;
        if (!(source.array instanceof Float32Array) || attribute.normalized) return null;
        let entry = buffers.get(source);
        if (!entry) buffers.set(source, entry = { stride: interleaved ? source.stride : attribute.itemSize, views: [] });
        entry.views.push([name, interleaved ? attribute.offset : 0, attribute.itemSize]);
    }
    const sources: SourceDesc[] = [{ source: instanceMatrix, stride: 16, rowOffset: 0 }];
    if (instanceColor) sources.push({ source: instanceColor, stride: 3, rowOffset: rowColorOffset });
    const offsets = new Map<string, number>();
    let rowStride = rowColorOffset + 3;
    let key = vertex.map(([name, size]) => `${name}:${size}`).join(',') + '|';
    for (const [source, { stride, views }] of buffers) {
        sources.push({ source, stride, rowOffset: rowStride });
        for (const [name, offset, size] of views) {
            offsets.set(name, rowStride + offset);
            key += `${name}@${offset}:${size},`;
        }
        key += `/${stride}|`;
        rowStride += stride;
    }
    // The cull pass reads [dragSelected, entityVisible] as one pair.
    if (offsets.get(dragSelectedAttributeName) === undefined || offsets.get(dragSelectedAttributeName) !== offsets.get(entityVisibleAttributeName)! - 1) return null;
    return { key, vertex, sources, offsets, rowStride };
}

/** True while every per-instance value of the batch is still a view of its rows and its count fits them. */
function rowsCurrent(batch: ObjectBatch, range: RowRange): boolean {
    const { view, layout } = range;
    if (batch.instanceMatrix.data !== view || batch.instanceColor?.data !== view || batch.count > range.capacity) return false;
    let instanced = 0, vertex = 0;
    for (const name in batch.geometry.attributes) {
        const attribute = batch.geometry.attributes[name];
        if (isInstancedAttribute(attribute)) {
            if (attribute.data !== view) return false;
            instanced++;
        } else vertex++;
    }
    return instanced === layout.offsets.size && vertex === layout.vertex.length;
}

/** A geometry holding one batch's row views; a second batch drawing it gets a copy. */
const geometryOwners = new WeakMap<BufferGeometry, ObjectBatch>();

/**
 * Puts the batch's per-instance data in rows (first draw, or after its attributes, count or vertex layout
 * changed) and returns its range; null when it can't be stored (the batch is then not drawn).
 */
export function sealBatch(batch: ObjectBatch): RowRange | null {
    const current = batch.rowRange as RowRange | null;
    if (current && !current.released && rowsCurrent(batch, current)) return current;
    if (current) unseal(batch, current);
    const owner = geometryOwners.get(batch.geometry);
    if (owner && owner !== batch && owner.rowRange) batch.geometry = cloneBatchGeometry(batch.geometry);
    const desc = describe(batch);
    if (!desc) return null;
    let capacity = Math.max(batch.count, 1);
    for (const { source, stride } of desc.sources) capacity = Math.max(capacity, Math.floor(source.array.length / stride));
    let layout!: RowLayout, start: number | null = null;
    // A layout at the binding limit continues in a sibling under a numbered key.
    for (let part = 0; start === null; part++) {
        const key = part ? `${desc.key}#${part}` : desc.key;
        const existing = layouts.get(key);
        layout = existing ?? new RowLayout(desc, key);
        if (!existing) layouts.set(key, layout);
        start = layout.allocate(capacity);
        if (start === null && !existing) {
            layouts.delete(key);
            return null;
        }
    }
    const { rows, rowStride } = layout;
    for (const { source, stride, rowOffset } of desc.sources) {
        const items = Math.min(capacity, Math.floor(source.array.length / stride));
        for (let item = 0; item < items; item++) {
            const target = (start + item) * rowStride + rowOffset;
            for (let component = 0; component < stride; component++) rows[target + component] = source.array[item * stride + component];
        }
    }
    // Rows always carry a color: white for batches without one.
    if (!batch.instanceColor) for (let slot = start; slot < start + capacity; slot++) rows.fill(1, slot * rowStride + rowColorOffset, slot * rowStride + rowColorOffset + 3);
    const view = new InstancedInterleavedBuffer(rows.subarray(start * rowStride, (start + capacity) * rowStride), rowStride, 1);
    rowViewBuffers.add(view);
    const range: RowRange = { layout, start, capacity, view, batch: new WeakRef(batch), released: false };
    layout.add(range);
    const { geometry } = batch;
    for (const name in geometry.attributes) {
        const attribute = geometry.attributes[name];
        if (isInstancedAttribute(attribute)) geometry.attributes[name] = new InterleavedBufferAttribute(view, attribute.itemSize, layout.offsets.get(name)!, attribute.normalized);
    }
    batch.instanceMatrix = new InterleavedBufferAttribute(view, 16, 0);
    batch.instanceColor = new InterleavedBufferAttribute(view, 3, rowColorOffset);
    // The original arrays go: the rows hold the only copy.
    for (const { source } of desc.sources) source.array = new Float32Array(0);
    geometryOwners.set(geometry, batch);
    batch.rowRange = range;
    collected.register(batch, range, range);
    return range;
}

/** Gives a sealed batch its own arrays again (values copied out of its rows) and frees the rows. */
export function unsealBatch(batch: ObjectBatch): void {
    const range = batch.rowRange as RowRange | null;
    if (range) unseal(batch, range);
}

function unseal(batch: ObjectBatch, range: RowRange): void {
    const { view } = range;
    const isView = (attribute): boolean => attribute?.data === view;
    const copy = (attribute: InterleavedBufferAttribute): InstancedBufferAttribute => {
        const values = new Float32Array(range.capacity * attribute.itemSize);
        for (let id = 0; id < range.capacity; id++) for (let component = 0; component < attribute.itemSize; component++) {
            values[id * attribute.itemSize + component] = attribute.getComponent(id, component);
        }
        return new InstancedBufferAttribute(values, attribute.itemSize, attribute.normalized);
    };
    const { geometry } = batch;
    if (!range.released) {
        // Attributes replaced since sealing stay; views are copied out. The drag/visible pair keeps its stride-2 buffer.
        if (isView(geometry.getAttribute(entityVisibleAttributeName)) && isView(geometry.getAttribute(dragSelectedAttributeName))) {
            setEntityStateAttributes(geometry, range.capacity);
        }
        for (const name in geometry.attributes) if (isView(geometry.attributes[name])) geometry.attributes[name] = copy(geometry.attributes[name]);
        if (isView(batch.instanceMatrix)) batch.instanceMatrix = copy(batch.instanceMatrix);
        if (isView(batch.instanceColor)) batch.instanceColor = copy(batch.instanceColor);
    }
    releaseBatchRows(batch);
}

/** Frees the batch's rows (dispose): its per-instance values are gone. */
export function releaseBatchRows(batch: ObjectBatch): void {
    const range = batch.rowRange as RowRange | null;
    if (!range) return;
    batch.rowRange = null;
    collected.unregister(range);
    if (geometryOwners.get(batch.geometry) === batch) geometryOwners.delete(batch.geometry);
    range.layout.free(range);
}

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
    // The drag/visible pair lives in a stride-2 buffer of its own; this copies the values into one.
    if (capacity >= 0 && clone.getAttribute(entityVisibleAttributeName)) setEntityStateAttributes(clone, capacity);
    return clone;
}
