import * as THREE from 'three/webgpu';
import * as GroupUtils from './group.js';

// Small shared temporaries (avoid allocations in hot paths)
const _TMP_MAT4_A = new THREE.Matrix4();
const _TMP_MAT4_B = new THREE.Matrix4();
const _TMP_BOX3_A = new THREE.Box3();
const _TMP_VEC3_A = new THREE.Vector3();
const _TMP_VEC3_B = new THREE.Vector3();

let loadedObjectGroup = null;

export function setLoadedObjectGroup(group) {
    loadedObjectGroup = group;
}

function getGroups() {
    return GroupUtils.getGroups(loadedObjectGroup);
}

function getAllGroupChildren(groupId) {
    return GroupUtils.getAllGroupChildren(loadedObjectGroup, groupId);
}

// Overlay Geometry & Materials

const _overlayUnitGeo = (() => {
    const geo = new THREE.BufferGeometry();
    const vertices = new Float32Array([
        // Bottom 4 edges
        -0.5, -0.5, -0.5,  0.5, -0.5, -0.5, -0.5, -0.5, -0.5,
         0.5, -0.5, -0.5,  0.5, -0.5,  0.5,  0.5, -0.5, -0.5,
         0.5, -0.5,  0.5, -0.5, -0.5,  0.5,  0.5, -0.5,  0.5,
        -0.5, -0.5,  0.5, -0.5, -0.5, -0.5, -0.5, -0.5,  0.5,
        // Top 4 edges
        -0.5,  0.5, -0.5,  0.5,  0.5, -0.5, -0.5,  0.5, -0.5,
         0.5,  0.5, -0.5,  0.5,  0.5,  0.5,  0.5,  0.5, -0.5,
         0.5,  0.5,  0.5, -0.5,  0.5,  0.5,  0.5,  0.5,  0.5,
        -0.5,  0.5,  0.5, -0.5,  0.5, -0.5, -0.5,  0.5,  0.5,
        // Vertical 4 edges
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
    const verts = [];
    const colors = [];
    const addLine = (v, colorHex) => {
        verts.push(0, 0, 0);
        verts.push(v.x, v.y, v.z);
        const c = new THREE.Color(colorHex);
        colors.push(c.r, c.g, c.b);
        colors.push(c.r, c.g, c.b);
    };
    addLine(new THREE.Vector3(0.3, 0, 0), 0xEF3751);
    addLine(new THREE.Vector3(-0.3, 0, 0), 0xEF3751);
    addLine(new THREE.Vector3(0, 0.3, 0), 0x6FA21C);
    addLine(new THREE.Vector3(0, -0.3, 0), 0x6FA21C);
    addLine(new THREE.Vector3(0, 0, 0.3), 0x437FD0);
    addLine(new THREE.Vector3(0, 0, -0.3), 0x437FD0);
    
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts), 3));
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(colors), 3));
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

export function createOverlayLineMaterial(color) {
    return new THREE.LineBasicMaterial({
        color,
        depthTest: true,
        depthWrite: false,
        transparent: true,
        opacity: 0.9
    });
}

export function createEdgesGeometryFromBox3(box) {
    if (!box || box.isEmpty()) return null;
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);
    const boxGeo = new THREE.BoxGeometry(size.x, size.y, size.z);
    boxGeo.translate(center.x, center.y, center.z);
    return new THREE.EdgesGeometry(boxGeo);
}

// Helper Functions

export function getInstanceCount(mesh) {
    if (!mesh) return 0;
    if (mesh.isInstancedMesh) return mesh.count ?? 0;
    if (mesh.isBatchedMesh) {
        const geomIds = mesh.userData?.instanceGeometryIds;
        return Array.isArray(geomIds) ? geomIds.length : 0;
    }
    return 0;
}

export function isInstanceValid(mesh, instanceId) {
    if (!mesh) return false;
    if (mesh.isBatchedMesh) {
        if (mesh.userData?.instanceGeometryIds) {
            return mesh.userData.instanceGeometryIds[instanceId] !== undefined;
        }
        return true;
    }
    if (mesh.isInstancedMesh) {
        return instanceId < (mesh.count ?? 0);
    }
    return false;
}

