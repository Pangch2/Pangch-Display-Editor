import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import * as THREE from 'three/webgpu';

// Small shared temporaries (avoid allocations in hot paths)
const _TMP_MAT4_A = new THREE.Matrix4();
const _TMP_MAT4_B = new THREE.Matrix4();
const _TMP_BOX3_A = new THREE.Box3();
const _TMP_VEC3_A = new THREE.Vector3();
const _TMP_VEC3_B = new THREE.Vector3();
const _TMP_MAT3_A = new THREE.Matrix3();
const _TMP_MAT3_B = new THREE.Matrix3();
const _TMP_MAT4_C = new THREE.Matrix4();
const _TMP_QUAT_A = new THREE.Quaternion();

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

    // Stable per-group fallback (avoid depending on current selection).
    const children = getAllGroupChildren(groupId);
    if (children.length > 0) {
        return calculateAvgOriginForChildren(children, out);
    }
    return out.set(0, 0, 0);
}

// Selection caches (critical for performance when group has many children)
let _selectedItemsCacheKey = null;
let _selectedItemsCache = null;
let _descendantGroupsCacheKey = null;
let _descendantGroupsCache = null;

let _ephemeralPivotUndo = null;
let _pivotEditUndoCapture = null;

function _getSelectedObjectIdCount() {
    let count = 0;
    if (currentSelection.objects && currentSelection.objects.size > 0) {
        for (const [, ids] of currentSelection.objects) {
            if (ids) count += ids.size;
        }
    }
    return count;
}

function _isMultiSelection() {
    const groupCount = currentSelection.groups ? currentSelection.groups.size : 0;
    const objectIdCount = _getSelectedObjectIdCount();
    return (groupCount + objectIdCount) > 1;
}

function _clearEphemeralPivotUndo() {
    _ephemeralPivotUndo = null;
    _pivotEditUndoCapture = null;
}

function _revertEphemeralPivotUndoIfAny() {
    if (!_ephemeralPivotUndo) return;
    try {
        _ephemeralPivotUndo();
    } finally {
        _clearEphemeralPivotUndo();
    }
}

function _capturePivotUndoForCurrentSelection() {
    const undoFns = [];

    // Only object custom pivots are written for multi-selection pivot edit.
    if (currentSelection.objects && currentSelection.objects.size > 0) {
        for (const [mesh, ids] of currentSelection.objects) {
            if (!mesh || !ids || ids.size === 0) continue;

            const hadIsCustomPivot = Object.prototype.hasOwnProperty.call(mesh.userData, 'isCustomPivot');
            const prevIsCustomPivot = mesh.userData.isCustomPivot;
            undoFns.push(() => {
                if (!mesh.userData) return;
                if (hadIsCustomPivot) mesh.userData.isCustomPivot = prevIsCustomPivot;
                else delete mesh.userData.isCustomPivot;
            });

            const isInstancedLike = !!(mesh.isBatchedMesh || mesh.isInstancedMesh);
            if (isInstancedLike) {
                const hadMap = Object.prototype.hasOwnProperty.call(mesh.userData, 'customPivots') && mesh.userData.customPivots;
                const prevById = new Map();
                for (const id of ids) {
                    const prev = hadMap ? mesh.userData.customPivots.get(id) : undefined;
                    prevById.set(id, prev ? prev.clone() : undefined);
                }
                undoFns.push(() => {
                    if (!mesh.userData) return;
                    if (!mesh.userData.customPivots) mesh.userData.customPivots = new Map();
                    for (const [id, prev] of prevById) {
                        if (prev === undefined) mesh.userData.customPivots.delete(id);
                        else mesh.userData.customPivots.set(id, prev.clone());
                    }
                    if (!hadMap && mesh.userData.customPivots.size === 0) {
                        delete mesh.userData.customPivots;
                    }
                });
            } else {
                const hadCustomPivot = Object.prototype.hasOwnProperty.call(mesh.userData, 'customPivot');
                const prevCustomPivot = mesh.userData.customPivot ? mesh.userData.customPivot.clone() : undefined;
                undoFns.push(() => {
                    if (!mesh.userData) return;
                    if (hadCustomPivot) mesh.userData.customPivot = prevCustomPivot ? prevCustomPivot.clone() : undefined;
                    else delete mesh.userData.customPivot;
                });
            }
        }
    }

    if (undoFns.length === 0) return null;
    return () => {
        for (let i = undoFns.length - 1; i >= 0; i--) {
            try {
                undoFns[i]();
            } catch {
            }
        }
    };
}

function _hasAnySelection() {
    return (currentSelection.groups && currentSelection.groups.size > 0) || (currentSelection.objects && currentSelection.objects.size > 0);
}

function _getSingleSelectedGroupId() {
    if (!currentSelection.groups || currentSelection.groups.size !== 1) return null;
    if (currentSelection.objects && currentSelection.objects.size > 0) return null;
    return Array.from(currentSelection.groups)[0] || null;
}

function _getSingleSelectedMeshEntry() {
    if (currentSelection.groups && currentSelection.groups.size > 0) return null;
    if (!currentSelection.objects || currentSelection.objects.size !== 1) return null;
    const [mesh, ids] = currentSelection.objects.entries().next().value;
    return mesh && ids ? { mesh, ids } : null;
}

function _setPrimaryToFirstAvailable() {
    // Prefer a group primary if any group is selected, otherwise first object.
    if (currentSelection.groups && currentSelection.groups.size > 0) {
        const id = Array.from(currentSelection.groups)[0];
        currentSelection.primary = id ? { type: 'group', id } : null;
        return;
    }
    if (currentSelection.objects && currentSelection.objects.size > 0) {
        for (const [mesh, ids] of currentSelection.objects) {
            const firstId = ids && ids.size > 0 ? Array.from(ids)[0] : undefined;
            if (mesh && firstId !== undefined) {
                currentSelection.primary = { type: 'object', mesh, instanceId: firstId };
                return;
            }
        }
    }
    currentSelection.primary = null;
}

function _clearSelectionState() {
    currentSelection.groups.clear();
    currentSelection.objects.clear();
    currentSelection.primary = null;
}

function _recomputePivotStateForSelection() {
    const preserveMultiCustomPivot = pivotMode === 'origin' && _isMultiSelection() && isCustomPivot;
    if (!preserveMultiCustomPivot) {
        pivotOffset.set(0, 0, 0);
        isCustomPivot = false;
    }

    const singleGroupId = _getSingleSelectedGroupId();
    if (singleGroupId) {
        // Single selection should always recompute pivot state.
        pivotOffset.set(0, 0, 0);
        isCustomPivot = false;
        const groups = getGroups();
        const group = groups.get(singleGroupId);
        if (group && shouldUseGroupPivot(group)) {
            const localPivot = normalizePivotToVector3(group.pivot, new THREE.Vector3());
            if (localPivot) {
                const groupMatrix = getGroupWorldMatrix(group, new THREE.Matrix4());
                const targetWorld = localPivot.clone().applyMatrix4(groupMatrix);
                const baseWorld = getGroupOriginWorld(singleGroupId, new THREE.Vector3());
                pivotOffset.subVectors(targetWorld, baseWorld);
                isCustomPivot = true;
            }
        }
        return;
    }

    const singleMeshEntry = _getSingleSelectedMeshEntry();
    if (!singleMeshEntry) return;

    // Single selection should always recompute pivot state.
    pivotOffset.set(0, 0, 0);
    isCustomPivot = false;

    const mesh = singleMeshEntry.mesh;
    const idsArr = Array.from(singleMeshEntry.ids);
    if (!mesh || idsArr.length === 0) return;

    let customPivot = null;
    if ((mesh.isBatchedMesh || mesh.isInstancedMesh) && mesh.userData.customPivots && idsArr.length > 0) {
        if (mesh.userData.customPivots.has(idsArr[0])) {
            customPivot = mesh.userData.customPivots.get(idsArr[0]);
        }
    } else if (mesh.userData.customPivot) {
        customPivot = mesh.userData.customPivot;
    }

    if (!customPivot) return;

    isCustomPivot = true;
    const center = calculateAvgOrigin();
    const firstId = idsArr[0];
    const tempMat = new THREE.Matrix4();
    mesh.getMatrixAt(firstId, tempMat);
    const worldMatrix = tempMat.premultiply(mesh.matrixWorld);
    const targetWorld = customPivot.clone().applyMatrix4(worldMatrix);
    pivotOffset.subVectors(targetWorld, center);
}

