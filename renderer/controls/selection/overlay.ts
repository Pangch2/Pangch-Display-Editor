import {
    InstancedMesh,
    Mesh,
    Vector3,
    Quaternion,
    Matrix4,
    Box3,
    Group,
    BufferGeometry,
    BufferAttribute,
    Color,
    Float32BufferAttribute,
    InstancedBufferAttribute,
    StorageInstancedBufferAttribute,
    LineBasicMaterial,
    EdgesGeometry,
    BoxGeometry,
    PlaneGeometry,
    DynamicDrawUsage,
    Material,
    LineSegments,
    MeshBasicNodeMaterial,
    SpriteMaterial,
    Sprite,
    Line,
    Scene,
    Renderer,
    Camera,
    Vector2
} from 'three/webgpu';
import { attribute } from 'three/tsl';
import { createHeadPainterGridMaterial, createHeadPainterPreviewMaterial } from './head-painter-gpu-preview';
import * as GroupUtils from '../grouping/group';
import type { GroupChildObject } from '../grouping/group';
import { dragDeltaMatrix, dragPreviewPositionNode, dragSelectedAttributeName, entityVisibleAttributeName } from '../../entity-material';
import { ConvexHull } from 'three/examples/jsm/math/ConvexHull.js';

// --- Types & Interfaces ---

type PdeMesh = InstancedMesh | Mesh;

export interface SelectionState {
    groups: Set<string>;
    objects: Map<Mesh | InstancedMesh, Set<number>>;
}

export type QueueItemType = 'group' | 'object' | 'bundle';

export interface QueueItem {
    type: QueueItemType;
    id?: string;
    mesh?: Mesh | InstancedMesh;
    instanceId?: number;
    items?: QueueItem[];
    gizmoLocalPosition?: Vector3;
    gizmoLocalQuaternion?: Quaternion;
    gizmoPosition?: Vector3;
    gizmoQuaternion?: Quaternion;
}

interface OverlayItemSource {
    type: 'group' | 'object';
    id?: string;
    mesh?: Mesh | InstancedMesh;
    instanceId?: number;
    cachedLocalCenter?: Vector3;
    cachedLocalSize?: Vector3;
}

interface OverlayItem {
    matrix: Matrix4;
    color: number;
    source: OverlayItemSource;
    gizmoPosition?: Vector3;
    gizmoQuaternion?: Quaternion;
    gizmoLocalPosition?: Vector3;
}

// --- Constants & Temporaries ---

const _TMP_MAT4_A = new Matrix4();
const _TMP_MAT4_B = new Matrix4();
const _TMP_MAT4_C = new Matrix4();
const _TMP_BOX3_A = new Box3();
const _TMP_VEC3_A = new Vector3();
const _TMP_VEC3_B = new Vector3();

let loadedObjectGroup: Group | null = null;
const _dragInitialOverlayMatrix = new Matrix4();
let _dragBoundsHullPoints: Vector3[] = [];

export function setLoadedObjectGroup(group: Group | null): void {
    loadedObjectGroup = group;
}

function getGroups() {
    return GroupUtils.getGroups(loadedObjectGroup);
}

function getAllGroupChildren(groupId: string) {
    return GroupUtils.getAllGroupChildren(loadedObjectGroup, groupId);
}

// --- Geometry & Materials ---

const _overlayUnitGeo = (() => {
    const geo = new BufferGeometry();
    const vertices = new Float32Array([
        -0.5, -0.5, -0.5,  0.5, -0.5, -0.5, -0.5, -0.5, -0.5,
         0.5, -0.5, -0.5,  0.5, -0.5,  0.5,  0.5, -0.5, -0.5,
         0.5, -0.5,  0.5, -0.5, -0.5,  0.5,  0.5, -0.5,  0.5,
        -0.5, -0.5,  0.5, -0.5, -0.5, -0.5, -0.5, -0.5,  0.5,
        -0.5,  0.5, -0.5,  0.5,  0.5, -0.5, -0.5,  0.5, -0.5,
         0.5,  0.5, -0.5,  0.5,  0.5,  0.5,  0.5,  0.5, -0.5,
         0.5,  0.5,  0.5, -0.5,  0.5,  0.5,  0.5,  0.5,  0.5,
        -0.5,  0.5,  0.5, -0.5,  0.5, -0.5, -0.5,  0.5,  0.5,
        -0.5, -0.5, -0.5, -0.5,  0.5, -0.5, -0.5, -0.5, -0.5,
         0.5, -0.5, -0.5,  0.5,  0.5, -0.5,  0.5, -0.5, -0.5,
         0.5, -0.5,  0.5,  0.5,  0.5,  0.5,  0.5, -0.5,  0.5,
        -0.5, -0.5,  0.5, -0.5,  0.5,  0.5, -0.5, -0.5,  0.5
    ]);
    geo.setAttribute('position', new BufferAttribute(vertices, 3));
    return geo;
})();

const _axisUnitGeo = (() => {
    const geo = new BufferGeometry();
    const verts: number[] = [];
    const colors: number[] = [];
    const addLine = (v: Vector3, colorHex: number) => {
        verts.push(0, 0, 0, v.x, v.y, v.z);
        const c = new Color(colorHex);
        colors.push(c.r, c.g, c.b, c.r, c.g, c.b);
    };
    addLine(new Vector3(0.3, 0, 0), 0xEF3751);
    addLine(new Vector3(-0.3, 0, 0), 0xEF3751);
    addLine(new Vector3(0, 0.3, 0), 0x6FA21C);
    addLine(new Vector3(0, -0.3, 0), 0x6FA21C);
    addLine(new Vector3(0, 0, 0.3), 0x437FD0);
    addLine(new Vector3(0, 0, -0.3), 0x437FD0);
    
    geo.setAttribute('position', new Float32BufferAttribute(verts, 3));
    geo.setAttribute('color', new Float32BufferAttribute(colors, 3));
    return geo;
})();

const _axisMat = new LineBasicMaterial({
    vertexColors: true,
    depthTest: false,
    depthWrite: false,
    transparent: true
});

const _selectionOverlayMat = new MeshBasicNodeMaterial({
    color: 0xffffff,
    depthTest: true,
    depthWrite: false,
    transparent: true,
    opacity: 0.9,
    wireframe: true
});
_selectionOverlayMat.positionNode = dragPreviewPositionNode;

const _vertexSpriteMat = new SpriteMaterial({
    color: 0x30333D,
    sizeAttenuation: false,
    depthTest: false,
    depthWrite: false,
    transparent: true
});
const _selectedVertexSpriteMat = _vertexSpriteMat.clone();
_selectedVertexSpriteMat.color.setHex(0x437FD0);

const _boxEdgesGeo = (() => {
    const boxGeo = new BoxGeometry(1, 1, 1);
    const edgesGeo = new EdgesGeometry(boxGeo);
    boxGeo.dispose();
    return edgesGeo;
})();

const _multiSelectionMat = new LineBasicMaterial({
    color: 0xFFFFFF,
    depthTest: true,
    depthWrite: false,
    transparent: true,
    opacity: 0.9
});

