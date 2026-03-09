import * as THREE from 'three/webgpu';
import * as GroupUtils from './group';
import type { GroupChildObject } from './group';

// --- Types & Interfaces ---

type PdeMesh = THREE.InstancedMesh | THREE.BatchedMesh | THREE.Mesh;

export interface SelectionState {
    groups: Set<string>;
    objects: Map<THREE.Mesh | THREE.BatchedMesh | THREE.InstancedMesh, Set<number>>;
}

export type QueueItemType = 'group' | 'object' | 'bundle';

export interface QueueItem {
    type: QueueItemType;
    id?: string;
    mesh?: THREE.Mesh | THREE.BatchedMesh | THREE.InstancedMesh;
    instanceId?: number;
    items?: QueueItem[];
    gizmoLocalPosition?: THREE.Vector3;
    gizmoLocalQuaternion?: THREE.Quaternion;
    gizmoPosition?: THREE.Vector3;
    gizmoQuaternion?: THREE.Quaternion;
}

interface OverlayItemSource {
    type: 'group' | 'object';
    id?: string;
    mesh?: THREE.Mesh | THREE.BatchedMesh | THREE.InstancedMesh;
    instanceId?: number;
    cachedLocalCenter?: THREE.Vector3;
    cachedLocalSize?: THREE.Vector3;
}

interface OverlayItem {
    matrix: THREE.Matrix4;
    color: number;
    source: OverlayItemSource;
    gizmoPosition?: THREE.Vector3;
    gizmoQuaternion?: THREE.Quaternion;
    gizmoLocalPosition?: THREE.Vector3;
}

// --- Constants & Temporaries ---

const _TMP_MAT4_A = new THREE.Matrix4();
const _TMP_MAT4_B = new THREE.Matrix4();
const _TMP_BOX3_A = new THREE.Box3();
const _TMP_VEC3_A = new THREE.Vector3();
const _TMP_VEC3_B = new THREE.Vector3();

let loadedObjectGroup: THREE.Group | null = null;
let _dragCachePos = new Float32Array(0);
let _dragCacheLocalExt = new Float32Array(0);
let _dragCacheWorldMat3 = new Float32Array(0);
let _dragCacheCount = 0;

export function setLoadedObjectGroup(group: THREE.Group | null): void {
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
    const geo = new THREE.BufferGeometry();
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
    geo.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
    return geo;
})();

const _axisUnitGeo = (() => {
    const geo = new THREE.BufferGeometry();
    const verts: number[] = [];
    const colors: number[] = [];
    const addLine = (v: THREE.Vector3, colorHex: number) => {
        verts.push(0, 0, 0, v.x, v.y, v.z);
        const c = new THREE.Color(colorHex);
        colors.push(c.r, c.g, c.b, c.r, c.g, c.b);
    };
    addLine(new THREE.Vector3(0.3, 0, 0), 0xEF3751);
    addLine(new THREE.Vector3(-0.3, 0, 0), 0xEF3751);
    addLine(new THREE.Vector3(0, 0.3, 0), 0x6FA21C);
    addLine(new THREE.Vector3(0, -0.3, 0), 0x6FA21C);
    addLine(new THREE.Vector3(0, 0, 0.3), 0x437FD0);
    addLine(new THREE.Vector3(0, 0, -0.3), 0x437FD0);
    
    geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    return geo;
})();

const _axisMat = new THREE.LineBasicMaterial({
    vertexColors: true,
    depthTest: false,
    depthWrite: false,
    transparent: true
});

const _unitCubeCorners = [
    new THREE.Vector3(-0.5, -0.5, -0.5),
    new THREE.Vector3( 0.5, -0.5, -0.5),
    new THREE.Vector3( 0.5,  0.5, -0.5),
    new THREE.Vector3(-0.5,  0.5, -0.5),
    new THREE.Vector3(-0.5, -0.5,  0.5),
    new THREE.Vector3( 0.5, -0.5,  0.5),
    new THREE.Vector3( 0.5,  0.5,  0.5),
    new THREE.Vector3(-0.5,  0.5,  0.5)
];

export function createOverlayLineMaterial(color: number): THREE.LineBasicMaterial {
    return new THREE.LineBasicMaterial({
        color,
        depthTest: true,
        depthWrite: false,
        transparent: true,
        opacity: 0.9
    });
}

export function createEdgesGeometryFromBox3(box: THREE.Box3): THREE.EdgesGeometry | null {
    if (!box || box.isEmpty()) return null;
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);
    const boxGeo = new THREE.BoxGeometry(size.x, size.y, size.z);
    boxGeo.translate(center.x, center.y, center.z);
    const edges = new THREE.EdgesGeometry(boxGeo);
    boxGeo.dispose();
    return edges;
}

// --- Helper Functions ---

