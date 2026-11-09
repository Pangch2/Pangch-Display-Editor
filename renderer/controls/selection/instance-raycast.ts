import {
    Box3,
    BackSide,
    BufferGeometry,
    CanvasTexture,
    Float32BufferAttribute,
    FrontSide,
    Group,
    InstancedBufferAttribute,
    Matrix4,
    Mesh,
    MeshBasicMaterial,
    Ray,
    Raycaster,
    Triangle,
    Vector2,
    Vector3,
    type Intersection,
    type Object3D
} from 'three/webgpu';
import { getBatchMatrixVersion, getInstanceCount, getInstanceMatrix, getInstanceValue, getInstanceValueVersion, hashInstanceRows, instanceValueSize,
    isObjectBatch } from '../../scene-store/object-access';
import { ObjectBatch } from '../../scene-store/object-batch';

type BoundsNode = {
    box: Box3;
    left?: BoundsNode;
    right?: BoundsNode;
    instanceIds?: number[];
};

/** Instance bounds of one block of slots, rebuilt only when a hash of its rows changes. */
type BoundsBlock = { end: number; hash: number; root: BoundsNode };

type BoundsTree = {
    count: number;
    geometry: BufferGeometry;
    geometryBox: string;
    matrixVersion: number;
    layoutVersion: number;
    bounds: Float32Array;
    blocks: BoundsBlock[];
    root: BoundsNode;
};

type HeadTriangle = { offset: number; a: number; b: number; c: number; va: Vector3; vb: Vector3; vc: Vector3; normal: Vector3 };
export type PreparedFace = { mesh: Mesh; instanceId?: number; matrix: Matrix4; inverse: Matrix4; geometry: BufferGeometry; start: number; count: number; triangles?: HeadTriangle[] };

const leafSize = 12;
// Large batches would otherwise re-sort every instance after a single edit.
const blockSize = 4096;
const boundsTrees = new WeakMap<ObjectBatch, BoundsTree>();
const raycastObjectBounds = new WeakMap<Mesh[], {
    bounds: number[]; root?: BoundsNode; faces: PreparedFace[];
    grid?: { axis: number; size: number; columns: Map<number, Map<number, number[]>> };
}>();
const headFaceBounds = new WeakMap<BufferGeometry, {
    position: ReturnType<BufferGeometry['getAttribute']>; index: BufferGeometry['index'];
    positionVersion: number; indexVersion: number; boxes: Box3[]; triangles: HeadTriangle[][];
}>();
const localMatrix = new Matrix4();
const shapeMatrix = new Matrix4();
const inverseWorldMatrix = new Matrix4();
const localRay = new Ray();
const localBox = new Box3();
const itemBox = new Box3();
const rangeEnd = new Vector3();
const boxIntersection = new Vector3();
const trianglePoint = new Vector3();
const worldPoint = new Vector3();
const barycoord = new Vector3();
const size = new Vector3();
const pickMesh = new Mesh();
const textDisplayPickGeometry = new BufferGeometry();
textDisplayPickGeometry.setAttribute('position', new Float32BufferAttribute([
    0, 1, 0,
    0, 0, 0,
    1, 1, 0,
    1, 0, 0
], 3));
textDisplayPickGeometry.setAttribute('uv', new Float32BufferAttribute([
    0, 1,
    0, 0,
    1, 1,
    1, 0
], 2));
textDisplayPickGeometry.setIndex([0, 1, 2, 1, 3, 2]);
textDisplayPickGeometry.computeBoundingBox();
textDisplayPickGeometry.computeBoundingSphere();
const textDisplayGlyphPickGeometries = new WeakMap<BufferGeometry, BufferGeometry>();
function getTextDisplayPickGeometry(geometry: BufferGeometry): BufferGeometry {
    if (!geometry.userData.textDisplayGeometryKey) return textDisplayPickGeometry;
    let pickGeometry = textDisplayGlyphPickGeometries.get(geometry);
    if (!pickGeometry) {
        const bounds = new Box3().setFromBufferAttribute(geometry.getAttribute('position'));
        const { min, max } = bounds;
        pickGeometry = new BufferGeometry();
        pickGeometry.setAttribute('position', new Float32BufferAttribute([
            min.x, max.y, 0, min.x, min.y, 0, max.x, max.y, 0, max.x, min.y, 0
        ], 3));
        pickGeometry.setAttribute('uv', new Float32BufferAttribute([
            min.x, max.y, min.x, min.y, max.x, max.y, max.x, min.y
        ], 2));
        pickGeometry.setIndex([0, 1, 2, 1, 3, 2]);
        pickGeometry.computeBoundingSphere();
        textDisplayGlyphPickGeometries.set(geometry, pickGeometry);
        const ownedGeometry = pickGeometry;
        geometry.addEventListener('dispose', () => ownedGeometry.dispose());
    }
    return pickGeometry;
}
const intersections: Intersection[] = [];
const candidates: number[] = [];
const objectCandidates: number[] = [];