const _unitCubeCorners = [
    new Vector3(-0.5, -0.5, -0.5),
    new Vector3( 0.5, -0.5, -0.5),
    new Vector3( 0.5,  0.5, -0.5),
    new Vector3(-0.5,  0.5, -0.5),
    new Vector3(-0.5, -0.5,  0.5),
    new Vector3( 0.5, -0.5,  0.5),
    new Vector3( 0.5,  0.5,  0.5),
    new Vector3(-0.5,  0.5,  0.5)
];

// --- Helper Functions ---

export function getInstanceCount(mesh: Mesh | InstancedMesh): number {
    if (!mesh) return 0;
    if ((mesh as InstancedMesh).isInstancedMesh) return (mesh as InstancedMesh).count ?? 0;
    return 0;
}

export function isInstanceValid(mesh: Mesh | InstancedMesh, instanceId: number): boolean {
    if (!mesh) return false;
    if ((mesh as InstancedMesh).isInstancedMesh) {
        return instanceId < ((mesh as InstancedMesh).count ?? 0);
    }
    return false;
}

export function getDisplayType(mesh: PdeMesh, instanceId: number): string | undefined {
    if (!mesh) return undefined;
    if (mesh.userData?.displayTypes instanceof Map) {
        return mesh.userData.displayTypes.get(instanceId) ?? mesh.userData?.displayType;
    }
    return mesh.userData?.displayType;
}

function getDisplayOverlayColor(displayType?: string): number {
    if (displayType === 'item_display') return 0x2E87EC;
    if (displayType === 'text_display') return 0xEF3751;
    return 0xFFD147;
}

export function isItemDisplayHatEnabled(mesh: PdeMesh, instanceId: number): boolean {
    return !!(getDisplayType(mesh, instanceId) === 'item_display' && mesh?.userData?.hasHat && mesh.userData.hasHat[instanceId]);
}

export function getInstanceLocalOriginOffset(mesh: PdeMesh, instanceId: number, out = new Vector3()): Vector3 {
    out.set(0, isItemDisplayHatEnabled(mesh, instanceId) ? 0.03125 : 0, 0);
    if (getDisplayType(mesh, instanceId) === 'text_display') {
        const box = getInstanceLocalBox(mesh, instanceId);
        if (box) out.x = (box.min.x + box.max.x) * 0.5;
    }
    return out;
}

export function getInstanceLocalBoxMin(mesh: PdeMesh, instanceId: number, out = new Vector3()): Vector3 | null {
    const box = getInstanceLocalBox(mesh, instanceId);
    if (!box) return null;
    return out.copy(box.min);
}

export function getInstanceWorldMatrixForOrigin(mesh: PdeMesh, instanceId: number, outMatrix: Matrix4): Matrix4 {
    outMatrix.identity();
    if (!mesh) return outMatrix;

    mesh.getMatrixAt(instanceId, outMatrix);
    if (mesh.userData?.localMatrices && mesh.userData.localMatrices.has(instanceId)) {
        _TMP_MAT4_B.copy(mesh.userData.localMatrices.get(instanceId)).invert();
        outMatrix.multiply(_TMP_MAT4_B);
    }
    outMatrix.premultiply(mesh.matrixWorld);
    return outMatrix;
}

export function calculateAvgOriginForChildren(children: GroupChildObject[], out = new Vector3()): Vector3 {
    out.set(0, 0, 0);
    if (!Array.isArray(children) || children.length === 0) return out;

    const tempPos = _TMP_VEC3_A;
    const tempMat = _TMP_MAT4_A;

    children.forEach(child => {
        const m = child.mesh;
        const id = child.instanceId;
        if (!m && m !== 0) return;

        getInstanceWorldMatrixForOrigin(m, id, tempMat);
        getInstanceLocalOriginOffset(m, id, tempPos).applyMatrix4(tempMat);
        out.add(tempPos);
    });

    out.divideScalar(children.length);
    return out;
}

export function getGroupWorldMatrixWithFallback(groupId: string, out = new Matrix4()): Matrix4 {
    out.identity();
    const groups = getGroups();
    const group = groups.get(groupId);
    if (!group) return out;
    if (group.matrix) return out.copy(group.matrix);

    let gPos = group.position;
    if (!gPos) {
        const children = getAllGroupChildren(groupId);
        gPos = calculateAvgOriginForChildren(children, _TMP_VEC3_B);
    }
    const quat = group.quaternion || new Quaternion();
    const scale = group.scale || new Vector3(1, 1, 1);
    return out.compose(gPos, quat, scale);
}

export function unionTransformedBox3(targetBox: Box3, localBox: Box3, matrix: Matrix4, tempBox = _TMP_BOX3_A): void {
    if (!targetBox || !localBox) return;
    tempBox.copy(localBox).applyMatrix4(matrix);
    targetBox.union(tempBox);
}

export function getInstanceLocalBox(mesh: PdeMesh, instanceId: number): Box3 | null {
    if (!mesh) return null;

    if (!mesh.geometry) return null;
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
    if (!mesh.geometry.boundingBox) return null;

    const textLayout = mesh.geometry.getAttribute('textDisplayLayout');
    let box = mesh.geometry.boundingBox.clone();
    if (textLayout && instanceId < textLayout.count) {
        const centerX = (textLayout.getX(instanceId) + textLayout.getY(instanceId)) * 0.5;
        const halfWidth = textLayout.getW(instanceId) * 0.5;
        box.min.set(centerX - halfWidth, 0, mesh.geometry.boundingBox.min.z);
        box.max.set(centerX + halfWidth, textLayout.getZ(instanceId), mesh.geometry.boundingBox.max.z);
    }

    if (getDisplayType(mesh, instanceId) === 'item_display' && mesh.userData?.hasHat && !mesh.userData.hasHat[instanceId]) {
        const center = new Vector3();
        box.getCenter(center);
        box = new Box3().setFromCenterAndSize(center, new Vector3(1, 1, 1));
    }

    return box;
}

if (import.meta.env.DEV) {
    const geometry = new BufferGeometry();
    geometry.boundingBox = new Box3(new Vector3(-1, 0, 0), new Vector3(3, 1, 0));
    const mesh = new InstancedMesh(geometry, undefined, 1);
    mesh.userData.displayType = 'text_display';
    console.assert(getInstanceLocalOriginOffset(mesh, 0).equals(new Vector3(1, 0, 0)), 'Text display origin must stay horizontally centered.');
}

export function getInstanceWorldMatrix(mesh: PdeMesh, instanceId: number, outMatrix: Matrix4): Matrix4 {
    outMatrix.identity();
    if (!mesh) return outMatrix;
    mesh.getMatrixAt(instanceId, outMatrix);
    outMatrix.premultiply(mesh.matrixWorld);
    return outMatrix;
}

