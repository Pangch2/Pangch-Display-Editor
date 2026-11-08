import { BufferAttribute, BufferGeometry, Frustum, IndirectStorageBufferAttribute, Matrix4, Mesh, Sphere, StorageBufferAttribute, Vector3, Vector4 } from 'three/webgpu';
import type { Box3, Camera, Material, WebGPURenderer } from 'three/webgpu';
import type { ObjectBatch } from '../scene-store/object-batch';
import { dragDeltaMatrix, dragSelectedAttributeName } from '../entity-material';
import { buildDrawRanges, cullBucketCount, drawRangesOf, shapeKeyOf, type DrawRange, type DrawRecord } from './cull-geometry';
import { createCullKernels, cullWorkgroupSize, noMember, type CullKernels } from './cull-compute';
import type { PooledLayout } from './pool-instance';
import { takeInstanceRows } from '../scene-store/object-access';
import { sealBatch, type RowLayout, type RowRange } from '../scene-store/row-store';

/** Pooled vertices and bucket-sorted indices of one geometry content, shared by every member drawing it. */
type Shape = { key: string; refs: number; vertexStart: number; vertexCount: number; indexStart: number; indexCount: number; records: DrawRecord[]; bucketMask: number };
type Member = {
    batch: ObjectBatch; layout: Layout; id: number; range: RowRange;
    shapeStamp: string; shape: Shape;
    materials: Material[]; ranges: Map<Material, number[]>; call: number;
    /** Row view version uploaded last; -1 uploads the whole range. */
    viewVersion: number;
};
type Proxy = Mesh & { pdeLayout: Layout; instanceColor: unknown };
export type Batch = { material: Material; proxy: Proxy; offsets: number[]; call: number; groupOrder: number; renderOrder: number; clippingContext: unknown };

const sweepInterval = 120;
const projectionView = new Matrix4();
const frustum = new Frustum();
const sphere = new Sphere();
const cameraVector = new Vector4();
const cameraAxis = new Vector3();

const materialsOf = (batch: ObjectBatch): Material[] => Array.isArray(batch.material) ? batch.material : [batch.material];

/** What decides the member's shape (pooled vertices and sorted indices); a change swaps the shape only. */
function shapeStampOf(batch: ObjectBatch): string {
    const { geometry } = batch;
    let key = `${geometry.id}|${geometry.index.id}:${geometry.index.version}|`;
    for (const group of geometry.groups) key += `${group.start},${group.count},${group.materialIndex};`;
    for (const material of materialsOf(batch)) key += material ? `|${material.side}${material.transparent ? 1 : 0}` : '|-';
    for (const name in geometry.attributes) {
        const attribute = geometry.attributes[name];
        if (!attribute.data?.isInstancedInterleavedBuffer && !attribute.isInstancedBufferAttribute) {
            key += `|${attribute.isInterleavedBufferAttribute ? attribute.data.uuid : attribute.id}@${(attribute.data ?? attribute).version}`;
        }
    }
    return key;
}

/** A larger copy of `old` (contents kept); the old GPU buffer is released. */
function grown<T extends Float32Array | Uint32Array>(old: BufferAttribute | null, Type: new (length: number) => T, count: number, itemSize: number,
    Kind: typeof BufferAttribute = StorageBufferAttribute, fill?: number): BufferAttribute {
    const array = new Type(count * itemSize);
    if (fill !== undefined) array.fill(fill);
    if (old) {
        array.set((old.array as T).subarray(0, Math.min(old.array.length, array.length)));
        old.dispose();
    }
    return new Kind(array, itemSize);
}

const growth = (needed: number, current: number) => Math.max(needed, current * 2);

/**
 * The GPU side of one row layout: its rows uploaded as they are, the slot table, pooled vertices, cull buffers
 * and draws of every member.
 */
