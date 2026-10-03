import {
    Box3, DoubleSide, DynamicDrawUsage, InstancedBufferAttribute, InstancedMesh, MeshBasicNodeMaterial,
    LineBasicNodeMaterial, Matrix4, PlaneGeometry, StorageBufferAttribute, StorageInstancedBufferAttribute, Vector3, Vector4
} from 'three/webgpu';
import {
    Fn, If, Loop, atomicOr, atomicStore, attribute, float, fwidth, instanceIndex, max,
    positionGeometry, positionLocal, smoothstep, storage, uint, uniform, uv, varying, vec2, vec3, vec4, uvec2
} from 'three/tsl';

// CPU and GPU choose the same pixel at UV boundaries despite Float32 interpolation error.
export const headPainterPixelEpsilon = 1e-4;

export function createHeadPainterGridMaterial(color: number): LineBasicNodeMaterial {
    const material = new LineBasicNodeMaterial({ color, transparent: true, depthTest: true, depthWrite: false });
    const line = attribute('headPainterGridLine', 'vec4');
    const packed = line.x.lessThan(2).select(attribute('headPainterGrid0', 'vec4'),
        line.x.lessThan(4).select(attribute('headPainterGrid1', 'vec4'), attribute('headPainterGrid2', 'vec4')));
    const counts = line.x.mod(2).equal(0).select(packed.xy, packed.zw).max(1);
    const count = line.z.equal(0).select(counts.x, counts.y);
    const visible = line.y.lessThanEqual(count);
    material.opacityNode = varying(visible.toFloat(), 'vHeadPainterGridVisible').mul(0.9);
    material.positionNode = Fn((builder) => {
        const boundary = line.y.mul(8).div(count).add(0.5).floor().div(8);
        const coordinate = visible.select(line.z.equal(0).select(vec2(boundary, line.w), vec2(line.w, boundary)), vec2(0));
        const h = attribute('headPainterGridHorizontal', 'vec3');
        const v = attribute('headPainterGridVertical', 'vec3');
        const position = positionGeometry.add(h.mul(coordinate.x)).add(v.mul(coordinate.y));
        const local = position.add(vec3(0, 0.5, 0)).mul(attribute('headPainterGridScale', 'float'))
            .sub(vec3(0, 0.5, 0)).add(h.cross(v).normalize().mul(0.001));
        // positionNode runs after Three's instancing; transform the complete local grid here.
        return storage(builder.object.instanceMatrix, 'mat4').toReadOnly().element(instanceIndex).mul(vec4(local, 1)).xyz;
    })();
    return material;
}

export function createHeadPainterPreviewMaterial(maskNode = attribute('headPainterCells', 'uvec2')): MeshBasicNodeMaterial {
    const material = new MeshBasicNodeMaterial({ color: 0xffffff, side: DoubleSide, transparent: true,
        alphaTest: 0.001, depthTest: false, depthWrite: false });
    // Empty faces collapse before rasterization, even when the scene table contains every head face.
    material.positionNode = maskNode.x.bitOr(maskNode.y).notEqual(uint(0)).select(positionLocal, vec3(0));
    material.opacityNode = Fn(() => {
        const counts = varying(attribute('headPainterGrid', 'vec2'), 'vHeadPainterGrid').toVar();
        const mask = varying(maskNode, 'vHeadPainterCells').setInterpolation('flat').toVar();
        const pixel = vec2(uv().x, float(1).sub(uv().y)).mul(8).toVar();
        const cell = pixel.floor().add(0.5).mul(counts).div(8).floor().toVar();
        // Match Math.round(index * 8 / count), including uneven 3/5/6/7-cell grids.
        const before = cell.mul(8).div(counts).add(0.5).floor().toVar();
        const after = cell.add(1).mul(8).div(counts).add(0.5).floor().toVar();
        const boundary = pixel.sub(before).lessThanEqual(after.sub(pixel)).select(cell, cell.add(1)).toVar();
        const distance = pixel.sub(boundary.mul(8).div(counts).add(0.5).floor()).abs().div(fwidth(pixel).max(1e-6));
        const line = float(1).sub(smoothstep(0, 1, distance)).toVar();
        const selected = Fn(([coordinate]) => {
            const index = coordinate.y.mul(8).add(coordinate.x).toUint();
            const word = index.lessThan(uint(32)).select(mask.x, mask.y);
            const bit = word.shiftRight(index.bitAnd(uint(31))).bitAnd(uint(1));
            const inside = coordinate.greaterThanEqual(vec2(0)).all().and(coordinate.lessThan(counts).all());
            return inside.select(bit.toFloat(), 0);
        });
        const vertical = max(selected(vec2(boundary.x.sub(1), cell.y)), selected(vec2(boundary.x, cell.y)));
        const horizontal = max(selected(vec2(cell.x, boundary.y.sub(1))), selected(vec2(cell.x, boundary.y)));
        return max(line.x.mul(vertical), line.y.mul(horizontal));
    })();
    return material;
}