export function getGroupLocalBoundingBox(groupId: string): Box3 {
    const groups = getGroups();
    const group = groups.get(groupId);
    if (!group) return new Box3();

    const groupMatrix = getGroupWorldMatrixWithFallback(groupId, new Matrix4());
    const groupInverse = new Matrix4();

    if (Math.abs(groupMatrix.determinant()) > 1e-10) {
        groupInverse.copy(groupMatrix).invert();
    } else {
        const pos = new Vector3();
        const quat = new Quaternion();
        const scale = new Vector3();
        groupMatrix.decompose(pos, quat, scale);

        groupInverse.makeTranslation(-pos.x, -pos.y, -pos.z);
        const tempInv = new Matrix4();
        tempInv.makeRotationFromQuaternion(quat.clone().invert());
        groupInverse.premultiply(tempInv);
        
        const safeInv = (s: number) => (Math.abs(s) < 1e-10 ? 0 : 1 / s);
        tempInv.makeScale(safeInv(scale.x), safeInv(scale.y), safeInv(scale.z));
        groupInverse.premultiply(tempInv); 
    }

    const children = getAllGroupChildren(groupId);
    const box = new Box3();
    const tempMat = new Matrix4();
    const tempBox = new Box3();

    if (children.length === 0) return box;

    children.forEach(child => {
        const mesh = child.mesh;
        const id = child.instanceId;
        if (!mesh) return;

        const localBox = getInstanceLocalBox(mesh, id);
        if (!localBox) return;

        getInstanceWorldMatrix(mesh, id, tempMat);
        tempMat.premultiply(groupInverse);
        tempBox.copy(localBox).applyMatrix4(tempMat);
        box.union(tempBox);
    });
    return box;
}

export function getGroupOriginWorld(groupId: string, out = new Vector3()): Vector3 {
    const groups = getGroups();
    const group = groups.get(groupId);
    if (!group) return out.set(0, 0, 0);

    const box = getGroupLocalBoundingBox(groupId);
    if (!box.isEmpty()) {
        const m = GroupUtils.getGroupWorldMatrix(group, new Matrix4());
        return out.copy(box.min).applyMatrix4(m);
    }
    if (group.position) return out.copy(group.position);

    const children = getAllGroupChildren(groupId);
    if (children.length > 0) {
        return calculateAvgOriginForChildren(children, out);
    }
    return out.set(0, 0, 0);
}

export function getRotationFromMatrix(matrix: Matrix4): Quaternion {
    const R = new Matrix4();
    const x = _TMP_VEC3_A.setFromMatrixColumn(matrix, 0).normalize();
    const y = _TMP_VEC3_B.setFromMatrixColumn(matrix, 1);
    const z = new Vector3().setFromMatrixColumn(matrix, 2);

    const yDotX = y.dot(x);
    y.sub(x.clone().multiplyScalar(yDotX)).normalize();
    z.crossVectors(x, y).normalize();
    R.makeBasis(x, y, z);
    
    const quaternion = new Quaternion();
    quaternion.setFromRotationMatrix(R);
    return quaternion;
}

export function getSelectionBoundingBox(currentSelection: SelectionState, previewMatrix?: Matrix4): Box3 {
    const box = new Box3();
    const tempMat = new Matrix4();
    const tempBox = new Box3();

    if (currentSelection.groups && currentSelection.groups.size > 0) {
        for (const groupId of currentSelection.groups) {
            const localBox = getGroupLocalBoundingBox(groupId);
            if (!localBox || localBox.isEmpty()) continue;
            getGroupWorldMatrixWithFallback(groupId, tempMat);
            if (previewMatrix) tempMat.premultiply(previewMatrix);
            tempBox.copy(localBox).applyMatrix4(tempMat);
            box.union(tempBox);
        }
    }

    if (currentSelection.objects && currentSelection.objects.size > 0) {
        for (const [mesh, ids] of currentSelection.objects) {
            for (const id of ids) {
                const localBox = getInstanceLocalBox(mesh, id);
                if (!localBox) continue;
                getInstanceWorldMatrix(mesh, id, tempMat);
                if (previewMatrix) tempMat.premultiply(previewMatrix);
                tempBox.copy(localBox).applyMatrix4(tempMat);
                box.union(tempBox);
            }
        }
    }

    return box;
}

function _getSelectedObjectCount(currentSelection: SelectionState): number {
    let count = 0;
    if (currentSelection.objects) {
        for (const ids of currentSelection.objects.values()) {
            count += ids.size;
        }
    }
    return count;
}

export function prepareMultiSelectionDrag(_currentSelection: SelectionState): void {
    const activeBoxLine = multiSelectionOverlay?.children[0] as LineSegments | undefined;
    if (activeBoxLine) _dragInitialOverlayMatrix.copy(activeBoxLine.matrix);

    _dragBoundsHullPoints = [];
    if (!selectionOverlay) return;
    const selectedCount = Math.min(selectionOverlay.count, (selectionOverlay.userData['selectedCount'] as number | undefined) ?? selectionOverlay.count);
    const points: Vector3[] = [];
    for (let i = 0; i < selectedCount; i++) {
        selectionOverlay.getMatrixAt(i, _TMP_MAT4_A);
        for (const corner of _unitCubeCorners) points.push(corner.clone().applyMatrix4(_TMP_MAT4_A));
    }
    if (points.length < 4) { _dragBoundsHullPoints = points; return; }

    try {
        const hull = new ConvexHull().setFromPoints(points);
        const hullPoints = new Set<Vector3>();
        for (const face of hull.faces) {
            let edge = face.edge;
            do {
                hullPoints.add(edge.head().point);
                edge = edge.next;
            } while (edge !== face.edge);
        }
        _dragBoundsHullPoints = hullPoints.size > 0 ? [...hullPoints] : points;
    } catch {
        _dragBoundsHullPoints = points;
    }
}

// --- Overlay State ---

const _headGridDragMatrix = new Matrix4();
const HEAD_GRID_INSTANCES_PER_CHUNK = 32768;
let headPainterGridOverlay: Group | null = null;
let headPainterStampPreview: InstancedMesh | null = null;
let headPainterGridDirty = true;

export function invalidateHeadPainterGridOverlay(): void {
    headPainterGridDirty = true;
}

