import { Vector4 } from 'three/webgpu';
import type { BufferAttribute, IndirectStorageBufferAttribute, StorageBufferAttribute } from 'three/webgpu';
import { Fn, If, Loop, instanceIndex, localId, mat4, max, min, select, storage, uint, uniform, uvec4, vec3, vec4, workgroupArray, workgroupBarrier, workgroupId } from 'three/tsl';
import { dragDeltaMatrix } from '../entity-material';
import { cullBucketCount } from './cull-geometry';

export const cullWorkgroupSize = 256;
/** `slotMember` value of a free slot. */
export const noMember = 0xffffffff;
const anyBucketBit = 1 << (cullBucketCount - 1);
const axes = ['x', 'y', 'z'] as const;
const lanes = ['x', 'y', 'z', 'w'] as const;

/** The GPU side of one layout pool (see draw-pool.ts). */
export type CullBuffers = {
    /** Per slot: instance matrix (16), color (3), then the instanced buffers of the layout. */
    rows: BufferAttribute;
    /** Per slot: owning member, or `noMember`. */
    slotMember: StorageBufferAttribute;
    /** Per member: slotStart, capacity, count, active | bucketMask << 1. */
    memberInfo: StorageBufferAttribute;
    /** Per member: bounding sphere, bbox min, bbox max (vec4 each). */
    memberBounds: StorageBufferAttribute;
    memberWorld: StorageBufferAttribute;
    masks: StorageBufferAttribute;
    blockCounts: StorageBufferAttribute;
    /** Bucket-major: `bucket * slotCapacity + position`. */
    visibleIds: StorageBufferAttribute;
    /** Per member and bucket: [first visible position, end position]. */
    segments: StorageBufferAttribute;
    /** Per draw record: first member seg, last member seg, bucket. */
    records: StorageBufferAttribute;
    args: IndirectStorageBufferAttribute;
};

/** Per-bucket counts of this lane and all earlier lanes in the workgroup, as 16-bit pairs (buckets 0-1 in x, ...). */
function scanLanes(scan, lane, mask) {
    const bit = (bucket: number) => mask.shiftRight(bucket).bitAnd(1);
    const own = uvec4(bit(0).bitOr(bit(1).shiftLeft(16)), bit(2).bitOr(bit(3).shiftLeft(16)),
        bit(4).bitOr(bit(5).shiftLeft(16)), bit(6)).toVar();
    const inclusive = own.toVar();
    scan.element(lane).assign(inclusive);
    // Hillis-Steele: 8 steps for 256 lanes; the clamped index keeps every read in bounds.
    for (let offset = 1; offset < cullWorkgroupSize; offset *= 2) {
        workgroupBarrier();
        const earlier = select(lane.greaterThanEqual(offset), scan.element(max(lane, uint(offset)).sub(offset)), uvec4(0)).toVar();
        workgroupBarrier();
        inclusive.addAssign(earlier);
        scan.element(lane).assign(inclusive);
    }
    return { own, inclusive };
}

const bucketCount = (packed, bucket: number) => packed[lanes[bucket >> 1]].shiftRight((bucket & 1) * 16).bitAnd(0xffff);

/**
 * The cull passes, shared by every layout: each layout rebinds its buffers and uniforms before its own
 * dispatch, so the WGSL (and the pipeline) is built once.
 */