class Layout implements PooledLayout {
    readonly rowLayout: RowLayout;
    readonly vertex: [string, number][];
    readonly rowStride: number;
    readonly offsets: Map<string, number>;
    readonly entityOffset: number;
    readonly shapes = new Map<string, Shape>();
    readonly members: (Member | null)[] = [];
    readonly batches = new Map<Material, Batch>();
    attributes = new Map<string, BufferAttribute>();
    index: BufferAttribute | null = null;
    vertexCapacity = 0; vertexEnd = 0; vertexFreed = 0;
    indexCapacity = 0; indexEnd = 0;
    slotCapacity = 0;
    memberCapacity = 0;
    rows: BufferAttribute | null = null;
    slotMember: BufferAttribute | null = null; masks: BufferAttribute | null = null; blockCounts: BufferAttribute | null = null; visibleIds: BufferAttribute | null = null;
    memberInfo: BufferAttribute; memberBounds: BufferAttribute; memberWorld: BufferAttribute; segments: BufferAttribute;
    records: BufferAttribute = new StorageBufferAttribute(new Uint32Array(4), 4);
    args: BufferAttribute = new IndirectStorageBufferAttribute(new Uint32Array(5), 5);
    recordCount = 0;
    recordsDirty = true; geometryDirty = false;
    /** Members came or went: the slot table is rewritten. */
    slotsDirty = true;
    private rowVersion = -1;
    /** Bumped by every change the cull pass reads. */
    version = 0;
    frameKey = '';
    call = -1;

    constructor(rowLayout: RowLayout) {
        this.rowLayout = rowLayout;
        this.vertex = rowLayout.vertex;
        this.rowStride = rowLayout.rowStride;
        this.offsets = rowLayout.offsets;
        this.entityOffset = rowLayout.offsets.get(dragSelectedAttributeName)!;
        this.growMembers(8);
    }

    get slotEnd(): number {
        return this.rowLayout.end;
    }

    private growMembers(capacity: number): void {
        this.memberInfo = grown(this.memberInfo, Uint32Array, capacity, 4);
        this.memberBounds = grown(this.memberBounds, Float32Array, capacity * 3, 4);
        this.memberWorld = grown(this.memberWorld, Float32Array, capacity, 16);
        this.segments?.dispose();
        this.segments = new StorageBufferAttribute(new Uint32Array(capacity * cullBucketCount * 2), 1);
        this.memberCapacity = capacity;
    }

    addMember(member: Omit<Member, 'id'>): Member {
        let id = this.members.indexOf(null);
        if (id < 0) id = this.members.length;
        if (id >= this.memberCapacity) this.growMembers(this.memberCapacity * 2);
        const added = { ...member, id } as Member;
        this.members[id] = added;
        this.slotsDirty = this.recordsDirty = true;
        this.version++;
        return added;
    }

    removeMember(member: Member): void {
        this.members[member.id] = null;
        (this.memberInfo.array as Uint32Array).fill(0, member.id * 4, member.id * 4 + 4);
        this.memberInfo.needsUpdate = true;
        this.releaseShape(member.shape);
        this.slotsDirty = this.recordsDirty = true;
        this.version++;
    }