function buildNode(bounds: ArrayLike<number>, instanceIds: number[]): BoundsNode {
    const box = new Box3();
    for (const instanceId of instanceIds) {
        const offset = instanceId * 6;
        box.min.x = Math.min(box.min.x, bounds[offset]);
        box.min.y = Math.min(box.min.y, bounds[offset + 1]);
        box.min.z = Math.min(box.min.z, bounds[offset + 2]);
        box.max.x = Math.max(box.max.x, bounds[offset + 3]);
        box.max.y = Math.max(box.max.y, bounds[offset + 4]);
        box.max.z = Math.max(box.max.z, bounds[offset + 5]);
    }
    if (instanceIds.length <= leafSize) return { box, instanceIds };

    box.getSize(size);
    const axis = size.x >= size.y && size.x >= size.z ? 0 : size.y >= size.z ? 1 : 2;
    instanceIds.sort((a, b) => bounds[a * 6 + axis] + bounds[a * 6 + axis + 3]
        - bounds[b * 6 + axis] - bounds[b * 6 + axis + 3]);
    const middle = instanceIds.length >> 1;
    return {
        box,
        left: buildNode(bounds, instanceIds.slice(0, middle)),
        right: buildNode(bounds, instanceIds.slice(middle))
    };
}

/** The text box of a text batch's object: [left, right, height, width], or null for other batches. */
function textLayoutAt(batch: ObjectBatch, instanceId: number, out: number[]): number[] | null {
    if (instanceValueSize(batch, 'textDisplayLayout') !== 4) return null;
    for (let component = 0; component < 4; component++) out[component] = getInstanceValue(batch, instanceId, 'textDisplayLayout', component)!;
    return out;
}
const layoutValues: number[] = [];

function getBoundsTree(mesh: ObjectBatch): BoundsTree | null {
    const count = getInstanceCount(mesh);
    const cached = boundsTrees.get(mesh);
    const matrixVersion = getBatchMatrixVersion(mesh);
    const layoutVersion = getInstanceValueVersion(mesh, 'textDisplayLayout');
    if (cached?.count === count && cached.geometry === mesh.geometry && cached.matrixVersion === matrixVersion && cached.layoutVersion === layoutVersion) return cached;

    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
    if (!mesh.geometry.boundingBox || count === 0) return null;
    const shapeBox = mesh.geometry.boundingBox;
    const geometryBox = [...shapeBox.min.toArray(), ...shapeBox.max.toArray()].join();
    const glyphShape = !!mesh.geometry.userData.textDisplayGeometryKey;
    const textLayout = !glyphShape && instanceValueSize(mesh, 'textDisplayLayout') === 4;
    // Blocks whose rows hash the same keep their bounds and subtree.
    const reuse = cached && cached.geometry === mesh.geometry && cached.geometryBox === geometryBox ? cached : null;
    const bounds = reuse?.bounds.length === count * 6 ? reuse.bounds : new Float32Array(count * 6);
    const blocks: BoundsBlock[] = [];
    for (let first = 0; first < count; first += blockSize) {
        const end = Math.min(count, first + blockSize);
        const hash = hashInstanceRows(mesh, first, end, textLayout ? ['textDisplayLayout'] : []);
        const old = reuse?.blocks[first / blockSize];
        if (old?.end === end && old.hash === hash) {
            if (bounds !== reuse!.bounds) bounds.set(reuse!.bounds.subarray(first * 6, end * 6), first * 6);
            blocks.push(old);
            continue;
        }
        for (let instanceId = first; instanceId < end; instanceId++) {
            getInstanceMatrix(mesh, instanceId, localMatrix);
            const layout = textLayout ? textLayoutAt(mesh, instanceId, layoutValues) : null;
            if (layout) {
                localBox.min.set(layout[0], 0, shapeBox.min.z);
                localBox.max.set(layout[1], layout[2], shapeBox.max.z);
            } else {
                localBox.copy(shapeBox);
            }
            localBox.applyMatrix4(localMatrix);
            const offset = instanceId * 6;
            bounds[offset] = localBox.min.x;
            bounds[offset + 1] = localBox.min.y;
            bounds[offset + 2] = localBox.min.z;
            bounds[offset + 3] = localBox.max.x;
            bounds[offset + 4] = localBox.max.y;
            bounds[offset + 5] = localBox.max.z;
        }
        blocks.push({ end, hash, root: buildNode(bounds, Array.from({ length: end - first }, (_, index) => first + index)) });
    }
    const tree = { count, geometry: mesh.geometry, geometryBox, matrixVersion, layoutVersion, bounds, blocks, root: joinNodes(blocks.map(block => block.root)) };
    boundsTrees.set(mesh, tree);
    return tree;
}