export function getInstanceCount(mesh: THREE.Mesh | THREE.InstancedMesh | THREE.BatchedMesh): number {
    if (!mesh) return 0;
    if ((mesh as THREE.InstancedMesh).isInstancedMesh) return (mesh as THREE.InstancedMesh).count ?? 0;
    if ((mesh as THREE.BatchedMesh).isBatchedMesh) {
        const geomIds = (mesh as THREE.BatchedMesh).userData?.instanceGeometryIds;
        return Array.isArray(geomIds) ? geomIds.length : 0;
    }
    return 0;
}

export function isInstanceValid(mesh: THREE.Mesh | THREE.InstancedMesh | THREE.BatchedMesh, instanceId: number): boolean {
    if (!mesh) return false;
    if ((mesh as THREE.BatchedMesh).isBatchedMesh) {
        if (mesh.userData?.instanceGeometryIds) {
            return mesh.userData.instanceGeometryIds[instanceId] !== undefined;
        }
        return true;
    }
    if ((mesh as THREE.InstancedMesh).isInstancedMesh) {
        return instanceId < ((mesh as THREE.InstancedMesh).count ?? 0);
    }
    return false;
}

export function disposeThreeObjectTree(root: THREE.Object3D): void {
    if (!root) return;
    root.traverse((child: THREE.Object3D) => {
        const mesh = child as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
        if (mesh.material) {
            if (Array.isArray(mesh.material)) {
                (mesh.material as THREE.Material[]).forEach((m: THREE.Material) => m.dispose());
            } else {
                (mesh.material as THREE.Material).dispose();
            }
        }
    });
}

export function getDisplayType(mesh: PdeMesh, instanceId: number): string | undefined {
    if (!mesh) return undefined;
    if (mesh.isBatchedMesh && mesh.userData?.displayTypes) {
        return mesh.userData.displayTypes.get(instanceId);
    }
    return mesh.userData?.displayType;
}

export function isItemDisplayHatEnabled(mesh: PdeMesh, instanceId: number): boolean {
    return !!(getDisplayType(mesh, instanceId) === 'item_display' && mesh?.userData?.hasHat && mesh.userData.hasHat[instanceId]);
}

export function getInstanceLocalBoxMin(mesh: PdeMesh, instanceId: number, out = new THREE.Vector3()): THREE.Vector3 | null {
    const box = getInstanceLocalBox(mesh, instanceId);
    if (!box) return null;
    return out.copy(box.min);
}

export function getInstanceWorldMatrixForOrigin(mesh: PdeMesh, instanceId: number, outMatrix: THREE.Matrix4): THREE.Matrix4 {
    outMatrix.identity();
    if (!mesh) return outMatrix;

    mesh.getMatrixAt(instanceId, outMatrix);
    if (mesh.isBatchedMesh && mesh.userData?.localMatrices && mesh.userData.localMatrices.has(instanceId)) {
        _TMP_MAT4_B.copy(mesh.userData.localMatrices.get(instanceId)).invert();
        outMatrix.multiply(_TMP_MAT4_B);
    }
    outMatrix.premultiply(mesh.matrixWorld);
    return outMatrix;
}