    /**
     * Before anything uploads: follows the row store (array replaced, slots allocated, freed or moved) and
     * rewrites the slot table and member slots when they changed.
     */
    sync(): void {
        const { rowLayout } = this;
        rowLayout.fit();
        const moved = this.rows?.array !== rowLayout.rows;
        if (moved) {
            // A new attribute uploads the whole array.
            this.rows?.dispose();
            this.rows = new StorageBufferAttribute(rowLayout.rows, this.rowStride);
        }
        if (!moved && !this.slotsDirty && this.rowVersion === rowLayout.version) return;
        this.slotsDirty = false;
        this.rowVersion = rowLayout.version;
        const capacity = Math.ceil(Math.max(rowLayout.capacity, 1) / cullWorkgroupSize) * cullWorkgroupSize;
        if (capacity !== this.slotCapacity) {
            for (const buffer of [this.slotMember, this.masks, this.visibleIds, this.blockCounts]) buffer?.dispose();
            this.slotMember = new StorageBufferAttribute(new Uint32Array(capacity), 1);
            // GPU-only cull buffers: written by every cull run, so nothing to keep.
            this.masks = new StorageBufferAttribute(new Uint32Array(capacity), 1);
            this.visibleIds = new StorageBufferAttribute(new Uint32Array(capacity * cullBucketCount), 1);
            this.blockCounts = new StorageBufferAttribute(new Uint32Array(capacity / cullWorkgroupSize * cullBucketCount), 1);
            this.slotCapacity = capacity;
        }
        const slots = this.slotMember!.array as Uint32Array;
        const info = this.memberInfo.array as Uint32Array;
        slots.fill(noMember);
        for (const member of this.members) {
            if (!member) continue;
            const { start, capacity: count } = member.range;
            slots.fill(member.id, start, start + count);
            info[member.id * 4] = start;
            info[member.id * 4 + 1] = count;
        }
        this.slotMember!.needsUpdate = true;
        this.memberInfo.needsUpdate = true;
        // Compaction moves rows in place: upload them whole.
        if (!moved && rowLayout.moves !== this.moves) {
            this.rows!.clearUpdateRanges();
            this.rows!.needsUpdate = true;
        }
        this.moves = rowLayout.moves;
        this.recordsDirty = true;
        this.version++;
    }

    private moves = -1;

    /** Uploads rows [start, start + count) (floats) of the store array; a replaced array uploads whole anyway. */
    markRows(start: number, count: number): void {
        const rows = this.rows;
        if (rows?.array !== this.rowLayout.rows) return;
        const ranges = rows.updateRanges;
        // Past a few dozen ranges one covering write is cheaper than many small ones.
        if (ranges.length >= 64) {
            const first = Math.min(start, ...ranges.map(range => range.start));
            const last = Math.max(start + count, ...ranges.map(range => range.start + range.count));
            rows.clearUpdateRanges();
            rows.addUpdateRange(first, last - first);
        } else rows.addUpdateRange(start, count);
        rows.needsUpdate = true;
        this.version++;
    }

    addShape(geometry: BufferGeometry, ranges: DrawRange[]): Shape {
        const key = shapeKeyOf(geometry, ranges, this.vertex.map(([name]) => name));
        const existing = this.shapes.get(key);
        if (existing) {
            existing.refs++;
            return existing;
        }
        const { index, records, bucketMask } = buildDrawRanges(geometry, ranges);
        const vertexCount = geometry.getAttribute('position').count;
        this.reserveVertices(vertexCount, index.length);
        for (const [name, itemSize] of this.vertex) {
            const target = this.attributes.get(name)!;
            const source = geometry.getAttribute(name);
            const array = target.array as Float32Array;
            const start = this.vertexEnd * itemSize;
            const count = Math.min(vertexCount, source.count);
            if (!source.isInterleavedBufferAttribute && source.array instanceof Float32Array && !source.normalized) {
                array.set(source.array.subarray(0, count * itemSize), start);
            } else {
                for (let vertex = 0; vertex < count; vertex++) {
                    for (let component = 0; component < itemSize; component++) array[start + vertex * itemSize + component] = source.getComponent(vertex, component);
                }
            }
            target.addUpdateRange(start, vertexCount * itemSize);
            target.needsUpdate = true;
        }
        (this.index!.array as Uint32Array).set(index, this.indexEnd);
        this.index!.addUpdateRange(this.indexEnd, index.length);
        this.index!.needsUpdate = true;
        const shape: Shape = { key, refs: 1, vertexStart: this.vertexEnd, vertexCount, indexStart: this.indexEnd, indexCount: index.length, records, bucketMask };
        this.shapes.set(key, shape);
        this.vertexEnd += vertexCount;
        this.indexEnd += index.length;
        this.recordsDirty = true;
        return shape;
    }