/** A balanced node over subtrees (the per-block roots). */
function joinNodes(nodes: BoundsNode[]): BoundsNode {
    if (nodes.length === 1) return nodes[0];
    const middle = nodes.length >> 1;
    const left = joinNodes(nodes.slice(0, middle)), right = joinNodes(nodes.slice(middle));
    return { box: left.box.clone().union(right.box), left, right };
}

function intersectsRayRange(ray: Ray, box: Box3, maxDistance: number): boolean {
    if (box.containsPoint(ray.origin)) return true;
    return ray.intersectBox(box, boxIntersection) !== null
        && ray.origin.distanceToSquared(boxIntersection) <= maxDistance * maxDistance;
}

function collectCandidates(node: BoundsNode, bounds: ArrayLike<number>, ray: Ray, target: number[], maxDistance = Infinity): void {
    if (!intersectsRayRange(ray, node.box, maxDistance)) return;
    if (node.instanceIds) {
        for (const instanceId of node.instanceIds) {
            const offset = instanceId * 6;
            itemBox.min.fromArray(bounds, offset);
            itemBox.max.fromArray(bounds, offset + 3);
            if (intersectsRayRange(ray, itemBox, maxDistance)) target.push(instanceId);
        }
        return;
    }
    if (node.left) collectCandidates(node.left, bounds, ray, target, maxDistance);
    if (node.right) collectCandidates(node.right, bounds, ray, target, maxDistance);
}

function isTextDisplayPixelVisible(mesh: ObjectBatch, instanceId: number, hit: Intersection): boolean {
    const material = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as MeshBasicMaterial;
    if (!material.visible) return false;
    const canvas = material.map?.image;
    const context = canvas instanceof HTMLCanvasElement ? canvas.getContext('2d', { willReadFrequently: true }) : null;
    const uv = hit.uv;
    if (!context || !uv) return true;

    const alphaAt = (u: number, v: number): number => context.getImageData(
        Math.max(0, Math.min(canvas.width - 1, Math.floor(u * canvas.width))),
        Math.max(0, Math.min(canvas.height - 1, Math.floor((1 - v) * canvas.height))),
        1,
        1
    ).data[3] / 255;
    const cutoff = material.alphaTest;
    const uvBounds = instanceValueSize(mesh, 'textDisplayUvBounds') === 4
        ? [0, 1, 2, 3].map(component => getInstanceValue(mesh, instanceId, 'textDisplayUvBounds', component)!) : null;
    if (uvBounds && mesh.geometry.userData.textDisplayGeometryKey) {
        const positions = mesh.geometry.getAttribute('position');
        const coordinates = mesh.geometry.getAttribute('uv');
        const indices = mesh.geometry.index!;
        trianglePoint.set(uv.x, uv.y, 0);
        const a = new Vector3(), b = new Vector3(), c = new Vector3();
        for (let i = 6; i < indices.count; i += 3) {
            const ia = indices.getX(i), ib = indices.getX(i + 1), ic = indices.getX(i + 2);
            a.fromBufferAttribute(positions, ia).z = 0;
            b.fromBufferAttribute(positions, ib).z = 0;
            c.fromBufferAttribute(positions, ic).z = 0;
            Triangle.getBarycoord(trianglePoint, a, b, c, barycoord);
            if (barycoord.x < 0 || barycoord.y < 0 || barycoord.z < 0) continue;
            const u = coordinates.getX(ia) * barycoord.x + coordinates.getX(ib) * barycoord.y + coordinates.getX(ic) * barycoord.z;
            const v = coordinates.getY(ia) * barycoord.x + coordinates.getY(ib) * barycoord.y + coordinates.getY(ic) * barycoord.z;
            if (alphaAt(uvBounds[0] + (uvBounds[1] - uvBounds[0]) * u, uvBounds[2] + (uvBounds[3] - uvBounds[2]) * v) > cutoff) return true;
        }
    } else if (uvBounds && alphaAt(uvBounds[0] + (uvBounds[1] - uvBounds[0]) * uv.x, uvBounds[2] + (uvBounds[3] - uvBounds[2]) * uv.y) > cutoff) return true;

    const layout = textLayoutAt(mesh, instanceId, []);
    if (!layout || instanceValueSize(mesh, 'textDisplayBackgroundUv') < 2) return false;
    const x = layout[0] + (layout[1] - layout[0]) * uv.x;
    const center = (layout[0] + layout[1]) * 0.5;
    return uv.y >= 0 && uv.y <= 1 && Math.abs(x - center) <= layout[3] * 0.5
        && alphaAt(getInstanceValue(mesh, instanceId, 'textDisplayBackgroundUv', 0)!, getInstanceValue(mesh, instanceId, 'textDisplayBackgroundUv', 1)!) > cutoff;
}

