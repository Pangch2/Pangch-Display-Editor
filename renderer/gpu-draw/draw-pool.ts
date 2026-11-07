import { BufferAttribute, BufferGeometry, Frustum, IndirectStorageBufferAttribute, InstancedInterleavedBuffer, InterleavedBufferAttribute, Matrix4, Mesh, Sphere,
    StorageBufferAttribute, Vector3, Vector4 } from 'three/webgpu';
import type { Box3, Camera, InstancedMesh, Material, WebGPURenderer } from 'three/webgpu';
import { dragDeltaMatrix, dragSelectedAttributeName, entityVisibleAttributeName } from '../entity-material';
import { buildDrawRanges, cullBucketCount, drawRangesOf, shapeKeyOf, type DrawRange, type DrawRecord } from './cull-geometry';
import { createCullKernels, cullWorkgroupSize, noMember, type CullKernels } from './cull-compute';
import type { PooledLayout } from './pool-instance';
import { rowViewBuffers, takeInstanceRows } from '../scene-store/object-access';

/** A per-instance source buffer: an instanced attribute, an instanced interleaved buffer, the matrix or the color. */
type InstanceSource = { array: Float32Array; version: number; updateRanges: { start: number; count: number }[]; clearUpdateRanges(): void };
type RowSource = { source: InstanceSource; stride: number; rowOffset: number; version: number };
type LayoutDesc = { key: string; vertex: [string, number][]; sources: Omit<RowSource, 'version'>[]; offsets: Map<string, number>; rowStride: number };
/** Pooled vertices and bucket-sorted indices of one geometry content, shared by every member drawing it. */
type Shape = { key: string; refs: number; vertexStart: number; vertexCount: number; indexStart: number; indexCount: number; records: DrawRecord[]; bucketMask: number };
type Member = {
    mesh: InstancedMesh; layout: Layout; id: number; slotStart: number; capacity: number; sources: RowSource[];
    slotKey: string; shapeStamp: string; shape: Shape;
    materials: Material[]; ranges: Map<Material, number[]>; call: number;
    /** Every source spans the full capacity, so the rows can hold all of its data. */
    adoptable: boolean;
    adoption?: Adoption;
};
/**
 * A member whose per-instance data lives only in the pool rows: its matrix, color and instanced attributes are
 * views (one interleaved buffer over its slots) and the original sources' arrays are dropped until it is released.
 */
type Adoption = {
    view: InstancedInterleavedBuffer; version: number; geometry: BufferGeometry;
    instanceMatrix: InstancedMesh['instanceMatrix']; instanceColor: InstancedMesh['instanceColor'];
    attributes: Map<string, BufferAttribute | InterleavedBufferAttribute>;
    sources: { source: InstanceSource; stride: number; rowOffset: number; items: number }[];
};
type Proxy = Mesh & { pdeLayout: Layout; instanceColor: unknown };
export type Batch = { material: Material; proxy: Proxy; offsets: number[]; call: number; groupOrder: number; renderOrder: number; clippingContext: unknown };

const rowColorOffset = 16;
const sweepInterval = 120;
const projectionView = new Matrix4();
const frustum = new Frustum();
const sphere = new Sphere();
const cameraVector = new Vector4();
const cameraAxis = new Vector3();

/** Mesh-local [dragSelected, entityVisible] views as setEntityStateAttributes lays them out. */
function entityStateOf(geometry: InstancedMesh['geometry']) {
    const visible = geometry.getAttribute(entityVisibleAttributeName);
    return visible?.isInterleavedBufferAttribute && visible.data.stride === 2 && visible.offset === 1 ? visible : null;
}

const isInstanced = (attribute): boolean => attribute.isInstancedBufferAttribute === true || attribute.data?.isInstancedInterleavedBuffer === true;
const materialsOf = (mesh: InstancedMesh): Material[] => Array.isArray(mesh.material) ? mesh.material : [mesh.material];
const attached = (object): boolean => {
    while (object.parent) object = object.parent;
    return object.isScene === true;
};

/** What decides the member's slots and row layout; a change re-registers the mesh. */
function slotKeyOf(mesh: InstancedMesh): string {
    let key = `${mesh.instanceMatrix.id}:${mesh.instanceMatrix.count}|${mesh.instanceColor?.id ?? '-'}`;
    for (const name in mesh.geometry.attributes) {
        const attribute = mesh.geometry.attributes[name];
        key += `|${name}:${!isInstanced(attribute) ? attribute.itemSize : attribute.isInterleavedBufferAttribute ? `${attribute.data.uuid}@${attribute.offset}` : attribute.id}`;
    }
    return key;
}