    releaseShape(shape: Shape): void {
        if (--shape.refs > 0) return;
        this.shapes.delete(shape.key);
        if (shape.vertexStart + shape.vertexCount === this.vertexEnd && shape.indexStart + shape.indexCount === this.indexEnd) {
            this.vertexEnd = shape.vertexStart;
            this.indexEnd = shape.indexStart;
        } else this.vertexFreed += shape.vertexCount;
        this.recordsDirty = true;
    }

    private reserveVertices(vertexCount: number, indexCount: number): void {
        if (this.vertexEnd + vertexCount > this.vertexCapacity) {
            const capacity = growth(this.vertexEnd + vertexCount, this.vertexCapacity);
            for (const [name, itemSize] of this.vertex) this.attributes.set(name, grown(this.attributes.get(name) ?? null, Float32Array, capacity, itemSize, BufferAttribute));
            this.vertexCapacity = capacity;
            this.geometryDirty = true;
        }
        if (this.indexEnd + indexCount > this.indexCapacity) {
            this.indexCapacity = growth(this.indexEnd + indexCount, this.indexCapacity);
            this.index = grown(this.index, Uint32Array, this.indexCapacity, 1, BufferAttribute);
            this.geometryDirty = true;
        }
    }

    proxyGeometry(offsets: number[]): BufferGeometry {
        const geometry = new BufferGeometry();
        for (const [name, attribute] of this.attributes) geometry.setAttribute(name, attribute);
        geometry.setIndex(this.index);
        geometry.setIndirect(this.args, offsets);
        return geometry;
    }

    /** New proxy geometries after the vertex or index pool was replaced (old buffers are already released). */
    refreshProxies(): void {
        this.geometryDirty = false;
        for (const batch of this.batches.values()) batch.proxy.geometry = this.proxyGeometry(batch.offsets);
    }

    /**
     * One draw record per (run, range, bucket). A run is a stretch of slot-adjacent members drawing the same
     * shape and range, so batches of one model draw once: its instances are the visible slots between the run's
     * first member start and last member end.
     */
    buildRecords(): void {
        this.recordsDirty = false;
        const ordered = this.members.filter((member): member is Member => member !== null).sort((a, b) => a.range.start - b.range.start);
        const previous = new Map(ordered.map((member, index) => [member, ordered[index - 1]]));
        const args: number[] = [], records: number[] = [];
        for (const batch of this.batches.values()) {
            batch.offsets = [];
            const runs: { first: Member; last: Member; range: number }[] = [];
            const open = new Map<string, (typeof runs)[number]>();
            for (const member of ordered) {
                for (const range of member.ranges.get(batch.material) ?? []) {
                    const key = `${member.shape.key}|${range}`;
                    const run = open.get(key);
                    if (run && run.last === previous.get(member)) run.last = member;
                    else {
                        const created = { first: member, last: member, range };
                        runs.push(created);
                        open.set(key, created);
                    }
                }
            }
            for (const { first, last, range } of runs) {
                for (const record of first.shape.records) {
                    if (record.range !== range) continue;
                    batch.offsets.push(args.length * 4);
                    args.push(record.indexCount, 0, first.shape.indexStart + record.firstIndex, first.shape.vertexStart, 0);
                    records.push(first.id * cullBucketCount + record.bucket, last.id * cullBucketCount + record.bucket, record.bucket, 0);
                }
            }
        }
        this.records.dispose();
        this.args.dispose();
        this.records = new StorageBufferAttribute(new Uint32Array(records.length ? records : [0, 0, 0, 0]), 4);
        this.args = new IndirectStorageBufferAttribute(new Uint32Array(args.length ? args : [0, 0, 0, 0, 0]), 5);
        this.recordCount = records.length / 4;
        for (const batch of this.batches.values()) batch.proxy.geometry.setIndirect(this.args, batch.offsets);
        this.version++;
    }