export type HeadPainterGpuPreviewData = {
    // Four vec4s per triangle: (position.xyz, u) × 3, then (vA, vB, vC, (record * 12 + skinPart) * 4 + side).
    triangles: Float32Array;
    // Two uvec4s per record: (columns, rows, firstFace, layerRule), then (alphaLow, alphaHigh, headMatrix, face).
    records: Uint32Array;
    bins: Uint32Array;
    indices: Uint32Array;
    matrices: Float32Array;
    grids: Float32Array;
    binBounds: Vector4;
    binDimensions: Vector4;
    origin: Vector3;
    sourceSlots: Map<string, number>;
    unsupportedBounds: Box3[];
    rayLength: number;
};

export function createHeadPainterGpuPreview(data: HeadPainterGpuPreviewData, flags: Uint32Array) {
    const capacity = (count: number, minimum: number) => 2 ** Math.ceil(Math.log2(Math.max(count, minimum)));
    const buffers = {
        triangles: new StorageBufferAttribute(new Float32Array(capacity(data.triangles.length, 4096)), 4),
        records: new StorageBufferAttribute(new Uint32Array(capacity(data.records.length, 2048)), 4),
        bins: new StorageBufferAttribute(new Uint32Array(capacity(data.bins.length, 2048)), 2),
        indices: new StorageBufferAttribute(new Uint32Array(capacity(data.indices.length, 8192)), 1),
        flags: new StorageBufferAttribute(new Uint32Array(capacity(flags.length, 16384)), 1),
        masks: new StorageBufferAttribute(new Uint32Array(capacity(data.grids.length, 2048)), 1)
    };
    const geometry = new PlaneGeometry(1, 1);
    for (const [name, buffer] of Object.entries(buffers)) geometry.setAttribute(`headPainter${name}`, buffer);
    const faceCapacity = buffers.masks.count / 2;
    geometry.setAttribute('headPainterGrid', new InstancedBufferAttribute(new Float32Array(faceCapacity * 2), 2).setUsage(DynamicDrawUsage));
    const maskRead = storage(buffers.masks, 'uint').toReadOnly();
    const maskNode = uvec2(maskRead.element(instanceIndex.mul(2)), maskRead.element(instanceIndex.mul(2).add(1)));
    const mesh = new InstancedMesh(geometry, createHeadPainterPreviewMaterial(maskNode), faceCapacity);
    mesh.instanceMatrix = new StorageInstancedBufferAttribute(new Float32Array(capacity(data.matrices.length, 2048)), 16).setUsage(DynamicDrawUsage);
    mesh.name = 'head-painter-gpu-preview';
    mesh.frustumCulled = false;
    mesh.renderOrder = 2000;
    const brush = uniform(new Vector4());
    const source = uniform(new Vector4());
    const bounds = uniform(data.binBounds.clone());
    const dimensions = uniform(data.binDimensions.clone());
    const frame = uniform(new Matrix4());
    const face = uniform(0, 'uint');
    const triangles = storage(buffers.triangles, 'vec4').toReadOnly();
    const records = storage(buffers.records, 'uvec4').toReadOnly();
    (mesh.material as MeshBasicNodeMaterial).positionNode = Fn((builder) => {
        const metadata = records.element(instanceIndex.div(uint(2)).mul(uint(2)).add(uint(1)));
        const face = metadata.w, p = uv().sub(0.5);
        const local = face.equal(uint(0)).select(vec3(0.5, p.y, p.x.negate()),
            face.equal(uint(1)).select(vec3(-0.5, p.y, p.x),
            face.equal(uint(2)).select(vec3(p.x.negate(), 0.5, p.y),
            face.equal(uint(3)).select(vec3(p.x.negate(), -0.5, p.y),
            face.equal(uint(4)).select(vec3(p.x, p.y, 0.5), vec3(p.x.negate(), p.y, -0.5))))));
        const scale = instanceIndex.mod(uint(2)).equal(uint(0)).select(1.006, 1.0625 * 1.006);
        const position = local.mul(scale).sub(vec3(0, 0.5, 0));
        const matrix = storage(builder.object.instanceMatrix, 'mat4').toReadOnly().element(metadata.z);
        return maskNode.x.bitOr(maskNode.y).notEqual(uint(0)).select(matrix.mul(vec4(position, 1)).xyz, vec3(0));
    })();
    const bins = storage(buffers.bins, 'uvec2').toReadOnly();
    const indices = storage(buffers.indices, 'uint').toReadOnly();
    const enabled = storage(buffers.flags, 'uint').toReadOnly();
    const masks = storage(buffers.masks, 'uint').toAtomic();
    const clear = Fn(() => { atomicStore(masks.element(instanceIndex), uint(0)); })().compute(buffers.masks.count);
    const paint = Fn(() => {
        If(enabled.element(instanceIndex).notEqual(uint(0)), () => {
            const x = float(instanceIndex.mod(brush.z.toUint())).add(brush.x).sub(brush.z.div(2).floor()).toVar();
            const y = float(instanceIndex.div(brush.z.toUint())).add(brush.y).sub(brush.w.div(2).floor()).toVar();
            const mark = (slot: ReturnType<typeof uint>, bit: ReturnType<typeof uint>) => {
                atomicOr(masks.element(slot.mul(2).add(bit.div(uint(32)))), uint(1).shiftLeft(bit.bitAnd(uint(31))));
            };
            If(x.greaterThanEqual(0).and(x.lessThan(source.x)).and(y.greaterThanEqual(0)).and(y.lessThan(source.y)), () => {
                mark(source.z.toUint(), y.mul(8).add(x).toUint());
            }).Else(() => {
                const pixel = vec2(x, y).mul(8).div(source.xy);
                const nextPixel = vec2(x, y).add(1).mul(8).div(source.xy);
                const center = pixel.add(0.5).floor().add(nextPixel.add(0.5).floor()).div(16);
                const point = frame.mul(vec4(center.x, float(1).sub(center.y), 0, 1)).xyz.toVar();
                const normal = frame.element(2).xyz.normalize().toVar();
                const rayOrigin = point.add(normal.mul(source.w)).toVar();
                const direction = normal.negate().toVar();
                const first = rayOrigin.sub(bounds.xyz).div(bounds.w).floor();
                const last = point.sub(normal.mul(source.w)).sub(bounds.xyz).div(bounds.w).floor();
                const lower = first.min(last).max(vec3(0)).toVar();
                const upper = first.max(last).min(dimensions.xyz.sub(1)).toVar();
                const nearest = uint(0xffffffff).toVar();
                const distance = source.w.mul(2).toVar();
                const weights = vec2(0).toVar();
                Loop({ name: 'tileZ', start: lower.z.toInt(), end: upper.z.toInt(), type: 'int', condition: '<=' }, ({ tileZ: z }) => {
                    Loop({ name: 'tileY', start: lower.y.toInt(), end: upper.y.toInt(), type: 'int', condition: '<=' }, ({ tileY: y }) => {
                        Loop({ name: 'tileX', start: lower.x.toInt(), end: upper.x.toInt(), type: 'int', condition: '<=' }, ({ tileX: x }) => {
                            const range = bins.element(z.mul(dimensions.y.toInt()).add(y).mul(dimensions.x.toInt()).add(x).toUint()).toVar();
                            Loop({ start: uint(0), end: range.y, type: 'uint', condition: '<' }, ({ i }) => {
                                const triangle = indices.element(range.x.add(i)).toVar();
                                const a = triangles.element(triangle.mul(4)).toVar();
                                const b = triangles.element(triangle.mul(4).add(1)).toVar();
                                const c = triangles.element(triangle.mul(4).add(2)).toVar();
                                const side = triangles.element(triangle.mul(4).add(3)).w.mod(4);
                                const ab = b.xyz.sub(a.xyz), ac = c.xyz.sub(a.xyz), delta = rayOrigin.sub(a.xyz);
                                const cross = direction.cross(ac).toVar();
                                const determinant = ab.dot(cross).toVar();
                                const wb = delta.dot(cross).div(determinant).toVar();
                                const q = delta.cross(ab).toVar();
                                const wc = direction.dot(q).div(determinant).toVar();
                                const t = ac.dot(q).div(determinant).toVar();
                                const facing = side.equal(2).or(side.equal(0).and(determinant.greaterThan(0)))
                                    .or(side.equal(1).and(determinant.lessThan(0)));
                                If(determinant.notEqual(0).and(wb.greaterThanEqual(0)).and(wc.greaterThanEqual(0))
                                    .and(wb.add(wc).lessThanEqual(1)).and(facing).and(t.greaterThanEqual(0)).and(t.lessThanEqual(distance))
                                    .and(t.lessThan(distance).or(nearest.equal(uint(0xffffffff))).or(triangle.greaterThanEqual(nearest))), () => {
                                    distance.assign(t);
                                    nearest.assign(triangle);
                                    weights.assign(vec2(wb, wc));
                                });
                            });
                        });
                    });
                });
                If(nearest.notEqual(uint(0xffffffff)), () => {
                    const a = triangles.element(nearest.mul(4)), b = triangles.element(nearest.mul(4).add(1));
                    const c = triangles.element(nearest.mul(4).add(2)), extra = triangles.element(nearest.mul(4).add(3)).toVar();
                    const packedCode = extra.w.div(4).floor();
                    If(packedCode.greaterThanEqual(0), () => {
                        const wb = weights.x, wc = weights.y;
                        const wa = float(1).sub(wb).sub(wc);
                        const code = packedCode.toUint().toVar(), recordIndex = code.div(uint(12));
                        const record = records.element(recordIndex.mul(2)).toVar();
                        const part = code.mod(uint(12));
                        const skinFace = part.mod(uint(6));
                        const paintFace = skinFace.equal(uint(0)).select(uint(1), skinFace.equal(uint(1)).select(uint(0), skinFace));
                        If(paintFace.equal(face).and(record.z.notEqual(source.z.toUint().bitAnd(uint(0xfffffffe)))), () => {
                            const u = wa.mul(a.w).add(wb.mul(b.w)).add(wc.mul(c.w));
                            const v = wa.mul(extra.x).add(wb.mul(extra.y)).add(wc.mul(extra.z));
                            const px = u.mul(2048).sub(float(part.mod(uint(3))).mul(8)).add(headPainterPixelEpsilon).floor().clamp(0, 7);
                            const py = float(32).sub(v.mul(2048)).sub(float(part.div(uint(3))).mul(8)).add(headPainterPixelEpsilon).floor().clamp(0, 7);
                            const tx = px.add(0.5).mul(float(record.x)).div(8).floor().toUint();
                            const ty = py.add(0.5).mul(float(record.y)).div(8).floor().toUint();
                            const bit = ty.mul(uint(8)).add(tx).toVar();
                            const layer = record.w.toVar();
                            If(layer.equal(uint(2)), () => {
                                const alpha = records.element(recordIndex.mul(2).add(1));
                                const coordinate = vec2(float(tx), float(ty)), counts = vec2(float(record.x), float(record.y));
                                const start = coordinate.mul(8).div(counts).add(0.5).floor();
                                const end = coordinate.add(1).mul(8).div(counts).add(0.5).floor();
                                const sample = start.add(end).sub(1).div(2).floor();
                                const alphaBit = sample.y.mul(8).add(sample.x).toUint();
                                layer.assign(alphaBit.lessThan(uint(32)).select(alpha.x, alpha.y)
                                    .shiftRight(alphaBit.bitAnd(uint(31))).bitAnd(uint(1)));
                            });
                            mark(record.z.add(layer), bit);
                        });
                    });
                });
            });
        });
    })().compute(flags.length);
    return { mesh, buffers, brush, source, bounds, dimensions, frame, face, clear, paint };
}

