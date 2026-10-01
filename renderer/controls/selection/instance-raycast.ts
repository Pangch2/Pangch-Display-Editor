import {
    Box3,
    BackSide,
    BufferGeometry,
    CanvasTexture,
    Float32BufferAttribute,
    FrontSide,
    Group,
    InstancedBufferAttribute,
    InstancedMesh,
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

type BoundsNode = {
    box: Box3;
    left?: BoundsNode;
    right?: BoundsNode;
    instanceIds?: number[];
};

type BoundsTree = {
    count: number;
    geometry: BufferGeometry;
    matrixVersion: number;
    layoutVersion: number;
    bounds: Float32Array;
    root: BoundsNode;
};

type HeadTriangle = { offset: number; a: number; b: number; c: number; va: Vector3; vb: Vector3; vc: Vector3; normal: Vector3 };
export type PreparedFace = { mesh: Mesh; instanceId?: number; matrix: Matrix4; inverse: Matrix4; geometry: BufferGeometry; start: number; count: number; triangles?: HeadTriangle[] };

const leafSize = 12;
const boundsTrees = new WeakMap<InstancedMesh, BoundsTree>();
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

function getBoundsTree(mesh: InstancedMesh): BoundsTree | null {
    const textLayout = mesh.geometry.getAttribute('textDisplayLayout');
    const cached = boundsTrees.get(mesh);
    if (
        cached?.count === mesh.count
        && cached.geometry === mesh.geometry
        && cached.matrixVersion === mesh.instanceMatrix.version
        && cached.layoutVersion === (textLayout?.version ?? -1)
    ) return cached;

    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
    if (!mesh.geometry.boundingBox || mesh.count === 0) return null;
    const bounds = new Float32Array(mesh.count * 6);
    for (let instanceId = 0; instanceId < mesh.count; instanceId++) {
        mesh.getMatrixAt(instanceId, localMatrix);
        if (textLayout && instanceId < textLayout.count) {
            localBox.min.set(textLayout.getX(instanceId), 0, mesh.geometry.boundingBox.min.z);
            localBox.max.set(textLayout.getY(instanceId), textLayout.getZ(instanceId), mesh.geometry.boundingBox.max.z);
        } else {
            localBox.copy(mesh.geometry.boundingBox);
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
    const tree = {
        count: mesh.count,
        geometry: mesh.geometry,
        matrixVersion: mesh.instanceMatrix.version,
        layoutVersion: textLayout?.version ?? -1,
        bounds,
        root: buildNode(bounds, Array.from({ length: mesh.count }, (_, instanceId) => instanceId))
    };
    boundsTrees.set(mesh, tree);
    return tree;
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

function isTextDisplayPixelVisible(mesh: InstancedMesh, instanceId: number, hit: Intersection): boolean {
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
    const uvBounds = mesh.geometry.getAttribute('textDisplayUvBounds');
    if (uvBounds && alphaAt(
        uvBounds.getX(instanceId) + (uvBounds.getY(instanceId) - uvBounds.getX(instanceId)) * uv.x,
        uvBounds.getZ(instanceId) + (uvBounds.getW(instanceId) - uvBounds.getZ(instanceId)) * uv.y
    ) > cutoff) return true;

    const layout = mesh.geometry.getAttribute('textDisplayLayout');
    const backgroundUv = mesh.geometry.getAttribute('textDisplayBackgroundUv');
    if (!layout || !backgroundUv) return false;
    const x = layout.getX(instanceId) + (layout.getY(instanceId) - layout.getX(instanceId)) * uv.x;
    const center = (layout.getX(instanceId) + layout.getY(instanceId)) * 0.5;
    return Math.abs(x - center) <= layout.getW(instanceId) * 0.5
        && alphaAt(backgroundUv.getX(instanceId), backgroundUv.getY(instanceId)) > cutoff;
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

export function intersectSceneInstances(
    raycaster: Raycaster,
    root: Group,
    acceptInstance?: (mesh: InstancedMesh, instanceId: number) => boolean,
    objects?: Mesh[]
): Intersection | null {
    let nearest: Intersection | null = null;
    const intersect = (object: Object3D) => {
        if (!(object as Mesh).isMesh || object.visible === false || !object.layers.test(raycaster.layers)) return;
        if (!(object as InstancedMesh).isInstancedMesh) {
            intersections.length = 0;
            (object as Mesh).raycast(raycaster, intersections);
            for (const hit of intersections) if (!nearest || hit.distance < nearest.distance) nearest = hit;
            return;
        }

        const mesh = object as InstancedMesh;
        const textLayout = mesh.geometry.getAttribute('textDisplayLayout');
        const tree = getBoundsTree(mesh);
        if (!tree) return;
        localRay.copy(raycaster.ray).applyMatrix4(inverseWorldMatrix.copy(mesh.matrixWorld).invert());
        const maxDistance = Number.isFinite(raycaster.far)
            ? rangeEnd.copy(raycaster.ray.direction).multiplyScalar(raycaster.far).add(raycaster.ray.origin)
                .applyMatrix4(inverseWorldMatrix).distanceTo(localRay.origin)
            : Infinity;
        candidates.length = 0;
        collectCandidates(tree.root, tree.bounds, localRay, candidates, maxDistance);
        pickMesh.geometry = textLayout ? textDisplayPickGeometry : mesh.geometry;
        pickMesh.material = mesh.material;
        for (const instanceId of candidates) {
            if (acceptInstance && !acceptInstance(mesh, instanceId)) continue;
            mesh.getMatrixAt(instanceId, localMatrix);
            pickMesh.matrixWorld.multiplyMatrices(mesh.matrixWorld, localMatrix);
            if (textLayout && instanceId < textLayout.count) {
                shapeMatrix.makeScale(
                    textLayout.getY(instanceId) - textLayout.getX(instanceId),
                    textLayout.getZ(instanceId),
                    1
                );
                shapeMatrix.setPosition(textLayout.getX(instanceId), 0, 0);
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
            if (face.instanceId !== undefined && acceptInstance && !acceptInstance(mesh as InstancedMesh, face.instanceId)) continue;
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
            const textLayout = mesh.geometry.getAttribute('textDisplayLayout');
            for (const hit of intersections) {
                if (face.instanceId !== undefined && textLayout && !isTextDisplayPixelVisible(mesh as InstancedMesh, face.instanceId, hit)) continue;
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
        if (!mesh.isMesh || !mesh.visible) return;
        if ((mesh as InstancedMesh).isInstancedMesh) {
            const tree = getBoundsTree(mesh as InstancedMesh);
            if (!tree) return;
            box.copy(tree.root.box);
        } else {
            if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
            if (!mesh.geometry.boundingBox) return;
            box.copy(mesh.geometry.boundingBox);
        }
        if (region && !box.applyMatrix4(mesh.matrixWorld).intersectsBox(region)) return;
        objects.push(mesh);
        if (!(mesh as InstancedMesh).isInstancedMesh) {
            addFaces(mesh, mesh.geometry, mesh.matrixWorld.clone());
            return;
        }
        const instanceMesh = mesh as InstancedMesh;
        const tree = getBoundsTree(instanceMesh)!;
        const localRegion = region ? region.clone().applyMatrix4(inverseWorldMatrix.copy(mesh.matrixWorld).invert()) : tree.root.box;
        const ids: number[] = [];
        collectBoxCandidates(tree.root, tree.bounds, localRegion, ids);
        const layout = mesh.geometry.getAttribute('textDisplayLayout');
        for (const id of ids) {
            instanceMesh.getMatrixAt(id, localMatrix);
            const matrix = new Matrix4().multiplyMatrices(mesh.matrixWorld, localMatrix);
            if (layout && id < layout.count) {
                shapeMatrix.makeScale(layout.getY(id) - layout.getX(id), layout.getZ(id), 1);
                shapeMatrix.setPosition(layout.getX(id), 0, 0);
                matrix.multiply(shapeMatrix);
            }
            addFaces(mesh, layout ? textDisplayPickGeometry : mesh.geometry, matrix, id);
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
    const mesh = new InstancedMesh(geometry, undefined, 1);
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
    const pickingMesh = new InstancedMesh(pickingGeometry, pickingMaterial, 2);
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