function getHeadFaceBounds(geometry: BufferGeometry): { boxes: Box3[]; triangles: HeadTriangle[][] } | null {
    if (!geometry.getAttribute('headLayer') || geometry.morphAttributes.position?.length) return null;
    const position = geometry.getAttribute('position');
    const index = geometry.index;
    const positionVersion = 'version' in position ? position.version : position.data.version;
    const indexVersion = index?.version ?? -1;
    let cached = headFaceBounds.get(geometry);
    if (!cached || cached.position !== position || cached.index !== index
        || cached.positionVersion !== positionVersion || cached.indexVersion !== indexVersion) {
        const boxes: Box3[] = [];
        const triangles: HeadTriangle[][] = [];
        const point = new Vector3();
        const count = index?.count ?? position.count;
        // Each head face is two triangles. Bounds also safely cover appended image faces.
        for (let start = 0; start < count; start += 6) {
            const box = new Box3();
            for (let i = start; i < Math.min(start + 6, count); i++) {
                box.expandByPoint(point.fromBufferAttribute(position, index ? index.getX(i) : i));
            }
            boxes.push(box.expandByScalar(1e-8));
            const faceTriangles: HeadTriangle[] = [];
            for (let i = start; i + 2 < Math.min(start + 6, count); i += 3) {
                const a = index ? index.getX(i) : i;
                const b = index ? index.getX(i + 1) : i + 1;
                const c = index ? index.getX(i + 2) : i + 2;
                const va = new Vector3().fromBufferAttribute(position, a);
                const vb = new Vector3().fromBufferAttribute(position, b);
                const vc = new Vector3().fromBufferAttribute(position, c);
                faceTriangles.push({ offset: i, a, b, c, va, vb, vc, normal: Triangle.getNormal(va, vb, vc, new Vector3()) });
            }
            triangles.push(faceTriangles);
        }
        cached = { position, index, positionVersion, indexVersion, boxes, triangles };
        headFaceBounds.set(geometry, cached);
    }
    return cached;
}

function collectBoxCandidates(node: BoundsNode, bounds: ArrayLike<number>, region: Box3, target: number[]): void {
    if (!node.box.intersectsBox(region)) return;
    if (node.instanceIds) {
        for (const id of node.instanceIds) {
            itemBox.min.fromArray(bounds, id * 6);
            itemBox.max.fromArray(bounds, id * 6 + 3);
            if (itemBox.intersectsBox(region)) target.push(id);
        }
    } else {
        if (node.left) collectBoxCandidates(node.left, bounds, region, target);
        if (node.right) collectBoxCandidates(node.right, bounds, region, target);
    }
}

let warmGeneration = 0;