export type HeadPainterGpuPreview = ReturnType<typeof createHeadPainterGpuPreview>;

export function updateHeadPainterGpuPreviewData(preview: HeadPainterGpuPreview, data: HeadPainterGpuPreviewData, flags?: Uint32Array): void {
    for (const name of ['triangles', 'records', 'bins', 'indices'] as const) {
        preview.buffers[name].array.set(data[name]);
        preview.buffers[name].clearUpdateRanges();
        preview.buffers[name].needsUpdate = true;
    }
    if (flags) {
        preview.buffers.flags.array.set(flags);
        preview.buffers.flags.needsUpdate = true;
        preview.paint.count = flags.length;
    }
    preview.mesh.instanceMatrix.array.set(data.matrices);
    preview.mesh.instanceMatrix.needsUpdate = true;
    const grid = preview.mesh.geometry.getAttribute('headPainterGrid');
    grid.array.set(data.grids);
    grid.needsUpdate = true;
    preview.mesh.count = data.grids.length / 2;
    preview.bounds.value.copy(data.binBounds);
    preview.dimensions.value.copy(data.binDimensions);
}

export function disposeHeadPainterGpuPreview(preview: HeadPainterGpuPreview): void {
    preview.clear.dispose();
    preview.paint.dispose();
    preview.mesh.removeFromParent();
    preview.mesh.dispose();
    preview.mesh.geometry.dispose();
    (preview.mesh.material as MeshBasicNodeMaterial).dispose();
}
