import { FrontSide, type BufferGeometry, type Material } from 'three/webgpu';

export const cullBucketCount = 7;
const anyBucket = 6;

/** One indirect draw template: the triangles of one draw range (group) that face one direction. */
export type DrawRecord = { range: number; bucket: number; firstIndex: number; indexCount: number };
export type DrawRange = { start: number; end: number; material: Material | undefined };
export type DrawRanges = { index: Uint32Array; records: DrawRecord[]; bucketMask: number };

// Buckets 0-5 are +X,-X,+Y,-Y,+Z,-Z; 6 is any other direction. Near-axis only, so the axis plane test stays conservative.
const axisBucket = (x: number, y: number, z: number): number => {
    const length = Math.hypot(x, y, z);
    if (!length) return anyBucket;
    const limit = length * (1 - 1e-5);
    return Math.abs(x) > limit ? (x > 0 ? 0 : 1)
        : Math.abs(y) > limit ? (y > 0 ? 2 : 3)
            : Math.abs(z) > limit ? (z > 0 ? 4 : 5) : anyBucket;
};

/** The index ranges three draws: geometry groups for a material array, else the whole index. */
export function drawRangesOf(geometry: BufferGeometry, material: Material | Material[]): DrawRange[] {
    const count = geometry.index!.count;
    return Array.isArray(material) && geometry.groups.length
        ? geometry.groups.map(group => ({ start: group.start, end: Math.min(count, group.start + group.count), material: material[group.materialIndex ?? 0] }))
        : [{ start: 0, end: count, material: Array.isArray(material) ? material[0] : material }];
}

/**
 * Sorts each range's triangles by winding direction into a copy of the index, so every (range, bucket)
 * pair is one contiguous indirect draw. `geometry.index` stays untouched for raycasts and face-indexed tools.
 */
export function buildDrawRanges(geometry: BufferGeometry, ranges: DrawRange[]): DrawRanges {
    const indices = geometry.index!.array as ArrayLike<number>;
    const position = geometry.getAttribute('position');
    const index = Uint32Array.from(indices);
    const records: DrawRecord[] = [];
    let bucketMask = 0;
    ranges.forEach((range, rangeIndex) => {
        // Faces drawn from both sides can't be culled by direction. Blended faces keep their original
        // order: they write depth, so reordering them changes which overlapping layers show.
        const facing = range.material?.side === FrontSide && !range.material.transparent;
        const buckets = new Uint8Array(Math.max(0, Math.ceil((range.end - range.start) / 3))).fill(anyBucket);
        const counts = new Array<number>(cullBucketCount).fill(0);
        for (let i = range.start; i + 2 < range.end; i += 3) {
            let bucket = anyBucket;
            if (facing) {
                // Winding, not the normal attribute, decides what the GPU culls (mirrored parts flip it).
                const a = indices[i], b = indices[i + 1], c = indices[i + 2];
                const abX = position.getX(b) - position.getX(a), abY = position.getY(b) - position.getY(a), abZ = position.getZ(b) - position.getZ(a);
                const acX = position.getX(c) - position.getX(a), acY = position.getY(c) - position.getY(a), acZ = position.getZ(c) - position.getZ(a);
                bucket = axisBucket(abY * acZ - abZ * acY, abZ * acX - abX * acZ, abX * acY - abY * acX);
            }
            buckets[(i - range.start) / 3] = bucket;
            counts[bucket] += 3;
        }
        const cursor: number[] = [];
        let offset = range.start;
        for (let bucket = 0; bucket < cullBucketCount; bucket++) {
            cursor[bucket] = offset;
            if (counts[bucket]) {
                records.push({ range: rangeIndex, bucket, firstIndex: offset, indexCount: counts[bucket] });
                bucketMask |= 1 << bucket;
            }
            offset += counts[bucket];
        }
        for (let i = range.start; i + 2 < range.end; i += 3) {
            const bucket = buckets[(i - range.start) / 3];
            index[cursor[bucket]] = indices[i];
            index[cursor[bucket] + 1] = indices[i + 1];
            index[cursor[bucket] + 2] = indices[i + 2];
            cursor[bucket] += 3;
        }
    });
    return { index, records, bucketMask };
}

type HashedArray = ArrayLike<number> & { buffer: ArrayBufferLike; byteOffset: number; byteLength: number };

/** A content key: geometries with equal vertices, indices and ranges share pooled data. */
export function shapeKeyOf(geometry: BufferGeometry, ranges: DrawRange[], vertexNames: string[]): string {
    let h1 = 0x811c9dc5, h2 = 0x9747b28c;
    const mix = (value: number) => {
        h1 = Math.imul(h1 ^ value, 0x01000193);
        h2 = Math.imul(h2 ^ value, 0x5bd1e995);
        h2 ^= h2 >>> 15;
    };
    const mixArray = (array: HashedArray) => {
        // Float bits, not values, so -0/NaN differences keep geometries apart.
        const words = array.byteLength % 4 === 0 && array.byteOffset % 4 === 0 && (array as unknown as { BYTES_PER_ELEMENT: number }).BYTES_PER_ELEMENT === 4
            ? new Uint32Array(array.buffer, array.byteOffset, array.byteLength >> 2) : array;
        mix(words.length);
        for (let i = 0; i < words.length; i++) mix(words[i]);
    };
    for (const name of vertexNames) {
        const attribute = geometry.getAttribute(name) as unknown as { isInterleavedBufferAttribute?: boolean; data?: { array: HashedArray; stride: number }; array: HashedArray; offset?: number; itemSize: number; normalized: boolean };
        mix(attribute.itemSize | (attribute.normalized ? 256 : 0) | ((attribute.offset ?? 0) << 9) | ((attribute.data?.stride ?? 0) << 17));
        mixArray(attribute.isInterleavedBufferAttribute ? attribute.data!.array : attribute.array);
    }
    mixArray(geometry.index!.array as unknown as HashedArray);
    for (const range of ranges) {
        mix(range.start);
        mix(range.end);
        mix(range.material?.side === FrontSide && !range.material.transparent ? 1 : 0);
    }
    return `${h1 >>> 0}:${h2 >>> 0}:${geometry.getAttribute('position').count}:${geometry.index!.count}:${ranges.length}`;
}