export function createCullKernels(buffers: CullBuffers) {
    const bindings = {
        rows: storage(buffers.rows, 'float').toReadOnly(),
        slotMember: storage(buffers.slotMember, 'uint').toReadOnly(),
        memberInfo: storage(buffers.memberInfo, 'uvec4').toReadOnly(),
        memberBounds: storage(buffers.memberBounds, 'vec4').toReadOnly(),
        memberWorld: storage(buffers.memberWorld, 'mat4').toReadOnly(),
        masks: storage(buffers.masks, 'uint'),
        blockCounts: storage(buffers.blockCounts, 'uint'),
        visibleIds: storage(buffers.visibleIds, 'uint'),
        segments: storage(buffers.segments, 'uint'),
        records: storage(buffers.records, 'uvec4').toReadOnly(),
        args: storage(buffers.args, 'uint')
    };
    const uniforms = {
        slotEnd: uniform(0, 'uint'),
        blockCount: uniform(0, 'uint'),
        slotCapacity: uniform(0, 'uint'),
        rowStride: uniform(0, 'uint'),
        entityOffset: uniform(0, 'uint'),
        recordCount: uniform(0, 'uint'),
        planes: Array.from({ length: 6 }, () => uniform(new Vector4())),
        // World camera: (position, 1) for perspective, (direction toward the camera, 0) for orthographic.
        camera: uniform(new Vector4())
    };
    const dragDelta = uniform(dragDeltaMatrix);
    const { rows, slotMember, memberInfo, memberBounds, memberWorld, masks, blockCounts, visibleIds, segments, records, args } = bindings;
    const { slotEnd, slotCapacity, rowStride, entityOffset, recordCount, planes, camera } = uniforms;

    /** Pass 1: a visible-bucket bit mask per slot, plus per-block bucket counts. */
    const classifyScan = workgroupArray('uvec4', cullWorkgroupSize).setName('pdeCullClassifyScan');
    const classify = Fn(() => {
        const id = instanceIndex;
        const lane = localId.x;
        const mask = uint(0).toVar();
        If(id.lessThan(slotEnd), () => {
            const member = slotMember.element(id).toVar();
            If(member.notEqual(noMember), () => {
                const info = memberInfo.element(member).toVar();
                const base = id.mul(rowStride).toVar();
                const active = info.w.bitAnd(1).equal(1).and(id.sub(info.x).lessThan(info.z));
                If(active.and(rows.element(base.add(entityOffset).add(1)).greaterThan(0.5)), () => {
                    const column = (index: number) => vec4(...[0, 1, 2, 3].map(row => rows.element(base.add(index * 4 + row))));
                    const matrix = memberWorld.element(member).mul(mat4(column(0), column(1), column(2), column(3))).toVar();
                    // Same transform as dragPreviewPosition, so selected instances cull where they are drawn.
                    If(rows.element(base.add(entityOffset)).greaterThan(0), () => { matrix.assign(dragDelta.mul(matrix)); });
                    const sphere = memberBounds.element(member.mul(3)).toVar();
                    const boundsMin = memberBounds.element(member.mul(3).add(1)).xyz.toVar();
                    const boundsMax = memberBounds.element(member.mul(3).add(2)).xyz.toVar();
                    const bucketMask = info.w.shiftRight(1).toVar();
                    const a0 = matrix.element(0).xyz.toVar(), a1 = matrix.element(1).xyz.toVar(), a2 = matrix.element(2).xyz.toVar();
                    const translation = matrix.element(3).xyz.toVar();
                    const center = a0.mul(sphere.x).add(a1.mul(sphere.y)).add(a2.mul(sphere.z)).add(translation).toVar();
                    const radius = sphere.w.mul(max(a0.length(), max(a1.length(), a2.length()))).negate().toVar();
                    let inside = planes[0].xyz.dot(center).add(planes[0].w).greaterThanEqual(radius);
                    for (const plane of planes.slice(1)) inside = inside.and(plane.xyz.dot(center).add(plane.w).greaterThanEqual(radius));
                    If(inside, () => {
                        // adj(A)·(camera - w·t) = det · (camera in instance space); avoids dividing by det.
                        const c0 = a1.cross(a2).toVar(), c1 = a2.cross(a0).toVar(), c2 = a0.cross(a1).toVar();
                        const det = a0.dot(c0).toVar();
                        const toCamera = camera.xyz.sub(translation.mul(camera.w)).toVar();
                        const local = vec3(c0.dot(toCamera), c1.dot(toCamera), c2.dot(toCamera)).toVar();
                        // A collapsed axis (det 0) can still leave faces with area, so keep every direction.
                        mask.assign(bucketMask);
                        If(det.notEqual(0), () => {
                            mask.assign(bucketMask.bitAnd(anyBucketBit));
                            for (let bucket = 0; bucket < 6; bucket++) {
                                const axis = axes[bucket >> 1];
                                const sign = bucket & 1 ? -1 : 1;
                                // Nearest (det > 0) or farthest (mirrored) bounds plane of the faces facing this way.
                                const lower = sign > 0 ? boundsMin[axis] : boundsMax[axis].negate();
                                const upper = sign > 0 ? boundsMax[axis] : boundsMin[axis].negate();
                                const plane = select(det.greaterThan(0), lower, upper);
                                If(local[axis].mul(sign).greaterThan(camera.w.mul(det).mul(plane)), () => {
                                    mask.assign(mask.bitOr(bucketMask.bitAnd(1 << bucket)));
                                });
                            }
                        });
                    });
                });
            });
        });
        masks.element(id).assign(mask);
        const { inclusive } = scanLanes(classifyScan, lane, mask);
        If(lane.equal(cullWorkgroupSize - 1), () => {
            for (let bucket = 0; bucket < cullBucketCount; bucket++) {
                blockCounts.element(workgroupId.x.mul(cullBucketCount).add(bucket)).assign(bucketCount(inclusive, bucket));
            }
        });
    })().computeKernel([cullWorkgroupSize]);

    /**
     * Pass 2, first workgroup only: turns `blockCounts` into each block's exclusive start per bucket in place.
     * Every lane sums a run of blocks, the lanes scan their sums, then rewrite their run.
     */
    const startScan = workgroupArray('uint', cullWorkgroupSize).setName('pdeCullStartScan');
    const scanBlocks = Fn(() => {
        // workgroup_id is uniform, so the barriers inside stay in uniform control flow.
        If(workgroupId.x.equal(0), () => {
            const lane = localId.x;
            const run = uniforms.blockCount.add(cullWorkgroupSize - 1).div(cullWorkgroupSize).toVar();
            const first = lane.mul(run).toVar();
            const last = min(first.add(run), uniforms.blockCount).toVar();
            for (let bucket = 0; bucket < cullBucketCount; bucket++) {
                const total = uint(0).toVar();
                Loop({ start: first, end: last, type: 'uint', condition: '<' }, ({ i }) => {
                    total.addAssign(blockCounts.element(i.mul(cullBucketCount).add(bucket)));
                });
                const inclusive = total.toVar();
                startScan.element(lane).assign(inclusive);
                for (let offset = 1; offset < cullWorkgroupSize; offset *= 2) {
                    workgroupBarrier();
                    const earlier = select(lane.greaterThanEqual(offset), startScan.element(max(lane, uint(offset)).sub(offset)), uint(0)).toVar();
                    workgroupBarrier();
                    inclusive.addAssign(earlier);
                    startScan.element(lane).assign(inclusive);
                }
                workgroupBarrier();
                const start = inclusive.sub(total).toVar();
                Loop({ start: first, end: last, type: 'uint', condition: '<' }, ({ i }) => {
                    const index = i.mul(cullBucketCount).add(bucket);
                    const count = blockCounts.element(index).toVar();
                    blockCounts.element(index).assign(start);
                    start.addAssign(count);
                });
            }
        });
    })().computeKernel([cullWorkgroupSize]);

    /** Pass 3: order-preserving compaction into `visibleIds`, plus each member's visible segment per bucket. */
    const compactScan = workgroupArray('uvec4', cullWorkgroupSize).setName('pdeCullCompactScan');
    const blockStarts = workgroupArray('uint', cullBucketCount).setName('pdeCullBlockStarts');
    const compact = Fn(() => {
        const id = instanceIndex;
        const lane = localId.x;
        const block = workgroupId.x;
        If(lane.lessThan(cullBucketCount), () => {
            blockStarts.element(lane).assign(blockCounts.element(block.mul(cullBucketCount).add(lane)));
        });
        const mask = masks.element(id).toVar();
        // The scan's barriers also publish blockStarts.
        const { own, inclusive } = scanLanes(compactScan, lane, mask);
        const before = inclusive.sub(own).toVar();
        const position = (packed, bucket: number) => blockStarts.element(uint(bucket)).add(bucketCount(packed, bucket));
        for (let bucket = 0; bucket < cullBucketCount; bucket++) {
            If(mask.shiftRight(bucket).bitAnd(1).equal(1), () => {
                visibleIds.element(slotCapacity.mul(bucket).add(position(before, bucket))).assign(id);
            });
        }
        If(id.lessThan(slotEnd), () => {
            const member = slotMember.element(id).toVar();
            If(member.notEqual(noMember), () => {
                const info = memberInfo.element(member).toVar();
                const segment = (bucket: number) => member.mul(cullBucketCount).add(bucket).mul(2);
                If(id.equal(info.x), () => {
                    for (let bucket = 0; bucket < cullBucketCount; bucket++) segments.element(segment(bucket)).assign(position(before, bucket));
                });
                If(id.equal(info.x.add(info.y).sub(1)), () => {
                    for (let bucket = 0; bucket < cullBucketCount; bucket++) segments.element(segment(bucket).add(1)).assign(position(inclusive, bucket));
                });
            });
        });
    })().computeKernel([cullWorkgroupSize]);

    /** Pass 4: each record's instances are the visible slots from its first member's start to its last member's end. */
    const writeArgs = Fn(() => {
        const id = instanceIndex;
        If(id.lessThan(recordCount), () => {
            const record = records.element(id).toVar();
            const start = segments.element(record.x.mul(2)).toVar();
            args.element(id.mul(5).add(1)).assign(segments.element(record.y.mul(2).add(1)).sub(start));
            args.element(id.mul(5).add(4)).assign(slotCapacity.mul(record.z).add(start));
        });
    })().computeKernel([64]);

    return { bindings, uniforms, cull: [classify, scanBlocks, compact], args: writeArgs, nodes: [classify, scanBlocks, compact, writeArgs] };
}

export type CullKernels = ReturnType<typeof createCullKernels>;
