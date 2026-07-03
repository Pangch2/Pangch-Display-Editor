import {
    Box3,
    BoxGeometry,
    InstancedMesh,
    Matrix4,
    MeshBasicMaterial,
    Object3D,
    Scene,
    Vector3
} from 'three/webgpu';

export interface SelectionState {
    groups: Set<string>;
    objects: Map<Object3D, Set<number>>;
    primary: { type: 'object'; mesh: Object3D; instanceId: number } | null;
}

type InstanceMatrixReadable = Object3D & {
    getMatrixAt?: (index: number, matrix: Matrix4) => void;
};

const instanceMatrix = new Matrix4();
const worldMatrix = new Matrix4();
const overlayWorldMatrix = new Matrix4();
const edgeMatrix = new Matrix4();
const localBox = new Box3();
const overlayLocalBox = new Box3();
const localCenter = new Vector3();
const localSize = new Vector3();

const SELECTION_OVERLAY_COLOR = 0x4ea6ff;
const EDGE_INSTANCE_COUNT = 12;
const EDGE_THICKNESS_RATIO = 0.001;
const MIN_EDGE_THICKNESS = 0.001;

export function createSelectionState(): SelectionState {
    return {
        groups: new Set<string>(),
        objects: new Map(),
        primary: null
    };
}

export function clearSelectionState(selection: SelectionState): void {
    selection.groups.clear();
    selection.objects.clear();
    selection.primary = null;
}

export function setObjectSelection(selection: SelectionState, mesh: Object3D, instanceId: number): void {
    selection.groups.clear();
    selection.objects.clear();
    selection.objects.set(mesh, new Set([instanceId]));
    selection.primary = { type: 'object', mesh, instanceId };
}

export function replaceSelectionWithObjectsMap(selection: SelectionState, meshToIds: Map<Object3D, Set<number>>): void {
    clearSelectionState(selection);
    for (const [mesh, ids] of meshToIds) {
        if (ids.size === 0) continue;
        selection.objects.set(mesh, new Set(ids));
        if (!selection.primary) {
            const firstInstanceId = ids.values().next().value;
            if (firstInstanceId === undefined) continue;
            selection.primary = { type: 'object', mesh, instanceId: firstInstanceId };
        }
    }
}

export function resolveSelectionBox(mesh: Object3D, instanceId: number, target: Box3): boolean {
    if (!resolveSelectionFrame(mesh, instanceId, localBox, worldMatrix)) return false;

    target.copy(localBox).applyMatrix4(worldMatrix);
    return true;
}

function resolveSelectionFrame(mesh: Object3D, instanceId: number, box: Box3, matrix: Matrix4): boolean {
    const geometry = (mesh as { geometry?: { boundingBox: Box3 | null; computeBoundingBox: () => void } }).geometry;
    if (!geometry) return false;
    if (!geometry.boundingBox) geometry.computeBoundingBox();
    if (!geometry.boundingBox) return false;

    mesh.updateMatrixWorld(true);
    box.copy(geometry.boundingBox);
    const readable = mesh as InstanceMatrixReadable;

    if (mesh instanceof InstancedMesh || typeof readable.getMatrixAt === 'function') {
        readable.getMatrixAt?.(instanceId, instanceMatrix);
        matrix.multiplyMatrices(mesh.matrixWorld, instanceMatrix);
        return true;
    }

    matrix.copy(mesh.matrixWorld);
    return true;
}

export function createSelectionOverlay(scene: Scene): {
    box: Box3;
    clear: () => void;
    update: (mesh: Object3D, instanceId: number) => boolean;
    getCenter: (target: Vector3) => Vector3;
} {
    const box = new Box3();
    const edgeGeometry = new BoxGeometry(1, 1, 1);
    const edgeMaterial = new MeshBasicMaterial({
        color: SELECTION_OVERLAY_COLOR,
        depthTest: false,
        depthWrite: false,
        toneMapped: false
    });
    const helper = new InstancedMesh(edgeGeometry, edgeMaterial, EDGE_INSTANCE_COUNT);
    helper.renderOrder = 1000;
    helper.frustumCulled = false;
    helper.visible = false;
    scene.add(helper);

    const clear = (): void => {
        helper.visible = false;
    };

    return {
        box,
        clear,
        update: (mesh: Object3D, instanceId: number): boolean => {
            clear();
            if (!resolveSelectionFrame(mesh, instanceId, overlayLocalBox, overlayWorldMatrix)) return false;

            box.copy(overlayLocalBox).applyMatrix4(overlayWorldMatrix);
            updateOverlayEdges(helper, overlayLocalBox, overlayWorldMatrix);
            helper.visible = true;
            return true;
        },
        getCenter: (target: Vector3): Vector3 => box.getCenter(target)
    };
}

function updateOverlayEdges(helper: InstancedMesh, box: Box3, matrix: Matrix4): void {
    box.getCenter(localCenter);
    box.getSize(localSize);

    const maxSize = Math.max(localSize.x, localSize.y, localSize.z);
    const thickness = Math.max(maxSize * EDGE_THICKNESS_RATIO, MIN_EDGE_THICKNESS);
    const sx = Math.max(localSize.x, thickness);
    const sy = Math.max(localSize.y, thickness);
    const sz = Math.max(localSize.z, thickness);
    let edgeIndex = 0;

    for (const y of [box.min.y, box.max.y]) {
        for (const z of [box.min.z, box.max.z]) {
            setOverlayEdge(helper, edgeIndex++, matrix, localCenter.x, y, z, sx, thickness, thickness);
        }
    }

    for (const x of [box.min.x, box.max.x]) {
        for (const z of [box.min.z, box.max.z]) {
            setOverlayEdge(helper, edgeIndex++, matrix, x, localCenter.y, z, thickness, sy, thickness);
        }
    }

    for (const x of [box.min.x, box.max.x]) {
        for (const y of [box.min.y, box.max.y]) {
            setOverlayEdge(helper, edgeIndex++, matrix, x, y, localCenter.z, thickness, thickness, sz);
        }
    }

    helper.instanceMatrix.needsUpdate = true;
}

function setOverlayEdge(
    helper: InstancedMesh,
    index: number,
    matrix: Matrix4,
    x: number,
    y: number,
    z: number,
    sx: number,
    sy: number,
    sz: number
): void {
    edgeMatrix.makeScale(sx, sy, sz);
    edgeMatrix.setPosition(x, y, z);
    edgeMatrix.premultiply(matrix);
    helper.setMatrixAt(index, edgeMatrix);
}