    dispose(): void {
        const buffers = [this.rows, this.slotMember, this.masks, this.blockCounts, this.visibleIds, this.memberInfo, this.memberBounds,
            this.memberWorld, this.segments, this.records, this.args, this.index, ...this.attributes.values()];
        for (const buffer of buffers) buffer?.dispose();
        for (const batch of this.batches.values()) batch.proxy.geometry.dispose();
        this.batches.clear();
    }
}

/**
 * Draws content batches: each is sealed into the row store on its first draw and becomes a member of the GPU
 * layout of its row layout. Rows are uploaded from the store's arrays; the pool keeps no copy of them.
 */
export class DrawPool {
    readonly members = new Map<ObjectBatch, Member>();
    readonly layouts = new Map<RowLayout, Layout>();
    private readonly rejected = new WeakSet<ObjectBatch>();
    private readonly hooked = new WeakSet<object>();
    private kernels: CullKernels | null = null;
    private call = 0;

    /** Starts a render (or compile) call. */
    beginCall(): void {
        this.call++;
        // Fragmented vertex pools are rebuilt: the layout's members join a new one on their next push.
        for (const layout of [...this.layouts.values()]) if (layout.vertexFreed * 2 > layout.vertexEnd) this.dropLayout(layout);
        if (this.call % sweepInterval) return;
        // Batches no longer drawn (removed, other tabs, freed) leave; their rows stay in the store.
        for (const member of [...this.members.values()]) {
            if (member.call < this.call - sweepInterval) this.removeMember(member);
        }
    }

    /** Draws a content batch in this call; false when it cannot be pooled (nothing else draws it). */
    push(batch: ObjectBatch, groupOrder: number, clippingContext): boolean {
        const { geometry } = batch;
        if (batch.disposed || !geometry.index || geometry.drawRange.start !== 0 || geometry.drawRange.count !== Infinity) return false;
        const range = sealBatch(batch);
        if (!range) {
            if (!this.rejected.has(batch)) console.warn('[draw-pool] A content batch could not be stored in rows and is not drawn.', batch.uuid);
            this.rejected.add(batch);
            return false;
        }
        let member = this.members.get(batch);
        if (member && member.range !== range) {
            this.removeMember(member);
            member = undefined;
        }
        member ??= this.addMember(batch, range);
        if (member.call !== this.call) this.update(member);
        const { layout } = member;
        layout.call = this.call;
        for (const material of member.materials) {
            if (!material?.visible) continue;
            const entry = layout.batches.get(material) ?? this.createBatch(layout, material);
            if (entry.call !== this.call) {
                entry.call = this.call;
                entry.groupOrder = groupOrder;
                entry.clippingContext = clippingContext;
                entry.renderOrder = batch.renderOrder;
            } else entry.renderOrder = Math.max(entry.renderOrder, batch.renderOrder);
        }
        return true;
    }

    private addMember(batch: ObjectBatch, range: RowRange): Member {
        let layout = this.layouts.get(range.layout);
        if (!layout) this.layouts.set(range.layout, layout = new Layout(range.layout));
        const shape = layout.addShape(batch.geometry, drawRangesOf(batch.geometry, batch.material));
        const member = layout.addMember({ batch, layout, range, shapeStamp: shapeStampOf(batch), shape, materials: [], ranges: new Map(), call: -1, viewVersion: -1 });
        this.members.set(batch, member);
        return member;
    }

    private removeMember(member: Member): void {
        this.members.delete(member.batch);
        const { layout } = member;
        layout.removeMember(member);
        if (!layout.members.some(Boolean)) this.dropLayout(layout);
    }

    /** Releases a layout's GPU data; its live members join a new one on their next push. */
    private dropLayout(layout: Layout): void {
        for (const member of layout.members) if (member) this.members.delete(member.batch);
        layout.dispose();
        this.layouts.delete(layout.rowLayout);
    }