function _getSelectionCacheKey() {
    if (!_hasAnySelection()) return 'none';

    const g = currentSelection.groups && currentSelection.groups.size > 0
        ? Array.from(currentSelection.groups).slice().sort().join('|')
        : '';

    const oParts = [];
    if (currentSelection.objects && currentSelection.objects.size > 0) {
        for (const [mesh, ids] of currentSelection.objects) {
            if (!mesh || !ids || ids.size === 0) continue;
            const idsStr = Array.from(ids).slice().sort((a, b) => a - b).join(',');
            oParts.push(`${mesh.uuid}:${idsStr}`);
        }
    }
    oParts.sort();

    return `g:${g};o:${oParts.join('|')}`;
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

    const items = [];
    const seen = new Set();

    if (currentSelection.groups && currentSelection.groups.size > 0) {
        for (const groupId of currentSelection.groups) {
            if (!groupId) continue;
            const children = getAllGroupChildren(groupId);
            for (const child of children) {
                if (!child || !child.mesh) continue;
                const k = getGroupKey(child.mesh, child.instanceId);
                if (seen.has(k)) continue;
                seen.add(k);
                items.push({ mesh: child.mesh, instanceId: child.instanceId });
            }
        }
    }

    if (currentSelection.objects && currentSelection.objects.size > 0) {
        for (const [mesh, ids] of currentSelection.objects) {
            if (!mesh || !ids || ids.size === 0) continue;
            for (const id of ids) {
                const k = getGroupKey(mesh, id);
                if (seen.has(k)) continue;
                seen.add(k);
                items.push({ mesh, instanceId: id });
            }
        }
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
    groups: new Set(),
    objects: new Map(), // Map<THREE.Object3D, Set<number>>
    primary: null // { type: 'group', id } | { type: 'object', mesh, instanceId }
};

let pivotMode = 'origin';
let currentSpace = 'world';
let selectionOverlay = null;
let multiSelectionOverlay = null;
let lastDirections = { X: null, Y: null, Z: null };

// Gizmo position lock: keep the initial selection gizmo position while multi-selecting.
const _gizmoAnchorPosition = new THREE.Vector3();
let _gizmoAnchorValid = false;

// Multi-selection Pivot Mode: origin position cache.
// This lets us temporarily switch pivotMode (e.g. origin -> center -> origin)
// without losing the multi-selection origin pivot position.
const _multiSelectionOriginAnchorPosition = new THREE.Vector3();
let _multiSelectionOriginAnchorValid = false;

// The very first remembered origin anchor for the current multi-selection session.
// Used by "Pivot reset to origin" to restore the original temporary origin.
const _multiSelectionOriginAnchorInitialPosition = new THREE.Vector3();
let _multiSelectionOriginAnchorInitialValid = false;

// When selection is created without a meaningful "first" target (Ctrl+A / marquee),
// anchor the gizmo at the selection center.
let _selectionAnchorMode = 'default'; // 'default' | 'center'

function _clearGizmoAnchor() {
    _gizmoAnchorValid = false;
    _gizmoAnchorPosition.set(0, 0, 0);

    _multiSelectionOriginAnchorValid = false;
    _multiSelectionOriginAnchorPosition.set(0, 0, 0);

    _multiSelectionOriginAnchorInitialValid = false;
    _multiSelectionOriginAnchorInitialPosition.set(0, 0, 0);
}

function _syncMultiSelectionOriginAnchorToCurrent() {
    if (!_hasAnySelection()) return;
    if (!_isMultiSelection()) return;

    // Cache the actual gizmo position we would use in Pivot Mode: origin
    // (includes pivotOffset when applicable).
    _multiSelectionOriginAnchorPosition.copy(SelectionCenter('origin', isCustomPivot, pivotOffset));
    _multiSelectionOriginAnchorValid = true;
}

function _getSelectionCenterWorld(out = new THREE.Vector3()) {
    const box = getSelectionBoundingBox();
    if (box && !box.isEmpty()) {
        return box.getCenter(out);
    }
    return out.copy(calculateAvgOrigin());
}

function _replaceSelectionWithObjectsMap(meshToIds, { anchorMode = 'default' } = {}) {
    if (!meshToIds || meshToIds.size === 0) {
        resetSelectionAndDeselect();
        return;
    }

    _revertEphemeralPivotUndoIfAny();
    if (transformControls) transformControls.detach();
    _clearSelectionState();
    _clearGizmoAnchor();

    // This kind of selection has no "first" item; default anchor is center.
    _selectionAnchorMode = anchorMode;

    // New selection starts with no transient custom pivot.
    pivotOffset.set(0, 0, 0);
    isCustomPivot = false;

    for (const [mesh, ids] of meshToIds) {
        if (!mesh || !ids || ids.size === 0) continue;
        currentSelection.objects.set(mesh, ids);
    }

    currentSelection.primary = null;
    invalidateSelectionCaches();
    _recomputePivotStateForSelection();
    updateHelperPosition();
    updateSelectionOverlay();
}

function _replaceSelectionWithGroupsAndObjects(groupIds, meshToIds, { anchorMode = 'default' } = {}) {
    const hasGroups = groupIds && groupIds.size > 0;
    const hasObjects = meshToIds && meshToIds.size > 0;
    if (!hasGroups && !hasObjects) {
        resetSelectionAndDeselect();
        return;
    }

    _revertEphemeralPivotUndoIfAny();
    if (transformControls) transformControls.detach();
    _clearSelectionState();
    _clearGizmoAnchor();

    _selectionAnchorMode = anchorMode;

    // New selection starts with no transient custom pivot.
    pivotOffset.set(0, 0, 0);
    isCustomPivot = false;

    if (hasGroups) {
        for (const gid of groupIds) {
            if (gid) currentSelection.groups.add(gid);
        }
    }
    if (hasObjects) {
        for (const [mesh, ids] of meshToIds) {
            if (!mesh || !ids || ids.size === 0) continue;
            currentSelection.objects.set(mesh, ids);
        }
    }

    currentSelection.primary = null;
    invalidateSelectionCaches();
    _recomputePivotStateForSelection();
    updateHelperPosition();
    updateSelectionOverlay();
}

function _selectAllObjectsVisibleInScene() {
    const meshToIds = new Map();
    if (!loadedObjectGroup) return meshToIds;

    loadedObjectGroup.traverse((obj) => {
        if (!obj || (!obj.isInstancedMesh && !obj.isBatchedMesh)) return;
        if (obj.visible === false) return;

        let instanceCount = 0;
        if (obj.isInstancedMesh) {
            instanceCount = obj.count ?? 0;
        } else {
            const geomIds = obj.userData?.instanceGeometryIds;
            instanceCount = Array.isArray(geomIds) ? geomIds.length : 0;
        }
        if (instanceCount <= 0) return;

        const ids = new Set();
        for (let i = 0; i < instanceCount; i++) ids.add(i);
        meshToIds.set(obj, ids);
    });

    return meshToIds;
}

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
    // Robust rotation extraction even when matrix contains shear.
    // Use Gram-Schmidt orthogonalization to preserve the primary axis (X) direction.
    // This ensures that if an object is sheared along X (Y tilted), the X axis remains stable.
    // (Previously used Polar Decomposition which caused wobbling/tilting for sheared objects)
    
    const R = new THREE.Matrix4();
    const x = _TMP_VEC3_A.setFromMatrixColumn(matrix, 0);
    const y = _TMP_VEC3_B.setFromMatrixColumn(matrix, 1);
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

// Blockbench scale mode needs a stable "pivot frame" transform.
// For groups, this must include shear from the group's world matrix, but be anchored at the current gizmo pivot position.
const _BB_PIVOT_FRAME_MAT4 = new THREE.Matrix4();
const _BB_PIVOT_FRAME_MAT4_INV = new THREE.Matrix4();
const _BB_PIVOT_FRAME_MAT3 = new THREE.Matrix3();

function _computeBlockbenchPivotFrameMatrixWorld(outMat4, outInvMat4, outMat3, pivotWorld) {
    // Default: use the current selectionHelper world matrix (no shear support).
    outMat4.copy(selectionHelper.matrixWorld);

    // In world space mode, Blockbench anchor should behave like world axes.
    if (currentSpace === 'world') {
        outMat4.identity();
        outMat4.setPosition(pivotWorld);
    }

    // Note: We rely on selectionHelper.matrixWorld being up-to-date (orthonormalized visual frame).
    // This ensures drag arithmetic matches the visual handles exactly.

    outInvMat4.copy(outMat4).invert();
    outMat3.setFromMatrix4(outMat4);
}

function getGroupRotationQuaternion(groupId, out = new THREE.Quaternion()) {
    if (!groupId) return out.set(0, 0, 0, 1);
    const m = getGroupWorldMatrixWithFallback(groupId, _TMP_MAT4_A);
    const q = getRotationFromMatrix(m);
    return out.copy(q);
}

function SelectionCenter(pivotMode, isCustomPivot, pivotOffset) {
    const center = new THREE.Vector3();
    const items = getSelectedItems();
    
    if (items.length === 0) return center;

    if (pivotMode === 'center') {
        // For a single group selection, use the group's *local* bounding box center (OBB center),
        // then transform by the group matrix. Using a world AABB center would shift when rotated.
        const singleGroupId = _getSingleSelectedGroupId();
        if (singleGroupId) {
            const groups = getGroups();
            const group = groups.get(singleGroupId);
            const box = getGroupLocalBoundingBox(singleGroupId);
            if (!box.isEmpty()) {
                const groupMatrix = getGroupWorldMatrixWithFallback(singleGroupId, _TMP_MAT4_A);
                box.getCenter(center);
                center.applyMatrix4(groupMatrix);
            } else if (group && group.position) {
                center.copy(group.position);
            } else {
                center.copy(calculateAvgOrigin());
            }
        } else {
            const box = getSelectionBoundingBox();
            if (box && !box.isEmpty()) box.getCenter(center);
            else center.copy(calculateAvgOrigin());
        }
    } else {
        // Origin (Average Position)
        const singleGroupId = _getSingleSelectedGroupId();
        if (singleGroupId) {
            const groups = getGroups();
            const group = groups.get(singleGroupId);

            const box = getGroupLocalBoundingBox(singleGroupId);
            if (!box.isEmpty()) {
                const groupMatrix = getGroupWorldMatrixWithFallback(singleGroupId, new THREE.Matrix4());
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
            if (child.geometry) child.geometry.dispose();
            if (child.material) child.material.dispose();
        });
        selectionOverlay = null;
    }

    if (multiSelectionOverlay) {
        scene.remove(multiSelectionOverlay);
        if (multiSelectionOverlay.geometry) multiSelectionOverlay.geometry.dispose();
        if (multiSelectionOverlay.material) multiSelectionOverlay.material.dispose();
        multiSelectionOverlay = null;
    }

    if (!_hasAnySelection()) return;

    selectionOverlay = new THREE.Group();
    selectionOverlay.renderOrder = 1;
    selectionOverlay.matrixAutoUpdate = false;
    selectionOverlay.matrix.identity();

    // Groups
    if (currentSelection.groups && currentSelection.groups.size > 0) {
        for (const groupId of currentSelection.groups) {
            if (!groupId) continue;
            const localBox = getGroupLocalBoundingBox(groupId);
            if (!localBox || localBox.isEmpty()) continue;

            const edgesGeo = createEdgesGeometryFromBox3(localBox);
            if (!edgesGeo) continue;

            const overlayMaterial = new THREE.LineBasicMaterial({
                color: 0x6FA21C,
                depthTest: true,
                depthWrite: false,
                transparent: true,
                opacity: 0.9
            });

            const line = new THREE.LineSegments(edgesGeo, overlayMaterial);
            line.matrixAutoUpdate = false;
            line.matrix.copy(getGroupWorldMatrixWithFallback(groupId, new THREE.Matrix4()));
            selectionOverlay.add(line);
        }
    }

    // Objects (can span multiple meshes)
    if (currentSelection.objects && currentSelection.objects.size > 0) {
        const tempMat = new THREE.Matrix4();
        for (const [mesh, ids] of currentSelection.objects) {
            if (!mesh || !ids || ids.size === 0) continue;

            for (const id of ids) {
                const localBox = getInstanceLocalBox(mesh, id);
                if (!localBox) continue;

                const edgesGeo = createEdgesGeometryFromBox3(localBox);
                if (!edgesGeo) continue;

                const displayType = getDisplayType(mesh, id);
                const overlayColor = displayType === 'item_display' ? 0x2E87EC : 0xFFD147;

                const overlayMaterial = new THREE.LineBasicMaterial({
                    color: overlayColor,
                    depthTest: true,
                    depthWrite: false,
                    transparent: true,
                    opacity: 0.9
                });

                mesh.getMatrixAt(id, tempMat);
                const line = new THREE.LineSegments(edgesGeo, overlayMaterial);
                line.matrixAutoUpdate = false;
                line.matrix.multiplyMatrices(mesh.matrixWorld, tempMat);
                selectionOverlay.add(line);
            }
        }
    }

    // Multi-selection: add a white world-aligned bounding box overlay (no rotation)
    if (_isMultiSelection()) {
        const worldBox = getSelectionBoundingBox();
        const edgesGeo = createEdgesGeometryFromBox3(worldBox);
        if (edgesGeo) {
            const overlayMaterial = new THREE.LineBasicMaterial({
                color: 0xFFFFFF,
                depthTest: true,
                depthWrite: false,
                transparent: true,
                opacity: 0.9
            });
            multiSelectionOverlay = new THREE.LineSegments(edgesGeo, overlayMaterial);
            multiSelectionOverlay.renderOrder = 1;
            multiSelectionOverlay.matrixAutoUpdate = false;
            multiSelectionOverlay.matrix.identity();
        }
    }

    selectionOverlay.updateMatrixWorld(true);
    scene.add(selectionOverlay);

    if (multiSelectionOverlay) {
        multiSelectionOverlay.updateMatrixWorld(true);
        scene.add(multiSelectionOverlay);
    }
}

function _updateMultiSelectionOverlayDuringDrag() {
    if (!multiSelectionOverlay) return;

    if (!_isMultiSelection()) {
        scene.remove(multiSelectionOverlay);
        if (multiSelectionOverlay.geometry) multiSelectionOverlay.geometry.dispose();
        if (multiSelectionOverlay.material) multiSelectionOverlay.material.dispose();
        multiSelectionOverlay = null;
        return;
    }

    const worldBox = getSelectionBoundingBox();
    const edgesGeo = createEdgesGeometryFromBox3(worldBox);
    if (!edgesGeo) return;

    if (multiSelectionOverlay.geometry) multiSelectionOverlay.geometry.dispose();
    multiSelectionOverlay.geometry = edgesGeo;
    multiSelectionOverlay.matrix.identity();
    multiSelectionOverlay.updateMatrixWorld(true);
}

function resetSelectionAndDeselect() {
    if (_hasAnySelection()) {
        // If the user created a custom pivot during multi-selection, it should not persist after deselect.
        _revertEphemeralPivotUndoIfAny();
        transformControls.detach();
        _clearSelectionState();
        _clearGizmoAnchor();

        // Clear any selection-derived pivot state so it can't leak into the next selection.
        pivotOffset.set(0, 0, 0);
        isCustomPivot = false;
        _selectionAnchorMode = 'default';

        invalidateSelectionCaches();
        updateSelectionOverlay();
        lastDirections = { X: null, Y: null, Z: null };
        console.log('선택 해제');
    }
}

function updateHelperPosition() {
    const items = getSelectedItems();
    if (items.length === 0 && !_hasAnySelection()) return;

    // Pivot Mode center must always work: recompute each time.
    // For multi-selection, Pivot Mode origin should stay stable (anchored) even when
    // the selection set changes (Shift+Click). Additionally, remember the origin pivot
    // so we can return to it after temporarily switching pivotMode.
    const isMulti = _isMultiSelection();

    // When a selection grows from single -> multi (Shift+Click add), we want Pivot Mode: origin
    // to keep the original gizmo position (first selected) instead of jumping to a newly
    // computed origin. Seed the multi-origin anchor from the existing gizmo anchor.
    if (pivotMode === 'origin' && isMulti && !_multiSelectionOriginAnchorValid && _gizmoAnchorValid) {
        _multiSelectionOriginAnchorPosition.copy(_gizmoAnchorPosition);
        _multiSelectionOriginAnchorValid = true;
        if (!_multiSelectionOriginAnchorInitialValid) {
            _multiSelectionOriginAnchorInitialPosition.copy(_gizmoAnchorPosition);
            _multiSelectionOriginAnchorInitialValid = true;
        }
    }

    const lockMultiOrigin = (pivotMode === 'origin') && isMulti && _multiSelectionOriginAnchorValid;
    if (lockMultiOrigin) {
        selectionHelper.position.copy(_multiSelectionOriginAnchorPosition);
        _gizmoAnchorPosition.copy(_multiSelectionOriginAnchorPosition);
        _gizmoAnchorValid = true;
    } else {
        const center = (_selectionAnchorMode === 'center')
            ? _getSelectionCenterWorld(new THREE.Vector3())
            : SelectionCenter(pivotMode, isCustomPivot, pivotOffset);
        selectionHelper.position.copy(center);
        _gizmoAnchorPosition.copy(center);
        _gizmoAnchorValid = true;

        // When computing an origin pivot position, keep the multi-origin cache up to date.
        if (pivotMode === 'origin' && isMulti) {
            _multiSelectionOriginAnchorPosition.copy(center);
            _multiSelectionOriginAnchorValid = true;
            if (!_multiSelectionOriginAnchorInitialValid) {
                _multiSelectionOriginAnchorInitialPosition.copy(center);
                _multiSelectionOriginAnchorInitialValid = true;
            }
        }
    }
    
    const singleGroupId = _getSingleSelectedGroupId();
    if (singleGroupId) {
        const groups = getGroups();
        const group = groups.get(singleGroupId);
        if (currentSpace === 'world') {
            selectionHelper.quaternion.set(0, 0, 0, 1);
        } else if (group) {
            // Groups may have shear in their matrix; derive a stable orthonormal rotation for local space.
            getGroupRotationQuaternion(singleGroupId, selectionHelper.quaternion);
        } else {
            selectionHelper.quaternion.set(0, 0, 0, 1);
        }
        // Keep helper scale neutral so scale gizmo math is consistent with object selection.
        selectionHelper.scale.set(1, 1, 1);
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

let _pivotEditPreviousPivotMode = null;

function applySelection(mesh, instanceIds, groupId = null) {
    // Selection replacement should also drop any ephemeral multi-selection pivot edits.
    _revertEphemeralPivotUndoIfAny();
    _clearSelectionState();
    _clearGizmoAnchor();
    _selectionAnchorMode = 'default';

    if (groupId) {
        currentSelection.groups.add(groupId);
        currentSelection.primary = { type: 'group', id: groupId };
    } else if (mesh && Array.isArray(instanceIds) && instanceIds.length > 0) {
        const idSet = new Set(instanceIds);
        currentSelection.objects.set(mesh, idSet);
        currentSelection.primary = { type: 'object', mesh, instanceId: instanceIds[0] };
    }

    invalidateSelectionCaches();
    _recomputePivotStateForSelection();

    updateHelperPosition();
    updateSelectionOverlay();
    
    if (groupId) {
        console.log(`그룹 선택됨: ${groupId}`);
    } else if (mesh && Array.isArray(instanceIds)) {
        console.log(`선택됨: InstancedMesh (IDs: ${instanceIds.join(',')})`);
    }
}

function _commitSelectionChange() {
    invalidateSelectionCaches();
    if (_hasAnySelection() && !currentSelection.primary) {
        _setPrimaryToFirstAvailable();
    }
    _recomputePivotStateForSelection();
    updateHelperPosition();
    updateSelectionOverlay();
}

function createGroup() {
    const items = getSelectedItems();
    if (items.length === 0 && !_hasAnySelection()) return;

    const groups = getGroups();
    const objectToGroup = getObjectToGroup();

    const selectedGroupIds = currentSelection.groups ? Array.from(currentSelection.groups).filter(Boolean) : [];
    const selectedObjects = [];
    if (currentSelection.objects && currentSelection.objects.size > 0) {
        for (const [mesh, ids] of currentSelection.objects) {
            if (!mesh || !ids) continue;
            for (const id of ids) {
                selectedObjects.push({ mesh, instanceId: id });
            }
        }
    }

    let initialPosition = new THREE.Vector3();
    // Keep old behavior for single selected group; otherwise use average.
    const singleGroupId = _getSingleSelectedGroupId();
    if (singleGroupId) {
        const existingGroup = groups.get(singleGroupId);
        if (existingGroup && existingGroup.position) initialPosition.copy(existingGroup.position);
        else initialPosition = calculateAvgOrigin();
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

    // Determine common parent group for all selected roots (groups + objects)
    let commonParentId = undefined;
    const considerParentId = (gid) => {
        if (commonParentId === undefined) commonParentId = gid;
        else if (commonParentId !== gid) commonParentId = null;
    };

    for (const gid of selectedGroupIds) {
        const g = groups.get(gid);
        considerParentId(g ? g.parent : undefined);
        if (commonParentId === null) break;
    }
    if (commonParentId !== null) {
        for (const { mesh, instanceId } of selectedObjects) {
            const key = getGroupKey(mesh, instanceId);
            considerParentId(objectToGroup.get(key));
            if (commonParentId === null) break;
        }
    }

    if (commonParentId) {
        newGroup.parent = commonParentId;
        const parentGroup = groups.get(commonParentId);
        if (parentGroup) {
            if (!Array.isArray(parentGroup.children)) parentGroup.children = [];
            parentGroup.children.push({ type: 'group', id: newGroupId });
        }
    }

    // Attach selected groups
    for (const childGroupId of selectedGroupIds) {
        const childGroup = groups.get(childGroupId);
        if (!childGroup) continue;

        if (childGroup.parent) {
            const oldParent = groups.get(childGroup.parent);
            if (oldParent && Array.isArray(oldParent.children)) {
                oldParent.children = oldParent.children.filter(c => !(c && c.type === 'group' && c.id === childGroupId));
            }
        }

        childGroup.parent = newGroupId;
        newGroup.children.push({ type: 'group', id: childGroupId });
    }

    // Attach selected objects
    for (const { mesh, instanceId } of selectedObjects) {
        if (!mesh && mesh !== 0) continue;
        const key = getGroupKey(mesh, instanceId);
        const oldGroupId = objectToGroup.get(key);
        if (oldGroupId) {
            const oldGroup = groups.get(oldGroupId);
            if (oldGroup && Array.isArray(oldGroup.children)) {
                oldGroup.children = oldGroup.children.filter(c => !(c && c.type === 'object' && c.mesh === mesh && c.instanceId === instanceId));
            }
        }
        newGroup.children.push({ type: 'object', mesh, instanceId });
        objectToGroup.set(key, newGroupId);
    }

    groups.set(newGroupId, newGroup);
    invalidateSelectionCaches();
    applySelection(null, [], newGroupId);
    console.log(`Group created: ${newGroupId}`);
    return newGroupId;
}

function ungroupGroup(groupId) {
    if (!groupId) return;
    const groups = getGroups();
    const objectToGroup = getObjectToGroup();
    const group = groups.get(groupId);
    if (!group) return;

    const parentId = group.parent || null;
    const parentGroup = parentId ? groups.get(parentId) : null;

    const children = Array.isArray(group.children) ? group.children.slice() : [];

    // Re-parent children to the parent group (or to root when no parent)
    for (const child of children) {
        if (!child) continue;
        if (child.type === 'group') {
            const sub = groups.get(child.id);
            if (sub) sub.parent = parentId;
        } else if (child.type === 'object') {
            const key = getGroupKey(child.mesh, child.instanceId);
            if (parentId) objectToGroup.set(key, parentId);
            else objectToGroup.delete(key);
        }
    }

    // Replace this group in parent's children list, or just drop it if it's root.
    if (parentGroup) {
        if (!Array.isArray(parentGroup.children)) parentGroup.children = [];
        const idx = parentGroup.children.findIndex(c => c && c.type === 'group' && c.id === groupId);
        if (idx !== -1) {
            parentGroup.children.splice(idx, 1, ...children);
        } else {
            parentGroup.children.push(...children);
        }
    }

    groups.delete(groupId);
    invalidateSelectionCaches();

    // After ungrouping, select the parent group if it exists, otherwise deselect.
    if (parentId && groups.has(parentId)) {
        applySelection(null, [], parentId);
    } else {
        resetSelectionAndDeselect();
    }

    console.log(`Group removed: ${groupId}`);
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

                // Multi-selection custom pivot should be ephemeral: capture undo snapshot at start.
                _pivotEditUndoCapture = _isMultiSelection() ? _capturePivotUndoForCurrentSelection() : null;
            }

            if (blockbenchScaleMode && draggingMode === 'scale' && !isUniformScale) {
                dragInitialBoundingBox.makeEmpty();

                selectionHelper.updateMatrixWorld();
                const pivotWorld = selectionHelper.position;
                _computeBlockbenchPivotFrameMatrixWorld(
                    _BB_PIVOT_FRAME_MAT4,
                    _BB_PIVOT_FRAME_MAT4_INV,
                    _BB_PIVOT_FRAME_MAT3,
                    pivotWorld
                );

                const singleGroupId = _getSingleSelectedGroupId();
                if (singleGroupId) {
                    // Group Selection: Use the Group's Bounding Box (matches the green overlay)
                    const groupLocalBox = getGroupLocalBoundingBox(singleGroupId);
                    if (!groupLocalBox.isEmpty()) {
                        const groupWorldMat = getGroupWorldMatrixWithFallback(singleGroupId, _TMP_MAT4_A);
                        // Transform: Group Local -> World -> Pivot Frame
                        const combinedMat = _TMP_MAT4_B.copy(_BB_PIVOT_FRAME_MAT4_INV).multiply(groupWorldMat);
                        unionTransformedBox3(dragInitialBoundingBox, groupLocalBox, combinedMat);
                    }
                } else {
                    // Object / Multi Selection: Aggregate children boxes
                    const items = getSelectedItems();
                    if (items.length > 0) {
                        const tempMat = new THREE.Matrix4();
                        items.forEach(({mesh, instanceId}) => {
                            const localBox = getInstanceLocalBox(mesh, instanceId);
                            if (!localBox) return;

                            getInstanceWorldMatrix(mesh, instanceId, tempMat);

                            const combinedMat = _TMP_MAT4_A.copy(_BB_PIVOT_FRAME_MAT4_INV).multiply(tempMat);
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
                const singleGroupId = _getSingleSelectedGroupId();
                if (singleGroupId) {
                    const groups = getGroups();
                    const group = groups.get(singleGroupId);
                    if (group) {
                        const pivotWorld = selectionHelper.position.clone();
                        const groupMatrix = getGroupWorldMatrix(group, new THREE.Matrix4());
                        const invGroupMatrix = groupMatrix.clone().invert();
                        const localPivot = pivotWorld.applyMatrix4(invGroupMatrix);

                        // Persist as group.pivot (compatible with pbde-worker payload shape).
                        group.pivot = localPivot.clone();
                        group.isCustomPivot = true;

                        // Ensure offset matches the baseline origin mode for groups.
                        const baseWorld = getGroupOriginWorld(singleGroupId, new THREE.Vector3());
                        const targetWorld = localPivot.clone().applyMatrix4(groupMatrix);
                        pivotOffset.subVectors(targetWorld, baseWorld);
                        isCustomPivot = true;
                    }
                } else {
                    // Persist per-mesh custom pivots only when objects are selected.
                    if (currentSelection.objects && currentSelection.objects.size > 0) {
                        const pivotWorld = selectionHelper.position.clone();
                        const instanceMatrix = new THREE.Matrix4();

                        for (const [mesh, ids] of currentSelection.objects) {
                            if (!mesh || !ids || ids.size === 0) continue;

                            const firstId = Array.from(ids)[0];
                            mesh.getMatrixAt(firstId, instanceMatrix);
                            const worldMatrix = instanceMatrix.premultiply(mesh.matrixWorld);
                            const invWorldMatrix = worldMatrix.clone().invert();
                            const localPivot = pivotWorld.clone().applyMatrix4(invWorldMatrix);

                            if (mesh.isBatchedMesh || mesh.isInstancedMesh) {
                                if (!mesh.userData.customPivots) mesh.userData.customPivots = new Map();
                                for (const id of ids) {
                                    mesh.userData.customPivots.set(id, localPivot.clone());
                                }
                            } else {
                                mesh.userData.customPivot = localPivot.clone();
                            }

                            mesh.userData.isCustomPivot = true;
                        }
                    }
                }

                // Preserve the user's pivotMode (e.g. allow creating a custom pivot while in center mode).
                if (_pivotEditPreviousPivotMode) {
                    pivotMode = _pivotEditPreviousPivotMode;
                }

                // Arm the undo so that deselect (or selection replace) removes these pivots.
                if (_pivotEditUndoCapture) {
                    _ephemeralPivotUndo = _pivotEditUndoCapture;
                }
                _pivotEditUndoCapture = null;

                // Keep the gizmo anchor at the edited pivot location.
                _gizmoAnchorPosition.copy(selectionHelper.position);
                _gizmoAnchorValid = true;
                _selectionAnchorMode = 'default';

                // Multi-selection: remember the edited custom pivot location as the origin anchor.
                if (_isMultiSelection()) {
                    _multiSelectionOriginAnchorPosition.copy(selectionHelper.position);
                    _multiSelectionOriginAnchorValid = true;
                    // Do not overwrite the initial anchor; pivot reset should restore that.
                    if (!_multiSelectionOriginAnchorInitialValid) {
                        _multiSelectionOriginAnchorInitialPosition.copy(selectionHelper.position);
                        _multiSelectionOriginAnchorInitialValid = true;
                    }
                }
            } else {
                _recomputePivotStateForSelection();

                // If we were transforming a multi-selection in Pivot Mode: origin, keep the cached
                // origin anchor following the moved gizmo.
                if (_isMultiSelection() && pivotMode === 'origin') {
                    _multiSelectionOriginAnchorPosition.copy(selectionHelper.position);
                    _multiSelectionOriginAnchorValid = true;
                }
            }

            // Invalidate bounding spheres for all affected meshes
            if (currentSelection.objects && currentSelection.objects.size > 0) {
                for (const [mesh] of currentSelection.objects) {
                    if (mesh) mesh.boundingSphere = null;
                }
            }

            if (selectionHelper) {
                selectionHelper.scale.set(1, 1, 1);
                selectionHelper.updateMatrixWorld();
                previousHelperMatrix.copy(selectionHelper.matrixWorld);
            }
        }
    });

    transformControls.addEventListener('change', (event) => {
        if (transformControls.dragging && _hasAnySelection()) {
            
            if (isPivotEditMode && transformControls.mode === 'translate') {
                // Keep pivotOffset consistent with SelectionCenter(origin) baseline (group uses box.min, block_display uses min when not custom).
                pivotOffset.subVectors(selectionHelper.position, dragStartPivotBaseWorld);
                isCustomPivot = true;

                // Multi-selection: keep the origin anchor in sync with the edited pivot while dragging.
                if (_isMultiSelection()) {
                    _multiSelectionOriginAnchorPosition.copy(selectionHelper.position);
                    _multiSelectionOriginAnchorValid = true;
                }
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
                        if (Math.abs(dragInitialScale.x) > 1e-6) {
                            shift.x = (fixedVal * (dragInitialScale.x - deltaScale.x)) / dragInitialScale.x;
                        }
                    }
                    if (Math.abs(deltaScale.y - dragInitialScale.y) > 0.0001) {
                        const isPositive = dragAnchorDirections.y;
                        const fixedVal = isPositive ? dragInitialBoundingBox.min.y : dragInitialBoundingBox.max.y;
                        if (Math.abs(dragInitialScale.y) > 1e-6) {
                            shift.y = (fixedVal * (dragInitialScale.y - deltaScale.y)) / dragInitialScale.y;
                        }
                    }
                    if (Math.abs(deltaScale.z - dragInitialScale.z) > 0.0001) {
                        const isPositive = dragAnchorDirections.z;
                        const fixedVal = isPositive ? dragInitialBoundingBox.min.z : dragInitialBoundingBox.max.z;
                        if (Math.abs(dragInitialScale.z) > 1e-6) {
                            shift.z = (fixedVal * (dragInitialScale.z - deltaScale.z)) / dragInitialScale.z;
                        }
                    }
                    
                    // Convert from pivot-frame local shift to world.
                    // When the selected target is a group that contains shear, the pivot frame includes that shear
                    // so the anchor/overlay space stays consistent.
                    const shiftWorld = shift.clone();
                    if (currentSpace === 'local') {
                        shiftWorld.applyMatrix3(_BB_PIVOT_FRAME_MAT3);
                    }
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

            if (currentSelection.groups && currentSelection.groups.size > 0) {
                const groups = getGroups();
                const toUpdate = new Set();

                for (const rootId of currentSelection.groups) {
                    if (!rootId) continue;
                    toUpdate.add(rootId);
                    const descendants = getAllDescendantGroups(rootId);
                    for (const subId of descendants) toUpdate.add(subId);
                }

                for (const id of toUpdate) {
                    const g = groups.get(id);
                    if (!g) continue;

                    if (!g.matrix) {
                        const gPos = g.position || new THREE.Vector3();
                        const gQuat = g.quaternion || new THREE.Quaternion();
                        const gScale = g.scale || new THREE.Vector3(1, 1, 1);
                        g.matrix = new THREE.Matrix4().compose(gPos, gQuat, gScale);
                    }

                    g.matrix.premultiply(_tmpDeltaMatrix);
                    if (!g.position) g.position = new THREE.Vector3();
                    if (!g.quaternion) g.quaternion = new THREE.Quaternion();
                    if (!g.scale) g.scale = new THREE.Vector3(1, 1, 1);
                    g.matrix.decompose(g.position, g.quaternion, g.scale);
                }
            }

            previousHelperMatrix.copy(selectionHelper.matrixWorld);

            // Keep overlay in sync without rebuilding geometry
            if (selectionOverlay) {
                selectionOverlay.matrix.premultiply(_tmpDeltaMatrix);
                selectionOverlay.updateMatrixWorld(true);
            }

            // White multi-selection overlay must stay world-aligned (no rotation).
            _updateMultiSelectionOverlayDuringDrag();
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
                
                const singleGroupId = _getSingleSelectedGroupId();
                if (singleGroupId && currentSpace !== 'world') {
                    const groups = getGroups();
                    const group = groups.get(singleGroupId);
                    if (group) {
                        // Groups may have shear in their matrix; derive a stable orthonormal rotation for local space.
                        getGroupRotationQuaternion(singleGroupId, selectionHelper.quaternion);
                        selectionHelper.updateMatrixWorld();
                        previousHelperMatrix.copy(selectionHelper.matrixWorld);
                    }
                }

                console.log('TransformControls Space:', currentSpace);
                break;
            }
            case 'z': {
                if (pivotMode === 'center' && isCustomPivot) {   
                    pivotMode = 'center';
                } else {
                    pivotMode = pivotMode === 'origin' ? 'center' : 'origin';

                }
                isCustomPivot = false;
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

                    // For group selections, drop shear-carrying cached matrices BEFORE computing SelectionCenter.
                    // This ensures the center used for offset matches what updateHelperPosition() will use next.
                    if (currentSelection.groups && currentSelection.groups.size > 0) {
                        const groups = getGroups();
                        const toClear = new Set();
                        for (const rootId of currentSelection.groups) {
                            if (!rootId) continue;
                            toClear.add(rootId);
                            const descendants = getAllDescendantGroups(rootId);
                            for (const subId of descendants) toClear.add(subId);
                        }
                        for (const id of toClear) {
                            const g = groups.get(id);
                            if (g && g.matrix) delete g.matrix;
                        }
                    }

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
            case 'g': {
                // If exactly one group is selected (and no objects), ungroup it.
                // If 2+ groups are selected, group the groups together.
                const groupCount = currentSelection.groups ? currentSelection.groups.size : 0;
                const hasObjects = currentSelection.objects && currentSelection.objects.size > 0;

                if (groupCount === 1 && !hasObjects) {
                    const gid = Array.from(currentSelection.groups)[0];
                    if (gid) ungroupGroup(gid);
                    resetSelectionAndDeselect();
                    break;
                }

                const items = getSelectedItems();
                if (items.length > 0) createGroup();
                break;
            }
        }
    };

    window.addEventListener('keydown', (event) => {
        if (event.target.tagName === 'INPUT' || event.target.tagName === 'TEXTAREA') return;

        // Ctrl+Shift+A: select all objects directly (ignore groups)
        if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'a') {
            event.preventDefault();
            const all = _selectAllObjectsVisibleInScene();
            _replaceSelectionWithObjectsMap(all, { anchorMode: 'center' });
            return;
        }

        // Ctrl+A: select all (no first selection, so anchor at center)
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
            event.preventDefault();
            const groupIds = new Set();
            const meshToIds = new Map();

            if (loadedObjectGroup) {
                const objectToGroup = getObjectToGroup();
                loadedObjectGroup.traverse((obj) => {
                    if (!obj || (!obj.isInstancedMesh && !obj.isBatchedMesh)) return;
                    if (obj.visible === false) return;

                    let instanceCount = 0;
                    if (obj.isInstancedMesh) {
                        instanceCount = obj.count ?? 0;
                    } else {
                        const geomIds = obj.userData?.instanceGeometryIds;
                        instanceCount = Array.isArray(geomIds) ? geomIds.length : 0;
                    }
                    if (instanceCount <= 0) return;

                    for (let instanceId = 0; instanceId < instanceCount; instanceId++) {
                        const key = getGroupKey(obj, instanceId);
                        const immediateGroupId = objectToGroup.get(key);
                        if (immediateGroupId) {
                            const chain = getGroupChain(immediateGroupId);
                            const root = chain && chain.length > 0 ? chain[0] : immediateGroupId;
                            if (root) groupIds.add(root);
                            continue;
                        }

                        let set = meshToIds.get(obj);
                        if (!set) {
                            set = new Set();
                            meshToIds.set(obj, set);
                        }
                        set.add(instanceId);
                    }
                });
            }

            _replaceSelectionWithGroupsAndObjects(groupIds, meshToIds, { anchorMode: 'center' });
            return;
        }

        // Ctrl+G: force ungroup for selected groups (even if multiple groups are selected)
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'g') {
            event.preventDefault();
            const hasGroups = currentSelection.groups && currentSelection.groups.size > 0;
            if (hasGroups) {
                const ids = Array.from(currentSelection.groups);
                // Ungroup all selected groups (safe order: deeper first)
                ids.sort((a, b) => getGroupChain(a).length - getGroupChain(b).length).reverse();
                ids.forEach(id => ungroupGroup(id));
                resetSelectionAndDeselect();
            }
            return;
        }

        if (event.key === 'Alt') {
            event.preventDefault();
            if (!isPivotEditMode) {
                isPivotEditMode = true;
                previousGizmoMode = transformControls.mode;
                _pivotEditPreviousPivotMode = pivotMode;
                transformControls.setMode('translate');
            }
        }

        if (event.altKey && event.ctrlKey) {
            if (event.key === 'Alt' || event.key === 'Control') {
                event.preventDefault();

                // Reset should also drop any ephemeral multi-selection pivot edits.
                _revertEphemeralPivotUndoIfAny();

                pivotOffset.set(0, 0, 0);
                isCustomPivot = false;
                pivotMode = 'origin';

                // Clear group pivot overrides
                if (currentSelection.groups && currentSelection.groups.size > 0) {
                    const groups = getGroups();
                    for (const groupId of currentSelection.groups) {
                        const group = groups.get(groupId);
                        if (!group) continue;
                        group.pivot = _DEFAULT_GROUP_PIVOT.clone();
                        delete group.isCustomPivot;
                    }
                }

                // Clear object pivot overrides (for all selected ids)
                if (currentSelection.objects && currentSelection.objects.size > 0) {
                    for (const [mesh, ids] of currentSelection.objects) {
                        if (!mesh) continue;
                        if ((mesh.isBatchedMesh || mesh.isInstancedMesh) && mesh.userData.customPivots) {
                            for (const id of ids) mesh.userData.customPivots.delete(id);
                        }
                        delete mesh.userData.customPivot;
                        delete mesh.userData.isCustomPivot;
                    }
                }

                _recomputePivotStateForSelection();

                // Multi-selection: restore the initial temporary origin anchor.
                if (_isMultiSelection()) {
                    if (!_multiSelectionOriginAnchorInitialValid) {
                        const initial = SelectionCenter('origin', false, _ZERO_VEC3);
                        _multiSelectionOriginAnchorInitialPosition.copy(initial);
                        _multiSelectionOriginAnchorInitialValid = true;
                    }

                    _multiSelectionOriginAnchorPosition.copy(_multiSelectionOriginAnchorInitialPosition);
                    _multiSelectionOriginAnchorValid = true;

                    _gizmoAnchorPosition.copy(_multiSelectionOriginAnchorInitialPosition);
                    _gizmoAnchorValid = true;
                } else {
                    // Not multi-selection: clear multi-selection caches.
                    _multiSelectionOriginAnchorValid = false;
                    _multiSelectionOriginAnchorInitialValid = false;
                }

                updateHelperPosition();
                console.log('Pivot reset to origin');
            }
        }

        if (isGizmoBusy) return;
        const key = event.key.toLowerCase();
        const keysToHandle = ['t', 'r', 's', 'x', 'z', 'v', 'b', 'g'];
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
                _pivotEditPreviousPivotMode = null;
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

    // Ctrl+Drag marquee selection
    let marqueeActive = false;
    let marqueeCandidate = false;
    let marqueeIgnoreGroups = false;
    let marqueeStart = null;
    let marqueeDiv = null;
    let marqueePrevControlsEnabled = true;

    // Used when marquee attempt is pre-empted by another interaction (e.g. TransformControls drag).
    // Do NOT touch OrbitControls.enabled here; TransformControls owns that while dragging.
    const abortMarqueeNoControls = () => {
        marqueeActive = false;
        marqueeCandidate = false;
        marqueeIgnoreGroups = false;
        marqueeStart = null;
        if (marqueeDiv && marqueeDiv.parentElement) marqueeDiv.parentElement.removeChild(marqueeDiv);
        marqueeDiv = null;
    };

    const ensureMarqueeDiv = () => {
        if (marqueeDiv) return marqueeDiv;
        marqueeDiv = document.createElement('div');
        marqueeDiv.style.position = 'fixed';
        marqueeDiv.style.pointerEvents = 'none';
        marqueeDiv.style.border = '1px dashed rgba(160,160,160,0.95)';
        marqueeDiv.style.background = 'rgba(160,160,160,0.12)';
        marqueeDiv.style.zIndex = '9999';
        marqueeDiv.style.left = '0px';
        marqueeDiv.style.top = '0px';
        marqueeDiv.style.width = '0px';
        marqueeDiv.style.height = '0px';
        document.body.appendChild(marqueeDiv);
        return marqueeDiv;
    };

    const updateMarqueeDiv = (x1, y1, x2, y2) => {
        const left = Math.min(x1, x2);
        const top = Math.min(y1, y2);
        const width = Math.abs(x2 - x1);
        const height = Math.abs(y2 - y1);
        const div = ensureMarqueeDiv();
        div.style.left = `${left}px`;
        div.style.top = `${top}px`;
        div.style.width = `${width}px`;
        div.style.height = `${height}px`;
    };

    const stopMarquee = () => {
        marqueeActive = false;
        marqueeCandidate = false;
        marqueeIgnoreGroups = false;
        marqueeStart = null;
        if (marqueeDiv && marqueeDiv.parentElement) marqueeDiv.parentElement.removeChild(marqueeDiv);
        marqueeDiv = null;
        controls.enabled = marqueePrevControlsEnabled;
    };

    loadedObjectGroup.userData.resetSelection = resetSelectionAndDeselect;
    // Programmatic selection helpers (used by project merge workflow)
    loadedObjectGroup.userData.replaceSelectionWithObjectsMap = (meshToIds, options) => {
        _replaceSelectionWithObjectsMap(meshToIds, options);
    };
    loadedObjectGroup.userData.replaceSelectionWithGroupsAndObjects = (groupIds, meshToIds, options) => {
        _replaceSelectionWithGroupsAndObjects(groupIds, meshToIds, options);
    };

    renderer.domElement.addEventListener('pointerdown', (event) => {
        if (isGizmoBusy) return;
        if (event.button !== 0) return;

        // Ctrl+Drag: marquee selection (start only after the user actually drags)
        if ((event.ctrlKey || event.metaKey) && !transformControls.dragging) {
            // NOTE:
            // We intentionally do NOT raycast against TransformControls here.
            // The helper contains large/hidden picker meshes, which can cause
            // intersectObject(...) to always hit and permanently disable marquee.
            // Instead, we allow marquee to begin as a candidate and cancel it
            // if TransformControls actually starts dragging.

            marqueeCandidate = true;
            marqueeIgnoreGroups = !!event.shiftKey;
            marqueeStart = { x: event.clientX, y: event.clientY };
            marqueePrevControlsEnabled = controls.enabled;
            // Prevent OrbitControls from starting a drag (tiny camera nudge) while Ctrl+Drag / Ctrl+Click is intended.
            controls.enabled = false;
            mouseDownPos = { x: event.clientX, y: event.clientY };
            cameraMatrixOnPointerDown.copy(camera.matrixWorld);
            return;
        }

        mouseDownPos = { x: event.clientX, y: event.clientY };
        cameraMatrixOnPointerDown.copy(camera.matrixWorld);
    }, true);

    renderer.domElement.addEventListener('pointermove', (event) => {
        if (!marqueeStart) return;

        // If another interaction takes over (e.g. user grabbed the gizmo), abort marquee.
        if (transformControls.dragging) {
            abortMarqueeNoControls();
            return;
        }

        if (marqueeCandidate && !marqueeActive) {
            const dx = event.clientX - marqueeStart.x;
            const dy = event.clientY - marqueeStart.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            const threshold = 6;
            if (dist >= threshold) {
                marqueeActive = true;
                marqueeCandidate = false;
                controls.enabled = false;
                ensureMarqueeDiv();
            }
        }

        if (!marqueeActive) return;
        updateMarqueeDiv(marqueeStart.x, marqueeStart.y, event.clientX, event.clientY);
    });

    renderer.domElement.addEventListener('pointerup', (event) => {
        // If TransformControls is handling a drag, marquee should not run.
        if (marqueeStart && transformControls.dragging) {
            abortMarqueeNoControls();
            mouseDownPos = null;
            return;
        }

        if (marqueeActive && marqueeStart) {
            event.preventDefault();

            const ignoreGroups = marqueeIgnoreGroups;

            const canvasRect = renderer.domElement.getBoundingClientRect();
            const x1 = marqueeStart.x;
            const y1 = marqueeStart.y;
            const x2 = event.clientX;
            const y2 = event.clientY;

            const left = Math.max(canvasRect.left, Math.min(x1, x2));
            const right = Math.min(canvasRect.right, Math.max(x1, x2));
            const top = Math.max(canvasRect.top, Math.min(y1, y2));
            const bottom = Math.min(canvasRect.bottom, Math.max(y1, y2));

            stopMarquee();

            const minSize = 6;
            if ((right - left) < minSize || (bottom - top) < minSize) {
                return;
            }

            const minX = left - canvasRect.left;
            const maxX = right - canvasRect.left;
            const minY = top - canvasRect.top;
            const maxY = bottom - canvasRect.top;

            const groupIds = ignoreGroups ? null : new Set();
            const meshToIds = new Map();
            const tmpMat = _TMP_MAT4_A;
            const tmpWorld = _TMP_VEC3_A;
            const tmpNdc = _TMP_VEC3_B;

            const objectToGroup = ignoreGroups ? null : getObjectToGroup();

            loadedObjectGroup.traverse((obj) => {
                if (!obj || (!obj.isInstancedMesh && !obj.isBatchedMesh)) return;
                if (obj.visible === false) return;

                let instanceCount = 0;
                if (obj.isInstancedMesh) {
                    instanceCount = obj.count ?? 0;
                } else {
                    const geomIds = obj.userData?.instanceGeometryIds;
                    instanceCount = Array.isArray(geomIds) ? geomIds.length : 0;
                }
                if (instanceCount <= 0) return;

                for (let instanceId = 0; instanceId < instanceCount; instanceId++) {
                    getInstanceWorldMatrixForOrigin(obj, instanceId, tmpMat);
                    const localY = isItemDisplayHatEnabled(obj, instanceId) ? 0.03125 : 0;
                    tmpWorld.set(0, localY, 0).applyMatrix4(tmpMat);

                    tmpNdc.copy(tmpWorld).project(camera);
                    if (tmpNdc.z < -1 || tmpNdc.z > 1) continue;

                    const sx = (tmpNdc.x * 0.5 + 0.5) * canvasRect.width;
                    const sy = (-tmpNdc.y * 0.5 + 0.5) * canvasRect.height;

                    if (sx < minX || sx > maxX || sy < minY || sy > maxY) continue;

                    if (!ignoreGroups && objectToGroup) {
                        const key = getGroupKey(obj, instanceId);
                        const immediateGroupId = objectToGroup.get(key);
                        if (immediateGroupId) {
                            const chain = getGroupChain(immediateGroupId);
                            const root = chain && chain.length > 0 ? chain[0] : immediateGroupId;
                            if (root) groupIds.add(root);
                            continue;
                        }
                    }

                    let set = meshToIds.get(obj);
                    if (!set) {
                        set = new Set();
                        meshToIds.set(obj, set);
                    }
                    set.add(instanceId);
                }
            });

            if (ignoreGroups) {
                _replaceSelectionWithObjectsMap(meshToIds, { anchorMode: 'center' });
            } else {
                _replaceSelectionWithGroupsAndObjects(groupIds, meshToIds, { anchorMode: 'center' });
            }
            return;
        }

        // Ctrl+Click should still work (group bypass) when no marquee actually started.
        if (marqueeCandidate) {
            marqueeCandidate = false;
            marqueeIgnoreGroups = false;
            marqueeStart = null;
            controls.enabled = marqueePrevControlsEnabled;
        }

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
            if (!event.shiftKey) resetSelectionAndDeselect();
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

        // Modifier clicks:
        // - Ctrl/Meta+Click: ignore groups, directly select object
        // - Shift+Click: multi-select/toggle (groups and objects). Still follows normal click behavior
        //   for grouped objects unless Ctrl/Meta is also held.
        const bypassGroupSelection = !!(event.ctrlKey || event.metaKey);

        // Determine click target (group vs object)
        let target = { type: 'object', mesh: object, ids: idsToSelect };

        if (!bypassGroupSelection && immediateGroupId) {
            const groupChain = getGroupChain(immediateGroupId);
            let nextGroupIdToSelect = groupChain[0];

            const primaryGroupId = currentSelection.primary && currentSelection.primary.type === 'group'
                ? currentSelection.primary.id
                : null;

            if (primaryGroupId) {
                const currentIndex = groupChain.indexOf(primaryGroupId);
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
                target = { type: 'group', id: nextGroupIdToSelect };
            }
        }

        // Shift+Click: toggle selection (groups and objects)
        if (event.shiftKey) {
            const hadAnyBefore = _hasAnySelection();
            if (target.type === 'group') {
                const gid = target.id;
                if (!gid) return;

                if (!currentSelection.groups) currentSelection.groups = new Set();
                if (currentSelection.groups.has(gid)) {
                    currentSelection.groups.delete(gid);
                    if (currentSelection.primary && currentSelection.primary.type === 'group' && currentSelection.primary.id === gid) {
                        currentSelection.primary = null;
                    }
                } else {
                    currentSelection.groups.add(gid);
                    // Preserve the original (first) primary when adding to an existing selection.
                    if (!hadAnyBefore || !currentSelection.primary) {
                        currentSelection.primary = { type: 'group', id: gid };
                    }
                }

                if (!_hasAnySelection()) resetSelectionAndDeselect();
                else _commitSelectionChange();
                return;
            }

            // object toggle
            const mesh = target.mesh;
            const ids = target.ids || [];
            if (!mesh || ids.length === 0) return;

            if (!currentSelection.objects) currentSelection.objects = new Map();
            let set = currentSelection.objects.get(mesh);
            if (!set) {
                set = new Set();
                currentSelection.objects.set(mesh, set);
            }

            const allSelected = ids.every(id => set.has(id));
            if (allSelected) {
                ids.forEach(id => set.delete(id));
            } else {
                ids.forEach(id => set.add(id));
            }

            if (set.size === 0) {
                currentSelection.objects.delete(mesh);
            }

            // Preserve the original (first) primary when adding to an existing selection.
            if (!hadAnyBefore || !currentSelection.primary) {
                currentSelection.primary = { type: 'object', mesh, instanceId: ids[0] };
            }
            if (!_hasAnySelection()) resetSelectionAndDeselect();
            else _commitSelectionChange();
            return;
        }

        // Normal click: replace selection
        if (target.type === 'group') {
            applySelection(null, [], target.id);
            return;
        }

        // object replace
        applySelection(target.mesh, target.ids);
    });

    return {
        getTransformControls: () => transformControls,
        updateGizmo: () => {
            // gizmo axis positive/negative toggling
            if (_hasAnySelection() && (transformControls.mode === 'translate' || transformControls.mode === 'scale')) {
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
        getSelectedObject: () => (currentSelection.primary && currentSelection.primary.type === 'object' ? currentSelection.primary.mesh : null),
        createGroup: createGroup,
        getGroups: getGroups
    };
}

export { initGizmo };