/** Builds (or revalidates) the project's picking trees in idle time, a batch at a time, so the next click does not. */
export function warmSceneRaycast(root: Group): void {
    const generation = ++warmGeneration;
    const batches = root.children.filter(isObjectBatch);
    const step = (deadline: IdleDeadline) => {
        if (generation !== warmGeneration) return;
        do {
            const batch = batches.pop();
            if (batch && !batch.disposed && batch.parent === root) getBoundsTree(batch);
        } while (batches.length && deadline.timeRemaining() > 0);
        if (batches.length) requestIdleCallback(step, { timeout: 2000 });
    };
    requestIdleCallback(step, { timeout: 2000 });
}

export function intersectSceneInstances(
    raycaster: Raycaster,
    root: Group,
    acceptInstance?: (mesh: ObjectBatch, instanceId: number) => boolean,
    objects?: Mesh[]
): Intersection | null {
    let nearest: Intersection | null = null;
    const intersect = (object: Object3D) => {
        if ((!(object as Mesh).isMesh && !isObjectBatch(object)) || object.visible === false || !object.layers.test(raycaster.layers)) return;
        if (!isObjectBatch(object)) {
            intersections.length = 0;
            (object as Mesh).raycast(raycaster, intersections);
            for (const hit of intersections) if (!nearest || hit.distance < nearest.distance) nearest = hit;
            return;
        }

        const mesh = object;
        const textLayout = instanceValueSize(mesh, 'textDisplayLayout') === 4;
        const tree = getBoundsTree(mesh);
        if (!tree) return;
        localRay.copy(raycaster.ray).applyMatrix4(inverseWorldMatrix.copy(mesh.matrixWorld).invert());
        const maxDistance = Number.isFinite(raycaster.far)
            ? rangeEnd.copy(raycaster.ray.direction).multiplyScalar(raycaster.far).add(raycaster.ray.origin)
                .applyMatrix4(inverseWorldMatrix).distanceTo(localRay.origin)
            : Infinity;
        candidates.length = 0;
        collectCandidates(tree.root, tree.bounds, localRay, candidates, maxDistance);
        pickMesh.geometry = textLayout ? getTextDisplayPickGeometry(mesh.geometry) : mesh.geometry;
        pickMesh.material = mesh.material;
        for (const instanceId of candidates) {
            if (acceptInstance && !acceptInstance(mesh, instanceId)) continue;
            getInstanceMatrix(mesh, instanceId, localMatrix);
            pickMesh.matrixWorld.multiplyMatrices(mesh.matrixWorld, localMatrix);
            const layout = textLayout ? textLayoutAt(mesh, instanceId, layoutValues) : null;
            if (layout) {
                shapeMatrix.makeScale(layout[1] - layout[0], layout[2], 1);
                shapeMatrix.setPosition(layout[0], 0, 0);
                pickMesh.matrixWorld.multiply(shapeMatrix);
            }
            intersections.length = 0;
            pickMesh.raycast(raycaster, intersections);
            for (const hit of intersections) {
                if (textLayout && !isTextDisplayPixelVisible(mesh, instanceId, hit)) continue;
                if (nearest && hit.distance > nearest.distance) continue;
                hit.instanceId = instanceId;
                hit.object = mesh;
                nearest = hit;
            }
        }
    };
    const objectBounds = objects && raycastObjectBounds.get(objects);
    if (objectBounds) {
        objectCandidates.length = 0;
        const grid = objectBounds.grid;
        const columnAxis = grid ? (grid.axis + 1) % 3 : 0;
        const rowAxis = grid ? (grid.axis + 2) % 3 : 1;
        if (grid && raycaster.ray.direction.getComponent(columnAxis) === 0 && raycaster.ray.direction.getComponent(rowAxis) === 0) {
            const column = raycaster.ray.origin.getComponent(columnAxis);
            const row = raycaster.ray.origin.getComponent(rowAxis);
            const first = raycaster.ray.origin.getComponent(grid.axis) + raycaster.ray.direction.getComponent(grid.axis) * raycaster.near;
            const last = raycaster.ray.origin.getComponent(grid.axis) + raycaster.ray.direction.getComponent(grid.axis) * raycaster.far;
            const bin = grid.columns.get(Math.floor(column / grid.size))?.get(Math.floor(row / grid.size));
            for (const id of bin ?? []) {
                const offset = id * 6;
                if (column < objectBounds.bounds[offset + columnAxis] || column > objectBounds.bounds[offset + columnAxis + 3]
                    || row < objectBounds.bounds[offset + rowAxis] || row > objectBounds.bounds[offset + rowAxis + 3]
                    || Math.min(first, last) > objectBounds.bounds[offset + grid.axis + 3]
                    || Math.max(first, last) < objectBounds.bounds[offset + grid.axis]) continue;
                objectCandidates.push(id);
            }
        } else if (objectBounds.root) {
            collectCandidates(objectBounds.root, objectBounds.bounds, raycaster.ray, objectCandidates, raycaster.far);
            objectCandidates.sort((a, b) => a - b);
        } else {
            objects!.forEach(intersect);
            return nearest;
        }
        for (const index of objectCandidates) {
            const face = objectBounds.faces[index];
            const mesh = face.mesh;
            if (!mesh.visible || !mesh.layers.test(raycaster.layers)) continue;
            if (face.instanceId !== undefined && acceptInstance && !acceptInstance(mesh as unknown as ObjectBatch, face.instanceId)) continue;
            if (face.triangles) {
                localRay.copy(raycaster.ray).applyMatrix4(face.inverse);
                const uv = face.geometry.getAttribute('uv');
                const uv1 = face.geometry.getAttribute('uv1');
                const normal = face.geometry.getAttribute('normal');
                for (const triangle of face.triangles) {
                    if (triangle.offset < face.start || triangle.offset >= face.start + face.count) continue;
                    let material = mesh.material;
                    let materialIndex = 0;
                    if (Array.isArray(material)) {
                        const group = face.geometry.groups.find(group => triangle.offset >= group.start && triangle.offset < group.start + group.count);
                        if (!group) continue;
                        materialIndex = group.materialIndex;
                        material = material[materialIndex];
                    }
                    const { a, b, c, va, vb, vc } = triangle;
                    const point = material.side === BackSide
                        ? localRay.intersectTriangle(vc, vb, va, true, trianglePoint)
                        : localRay.intersectTriangle(va, vb, vc, material.side === FrontSide, trianglePoint);
                    if (!point) continue;
                    worldPoint.copy(point).applyMatrix4(face.matrix);
                    const distance = raycaster.ray.origin.distanceTo(worldPoint);
                    if (distance < raycaster.near || distance > raycaster.far
                        || (nearest && (face.instanceId === undefined ? distance >= nearest.distance : distance > nearest.distance))) continue;
                    Triangle.getBarycoord(point, va, vb, vc, barycoord);
                    nearest = { object: mesh, distance, point: worldPoint.clone(),
                        faceIndex: triangle.offset / 3, face: { a, b, c, normal: triangle.normal.clone(), materialIndex } };
                    if (face.instanceId !== undefined) nearest.instanceId = face.instanceId;
                    if (uv) nearest.uv = Triangle.getInterpolatedAttribute(uv, a, b, c, barycoord, new Vector2());
                    if (uv1) nearest.uv1 = Triangle.getInterpolatedAttribute(uv1, a, b, c, barycoord, new Vector2());
                    if (normal) {
                        nearest.normal = Triangle.getInterpolatedAttribute(normal, a, b, c, barycoord, new Vector3());
                        if (nearest.normal.dot(localRay.direction) > 0) nearest.normal.negate();
                    }
                }
                continue;
            }
            pickMesh.geometry = face.geometry;
            pickMesh.material = mesh.material;
            pickMesh.matrixWorld.copy(face.matrix);
            intersections.length = 0;
            const { start, count } = face.geometry.drawRange;
            try {
                face.geometry.setDrawRange(face.start, face.count);
                if (face.instanceId === undefined) mesh.raycast(raycaster, intersections);
                else pickMesh.raycast(raycaster, intersections);
            } finally {
                face.geometry.setDrawRange(start, count);
            }
            const textLayout = isObjectBatch(mesh) && instanceValueSize(mesh, 'textDisplayLayout') === 4;
            for (const hit of intersections) {
                if (face.instanceId !== undefined && textLayout && !isTextDisplayPixelVisible(mesh as unknown as ObjectBatch, face.instanceId, hit)) continue;
                if (nearest && (face.instanceId === undefined ? hit.distance >= nearest.distance : hit.distance > nearest.distance)) continue;
                hit.object = mesh;
                if (face.instanceId !== undefined) hit.instanceId = face.instanceId;
                nearest = hit;
            }
        }
    } else if (objects) objects.forEach(intersect);
    else root.traverse(intersect);
    return nearest;
}