export function calculateAvgOriginForChildren(children: GroupChildObject[], out = new THREE.Vector3()): THREE.Vector3 {
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

export function getGroupWorldMatrixWithFallback(groupId: string, out = new THREE.Matrix4()): THREE.Matrix4 {
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
    const quat = group.quaternion || new THREE.Quaternion();
    const scale = group.scale || new THREE.Vector3(1, 1, 1);
    return out.compose(gPos, quat, scale);
}

export function unionTransformedBox3(targetBox: THREE.Box3, localBox: THREE.Box3, matrix: THREE.Matrix4, tempBox = _TMP_BOX3_A): void {
    if (!targetBox || !localBox) return;
    tempBox.copy(localBox).applyMatrix4(matrix);
    targetBox.union(tempBox);
}

export function getInstanceLocalBox(mesh: PdeMesh, instanceId: number): THREE.Box3 | null {
    if (!mesh) return null;

    if (mesh.isBatchedMesh) {
        const geomIds = mesh.userData?.instanceGeometryIds;
        const bounds = mesh.userData?.geometryBounds;
        if (!geomIds || !bounds) return null;
        const geomId = geomIds[instanceId];
        if (geomId === undefined || geomId === null) return null;
        const box = bounds.get(geomId);
        return box ? box.clone() : null;
    }

    if (!mesh.geometry) return null;
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
    if (!mesh.geometry.boundingBox) return null;

    let box = mesh.geometry.boundingBox.clone();

    if (getDisplayType(mesh, instanceId) === 'item_display' && mesh.userData?.hasHat && !mesh.userData.hasHat[instanceId]) {
        const center = new THREE.Vector3();
        box.getCenter(center);
        box = new THREE.Box3().setFromCenterAndSize(center, new THREE.Vector3(1, 1, 1));
    }

    return box;
}

export function getInstanceWorldMatrix(mesh: PdeMesh, instanceId: number, outMatrix: THREE.Matrix4): THREE.Matrix4 {
    outMatrix.identity();
    if (!mesh) return outMatrix;
    mesh.getMatrixAt(instanceId, outMatrix);
    outMatrix.premultiply(mesh.matrixWorld);
    return outMatrix;
}

export function getGroupLocalBoundingBox(groupId: string): THREE.Box3 {
    const groups = getGroups();
    const group = groups.get(groupId);
    if (!group) return new THREE.Box3();

    const groupMatrix = getGroupWorldMatrixWithFallback(groupId, new THREE.Matrix4());
    const groupInverse = new THREE.Matrix4();

    if (Math.abs(groupMatrix.determinant()) > 1e-10) {
        groupInverse.copy(groupMatrix).invert();
    } else {
        const pos = new THREE.Vector3();
        const quat = new THREE.Quaternion();
        const scale = new THREE.Vector3();
        groupMatrix.decompose(pos, quat, scale);

        groupInverse.makeTranslation(-pos.x, -pos.y, -pos.z);
        const tempInv = new THREE.Matrix4();
        tempInv.makeRotationFromQuaternion(quat.clone().invert());
        groupInverse.premultiply(tempInv);
        
        const safeInv = (s: number) => (Math.abs(s) < 1e-10 ? 0 : 1 / s);
        tempInv.makeScale(safeInv(scale.x), safeInv(scale.y), safeInv(scale.z));
        groupInverse.premultiply(tempInv); 
    }

    const children = getAllGroupChildren(groupId);
    const box = new THREE.Box3();
    const tempMat = new THREE.Matrix4();
    const tempBox = new THREE.Box3();

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

export function getGroupOriginWorld(groupId: string, out = new THREE.Vector3()): THREE.Vector3 {
    const groups = getGroups();
    const group = groups.get(groupId);
    if (!group) return out.set(0, 0, 0);

    const box = getGroupLocalBoundingBox(groupId);
    if (!box.isEmpty()) {
        const m = GroupUtils.getGroupWorldMatrix(group, new THREE.Matrix4());
        return out.copy(box.min).applyMatrix4(m);
    }
    if (group.position) return out.copy(group.position);

    const children = getAllGroupChildren(groupId);
    if (children.length > 0) {
        return calculateAvgOriginForChildren(children, out);
    }
    return out.set(0, 0, 0);
}

export function getRotationFromMatrix(matrix: THREE.Matrix4): THREE.Quaternion {
    const R = new THREE.Matrix4();
    const x = _TMP_VEC3_A.setFromMatrixColumn(matrix, 0).normalize();
    const y = _TMP_VEC3_B.setFromMatrixColumn(matrix, 1);
    const z = new THREE.Vector3().setFromMatrixColumn(matrix, 2);

    const yDotX = y.dot(x);
    y.sub(x.clone().multiplyScalar(yDotX)).normalize();
    z.crossVectors(x, y).normalize();
    R.makeBasis(x, y, z);
    
    const quaternion = new THREE.Quaternion();
    quaternion.setFromRotationMatrix(R);
    return quaternion;
}

export function getSelectionBoundingBox(currentSelection: SelectionState): THREE.Box3 {
    const box = new THREE.Box3();
    const tempMat = new THREE.Matrix4();
    const tempBox = new THREE.Box3();

    if (currentSelection.groups && currentSelection.groups.size > 0) {
        for (const groupId of currentSelection.groups) {
            const localBox = getGroupLocalBoundingBox(groupId);
            if (!localBox || localBox.isEmpty()) continue;
            getGroupWorldMatrixWithFallback(groupId, tempMat);
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
    if (!currentSelection) {
        _dragCacheCount = 0;
        return;
    }
    
    const objCount = _getSelectedObjectCount(currentSelection);
    const grpCount = currentSelection.groups ? currentSelection.groups.size : 0;
    const totalCount = objCount + grpCount;

    if (totalCount === 0) {
        _dragCacheCount = 0;
        return;
    }

    if (_dragCachePos.length < totalCount * 3) {
        _dragCachePos       = new Float32Array(totalCount * 3);
        _dragCacheLocalExt  = new Float32Array(totalCount * 3);
        _dragCacheWorldMat3 = new Float32Array(totalCount * 9);
    }
    _dragCacheCount = 0;

    const size    = _TMP_VEC3_A;
    const center  = _TMP_VEC3_B;

    const addBox = (localBox: THREE.Box3, worldMat: THREE.Matrix4) => {
        if (!localBox || localBox.isEmpty()) return;

        localBox.getCenter(center);
        localBox.getSize(size);

        center.applyMatrix4(worldMat);
        const pIdx = _dragCacheCount * 3;
        _dragCachePos[pIdx]   = center.x;
        _dragCachePos[pIdx+1] = center.y;
        _dragCachePos[pIdx+2] = center.z;

        _dragCacheLocalExt[pIdx]   = size.x * 0.5;
        _dragCacheLocalExt[pIdx+1] = size.y * 0.5;
        _dragCacheLocalExt[pIdx+2] = size.z * 0.5;

        const e = worldMat.elements;
        const rIdx = _dragCacheCount * 9;
        _dragCacheWorldMat3[rIdx]   = e[0]; _dragCacheWorldMat3[rIdx+1] = e[4]; _dragCacheWorldMat3[rIdx+2] = e[8];
        _dragCacheWorldMat3[rIdx+3] = e[1]; _dragCacheWorldMat3[rIdx+4] = e[5]; _dragCacheWorldMat3[rIdx+5] = e[9];
        _dragCacheWorldMat3[rIdx+6] = e[2]; _dragCacheWorldMat3[rIdx+7] = e[6]; _dragCacheWorldMat3[rIdx+8] = e[10];

        _dragCacheCount++;
    };

    if (currentSelection.groups) {
        for (const groupId of currentSelection.groups) {
            const localBox = getGroupLocalBoundingBox(groupId);
            const tempMat = new THREE.Matrix4();
            getGroupWorldMatrixWithFallback(groupId, tempMat);
            addBox(localBox, tempMat);
        }
    }

    if (currentSelection.objects) {
        for (const [mesh, ids] of currentSelection.objects) {
            for (const id of ids) {
                const localBox = getInstanceLocalBox(mesh, id);
                if (!localBox) continue;
                const tempMat = new THREE.Matrix4();
                getInstanceWorldMatrix(mesh, id, tempMat);
                addBox(localBox, tempMat);
            }
        }
    }
}

// --- Overlay State ---

let selectionOverlay: THREE.Object3D | null = null;
let selectionPointsOverlay: THREE.Group | null = null;
let multiSelectionOverlay: THREE.Group | null = null;

export function getSelectionPointsOverlay(): THREE.Group | null {
    return selectionPointsOverlay;
}

export function updateSelectionOverlay(
    scene: THREE.Scene, 
    renderer: THREE.Renderer, 
    _camera: THREE.Camera, 
    currentSelection: SelectionState, 
    vertexQueue: QueueItem[], 
    isVertexMode: boolean, 
    selectionHelper: THREE.Mesh,
    selectedVertexKeys: Set<string>
): void {
    if (selectionOverlay) {
        scene.remove(selectionOverlay);
        if (selectionOverlay instanceof THREE.Group) {
            disposeThreeObjectTree(selectionOverlay);
        } else if (selectionOverlay instanceof THREE.InstancedMesh) {
            if (selectionOverlay.material instanceof THREE.Material) selectionOverlay.material.dispose();
        }
        selectionOverlay = null;
    }

    if (selectionPointsOverlay) {
        scene.remove(selectionPointsOverlay);
        selectionPointsOverlay.traverse((child: THREE.Object3D) => {
            const s = child as THREE.Sprite;
            if (s.material) s.material.dispose();
        });
        selectionPointsOverlay = null;
    }

    if (multiSelectionOverlay) {
        scene.remove(multiSelectionOverlay);
        disposeThreeObjectTree(multiSelectionOverlay);
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
            const groupWorld = getGroupWorldMatrixWithFallback(groupId, new THREE.Matrix4());
            const instanceMat = new THREE.Matrix4().makeTranslation(tempCenter.x, tempCenter.y, tempCenter.z).scale(tempSize).premultiply(groupWorld);
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
                const objTempMat = new THREE.Matrix4();
                getInstanceWorldMatrix(mesh, id, objTempMat);
                const instanceMat = new THREE.Matrix4().makeTranslation(tempCenter.x, tempCenter.y, tempCenter.z).scale(tempSize).premultiply(objTempMat);
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
                const groupWorld = getGroupWorldMatrixWithFallback(item.id, new THREE.Matrix4());
                const instanceMat = new THREE.Matrix4().makeTranslation(tempCenter.x, tempCenter.y, tempCenter.z).scale(tempSize).premultiply(groupWorld);
                let gPos = item.gizmoLocalPosition ? item.gizmoLocalPosition.clone().applyMatrix4(groupWorld) : undefined;
                let gQuat = item.gizmoLocalQuaternion && gPos ? getRotationFromMatrix(groupWorld).multiply(item.gizmoLocalQuaternion) : undefined;
                queueItemsToRender.push({ matrix: instanceMat, color: 0x6FA21C, source: { type: 'group', id: item.id }, gizmoPosition: gPos, gizmoQuaternion: gQuat, gizmoLocalPosition: item.gizmoLocalPosition });
            }
        } else if (item.type === 'object' && item.mesh && item.instanceId !== undefined) {
            const localBox = getInstanceLocalBox(item.mesh, item.instanceId);
            if (localBox) {
                localBox.getSize(tempSize);
                localBox.getCenter(tempCenter);
                const worldMat = getInstanceWorldMatrix(item.mesh, item.instanceId, new THREE.Matrix4());
                const instanceMat = new THREE.Matrix4().makeTranslation(tempCenter.x, tempCenter.y, tempCenter.z).scale(tempSize).premultiply(worldMat);
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
        const createMesh = (items: OverlayItem[]) => {
            const material = new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: true, depthWrite: false, transparent: true, opacity: 0.9, wireframe: true });
            const mesh = new THREE.InstancedMesh(_overlayUnitGeo, material, items.length);
            mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
            mesh.renderOrder = 1;
            mesh.matrixAutoUpdate = false;
            mesh.frustumCulled = false;
            mesh.userData['items'] = items;
            const colorObj = new THREE.Color();
            items.forEach((item, index) => {
                mesh.setMatrixAt(index, item.matrix);
                colorObj.setHex(item.color);
                mesh.setColorAt(index, colorObj);
            });
            return mesh;
        };

        const CHUNK_SIZE = 1000;
        if (allOverlayItems.length > CHUNK_SIZE) {
            selectionOverlay = new THREE.Group();
            selectionOverlay.matrixAutoUpdate = false;
            for (let i = 0; i < allOverlayItems.length; i += CHUNK_SIZE) {
                selectionOverlay.add(createMesh(allOverlayItems.slice(i, i + CHUNK_SIZE)));
            }
        } else {
            selectionOverlay = createMesh(allOverlayItems);
        }
        scene.add(selectionOverlay);
    }

    if (allOverlayItems.length > 0 && isVertexMode) {
        selectionPointsOverlay = new THREE.Group();
        selectionPointsOverlay.renderOrder = 999;
        selectionPointsOverlay.matrixAutoUpdate = false;
        
        const baseSpriteMat = new THREE.SpriteMaterial({ color: 0x30333D, sizeAttenuation: false, depthTest: false, depthWrite: false, transparent: true });
        const canvas = renderer.domElement;
        const width = canvas.clientWidth, height = canvas.clientHeight;
        const scaleX = 10 / width, scaleY = 10 / height;
        const v = new THREE.Vector3();
        const existingPoints = new Set<string>();

        for (const item of allOverlayItems) {
            for (const corner of _unitCubeCorners) {
                v.copy(corner).applyMatrix4(item.matrix);
                const key = `${v.x.toFixed(4)}_${v.y.toFixed(4)}_${v.z.toFixed(4)}`;
                if (existingPoints.has(key)) continue;
                existingPoints.add(key);
                const sprite = new THREE.Sprite(baseSpriteMat.clone());
                sprite.position.copy(v);
                sprite.userData = { key, source: item.source };
                if (selectedVertexKeys.has(key)) sprite.material.color.setHex(0x437FD0);
                sprite.scale.set(scaleX, scaleY, 1);
                selectionPointsOverlay.add(sprite);
            }
        }

        if (selectionHelper) {
            const gizmoPos = selectionHelper.position;
            const centerSprite = new THREE.Sprite(baseSpriteMat.clone());
            centerSprite.position.copy(gizmoPos);
            const centerKey = `CENTER_${gizmoPos.x.toFixed(4)}_${gizmoPos.y.toFixed(4)}_${gizmoPos.z.toFixed(4)}`;
            centerSprite.userData = { isCenter: true, key: centerKey };
            if (selectedVertexKeys.has(centerKey)) centerSprite.material.color.setHex(0x437FD0);
            centerSprite.scale.set(scaleX, scaleY, 1);
            selectionPointsOverlay.add(centerSprite);

            const createAxisHelper = (pos: THREE.Vector3, quat: THREE.Quaternion) => {
                const axes = new THREE.LineSegments(_axisUnitGeo, _axisMat);
                axes.position.copy(pos);
                axes.quaternion.copy(quat);
                axes.renderOrder = 100;
                axes.onBeforeRender = function(this: THREE.LineSegments, _renderer, _scene, cam) {
                    const distance = this.getWorldPosition(_TMP_VEC3_A).distanceTo(cam.position);
                    const s = distance * 0.15; 
                    this.scale.set(s, s, s);
                    this.updateMatrix();
                };
                return axes;
            };

            queueItemsToRender.forEach(item => {
                if (item.gizmoPosition) {
                    const queueSprite = new THREE.Sprite(baseSpriteMat.clone());
                    queueSprite.position.copy(item.gizmoPosition);
                    const posForKey = item.gizmoLocalPosition || item.gizmoPosition;
                    const src = item.source;
                    const idStr = src.type === 'group' ? `G_${src.id}` : `O_${src.mesh!.uuid}_${src.instanceId}`;
                    const qKey = `QUEUE_${idStr}_${posForKey.x.toFixed(4)}_${posForKey.y.toFixed(4)}_${posForKey.z.toFixed(4)}`;
                    queueSprite.userData = { isCenter: true, key: qKey, source: src };
                    if (selectedVertexKeys.has(qKey)) queueSprite.material.color.setHex(0x437FD0);
                    queueSprite.scale.set(scaleX, scaleY, 1);
                    selectionPointsOverlay!.add(queueSprite);
                    if (item.gizmoQuaternion) selectionPointsOverlay!.add(createAxisHelper(item.gizmoPosition, item.gizmoQuaternion));
                }
            });
            selectionPointsOverlay.add(createAxisHelper(gizmoPos, selectionHelper.quaternion));
        }
        baseSpriteMat.dispose();
        scene.add(selectionPointsOverlay);
    }

    const boxesToDraw: THREE.Box3[] = [];
    if (_getSelectedObjectCount(currentSelection) + (currentSelection.groups?.size || 0) > 1) {
        boxesToDraw.push(getSelectionBoundingBox(currentSelection));
    }
    vertexQueue.forEach(qItem => {
        if (qItem.type === 'bundle' && qItem.items && qItem.items.length > 1) {
            const bundleBox = new THREE.Box3();
            qItem.items.forEach(sub => {
                let localBox: THREE.Box3 | null = null, worldMat = new THREE.Matrix4();
                if (sub.type === 'group' && sub.id) { localBox = getGroupLocalBoundingBox(sub.id); getGroupWorldMatrixWithFallback(sub.id, worldMat); }
                else if (sub.type === 'object' && sub.mesh && sub.instanceId !== undefined) { localBox = getInstanceLocalBox(sub.mesh, sub.instanceId); getInstanceWorldMatrix(sub.mesh, sub.instanceId, worldMat); }
                if (localBox && !localBox.isEmpty()) bundleBox.union(_TMP_BOX3_A.copy(localBox).applyMatrix4(worldMat));
            });
            if (!bundleBox.isEmpty()) boxesToDraw.push(bundleBox);
        }
    });

    if (boxesToDraw.length > 0) {
        multiSelectionOverlay = new THREE.Group();
        multiSelectionOverlay.matrixAutoUpdate = false;
        const mat = createOverlayLineMaterial(0xFFFFFF);
        boxesToDraw.forEach(box => {
            const geo = createEdgesGeometryFromBox3(box);
            if (geo) multiSelectionOverlay!.add(new THREE.LineSegments(geo, mat));
        });
        scene.add(multiSelectionOverlay);
    }
}

export function updateMultiSelectionOverlayDuringDrag(currentSelection: SelectionState, currentGizmoMat: THREE.Matrix4 | null, initialGizmoMat: THREE.Matrix4 | null): void {
    if (!multiSelectionOverlay) return;
    const activeBoxLine = multiSelectionOverlay.children[0] as THREE.LineSegments;
    if (!activeBoxLine) return;
    if (_getSelectedObjectCount(currentSelection) + (currentSelection.groups?.size || 0) <= 1) { activeBoxLine.visible = false; return; }
    activeBoxLine.visible = true;

    const worldBox = _TMP_BOX3_A.makeEmpty();
    if (currentGizmoMat && initialGizmoMat && _dragCacheCount > 0) {
        const tMat = _TMP_MAT4_A.copy(initialGizmoMat).invert().premultiply(currentGizmoMat);
        const te = tMat.elements;
        const t00 = te[0], t01 = te[4], t02 = te[8], t10 = te[1], t11 = te[5], t12 = te[9], t20 = te[2], t21 = te[6], t22 = te[10], tx = te[12], ty = te[13], tz = te[14];
        let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

        for (let i = 0; i < _dragCacheCount; i++) {
            const pIdx = i * 3, rIdx = i * 9;
            const px = _dragCachePos[pIdx], py = _dragCachePos[pIdx+1], pz = _dragCachePos[pIdx+2];
            const nx = t00*px + t01*py + t02*pz + tx, ny = t10*px + t11*py + t12*pz + ty, nz = t20*px + t21*py + t22*pz + tz;
            const m00 = _dragCacheWorldMat3[rIdx], m01 = _dragCacheWorldMat3[rIdx+1], m02 = _dragCacheWorldMat3[rIdx+2], m10 = _dragCacheWorldMat3[rIdx+3], m11 = _dragCacheWorldMat3[rIdx+4], m12 = _dragCacheWorldMat3[rIdx+5], m20 = _dragCacheWorldMat3[rIdx+6], m21 = _dragCacheWorldMat3[rIdx+7], m22 = _dragCacheWorldMat3[rIdx+8];
            const c00 = t00*m00 + t01*m10 + t02*m20, c01 = t00*m01 + t01*m11 + t02*m21, c02 = t00*m02 + t01*m12 + t02*m22, c10 = t10*m00 + t11*m10 + t12*m20, c11 = t10*m01 + t11*m11 + t12*m21, c12 = t10*m02 + t11*m12 + t12*m22, c20 = t20*m00 + t21*m10 + t22*m20, c21 = t20*m01 + t21*m11 + t22*m21, c22 = t20*m02 + t21*m12 + t22*m22;
            const ex = _dragCacheLocalExt[pIdx], ey = _dragCacheLocalExt[pIdx+1], ez = _dragCacheLocalExt[pIdx+2];
            const nex = Math.abs(c00)*ex + Math.abs(c01)*ey + Math.abs(c02)*ez, ney = Math.abs(c10)*ex + Math.abs(c11)*ey + Math.abs(c12)*ez, nez = Math.abs(c20)*ex + Math.abs(c21)*ey + Math.abs(c22)*ez;
            minX = Math.min(minX, nx-nex); maxX = Math.max(maxX, nx+nex); minY = Math.min(minY, ny-ney); maxY = Math.max(maxY, ny+ney); minZ = Math.min(minZ, nz-nez); maxZ = Math.max(maxZ, nz+nez);
        }
        worldBox.min.set(minX, minY, minZ); worldBox.max.set(maxX, maxY, maxZ);
    } else {
        worldBox.copy(getSelectionBoundingBox(currentSelection));
    }
    if (worldBox.isEmpty()) return;
    const geo = createEdgesGeometryFromBox3(worldBox);
    if (geo) { if (activeBoxLine.geometry) activeBoxLine.geometry.dispose(); activeBoxLine.geometry = geo; }
}

export function syncSelectionPointsOverlay(delta: THREE.Vector3): void {
    if (selectionPointsOverlay) { selectionPointsOverlay.position.add(delta); selectionPointsOverlay.updateMatrixWorld(true); }
}

export function syncSelectionOverlay(deltaMatrix: THREE.Matrix4): void {
    if (!selectionOverlay && !selectionPointsOverlay) return;
    if (selectionOverlay) {
        const updateMesh = (mesh: THREE.InstancedMesh) => {
            const items = mesh.userData['items'] as OverlayItem[];
            for (let i = 0; i < mesh.count; i++) {
                const src = items[i]?.source;
                if (!src) continue;
                const tempMat = new THREE.Matrix4();
                if (src.type === 'group' && src.id) {
                    const groupWorld = getGroupWorldMatrixWithFallback(src.id, new THREE.Matrix4());
                    if (src.cachedLocalCenter && src.cachedLocalSize) tempMat.makeTranslation(src.cachedLocalCenter.x, src.cachedLocalCenter.y, src.cachedLocalCenter.z).scale(src.cachedLocalSize).premultiply(groupWorld);
                    else { const lb = getGroupLocalBoundingBox(src.id); if (!lb.isEmpty()) { lb.getCenter(_TMP_VEC3_A); lb.getSize(_TMP_VEC3_B); tempMat.makeTranslation(_TMP_VEC3_A.x, _TMP_VEC3_A.y, _TMP_VEC3_A.z).scale(_TMP_VEC3_B).premultiply(groupWorld); } }
                } else if (src.type === 'object' && src.mesh && src.instanceId !== undefined) {
                    const worldMat = getInstanceWorldMatrix(src.mesh, src.instanceId, new THREE.Matrix4());
                    if (src.cachedLocalCenter && src.cachedLocalSize) tempMat.makeTranslation(src.cachedLocalCenter.x, src.cachedLocalCenter.y, src.cachedLocalCenter.z).scale(src.cachedLocalSize).premultiply(worldMat);
                    else { const lb = getInstanceLocalBox(src.mesh, src.instanceId); if (lb) { lb.getCenter(_TMP_VEC3_A); lb.getSize(_TMP_VEC3_B); tempMat.makeTranslation(_TMP_VEC3_A.x, _TMP_VEC3_A.y, _TMP_VEC3_A.z).scale(_TMP_VEC3_B).premultiply(worldMat); } }
                }
                mesh.setMatrixAt(i, tempMat);
            }
            mesh.instanceMatrix.needsUpdate = true;
        };
        if (selectionOverlay instanceof THREE.Group) selectionOverlay.children.forEach(c => updateMesh(c as THREE.InstancedMesh));
        else updateMesh(selectionOverlay as THREE.InstancedMesh);
    }
    if (selectionPointsOverlay) { selectionPointsOverlay.applyMatrix4(deltaMatrix); selectionPointsOverlay.updateMatrixWorld(true); }
}

export function findClosestVertexForSnapping(gizmoWorldPos: THREE.Vector3, camera: THREE.Camera, renderer: THREE.Renderer, snapThreshold = 15): THREE.Vector3 | null {
    if (!selectionPointsOverlay) return null;
    const rect = renderer.domElement.getBoundingClientRect();
    const gScreen = _TMP_VEC3_B.copy(gizmoWorldPos).project(camera);
    const gx = (gScreen.x * 0.5 + 0.5) * rect.width, gy = (1 - (gScreen.y * 0.5 + 0.5)) * rect.height;
    let minDSq = snapThreshold * snapThreshold, target: THREE.Vector3 | null = null;
    selectionPointsOverlay.children.forEach(c => {
        if (!(c as THREE.Sprite).isSprite || c.userData['isCenter']) return;
        const vS = _TMP_VEC3_A.copy(c.position).project(camera);
        const vx = (vS.x * 0.5 + 0.5) * rect.width, vy = (1 - (vS.y * 0.5 + 0.5)) * rect.height;
        const dSq = (vx-gx)**2 + (vy-gy)**2;
        if (dSq < minDSq) { minDSq = dSq; target = c.position; }
    });
    return target;
}

export function getHoveredVertex(mouseNDC: THREE.Vector2, camera: THREE.Camera, renderer: THREE.Renderer): THREE.Sprite | null {
    if (!selectionPointsOverlay) return null;
    const canvas = renderer.domElement;
    const mx = (mouseNDC.x * 0.5 + 0.5) * canvas.clientWidth, my = (-mouseNDC.y * 0.5 + 0.5) * canvas.clientHeight;
    let bestDSq = 100, best: THREE.Sprite | null = null;
    selectionPointsOverlay.children.forEach(s => {
        if (!(s as THREE.Sprite).isSprite) return;
        const vS = _TMP_VEC3_A.copy(s.position).project(camera);
        if (vS.z < -1 || vS.z > 1) return;
        const sx = (vS.x * 0.5 + 0.5) * canvas.clientWidth, sy = (-vS.y * 0.5 + 0.5) * canvas.clientHeight;
        const dSq = (sx-mx)**2 + (sy-my)**2;
        if (dSq < bestDSq) { bestDSq = dSq; best = s as THREE.Sprite; }
    });
    return best;
}

export function updateVertexHoverHighlight(hoveredSprite: THREE.Sprite | null, selectedVertexKeys: Set<string>): void {
    if (!selectionPointsOverlay) return;
    let selected: THREE.Sprite | null = null, existingLine: THREE.Line | null = null;
    selectionPointsOverlay.children.forEach(c => {
        if (c.name === 'VertexHoverLine') { existingLine = c as THREE.Line; return; }
        if (!(c as THREE.Sprite).isSprite) return;
        const s = c as THREE.Sprite, key = s.userData['key'] as string | undefined;
        const isSel = key && selectedVertexKeys.has(key);
        if (isSel) selected = s;
        s.material.color.setHex((s === hoveredSprite || isSel) ? 0x437FD0 : 0x30333D);
    });
    if (selectedVertexKeys.size === 1 && hoveredSprite && selected && hoveredSprite !== selected) {
        if (!existingLine) {
            const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints([selected.position, hoveredSprite.position]), new THREE.LineBasicMaterial({ color: 0x437FD0, depthTest: false, transparent: true }));
            l.name = 'VertexHoverLine'; selectionPointsOverlay.add(l);
        } else existingLine.geometry.setFromPoints([selected.position, hoveredSprite.position]);
    } else if (existingLine) { selectionPointsOverlay.remove(existingLine); existingLine.geometry.dispose(); (existingLine.material as THREE.Material).dispose(); }
}

export function findSpritesByKeys(keys: string[]): Record<string, THREE.Sprite> {
    const res: Record<string, THREE.Sprite> = {}, set = new Set(keys);
    selectionPointsOverlay?.children.forEach(c => { if ((c as THREE.Sprite).isSprite && c.userData['key'] && set.has(c.userData['key'])) res[c.userData['key'] as string] = c as THREE.Sprite; });
    return res;
}

export function refreshSelectionPointColors(selectedVertexKeys: Set<string>): void {
    selectionPointsOverlay?.children.forEach(s => { if ((s as THREE.Sprite).isSprite && s.userData['key']) (s as THREE.Sprite).material.color.setHex(selectedVertexKeys.has(s.userData['key'] as string) ? 0x437FD0 : 0x30333D); });
}