export function disposeThreeObjectTree(root) {
    if (!root) return;
    root.traverse(child => {
        if (child.geometry) child.geometry.dispose();
        if (child.material) child.material.dispose();
    });
}

export function getDisplayType(mesh, instanceId) {
    if (!mesh) return undefined;
    if (mesh.isBatchedMesh && mesh.userData?.displayTypes) {
        return mesh.userData.displayTypes.get(instanceId);
    }
    return mesh.userData?.displayType;
}

export function isItemDisplayHatEnabled(mesh, instanceId) {
    return !!(getDisplayType(mesh, instanceId) === 'item_display' && mesh?.userData?.hasHat && mesh.userData.hasHat[instanceId]);
}

export function getInstanceLocalBoxMin(mesh, instanceId, out = new THREE.Vector3()) {
    const box = getInstanceLocalBox(mesh, instanceId);
    if (!box) return null;
    return out.copy(box.min);
}

export function getInstanceWorldMatrixForOrigin(mesh, instanceId, outMatrix) {
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

export function calculateAvgOriginForChildren(children, out = new THREE.Vector3()) {
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

export function getGroupWorldMatrixWithFallback(groupId, out = new THREE.Matrix4()) {
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

export function unionTransformedBox3(targetBox, localBox, matrix, tempBox = _TMP_BOX3_A) {
    if (!targetBox || !localBox) return;
    tempBox.copy(localBox).applyMatrix4(matrix);
    targetBox.union(tempBox);
}

export function getInstanceLocalBox(mesh, instanceId) {
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

export function getInstanceWorldMatrix(mesh, instanceId, outMatrix) {
    outMatrix.identity();
    if (!mesh) return outMatrix;
    mesh.getMatrixAt(instanceId, outMatrix);
    outMatrix.premultiply(mesh.matrixWorld);
    return outMatrix;
}

export function getGroupLocalBoundingBox(groupId) {
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

export function getRotationFromMatrix(matrix) {
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

export function getSelectionBoundingBox(currentSelection) {
    const box = new THREE.Box3();
    const tempMat = new THREE.Matrix4();
    const tempBox = new THREE.Box3();

    // 1. Include Selected Groups
    if (currentSelection.groups && currentSelection.groups.size > 0) {
        for (const groupId of currentSelection.groups) {
            if (!groupId) continue;
            const localBox = getGroupLocalBoundingBox(groupId);
            if (!localBox || localBox.isEmpty()) continue;
            
            getGroupWorldMatrixWithFallback(groupId, tempMat);
            tempBox.copy(localBox).applyMatrix4(tempMat);
            box.union(tempBox);
        }
    }

    // 2. Include Selected Objects
    if (currentSelection.objects && currentSelection.objects.size > 0) {
        for (const [mesh, ids] of currentSelection.objects) {
            if (!mesh || !ids || ids.size === 0) continue;
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

function _getSelectedObjectCount(currentSelection) {
    let count = 0;
    if (currentSelection.objects && currentSelection.objects.size > 0) {
        for (const [mesh, ids] of currentSelection.objects) {
            if (!ids || ids.size === 0) continue;
            count += ids.size;
        }
    }
    return count;
}


// Overlay State
let selectionOverlay = null;
let selectionPointsOverlay = null;
let multiSelectionOverlay = null;

export function getSelectionPointsOverlay() {
    return selectionPointsOverlay;
}

export function updateSelectionOverlay(scene, renderer, camera, currentSelection, vertexQueue, isVertexMode, selectionHelper, selectedVertexKeys) {
    // Preserve selection logic adjusted for multi-vertex

    if (selectionOverlay) {
        scene.remove(selectionOverlay);
        if (selectionOverlay.isGroup) {
            disposeThreeObjectTree(selectionOverlay);
        } else {
            if (selectionOverlay.geometry && selectionOverlay.geometry !== _overlayUnitGeo) {
                selectionOverlay.geometry.dispose();
            }
            if (selectionOverlay.material) selectionOverlay.material.dispose();
        }
        selectionOverlay = null;
    }

    if (selectionPointsOverlay) {
        scene.remove(selectionPointsOverlay);
        // Specialized cleanup for Sprites: do NOT dispose geometry as it is shared globally.
        selectionPointsOverlay.traverse(child => {
            if (child.material) child.material.dispose();
        });
        selectionPointsOverlay = null;
    }

    if (multiSelectionOverlay) {
        scene.remove(multiSelectionOverlay);
        if (multiSelectionOverlay.geometry) multiSelectionOverlay.geometry.dispose();
        if (multiSelectionOverlay.material) multiSelectionOverlay.material.dispose();
        multiSelectionOverlay = null;
    }

    const hasAnySelection = (currentSelection.groups && currentSelection.groups.size > 0) || (currentSelection.objects && currentSelection.objects.size > 0);

    if (!hasAnySelection && vertexQueue.length === 0) return;

    const itemsToRender = [];
    const tempCenter = _TMP_VEC3_A;
    const tempSize = _TMP_VEC3_B;
    
    // Groups
    if (currentSelection.groups && currentSelection.groups.size > 0) {
        for (const groupId of currentSelection.groups) {
            if (!groupId) continue;
            const localBox = getGroupLocalBoundingBox(groupId);
            if (!localBox || localBox.isEmpty()) continue;

            localBox.getSize(tempSize);
            localBox.getCenter(tempCenter);

            const groupWorld = getGroupWorldMatrixWithFallback(groupId, new THREE.Matrix4());
            
            const instanceMat = new THREE.Matrix4();
            instanceMat.makeTranslation(tempCenter.x, tempCenter.y, tempCenter.z);
            instanceMat.scale(tempSize);
            instanceMat.premultiply(groupWorld);

            itemsToRender.push({ matrix: instanceMat, color: 0x6FA21C, source: { type: 'group', id: groupId } });
        }
    }

    // Objects
    if (currentSelection.objects && currentSelection.objects.size > 0) {
        const objTempMat = new THREE.Matrix4();
        for (const [mesh, ids] of currentSelection.objects) {
            if (!mesh || !ids || ids.size === 0) continue;

            for (const id of ids) {
                const localBox = getInstanceLocalBox(mesh, id);
                if (!localBox) continue;

                localBox.getSize(tempSize);
                localBox.getCenter(tempCenter);

                getInstanceWorldMatrix(mesh, id, objTempMat);

                const instanceMat = new THREE.Matrix4();
                instanceMat.makeTranslation(tempCenter.x, tempCenter.y, tempCenter.z);
                instanceMat.scale(tempSize);
                instanceMat.premultiply(objTempMat);

                const displayType = getDisplayType(mesh, id);
                const color = displayType === 'item_display' ? 0x2E87EC : 0xFFD147;

                itemsToRender.push({ matrix: instanceMat, color: color, source: { type: 'object', mesh, instanceId: id } });
            }
        }
    }

    const queueItemsToRender = [];
    if (vertexQueue.length > 0) {
        const groups = getGroups();
        for (const item of vertexQueue) {
            let isSelected = false;
            if (item.type === 'group') {
                if (currentSelection.groups.has(item.id)) isSelected = true;
            } else {
                if (currentSelection.objects.has(item.mesh) && currentSelection.objects.get(item.mesh).has(item.instanceId)) {
                    isSelected = true;
                }
            }
            if (isSelected) continue;

            if (item.type === 'group') {
                const groupId = item.id;
                if (!groups.has(groupId)) continue;
                const localBox = getGroupLocalBoundingBox(groupId);
                if (!localBox || localBox.isEmpty()) continue;
                
                localBox.getSize(tempSize);
                localBox.getCenter(tempCenter);
                
                const groupWorld = getGroupWorldMatrixWithFallback(groupId, new THREE.Matrix4());
                const instanceMat = new THREE.Matrix4();
                instanceMat.makeTranslation(tempCenter.x, tempCenter.y, tempCenter.z);
                instanceMat.scale(tempSize);
                instanceMat.premultiply(groupWorld);
                
                let gPos = null;
                let gQuat = null;
                if (item.gizmoLocalPosition) {
                     gPos = item.gizmoLocalPosition.clone().applyMatrix4(groupWorld);
                     if (item.gizmoLocalQuaternion) {
                         const groupRot = getRotationFromMatrix(groupWorld);
                         gQuat = groupRot.multiply(item.gizmoLocalQuaternion);
                     }
                }

                queueItemsToRender.push({ matrix: instanceMat, color: 0x6FA21C, source: { type: 'group', id: groupId }, gizmoPosition: gPos, gizmoQuaternion: gQuat, gizmoLocalPosition: item.gizmoLocalPosition });
            } else if (item.type === 'object') {
                const { mesh, instanceId } = item;
                if (!mesh.parent || !isInstanceValid(mesh, instanceId)) continue;
                
                const localBox = getInstanceLocalBox(mesh, instanceId);
                if (!localBox) continue;
                
                localBox.getSize(tempSize);
                localBox.getCenter(tempCenter);
                
                const worldMat = getInstanceWorldMatrix(mesh, instanceId, new THREE.Matrix4());
                const instanceMat = new THREE.Matrix4();
                instanceMat.makeTranslation(tempCenter.x, tempCenter.y, tempCenter.z);
                instanceMat.scale(tempSize);
                instanceMat.premultiply(worldMat);

                let gPos = null;
                let gQuat = null;
                if (item.gizmoLocalPosition) {
                     gPos = item.gizmoLocalPosition.clone().applyMatrix4(worldMat);
                     if (item.gizmoLocalQuaternion) {
                         const objRot = getRotationFromMatrix(worldMat);
                         gQuat = objRot.multiply(item.gizmoLocalQuaternion);
                     }
                }

                const displayType = getDisplayType(mesh, instanceId);
                const color = displayType === 'item_display' ? 0x2E87EC : 0xFFD147;

                queueItemsToRender.push({ matrix: instanceMat, color: color, source: { type: 'object', mesh, instanceId }, gizmoPosition: gPos, gizmoQuaternion: gQuat, gizmoLocalPosition: item.gizmoLocalPosition });
            }
        }
    }

    const allOverlayItems = [...itemsToRender, ...queueItemsToRender];

    if (allOverlayItems.length > 0) {
        const material = new THREE.MeshBasicMaterial({
            color: 0xffffff,
            depthTest: true,
            depthWrite: false,
            transparent: true,
            opacity: 0.9,
            wireframe: true
        });

        selectionOverlay = new THREE.InstancedMesh(_overlayUnitGeo, material, allOverlayItems.length);
        selectionOverlay.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        selectionOverlay.renderOrder = 1;
        selectionOverlay.matrixAutoUpdate = false;
        selectionOverlay.matrix.identity();

        const colorObj = new THREE.Color();
        allOverlayItems.forEach((item, index) => {
            selectionOverlay.setMatrixAt(index, item.matrix);
            colorObj.setHex(item.color);
            selectionOverlay.setColorAt(index, colorObj);
        });

        selectionOverlay.instanceMatrix.needsUpdate = true;
        if (selectionOverlay.instanceColor) selectionOverlay.instanceColor.needsUpdate = true;

        scene.add(selectionOverlay);
    }

    if (allOverlayItems.length > 0 && isVertexMode) {
        selectionPointsOverlay = new THREE.Group();
        selectionPointsOverlay.renderOrder = 999;
        selectionPointsOverlay.matrixAutoUpdate = false;
        
        const baseSpriteMat = new THREE.SpriteMaterial({
            color: 0x30333D,
            sizeAttenuation: false,
            depthTest: false,
            depthWrite: false,
            transparent: true
        });

        const canvas = renderer.domElement;
        const width = canvas.clientWidth;
        const height = canvas.clientHeight;
        const scaleX = 10 / width;
        const scaleY = 10 / height;

        const v = new THREE.Vector3();
        const existingPoints = new Set();

        for (const item of allOverlayItems) {
            for (const corner of _unitCubeCorners) {
                v.copy(corner).applyMatrix4(item.matrix);
                
                // Simple spatial hashing to prevent duplicate points at shared corners
                const key = `${v.x.toFixed(4)}_${v.y.toFixed(4)}_${v.z.toFixed(4)}`;
                if (existingPoints.has(key)) continue;
                existingPoints.add(key);

                const sprite = new THREE.Sprite(baseSpriteMat.clone());
                sprite.position.copy(v);
                sprite.userData = { key: key, source: item.source };
                
                if (selectedVertexKeys.has(key)) {
                    sprite.material.color.setHex(0x437FD0);
                }

                sprite.scale.set(scaleX, scaleY, 1);
                selectionPointsOverlay.add(sprite);
            }
        }

        // Add Gizmo visualization (Center point + Axis lines)
        if (selectionHelper) {
            const gizmoPos = selectionHelper.position;
            const gizmoQuat = selectionHelper.quaternion;

            // 1. Gizmo Center Point
            const centerSprite = new THREE.Sprite(baseSpriteMat.clone());
            centerSprite.position.copy(gizmoPos);
            
            const centerKey = `CENTER_${gizmoPos.x.toFixed(4)}_${gizmoPos.y.toFixed(4)}_${gizmoPos.z.toFixed(4)}`;
            centerSprite.userData = { isCenter: true, key: centerKey };
            
            if (selectedVertexKeys.has(centerKey)) {
                centerSprite.material.color.setHex(0x437FD0);
            }

            centerSprite.scale.set(scaleX, scaleY, 1);
            centerSprite.renderOrder = 999;
            selectionPointsOverlay.add(centerSprite);

            // Shared setup for axis lines (Queue + Main)
            const createAxisHelper = (pos, quat) => {
                const axes = new THREE.LineSegments(_axisUnitGeo, _axisMat);
                axes.position.copy(pos);
                axes.quaternion.copy(quat);
                axes.renderOrder = 100;
                axes.matrixAutoUpdate = true;
                
                // Initial scale to prevent "pop"
                if (camera) {
                    const distance = pos.distanceTo(camera.position);
                    const initialScale = distance * 0.15;
                    axes.scale.set(initialScale, initialScale, initialScale);
                    axes.updateMatrix();
                }

                axes.onBeforeRender = function(renderer, scene, camera) {
                    const worldPos = _TMP_VEC3_A;
                    this.getWorldPosition(worldPos);
                    const distance = worldPos.distanceTo(camera.position);
                    // Fixed screen size factor (approx matching original 0.1 at close range)
                    const scale = distance * 0.15; 
                    this.scale.set(scale, scale, scale);
                    this.updateMatrix();
                };
                return axes;
            };

            // 1.5 Queue Gizmo Points
            for (const item of queueItemsToRender) {
                if (item.gizmoPosition) {
                    const queueSprite = new THREE.Sprite(baseSpriteMat.clone());
                    queueSprite.position.copy(item.gizmoPosition);
                    
                    const posForKey = item.gizmoLocalPosition || item.gizmoPosition;
                    const src = item.source;
                    const idStr = src.type === 'group' ? `G_${src.id}` : `O_${src.mesh.uuid}_${src.instanceId}`;
                    const qKey = `QUEUE_${idStr}_${posForKey.x.toFixed(4)}_${posForKey.y.toFixed(4)}_${posForKey.z.toFixed(4)}`;
                    queueSprite.userData = { isCenter: true, key: qKey, source: item.source };
                    
                    if (selectedVertexKeys.has(qKey)) {
                         queueSprite.material.color.setHex(0x437FD0);
                    }

                    queueSprite.scale.set(scaleX, scaleY, 1);
                    queueSprite.renderOrder = 999;
                    selectionPointsOverlay.add(queueSprite);

                    // Add axis lines for queue item
                    if (item.gizmoQuaternion) {
                        const axis = createAxisHelper(item.gizmoPosition, item.gizmoQuaternion);
                        selectionPointsOverlay.add(axis);
                    }
                }
            }

            // 2. Gizmo Axis Lines (Main)
            const mainAxis = createAxisHelper(gizmoPos, gizmoQuat);
            selectionPointsOverlay.add(mainAxis);
        }
        
        // Clean up base material as we cloned it for everyone
        baseSpriteMat.dispose();
        
        scene.add(selectionPointsOverlay);
    }

    // Multi-selection: add a white world-aligned bounding box overlay (no rotation)
    const objectIdCount = _getSelectedObjectCount(currentSelection);
    const groupCount = currentSelection.groups ? currentSelection.groups.size : 0;
    const isMultiSelection = (groupCount + objectIdCount) > 1;

    if (isMultiSelection) {
        const worldBox = getSelectionBoundingBox(currentSelection);
        const edgesGeo = createEdgesGeometryFromBox3(worldBox);
        if (edgesGeo) {
            const overlayMaterial = createOverlayLineMaterial(0xFFFFFF);
            multiSelectionOverlay = new THREE.LineSegments(edgesGeo, overlayMaterial);
            multiSelectionOverlay.renderOrder = 1;
            multiSelectionOverlay.matrixAutoUpdate = false;
            multiSelectionOverlay.matrix.identity();
            scene.add(multiSelectionOverlay);
        }
    }

    if (selectionOverlay) selectionOverlay.updateMatrixWorld(true);
    if (selectionPointsOverlay) selectionPointsOverlay.updateMatrixWorld(true);
    if (multiSelectionOverlay) {
        multiSelectionOverlay.updateMatrixWorld(true);
    }
}

export function updateMultiSelectionOverlayDuringDrag(currentSelection, scene) {
    if (!multiSelectionOverlay) return;

    const objectIdCount = _getSelectedObjectCount(currentSelection);
    const groupCount = currentSelection.groups ? currentSelection.groups.size : 0;
    const isMultiSelection = (groupCount + objectIdCount) > 1;
    
    if (!isMultiSelection) {
        scene.remove(multiSelectionOverlay);
        if (multiSelectionOverlay.geometry) multiSelectionOverlay.geometry.dispose();
        if (multiSelectionOverlay.material) multiSelectionOverlay.material.dispose();
        multiSelectionOverlay = null;
        return;
    }

    const worldBox = getSelectionBoundingBox(currentSelection);
    const edgesGeo = createEdgesGeometryFromBox3(worldBox);
    if (!edgesGeo) return;

    if (multiSelectionOverlay.geometry) multiSelectionOverlay.geometry.dispose();
    multiSelectionOverlay.geometry = edgesGeo;
    multiSelectionOverlay.matrix.identity();
    multiSelectionOverlay.updateMatrixWorld(true);
}

export function syncSelectionPointsOverlay(delta) {
    if (selectionPointsOverlay) {
        selectionPointsOverlay.position.add(delta);
        selectionPointsOverlay.updateMatrixWorld(true);
    }
}

export function syncSelectionOverlay(deltaMatrix) {
    if (selectionOverlay) {
        selectionOverlay.matrix.premultiply(deltaMatrix);
        selectionOverlay.updateMatrixWorld(true);
    }
}

export function findClosestVertexForSnapping(gizmoWorldPos, camera, renderer, snapThreshold = 15) {
    if (!selectionPointsOverlay) return null;

    const rect = renderer.domElement.getBoundingClientRect();
    const width = rect.width;
    const height = rect.height;

    const gizmoScreenPos = _TMP_VEC3_B.copy(gizmoWorldPos);
    gizmoScreenPos.project(camera);

    const gizmoX = (gizmoScreenPos.x * 0.5 + 0.5) * width;
    const gizmoY = (1 - (gizmoScreenPos.y * 0.5 + 0.5)) * height;

    let minDistanceSq = snapThreshold * snapThreshold;
    let snapTarget = null;
    
    const tempVec = _TMP_VEC3_A;

    for (const child of selectionPointsOverlay.children) {
        if (!child.isSprite) continue;
        if (child.userData && child.userData.isCenter) continue;

        tempVec.copy(child.position);
        tempVec.project(camera);

        const vx = (tempVec.x * 0.5 + 0.5) * width;
        const vy = (1 - (tempVec.y * 0.5 + 0.5)) * height;
        
        const dx = vx - gizmoX;
        const dy = vy - gizmoY;
        const dSq = dx*dx + dy*dy;
        
        if (dSq < minDistanceSq) {
            minDistanceSq = dSq;
            snapTarget = child.position;
        }
    }
    return snapTarget;
}

export function getHoveredVertex(mouseNDC, camera, renderer) {
    if (!selectionPointsOverlay || selectionPointsOverlay.children.length === 0) return null;

    const canvas = renderer.domElement;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    
    const mouseX = (mouseNDC.x * 0.5 + 0.5) * width;
    const mouseY = (-mouseNDC.y * 0.5 + 0.5) * height;
    
    // Judgment: 2x wider than point (10px). Radius = 10px (diameter 20px).
    const hitRadiusSq = 10 * 10; 
    
    let bestDistSq = Infinity;
    let bestSprite = null;
    
    const tempVec = _TMP_VEC3_A;

    for (const sprite of selectionPointsOverlay.children) {
        if (!sprite.isSprite) continue;

        tempVec.copy(sprite.position);
        tempVec.project(camera);
        
        if (tempVec.z < -1 || tempVec.z > 1) continue;
        
        const sx = (tempVec.x * 0.5 + 0.5) * width;
        const sy = (-tempVec.y * 0.5 + 0.5) * height;
        
        const dx = sx - mouseX;
        const dy = sy - mouseY;
        const distSq = dx*dx + dy*dy;
        
        if (distSq < hitRadiusSq && distSq < bestDistSq) {
            bestDistSq = distSq;
            bestSprite = sprite;
        }
    }
    
    return bestSprite;
}

export function updateVertexHoverHighlight(hoveredSprite, selectedVertexKeys) {
    if (!selectionPointsOverlay) return;
    
    let selectedSprite = null;
    let existingLine = null;
    
    selectionPointsOverlay.children.forEach(child => {
        if (child.name === 'VertexHoverLine') {
            existingLine = child;
            return;
        }
        if (!child.isSprite) return;
        
        const sprite = child;
        const isHovered = (sprite === hoveredSprite);
        const isSelected = sprite.userData && sprite.userData.key && selectedVertexKeys.has(sprite.userData.key);
        
        if (isSelected) {
            selectedSprite = sprite;
        }
        
        if (isHovered || isSelected) {
            sprite.material.color.setHex(0x437FD0); 
        } else {
            sprite.material.color.setHex(0x30333D);
        }
    });

    if (selectedVertexKeys.size === 1 && hoveredSprite && selectedSprite && hoveredSprite !== selectedSprite) {
         if (!existingLine) {
            const geometry = new THREE.BufferGeometry().setFromPoints([selectedSprite.position, hoveredSprite.position]);
            const material = new THREE.LineBasicMaterial({ 
                color: 0x437FD0, 
                depthTest: false, 
                transparent: true 
            });
            const line = new THREE.Line(geometry, material);
            line.name = 'VertexHoverLine';
            selectionPointsOverlay.add(line);
         } else {
            existingLine.geometry.setFromPoints([selectedSprite.position, hoveredSprite.position]);
         }
    } else {
        if (existingLine) {
            selectionPointsOverlay.remove(existingLine);
            existingLine.geometry.dispose();
            existingLine.material.dispose();
        }
    }
}

export function findSpritesByKeys(keys) {
    if (!selectionPointsOverlay) return {};
    const result = {};
    const keySet = new Set(keys);
    selectionPointsOverlay.children.forEach(child => {
       if (child.isSprite && child.userData && keySet.has(child.userData.key)) {
           result[child.userData.key] = child;
       } 
    });
    return result;
}

export function refreshSelectionPointColors(selectedVertexKeys) {
    if (!selectionPointsOverlay) return;
    selectionPointsOverlay.children.forEach(sprite => {
         if (!sprite.isSprite || !sprite.userData || !sprite.userData.key) return;
         const isSelected = selectedVertexKeys.has(sprite.userData.key);
         sprite.material.color.setHex(isSelected ? 0x437FD0 : 0x30333D);
    });
}