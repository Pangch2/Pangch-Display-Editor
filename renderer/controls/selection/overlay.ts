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
import * as GroupUtils from '../grouping/group';
import type { GroupChildObject } from '../grouping/group';
import { dragPreviewPositionNode, dragSelectedAttributeName } from '../../entityMaterial.js';

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

interface DragBoundsItem {
    box: Box3;
    matrix: Matrix4;
}

// --- Constants & Temporaries ---

const _TMP_MAT4_A = new Matrix4();
const _TMP_MAT4_B = new Matrix4();
const _TMP_MAT4_C = new Matrix4();
const _TMP_BOX3_A = new Box3();
const _TMP_BOX3_B = new Box3();
const _TMP_VEC3_A = new Vector3();
const _TMP_VEC3_B = new Vector3();

let loadedObjectGroup: Group | null = null;
const _dragBoundsItems: DragBoundsItem[] = [];

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
        return mesh.userData.displayTypes.get(instanceId);
    }
    return mesh.userData?.displayType;
}

export function isItemDisplayHatEnabled(mesh: PdeMesh, instanceId: number): boolean {
    return !!(getDisplayType(mesh, instanceId) === 'item_display' && mesh?.userData?.hasHat && mesh.userData.hasHat[instanceId]);
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
        const localY = isItemDisplayHatEnabled(m, id) ? 0.03125 : 0;
        tempPos.set(0, localY, 0).applyMatrix4(tempMat);
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

    let box = mesh.geometry.boundingBox.clone();

    if (getDisplayType(mesh, instanceId) === 'item_display' && mesh.userData?.hasHat && !mesh.userData.hasHat[instanceId]) {
        const center = new Vector3();
        box.getCenter(center);
        box = new Box3().setFromCenterAndSize(center, new Vector3(1, 1, 1));
    }

    return box;
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

export function prepareMultiSelectionDrag(currentSelection: SelectionState): void {
    _dragBoundsItems.length = 0;
    for (const groupId of currentSelection.groups) {
        const box = getGroupLocalBoundingBox(groupId);
        if (!box.isEmpty()) _dragBoundsItems.push({ box, matrix: getGroupWorldMatrixWithFallback(groupId) });
    }
    for (const [mesh, ids] of currentSelection.objects) {
        for (const id of ids) {
            const box = getInstanceLocalBox(mesh, id);
            if (box) _dragBoundsItems.push({ box, matrix: getInstanceWorldMatrix(mesh, id, new Matrix4()) });
        }
    }
}

// --- Overlay State ---

let selectionOverlay: InstancedMesh | null = null;
let selectionPointsOverlay: Group | null = null;
let multiSelectionOverlay: Group | null = null;
let hoveredVertex: Sprite | null = null;

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
                const displayType = getDisplayType(mesh, id);
                const color = displayType === 'item_display' ? 0x2E87EC : 0xFFD147;
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
                const displayType = getDisplayType(item.mesh, item.instanceId);
                const color = displayType === 'item_display' ? 0x2E87EC : 0xFFD147;
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

    const worldBox = _TMP_BOX3_A.makeEmpty();
    if (currentGizmoMat && initialGizmoMat && _dragBoundsItems.length > 0) {
        const tMat = _TMP_MAT4_C.copy(initialGizmoMat).invert().premultiply(currentGizmoMat);
        for (const item of _dragBoundsItems) {
            _TMP_MAT4_A.multiplyMatrices(tMat, item.matrix);
            worldBox.union(_TMP_BOX3_B.copy(item.box).applyMatrix4(_TMP_MAT4_A));
        }
    } else {
        worldBox.copy(getSelectionBoundingBox(currentSelection));
    }
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
    _dragBoundsItems.length = 0;
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