export function getSceneRaycastFaces(objects: Mesh[]): readonly PreparedFace[] {
    return raycastObjectBounds.get(objects)?.faces ?? [];
}

export function getSceneRaycastObjects(root: Group, region?: Box3, grid?: { axis: number; size: number }, prepareRaycast = true): Mesh[] {
    const objects: Mesh[] = [];
    const bounds: number[] = [];
    const faces: PreparedFace[] = [];
    const box = new Box3();
    const addFaces = (mesh: Mesh, geometry: BufferGeometry, matrix: Matrix4, instanceId?: number) => {
        const { start, count } = geometry.drawRange;
        const orderedGroups = !Array.isArray(mesh.material) || !geometry.groups.some((group, i, groups) =>
            group.start % 3 || group.count % 3 || (i > 0 && group.start < groups[i - 1].start + groups[i - 1].count));
        const rigidVertices = instanceId !== undefined || mesh.getVertexPosition === Mesh.prototype.getVertexPosition;
        const headFaces = start % 3 === 0 && (!Number.isFinite(count) || count % 3 === 0) && orderedGroups && rigidVertices
            ? getHeadFaceBounds(geometry) : null;
        const boxes = headFaces?.boxes;
        const inverse = matrix.clone().invert();
        if (!geometry.boundingBox) geometry.computeBoundingBox();
        if (!geometry.boundingBox) return;
        for (let i = 0; i < (boxes?.length ?? 1); i++) {
            const first = boxes ? Math.max(start, i * 6) : start;
            const last = boxes ? Math.min(start + count, (i + 1) * 6) : start + count;
            if (last <= first) continue;
            if (region || prepareRaycast) box.copy(boxes ? boxes[i] : geometry.boundingBox).applyMatrix4(matrix);
            if (region && !box.intersectsBox(region)) continue;
            faces.push({ mesh, geometry, matrix, inverse, instanceId, start: first, count: last - first, triangles: headFaces?.triangles[i] });
            if (prepareRaycast) bounds.push(box.min.x, box.min.y, box.min.z, box.max.x, box.max.y, box.max.z);
        }
    };
    root.traverse(object => {
        const mesh = object as Mesh;
        if ((!mesh.isMesh && !isObjectBatch(mesh)) || !mesh.visible) return;
        if (isObjectBatch(mesh)) {
            const tree = getBoundsTree(mesh);
            if (!tree) return;
            box.copy(tree.root.box);
        } else {
            if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
            if (!mesh.geometry.boundingBox) return;
            box.copy(mesh.geometry.boundingBox);
        }
        if (region && !box.applyMatrix4(mesh.matrixWorld).intersectsBox(region)) return;
        objects.push(mesh);
        if (!isObjectBatch(mesh)) {
            addFaces(mesh, mesh.geometry, mesh.matrixWorld.clone());
            return;
        }
        const tree = getBoundsTree(mesh)!;
        const localRegion = region ? region.clone().applyMatrix4(inverseWorldMatrix.copy(mesh.matrixWorld).invert()) : tree.root.box;
        const ids: number[] = [];
        collectBoxCandidates(tree.root, tree.bounds, localRegion, ids);
        const textLayout = instanceValueSize(mesh, 'textDisplayLayout') === 4;
        for (const id of ids) {
            getInstanceMatrix(mesh, id, localMatrix);
            const matrix = new Matrix4().multiplyMatrices(mesh.matrixWorld, localMatrix);
            const layout = textLayout ? textLayoutAt(mesh, id, layoutValues) : null;
            if (layout) {
                shapeMatrix.makeScale(layout[1] - layout[0], layout[2], 1);
                shapeMatrix.setPosition(layout[0], 0, 0);
                matrix.multiply(shapeMatrix);
            }
            addFaces(mesh as unknown as Mesh, textLayout ? getTextDisplayPickGeometry(mesh.geometry) : mesh.geometry, matrix, id);
        }
    });
    // Prepare world-space instances/faces once; cell rays skip repeated transforms and full-head tests.
    if (!faces.length) return [];
    if (!prepareRaycast) raycastObjectBounds.set(objects, { bounds, faces });
    else if (region && grid && grid.size > 0 && Number.isFinite(grid.size)) {
        const columns = new Map<number, Map<number, number[]>>();
        const columnAxis = (grid.axis + 1) % 3;
        const rowAxis = (grid.axis + 2) % 3;
        for (let id = 0; id < faces.length; id++) {
            const offset = id * 6;
            const firstColumn = Math.floor(Math.max(bounds[offset + columnAxis], region.min.getComponent(columnAxis)) / grid.size);
            const lastColumn = Math.floor(Math.min(bounds[offset + columnAxis + 3], region.max.getComponent(columnAxis)) / grid.size);
            const firstRow = Math.floor(Math.max(bounds[offset + rowAxis], region.min.getComponent(rowAxis)) / grid.size);
            const lastRow = Math.floor(Math.min(bounds[offset + rowAxis + 3], region.max.getComponent(rowAxis)) / grid.size);
            for (let column = firstColumn; column <= lastColumn; column++) {
                let rows = columns.get(column);
                if (!rows) columns.set(column, rows = new Map());
                for (let row = firstRow; row <= lastRow; row++) {
                    let ids = rows.get(row);
                    if (!ids) rows.set(row, ids = []);
                    ids.push(id);
                }
            }
        }
        raycastObjectBounds.set(objects, { bounds, faces, grid: { ...grid, columns } });
    } else raycastObjectBounds.set(objects, { bounds, faces, root: buildNode(bounds, faces.map((_, index) => index)) });
    return objects;
}

