import type { BufferAttribute, Camera, Object3D, WebGPURenderer } from 'three/webgpu';
import type { ObjectBatch } from '../scene-store/object-batch';
import type { PdeDrawingPipeline } from './gpu-draw-pipeline';
import { drawRangesOf } from './cull-geometry';

export type SceneVertexCounts = { total: number; culled: number | null };

const shapeCounts = new WeakMap<object, Map<string, { vertices: Uint8Array; counts: Map<number, number> }>>();

/** Counts geometry vertices per instance, using the last GPU cull masks (shared face vertices count once). */
export async function readSceneVertexCounts(renderer: WebGPURenderer, root: Object3D, camera: Camera): Promise<SceneVertexCounts> {
    let total = 0;
    root.traverse((batch: ObjectBatch) => {
        if (batch.isObjectBatch && !batch.disposed) total += (batch.geometry.getAttribute('position')?.count ?? 0) * batch.count;
    });
    const pool = (renderer.drawingPipeline as PdeDrawingPipeline).pool;
    if (!pool) return { total, culled: total ? null : 0 };
    const reads = new Map<BufferAttribute, Promise<Uint32Array>>();
    const drawn: Promise<number>[] = [];
    root.traverseVisible((batch: ObjectBatch) => {
        if (!batch.isObjectBatch || batch.disposed || !batch.count || !batch.layers.test(camera.layers)) return;
        const member = pool.members.get(batch);
        if (!member) return;
        const { layout, shape, range } = member;
        if (member.call !== layout.call || !layout.frameKey || !layout.masks) return;
        const visibleRanges = drawRangesOf(batch.geometry, batch.material).map(range => !!range.material?.visible);
        const key = visibleRanges.map(Number).join();
        let variants = shapeCounts.get(shape);
        if (!variants) shapeCounts.set(shape, variants = new Map());
        let cached = variants.get(key);
        if (!cached) {
            const vertices = new Uint8Array(shape.vertexCount);
            const index = layout.index!.array;
            for (const record of shape.records) {
                if (!visibleRanges[record.range]) continue;
                for (let i = record.firstIndex; i < record.firstIndex + record.indexCount; i++) {
                    vertices[index[shape.indexStart + i]] |= 1 << record.bucket;
                }
            }
            variants.set(key, cached = { vertices, counts: new Map([[0, 0]]) });
        }
        const { vertices, counts } = cached;
        const start = range.start, count = Math.min(batch.count, range.capacity);
        let masks = reads.get(layout.masks);
        if (!masks) {
            masks = renderer.getArrayBufferAsync(layout.masks).then(buffer => new Uint32Array(buffer));
            reads.set(layout.masks, masks);
        }
        drawn.push(masks.then(values => {
            let visible = 0;
            for (let slot = start; slot < start + count; slot++) {
                const mask = values[slot];
                let vertexCount = counts.get(mask);
                if (vertexCount === undefined) {
                    vertexCount = 0;
                    for (const vertex of vertices) if (vertex & mask) vertexCount++;
                    counts.set(mask, vertexCount);
                }
                visible += vertexCount;
            }
            return visible;
        }));
    });
    const visible = (await Promise.all(drawn)).reduce((sum, count) => sum + count, 0);
    return { total, culled: total - visible };
}
