import {
    Object3D,
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
    InterleavedBuffer,
    InterleavedBufferAttribute,
    StorageBufferAttribute,
    LineBasicNodeMaterial,
    SpriteNodeMaterial,
    EdgesGeometry,
    BoxGeometry,
    PlaneGeometry,
    DynamicDrawUsage,
    Material,
    MeshBasicNodeMaterial,
    Scene,
    Renderer,
    Camera,
    Vector2
} from 'three/webgpu';
import { Fn, attribute, cameraPosition, color, mix, modelWorldMatrix, positionLocal, uniform, vec4, vertexStage } from 'three/tsl';
import { createHeadPainterGridMaterial, createHeadPainterPreviewMaterial } from './head-painter-gpu-preview';
import { OverlayBatch, overlayInstance } from '../../gpu-draw/overlay-batch';
import * as GroupUtils from '../grouping/group';
import { decomposeDisplayMatrix } from '../../animation/display-transformation';
import type { AnimationMeshPreview } from '../../animation/animation-mesh-preview';
import type { GroupObjectSlot } from '../grouping/group';
import { dragDeltaMatrix, dragPreviewPosition, dragSelectedAttributeName, entityVisibleAttributeName } from '../../entity-material';
import { transformInstanceRange } from './instance-ranges';
import { getBatchMatrixVersion, getDisplayType, getInstanceCount, getInstanceHasHat, getInstanceLocalBox, getInstanceLocalBoxMin, getInstanceLocalOriginOffset, getInstanceValue,
    getInstanceValueVersion, getInstanceWorldMatrix, getInstanceWorldMatrixForOrigin, hasHatAttributeName, instanceValueSize, isInstanceValid, isItemDisplayHatEnabled,
    objectBatches, objectRef, objectSlots, objectUuidAt, type ObjectBatch, type ObjectRef } from '../../scene-store/object-access';

// --- Types & Interfaces ---


export interface SelectionState {
    groups: Set<string>;
    /** Object uuids. */
    objects: Set<string>;
}

export type QueueItemType = 'group' | 'object' | 'bundle';

