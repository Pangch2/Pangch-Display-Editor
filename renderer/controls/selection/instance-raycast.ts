import {
    Box3,
    Group,
    InstancedMesh,
    Matrix4,
    Mesh,
    Ray,
    Raycaster,
    Vector3,
    type BufferGeometry,
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
    bounds: Float32Array;
    root: BoundsNode;
};

const leafSize = 12;
const boundsTrees = new WeakMap<InstancedMesh, BoundsTree>();
const localMatrix = new Matrix4();
const inverseWorldMatrix = new Matrix4();
const localRay = new Ray();
const localBox = new Box3();
const itemBox = new Box3();
const size = new Vector3();
const pickMesh = new Mesh();
const intersections: Intersection[] = [];
const candidates: number[] = [];

function buildNode(bounds: Float32Array, instanceIds: number[]): BoundsNode {
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
    const cached = boundsTrees.get(mesh);
    if (cached?.count === mesh.count && cached.geometry === mesh.geometry && cached.matrixVersion === mesh.instanceMatrix.version) return cached;

    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
    if (!mesh.geometry.boundingBox || mesh.count === 0) return null;
    const bounds = new Float32Array(mesh.count * 6);
    for (let instanceId = 0; instanceId < mesh.count; instanceId++) {
        mesh.getMatrixAt(instanceId, localMatrix);
        localBox.copy(mesh.geometry.boundingBox).applyMatrix4(localMatrix);
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
        bounds,
        root: buildNode(bounds, Array.from({ length: mesh.count }, (_, instanceId) => instanceId))
    };
    boundsTrees.set(mesh, tree);
    return tree;
}

function collectCandidates(node: BoundsNode, bounds: Float32Array, ray: Ray, target: number[]): void {
    if (!ray.intersectsBox(node.box)) return;
    if (node.instanceIds) {
        for (const instanceId of node.instanceIds) {
            const offset = instanceId * 6;
            itemBox.min.fromArray(bounds, offset);
            itemBox.max.fromArray(bounds, offset + 3);
            if (ray.intersectsBox(itemBox)) target.push(instanceId);
        }
        return;
    }
    if (node.left) collectCandidates(node.left, bounds, ray, target);
    if (node.right) collectCandidates(node.right, bounds, ray, target);
}

export function intersectSceneInstances(
    raycaster: Raycaster,
    root: Group,
    acceptInstance?: (mesh: InstancedMesh, instanceId: number) => boolean
): Intersection | null {
    let nearest: Intersection | null = null;
    root.traverse((object: Object3D) => {
        if (!(object as Mesh).isMesh || !object.layers.test(raycaster.layers)) return;
        if (!(object as InstancedMesh).isInstancedMesh) {
            intersections.length = 0;
            (object as Mesh).raycast(raycaster, intersections);
            for (const hit of intersections) if (!nearest || hit.distance < nearest.distance) nearest = hit;
            return;
        }

        const mesh = object as InstancedMesh;
        const tree = getBoundsTree(mesh);
        if (!tree) return;
        localRay.copy(raycaster.ray).applyMatrix4(inverseWorldMatrix.copy(mesh.matrixWorld).invert());
        candidates.length = 0;
        collectCandidates(tree.root, tree.bounds, localRay, candidates);
        pickMesh.geometry = mesh.geometry;
        pickMesh.material = mesh.material;
        for (const instanceId of candidates) {
            if (acceptInstance && !acceptInstance(mesh, instanceId)) continue;
            mesh.getMatrixAt(instanceId, localMatrix);
            pickMesh.matrixWorld.multiplyMatrices(mesh.matrixWorld, localMatrix);
            intersections.length = 0;
            pickMesh.raycast(raycaster, intersections);
            for (const hit of intersections) {
                if (nearest && hit.distance >= nearest.distance) continue;
                hit.instanceId = instanceId;
                hit.object = mesh;
                nearest = hit;
            }
        }
    });
    return nearest;
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
}
