import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import * as THREE from 'three/webgpu';

// Small shared temporaries (avoid allocations in hot paths)
const _TMP_MAT4_A = new THREE.Matrix4();
const _TMP_MAT4_B = new THREE.Matrix4();
const _TMP_BOX3_A = new THREE.Box3();
const _TMP_VEC3_A = new THREE.Vector3();
const _TMP_VEC3_B = new THREE.Vector3();

function getDisplayType(mesh, instanceId) {
    if (!mesh) return undefined;
    if (mesh.isBatchedMesh && mesh.userData?.displayTypes) {
        return mesh.userData.displayTypes.get(instanceId);
    }
    return mesh.userData?.displayType;
}

function isItemDisplayHatEnabled(mesh, instanceId) {
    return !!(getDisplayType(mesh, instanceId) === 'item_display' && mesh?.userData?.hasHat && mesh.userData.hasHat[instanceId]);
}

function getInstanceLocalBoxMin(mesh, instanceId, out = new THREE.Vector3()) {
    const box = getInstanceLocalBox(mesh, instanceId);
    if (!box) return null;
    return out.copy(box.min);
}

// Used for origin/center computations where BatchedMesh localMatrices should be removed.
function getInstanceWorldMatrixForOrigin(mesh, instanceId, outMatrix) {
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

function calculateAvgOriginForChildren(children, out = new THREE.Vector3()) {
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

function getGroupWorldMatrixWithFallback(groupId, out = new THREE.Matrix4()) {
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
    if (!group.quaternion) group.quaternion = new THREE.Quaternion();
    if (!group.scale) group.scale = new THREE.Vector3(1, 1, 1);
    return out.compose(gPos, group.quaternion, group.scale);
}

function createEdgesGeometryFromBox3(box) {
    if (!box || box.isEmpty()) return null;
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);
    const boxGeo = new THREE.BoxGeometry(size.x, size.y, size.z);
    boxGeo.translate(center.x, center.y, center.z);
    return new THREE.EdgesGeometry(boxGeo);
}

function unionTransformedBox3(targetBox, localBox, matrix, tempBox = _TMP_BOX3_A) {
    if (!targetBox || !localBox) return;
    tempBox.copy(localBox).applyMatrix4(matrix);
    targetBox.union(tempBox);
}

function getInstanceLocalBox(mesh, instanceId) {
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

    // Player Head: when hat is disabled, treat as 1x1x1 around center (matches existing selection bounding logic)
    if (getDisplayType(mesh, instanceId) === 'item_display' && mesh.userData?.hasHat && !mesh.userData.hasHat[instanceId]) {
        const center = new THREE.Vector3();
        box.getCenter(center);
        box = new THREE.Box3().setFromCenterAndSize(center, new THREE.Vector3(1, 1, 1));
    }

    return box;
}

function getInstanceWorldMatrix(mesh, instanceId, outMatrix) {
    outMatrix.identity();
    if (!mesh) return outMatrix;
    mesh.getMatrixAt(instanceId, outMatrix);
    outMatrix.premultiply(mesh.matrixWorld);
    return outMatrix;
}

function pickInstanceByOverlayBox(raycaster, rootGroup) {
    const rayWorld = raycaster.ray.clone();
    const best = { mesh: null, instanceId: undefined, distance: Infinity };
    const tmpWorldMatrix = new THREE.Matrix4();
    const tmpInvWorldMatrix = new THREE.Matrix4();
    const tmpLocalRay = new THREE.Ray();
    const tmpHitLocal = new THREE.Vector3();
    const tmpHitWorld = new THREE.Vector3();

    rootGroup.traverse((obj) => {
        if (!obj || (!obj.isInstancedMesh && !obj.isBatchedMesh)) return;
        if (!raycaster.layers.test(obj.layers)) return;

        const mesh = obj;

        let instanceCount = 0;
        if (mesh.isInstancedMesh) {
            instanceCount = mesh.count ?? 0;
        } else {
            const geomIds = mesh.userData?.instanceGeometryIds;
            instanceCount = Array.isArray(geomIds) ? geomIds.length : 0;
        }

        if (instanceCount <= 0) return;

        for (let instanceId = 0; instanceId < instanceCount; instanceId++) {
            const localBox = getInstanceLocalBox(mesh, instanceId);
            if (!localBox) continue;

            getInstanceWorldMatrix(mesh, instanceId, tmpWorldMatrix);
            tmpInvWorldMatrix.copy(tmpWorldMatrix).invert();

            tmpLocalRay.copy(rayWorld).applyMatrix4(tmpInvWorldMatrix);
            const hit = tmpLocalRay.intersectBox(localBox, tmpHitLocal);
            if (!hit) continue;

            tmpHitWorld.copy(tmpHitLocal).applyMatrix4(tmpWorldMatrix);
            const dist = rayWorld.origin.distanceTo(tmpHitWorld);
            if (dist < best.distance) {
                best.mesh = mesh;
                best.instanceId = instanceId;
                best.distance = dist;
            }
        }
    });

    if (!best.mesh || best.instanceId === undefined) return null;
    return { mesh: best.mesh, instanceId: best.instanceId };
}

// Group Data Structures
function getGroups() {
    if (!loadedObjectGroup.userData.groups) {
        loadedObjectGroup.userData.groups = new Map();
    }
    return loadedObjectGroup.userData.groups;
}

function getObjectToGroup() {
    if (!loadedObjectGroup.userData.objectToGroup) {
        loadedObjectGroup.userData.objectToGroup = new Map();
    }
    return loadedObjectGroup.userData.objectToGroup;
}

function getGroupKey(mesh, instanceId) {
    return `${mesh.uuid}_${instanceId}`;
}

function getGroupChain(startGroupId) {
    const groups = getGroups();
    const chain = [];
    let currentId = startGroupId;
    while (currentId) {
        const group = groups.get(currentId);
        if (!group) break;
        chain.unshift(currentId); // [Root, ..., Parent]
        currentId = group.parent;
    }
    return chain;
}

function getAllGroupChildren(groupId) {
    const groups = getGroups();
    const group = groups.get(groupId);
    if (!group) return [];

    const out = [];
    const stack = Array.isArray(group.children) ? group.children.slice().reverse() : [];
    while (stack.length > 0) {
        const child = stack.pop();
        if (!child) continue;

        if (child.type === 'group') {
            const sub = groups.get(child.id);
            if (sub && Array.isArray(sub.children) && sub.children.length > 0) {
                for (let i = sub.children.length - 1; i >= 0; i--) {
                    stack.push(sub.children[i]);
                }
            }
        } else {
            out.push(child);
        }
    }
    return out;
}

function getAllDescendantGroups(groupId) {
    const groups = getGroups();
    const group = groups.get(groupId);
    if (!group) return [];

    const out = [];
    const stack = [];
    if (Array.isArray(group.children)) {
        for (let i = group.children.length - 1; i >= 0; i--) {
            const child = group.children[i];
            if (child && child.type === 'group') stack.push(child.id);
        }
    }

    while (stack.length > 0) {
        const id = stack.pop();
        if (!id) continue;
        out.push(id);
        const sub = groups.get(id);
        if (!sub || !Array.isArray(sub.children)) continue;
        for (let i = sub.children.length - 1; i >= 0; i--) {
            const child = sub.children[i];
            if (child && child.type === 'group') stack.push(child.id);
        }
    }
    return out;
}

// Group Pivot Helpers
const _DEFAULT_GROUP_PIVOT = new THREE.Vector3(0.5, 0.5, 0.5);
const _ZERO_VEC3 = new THREE.Vector3(0, 0, 0);

function _nearlyEqual(a, b, eps = 1e-6) {
    return Math.abs(a - b) <= eps;
}

function normalizePivotToVector3(pivot, out = new THREE.Vector3()) {
    if (!pivot) return null;
    if (pivot.isVector3) return out.copy(pivot);
    if (Array.isArray(pivot) && pivot.length >= 3) return out.set(pivot[0], pivot[1], pivot[2]);
    if (typeof pivot === 'object' && pivot.x !== undefined && pivot.y !== undefined && pivot.z !== undefined) {
        return out.set(pivot.x, pivot.y, pivot.z);
    }
    return null;
}

function isCustomGroupPivot(pivot) {
    const v = normalizePivotToVector3(pivot, new THREE.Vector3());
    if (!v) return false;
    return !(
        _nearlyEqual(v.x, _DEFAULT_GROUP_PIVOT.x) &&
        _nearlyEqual(v.y, _DEFAULT_GROUP_PIVOT.y) &&
        _nearlyEqual(v.z, _DEFAULT_GROUP_PIVOT.z)
    );
}

function getGroupWorldMatrix(group, out = new THREE.Matrix4()) {
    out.identity();
    if (!group) return out;
    if (group.matrix) return out.copy(group.matrix);

    const gPos = group.position || new THREE.Vector3();
    const gQuat = group.quaternion || new THREE.Quaternion();
    const gScale = group.scale || new THREE.Vector3(1, 1, 1);
    return out.compose(gPos, gQuat, gScale);
}

function shouldUseGroupPivot(group) {
    if (!group) return false;
    if (group.isCustomPivot) return true;
    return isCustomGroupPivot(group.pivot);
}

// Baseline origin used by SelectionCenter for groups in pivotMode === 'origin' (without pivotOffset).
function getGroupOriginWorld(groupId, out = new THREE.Vector3()) {
    const groups = getGroups();
    const group = groups.get(groupId);
    if (!group) return out.set(0, 0, 0);

    const box = getGroupLocalBoundingBox(groupId);
    if (!box.isEmpty()) {
        const m = getGroupWorldMatrix(group, new THREE.Matrix4());
        return out.copy(box.min).applyMatrix4(m);
    }
    if (group.position) return out.copy(group.position);
    return out.copy(calculateAvgOrigin());
}

// Selection caches (critical for performance when group has many children)
let _selectedItemsCacheKey = null;
let _selectedItemsCache = null;
let _descendantGroupsCacheKey = null;
let _descendantGroupsCache = null;

function _getSelectionCacheKey() {
    if (currentSelection.groupId) return `g:${currentSelection.groupId}`;
    if (currentSelection.mesh && currentSelection.instanceIds && currentSelection.instanceIds.length > 0) {
        return `m:${currentSelection.mesh.uuid}:${currentSelection.instanceIds.join(',')}`;
    }
    return 'none';
}

function invalidateSelectionCaches() {
    _selectedItemsCacheKey = null;
    _selectedItemsCache = null;
    _descendantGroupsCacheKey = null;
    _descendantGroupsCache = null;
}

function getAllDescendantGroupsCached(groupId) {
    if (_descendantGroupsCacheKey === groupId && _descendantGroupsCache) return _descendantGroupsCache;
    _descendantGroupsCacheKey = groupId;
    _descendantGroupsCache = getAllDescendantGroups(groupId);
    return _descendantGroupsCache;
}

// Unified helper to get flat list of selected targets
function getSelectedItems() {
    const key = _getSelectionCacheKey();
    if (_selectedItemsCacheKey === key && _selectedItemsCache) return _selectedItemsCache;

    let items = [];
    if (currentSelection.groupId) {
        items = getAllGroupChildren(currentSelection.groupId)
            .map(child => ({ mesh: child.mesh, instanceId: child.instanceId }))
            .filter(it => it.mesh);
    } else if (currentSelection.mesh && currentSelection.instanceIds.length > 0) {
        const mesh = currentSelection.mesh;
        items = currentSelection.instanceIds.map(id => ({ mesh, instanceId: id }));
    }

    _selectedItemsCacheKey = key;
    _selectedItemsCache = items;
    return items;
}

function getSelectionBoundingBox() {
    const items = getSelectedItems();
    const box = new THREE.Box3();
    const tempMat = new THREE.Matrix4();
    const tempBox = new THREE.Box3();

    if (items.length === 0) return box;

    items.forEach(({ mesh, instanceId: id }) => {
        if (!mesh) return;
        const localBox = getInstanceLocalBox(mesh, id);
        if (!localBox) return;

        getInstanceWorldMatrix(mesh, id, tempMat);
        tempBox.copy(localBox).applyMatrix4(tempMat);
        box.union(tempBox);
    });
    return box;
}

function getGroupLocalBoundingBox(groupId) {
    const groups = getGroups();
    const group = groups.get(groupId);
    if (!group) return new THREE.Box3();

    const groupMatrix = getGroupWorldMatrixWithFallback(groupId, new THREE.Matrix4());
    const groupInverse = groupMatrix.clone().invert();

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

let scene, camera, renderer, controls, loadedObjectGroup;
let transformControls = null;
let selectionHelper = null;
let previousHelperMatrix = new THREE.Matrix4();

// Selection State
let currentSelection = {
    mesh: null,
    instanceIds: [],
    edgesGeometry: null,
    groupId: null
};

let pivotMode = 'origin';
let currentSpace = 'world';
let selectionOverlay = null;
let lastDirections = { X: null, Y: null, Z: null };
let gizmoLines = {
  X: { original: [], negative: [] },
  Y: { original: [], negative: [] },
  Z: { original: [], negative: [] }
};

// drag state
const dragInitialMatrix = new THREE.Matrix4();
const dragInitialQuaternion = new THREE.Quaternion();
const dragInitialScale = new THREE.Vector3();
const dragInitialPosition = new THREE.Vector3();
const dragInitialBoundingBox = new THREE.Box3();
const dragStartAvgOrigin = new THREE.Vector3();
const dragStartPivotBaseWorld = new THREE.Vector3();
let draggingMode = null;
let isGizmoBusy = false;
let blockbenchScaleMode = false;
let dragAnchorDirections = { x: true, y: true, z: true };
let previousGizmoMode = 'translate';
let isPivotEditMode = false;
let isUniformScale = false;
let isCustomPivot = false;
let pivotOffset = new THREE.Vector3(0, 0, 0);

// Reusable temporaries (avoid allocations during dragging)
const _tmpPrevInvMatrix = new THREE.Matrix4();
const _tmpDeltaMatrix = new THREE.Matrix4();
const _tmpInstanceMatrix = new THREE.Matrix4();
const _tmpMeshWorldInverse = new THREE.Matrix4();
const _tmpLocalDelta = new THREE.Matrix4();
const _meshToInstanceIds = new Map();

// Helpers
function getRotationFromMatrix(matrix) {
    const R = new THREE.Matrix4();
    const x = new THREE.Vector3().setFromMatrixColumn(matrix, 0);
    const y = new THREE.Vector3().setFromMatrixColumn(matrix, 1);
    const z = new THREE.Vector3().setFromMatrixColumn(matrix, 2);

    x.normalize();
    const yDotX = y.dot(x);
    y.sub(x.clone().multiplyScalar(yDotX)).normalize();
    z.crossVectors(x, y).normalize();
    R.makeBasis(x, y, z);
    const quaternion = new THREE.Quaternion();
    quaternion.setFromRotationMatrix(R);
    return quaternion;
}

function SelectionCenter(pivotMode, isCustomPivot, pivotOffset) {
    const center = new THREE.Vector3();
    const items = getSelectedItems();
    
    if (items.length === 0) return center;

    if (pivotMode === 'center') {
        const box = getSelectionBoundingBox();
        box.getCenter(center);
    } else {
        // Origin (Average Position)
        if (currentSelection.groupId) {
             const groups = getGroups();
             const group = groups.get(currentSelection.groupId);
             
             const box = getGroupLocalBoundingBox(currentSelection.groupId);
             if (!box.isEmpty()) {
                 const groupMatrix = getGroupWorldMatrixWithFallback(currentSelection.groupId, new THREE.Matrix4());
                 center.copy(box.min).applyMatrix4(groupMatrix);
             } else if (group && group.position) {
                 center.copy(group.position);
             } else {
                 center.copy(calculateAvgOrigin());
             }
        } else {
             const firstItem = items[0];
             const mesh = firstItem.mesh;
             const displayType = getDisplayType(mesh, firstItem.instanceId);

             const isBlockDisplayWithoutCustomPivot = displayType === 'block_display' && !isCustomPivot;
             if (isBlockDisplayWithoutCustomPivot) {
                 const localPivot = getInstanceLocalBoxMin(mesh, firstItem.instanceId, new THREE.Vector3(0, 0, 0));
                 if (localPivot) {
                     const worldMatrix = getInstanceWorldMatrixForOrigin(mesh, firstItem.instanceId, new THREE.Matrix4());
                     center.copy(localPivot.applyMatrix4(worldMatrix));
                 } else {
                     center.copy(calculateAvgOrigin());
                 }
             } else {
                 center.copy(calculateAvgOrigin());
             }
        }
    }

    if (pivotMode === 'origin') {
        center.add(pivotOffset);
    }

    return center;
}

function calculateAvgOrigin() {
    const center = new THREE.Vector3();
    const items = getSelectedItems();
    
    if (items.length === 0) return center;

    const tempPos = new THREE.Vector3();
    const tempMat = new THREE.Matrix4();
    
    items.forEach(({mesh, instanceId}) => {
        getInstanceWorldMatrixForOrigin(mesh, instanceId, tempMat);
        const localY = isItemDisplayHatEnabled(mesh, instanceId) ? 0.03125 : 0;
        tempPos.set(0, localY, 0).applyMatrix4(tempMat);
        center.add(tempPos);
    });
    
    center.divideScalar(items.length);
    return center;
}

function updateSelectionOverlay() {
    if (selectionOverlay) {
        scene.remove(selectionOverlay);
        selectionOverlay.traverse(child => {
            if (child.geometry && child.geometry !== currentSelection.edgesGeometry) child.geometry.dispose();
            if (child.material) child.material.dispose();
        });
        selectionOverlay = null;
    }

    if (currentSelection.groupId) {
        const groups = getGroups();
        const group = groups.get(currentSelection.groupId);
        
        const localBox = getGroupLocalBoundingBox(currentSelection.groupId);
        if (localBox.isEmpty()) return;

        const edgesGeo = createEdgesGeometryFromBox3(localBox);
        if (!edgesGeo) return;
        
        const overlayMaterial = new THREE.LineBasicMaterial({
            color: 0x6FA21C,
            depthTest: true,
            depthWrite: false,
            transparent: true,
            opacity: 0.9
        });

        selectionOverlay = new THREE.LineSegments(edgesGeo, overlayMaterial);
        
        selectionOverlay.matrixAutoUpdate = false;
        selectionOverlay.matrix.copy(getGroupWorldMatrixWithFallback(currentSelection.groupId, new THREE.Matrix4()));
        selectionOverlay.updateMatrixWorld(true);

        selectionOverlay.renderOrder = 1;
        scene.add(selectionOverlay);
        return;
    }

    if (!currentSelection.mesh || currentSelection.instanceIds.length === 0) return;

    const mesh = currentSelection.mesh;
    
    if (!currentSelection.edgesGeometry) {
        const id0 = currentSelection.instanceIds[0];
        const localBox = getInstanceLocalBox(mesh, id0);
        if (!localBox) return;
        currentSelection.edgesGeometry = createEdgesGeometryFromBox3(localBox);
    }
    
    if (!currentSelection.edgesGeometry) return;
    const edgesGeo = currentSelection.edgesGeometry;

    const displayType = getDisplayType(mesh, currentSelection.instanceIds[0]);

    const overlayColor = displayType === 'item_display' ? 0x2E87EC : 0xFFD147;

    const overlayMaterial = new THREE.LineBasicMaterial({
        color: overlayColor,
        depthTest: true,
        depthWrite: false,
        transparent: true,
        opacity: 0.9
    });

    selectionOverlay = new THREE.Group();
    selectionOverlay.renderOrder = 1;
    selectionOverlay.matrixAutoUpdate = false;
    selectionOverlay.matrix.identity();

    const tempMat = new THREE.Matrix4();
    for (const id of currentSelection.instanceIds) {
        mesh.getMatrixAt(id, tempMat);
        const line = new THREE.LineSegments(edgesGeo, overlayMaterial);
        line.matrixAutoUpdate = false;
        line.matrix.multiplyMatrices(mesh.matrixWorld, tempMat);
        selectionOverlay.add(line);
    }
    selectionOverlay.updateMatrixWorld(true);
    scene.add(selectionOverlay);
}

function resetSelectionAndDeselect() {
    if (currentSelection.mesh || currentSelection.groupId) {
        transformControls.detach();
        if (currentSelection.edgesGeometry) {
            currentSelection.edgesGeometry.dispose();
            currentSelection.edgesGeometry = null;
        }
        currentSelection = { mesh: null, instanceIds: [], edgesGeometry: null, groupId: null };
        invalidateSelectionCaches();
        updateSelectionOverlay();
        lastDirections = { X: null, Y: null, Z: null };
        console.log('선택 해제');
    }
}

function updateHelperPosition() {
    const items = getSelectedItems();
    if (items.length === 0 && !currentSelection.groupId) return;

    const center = SelectionCenter(pivotMode, isCustomPivot, pivotOffset);

    selectionHelper.position.copy(center);
    
    if (currentSelection.groupId) {
        const groups = getGroups();
        const group = groups.get(currentSelection.groupId);
        if (currentSpace === 'world') {
            selectionHelper.quaternion.set(0, 0, 0, 1);
        } else if (group && group.quaternion) {
            selectionHelper.quaternion.copy(group.quaternion);
        } else {
            selectionHelper.quaternion.set(0, 0, 0, 1);
        }
        if (group && group.scale) {
            selectionHelper.scale.copy(group.scale);
        } else {
            selectionHelper.scale.set(1, 1, 1);
        }
    } else if (items.length > 0) {
        const firstItem = items[0];
        const instanceMatrix = new THREE.Matrix4();
        firstItem.mesh.getMatrixAt(firstItem.instanceId, instanceMatrix);
        const worldMatrix = instanceMatrix.premultiply(firstItem.mesh.matrixWorld);
        
        const quaternion = getRotationFromMatrix(worldMatrix);
        
        if (currentSpace === 'world') {
            selectionHelper.quaternion.set(0, 0, 0, 1);
        } else {
            selectionHelper.quaternion.copy(quaternion);
        }

        selectionHelper.scale.set(1, 1, 1);

    } else {
        selectionHelper.quaternion.set(0, 0, 0, 1);
        selectionHelper.scale.set(1, 1, 1);
    }

    selectionHelper.updateMatrixWorld();
    transformControls.attach(selectionHelper);
    previousHelperMatrix.copy(selectionHelper.matrixWorld);
}

function applySelection(mesh, instanceIds, groupId = null) {
    if (currentSelection.mesh && (currentSelection.mesh !== mesh || mesh?.isBatchedMesh)) {
        if (currentSelection.edgesGeometry) {
            currentSelection.edgesGeometry.dispose();
            currentSelection.edgesGeometry = null;
        }
    }

    let customPivot = null;
    if (groupId) {
        pivotOffset.set(0, 0, 0);
        isCustomPivot = false;
    } else if ((mesh.isBatchedMesh || mesh.isInstancedMesh) && mesh.userData.customPivots && instanceIds.length > 0) {
        if (mesh.userData.customPivots.has(instanceIds[0])) {
            customPivot = mesh.userData.customPivots.get(instanceIds[0]);
        }
    } else if (mesh.userData.customPivot) {
        customPivot = mesh.userData.customPivot;
    }

    currentSelection = { mesh, instanceIds, edgesGeometry: currentSelection.edgesGeometry, groupId };
    invalidateSelectionCaches();

    if (groupId) {
        const groups = getGroups();
        const group = groups.get(groupId);

        // Apply group pivot (from pbde-worker: group.pivot) only when it is actually custom.
        // When no custom pivot exists, Pivot Mode: origin should stick to the overlay corner (box.min) like block_display.
        if (group && shouldUseGroupPivot(group)) {
            const localPivot = normalizePivotToVector3(group.pivot, new THREE.Vector3());
            const groupMatrix = getGroupWorldMatrix(group, new THREE.Matrix4());
            const targetWorld = localPivot.clone().applyMatrix4(groupMatrix);
            const baseWorld = getGroupOriginWorld(groupId, new THREE.Vector3());
            pivotOffset.subVectors(targetWorld, baseWorld);
            isCustomPivot = true;
        } else {
            pivotOffset.set(0, 0, 0);
            isCustomPivot = false;
        }
    }
    
    if (customPivot && !groupId) {
        isCustomPivot = true;
        const center = calculateAvgOrigin();
        const firstId = instanceIds[0];
        const tempMat = new THREE.Matrix4();
        mesh.getMatrixAt(firstId, tempMat);
        const worldMatrix = tempMat.premultiply(mesh.matrixWorld);
        const targetWorld = customPivot.clone().applyMatrix4(worldMatrix);
        pivotOffset.subVectors(targetWorld, center);
    } else if (!groupId) {
        pivotOffset.set(0, 0, 0);
        isCustomPivot = false;
    }

    updateHelperPosition();
    updateSelectionOverlay();
    
    if (groupId) {
        console.log(`그룹 선택됨: ${groupId}`);
    } else {
        console.log(`선택됨: InstancedMesh (IDs: ${instanceIds.join(',')})`);
    }
}

function createGroup() {
    const items = getSelectedItems();
    if (items.length === 0 && !currentSelection.groupId) return;

    const groups = getGroups();
    const objectToGroup = getObjectToGroup();

    let initialPosition = new THREE.Vector3();
    if (currentSelection.groupId) {
        const existingGroup = groups.get(currentSelection.groupId);
        if (existingGroup.position) {
            initialPosition.copy(existingGroup.position);
        } else {
            initialPosition = calculateAvgOrigin();
        }
    } else {
        initialPosition = calculateAvgOrigin();
    }

    const newGroupId = THREE.MathUtils.generateUUID();
    const newGroup = {
        id: newGroupId,
        isCollection: true,
        children: [],
        parent: null,
        name: 'Group',
        position: initialPosition,
        quaternion: new THREE.Quaternion(),
        scale: new THREE.Vector3(1, 1, 1)
    };

    if (currentSelection.groupId) {
        const childGroupId = currentSelection.groupId;
        const childGroup = groups.get(childGroupId);
        
        if (childGroup.parent) {
            const parentGroup = groups.get(childGroup.parent);
            if (parentGroup) {
                parentGroup.children = parentGroup.children.filter(c => !(c.type === 'group' && c.id === childGroupId));
                parentGroup.children.push({ type: 'group', id: newGroupId });
                newGroup.parent = childGroup.parent;
            }
        }
        
        newGroup.children.push({ type: 'group', id: childGroupId });
        childGroup.parent = newGroupId;
        
    } else {
        const mesh = currentSelection.mesh;
        const instanceIds = currentSelection.instanceIds;
        
        let commonParentId = undefined;
        for (const id of instanceIds) {
            const key = getGroupKey(mesh, id);
            const gid = objectToGroup.get(key);
            if (commonParentId === undefined) {
                commonParentId = gid;
            } else if (commonParentId !== gid) {
                commonParentId = null;
                break;
            }
        }

        if (commonParentId) {
            newGroup.parent = commonParentId;
            const parentGroup = groups.get(commonParentId);
            if (parentGroup) {
                parentGroup.children.push({ type: 'group', id: newGroupId });
            }
        }

        instanceIds.forEach(id => {
            const key = getGroupKey(mesh, id);
            const oldGroupId = objectToGroup.get(key);
            if (oldGroupId) {
                const oldGroup = groups.get(oldGroupId);
                if (oldGroup) {
                    oldGroup.children = oldGroup.children.filter(c => !(c.type === 'object' && c.mesh === mesh && c.instanceId === id));
                }
            }
            newGroup.children.push({ type: 'object', mesh, instanceId: id });
            objectToGroup.set(key, newGroupId);
        });
    }

    groups.set(newGroupId, newGroup);
    invalidateSelectionCaches();
    applySelection(null, [], newGroupId);
    console.log(`Group created: ${newGroupId}`);
    return newGroupId;
}

function initGizmo({scene: s, camera: cam, renderer: rend, controls: orbitControls, loadedObjectGroup: lg, setControls}) {
    scene = s; camera = cam; renderer = rend; controls = orbitControls; loadedObjectGroup = lg;

    if (!loadedObjectGroup.userData.groups) loadedObjectGroup.userData.groups = new Map();
    if (!loadedObjectGroup.userData.objectToGroup) loadedObjectGroup.userData.objectToGroup = new Map();

    selectionHelper = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.1), new THREE.MeshBasicMaterial({ visible: false }));
    scene.add(selectionHelper);

    const mouseInput = new THREE.Vector2();
    let detectedAnchorDirections = { x: null, y: null, z: null };

    renderer.domElement.addEventListener('pointerdown', (event) => {
        const rect = renderer.domElement.getBoundingClientRect();
        mouseInput.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        mouseInput.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

        detectedAnchorDirections = { x: null, y: null, z: null };

        if (!transformControls.dragging) {
            raycaster.setFromCamera(mouseInput, camera);
            const gizmo = transformControls.getHelper();
            const intersects = raycaster.intersectObject(gizmo, true);

            if (intersects.length > 0) {
                const object = intersects[0].object;
                if (object.name === 'XYZ') {
                    isUniformScale = true;
                } else {
                    isUniformScale = false;
                    const check = (axis) => {
                        if (gizmoLines[axis].negative.includes(object)) return false;
                        if (gizmoLines[axis].original.includes(object)) return true;
                        return null;
                    };
                    detectedAnchorDirections.x = check('X');
                    detectedAnchorDirections.y = check('Y');
                    detectedAnchorDirections.z = check('Z');
                }
            }
        }
    }, true);

    transformControls = new TransformControls(camera, renderer.domElement);
    transformControls.setMode('translate');
    transformControls.setSpace('world');
    transformControls.setColors(0xEF3751, 0x6FA21C, 0x437FD0, 0xfeff3e);
    scene.add(transformControls.getHelper());

    try {
        const gizmoRoot = transformControls.getHelper();
        const gizmoContainer = gizmoRoot.children[0];
        const processedMeshes = new Set();
        ['translate', 'scale'].forEach(mode => {
            const modeGizmo = gizmoContainer.gizmo[mode];
            if (modeGizmo) {
                const originalLines = [];
                modeGizmo.traverse((child) => {
                    if (child.isMesh && (child.name === 'X' || child.name === 'Y' || child.name === 'Z')) {
                        if (!processedMeshes.has(child)) {
                            originalLines.push(child);
                            processedMeshes.add(child);
                        }
                    }
                });
                originalLines.forEach(originalLine => {
                    const negativeGeometry = originalLine.geometry.clone();
                    if (originalLine.name === 'X') {
                        negativeGeometry.rotateY(Math.PI);
                    } else if (originalLine.name === 'Y') {
                        negativeGeometry.rotateX(Math.PI);
                    } else if (originalLine.name === 'Z') {
                        negativeGeometry.rotateY(Math.PI);
                    }

                    originalLine.material = originalLine.material.clone();

                    const negativeMaterial = originalLine.material.clone();
                    negativeMaterial.transparent = true;
                    negativeMaterial._opacity = 0.001;
                    negativeMaterial.opacity = 0.001;
                    originalLine.material.transparent = true;
                    originalLine.material._opacity = originalLine.material._opacity || 1;
                    originalLine.material.opacity = originalLine.material._opacity;
                    const negativeLine = new THREE.Mesh(negativeGeometry, negativeMaterial);
                    negativeLine.name = originalLine.name;
                    negativeLine.material._opacity = negativeLine.material._opacity || negativeLine.material.opacity;
                    negativeLine.renderOrder = originalLine.renderOrder + 1;
                    originalLine.material.transparent = true;
                    originalLine.parent.add(negativeLine);
                    if (originalLine.name === 'X') {
                        gizmoLines.X.original.push(originalLine);
                        gizmoLines.X.negative.push(negativeLine);
                    } else if (originalLine.name === 'Y') {
                        gizmoLines.Y.original.push(originalLine);
                        gizmoLines.Y.negative.push(negativeLine);
                    } else if (originalLine.name === 'Z') {
                        gizmoLines.Z.original.push(originalLine);
                        gizmoLines.Z.negative.push(negativeLine);
                    }
                });
            }
        });
    } catch (error) {
        console.error('TransformControls gizmo patch (clone method) failed:', error);
    }

    transformControls.addEventListener('dragging-changed', (event) => {
        controls.enabled = !event.value;
        if (event.value) {
            draggingMode = transformControls.mode;
            if (transformControls.axis === 'XYZ') isUniformScale = true;

            dragInitialMatrix.copy(selectionHelper.matrix);
            dragInitialQuaternion.copy(selectionHelper.quaternion);
            dragInitialScale.copy(selectionHelper.scale);
            dragInitialPosition.copy(selectionHelper.position);

            if (isPivotEditMode) {
                  // Pivot edit: compute pivotOffset relative to the same baseline that SelectionCenter(origin) uses.
                  dragStartPivotBaseWorld.copy(SelectionCenter('origin', false, _ZERO_VEC3));
                  dragStartAvgOrigin.copy(calculateAvgOrigin());
            }

            if (blockbenchScaleMode && draggingMode === 'scale' && !isUniformScale) {
                dragInitialBoundingBox.makeEmpty();
                
                if (currentSelection.groupId) {
                    const groupBox = getGroupLocalBoundingBox(currentSelection.groupId);
                    if (!groupBox.isEmpty()) {
                        const groupMatrix = getGroupWorldMatrixWithFallback(currentSelection.groupId, new THREE.Matrix4());
                        
                        selectionHelper.updateMatrixWorld();
                        const inverseHelperMat = selectionHelper.matrixWorld.clone().invert();
                        const transformMat = inverseHelperMat.multiply(groupMatrix);

                        unionTransformedBox3(dragInitialBoundingBox, groupBox, transformMat);
                    }
                } else {
                    const items = getSelectedItems();
                    if (items.length > 0) {
                        selectionHelper.updateMatrixWorld();
                        const inverseHelperMat = selectionHelper.matrixWorld.clone().invert();
                        const tempMat = new THREE.Matrix4();

                        items.forEach(({mesh, instanceId}) => {
                            const localBox = getInstanceLocalBox(mesh, instanceId);
                            if (!localBox) return;

                            getInstanceWorldMatrix(mesh, instanceId, tempMat);

                            const combinedMat = _TMP_MAT4_A.copy(inverseHelperMat).multiply(tempMat);
                            unionTransformedBox3(dragInitialBoundingBox, localBox, combinedMat);
                        });
                    }
                }

                const gizmoPos = selectionHelper.position.clone();
                const gizmoNDC = gizmoPos.clone().project(camera);
                gizmoNDC.z = 0;

                const checkAxis = (x, y, z) => {
                    const axisVec = new THREE.Vector3(x, y, z);
                    if (currentSpace === 'local') {
                        axisVec.applyQuaternion(selectionHelper.quaternion);
                    }
                    
                    const origin = selectionHelper.position.clone();
                    const target = origin.clone().add(axisVec);
                    
                    origin.project(camera);
                    target.project(camera);
                    
                    const dir = new THREE.Vector2(target.x - origin.x, target.y - origin.y);
                    const mouse = new THREE.Vector2(mouseInput.x - origin.x, mouseInput.y - origin.y);
                    
                    return mouse.dot(dir) > 0;
                };

                dragAnchorDirections = {
                    x: detectedAnchorDirections.x !== null ? detectedAnchorDirections.x : checkAxis(1, 0, 0),
                    y: detectedAnchorDirections.y !== null ? detectedAnchorDirections.y : checkAxis(0, 1, 0),
                    z: detectedAnchorDirections.z !== null ? detectedAnchorDirections.z : checkAxis(0, 0, 1)
                };
            }

        } else {
            draggingMode = null;
            isUniformScale = false;

            if (isPivotEditMode) {
                if (currentSelection.groupId) {
                    const groups = getGroups();
                    const group = groups.get(currentSelection.groupId);
                    if (group) {
                        const pivotWorld = selectionHelper.position.clone();
                        const groupMatrix = getGroupWorldMatrix(group, new THREE.Matrix4());
                        const invGroupMatrix = groupMatrix.clone().invert();
                        const localPivot = pivotWorld.applyMatrix4(invGroupMatrix);

                        // Persist as group.pivot (compatible with pbde-worker payload shape).
                        group.pivot = localPivot.clone();
                        group.isCustomPivot = true;

                        // Ensure offset matches the baseline origin mode for groups.
                        const baseWorld = getGroupOriginWorld(currentSelection.groupId, new THREE.Vector3());
                        const targetWorld = localPivot.clone().applyMatrix4(groupMatrix);
                        pivotOffset.subVectors(targetWorld, baseWorld);
                        isCustomPivot = true;
                        pivotMode = 'origin';
                    }
                } else {
                    const items = getSelectedItems();
                    if (items.length > 0) {
                        const firstItem = items[0];
                        const mesh = firstItem.mesh;

                        const pivotWorld = selectionHelper.position.clone();
                        const instanceMatrix = new THREE.Matrix4();
                        mesh.getMatrixAt(firstItem.instanceId, instanceMatrix);
                        const worldMatrix = instanceMatrix.premultiply(mesh.matrixWorld);
                        const invWorldMatrix = worldMatrix.invert();
                        const localPivot = pivotWorld.applyMatrix4(invWorldMatrix);

                        if (mesh.isBatchedMesh || mesh.isInstancedMesh) {
                            if (!mesh.userData.customPivots) mesh.userData.customPivots = new Map();
                            items.forEach(({ instanceId }) => {
                                mesh.userData.customPivots.set(instanceId, localPivot.clone());
                            });
                        } else {
                            mesh.userData.customPivot = localPivot;
                        }

                        mesh.userData.isCustomPivot = true;
                        pivotMode = 'origin';
                    }
                }
            } else {
                if (currentSelection.groupId) {
                    const groups = getGroups();
                    const group = groups.get(currentSelection.groupId);
                    if (group && shouldUseGroupPivot(group)) {
                        const localPivot = normalizePivotToVector3(group.pivot, new THREE.Vector3());
                        if (localPivot) {
                            const groupMatrix = getGroupWorldMatrix(group, new THREE.Matrix4());
                            const targetWorld = localPivot.clone().applyMatrix4(groupMatrix);
                            const baseWorld = getGroupOriginWorld(currentSelection.groupId, new THREE.Vector3());
                            pivotOffset.subVectors(targetWorld, baseWorld);
                            isCustomPivot = true;
                        }
                    } else {
                        pivotOffset.set(0, 0, 0);
                        isCustomPivot = false;
                    }
                } else {
                    const items = getSelectedItems();
                    if (items.length > 0 && isCustomPivot) {
                        const firstItem = items[0];
                        const mesh = firstItem.mesh;
                        let customPivot = null;

                        if ((mesh.isBatchedMesh || mesh.isInstancedMesh) && mesh.userData.customPivots) {
                            if (mesh.userData.customPivots.has(firstItem.instanceId)) {
                                customPivot = mesh.userData.customPivots.get(firstItem.instanceId);
                            }
                        } else if (mesh.userData.customPivot) {
                            customPivot = mesh.userData.customPivot;
                        }

                        if (customPivot) {
                            mesh.updateMatrixWorld();
                            const center = calculateAvgOrigin();
                            const tempMat = new THREE.Matrix4();
                            mesh.getMatrixAt(firstItem.instanceId, tempMat);
                            const worldMatrix = tempMat.premultiply(mesh.matrixWorld);
                            const targetWorld = customPivot.clone().applyMatrix4(worldMatrix);
                            pivotOffset.subVectors(targetWorld, center);
                        }
                    }
                }
            }

            if (currentSelection.mesh) {
                currentSelection.mesh.boundingSphere = null;
            }

            if (selectionHelper) {
                selectionHelper.scale.set(1, 1, 1);
                selectionHelper.updateMatrixWorld();
                previousHelperMatrix.copy(selectionHelper.matrixWorld);
            }
        }
    });

    transformControls.addEventListener('change', (event) => {
        if (transformControls.dragging && (currentSelection.mesh || currentSelection.groupId)) {
            
            if (isPivotEditMode && transformControls.mode === 'translate') {
                // Keep pivotOffset consistent with SelectionCenter(origin) baseline (group uses box.min, block_display uses min when not custom).
                pivotOffset.subVectors(selectionHelper.position, dragStartPivotBaseWorld);
                isCustomPivot = true;
                previousHelperMatrix.copy(selectionHelper.matrixWorld);
                return;
            }

            if (blockbenchScaleMode && transformControls.mode === 'scale' && !isUniformScale) {
                 if (!dragInitialBoundingBox.isEmpty()) {
                    const deltaScale = selectionHelper.scale; 
                    const shift = new THREE.Vector3();
                    
                    if (Math.abs(deltaScale.x - dragInitialScale.x) > 0.0001) {
                        const isPositive = dragAnchorDirections.x;
                        const fixedVal = isPositive ? dragInitialBoundingBox.min.x : dragInitialBoundingBox.max.x;
                        shift.x = fixedVal * (dragInitialScale.x - deltaScale.x);
                    }
                    if (Math.abs(deltaScale.y - dragInitialScale.y) > 0.0001) {
                        const isPositive = dragAnchorDirections.y;
                        const fixedVal = isPositive ? dragInitialBoundingBox.min.y : dragInitialBoundingBox.max.y;
                        shift.y = fixedVal * (dragInitialScale.y - deltaScale.y);
                    }
                    if (Math.abs(deltaScale.z - dragInitialScale.z) > 0.0001) {
                        const isPositive = dragAnchorDirections.z;
                        const fixedVal = isPositive ? dragInitialBoundingBox.min.z : dragInitialBoundingBox.max.z;
                        shift.z = fixedVal * (dragInitialScale.z - deltaScale.z);
                    }
                    
                    const shiftWorld = shift.clone().applyQuaternion(selectionHelper.quaternion);
                    selectionHelper.position.copy(dragInitialPosition).add(shiftWorld);
                    selectionHelper.updateMatrixWorld();
                }
            }

            selectionHelper.updateMatrixWorld();
            _tmpPrevInvMatrix.copy(previousHelperMatrix).invert();
            _tmpDeltaMatrix.multiplyMatrices(selectionHelper.matrixWorld, _tmpPrevInvMatrix);

            const items = getSelectedItems();
            _meshToInstanceIds.clear();
            for (const { mesh, instanceId } of items) {
                if (!mesh) continue;
                let list = _meshToInstanceIds.get(mesh);
                if (!list) {
                    list = [];
                    _meshToInstanceIds.set(mesh, list);
                }
                list.push(instanceId);
            }

            for (const [mesh, instanceIds] of _meshToInstanceIds) {
                _tmpMeshWorldInverse.copy(mesh.matrixWorld).invert();
                _tmpLocalDelta.multiplyMatrices(_tmpMeshWorldInverse, _tmpDeltaMatrix);
                _tmpLocalDelta.multiply(mesh.matrixWorld);

                for (let i = 0; i < instanceIds.length; i++) {
                    const instanceId = instanceIds[i];
                    mesh.getMatrixAt(instanceId, _tmpInstanceMatrix);
                    _tmpInstanceMatrix.premultiply(_tmpLocalDelta);
                    mesh.setMatrixAt(instanceId, _tmpInstanceMatrix);
                }

                if (mesh.isInstancedMesh) {
                    mesh.instanceMatrix.needsUpdate = true;
                }
            }

            if (currentSelection.groupId) {
                const groups = getGroups();
                const group = groups.get(currentSelection.groupId);
                if (group) {
                    if (!group.matrix) {
                        const gPos = group.position || new THREE.Vector3();
                        const gQuat = group.quaternion || new THREE.Quaternion();
                        const gScale = group.scale || new THREE.Vector3(1, 1, 1);
                        group.matrix = new THREE.Matrix4().compose(gPos, gQuat, gScale);
                    }
                    group.matrix.premultiply(_tmpDeltaMatrix);
                    if (!group.position) group.position = new THREE.Vector3();
                    if (!group.quaternion) group.quaternion = new THREE.Quaternion();
                    if (!group.scale) group.scale = new THREE.Vector3(1, 1, 1);
                    group.matrix.decompose(group.position, group.quaternion, group.scale);
                }

                // Update descendant groups
                const descendantIds = getAllDescendantGroupsCached(currentSelection.groupId);
                descendantIds.forEach(subId => {
                    const subGroup = groups.get(subId);
                    if (subGroup) {
                        if (!subGroup.matrix) {
                            const sPos = subGroup.position || new THREE.Vector3();
                            const sQuat = subGroup.quaternion || new THREE.Quaternion();
                            const sScale = subGroup.scale || new THREE.Vector3(1, 1, 1);
                            subGroup.matrix = new THREE.Matrix4().compose(sPos, sQuat, sScale);
                        }
                        subGroup.matrix.premultiply(_tmpDeltaMatrix);
                        
                        if (!subGroup.position) subGroup.position = new THREE.Vector3();
                        if (!subGroup.quaternion) subGroup.quaternion = new THREE.Quaternion();
                        if (!subGroup.scale) subGroup.scale = new THREE.Vector3(1, 1, 1);
                        
                        subGroup.matrix.decompose(subGroup.position, subGroup.quaternion, subGroup.scale);
                    }
                });

                // Keep overlay in sync without rebuilding geometry
                if (selectionOverlay) {
                    if (group && group.matrix) {
                        selectionOverlay.matrix.copy(group.matrix);
                    } else if (group) {
                        selectionOverlay.matrix.compose(group.position, group.quaternion, group.scale);
                    }
                    selectionOverlay.updateMatrixWorld(true);
                }
            }

            previousHelperMatrix.copy(selectionHelper.matrixWorld);

            // Non-group selection overlay: apply the same delta in world space
            if (!currentSelection.groupId && selectionOverlay) {
                selectionOverlay.matrix.premultiply(_tmpDeltaMatrix);
                selectionOverlay.updateMatrixWorld(true);
            }
        }
    });

    const handleKeyPress = (key) => {
        const resetHelperRotationForWorldSpace = () => {
            if (currentSpace !== 'world') return;
            const items = getSelectedItems();
            if (items.length > 0) {
                selectionHelper.quaternion.set(0, 0, 0, 1);
                selectionHelper.updateMatrixWorld();
                previousHelperMatrix.copy(selectionHelper.matrixWorld);
            }
        };

        switch (key) {
            case 't':
                transformControls.setMode('translate');
                resetHelperRotationForWorldSpace();
                break;
            case 'r':
                transformControls.setMode('rotate');
                resetHelperRotationForWorldSpace();
                break;
            case 's':
                transformControls.setMode('scale');
                resetHelperRotationForWorldSpace();
                break;
            case 'x': {
                currentSpace = currentSpace === 'world' ? 'local' : 'world';
                transformControls.setSpace(currentSpace);
                
                const items = getSelectedItems();
                if (items.length > 0) {
                    if (currentSpace === 'world') {
                        selectionHelper.quaternion.set(0, 0, 0, 1);
                    } else {
                        const firstItem = items[0];
                        const instanceMatrix = new THREE.Matrix4();
                        firstItem.mesh.getMatrixAt(firstItem.instanceId, instanceMatrix);
                        const worldMatrix = instanceMatrix.premultiply(firstItem.mesh.matrixWorld);
                        
                        const quaternion = getRotationFromMatrix(worldMatrix);
                        selectionHelper.quaternion.copy(quaternion);
                    }
                    selectionHelper.updateMatrixWorld();
                    previousHelperMatrix.copy(selectionHelper.matrixWorld);
                }
                
                if (currentSelection.groupId && currentSpace !== 'world') {
                     const groups = getGroups();
                     const group = groups.get(currentSelection.groupId);
                     if (group && group.quaternion) {
                         selectionHelper.quaternion.copy(group.quaternion);
                         selectionHelper.updateMatrixWorld();
                         previousHelperMatrix.copy(selectionHelper.matrixWorld);
                     }
                }

                console.log('TransformControls Space:', currentSpace);
                break;
            }
            case 'z': {
                pivotMode = pivotMode === 'origin' ? 'center' : 'origin';
                console.log('Pivot Mode:', pivotMode);
                updateHelperPosition();
                break;
            }
            case 'v': {
                const items = getSelectedItems();
                if (items.length > 0) {
                    const targetPosition = selectionHelper.position.clone();
                    
                    let shearRemoved = false;
                    let attempts = 0;
                    const maxAttempts = 10;

                    while (!shearRemoved && attempts < maxAttempts) {
                        attempts++;
                        let maxShear = 0;

                        items.forEach(({mesh, instanceId}) => {
                            const matrix = new THREE.Matrix4();
                            mesh.getMatrixAt(instanceId, matrix);
                            
                            const x = new THREE.Vector3().setFromMatrixColumn(matrix, 0).normalize();
                            const y = new THREE.Vector3().setFromMatrixColumn(matrix, 1).normalize();
                            const z = new THREE.Vector3().setFromMatrixColumn(matrix, 2).normalize();
                            
                            const dotXY = Math.abs(x.dot(y));
                            const dotXZ = Math.abs(x.dot(z));
                            const dotYZ = Math.abs(y.dot(z));
                            
                            maxShear = Math.max(maxShear, dotXY, dotXZ, dotYZ);
                            
                            const position = new THREE.Vector3();
                            const quaternion = new THREE.Quaternion();
                            const scale = new THREE.Vector3();
                            
                            matrix.decompose(position, quaternion, scale);
                            matrix.compose(position, quaternion, scale);
                            
                            mesh.setMatrixAt(instanceId, matrix);
                        });

                        if (maxShear < 0.0001) {
                            shearRemoved = true;
                        }
                    }
                    
                    items.forEach(({mesh}) => {
                         if (mesh.isInstancedMesh) mesh.instanceMatrix.needsUpdate = true;
                    });

                    const currentCenter = SelectionCenter(pivotMode, isCustomPivot, pivotOffset);
                    const offset = new THREE.Vector3().subVectors(targetPosition, currentCenter);
                    
                    const tempMat = new THREE.Matrix4();
                    
                    items.forEach(({mesh, instanceId}) => {
                        const inverseMeshWorld = mesh.matrixWorld.clone().invert();
                        mesh.getMatrixAt(instanceId, tempMat);
                        tempMat.premultiply(mesh.matrixWorld);
                        
                        tempMat.elements[12] += offset.x;
                        tempMat.elements[13] += offset.y;
                        tempMat.elements[14] += offset.z;
                        
                        tempMat.premultiply(inverseMeshWorld);
                        mesh.setMatrixAt(instanceId, tempMat);
                        if (mesh.isInstancedMesh) mesh.instanceMatrix.needsUpdate = true;
                    });

                    if (currentSelection.groupId) {
                         const groups = getGroups();
                         const group = groups.get(currentSelection.groupId);
                         if (group && group.matrix) delete group.matrix;

                         const descendantIds = getAllDescendantGroups(currentSelection.groupId);
                         descendantIds.forEach(subId => {
                             const subGroup = groups.get(subId);
                             if (subGroup && subGroup.matrix) delete subGroup.matrix;
                         });
                    }

                    updateHelperPosition();
                    updateSelectionOverlay();
                    console.log('스케일 정규화 및 위치 보정 (Shear 제거)');
                }
                break;
            }
            case 'b': {
                blockbenchScaleMode = !blockbenchScaleMode;
                console.log(`blockbench scale모드 ${blockbenchScaleMode ? '켜짐' : '꺼짐'}`);
                break;
            }
        }
    };

    window.addEventListener('keydown', (event) => {
        if (event.target.tagName === 'INPUT' || event.target.tagName === 'TEXTAREA') return;

        if (event.key === 'Alt') {
            event.preventDefault();
            if (!isPivotEditMode) {
                isPivotEditMode = true;
                previousGizmoMode = transformControls.mode;
                transformControls.setMode('translate');
            }
        }

        if (event.altKey && event.ctrlKey) {
            if (event.key === 'Alt' || event.key === 'Control') {
                event.preventDefault();
                pivotOffset.set(0, 0, 0);
                isCustomPivot = false;
                if (currentSelection.groupId) {
                    const groups = getGroups();
                    const group = groups.get(currentSelection.groupId);
                    if (group) {
                        // Clear pivot override (default pivot behavior resumes).
                        group.pivot = _DEFAULT_GROUP_PIVOT.clone();
                        delete group.isCustomPivot;
                    }
                } else if (currentSelection.mesh) {
                    const mesh = currentSelection.mesh;
                    if ((mesh.isBatchedMesh || mesh.isInstancedMesh) && mesh.userData.customPivots) {
                        currentSelection.instanceIds.forEach(id => {
                            mesh.userData.customPivots.delete(id);
                        });
                    }
                    delete mesh.userData.customPivot;
                    delete mesh.userData.isCustomPivot;
                }
                updateHelperPosition();
                console.log('Pivot reset to origin');
            }
        }

        if (isGizmoBusy) return;
        const key = event.key.toLowerCase();
        const keysToHandle = ['t', 'r', 's', 'x', 'z', 'v', 'b'];
        if (transformControls.dragging && keysToHandle.includes(key)) {
            isGizmoBusy = true;
            const attachedObject = transformControls.object;
            transformControls.pointerUp({button: 0});
            const oldTarget = controls.target.clone();
            controls.dispose();
            const newControls = new (controls.constructor)(camera, renderer.domElement);
            newControls.screenSpacePanning = true;
            newControls.target.copy(oldTarget);
            newControls.update();
            if (setControls) setControls(newControls);
            controls = newControls;
            setTimeout(() => {
                if (attachedObject) {
                    transformControls.detach();
                    transformControls.attach(attachedObject);
                }
                handleKeyPress(key);
                isGizmoBusy = false;
            }, 0);
            return;
        }
        if (keysToHandle.includes(key)) {
            isGizmoBusy = true;
            handleKeyPress(key);
            setTimeout(() => { isGizmoBusy = false; }, 50);
        }
        });

    window.addEventListener('keyup', (event) => {
        if (event.key === 'Alt') {
            if (isPivotEditMode) {
                isPivotEditMode = false;
                transformControls.setMode(previousGizmoMode);
            }
        }
    });
    const clearAltState = () => {
        if (isPivotEditMode) {
            isPivotEditMode = false;
            try {
                transformControls.setMode(previousGizmoMode);
            } catch (err) {
                console.warn('Failed to restore transformControls mode on blur/visibility change', err);
            }
        }
        isGizmoBusy = false;
        try {
            if (transformControls && transformControls.dragging) {
                transformControls.pointerUp({ button: 0 });
            }
        } catch (err) {
        }
    };
    const resetOrbitControls = () => {
        if (controls && setControls) {
            const oldTarget = controls.target.clone();
            const oldScreenSpacePanning = controls.screenSpacePanning;
            controls.dispose();
            
            const newControls = new (controls.constructor)(camera, renderer.domElement);
            newControls.screenSpacePanning = oldScreenSpacePanning;
            newControls.target.copy(oldTarget);
            newControls.update();
            
            setControls(newControls);
            controls = newControls;
        }
    }

    window.addEventListener('blur', () => {
        clearAltState();
        resetOrbitControls();
    });
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            clearAltState();
            resetOrbitControls();
        }
    });
    window.addEventListener('focus', () => {
        clearAltState();
    });

    // selection with raycaster
    const raycaster = new THREE.Raycaster();
    raycaster.layers.enable(2);
    const mouse = new THREE.Vector2();
    let mouseDownPos = null;
    const cameraMatrixOnPointerDown = new THREE.Matrix4();

    loadedObjectGroup.userData.resetSelection = resetSelectionAndDeselect;

    renderer.domElement.addEventListener('pointerdown', (event) => {
        if (isGizmoBusy) return;
        if (event.button !== 0) return;
        mouseDownPos = { x: event.clientX, y: event.clientY };
        cameraMatrixOnPointerDown.copy(camera.matrixWorld);
    });

    renderer.domElement.addEventListener('pointerup', (event) => {
        if (!mouseDownPos) return;

        // If camera has moved, it's a drag, not a click.
        if (!camera.matrixWorld.equals(cameraMatrixOnPointerDown)) {
            mouseDownPos = null;
            return;
        }
        
        const dist = Math.sqrt((event.clientX - mouseDownPos.x) ** 2 + (event.clientY - mouseDownPos.y) ** 2);
        if (dist > 5) { mouseDownPos = null; return; }
        mouseDownPos = null;
        const rect = renderer.domElement.getBoundingClientRect();
        mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(mouse, camera);

        // Pick using the same oriented bounding boxes as the selection overlay
        const picked = pickInstanceByOverlayBox(raycaster, loadedObjectGroup);
        if (!picked) {
            resetSelectionAndDeselect();
            return;
        }

        const object = picked.mesh;
        const instanceId = picked.instanceId;
        let idsToSelect = [instanceId];

        // Group selection by itemId for BatchedMesh
        if (object.isBatchedMesh && object.userData.itemIds) {
            const targetItemId = object.userData.itemIds.get(instanceId);
            if (targetItemId !== undefined) {
                idsToSelect = [];
                for (const [id, itemId] of object.userData.itemIds) {
                    if (itemId === targetItemId) idsToSelect.push(id);
                }
            }
        }

        // Check for Group Membership (use first instanceId)
        const key = getGroupKey(object, idsToSelect[0]);
        const objectToGroup = getObjectToGroup();
        const immediateGroupId = objectToGroup.get(key);

        if (immediateGroupId) {
            const groupChain = getGroupChain(immediateGroupId);
            let nextGroupIdToSelect = groupChain[0];

            if (currentSelection.groupId) {
                const currentIndex = groupChain.indexOf(currentSelection.groupId);
                if (currentIndex !== -1) {
                    if (currentIndex < groupChain.length - 1) {
                        nextGroupIdToSelect = groupChain[currentIndex + 1];
                    } else {
                        nextGroupIdToSelect = null;
                    }
                } else {
                    nextGroupIdToSelect = groupChain[0];
                }
            }

            if (nextGroupIdToSelect) {
                applySelection(null, [], nextGroupIdToSelect);
                return;
            }
        }

        const isSameMesh = currentSelection.mesh === object;
        const isSameSelection = isSameMesh &&
            currentSelection.instanceIds.length === idsToSelect.length &&
            currentSelection.instanceIds.every(id => idsToSelect.includes(id));

        if (!isSameSelection) {
            applySelection(object, idsToSelect);
        }
    });

    return {
        getTransformControls: () => transformControls,
        updateGizmo: () => {
            // overlay update
            if (currentSelection.mesh) {
                // Overlay is updated in change event, but maybe we need it here too?
                // Actually, overlay follows the mesh instances which are updated.
                // But if we want the overlay to be perfectly synced during animation if any, we might update here.
                // For now, it's static unless transformed.
            }
            
            // gizmo axis positive/negative toggling
            if ((currentSelection.mesh || currentSelection.groupId) && (transformControls.mode === 'translate' || transformControls.mode === 'scale')) {
                const gizmoPos = transformControls.object.position;
                const camPos = camera.position;
                const direction = camPos.clone().sub(gizmoPos).normalize();
                if (currentSpace === 'local') direction.applyQuaternion(transformControls.object.quaternion.clone().invert());
                const axesConfig = {
                    X: { originalLines: gizmoLines.X.original, negativeLines: gizmoLines.X.negative, getDirection: () => direction.x > 0 },
                    Y: { originalLines: gizmoLines.Y.original, negativeLines: gizmoLines.Y.negative, getDirection: () => direction.y > 0 },
                    Z: { originalLines: gizmoLines.Z.original, negativeLines: gizmoLines.Z.negative, getDirection: () => direction.z > 0 }
                };
                for (const axis in axesConfig) {
                    const { originalLines, negativeLines, getDirection } = axesConfig[axis];
                    const isPositive = getDirection();
                    const currentDirection = isPositive ? 'positive' : 'negative';
                    if (currentDirection !== lastDirections[axis]) {
                        lastDirections[axis] = currentDirection;
                        if (isPositive) {
                            originalLines.forEach(line => { if (line.material) { line.material.transparent = true; line.material.opacity = 1; line.material._opacity = 1; } });
                            negativeLines.forEach(line => { if (line.material) { line.material.transparent = true; line.material.opacity = 0.001; line.material._opacity = 0.001; } });
                        } else {
                            negativeLines.forEach(line => { if (line.material) { line.material.transparent = true; line.material.opacity = 1; line.material._opacity = 1; } });
                            originalLines.forEach(line => { if (line.material) { line.material.transparent = true; line.material.opacity = 0.001; line.material._opacity = 0.001; } });
                        }
                    }
                }
            }
        },
        resetSelection: resetSelectionAndDeselect,
        getSelectedObject: () => currentSelection.mesh, // Return mesh or null
        createGroup: createGroup,
        getGroups: getGroups
    };
}

export { initGizmo };