export interface QueueItem {
    type: QueueItemType;
    id?: string;
    mesh?: ObjectBatch;
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
    mesh?: ObjectBatch;
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

/** A vertex-mode point, in the points overlay's space (moved by syncSelectionOverlay until the next rebuild). */
export interface OverlayPoint {
    position: Vector3;
    // Kept as loose as Sprite.userData was: the vertex tools pass `source` on as a SelectionSource.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    userData: { key: string; source?: any; isCenter?: boolean };
}

// --- Constants & Temporaries ---

const _TMP_MAT4_A = new Matrix4();
const _TMP_MAT4_C = new Matrix4();
const _TMP_MAT4_BOX = new Matrix4();
const _TMP_BOX3_A = new Box3();
const _TMP_VEC3_A = new Vector3();
const _TMP_VEC3_B = new Vector3();
const _TMP_COLOR = new Color();
const _IDENTITY_QUAT = new Quaternion();
const _UNIT_SCALE = new Vector3(1, 1, 1);

let loadedObjectGroup: Group | null = null;
const _dragInitialOverlayMatrix = new Matrix4();
const animationGroupBounds = new WeakMap<AnimationMeshPreview, Map<string, { box: Box3; matrices: Matrix4[] }>>();

export function setLoadedObjectGroup(group: Group | null): void {
    loadedObjectGroup = group;
}

/** A queued object's current slot (queue entries keep uuids). */
function queuedRef(entry: { type: string; id?: string }): ObjectRef | undefined {
    return entry.type === 'object' && entry.id && loadedObjectGroup ? objectRef(loadedObjectGroup, entry.id) : undefined;
}

function selectedSlots(uuids: Iterable<string>): Map<ObjectBatch, Set<number>> {
    return loadedObjectGroup ? objectSlots(loadedObjectGroup, uuids) : new Map();
}

/** The slot's object uuid, used for selection checks and vertex keys; the slot key when no object owns it. */
export function slotKeyUuid(mesh: ObjectBatch, instanceId: number): string {
    return (loadedObjectGroup && objectUuidAt(loadedObjectGroup, mesh, instanceId)) || `${mesh.uuid}_${instanceId}`;
}

function getGroups() {
    return GroupUtils.getGroups(loadedObjectGroup);
}

function getAllGroupChildren(groupId: string) {
    return GroupUtils.getAllGroupChildren(loadedObjectGroup, groupId);
}

// --- Geometry & Materials ---

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

// Axis helpers keep a constant on-screen size: scaled by their camera distance.
const _axisMat = new LineBasicNodeMaterial({
    vertexColors: true,
    depthTest: false,
    depthWrite: false,
    transparent: true
});
_axisMat.positionNode = Fn(() => {
    const matrix = overlayInstance('mat4');
    const scale = cameraPosition.distance(modelWorldMatrix.mul(matrix.element(3)).xyz).mul(0.15);
    return matrix.mul(vec4(positionLocal.mul(scale), 1)).xyz;
})();

const _boxEdgesGeo = (() => {
    const boxGeo = new BoxGeometry(1, 1, 1);
    const edgesGeo = new EdgesGeometry(boxGeo);
    boxGeo.dispose();
    return edgesGeo;
})();

/** Unit box edges with a color and drag flag per box, for `capacity` boxes (matrices are the batch instances). */
function createBoxOverlayGeometry(capacity: number): BufferGeometry {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', _boxEdgesGeo.getAttribute('position').clone());
    geometry.setAttribute('overlayColor', new InstancedBufferAttribute(new Float32Array(capacity * 3), 3));
    geometry.setAttribute(dragSelectedAttributeName, new InstancedBufferAttribute(new Float32Array(capacity), 1));
    return geometry;
}

const _boxOverlayMat = new LineBasicNodeMaterial({
    depthTest: true,
    depthWrite: false,
    transparent: true,
    opacity: 0.9
});
_boxOverlayMat.colorNode = vertexStage(attribute('overlayColor', 'vec3'));
_boxOverlayMat.positionNode = dragPreviewPosition(overlayInstance('mat4').mul(vec4(positionLocal, 1)).xyz);

// Points are vec4(position, highlighted) instances drawn at a fixed screen size.
const _pointScale = uniform(new Vector2());
const _pointMat = new SpriteNodeMaterial({
    sizeAttenuation: false,
    depthTest: false,
    depthWrite: false,
    transparent: true
});
_pointMat.positionNode = overlayInstance('vec4').xyz;
_pointMat.scaleNode = _pointScale;
_pointMat.colorNode = mix(color(0x30333D), color(0x437FD0), vertexStage(overlayInstance('vec4').w));

const _hoverLineMat = new LineBasicNodeMaterial({ color: 0x437FD0, depthTest: false, transparent: true });

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

export { getDisplayType, getInstanceCount, getInstanceLocalBox, getInstanceLocalBoxMin, getInstanceLocalOriginOffset, getInstanceWorldMatrix,
    getInstanceWorldMatrixForOrigin, isInstanceValid, isItemDisplayHatEnabled };

function getDisplayOverlayColor(displayType?: string): number {
    if (displayType === 'item_display') return 0x2E87EC;
    if (displayType === 'text_display') return 0xEF3751;
    return 0xFFD147;
}

export function calculateAvgOriginForChildren(children: readonly GroupObjectSlot[], out = new Vector3()): Vector3 {
    out.set(0, 0, 0);
    if (!Array.isArray(children) || children.length === 0) return out;

    const tempPos = _TMP_VEC3_A;
    const tempMat = _TMP_MAT4_A;

    children.forEach(child => {
        const m = child.mesh;
        const id = child.instanceId;
        if (!m) return;

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

    const preview = loadedObjectGroup?.userData.animationSession?.meshPreview as AnimationMeshPreview | undefined;
    let cache: Map<string, { box: Box3; matrices: Matrix4[] }> | undefined;
    const matrices: Matrix4[] = [];
    if (preview?.valid) {
        cache = animationGroupBounds.get(preview);
        if (!cache) animationGroupBounds.set(preview, cache = new Map());
        for (const state of preview.meshes.values()) {
            let parent = state.parent;
            while (parent && parent !== groupId) parent = preview.local.get(parent)?.parent;
            if (parent === groupId) matrices.push(new Matrix4().multiplyMatrices(groupInverse, state.mesh.matrixWorld));
        }
        const cached = cache.get(groupId);
        if (cached && matrices.length === cached.matrices.length && matrices.every((matrix, index) =>
            matrix.elements.every((value, axis) => Math.abs(value - cached.matrices[index].elements[axis]) <= 1e-10 * Math.max(1, Math.abs(value))))) {
            return cached.box.clone();
        }
    }
    const children = getAllGroupChildren(groupId);
    const box = new Box3();
    if (children.length === 0) return box;
    if (cache) {
        for (const [batch, ids] of childIdsByBatch(children)) unionBatchBounds(box, batch, ids, groupInverse);
        cache.set(groupId, { box: box.clone(), matrices });
        return box;
    }

    // Each batch's part is kept until the slots, the group transform or that batch's matrices or boxes change.
    let bounds = groupBounds.get(groupId);
    if (!bounds || bounds.children !== children || !bounds.inverse.equals(groupInverse)) {
        bounds = { children, inverse: groupInverse, ids: childIdsByBatch(children), parts: new Map() };
    }
    groupBounds.delete(groupId);
    groupBounds.set(groupId, bounds);
    if (groupBounds.size > maxCachedGroupBounds) groupBounds.delete(groupBounds.keys().next().value!);
    for (const [batch, ids] of bounds.ids) {
        const key = batchBoundsKey(batch);
        let part = bounds.parts.get(batch);
        if (part?.key !== key) bounds.parts.set(batch, part = { key, box: unionBatchBounds(new Box3(), batch, ids, groupInverse) });
        box.union(part.box);
    }
    return box;
}

type GroupBounds = { children: readonly GroupObjectSlot[]; inverse: Matrix4; ids: Map<ObjectBatch, number[]>; parts: Map<ObjectBatch, { key: string; box: Box3 }> };
const groupBounds = new Map<string, GroupBounds>();
const maxCachedGroupBounds = 8;
const _BOUNDS_LOCAL = new Box3();
const _BOUNDS_BATCH = new Matrix4();
const _BOUNDS_MATRIX = new Matrix4();

function childIdsByBatch(children: readonly GroupObjectSlot[]): Map<ObjectBatch, number[]> {
    const ids = new Map<ObjectBatch, number[]>();
    for (const { mesh, instanceId } of children) {
        let list = ids.get(mesh);
        if (!list) ids.set(mesh, list = []);
        list.push(instanceId);
    }
    return ids;
}

/** What a batch's part of a group box reads besides its slots: matrices, root transform, shape box and per-object box values. */
function batchBoundsKey(batch: ObjectBatch): string {
    const { geometry } = batch;
    if (!geometry.boundingBox) geometry.computeBoundingBox();
    const shape = geometry.boundingBox;
    // Row-stored batches share one version for all their values: text and head batches recompute on any row write.
    return `${getBatchMatrixVersion(batch)}|${batch.matrixWorld.elements.join()}|${geometry.id}|${shape ? `${shape.min.toArray()}|${shape.max.toArray()}` : ''}`
        + `|${getInstanceValueVersion(batch, 'textDisplayLayout')}|${getInstanceValueVersion(batch, hasHatAttributeName)}`;
}

/** Grows `box` by the given objects' boxes in the group's space (inverse = the group's inverse world matrix). */
function unionBatchBounds(box: Box3, batch: ObjectBatch, ids: readonly number[], inverse: Matrix4): Box3 {
    _BOUNDS_BATCH.multiplyMatrices(inverse, batch.matrixWorld);
    for (const id of ids) {
        const local = getInstanceLocalBox(batch, id, _BOUNDS_LOCAL);
        if (!local || local.isEmpty()) continue;
        const e = batch.getMatrixAt(id, _BOUNDS_MATRIX).premultiply(_BOUNDS_BATCH).elements;
        const cx = (local.min.x + local.max.x) * 0.5, cy = (local.min.y + local.max.y) * 0.5, cz = (local.min.z + local.max.z) * 0.5;
        const ex = (local.max.x - local.min.x) * 0.5, ey = (local.max.y - local.min.y) * 0.5, ez = (local.max.z - local.min.z) * 0.5;
        // An affine box's bounds: transformed center ± the absolute basis applied to the half extents.
        for (let axis = 0; axis < 3; axis++) {
            const center = e[axis] * cx + e[axis + 4] * cy + e[axis + 8] * cz + e[axis + 12];
            const radius = Math.abs(e[axis]) * ex + Math.abs(e[axis + 4]) * ey + Math.abs(e[axis + 8]) * ez;
            if (center - radius < box.min.getComponent(axis)) box.min.setComponent(axis, center - radius);
            if (center + radius > box.max.getComponent(axis)) box.max.setComponent(axis, center + radius);
        }
    }
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
    // Both SVD rotations contribute to the local frame when the matrix contains shear.
    const parts = decomposeDisplayMatrix(matrix.clone().transpose().elements);
    return new Quaternion().fromArray(parts.left_rotation)
        .multiply(new Quaternion().fromArray(parts.right_rotation)).normalize();
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
        for (const [mesh, ids] of selectedSlots(currentSelection.objects)) {
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
    return currentSelection.objects?.size ?? 0;
}

export function prepareMultiSelectionDrag(_currentSelection: SelectionState): void {
    if (selectionOverlay && multiBoxSlot >= 0) _dragInitialOverlayMatrix.fromArray(selectionOverlay.instances!.array, multiBoxSlot * 16);
}

function getSelectionOverlayBoundingBox(previewMatrix?: Matrix4): Box3 {
    const box = new Box3();
    if (!selectionOverlay) return box;
    const selectedCount = Math.min(selectionOverlay.count, (selectionOverlay.userData['selectedCount'] as number | undefined) ?? selectionOverlay.count);
    const matrices = selectionOverlay.instances!.array;
    const e = previewMatrix?.elements;
    for (let axis = 0; axis < 3; axis++) {
        const x = e ? e[axis] : Number(axis === 0);
        const y = e ? e[axis + 4] : Number(axis === 1);
        const z = e ? e[axis + 8] : Number(axis === 2);
        const w = e ? e[axis + 12] : 0;
        let min = Infinity, max = -Infinity;
        for (let i = 0; i < selectedCount * 16; i += 16) {
            const center = x * matrices[i + 12] + y * matrices[i + 13] + z * matrices[i + 14] + w * matrices[i + 15];
            // Unit cube half extents are the absolute sums of the transformed basis vectors.
            const radius = (Math.abs(x * matrices[i] + y * matrices[i + 1] + z * matrices[i + 2] + w * matrices[i + 3])
                + Math.abs(x * matrices[i + 4] + y * matrices[i + 5] + z * matrices[i + 6] + w * matrices[i + 7])
                + Math.abs(x * matrices[i + 8] + y * matrices[i + 9] + z * matrices[i + 10] + w * matrices[i + 11])) * 0.5;
            min = Math.min(min, center - radius);
            max = Math.max(max, center + radius);
        }
        box.min.setComponent(axis, min);
        box.max.setComponent(axis, max);
    }
    return box;
}

// --- Overlay State ---

const _headGridDragMatrix = new Matrix4();
const HEAD_GRID_INSTANCES_PER_CHUNK = 32768;
let headPainterGridOverlay: Group | null = null;
let headPainterStampPreview: OverlayBatch | null = null;
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
    objectGroup.updateMatrixWorld(true);
    const meshes = objectBatches(objectGroup).filter(batch => instanceValueSize(batch, 'headLayerVisible') > 0);
    if (!headPainterGridOverlay) {
        headPainterGridOverlay = new Group();
        headPainterGridOverlay.name = 'head-painter-grid';
        scene.add(headPainterGridOverlay);
    }
    headPainterGridOverlay.visible = true;
    for (const child of headPainterGridOverlay.children) (child as OverlayBatch).count = 0;
    const total = meshes.reduce((sum, mesh) => sum + getInstanceCount(mesh), 0);
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
        for (let instanceId = 0; instanceId < getInstanceCount(mesh); instanceId++) {
            if (getInstanceValue(mesh, instanceId, entityVisibleAttributeName) === 0) continue;
            const uuid = objectUuidAt(objectGroup, mesh, instanceId);
            if (!uuid) continue;
            const showLayer = layerMode === 'layer' || (layerMode === 'auto' && !!getInstanceHasHat(mesh, instanceId));
            const scale = showLayer ? 1.0625 : 1;
            getInstanceWorldMatrix(mesh, instanceId, worldMatrix);
            if (getInstanceValue(mesh, instanceId, dragSelectedAttributeName)) worldMatrix.premultiply(dragDeltaMatrix);
            let lines = headPainterGridOverlay.children[chunkIndex] as OverlayBatch;
            if (lines && lines.count === lines.instances!.count) lines = headPainterGridOverlay.children[++chunkIndex] as OverlayBatch;
            if (!lines) {
                const capacity = Math.min(Math.max(16, total), HEAD_GRID_INSTANCES_PER_CHUNK);
                const geometry = createHeadPainterGridGeometry(capacity);
                const material = (headPainterGridOverlay.children[0] as OverlayBatch)?.draw.material ?? createHeadPainterGridMaterial(color);
                lines = new OverlayBatch('lines', geometry, material,
                    new StorageBufferAttribute(new Float32Array(capacity * 16), 16).setUsage(DynamicDrawUsage));
                lines.renderOrder = 1000;
                headPainterGridOverlay.add(lines);
            }
            const slot = lines.count++;
            write(lines.instances!, slot * 16, worldMatrix.elements);
            write(lines.draw.geometry.getAttribute('headPainterGridScale') as BufferAttribute, slot, [scale]);
            for (let pair = 0; pair < 3; pair++) {
                const first = getFaceGridCounts(uuid, pair * 2, worldMatrix, showLayer ? 1 : 0);
                const second = getFaceGridCounts(uuid, pair * 2 + 1, worldMatrix, showLayer ? 1 : 0);
                write(lines.draw.geometry.getAttribute(`headPainterGrid${pair}`) as BufferAttribute, slot * 4,
                    [first[0], first[1], second[0], second[1]]);
                write(lines.draw.geometry.getAttribute(`headPainterTexture${pair}`) as BufferAttribute, slot * 4,
                    [first[2], first[3], second[2], second[3]]);
            }
        }
    }
    for (const attribute of changed) attribute.needsUpdate = true;
    for (const child of headPainterGridOverlay.children) ((child as OverlayBatch).draw.material as LineBasicNodeMaterial).color.setHex(color);
    headPainterGridDirty = false;
    _headGridDragMatrix.copy(dragDeltaMatrix);
}

function createHeadPainterGridGeometry(capacity: number): BufferGeometry {
    const vertices: number[] = [];
    for (let face = 0; face < 6; face++) {
        const [origin, h, v] = getHeadPainterFaceAxes(face, 1);
        for (let axis = 0; axis < 2; axis++) for (let line = 0; line <= 8; line++) for (let end = 0; end < 2; end++) {
            vertices.push(...origin.toArray(), ...h.toArray(), ...v.toArray(), face, line, axis, end);
        }
    }
    const geometry = new BufferGeometry();
    // Share static attributes to stay within WebGPU's eight vertex buffer limit.
    const buffer = new InterleavedBuffer(new Float32Array(vertices), 13);
    geometry.setAttribute('position', new InterleavedBufferAttribute(buffer, 3, 0));
    geometry.setAttribute('headPainterGridHorizontal', new InterleavedBufferAttribute(buffer, 3, 3));
    geometry.setAttribute('headPainterGridVertical', new InterleavedBufferAttribute(buffer, 3, 6));
    geometry.setAttribute('headPainterGridLine', new InterleavedBufferAttribute(buffer, 4, 9));
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
        const materials = new Set<Material>();
        for (const chunk of [...headPainterGridOverlay.children] as OverlayBatch[]) {
            materials.add(chunk.draw.material as Material);
            chunk.dispose();
        }
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
    hits: Array<{ mesh: ObjectBatch; instanceId: number; face: number; layer: 0 | 1; x: number; y: number; columns: number; rows: number; textureWidth?: number; textureHeight?: number }>
): void {
    if (!hits.length) return hideHeadPainterStampPreview();
    const faces = new Map<ObjectBatch, Map<number, { hit: typeof hits[number]; low: number; high: number }>>();
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
    if (!headPainterStampPreview || headPainterStampPreview.instances!.count < count) {
        const capacity = Math.max(count, (headPainterStampPreview?.instances!.count ?? 0) * 2, 16);
        const geometry = new PlaneGeometry(1, 1);
        geometry.setAttribute('headPainterGrid', new InstancedBufferAttribute(new Float32Array(capacity * 2), 2).setUsage(DynamicDrawUsage));
        geometry.setAttribute('headPainterTextureSize', new InstancedBufferAttribute(new Float32Array(capacity * 2), 2).setUsage(DynamicDrawUsage));
        geometry.setAttribute('headPainterCells', new InstancedBufferAttribute(new Uint32Array(capacity * 2), 2).setUsage(DynamicDrawUsage));
        const instances = new StorageBufferAttribute(new Float32Array(capacity * 16), 16).setUsage(DynamicDrawUsage);
        if (headPainterStampPreview) {
            headPainterStampPreview.draw.geometry.dispose();
            headPainterStampPreview.draw.geometry = geometry;
            headPainterStampPreview.instances!.dispose();
            headPainterStampPreview.instances = instances;
        } else {
            headPainterStampPreview = new OverlayBatch('triangles', geometry,
                createHeadPainterPreviewMaterial(undefined, attribute('headPainterTextureSize', 'vec2')), instances);
            headPainterStampPreview.name = 'head-painter-stamp-preview';
            headPainterStampPreview.renderOrder = 2000;
            scene.add(headPainterStampPreview);
        }
    }
    headPainterStampPreview.visible = true;
    headPainterStampPreview.count = count;
    const grid = headPainterStampPreview.draw.geometry.getAttribute('headPainterGrid') as InstancedBufferAttribute;
    const textureSize = headPainterStampPreview.draw.geometry.getAttribute('headPainterTextureSize') as InstancedBufferAttribute;
    const cells = headPainterStampPreview.draw.geometry.getAttribute('headPainterCells') as InstancedBufferAttribute;
    const matrices = headPainterStampPreview.instances!.array as Float32Array;
    const packedMatrix = new Float32Array(16);
    const matrix = new Matrix4();
    const faceMatrix = new Matrix4();
    let index = 0;
    let updateStart = count;
    let updateEnd = 0;
    for (const meshFaces of faces.values()) for (const { hit, low, high } of meshFaces.values()) {
        getInstanceWorldMatrix(hit.mesh, hit.instanceId, matrix);
        if (getInstanceValue(hit.mesh, hit.instanceId, dragSelectedAttributeName)) matrix.premultiply(dragDeltaMatrix);
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
    if (updateEnd > updateStart) for (const buffer of [headPainterStampPreview.instances!, grid, textureSize, cells]) {
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
    headPainterStampPreview.dispose();
    (headPainterStampPreview.draw.material as MeshBasicNodeMaterial).dispose();
    headPainterStampPreview = null;
}

let selectionOverlay: OverlayBatch | null = null;
let selectionPointsOverlay: Group | null = null;
let pointOverlay: OverlayBatch | null = null;
let axisOverlay: OverlayBatch | null = null;
let hoverLineOverlay: OverlayBatch | null = null;
/** Box slot of the multi-selection box, -1 without one (bundle boxes do not follow drags). */
let multiBoxSlot = -1;
let overlayPoints: OverlayPoint[] = [];
let hoveredVertex: OverlayPoint | null = null;

/** Creates the overlay batches once; updates only rewrite their instances. */
function ensureSelectionOverlays(scene: Scene): void {
    if (selectionOverlay) return;
    selectionOverlay = new OverlayBatch('lines', createBoxOverlayGeometry(16), _boxOverlayMat, new StorageBufferAttribute(new Float32Array(16 * 16), 16));
    selectionOverlay.renderOrder = 1;
    selectionOverlay.matrixAutoUpdate = false;
    hoverLineOverlay = new OverlayBatch('lines', new BufferGeometry().setAttribute('position', new Float32BufferAttribute(6, 3)), _hoverLineMat);
    axisOverlay = new OverlayBatch('lines', _axisUnitGeo, _axisMat, new StorageBufferAttribute(new Float32Array(4 * 16), 16));
    axisOverlay.renderOrder = 100;
    pointOverlay = new OverlayBatch('sprites', null, _pointMat, new StorageBufferAttribute(new Float32Array(64 * 4), 4));
    pointOverlay.renderOrder = 110;
    selectionPointsOverlay = new Group();
    selectionPointsOverlay.renderOrder = 999;
    selectionPointsOverlay.matrixAutoUpdate = false;
    selectionPointsOverlay.add(hoverLineOverlay, axisOverlay, pointOverlay);
    scene.add(selectionOverlay, selectionPointsOverlay);
}

/** Room for `count` instances (capacity doubles; `grow` rebuilds per-instance geometry); returns the array, uploaded whole. */
function reserveInstances(batch: OverlayBatch, count: number, grow?: (capacity: number) => BufferGeometry): Float32Array {
    const old = batch.instances!;
    if (old.count < count) {
        const capacity = Math.max(count, old.count * 2);
        batch.instances = new StorageBufferAttribute(new Float32Array(capacity * old.itemSize), old.itemSize);
        old.dispose();
        if (grow) {
            batch.draw.geometry.dispose();
            batch.draw.geometry = grow(capacity);
        }
    }
    batch.count = count;
    batch.instances!.clearUpdateRanges();
    batch.instances!.needsUpdate = true;
    return batch.instances!.array as Float32Array;
}

function markBoxes(start: number, count: number): void {
    selectionOverlay!.instances!.addUpdateRange(start * 16, count * 16);
    selectionOverlay!.instances!.needsUpdate = true;
}

function boxMatrix(box: Box3): Matrix4 {
    return _TMP_MAT4_BOX.compose(box.getCenter(_TMP_VEC3_A), _IDENTITY_QUAT, box.getSize(_TMP_VEC3_B));
}

function setMultiBoxMatrix(matrix: Matrix4): void {
    matrix.toArray(selectionOverlay!.instances!.array, multiBoxSlot * 16);
    markBoxes(multiBoxSlot, 1);
}

/** Uploads point positions and highlights (hovered or selected). */
function writePoints(selectedVertexKeys: Set<string>): void {
    if (!pointOverlay) return;
    const values = reserveInstances(pointOverlay, overlayPoints.length);
    overlayPoints.forEach((point, index) => {
        point.position.toArray(values, index * 4);
        values[index * 4 + 3] = point === hoveredVertex || selectedVertexKeys.has(point.userData.key) ? 1 : 0;
    });
}

export function updateSelectionOverlayObject(mesh: ObjectBatch, instanceId: number): void {
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
    _TMP_MAT4_C.toArray(selectionOverlay.instances!.array, index * 16);
    markBoxes(index, 1);

    const item = (selectionOverlay.userData['items'] as OverlayItem[])[index];
    item.matrix.copy(_TMP_MAT4_C);
    item.source.cachedLocalCenter?.copy(_TMP_VEC3_A);
    item.source.cachedLocalSize?.copy(_TMP_VEC3_B);
    // ponytail: the aggregate box catches up on the next full selection refresh; per-key rebuilds must stay O(1).
}

export function updateSelectionOverlay(
    scene: Scene,
    renderer: Renderer,
    currentSelection: SelectionState,
    vertexQueue: QueueItem[],
    isVertexMode: boolean,
    selectionHelper: Object3D,
    selectedVertexKeys: Set<string>
): void {
    ensureSelectionOverlays(scene);
    const boxes = selectionOverlay!;
    const pointsRoot = selectionPointsOverlay!;
    overlayPoints = [];
    hoveredVertex = null;
    hoverLineOverlay!.count = 0;
    multiBoxSlot = -1;
    // Drags move the points overlay (syncSelectionOverlay) until this rebuild.
    pointsRoot.matrix.identity().decompose(pointsRoot.position, pointsRoot.quaternion, pointsRoot.scale);
    pointsRoot.updateMatrixWorld(true);

    const hasAnySelection = (currentSelection.groups && currentSelection.groups.size > 0) || (currentSelection.objects && currentSelection.objects.size > 0);
    if (!hasAnySelection && vertexQueue.length === 0) {
        boxes.count = 0;
        boxes.userData['items'] = [];
        boxes.userData['selectedCount'] = 0;
        boxes.userData['objectIndexes'] = new Map();
        pointsRoot.visible = false;
        return;
    }

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
        for (const [mesh, ids] of selectedSlots(currentSelection.objects)) {
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
        if (item.type === 'group' && item.id && currentSelection.groups.has(item.id)) return;
        if (item.type === 'object' && item.id && currentSelection.objects.has(item.id)) return;

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
        } else if (item.type === 'object') {
            const ref = queuedRef(item);
            if (!ref) return;
            const { mesh, instanceId } = ref;
            const localBox = getInstanceLocalBox(mesh, instanceId);
            if (localBox) {
                localBox.getSize(tempSize);
                localBox.getCenter(tempCenter);
                const worldMat = getInstanceWorldMatrix(mesh, instanceId, new Matrix4());
                const instanceMat = new Matrix4().makeTranslation(tempCenter.x, tempCenter.y, tempCenter.z).scale(tempSize).premultiply(worldMat);
                let gPos = item.gizmoLocalPosition ? item.gizmoLocalPosition.clone().applyMatrix4(worldMat) : undefined;
                let gQuat = item.gizmoLocalQuaternion && gPos ? getRotationFromMatrix(worldMat).multiply(item.gizmoLocalQuaternion) : undefined;
                const color = getDisplayOverlayColor(getDisplayType(mesh, instanceId));
                queueItemsToRender.push({ matrix: instanceMat, color, source: { type: 'object', mesh, instanceId }, gizmoPosition: gPos, gizmoQuaternion: gQuat, gizmoLocalPosition: item.gizmoLocalPosition });
            }
        }
    };
    vertexQueue.forEach(processQueueItem);

    const allOverlayItems = [...itemsToRender, ...queueItemsToRender];

    // Aggregate boxes follow the item boxes: the multi-selection box first, then one per bundle.
    const boxesToDraw: Box3[] = [];
    const hasMultiBox = _getSelectedObjectCount(currentSelection) + (currentSelection.groups?.size || 0) > 1;
    if (hasMultiBox) boxesToDraw.push(getSelectionBoundingBox(currentSelection));
    vertexQueue.forEach(qItem => {
        if (qItem.type === 'bundle' && qItem.items && qItem.items.length > 1) {
            const bundleBox = new Box3();
            qItem.items.forEach(sub => {
                let localBox: Box3 | null = null, worldMat = new Matrix4();
                if (sub.type === 'group' && sub.id) { localBox = getGroupLocalBoundingBox(sub.id); getGroupWorldMatrixWithFallback(sub.id, worldMat); }
                else { const ref = queuedRef(sub); if (ref) { localBox = getInstanceLocalBox(ref.mesh, ref.instanceId); getInstanceWorldMatrix(ref.mesh, ref.instanceId, worldMat); } }
                if (localBox && !localBox.isEmpty()) bundleBox.union(_TMP_BOX3_A.copy(localBox).applyMatrix4(worldMat));
            });
            if (!bundleBox.isEmpty()) boxesToDraw.push(bundleBox);
        }
    });

    const matrices = reserveInstances(boxes, allOverlayItems.length + boxesToDraw.length, createBoxOverlayGeometry);
    const colors = boxes.draw.geometry.getAttribute('overlayColor') as BufferAttribute;
    const dragSelected = boxes.draw.geometry.getAttribute(dragSelectedAttributeName) as BufferAttribute;
    dragSelected.array.fill(0);
    dragSelected.array.fill(1, 0, itemsToRender.length);
    allOverlayItems.forEach((item, index) => {
        item.matrix.toArray(matrices, index * 16);
        _TMP_COLOR.setHex(item.color).toArray(colors.array, index * 3);
    });
    boxesToDraw.forEach((box, index) => {
        const slot = allOverlayItems.length + index;
        boxMatrix(box).toArray(matrices, slot * 16);
        _TMP_COLOR.setHex(0xFFFFFF).toArray(colors.array, slot * 3);
    });
    colors.needsUpdate = true;
    dragSelected.needsUpdate = true;
    if (hasMultiBox) multiBoxSlot = allOverlayItems.length;
    boxes.userData['items'] = allOverlayItems;
    boxes.userData['selectedCount'] = itemsToRender.length;
    boxes.userData['objectIndexes'] = new Map(allOverlayItems.flatMap((item, index) =>
        item.source.type === 'object' && item.source.mesh && item.source.instanceId !== undefined
            ? [[`${item.source.mesh.uuid}:${item.source.instanceId}`, index] as const]
            : []
    ));

    const axes: Matrix4[] = [];
    if (allOverlayItems.length > 0 && isVertexMode) {
        const canvas = renderer.domElement;
        _pointScale.value.set(10 / canvas.clientWidth, 10 / canvas.clientHeight);
        const existingPoints = new Set<string>();

        for (const item of allOverlayItems) {
            for (const corner of _unitCubeCorners) {
                const position = corner.clone().applyMatrix4(item.matrix);
                const key = `${position.x.toFixed(4)}_${position.y.toFixed(4)}_${position.z.toFixed(4)}`;
                if (existingPoints.has(key)) continue;
                existingPoints.add(key);
                overlayPoints.push({ position, userData: { key, source: item.source } });
            }
        }

        if (selectionHelper) {
            const gizmoPos = selectionHelper.position;
            const centerKey = `CENTER_${gizmoPos.x.toFixed(4)}_${gizmoPos.y.toFixed(4)}_${gizmoPos.z.toFixed(4)}`;
            overlayPoints.push({ position: gizmoPos.clone(), userData: { isCenter: true, key: centerKey } });

            queueItemsToRender.forEach(item => {
                if (item.gizmoPosition) {
                    const posForKey = item.gizmoLocalPosition || item.gizmoPosition;
                    const centerPosKey = `CENTER_QUEUE_${item.gizmoPosition.x.toFixed(4)}_${item.gizmoPosition.y.toFixed(4)}_${item.gizmoPosition.z.toFixed(4)}`;
                    if (existingPoints.has(centerPosKey)) return;
                    existingPoints.add(centerPosKey);

                    const src = item.source;
                    const idStr = src.type === 'group' ? `G_${src.id}` : `O_${slotKeyUuid(src.mesh!, src.instanceId!)}`;
                    const qKey = `QUEUE_${idStr}_${posForKey.x.toFixed(4)}_${posForKey.y.toFixed(4)}_${posForKey.z.toFixed(4)}`;
                    overlayPoints.push({ position: item.gizmoPosition.clone(), userData: { isCenter: true, key: qKey, source: src } });
                    if (item.gizmoQuaternion) axes.push(new Matrix4().compose(item.gizmoPosition, item.gizmoQuaternion, _UNIT_SCALE));
                }
            });
            axes.push(new Matrix4().compose(gizmoPos, selectionHelper.quaternion, _UNIT_SCALE));
        }
    }
    const axisMatrices = reserveInstances(axisOverlay!, axes.length);
    axes.forEach((matrix, index) => matrix.toArray(axisMatrices, index * 16));
    writePoints(selectedVertexKeys);
    pointsRoot.visible = overlayPoints.length > 0;
}

export function updateMultiSelectionOverlayDuringDrag(currentSelection: SelectionState, currentGizmoMat: Matrix4 | null, initialGizmoMat: Matrix4 | null): void {
    if (!selectionOverlay || multiBoxSlot < 0) return;

    if (currentGizmoMat && initialGizmoMat) {
        const tMat = _TMP_MAT4_C.copy(initialGizmoMat).invert().premultiply(currentGizmoMat);
        const e = tMat.elements;
        const axesStayAligned = Math.abs(e[1]) < 1e-10 && Math.abs(e[2]) < 1e-10
            && Math.abs(e[4]) < 1e-10 && Math.abs(e[6]) < 1e-10
            && Math.abs(e[8]) < 1e-10 && Math.abs(e[9]) < 1e-10;
        if (axesStayAligned) {
            setMultiBoxMatrix(_TMP_MAT4_BOX.multiplyMatrices(tMat, _dragInitialOverlayMatrix));
            return;
        }

        const worldBox = getSelectionOverlayBoundingBox(tMat);
        if (!worldBox.isEmpty()) setMultiBoxMatrix(boxMatrix(worldBox));
        return;
    }

    const worldBox = getSelectionBoundingBox(currentSelection);
    if (!worldBox.isEmpty()) setMultiBoxMatrix(boxMatrix(worldBox));
}

export function syncSelectionOverlay(deltaMatrix: Matrix4): void {
    if (selectionPointsOverlay) { selectionPointsOverlay.applyMatrix4(deltaMatrix); selectionPointsOverlay.updateMatrixWorld(true); }
}

export function commitSelectionOverlay(deltaMatrix: Matrix4, _currentSelection: SelectionState): void {
    if (!selectionOverlay) return;
    const selectedCount = Math.min(selectionOverlay.count, (selectionOverlay.userData['selectedCount'] as number | undefined) ?? selectionOverlay.count);
    if (selectedCount > 0) {
        transformInstanceRange(selectionOverlay.instances!.array, deltaMatrix, 0, selectedCount);
        markBoxes(0, selectedCount);
    }
    if (multiBoxSlot < 0) return;
    const finalBox = getSelectionOverlayBoundingBox();
    if (!finalBox.isEmpty()) setMultiBoxMatrix(boxMatrix(finalBox));
}

export function findClosestVertexForSnapping(gizmoWorldPos: Vector3, camera: Camera, renderer: Renderer, snapThreshold = 15): Vector3 | null {
    if (!overlayPoints.length) return null;
    const rect = renderer.domElement.getBoundingClientRect();
    const gScreen = _TMP_VEC3_B.copy(gizmoWorldPos).project(camera);
    const gx = (gScreen.x * 0.5 + 0.5) * rect.width, gy = (1 - (gScreen.y * 0.5 + 0.5)) * rect.height;
    let minDSq = snapThreshold * snapThreshold, target: Vector3 | null = null;
    for (const point of overlayPoints) {
        if (point.userData.isCenter) continue;
        const vS = _TMP_VEC3_A.copy(point.position).project(camera);
        const vx = (vS.x * 0.5 + 0.5) * rect.width, vy = (1 - (vS.y * 0.5 + 0.5)) * rect.height;
        const dSq = (vx-gx)**2 + (vy-gy)**2;
        if (dSq < minDSq) { minDSq = dSq; target = point.position; }
    }
    return target;
}

export function getHoveredVertex(mouseNDC: Vector2, camera: Camera, renderer: Renderer): OverlayPoint | null {
    const canvas = renderer.domElement;
    const mx = (mouseNDC.x * 0.5 + 0.5) * canvas.clientWidth, my = (-mouseNDC.y * 0.5 + 0.5) * canvas.clientHeight;
    let bestDSq = 100, best: OverlayPoint | null = null;
    for (const point of overlayPoints) {
        const vS = _TMP_VEC3_A.copy(point.position).project(camera);
        if (vS.z < -1 || vS.z > 1) continue;
        const sx = (vS.x * 0.5 + 0.5) * canvas.clientWidth, sy = (-vS.y * 0.5 + 0.5) * canvas.clientHeight;
        const dSq = (sx-mx)**2 + (sy-my)**2;
        if (dSq < bestDSq) { bestDSq = dSq; best = point; }
    }
    return best;
}

export function updateVertexHoverHighlight(hoveredPoint: OverlayPoint | null, selectedVertexKeys: Set<string>): void {
    if (!overlayPoints.length || hoveredPoint === hoveredVertex) return;
    hoveredVertex = hoveredPoint;
    writePoints(selectedVertexKeys);
    let selected: OverlayPoint | null = null;
    for (const point of overlayPoints) if (selectedVertexKeys.has(point.userData.key)) selected = point;
    if (selectedVertexKeys.size === 1 && hoveredPoint && selected && hoveredPoint !== selected) {
        const position = hoverLineOverlay!.draw.geometry.getAttribute('position') as BufferAttribute;
        position.setXYZ(0, selected.position.x, selected.position.y, selected.position.z);
        position.setXYZ(1, hoveredPoint.position.x, hoveredPoint.position.y, hoveredPoint.position.z);
        position.needsUpdate = true;
        hoverLineOverlay!.count = 1;
    } else hoverLineOverlay!.count = 0;
}

export function findSpritesByKeys(keys: string[]): Record<string, OverlayPoint> {
    const res: Record<string, OverlayPoint> = {}, set = new Set(keys);
    for (const point of overlayPoints) if (set.has(point.userData.key)) res[point.userData.key] = point;
    return res;
}

export function refreshSelectionPointColors(selectedVertexKeys: Set<string>): void {
    hoveredVertex = null;
    if (hoverLineOverlay) hoverLineOverlay.count = 0;
    writePoints(selectedVertexKeys);
}