    /** First push of the member in this call: shape and material changes, then the rows written since the last upload. */
    private update(member: Member): void {
        const { batch, layout, range } = member;
        const shapeStamp = shapeStampOf(batch);
        if (member.shapeStamp !== shapeStamp) {
            // Vertex edits, group or material-side changes: same slots, new pooled shape.
            const shape = layout.addShape(batch.geometry, drawRangesOf(batch.geometry, batch.material));
            layout.releaseShape(member.shape);
            member.shape = shape;
            member.shapeStamp = shapeStamp;
        }
        const materials = materialsOf(batch);
        if (materials.length !== member.materials.length || materials.some((material, index) => material !== member.materials[index])) {
            member.materials = [...materials];
            member.ranges = new Map();
            drawRangesOf(batch.geometry, batch.material).forEach((entry, index) => {
                if (!entry.material) return;
                member.ranges.set(entry.material, [...member.ranges.get(entry.material) ?? [], index]);
            });
            layout.recordsDirty = true;
        }
        member.call = this.call;
        const { view } = range;
        if (view.version === member.viewVersion) return;
        // A new member uploads its whole range; later only the marked rows (all of them after an unmarked write).
        const marked = takeInstanceRows(view);
        for (const [from, to] of member.viewVersion < 0 || !marked ? [[0, range.capacity]] : marked) {
            const end = Math.min(range.capacity, to);
            if (end > from) layout.markRows((range.start + from) * layout.rowStride, (end - from) * layout.rowStride);
        }
        view.clearUpdateRanges();
        member.viewVersion = view.version;
    }

    private createBatch(layout: Layout, material: Material): Batch {
        const proxy = new Mesh(layout.proxyGeometry([]), material) as Proxy;
        proxy.pdeLayout = layout;
        // Rows always carry a color; three applies instanceColor for objects that have one.
        proxy.instanceColor = true;
        proxy.frustumCulled = false;
        proxy.matrixAutoUpdate = false;
        proxy.matrixWorldAutoUpdate = false;
        const batch: Batch = { material, proxy, offsets: [], call: -1, groupOrder: 0, renderOrder: 0, clippingContext: null };
        layout.batches.set(material, batch);
        layout.recordsDirty = true;
        if (!this.hooked.has(material)) {
            this.hooked.add(material);
            material.addEventListener('dispose', () => {
                // The proxy geometry shares the pool buffers, so it is dropped, not disposed.
                for (const entry of this.layouts.values()) if (entry.batches.delete(material)) entry.recordsDirty = true;
            });
        }
        return batch;
    }

    /** Member table: count, active flag, bucket mask, world matrix and bounds, uploaded when they change. */
    private updateMembers(layout: Layout): void {
        const info = layout.memberInfo.array as Uint32Array;
        const bounds = layout.memberBounds.array as Float32Array;
        const world = layout.memberWorld.array as Float32Array;
        let infoChanged = false, boundsChanged = false, worldChanged = false;
        for (const member of layout.members) {
            if (!member) continue;
            const { batch, id } = member;
            const count = Math.min(batch.count, member.range.capacity);
            const flags = (member.call === this.call ? 1 : 0) | member.shape.bucketMask << 1;
            if (info[id * 4 + 2] !== count || info[id * 4 + 3] !== flags) {
                info[id * 4 + 2] = count;
                info[id * 4 + 3] = flags;
                infoChanged = true;
            }
            const elements = batch.matrixWorld.elements;
            for (let index = 0; index < 16; index++) {
                if (world[id * 16 + index] !== elements[index]) {
                    world.set(elements, id * 16);
                    worldChanged = true;
                    break;
                }
            }
            const box = (batch.geometry.boundingBox ?? (batch.geometry.computeBoundingBox(), batch.geometry.boundingBox)) as Box3;
            box.getBoundingSphere(sphere);
            const values = [sphere.center.x, sphere.center.y, sphere.center.z, sphere.radius, box.min.x, box.min.y, box.min.z, 0, box.max.x, box.max.y, box.max.z, 0];
            if (values.some((value, index) => bounds[id * 12 + index] !== Math.fround(value))) {
                bounds.set(values, id * 12);
                boundsChanged = true;
            }
        }
        if (infoChanged) layout.memberInfo.needsUpdate = true;
        if (boundsChanged) layout.memberBounds.needsUpdate = true;
        if (worldChanged) layout.memberWorld.needsUpdate = true;
        if (infoChanged || boundsChanged || worldChanged) layout.version++;
    }