export function updateHeadPainterGridOverlay(
    scene: Scene,
    objectGroup: Group,
    enabled: boolean,
    layerMode: 'auto' | 'layer' | 'base',
    color: number,
    getFaceGridCounts: (objectUuid: string, face: number, worldMatrix: Matrix4, layer: 0 | 1) => [number, number, number, number]
): void {
    if (!headPainterGridDirty && _headGridDragMatrix.equals(dragDeltaMatrix)) return;
    if (!enabled) {
        if (headPainterGridOverlay) headPainterGridOverlay.visible = false;
        headPainterGridDirty = false;
        _headGridDragMatrix.copy(dragDeltaMatrix);
        return;
    }
    const meshes: InstancedMesh[] = [];
    objectGroup.updateMatrixWorld(true);
    objectGroup.traverse(object => {
        if ((object as InstancedMesh).isInstancedMesh && (object as InstancedMesh).geometry.getAttribute('headLayerVisible')) meshes.push(object as InstancedMesh);
    });
    if (!headPainterGridOverlay) {
        headPainterGridOverlay = new Group();
        headPainterGridOverlay.name = 'head-painter-grid';
        scene.add(headPainterGridOverlay);
    }
    headPainterGridOverlay.visible = true;
    for (const child of headPainterGridOverlay.children) (child as InstancedMesh).count = 0;
    const total = meshes.reduce((sum, mesh) => sum + mesh.count, 0);
    const keyToUuid = objectGroup.userData.instanceKeyToObjectUuid as Map<string, string> | undefined;
    const worldMatrix = new Matrix4();
    let chunkIndex = 0;
    const changed = new Set<BufferAttribute>();
    const write = (attribute: BufferAttribute, offset: number, values: ArrayLike<number>) => {
        let differs = false;
        for (let i = 0; i < values.length; i++) if (attribute.array[offset + i] !== Math.fround(values[i])) {
            attribute.array[offset + i] = values[i];
            differs = true;
        }
        if (differs) changed.add(attribute);
    };
    for (const mesh of meshes) {
        for (let instanceId = 0; instanceId < mesh.count; instanceId++) {
            if (mesh.geometry.getAttribute(entityVisibleAttributeName)?.getX(instanceId) === 0) continue;
            const uuid = keyToUuid?.get(`${mesh.uuid}_${instanceId}`);
            if (!uuid) continue;
            const showLayer = layerMode === 'layer' || (layerMode === 'auto' && !!mesh.userData.hasHat?.[instanceId]);
            const scale = showLayer ? 1.0625 : 1;
            mesh.getMatrixAt(instanceId, worldMatrix);
            worldMatrix.premultiply(mesh.matrixWorld);
            if (mesh.geometry.getAttribute(dragSelectedAttributeName)?.getX(instanceId)) worldMatrix.premultiply(dragDeltaMatrix);
            let lines = headPainterGridOverlay.children[chunkIndex] as InstancedMesh;
            if (lines && lines.count === lines.instanceMatrix.count) lines = headPainterGridOverlay.children[++chunkIndex] as InstancedMesh;
            if (!lines) {
                const capacity = Math.min(Math.max(16, total), HEAD_GRID_INSTANCES_PER_CHUNK);
                const geometry = createHeadPainterGridGeometry(capacity);
                const material = (headPainterGridOverlay.children[0] as InstancedMesh)?.material ?? createHeadPainterGridMaterial(color);
                lines = new InstancedMesh(geometry, material, capacity);
                (lines as InstancedMesh & { isLineSegments: boolean }).isLineSegments = true;
                lines.instanceMatrix = new StorageInstancedBufferAttribute(new Float32Array(capacity * 16), 16).setUsage(DynamicDrawUsage);
                lines.count = 0;
                lines.frustumCulled = false;
                lines.renderOrder = 1000;
                headPainterGridOverlay.add(lines);
            }
            const slot = lines.count++;
            write(lines.instanceMatrix, slot * 16, worldMatrix.elements);
            write(lines.geometry.getAttribute('headPainterGridScale') as BufferAttribute, slot, [scale]);
            for (let pair = 0; pair < 3; pair++) {
                const first = getFaceGridCounts(uuid, pair * 2, worldMatrix, showLayer ? 1 : 0);
                const second = getFaceGridCounts(uuid, pair * 2 + 1, worldMatrix, showLayer ? 1 : 0);
                write(lines.geometry.getAttribute(`headPainterGrid${pair}`) as BufferAttribute, slot * 4,
                    [first[0], first[1], second[0], second[1]]);
                write(lines.geometry.getAttribute(`headPainterTexture${pair}`) as BufferAttribute, slot * 4,
                    [first[2], first[3], second[2], second[3]]);
            }
        }
    }
    for (const attribute of changed) attribute.needsUpdate = true;
    for (const child of headPainterGridOverlay.children) ((child as InstancedMesh).material as MeshBasicNodeMaterial).color.setHex(color);
    headPainterGridDirty = false;
    _headGridDragMatrix.copy(dragDeltaMatrix);
}

