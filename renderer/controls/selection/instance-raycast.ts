import {
    Box3,
    BufferGeometry,
    CanvasTexture,
    Float32BufferAttribute,
    Group,
    InstancedBufferAttribute,
    InstancedMesh,
    Matrix4,
    Mesh,
    MeshBasicMaterial,
    Ray,
    Raycaster,
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

const leafSize = 12;
const boundsTrees = new WeakMap<InstancedMesh, BoundsTree>();
const localMatrix = new Matrix4();
const shapeMatrix = new Matrix4();
const inverseWorldMatrix = new Matrix4();
const localRay = new Ray();
const localBox = new Box3();
const itemBox = new Box3();
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

export function intersectSceneInstances(
    raycaster: Raycaster,
    root: Group,
    acceptInstance?: (mesh: InstancedMesh, instanceId: number) => boolean
): Intersection | null {
    let nearest: Intersection | null = null;
    root.traverse((object: Object3D) => {
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
        candidates.length = 0;
        collectCandidates(tree.root, tree.bounds, localRay, candidates);
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