/** What decides the member's shape (pooled vertices and sorted indices); a change swaps the shape only. */
function shapeStampOf(mesh: InstancedMesh): string {
    const { geometry } = mesh;
    let key = `${geometry.id}|${geometry.index.id}:${geometry.index.version}|`;
    for (const group of geometry.groups) key += `${group.start},${group.count},${group.materialIndex};`;
    for (const material of materialsOf(mesh)) key += material ? `|${material.side}${material.transparent ? 1 : 0}` : '|-';
    for (const name in geometry.attributes) {
        const attribute = geometry.attributes[name];
        if (!isInstanced(attribute)) key += `|${attribute.isInterleavedBufferAttribute ? attribute.data.uuid : attribute.id}@${(attribute.data ?? attribute).version}`;
    }
    return key;
}

/** Row = instance matrix (16) + color (3, white without one) + each instanced buffer whole; null if it can't be pooled. */
function describe(mesh: InstancedMesh): LayoutDesc | null {
    const { geometry, instanceMatrix, instanceColor } = mesh;
    if (!(instanceMatrix.array instanceof Float32Array) || (instanceColor && !(instanceColor.array instanceof Float32Array))) return null;
    if (geometry.getAttribute('position')?.itemSize !== 3) return null;
    const vertex: [string, number][] = [];
    const buffers = new Map<InstanceSource, { stride: number; views: [string, number, number][] }>();
    for (const name of Object.keys(geometry.attributes).sort()) {
        const attribute = geometry.attributes[name];
        if (!isInstanced(attribute)) {
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
    const sources: LayoutDesc['sources'] = [{ source: instanceMatrix, stride: 16, rowOffset: 0 }];
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
    if (offsets.get(dragSelectedAttributeName) !== offsets.get(entityVisibleAttributeName)! - 1) return null;
    return { key, vertex, sources, offsets, rowStride };
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

/** Instances, vertices and draws of every member sharing one vertex and row layout. */
class Layout implements PooledLayout {
    readonly key: string;
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
    slotCapacity = 0; slotEnd = 0; slotFreed = 0;
    memberCapacity = 0;
    rows: BufferAttribute; slotMember: BufferAttribute; masks: BufferAttribute; blockCounts: BufferAttribute; visibleIds: BufferAttribute;
    memberInfo: BufferAttribute; memberBounds: BufferAttribute; memberWorld: BufferAttribute; segments: BufferAttribute;
    records: BufferAttribute = new StorageBufferAttribute(new Uint32Array(4), 4);
    args: BufferAttribute = new IndirectStorageBufferAttribute(new Uint32Array(5), 5);
    recordCount = 0;
    recordsDirty = true; geometryDirty = false; compact = false; grewSlots = false;
    /** Bumped by every change the cull pass reads. */
    version = 0;
    frameKey = '';
    call = -1;

    constructor(desc: LayoutDesc) {
        this.key = desc.key;
        this.vertex = desc.vertex;
        this.rowStride = desc.rowStride;
        this.offsets = desc.offsets;
        this.entityOffset = desc.offsets.get(dragSelectedAttributeName)!;
        this.growSlots(cullWorkgroupSize);
        this.growMembers(8);
    }

    private growSlots(capacity: number): void {
        this.rows = grown(this.rows, Float32Array, capacity, this.rowStride);
        this.slotMember = grown(this.slotMember, Uint32Array, capacity, 1, StorageBufferAttribute, noMember);
        this.slotCapacity = capacity;
        // Adopted members read and write the rows through views: point them at the new array.
        for (const member of this.members) if (member?.adoption) member.adoption.view.array = this.rowsOf(member.slotStart, member.capacity);
    }

    rowsOf(slotStart: number, capacity: number): Float32Array {
        return (this.rows.array as Float32Array).subarray(slotStart * this.rowStride, (slotStart + capacity) * this.rowStride);
    }

    /**
     * After a call's registrations, before anything uploads: trims the doubling slack to 1/8 and sizes the
     * GPU-only cull buffers (written by every cull run, so nothing to keep).
     */
    fitSlots(): void {
        if (this.grewSlots) {
            this.grewSlots = false;
            const fitted = Math.ceil(Math.max(this.slotEnd * 9 / 8, 1) / cullWorkgroupSize) * cullWorkgroupSize;
            if (fitted < this.slotCapacity) this.growSlots(fitted);
            this.version++;
        }
        if (this.masks?.count === this.slotCapacity) return;
        for (const buffer of [this.masks, this.visibleIds, this.blockCounts]) buffer?.dispose();
        this.masks = new StorageBufferAttribute(new Uint32Array(this.slotCapacity), 1);
        this.visibleIds = new StorageBufferAttribute(new Uint32Array(this.slotCapacity * cullBucketCount), 1);
        this.blockCounts = new StorageBufferAttribute(new Uint32Array(this.slotCapacity / cullWorkgroupSize * cullBucketCount), 1);
    }

    private growMembers(capacity: number): void {
        this.memberInfo = grown(this.memberInfo, Uint32Array, capacity, 4);
        this.memberBounds = grown(this.memberBounds, Float32Array, capacity * 3, 4);
        this.memberWorld = grown(this.memberWorld, Float32Array, capacity, 16);
        this.segments?.dispose();
        this.segments = new StorageBufferAttribute(new Uint32Array(capacity * cullBucketCount * 2), 1);
        this.memberCapacity = capacity;
    }

    /** First slot of `count` new slots, or null past the storage binding limit. */
    allocateSlots(count: number, maxBindingSize: number): number | null {
        const end = this.slotEnd + count;
        if (end > this.slotCapacity) {
            const bytes = (slots: number) => slots * Math.max(this.rowStride, cullBucketCount) * 4;
            const round = (slots: number) => Math.ceil(slots / cullWorkgroupSize) * cullWorkgroupSize;
            let capacity = round(growth(end, this.slotCapacity));
            if (bytes(capacity) > maxBindingSize) capacity = round(end);
            if (bytes(capacity) > maxBindingSize) return null;
            this.growSlots(capacity);
            this.grewSlots = true;
        }
        const start = this.slotEnd;
        this.slotEnd = end;
        return start;
    }

    addMember(member: Omit<Member, 'id'>): Member {
        let id = this.members.indexOf(null);
        if (id < 0) id = this.members.length;
        if (id >= this.memberCapacity) this.growMembers(this.memberCapacity * 2);
        const added = { ...member, id } as Member;
        this.members[id] = added;
        const { slotStart, capacity } = added;
        (this.slotMember.array as Uint32Array).fill(id, slotStart, slotStart + capacity);
        this.slotMember.addUpdateRange(slotStart, capacity);
        this.slotMember.needsUpdate = true;
        if (!added.mesh.instanceColor) {
            const rows = this.rows.array as Float32Array;
            for (let slot = slotStart; slot < slotStart + capacity; slot++) rows.fill(1, slot * this.rowStride + rowColorOffset, slot * this.rowStride + rowColorOffset + 3);
            this.markRows(slotStart * this.rowStride, capacity * this.rowStride);
        }
        (this.memberInfo.array as Uint32Array).set([slotStart, capacity, 0, 0], id * 4);
        this.memberInfo.needsUpdate = true;
        this.recordsDirty = true;
        this.version++;
        return added;
    }

    removeMember(member: Member): void {
        this.members[member.id] = null;
        const { slotStart, capacity } = member;
        (this.slotMember.array as Uint32Array).fill(noMember, slotStart, slotStart + capacity);
        this.slotMember.addUpdateRange(slotStart, capacity);
        this.slotMember.needsUpdate = true;
        (this.memberInfo.array as Uint32Array).fill(0, member.id * 4, member.id * 4 + 4);
        this.memberInfo.needsUpdate = true;
        if (slotStart + capacity === this.slotEnd) this.slotEnd = slotStart;
        else this.slotFreed += capacity;
        this.releaseShape(member.shape);
        this.recordsDirty = true;
        this.version++;
        if (this.slotFreed * 2 > this.slotEnd || this.vertexFreed * 2 > this.vertexEnd) this.compact = true;
    }

    markRows(start: number, count: number): void {
        const ranges = this.rows.updateRanges;
        // Past a few dozen ranges one covering write is cheaper than many small ones.
        if (ranges.length >= 64) {
            const first = Math.min(start, ...ranges.map(range => range.start));
            const last = Math.max(start + count, ...ranges.map(range => range.start + range.count));
            this.rows.clearUpdateRanges();
            this.rows.addUpdateRange(first, last - first);
        } else this.rows.addUpdateRange(start, count);
        this.rows.needsUpdate = true;
        this.version++;
    }

    addShape(geometry: InstancedMesh['geometry'], ranges: DrawRange[]): Shape {
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
     * shape and range, so chunks of one model draw once: its instances are the visible slots between the run's
     * first member start and last member end.
     */
    buildRecords(): void {
        this.recordsDirty = false;
        const ordered = this.members.filter((member): member is Member => member !== null).sort((a, b) => a.slotStart - b.slotStart);
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
 * Content InstancedMeshes registered as members of layout pools. A member's per-instance data is copied into
 * its rows once; after that the mesh is adopted and reads and writes the rows directly (see Adoption).
 */
export class DrawPool {
    readonly members = new Map<InstancedMesh, Member>();
    readonly layouts = new Map<string, Layout>();
    private readonly rejected = new WeakMap<InstancedMesh, string>();
    private readonly hooked = new WeakSet<object>();
    /** A geometry shared by two meshes is never adopted: its attribute views would belong to one of them. */
    private readonly geometryOwners = new WeakMap<BufferGeometry, InstancedMesh>();
    private readonly sharedGeometries = new WeakSet<BufferGeometry>();
    private kernels: CullKernels | null = null;
    private call = 0;

    private readonly maxBindingSize: number;

    constructor(maxBindingSize: number) {
        this.maxBindingSize = maxBindingSize;
    }

    /** Starts a render (or compile) call. */
    beginCall(): void {
        this.call++;
        for (const layout of [...this.layouts.values()]) if (layout.compact) this.dropLayout(layout);
        if (this.call % sweepInterval) return;
        for (const member of [...this.members.values()]) {
            if (member.call < this.call - sweepInterval && !attached(member.mesh)) this.release(member, true);
        }
    }

    /** Takes a render item of a content mesh; false leaves it to the regular pipeline. */
    push(object, geometry, material: Material, groupOrder: number, clippingContext): boolean {
        const mesh = object as InstancedMesh;
        if (mesh.isInstancedMesh !== true || material.wireframe || !geometry.index) return false;
        if (!this.members.get(mesh)?.adoption && !entityStateOf(geometry)) return false;
        if (geometry.drawRange.start !== 0 || geometry.drawRange.count !== Infinity) return false;
        if (clippingContext.unionPlanes?.length || clippingContext.intersectionPlanes?.length) return false;
        let member = this.members.get(mesh);
        if (member?.call !== this.call) {
            member = this.update(mesh, member);
            if (!member) return false;
        }
        const layout = member.layout;
        layout.call = this.call;
        const batch = layout.batches.get(material) ?? this.createBatch(layout, material);
        if (batch.call !== this.call) {
            batch.call = this.call;
            batch.groupOrder = groupOrder;
            batch.clippingContext = clippingContext;
            batch.renderOrder = mesh.renderOrder;
        } else batch.renderOrder = Math.max(batch.renderOrder, mesh.renderOrder);
        return true;
    }

    /** First push of the mesh in this call: (re)register on structural changes, then copy changed rows. */
    private update(mesh: InstancedMesh, member: Member | undefined): Member | null {
        const slotKey = slotKeyOf(mesh);
        if (member && (member.slotKey !== slotKey || mesh.count > member.capacity)) {
            this.release(member, true);
            member = undefined;
        }
        if (!member) {
            if (this.rejected.get(mesh) === slotKey) return null;
            member = this.register(mesh, slotKey) ?? undefined;
            if (!member) {
                this.rejected.set(mesh, slotKey);
                return null;
            }
        }
        const { layout } = member;
        const shapeStamp = shapeStampOf(mesh);
        if (member.shapeStamp !== shapeStamp) {
            // Vertex edits, group or material-side changes: same slots, new pooled shape.
            const shape = layout.addShape(mesh.geometry, drawRangesOf(mesh.geometry, mesh.material));
            layout.releaseShape(member.shape);
            member.shape = shape;
            member.shapeStamp = shapeStamp;
        }
        const materials = materialsOf(mesh);
        if (materials.length !== member.materials.length || materials.some((material, index) => material !== member.materials[index])) {
            member.materials = [...materials];
            member.ranges = new Map();
            drawRangesOf(mesh.geometry, mesh.material).forEach((range, index) => {
                if (!range.material) return;
                const ranges = member.ranges.get(range.material) ?? [];
                member.ranges.set(range.material, [...ranges, index]);
            });
            layout.recordsDirty = true;
        }
        member.call = this.call;
        if (member.adoption) this.markAdoptedRows(member);
        else {
            this.copyRows(member);
            if (member.adoptable) this.adopt(member);
        }
        return member;
    }

    private register(mesh: InstancedMesh, slotKey: string): Member | null {
        const desc = describe(mesh);
        if (!desc) return null;
        const owner = this.geometryOwners.get(mesh.geometry);
        if (owner && owner !== mesh) {
            this.sharedGeometries.add(mesh.geometry);
            const adopted = this.members.get(owner);
            if (adopted?.adoption) this.release(adopted, true);
        } else this.geometryOwners.set(mesh.geometry, mesh);
        // Adopted meshes keep their whole capacity in rows: their own arrays go away. Others keep 1/8 room to
        // append and re-register when they outgrow it.
        const adoptable = !this.sharedGeometries.has(mesh.geometry)
            && desc.sources.every(({ source, stride }) => source.array.length / stride === mesh.instanceMatrix.count);
        const capacity = adoptable ? mesh.instanceMatrix.count
            : Math.min(mesh.instanceMatrix.count, mesh.count + Math.max(16, Math.ceil(mesh.count / 8)));
        if (!capacity) return null;
        let layout = this.layouts.get(desc.key);
        if (!layout) this.layouts.set(desc.key, layout = new Layout(desc));
        const slotStart = layout.allocateSlots(capacity, this.maxBindingSize);
        if (slotStart === null) {
            if (!layout.members.some(Boolean)) this.dropLayout(layout);
            return null;
        }
        const shape = layout.addShape(mesh.geometry, drawRangesOf(mesh.geometry, mesh.material));
        const member = layout.addMember({
            mesh, layout, slotStart, capacity, slotKey, shapeStamp: shapeStampOf(mesh), shape, adoptable,
            sources: desc.sources.map(source => ({ ...source, version: -1 })), materials: [], ranges: new Map(), call: -1
        });
        this.members.set(mesh, member);
        if (!this.hooked.has(mesh)) {
            this.hooked.add(mesh);
            mesh.addEventListener('dispose', () => {
                const current = this.members.get(mesh);
                if (current) this.release(current, false);
            });
        }
        return member;
    }

    /** Frees the member's slots; `keepData` copies an adopted member's data back into its own arrays (not on dispose). */
    private release(member: Member, keepData: boolean): void {
        this.detach(member, keepData);
        this.members.delete(member.mesh);
        const { layout } = member;
        layout.removeMember(member);
        if (!layout.members.some(Boolean)) this.dropLayout(layout);
    }

    /** Releases a layout's GPU data; its live members register again on their next push (compaction). */
    private dropLayout(layout: Layout): void {
        for (const member of layout.members) if (member) {
            this.detach(member, true);
            this.members.delete(member.mesh);
        }
        layout.dispose();
        this.layouts.delete(layout.key);
    }

    /** Copies the per-instance sources whose version changed into the member's rows. */
    private copyRows(member: Member): void {
        const { layout, slotStart, capacity } = member;
        const rows = layout.rows.array as Float32Array;
        const rowStride = layout.rowStride;
        for (const entry of member.sources) {
            const { source, stride, rowOffset } = entry;
            if (source.version === entry.version) continue;
            const items = Math.min(capacity, Math.floor(source.array.length / stride));
            const marked = takeInstanceRows(source);
            const spans = entry.version < 0 || !marked ? [[0, items]] : marked.map(([from, to]) => [from, Math.min(items, to)]);
            const array = source.array;
            for (const [from, to] of spans) {
                if (to <= from) continue;
                for (let item = from; item < to; item++) {
                    const target = (slotStart + item) * rowStride + rowOffset;
                    const start = item * stride;
                    for (let component = 0; component < stride; component++) rows[target + component] = array[start + component];
                }
                layout.markRows((slotStart + from) * rowStride, (to - from) * rowStride);
            }
            // three never uploads pooled sources; drop ranges other writers left.
            source.clearUpdateRanges();
            entry.version = source.version;
        }
    }

    /** Replaces the member's per-instance sources with views into its rows and drops their arrays. */
    private adopt(member: Member): void {
        const { mesh, layout } = member;
        const { geometry } = mesh;
        const view = new InstancedInterleavedBuffer(layout.rowsOf(member.slotStart, member.capacity), layout.rowStride, 1);
        rowViewBuffers.add(view);
        const attributes = new Map<string, BufferAttribute | InterleavedBufferAttribute>();
        for (const name in geometry.attributes) {
            const attribute = geometry.attributes[name];
            if (!isInstanced(attribute)) continue;
            attributes.set(name, attribute);
            geometry.attributes[name] = new InterleavedBufferAttribute(view, attribute.itemSize, layout.offsets.get(name)!, attribute.normalized);
        }
        member.adoption = {
            view, version: view.version, geometry, instanceMatrix: mesh.instanceMatrix, instanceColor: mesh.instanceColor, attributes,
            sources: member.sources.map(({ source, stride, rowOffset }) => ({ source, stride, rowOffset, items: source.array.length / stride }))
        };
        mesh.instanceMatrix = new InterleavedBufferAttribute(view, 16, 0) as unknown as InstancedMesh['instanceMatrix'];
        if (mesh.instanceColor) mesh.instanceColor = new InterleavedBufferAttribute(view, 3, rowColorOffset) as unknown as InstancedMesh['instanceColor'];
        for (const { source } of member.adoption.sources) source.array = new Float32Array(0);
        member.slotKey = slotKeyOf(mesh);
    }

    /** Restores an adopted member's original sources; with `copyData` their arrays are refilled from the rows. */
    private detach(member: Member, copyData: boolean): void {
        const { adoption, mesh, layout, slotStart } = member;
        if (!adoption) return;
        member.adoption = undefined;
        const rows = layout.rows.array as Float32Array;
        for (const { source, stride, rowOffset, items } of copyData ? adoption.sources : []) {
            const array = new Float32Array(items * stride);
            for (let item = 0; item < Math.min(items, member.capacity); item++) {
                const from = (slotStart + item) * layout.rowStride + rowOffset;
                array.set(rows.subarray(from, from + stride), item * stride);
            }
            source.array = array;
            (source as unknown as { needsUpdate: boolean }).needsUpdate = true;
        }
        const isView = (attribute: unknown) => (attribute as InterleavedBufferAttribute | null)?.data === adoption.view;
        if (isView(mesh.instanceMatrix)) mesh.instanceMatrix = adoption.instanceMatrix;
        if (isView(mesh.instanceColor)) mesh.instanceColor = adoption.instanceColor;
        // Attributes replaced since adoption stay; their views' values are superseded.
        for (const [name, attribute] of adoption.attributes) {
            if (isView(adoption.geometry.attributes[name])) adoption.geometry.attributes[name] = attribute;
        }
    }

    /** Turns writes to an adopted member's rows into upload ranges: marked rows, or all of them after an unmarked change. */
    private markAdoptedRows(member: Member): void {
        const { layout, slotStart, capacity, adoption } = member;
        const { view } = adoption!;
        if (view.version === adoption!.version) return;
        for (const [from, to] of takeInstanceRows(view) ?? [[0, capacity]]) {
            const end = Math.min(capacity, to);
            if (end > from) layout.markRows((slotStart + from) * layout.rowStride, (end - from) * layout.rowStride);
        }
        view.clearUpdateRanges();
        adoption!.version = view.version;
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
            const { mesh, id } = member;
            const count = Math.min(mesh.count, member.capacity);
            const flags = (member.call === this.call ? 1 : 0) | member.shape.bucketMask << 1;
            if (info[id * 4 + 2] !== count || info[id * 4 + 3] !== flags) {
                info[id * 4 + 2] = count;
                info[id * 4 + 3] = flags;
                infoChanged = true;
            }
            const elements = mesh.matrixWorld.elements;
            for (let index = 0; index < 16; index++) {
                if (world[id * 16 + index] !== elements[index]) {
                    world.set(elements, id * 16);
                    worldChanged = true;
                    break;
                }
            }
            const box = (mesh.geometry.boundingBox ?? (mesh.geometry.computeBoundingBox(), mesh.geometry.boundingBox)) as Box3;
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
        const drawn: Batch[] = [];
        let cameraKey: string | null = null;
        for (const layout of this.layouts.values()) {
            if (layout.call !== this.call) continue;
            layout.fitSlots();
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