function createHeadPainterGridGeometry(capacity: number): BufferGeometry {
    const positions: number[] = [], horizontal: number[] = [], vertical: number[] = [], lines: number[] = [];
    for (let face = 0; face < 6; face++) {
        const [origin, h, v] = getHeadPainterFaceAxes(face, 1);
        for (let axis = 0; axis < 2; axis++) for (let line = 0; line <= 8; line++) for (let end = 0; end < 2; end++) {
            positions.push(...origin.toArray()); horizontal.push(...h.toArray()); vertical.push(...v.toArray());
            lines.push(face, line, axis, end);
        }
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
    geometry.setAttribute('headPainterGridHorizontal', new Float32BufferAttribute(horizontal, 3));
    geometry.setAttribute('headPainterGridVertical', new Float32BufferAttribute(vertical, 3));
    geometry.setAttribute('headPainterGridLine', new Float32BufferAttribute(lines, 4));
    for (let pair = 0; pair < 3; pair++) geometry.setAttribute(`headPainterGrid${pair}`,
        new InstancedBufferAttribute(new Float32Array(capacity * 4), 4).setUsage(DynamicDrawUsage));
    for (let pair = 0; pair < 3; pair++) geometry.setAttribute(`headPainterTexture${pair}`,
        new InstancedBufferAttribute(new Float32Array(capacity * 4), 4).setUsage(DynamicDrawUsage));
    geometry.setAttribute('headPainterGridScale', new InstancedBufferAttribute(new Float32Array(capacity), 1).setUsage(DynamicDrawUsage));
    return geometry;
}

export function removeHeadPainterGridOverlay(): void {
    if (headPainterGridOverlay) {
        headPainterGridOverlay.removeFromParent();
        const geometries = new Set<BufferGeometry>();
        const materials = new Set<Material>();
        headPainterGridOverlay.traverse(object => {
            const mesh = object as InstancedMesh;
            if (!mesh.isInstancedMesh) return;
            mesh.dispose();
            geometries.add(mesh.geometry);
            const meshMaterials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
            meshMaterials.forEach(material => materials.add(material));
        });
        geometries.forEach(geometry => geometry.dispose());
        materials.forEach(material => material.dispose());
        headPainterGridOverlay = null;
    }
    headPainterGridDirty = true;
}

export function getHeadPainterFaceAxes(face: number, scale: number): [Vector3, Vector3, Vector3] {
    const half = scale / 2;
    const bottom = -0.5 - half;
    const top = -0.5 + half;
    switch (face) {
        case 0: return [new Vector3(half, bottom, half), new Vector3(0, 0, -scale), new Vector3(0, scale, 0)];
        case 1: return [new Vector3(-half, bottom, -half), new Vector3(0, 0, scale), new Vector3(0, scale, 0)];
        case 2: return [new Vector3(half, top, -half), new Vector3(-scale, 0, 0), new Vector3(0, 0, scale)];
        case 3: return [new Vector3(half, bottom, -half), new Vector3(-scale, 0, 0), new Vector3(0, 0, scale)];
        case 4: return [new Vector3(-half, bottom, half), new Vector3(scale, 0, 0), new Vector3(0, scale, 0)];
        case 5: return [new Vector3(half, bottom, -half), new Vector3(-scale, 0, 0), new Vector3(0, scale, 0)];
        default: throw new RangeError(`Invalid head face: ${face}`);
    }
}

export function updateHeadPainterStampPreview(
    scene: Scene,
    hits: Array<{ mesh: InstancedMesh; instanceId: number; face: number; layer: 0 | 1; x: number; y: number; columns: number; rows: number; textureWidth?: number; textureHeight?: number }>
): void {
    if (!hits.length) return hideHeadPainterStampPreview();
    const faces = new Map<InstancedMesh, Map<number, { hit: typeof hits[number]; low: number; high: number }>>();
    let count = 0;
    for (const hit of hits) {
        let meshFaces = faces.get(hit.mesh);
        if (!meshFaces) faces.set(hit.mesh, meshFaces = new Map());
        const key = hit.instanceId * 12 + hit.face * 2 + hit.layer;
        let face = meshFaces.get(key);
        if (!face) {
            meshFaces.set(key, face = { hit, low: 0, high: 0 });
            count++;
        }
        const bit = hit.y * 8 + hit.x;
        if (bit < 32) face.low = (face.low | (1 << bit)) >>> 0;
        else face.high = (face.high | (1 << (bit - 32))) >>> 0;
    }
    if (!headPainterStampPreview || headPainterStampPreview.instanceMatrix.count < count) {
        const capacity = Math.max(count, (headPainterStampPreview?.instanceMatrix.count ?? 0) * 2, 16);
        const geometry = new PlaneGeometry(1, 1);
        geometry.setAttribute('headPainterGrid', new InstancedBufferAttribute(new Float32Array(capacity * 2), 2).setUsage(DynamicDrawUsage));
        geometry.setAttribute('headPainterTextureSize', new InstancedBufferAttribute(new Float32Array(capacity * 2), 2).setUsage(DynamicDrawUsage));
        geometry.setAttribute('headPainterCells', new InstancedBufferAttribute(new Uint32Array(capacity * 2), 2).setUsage(DynamicDrawUsage));
        if (headPainterStampPreview) {
            headPainterStampPreview.dispose();
            headPainterStampPreview.geometry.dispose();
            headPainterStampPreview.geometry = geometry;
        } else {
            headPainterStampPreview = new InstancedMesh(geometry, createHeadPainterPreviewMaterial(undefined, attribute('headPainterTextureSize', 'vec2')), capacity);
            headPainterStampPreview.name = 'head-painter-stamp-preview';
            headPainterStampPreview.renderOrder = 2000;
            headPainterStampPreview.frustumCulled = false;
            scene.add(headPainterStampPreview);
        }
        headPainterStampPreview.instanceMatrix = new StorageInstancedBufferAttribute(new Float32Array(capacity * 16), 16).setUsage(DynamicDrawUsage);
    }
    headPainterStampPreview.visible = true;
    headPainterStampPreview.count = count;
    const grid = headPainterStampPreview.geometry.getAttribute('headPainterGrid') as InstancedBufferAttribute;
    const textureSize = headPainterStampPreview.geometry.getAttribute('headPainterTextureSize') as InstancedBufferAttribute;
    const cells = headPainterStampPreview.geometry.getAttribute('headPainterCells') as InstancedBufferAttribute;
    const matrices = headPainterStampPreview.instanceMatrix.array as Float32Array;
    const packedMatrix = new Float32Array(16);
    const matrix = new Matrix4();
    const faceMatrix = new Matrix4();
    let index = 0;
    let updateStart = count;
    let updateEnd = 0;
    for (const meshFaces of faces.values()) for (const { hit, low, high } of meshFaces.values()) {
        hit.mesh.getMatrixAt(hit.instanceId, matrix);
        matrix.premultiply(hit.mesh.matrixWorld);
        if (hit.mesh.geometry.getAttribute(dragSelectedAttributeName)?.getX(hit.instanceId)) matrix.premultiply(dragDeltaMatrix);
        const [origin, horizontal, vertical] = getHeadPainterFaceAxes(hit.face, (hit.layer ? 1.0625 : 1) * 1.006);
        faceMatrix.makeBasis(horizontal, vertical, horizontal.clone().cross(vertical).normalize());
        faceMatrix.setPosition(origin.addScaledVector(horizontal, 0.5).addScaledVector(vertical, 0.5));
        matrix.multiply(faceMatrix).toArray(packedMatrix);
        if (grid.getX(index) !== hit.columns || grid.getY(index) !== hit.rows
            || textureSize.getX(index) !== (hit.textureWidth ?? 8) || textureSize.getY(index) !== (hit.textureHeight ?? 8)
            || cells.getX(index) !== low || cells.getY(index) !== high
            || packedMatrix.some((value, component) => value !== matrices[index * 16 + component])) {
            matrices.set(packedMatrix, index * 16);
            grid.setXY(index, hit.columns, hit.rows);
            textureSize.setXY(index, hit.textureWidth ?? 8, hit.textureHeight ?? 8);
            cells.setXY(index, low, high);
            updateStart = Math.min(updateStart, index);
            updateEnd = index + 1;
        }
        index++;
    }
    if (updateEnd > updateStart) for (const buffer of [headPainterStampPreview.instanceMatrix, grid, textureSize, cells]) {
        let start = updateStart * buffer.itemSize;
        let end = updateEnd * buffer.itemSize;
        // Preserve changes still awaiting consumption by WebGPU.
        for (const range of buffer.updateRanges) {
            start = Math.min(start, range.start);
            end = Math.max(end, range.start + range.count);
        }
        buffer.clearUpdateRanges();
        buffer.addUpdateRange(start, end - start);
        buffer.needsUpdate = true;
    }
}

export function hideHeadPainterStampPreview(): void {
    if (headPainterStampPreview) headPainterStampPreview.visible = false;
}

export function removeHeadPainterStampPreview(): void {
    if (!headPainterStampPreview) return;
    headPainterStampPreview.removeFromParent();
    headPainterStampPreview.dispose();
    headPainterStampPreview.geometry.dispose();
    (headPainterStampPreview.material as MeshBasicNodeMaterial).dispose();
    headPainterStampPreview = null;
}

let selectionOverlay: InstancedMesh | null = null;
let selectionPointsOverlay: Group | null = null;
let multiSelectionOverlay: Group | null = null;
let hoveredVertex: Sprite | null = null;

export function updateSelectionOverlayObject(mesh: PdeMesh, instanceId: number): void {
    const index = (selectionOverlay?.userData['objectIndexes'] as Map<string, number> | undefined)
        ?.get(`${mesh.uuid}:${instanceId}`);
    if (index === undefined || !selectionOverlay) return;
    const box = getInstanceLocalBox(mesh, instanceId);
    if (!box) return;

    box.getCenter(_TMP_VEC3_A);
    box.getSize(_TMP_VEC3_B);
    getInstanceWorldMatrix(mesh, instanceId, _TMP_MAT4_A);
    _TMP_MAT4_C.makeTranslation(_TMP_VEC3_A.x, _TMP_VEC3_A.y, _TMP_VEC3_A.z)
        .scale(_TMP_VEC3_B)
        .premultiply(_TMP_MAT4_A);
    selectionOverlay.setMatrixAt(index, _TMP_MAT4_C);
    selectionOverlay.instanceMatrix.addUpdateRange(index * 16, 16);
    selectionOverlay.instanceMatrix.needsUpdate = true;

    const item = (selectionOverlay.userData['items'] as OverlayItem[])[index];
    item.matrix.copy(_TMP_MAT4_C);
    item.source.cachedLocalCenter?.copy(_TMP_VEC3_A);
    item.source.cachedLocalSize?.copy(_TMP_VEC3_B);
    // ponytail: the aggregate box catches up on the next full selection refresh; per-key rebuilds must stay O(1).
}

function setBoxLineTransform(line: LineSegments, box: Box3): void {
    box.getCenter(line.position);
    box.getSize(line.scale);
    line.updateMatrix();
}

export function getSelectionPointsOverlay(): Group | null {
    return selectionPointsOverlay;
}

export function updateSelectionOverlay(
    scene: Scene, 
    renderer: Renderer, 
    camera: Camera, 
    currentSelection: SelectionState, 
    vertexQueue: QueueItem[], 
    isVertexMode: boolean, 
    selectionHelper: Mesh,
    selectedVertexKeys: Set<string>
): void {
    if (selectionOverlay) {
        scene.remove(selectionOverlay);
        selectionOverlay.dispose();
        selectionOverlay = null;
    }

    if (selectionPointsOverlay) {
        scene.remove(selectionPointsOverlay);
        const hoverLine = selectionPointsOverlay.getObjectByName('VertexHoverLine') as Line | undefined;
        hoverLine?.geometry.dispose();
        (hoverLine?.material as Material | undefined)?.dispose();
        selectionPointsOverlay = null;
        hoveredVertex = null;
    }

    if (multiSelectionOverlay) {
        scene.remove(multiSelectionOverlay);
        multiSelectionOverlay = null;
    }

    const hasAnySelection = (currentSelection.groups && currentSelection.groups.size > 0) || (currentSelection.objects && currentSelection.objects.size > 0);
    if (!hasAnySelection && vertexQueue.length === 0) return;

    const itemsToRender: OverlayItem[] = [];
    const tempCenter = _TMP_VEC3_A;
    const tempSize = _TMP_VEC3_B;
    
    if (currentSelection.groups) {
        for (const groupId of currentSelection.groups) {
            const localBox = getGroupLocalBoundingBox(groupId);
            if (!localBox || localBox.isEmpty()) continue;
            localBox.getSize(tempSize);
            localBox.getCenter(tempCenter);
            const groupWorld = getGroupWorldMatrixWithFallback(groupId, new Matrix4());
            const instanceMat = new Matrix4().makeTranslation(tempCenter.x, tempCenter.y, tempCenter.z).scale(tempSize).premultiply(groupWorld);
            itemsToRender.push({ matrix: instanceMat, color: 0x6FA21C, source: { type: 'group', id: groupId, cachedLocalCenter: tempCenter.clone(), cachedLocalSize: tempSize.clone() } });
        }
    }

    if (currentSelection.objects) {
        for (const [mesh, ids] of currentSelection.objects) {
            for (const id of ids) {
                const localBox = getInstanceLocalBox(mesh, id);
                if (!localBox) continue;
                localBox.getSize(tempSize);
                localBox.getCenter(tempCenter);
                const objTempMat = new Matrix4();
                getInstanceWorldMatrix(mesh, id, objTempMat);
                const instanceMat = new Matrix4().makeTranslation(tempCenter.x, tempCenter.y, tempCenter.z).scale(tempSize).premultiply(objTempMat);
                const color = getDisplayOverlayColor(getDisplayType(mesh, id));
                itemsToRender.push({ matrix: instanceMat, color: color, source: { type: 'object', mesh, instanceId: id, cachedLocalCenter: tempCenter.clone(), cachedLocalSize: tempSize.clone() } });
            }
        }
    }

    const queueItemsToRender: OverlayItem[] = [];
    const groups = getGroups();
    const processQueueItem = (item: QueueItem) => {
        if (item.type === 'bundle' && item.items) {
            item.items.forEach(processQueueItem);
            return;
        }
        let isSelected = false;
        if (item.type === 'group' && item.id) {
            if (currentSelection.groups.has(item.id)) isSelected = true;
        } else if (item.type === 'object' && item.mesh && item.instanceId !== undefined) {
            if (currentSelection.objects.has(item.mesh) && currentSelection.objects.get(item.mesh)!.has(item.instanceId)) isSelected = true;
        }
        if (isSelected) return;

        if (item.type === 'group' && item.id) {
            if (!groups.has(item.id)) return;
            const localBox = getGroupLocalBoundingBox(item.id);
            if (!localBox.isEmpty()) {
                localBox.getSize(tempSize);
                localBox.getCenter(tempCenter);
                const groupWorld = getGroupWorldMatrixWithFallback(item.id, new Matrix4());
                const instanceMat = new Matrix4().makeTranslation(tempCenter.x, tempCenter.y, tempCenter.z).scale(tempSize).premultiply(groupWorld);
                let gPos = item.gizmoLocalPosition ? item.gizmoLocalPosition.clone().applyMatrix4(groupWorld) : undefined;
                let gQuat = item.gizmoLocalQuaternion && gPos ? getRotationFromMatrix(groupWorld).multiply(item.gizmoLocalQuaternion) : undefined;
                queueItemsToRender.push({ matrix: instanceMat, color: 0x6FA21C, source: { type: 'group', id: item.id }, gizmoPosition: gPos, gizmoQuaternion: gQuat, gizmoLocalPosition: item.gizmoLocalPosition });
            }
        } else if (item.type === 'object' && item.mesh && item.instanceId !== undefined) {
            const localBox = getInstanceLocalBox(item.mesh, item.instanceId);
            if (localBox) {
                localBox.getSize(tempSize);
                localBox.getCenter(tempCenter);
                const worldMat = getInstanceWorldMatrix(item.mesh, item.instanceId, new Matrix4());
                const instanceMat = new Matrix4().makeTranslation(tempCenter.x, tempCenter.y, tempCenter.z).scale(tempSize).premultiply(worldMat);
                let gPos = item.gizmoLocalPosition ? item.gizmoLocalPosition.clone().applyMatrix4(worldMat) : undefined;
                let gQuat = item.gizmoLocalQuaternion && gPos ? getRotationFromMatrix(worldMat).multiply(item.gizmoLocalQuaternion) : undefined;
                const color = getDisplayOverlayColor(getDisplayType(item.mesh, item.instanceId));
                queueItemsToRender.push({ matrix: instanceMat, color, source: { type: 'object', mesh: item.mesh, instanceId: item.instanceId }, gizmoPosition: gPos, gizmoQuaternion: gQuat, gizmoLocalPosition: item.gizmoLocalPosition });
            }
        }
    };
    vertexQueue.forEach(processQueueItem);

    const allOverlayItems = [...itemsToRender, ...queueItemsToRender];

    if (allOverlayItems.length > 0) {
        const dragSelected = new InstancedBufferAttribute(new Float32Array(allOverlayItems.length), 1);
        dragSelected.array.fill(1, 0, itemsToRender.length);
        _overlayUnitGeo.setAttribute(dragSelectedAttributeName, dragSelected);
        selectionOverlay = new InstancedMesh(_overlayUnitGeo, _selectionOverlayMat, allOverlayItems.length);
        selectionOverlay.instanceMatrix = new StorageInstancedBufferAttribute(allOverlayItems.length, 16);
        selectionOverlay.renderOrder = 1;
        selectionOverlay.matrixAutoUpdate = false;
        selectionOverlay.frustumCulled = false;
        selectionOverlay.userData['items'] = allOverlayItems;
        selectionOverlay.userData['selectedCount'] = itemsToRender.length;
        selectionOverlay.userData['objectIndexes'] = new Map(allOverlayItems.flatMap((item, index) =>
            item.source.type === 'object' && item.source.mesh && item.source.instanceId !== undefined
                ? [[`${item.source.mesh.uuid}:${item.source.instanceId}`, index] as const]
                : []
        ));
        const colorObj = new Color();
        allOverlayItems.forEach((item, index) => {
            selectionOverlay!.setMatrixAt(index, item.matrix);
            colorObj.setHex(item.color);
            selectionOverlay!.setColorAt(index, colorObj);
        });
        scene.add(selectionOverlay);
    }

    if (allOverlayItems.length > 0 && isVertexMode) {
        selectionPointsOverlay = new Group();
        selectionPointsOverlay.renderOrder = 999;
        selectionPointsOverlay.matrixAutoUpdate = false;
        
        const canvas = renderer.domElement;
        const width = canvas.clientWidth, height = canvas.clientHeight;
        const scaleX = 10 / width, scaleY = 10 / height;
        const v = new Vector3();
        const existingPoints = new Set<string>();

        for (const item of allOverlayItems) {
            for (const corner of _unitCubeCorners) {
                v.copy(corner).applyMatrix4(item.matrix);
                const key = `${v.x.toFixed(4)}_${v.y.toFixed(4)}_${v.z.toFixed(4)}`;
                if (existingPoints.has(key)) continue;
                existingPoints.add(key);
                const sprite = new Sprite(selectedVertexKeys.has(key) ? _selectedVertexSpriteMat : _vertexSpriteMat);
                sprite.position.copy(v);
                sprite.userData = { key, source: item.source };
                sprite.scale.set(scaleX, scaleY, 1);
                selectionPointsOverlay.add(sprite);
            }
        }

        if (selectionHelper) {
            const gizmoPos = selectionHelper.position;
            const centerKey = `CENTER_${gizmoPos.x.toFixed(4)}_${gizmoPos.y.toFixed(4)}_${gizmoPos.z.toFixed(4)}`;
            const centerSprite = new Sprite(selectedVertexKeys.has(centerKey) ? _selectedVertexSpriteMat : _vertexSpriteMat);
            centerSprite.position.copy(gizmoPos);
            centerSprite.userData = { isCenter: true, key: centerKey };
            centerSprite.scale.set(scaleX, scaleY, 1);
            centerSprite.renderOrder = 110;
            selectionPointsOverlay.add(centerSprite);

            const createAxisHelper = (pos: Vector3, quat: Quaternion) => {
                const axes = new LineSegments(_axisUnitGeo, _axisMat);
                axes.position.copy(pos);
                axes.quaternion.copy(quat);
                axes.renderOrder = 100

                // Set initial scale immediately to prevent jump/flicker on load
                const distance = pos.distanceTo(camera.position);
                const initialScale = distance * 0.15;
                axes.scale.set(initialScale, initialScale, initialScale);
                axes.updateMatrix();

                axes.onBeforeRender = function(this: LineSegments, _renderer, _scene, cam) {
                    const d = this.getWorldPosition(_TMP_VEC3_A).distanceTo(cam.position);
                    const s = d * 0.15; 
                    this.scale.set(s, s, s);
                    this.updateMatrix();
                };
                return axes;
            };

            queueItemsToRender.forEach(item => {
                if (item.gizmoPosition) {
                    const posForKey = item.gizmoLocalPosition || item.gizmoPosition;
                    const centerPosKey = `CENTER_QUEUE_${item.gizmoPosition.x.toFixed(4)}_${item.gizmoPosition.y.toFixed(4)}_${item.gizmoPosition.z.toFixed(4)}`;
                    if (existingPoints.has(centerPosKey)) return;
                    existingPoints.add(centerPosKey);

                    const queueSprite = new Sprite(_vertexSpriteMat);
                    queueSprite.position.copy(item.gizmoPosition);
                    const src = item.source;
                    const idStr = src.type === 'group' ? `G_${src.id}` : `O_${src.mesh!.uuid}_${src.instanceId}`;
                    const qKey = `QUEUE_${idStr}_${posForKey.x.toFixed(4)}_${posForKey.y.toFixed(4)}_${posForKey.z.toFixed(4)}`;
                    queueSprite.userData = { isCenter: true, key: qKey, source: src };
                    if (selectedVertexKeys.has(qKey)) queueSprite.material = _selectedVertexSpriteMat;
                    queueSprite.scale.set(scaleX, scaleY, 1);
                    queueSprite.renderOrder = 110;
                    selectionPointsOverlay!.add(queueSprite);
                    if (item.gizmoQuaternion) selectionPointsOverlay!.add(createAxisHelper(item.gizmoPosition, item.gizmoQuaternion));
                }
            });
            selectionPointsOverlay.add(createAxisHelper(gizmoPos, selectionHelper.quaternion));
        }
        scene.add(selectionPointsOverlay);
    }

    const boxesToDraw: Box3[] = [];
    if (_getSelectedObjectCount(currentSelection) + (currentSelection.groups?.size || 0) > 1) {
        boxesToDraw.push(getSelectionBoundingBox(currentSelection));
    }
    vertexQueue.forEach(qItem => {
        if (qItem.type === 'bundle' && qItem.items && qItem.items.length > 1) {
            const bundleBox = new Box3();
            qItem.items.forEach(sub => {
                let localBox: Box3 | null = null, worldMat = new Matrix4();
                if (sub.type === 'group' && sub.id) { localBox = getGroupLocalBoundingBox(sub.id); getGroupWorldMatrixWithFallback(sub.id, worldMat); }
                else if (sub.type === 'object' && sub.mesh && sub.instanceId !== undefined) { localBox = getInstanceLocalBox(sub.mesh, sub.instanceId); getInstanceWorldMatrix(sub.mesh, sub.instanceId, worldMat); }
                if (localBox && !localBox.isEmpty()) bundleBox.union(_TMP_BOX3_A.copy(localBox).applyMatrix4(worldMat));
            });
            if (!bundleBox.isEmpty()) boxesToDraw.push(bundleBox);
        }
    });

    if (boxesToDraw.length > 0) {
        multiSelectionOverlay = new Group();
        multiSelectionOverlay.matrixAutoUpdate = false;
        boxesToDraw.forEach(box => {
            const line = new LineSegments(_boxEdgesGeo, _multiSelectionMat);
            line.matrixAutoUpdate = false;
            setBoxLineTransform(line, box);
            multiSelectionOverlay!.add(line);
        });
        scene.add(multiSelectionOverlay);
    }
}

export function updateMultiSelectionOverlayDuringDrag(currentSelection: SelectionState, currentGizmoMat: Matrix4 | null, initialGizmoMat: Matrix4 | null): void {
    if (!multiSelectionOverlay) return;
    const activeBoxLine = multiSelectionOverlay.children[0] as LineSegments;
    if (!activeBoxLine) return;
    if (_getSelectedObjectCount(currentSelection) + (currentSelection.groups?.size || 0) <= 1) { activeBoxLine.visible = false; return; }
    activeBoxLine.visible = true;

    if (currentGizmoMat && initialGizmoMat) {
        const tMat = _TMP_MAT4_C.copy(initialGizmoMat).invert().premultiply(currentGizmoMat);
        const e = tMat.elements;
        const axesStayAligned = Math.abs(e[1]) < 1e-10 && Math.abs(e[2]) < 1e-10
            && Math.abs(e[4]) < 1e-10 && Math.abs(e[6]) < 1e-10
            && Math.abs(e[8]) < 1e-10 && Math.abs(e[9]) < 1e-10;
        if (axesStayAligned) {
            activeBoxLine.matrix.multiplyMatrices(tMat, _dragInitialOverlayMatrix);
            activeBoxLine.matrixWorldNeedsUpdate = true;
            return;
        }

        const worldBox = _TMP_BOX3_A.makeEmpty();
        if (_dragBoundsHullPoints.length > 0) {
            for (const point of _dragBoundsHullPoints) worldBox.expandByPoint(_TMP_VEC3_A.copy(point).applyMatrix4(tMat));
        } else {
            worldBox.copy(getSelectionBoundingBox(currentSelection, tMat));
        }
        if (!worldBox.isEmpty()) setBoxLineTransform(activeBoxLine, worldBox);
        return;
    }

    const worldBox = _TMP_BOX3_A.copy(getSelectionBoundingBox(currentSelection));
    if (worldBox.isEmpty()) return;
    setBoxLineTransform(activeBoxLine, worldBox);
}

export function syncSelectionPointsOverlay(delta: Vector3): void {
    if (selectionPointsOverlay) { selectionPointsOverlay.position.add(delta); selectionPointsOverlay.updateMatrixWorld(true); }
}

export function syncSelectionOverlay(deltaMatrix: Matrix4): void {
    if (selectionPointsOverlay) { selectionPointsOverlay.applyMatrix4(deltaMatrix); selectionPointsOverlay.updateMatrixWorld(true); }
}

export function commitSelectionOverlay(deltaMatrix: Matrix4, currentSelection: SelectionState): void {
    if (selectionOverlay) {
        const selectedCount = Math.min(selectionOverlay.count, (selectionOverlay.userData['selectedCount'] as number | undefined) ?? selectionOverlay.count);
        for (let i = 0; i < selectedCount; i++) {
            selectionOverlay.getMatrixAt(i, _TMP_MAT4_A);
            selectionOverlay.setMatrixAt(i, _TMP_MAT4_A.premultiply(deltaMatrix));
        }
        selectionOverlay.instanceMatrix.needsUpdate = true;
    }

    const activeBoxLine = multiSelectionOverlay?.children[0] as LineSegments | undefined;
    if (activeBoxLine) {
        const finalBox = getSelectionBoundingBox(currentSelection);
        if (!finalBox.isEmpty()) setBoxLineTransform(activeBoxLine, finalBox);
    }
    _dragBoundsHullPoints = [];
}

export function findClosestVertexForSnapping(gizmoWorldPos: Vector3, camera: Camera, renderer: Renderer, snapThreshold = 15): Vector3 | null {
    if (!selectionPointsOverlay) return null;
    const rect = renderer.domElement.getBoundingClientRect();
    const gScreen = _TMP_VEC3_B.copy(gizmoWorldPos).project(camera);
    const gx = (gScreen.x * 0.5 + 0.5) * rect.width, gy = (1 - (gScreen.y * 0.5 + 0.5)) * rect.height;
    let minDSq = snapThreshold * snapThreshold, target: Vector3 | null = null;
    selectionPointsOverlay.children.forEach(c => {
        if (!(c as Sprite).isSprite || c.userData['isCenter']) return;
        const vS = _TMP_VEC3_A.copy(c.position).project(camera);
        const vx = (vS.x * 0.5 + 0.5) * rect.width, vy = (1 - (vS.y * 0.5 + 0.5)) * rect.height;
        const dSq = (vx-gx)**2 + (vy-gy)**2;
        if (dSq < minDSq) { minDSq = dSq; target = c.position; }
    });
    return target;
}

export function getHoveredVertex(mouseNDC: Vector2, camera: Camera, renderer: Renderer): Sprite | null {
    if (!selectionPointsOverlay) return null;
    const canvas = renderer.domElement;
    const mx = (mouseNDC.x * 0.5 + 0.5) * canvas.clientWidth, my = (-mouseNDC.y * 0.5 + 0.5) * canvas.clientHeight;
    let bestDSq = 100, best: Sprite | null = null;
    selectionPointsOverlay.children.forEach(s => {
        if (!(s as Sprite).isSprite) return;
        const vS = _TMP_VEC3_A.copy(s.position).project(camera);
        if (vS.z < -1 || vS.z > 1) return;
        const sx = (vS.x * 0.5 + 0.5) * canvas.clientWidth, sy = (-vS.y * 0.5 + 0.5) * canvas.clientHeight;
        const dSq = (sx-mx)**2 + (sy-my)**2;
        if (dSq < bestDSq) { bestDSq = dSq; best = s as Sprite; }
    });
    return best;
}

export function updateVertexHoverHighlight(hoveredSprite: Sprite | null, selectedVertexKeys: Set<string>): void {
    if (!selectionPointsOverlay || hoveredSprite === hoveredVertex) return;
    hoveredVertex = hoveredSprite;
    let selected: Sprite | null = null, existingLine: Line | null = null;
    selectionPointsOverlay.children.forEach(c => {
        if (c.name === 'VertexHoverLine') { existingLine = c as Line; return; }
        if (!(c as Sprite).isSprite) return;
        const s = c as Sprite, key = s.userData['key'] as string | undefined;
        const isSel = key && selectedVertexKeys.has(key);
        if (isSel) selected = s;
        s.material = s === hoveredSprite || isSel ? _selectedVertexSpriteMat : _vertexSpriteMat;
    });
    if (selectedVertexKeys.size === 1 && hoveredSprite && selected && hoveredSprite !== selected) {
        if (!existingLine) {
            const l = new Line(new BufferGeometry().setFromPoints([selected.position, hoveredSprite.position]), new LineBasicMaterial({ color: 0x437FD0, depthTest: false, transparent: true }));
            l.name = 'VertexHoverLine'; selectionPointsOverlay.add(l);
        } else existingLine.geometry.setFromPoints([selected.position, hoveredSprite.position]);
    } else if (existingLine) { selectionPointsOverlay.remove(existingLine); existingLine.geometry.dispose(); (existingLine.material as Material).dispose(); }
}

export function findSpritesByKeys(keys: string[]): Record<string, Sprite> {
    const res: Record<string, Sprite> = {}, set = new Set(keys);
    selectionPointsOverlay?.children.forEach(c => { if ((c as Sprite).isSprite && c.userData['key'] && set.has(c.userData['key'])) res[c.userData['key'] as string] = c as Sprite; });
    return res;
}

export function refreshSelectionPointColors(selectedVertexKeys: Set<string>): void {
    hoveredVertex = null;
    const hoverLine = selectionPointsOverlay?.getObjectByName('VertexHoverLine') as Line | undefined;
    if (hoverLine) {
        selectionPointsOverlay!.remove(hoverLine);
        hoverLine.geometry.dispose();
        (hoverLine.material as Material).dispose();
    }
    selectionPointsOverlay?.children.forEach(s => { if ((s as Sprite).isSprite && s.userData['key']) (s as Sprite).material = selectedVertexKeys.has(s.userData['key'] as string) ? _selectedVertexSpriteMat : _vertexSpriteMat; });
}