    private cameraKey(camera: Camera, kernels: CullKernels): string {
        projectionView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
        frustum.setFromProjectionMatrix(projectionView, camera.coordinateSystem, (camera as Camera & { reversedDepth?: boolean }).reversedDepth);
        frustum.planes.forEach((plane, index) => kernels.uniforms.planes[index].value.set(plane.normal.x, plane.normal.y, plane.normal.z, plane.constant));
        if ((camera as Camera & { isOrthographicCamera?: boolean }).isOrthographicCamera) {
            cameraAxis.setFromMatrixColumn(camera.matrixWorld, 2);
            cameraVector.set(cameraAxis.x, cameraAxis.y, cameraAxis.z, 0);
        } else {
            cameraVector.set(camera.matrixWorld.elements[12], camera.matrixWorld.elements[13], camera.matrixWorld.elements[14], 1);
        }
        kernels.uniforms.camera.value.copy(cameraVector);
        return `${projectionView.elements.join()}|${cameraVector.toArray().join()}|${dragDeltaMatrix.elements.join()}`;
    }

    private cull(renderer: WebGPURenderer, layout: Layout, kernels: CullKernels): void {
        for (const name of Object.keys(kernels.bindings) as (keyof CullKernels['bindings'])[]) kernels.bindings[name].value = layout[name];
        const blocks = Math.ceil(layout.slotEnd / cullWorkgroupSize);
        const { uniforms } = kernels;
        uniforms.slotEnd.value = layout.slotEnd;
        uniforms.blockCount.value = blocks;
        uniforms.slotCapacity.value = layout.slotCapacity;
        uniforms.rowStride.value = layout.rowStride;
        uniforms.entityOffset.value = layout.entityOffset;
        uniforms.recordCount.value = layout.recordCount;
        renderer.compute(kernels.cull, blocks * cullWorkgroupSize);
        renderer.compute(kernels.args, layout.recordCount);
    }

    /** Uploads this call's member state, culls every layout whose inputs changed, and returns the batches to draw. */
    finish(renderer: WebGPURenderer, camera: Camera): Batch[] {
        // Freed rows (disposed batches) can be reused at once: their members leave before the slot table is rewritten.
        for (const member of [...this.members.values()]) if (member.range.released) this.removeMember(member);
        const drawn: Batch[] = [];
        let cameraKey: string | null = null;
        for (const layout of this.layouts.values()) {
            if (layout.call !== this.call) continue;
            layout.sync();
            this.updateMembers(layout);
            if (layout.geometryDirty) layout.refreshProxies();
            if (layout.recordsDirty) layout.buildRecords();
            if (!layout.recordCount) continue;
            const kernels = this.kernels ??= createCullKernels(layout);
            cameraKey ??= this.cameraKey(camera, kernels);
            const frameKey = `${cameraKey}|${layout.version}`;
            if (layout.frameKey !== frameKey) {
                layout.frameKey = frameKey;
                this.cull(renderer, layout, kernels);
            }
            for (const batch of layout.batches.values()) if (batch.call === this.call && batch.offsets.length) drawn.push(batch);
        }
        return drawn;
    }

    dispose(): void {
        for (const layout of [...this.layouts.values()]) this.dropLayout(layout);
        this.members.clear();
        for (const node of this.kernels?.nodes ?? []) node.dispose();
        this.kernels = null;
    }
}