if (import.meta.env.DEV) {
    const bounds = new Float32Array([0, 0, 0, 1, 1, 1, 4, 0, 0, 5, 1, 1]);
    const candidates: number[] = [];
    collectCandidates(
        buildNode(bounds, [0, 1]),
        bounds,
        new Ray(new Vector3(4.5, 0.5, 2), new Vector3(0, 0, -1)),
        candidates
    );
    console.assert(candidates.length === 1 && candidates[0] === 1, 'Instanced raycast bounds tree returned the wrong candidate.');

    const geometry = new BufferGeometry();
    geometry.boundingBox = new Box3(new Vector3(-1, 0, -0.01), new Vector3(3, 2, 0));
    geometry.setAttribute('textDisplayLayout', new InstancedBufferAttribute(new Float32Array([-1, 3, 2, 2]), 4));
    const mesh = new ObjectBatch(geometry, undefined, 1);
    const tree = getBoundsTree(mesh);
    console.assert(
        tree?.bounds[0] === -1 && tree.bounds[3] === 3 && tree.bounds[4] === 2,
        'Text display instance bounds must use its own layout.'
    );

    const pickingGeometry = geometry.clone();
    pickingGeometry.setAttribute('textDisplayLayout', new InstancedBufferAttribute(new Float32Array([
        -1, 3, 2, 4,
        -1, 3, 2, 4
    ]), 4));
    pickingGeometry.setAttribute('textDisplayUvBounds', new InstancedBufferAttribute(new Float32Array([
        0, 1, 0, 1,
        0, 1, 0, 1
    ]), 4));
    pickingGeometry.setAttribute('textDisplayBackgroundUv', new InstancedBufferAttribute(new Float32Array([
        0.5, 0.5,
        0.5, 0.5
    ]), 2));
    const pickingCanvas = document.createElement('canvas');
    pickingCanvas.width = 4;
    pickingCanvas.height = 1;
    pickingCanvas.getContext('2d', { willReadFrequently: true })!.fillRect(3, 0, 1, 1);
    const pickingMaterial = new MeshBasicMaterial({ map: new CanvasTexture(pickingCanvas), alphaTest: 0.1 });
    const pickingMesh = new ObjectBatch(pickingGeometry, pickingMaterial, 2);
    pickingMesh.setMatrixAt(0, new Matrix4());
    pickingMesh.setMatrixAt(1, new Matrix4().makeTranslation(10, 0, 0));
    const root = new Group();
    root.add(pickingMesh);
    root.updateMatrixWorld(true);
    const hit = intersectSceneInstances(new Raycaster(new Vector3(12, 1, 2), new Vector3(0, 0, -1)), root);
    const transparentHit = intersectSceneInstances(new Raycaster(new Vector3(11, 1, 2), new Vector3(0, 0, -1)), root);
    console.assert(hit?.instanceId === 1 && !transparentHit, 'Text display picking must ignore transparent pixels.');
    pickingGeometry.dispose();
    pickingMaterial.map?.dispose();
    pickingMaterial.dispose();
    geometry.dispose();
}
