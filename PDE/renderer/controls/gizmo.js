import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import * as THREE from 'three/webgpu';

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
    let children = [];
    for (const child of group.children) {
        if (child.type === 'group') {
            children = children.concat(getAllGroupChildren(child.id));
        } else {
            children.push(child);
        }
    }
    return children;
}

function getGroupBoundingBox(groupId) {
    const children = getAllGroupChildren(groupId);
    const box = new THREE.Box3();
    const tempMat = new THREE.Matrix4();
    const tempBox = new THREE.Box3();

    if (children.length === 0) return box;

    children.forEach(child => {
        const mesh = child.mesh;
        const id = child.instanceId;

        if (!mesh) return;

        mesh.getMatrixAt(id, tempMat);
        tempMat.premultiply(mesh.matrixWorld);

        let geoBox = null;
        if (mesh.isBatchedMesh) {
            if (mesh.userData.instanceGeometryIds && mesh.userData.geometryBounds) {
                const geomId = mesh.userData.instanceGeometryIds[id];
                geoBox = mesh.userData.geometryBounds.get(geomId);
            }
        } else {
            if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
            geoBox = mesh.geometry.boundingBox;
             // Player Head logic
             if (mesh.userData.displayType === 'item_display' && mesh.userData.hasHat && !mesh.userData.hasHat[id]) {
                const center = new THREE.Vector3();
                geoBox.getCenter(center);
                geoBox = new THREE.Box3().setFromCenterAndSize(center, new THREE.Vector3(1, 1, 1));
            }
        }

        if (geoBox) {
            tempBox.copy(geoBox).applyMatrix4(tempMat);
            box.union(tempBox);
        }
    });
    return box;
}

function getGroupLocalBoundingBox(groupId) {
    const groups = getGroups();
    const group = groups.get(groupId);
    if (!group) return new THREE.Box3();

    if (!group.position) group.position = calculateAvgOrigin(null, null, groupId);
    if (!group.quaternion) group.quaternion = new THREE.Quaternion();
    if (!group.scale) group.scale = new THREE.Vector3(1, 1, 1);

    const groupMatrix = new THREE.Matrix4().compose(group.position, group.quaternion, group.scale);
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

        mesh.getMatrixAt(id, tempMat);
        tempMat.premultiply(mesh.matrixWorld);
        tempMat.premultiply(groupInverse);

        let geoBox = null;
        if (mesh.isBatchedMesh) {
            if (mesh.userData.instanceGeometryIds && mesh.userData.geometryBounds) {
                const geomId = mesh.userData.instanceGeometryIds[id];
                geoBox = mesh.userData.geometryBounds.get(geomId);
            }
        } else {
            if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
            geoBox = mesh.geometry.boundingBox;
             
             if (mesh.userData.displayType === 'item_display' && mesh.userData.hasHat && !mesh.userData.hasHat[id]) {
                const center = new THREE.Vector3();
                geoBox.getCenter(center);
                geoBox = new THREE.Box3().setFromCenterAndSize(center, new THREE.Vector3(1, 1, 1));
            }
        }

        if (geoBox) {
            tempBox.copy(geoBox).applyMatrix4(tempMat);
            box.union(tempBox);
        }
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
    edgesGeometry: null
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
let draggingMode = null;
let isGizmoBusy = false;
let blockbenchScaleMode = false;
let dragAnchorDirections = { x: true, y: true, z: true };
let previousGizmoMode = 'translate';
let isPivotEditMode = false;
let isUniformScale = false;
let isCustomPivot = false;
let pivotOffset = new THREE.Vector3(0, 0, 0);

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

function SelectionCenter(mesh, instanceIds, pivotMode, isCustomPivot, pivotOffset, groupId = null) {
    const center = new THREE.Vector3();

    if (groupId) {
        // Group Selection Center
        if (pivotMode === 'center') {
            const localBox = getGroupLocalBoundingBox(groupId);
            const centerLocal = new THREE.Vector3();
            localBox.getCenter(centerLocal);
            
            const groups = getGroups();
            const group = groups.get(groupId);
            if (group && group.position) {
                center.copy(centerLocal);
                center.applyQuaternion(group.quaternion);
                center.multiply(group.scale);
                center.add(group.position);
            } else {
                // Fallback if group transform not ready
                const box = getGroupBoundingBox(groupId);
                box.getCenter(center);
            }
        } else {
            const groups = getGroups();
            const group = groups.get(groupId);
            if (group && group.position) {
                center.copy(group.position);
            } else {
                center.copy(calculateAvgOrigin(null, null, groupId));
            }
        }
        if (pivotMode === 'origin') {
            center.add(pivotOffset);
        }
        return center;
    }

    let displayType = mesh.userData.displayType;
    if (mesh.isBatchedMesh && mesh.userData.displayTypes && instanceIds.length > 0) {
        displayType = mesh.userData.displayTypes.get(instanceIds[0]);
    }

    const isBlockDisplayWithoutCustomPivotOrigin = pivotMode === 'origin' && displayType === 'block_display' && !isCustomPivot;

    if (isBlockDisplayWithoutCustomPivotOrigin) {
        let localPivot;
        if (mesh.isBatchedMesh) {
            localPivot = new THREE.Vector3(0, 0, 0);
            if (mesh.userData.instanceGeometryIds && mesh.userData.geometryBounds) {
                const batchId = instanceIds[0];
                const geomId = mesh.userData.instanceGeometryIds[batchId];
                const box = mesh.userData.geometryBounds.get(geomId);
                if (box) {
                    localPivot.copy(box.min);
                }
            }
        } else {
            if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
            const geoBox = mesh.geometry.boundingBox;
            localPivot = geoBox.min;
        }

        const firstId = instanceIds[0];
        
        const instanceMatrix = new THREE.Matrix4();
        mesh.getMatrixAt(firstId, instanceMatrix);

        if (mesh.isBatchedMesh && mesh.userData.localMatrices && mesh.userData.localMatrices.has(firstId)) {
             const localMatrix = mesh.userData.localMatrices.get(firstId);
             const localInverse = localMatrix.clone().invert();
             instanceMatrix.multiply(localInverse);
        }
        
        const worldMatrix = new THREE.Matrix4().multiplyMatrices(mesh.matrixWorld, instanceMatrix);
        
        center.copy(localPivot.clone().applyMatrix4(worldMatrix));

    } else if (pivotMode === 'center') {
        const box = new THREE.Box3();
        const tempMat = new THREE.Matrix4();
        const tempBox = new THREE.Box3();
        
        if (!mesh.isBatchedMesh) {
            if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
        }
        const defaultGeoBox = mesh.geometry ? mesh.geometry.boundingBox : null;

        instanceIds.forEach(id => {
            mesh.getMatrixAt(id, tempMat);
            tempMat.premultiply(mesh.matrixWorld);
            
            let geoBox = defaultGeoBox;
            if (mesh.isBatchedMesh && mesh.userData.instanceGeometryIds && mesh.userData.geometryBounds) {
                const geomId = mesh.userData.instanceGeometryIds[id];
                geoBox = mesh.userData.geometryBounds.get(geomId);
            }

            if (geoBox) {
                tempBox.copy(geoBox).applyMatrix4(tempMat);
                box.union(tempBox);
            }
        });
        box.getCenter(center);
    } else {
        center.copy(calculateAvgOrigin(mesh, instanceIds));
    }

    if (pivotMode === 'origin') {
        center.add(pivotOffset);
    }

    return center;
}

function calculateAvgOrigin(mesh, instanceIds, groupId = null) {
    const center = new THREE.Vector3();
    
    if (groupId) {
        const children = getAllGroupChildren(groupId);
        if (children.length === 0) return center;
        
        const tempPos = new THREE.Vector3();
        const tempMat = new THREE.Matrix4();

        children.forEach(child => {
            const m = child.mesh;
            const id = child.instanceId;
            
            m.getMatrixAt(id, tempMat);
            
            if (m.isBatchedMesh && m.userData.localMatrices && m.userData.localMatrices.has(id)) {
                 const localMatrix = m.userData.localMatrices.get(id);
                 const localInverse = localMatrix.clone().invert();
                 tempMat.multiply(localInverse);
            }

            tempMat.premultiply(m.matrixWorld);
            
            let localY = 0;
            let displayType = m.userData.displayType;
            if (m.isBatchedMesh && m.userData.displayTypes) {
                displayType = m.userData.displayTypes.get(id);
            }

            if (displayType === 'item_display' && m.userData.hasHat && m.userData.hasHat[id]) {
                localY = 0.03125;
            }
            
            tempPos.set(0, localY, 0).applyMatrix4(tempMat);
            center.add(tempPos);
        });
        center.divideScalar(children.length);
        return center;
    }

    const tempPos = new THREE.Vector3();
    const tempMat = new THREE.Matrix4();
    
    instanceIds.forEach(id => {
        mesh.getMatrixAt(id, tempMat);
        
        if (mesh.isBatchedMesh && mesh.userData.localMatrices && mesh.userData.localMatrices.has(id)) {
             const localMatrix = mesh.userData.localMatrices.get(id);
             const localInverse = localMatrix.clone().invert();
             tempMat.multiply(localInverse);
        }

        tempMat.premultiply(mesh.matrixWorld);
        
        let localY = 0;
        let displayType = mesh.userData.displayType;
        if (mesh.isBatchedMesh && mesh.userData.displayTypes) {
            displayType = mesh.userData.displayTypes.get(id);
        }

        if (displayType === 'item_display' && mesh.userData.hasHat && mesh.userData.hasHat[id]) {
            localY = 0.03125;
        }
        
        tempPos.set(0, localY, 0).applyMatrix4(tempMat);
        center.add(tempPos);
    });
    center.divideScalar(instanceIds.length);
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

        const size = new THREE.Vector3();
        localBox.getSize(size);
        const center = new THREE.Vector3();
        localBox.getCenter(center);

        const boxGeo = new THREE.BoxGeometry(size.x, size.y, size.z);
        boxGeo.translate(center.x, center.y, center.z);
        const edgesGeo = new THREE.EdgesGeometry(boxGeo);
        
        const overlayMaterial = new THREE.LineBasicMaterial({
            color: 0x6FA21C,
            depthTest: true,
            depthWrite: false,
            transparent: true,
            opacity: 0.9
        });

        selectionOverlay = new THREE.LineSegments(edgesGeo, overlayMaterial);
        
        if (group.position) selectionOverlay.position.copy(group.position);
        if (group.quaternion) selectionOverlay.quaternion.copy(group.quaternion);
        if (group.scale) selectionOverlay.scale.copy(group.scale);

        selectionOverlay.renderOrder = 1;
        scene.add(selectionOverlay);
        return;
    }

    if (!currentSelection.mesh || currentSelection.instanceIds.length === 0) return;

    const mesh = currentSelection.mesh;
    
    // Use cached edges geometry or create new one
    if (!currentSelection.edgesGeometry) {
        if (mesh.isBatchedMesh) {
            let boxGeo;
            if (mesh.userData.instanceGeometryIds && mesh.userData.geometryBounds) {
                const batchId = currentSelection.instanceIds[0];
                const geomId = mesh.userData.instanceGeometryIds[batchId];
                const box = mesh.userData.geometryBounds.get(geomId);
                
                if (box) {
                    const size = new THREE.Vector3();
                    box.getSize(size);
                    const center = new THREE.Vector3();
                    box.getCenter(center);
                    
                    boxGeo = new THREE.BoxGeometry(size.x, size.y, size.z);
                    boxGeo.translate(center.x, center.y, center.z);
                }
            }

            if (boxGeo) {
                currentSelection.edgesGeometry = new THREE.EdgesGeometry(boxGeo);
            }
        } else {
            if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
            const box = mesh.geometry.boundingBox;
            const size = new THREE.Vector3();
            box.getSize(size);
            const center = new THREE.Vector3();
            box.getCenter(center);
            
            const boxGeo = new THREE.BoxGeometry(size.x, size.y, size.z);
            boxGeo.translate(center.x, center.y, center.z);

            currentSelection.edgesGeometry = new THREE.EdgesGeometry(boxGeo);
        }
    }
    
    if (!currentSelection.edgesGeometry) return;
    const edgesGeo = currentSelection.edgesGeometry;

    let displayType = mesh.userData.displayType;
    if (mesh.isBatchedMesh && mesh.userData.displayTypes && currentSelection.instanceIds.length > 0) {
        displayType = mesh.userData.displayTypes.get(currentSelection.instanceIds[0]);
    }

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

    const tempMat = new THREE.Matrix4();
    for (const id of currentSelection.instanceIds) {
        mesh.getMatrixAt(id, tempMat);
        const line = new THREE.LineSegments(edgesGeo, overlayMaterial);
        line.matrixAutoUpdate = false;
        // Calculate World Matrix for the overlay line
        // Overlay is in Scene (World) space.
        // Mesh Instance Matrix is in Mesh Local Space.
        // Line Matrix = Mesh World Matrix * Instance Matrix
        line.matrix.multiplyMatrices(mesh.matrixWorld, tempMat);
        selectionOverlay.add(line);
    }
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
        updateSelectionOverlay();
        lastDirections = { X: null, Y: null, Z: null };
        console.log('선택 해제');
    }
}

function updateHelperPosition() {
    if ((!currentSelection.mesh || currentSelection.instanceIds.length === 0) && !currentSelection.groupId) return;
    
    const mesh = currentSelection.mesh;
    const instanceIds = currentSelection.instanceIds;
    const groupId = currentSelection.groupId;

    const center = SelectionCenter(mesh, instanceIds, pivotMode, isCustomPivot, pivotOffset, groupId);

    // Position helper
    selectionHelper.position.copy(center);
    
    // Align helper rotation with the first selected instance
    if (groupId) {
        const groups = getGroups();
        const group = groups.get(groupId);
        if (group && group.quaternion) {
            selectionHelper.quaternion.copy(group.quaternion);
        } else {
            selectionHelper.quaternion.set(0, 0, 0, 1);
        }
        if (group && group.scale) {
            selectionHelper.scale.copy(group.scale);
        } else {
            selectionHelper.scale.set(1, 1, 1);
        }
    } else if (instanceIds.length > 0) {
        const firstId = instanceIds[0];
        const instanceMatrix = new THREE.Matrix4();
        mesh.getMatrixAt(firstId, instanceMatrix);
        const worldMatrix = instanceMatrix.premultiply(mesh.matrixWorld);
        
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
    // Clean up previous selection geometry if switching meshes
    // BatchedMesh의 경우 인스턴스마다 지오메트리가 다를 수 있으므로 항상 재생성
    if (currentSelection.mesh && (currentSelection.mesh !== mesh || mesh?.isBatchedMesh)) {
        if (currentSelection.edgesGeometry) {
            currentSelection.edgesGeometry.dispose();
            currentSelection.edgesGeometry = null;
        }
    }

    // Reset pivot offset when selecting new things
    let customPivot = null;
    if (groupId) {
        // Group selection pivot logic (default to center/origin)
        pivotOffset.set(0, 0, 0);
        isCustomPivot = false;
    } else if ((mesh.isBatchedMesh || mesh.isInstancedMesh) && mesh.userData.customPivots && instanceIds.length > 0) {
        // Try to get custom pivot from the first selected instance
        if (mesh.userData.customPivots.has(instanceIds[0])) {
            customPivot = mesh.userData.customPivots.get(instanceIds[0]);
        }
    } else if (mesh.userData.customPivot) {
        customPivot = mesh.userData.customPivot;
    }

    if (customPivot && !groupId) {
        isCustomPivot = true;
        
        // Calculate Average Origin (Center) to determine offset
        const center = calculateAvgOrigin(mesh, instanceIds);

        // Calculate Target World Position from Custom Pivot (Local to First Instance)
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

    currentSelection = { mesh, instanceIds, edgesGeometry: currentSelection.edgesGeometry, groupId };
    
    updateHelperPosition();
    
    updateSelectionOverlay();
    if (groupId) {
        console.log(`그룹 선택됨: ${groupId}`);
    } else {
        console.log(`선택됨: InstancedMesh (IDs: ${instanceIds.join(',')})`);
    }
}

function createGroup() {
    if ((!currentSelection.mesh || currentSelection.instanceIds.length === 0) && !currentSelection.groupId) return;

    const groups = getGroups();
    const objectToGroup = getObjectToGroup();

    let initialPosition = new THREE.Vector3();
    if (currentSelection.groupId) {
        // If wrapping an existing group, use its position if available, otherwise average
        const existingGroup = groups.get(currentSelection.groupId);
        if (existingGroup.position) {
            initialPosition.copy(existingGroup.position);
        } else {
            initialPosition = calculateAvgOrigin(null, null, currentSelection.groupId);
        }
    } else {
        initialPosition = calculateAvgOrigin(currentSelection.mesh, currentSelection.instanceIds);
    }

    const newGroupId = THREE.MathUtils.generateUUID();
    const newGroup = {
        id: newGroupId,
        isCollection: true, // "isCollection": true is a group
        children: [],
        parent: null,
        name: 'Group',
        position: initialPosition,
        quaternion: new THREE.Quaternion(),
        scale: new THREE.Vector3(1, 1, 1)
    };

    if (currentSelection.groupId) {
        // If a group is selected, we are grouping this group
        const childGroupId = currentSelection.groupId;
        const childGroup = groups.get(childGroupId);
        
        // If childGroup had a parent, newGroup should take its place in the parent
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
        // Objects selected
        const mesh = currentSelection.mesh;
        const instanceIds = currentSelection.instanceIds;
        
        // Check for common parent
        let commonParentId = undefined;
        
        for (const id of instanceIds) {
            const key = getGroupKey(mesh, id);
            const gid = objectToGroup.get(key);
            if (commonParentId === undefined) {
                commonParentId = gid;
            } else if (commonParentId !== gid) {
                commonParentId = null; // Mixed parents or some have no parent
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
                // Remove from old group
                if (oldGroup) {
                    oldGroup.children = oldGroup.children.filter(c => !(c.type === 'object' && c.mesh === mesh && c.instanceId === id));
                }
            }
            
            newGroup.children.push({ type: 'object', mesh, instanceId: id });
            objectToGroup.set(key, newGroupId);
        });
    }

    groups.set(newGroupId, newGroup);
    applySelection(null, [], newGroupId);
    console.log(`Group created: ${newGroupId}`);
    return newGroupId;
}

function initGizmo({scene: s, camera: cam, renderer: rend, controls: orbitControls, loadedObjectGroup: lg, setControls}) {
    scene = s; camera = cam; renderer = rend; controls = orbitControls; loadedObjectGroup = lg;

    // Expose group data for persistence/other modules
    if (!loadedObjectGroup.userData.groups) loadedObjectGroup.userData.groups = new Map();
    if (!loadedObjectGroup.userData.objectToGroup) loadedObjectGroup.userData.objectToGroup = new Map();

    // Create Selection Helper
    selectionHelper = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.1), new THREE.MeshBasicMaterial({ visible: false }));
    scene.add(selectionHelper);

    const mouseInput = new THREE.Vector2();
    let detectedAnchorDirections = { x: null, y: null, z: null };

    renderer.domElement.addEventListener('pointerdown', (event) => {
        const rect = renderer.domElement.getBoundingClientRect();
        mouseInput.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        mouseInput.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

        // Reset detected directions
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

    // create transformControls
    transformControls = new TransformControls(camera, renderer.domElement);
    transformControls.setMode('translate');
    transformControls.setSpace('world');
    transformControls.setColors(0xEF3751, 0x6FA21C, 0x437FD0, 0xfeff3e);
    scene.add(transformControls.getHelper());

    // patch gizmo visuals (clone negative lines)
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

    // drag handler
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
                if (currentSelection.groupId) {
                    dragStartAvgOrigin.copy(calculateAvgOrigin(null, null, currentSelection.groupId));
                } else if (currentSelection.mesh && currentSelection.instanceIds.length > 0) {
                    dragStartAvgOrigin.copy(calculateAvgOrigin(currentSelection.mesh, currentSelection.instanceIds));
                }
            }

            if (blockbenchScaleMode && draggingMode === 'scale' && !isUniformScale) {
                dragInitialBoundingBox.makeEmpty();
                
                // Calculate bounding box of all selected instances
                if (currentSelection.groupId) {
                    const box = getGroupBoundingBox(currentSelection.groupId);
                    if (!box.isEmpty()) {
                        selectionHelper.updateMatrixWorld();
                        const inverseHelperMat = selectionHelper.matrixWorld.clone().invert();
                        
                        // Transform box corners to helper local space
                        // Note: getGroupBoundingBox returns World Space AABB.
                        // We need to transform it to Helper Local Space.
                        // But wait, getGroupBoundingBox returns AABB aligned to world axes.
                        // If the group is rotated, the AABB might be loose.
                        // Ideally we should calculate OBB or transform individual instance boxes.
                        
                        // For simplicity, let's iterate children again like in getGroupBoundingBox but transform to helper space.
                        const children = getAllGroupChildren(currentSelection.groupId);
                        const tempMat = new THREE.Matrix4();
                        
                        children.forEach(child => {
                            const mesh = child.mesh;
                            const id = child.instanceId;
                            
                            let geoBox = null;
                            if (mesh.isBatchedMesh) {
                                if (mesh.userData.instanceGeometryIds && mesh.userData.geometryBounds) {
                                    const geomId = mesh.userData.instanceGeometryIds[id];
                                    geoBox = mesh.userData.geometryBounds.get(geomId);
                                }
                            } else {
                                if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
                                geoBox = mesh.geometry.boundingBox;
                                if (mesh.userData.displayType === 'item_display' && mesh.userData.hasHat && !mesh.userData.hasHat[id]) {
                                    const center = new THREE.Vector3();
                                    geoBox.getCenter(center);
                                    geoBox = new THREE.Box3().setFromCenterAndSize(center, new THREE.Vector3(1, 1, 1));
                                }
                            }
                            
                            if (!geoBox) return;
                            
                            mesh.getMatrixAt(id, tempMat);
                            tempMat.premultiply(mesh.matrixWorld);
                            
                            const combinedMat = inverseHelperMat.clone().multiply(tempMat);
                            
                            const corners = [
                                new THREE.Vector3(geoBox.min.x, geoBox.min.y, geoBox.min.z),
                                new THREE.Vector3(geoBox.min.x, geoBox.min.y, geoBox.max.z),
                                new THREE.Vector3(geoBox.min.x, geoBox.max.y, geoBox.min.z),
                                new THREE.Vector3(geoBox.min.x, geoBox.max.y, geoBox.max.z),
                                new THREE.Vector3(geoBox.max.x, geoBox.min.y, geoBox.min.z),
                                new THREE.Vector3(geoBox.max.x, geoBox.min.y, geoBox.max.z),
                                new THREE.Vector3(geoBox.max.x, geoBox.max.y, geoBox.min.z),
                                new THREE.Vector3(geoBox.max.x, geoBox.max.y, geoBox.max.z)
                            ];
                            
                            corners.forEach(corner => {
                                corner.applyMatrix4(combinedMat);
                                dragInitialBoundingBox.expandByPoint(corner);
                            });
                        });
                    }
                } else {
                    const mesh = currentSelection.mesh;
                    const instanceIds = currentSelection.instanceIds;
                    if (mesh && instanceIds.length > 0) {
                        selectionHelper.updateMatrixWorld();
                        const inverseHelperMat = selectionHelper.matrixWorld.clone().invert();
                        const tempMat = new THREE.Matrix4();

                        instanceIds.forEach(id => {
                            let geoBox = null;

                            if (mesh.isBatchedMesh) {
                                if (mesh.userData.instanceGeometryIds && mesh.userData.geometryBounds) {
                                    const geomId = mesh.userData.instanceGeometryIds[id];
                                    geoBox = mesh.userData.geometryBounds.get(geomId);
                                }
                            } else {
                                if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
                                geoBox = mesh.geometry.boundingBox;

                                // Player Head logic for InstancedMesh
                                if (mesh.userData.displayType === 'item_display' && mesh.userData.hasHat && !mesh.userData.hasHat[id]) {
                                    const center = new THREE.Vector3();
                                    geoBox.getCenter(center);
                                    geoBox = new THREE.Box3().setFromCenterAndSize(center, new THREE.Vector3(1, 1, 1));
                                }
                            }

                            if (!geoBox) return;

                            mesh.getMatrixAt(id, tempMat);
                            tempMat.premultiply(mesh.matrixWorld); // Instance World Matrix
                            
                            // Transform to Helper Local Space
                            const combinedMat = inverseHelperMat.clone().multiply(tempMat);
                            
                            const corners = [
                                new THREE.Vector3(geoBox.min.x, geoBox.min.y, geoBox.min.z),
                                new THREE.Vector3(geoBox.min.x, geoBox.min.y, geoBox.max.z),
                                new THREE.Vector3(geoBox.min.x, geoBox.max.y, geoBox.min.z),
                                new THREE.Vector3(geoBox.min.x, geoBox.max.y, geoBox.max.z),
                                new THREE.Vector3(geoBox.max.x, geoBox.min.y, geoBox.min.z),
                                new THREE.Vector3(geoBox.max.x, geoBox.min.y, geoBox.max.z),
                                new THREE.Vector3(geoBox.max.x, geoBox.max.y, geoBox.min.z),
                                new THREE.Vector3(geoBox.max.x, geoBox.max.y, geoBox.max.z)
                            ];
                            
                            corners.forEach(corner => {
                                corner.applyMatrix4(combinedMat);
                                dragInitialBoundingBox.expandByPoint(corner);
                            });
                        });
                    }
                }

                const gizmoPos = selectionHelper.position.clone();
                const gizmoNDC = gizmoPos.clone().project(camera);
                gizmoNDC.z = 0;

                //const mouseNDC = new THREE.Vector3(mouseInput.x, mouseInput.y, 0);

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
                // Save custom pivot
                if (currentSelection.mesh && currentSelection.instanceIds.length > 0) {
                    const mesh = currentSelection.mesh;
                    const firstId = currentSelection.instanceIds[0];
                    const pivotWorld = selectionHelper.position.clone();
                    
                    const instanceMatrix = new THREE.Matrix4();
                    mesh.getMatrixAt(firstId, instanceMatrix);
                    const worldMatrix = instanceMatrix.premultiply(mesh.matrixWorld);
                    
                    const invWorldMatrix = worldMatrix.invert();
                    const localPivot = pivotWorld.applyMatrix4(invWorldMatrix);
                    
                    if (mesh.isBatchedMesh) {
                        if (!mesh.userData.customPivots) mesh.userData.customPivots = new Map();
                        
                        // Save for all selected instances (assuming they share the same item/pivot)
                        // Or just save for the first one if we assume they are grouped.
                        // If we have itemId, use that as key? Or instanceId?
                        // Using instanceId is safer if we don't have itemId, but if we have itemId, we should probably use that or store for all instances.
                        
                        // If we have itemIds, we can store by itemId if we want shared pivot for the item.
                        // But here we are selecting a group of instances.
                        
                        for (const id of currentSelection.instanceIds) {
                            mesh.userData.customPivots.set(id, localPivot.clone());
                        }
                    } else {
                        mesh.userData.customPivot = localPivot;
                    }
                    
                    mesh.userData.isCustomPivot = true;
                    pivotMode = 'origin';
                }
            } else {
                if (currentSelection.mesh && currentSelection.instanceIds.length > 0 && isCustomPivot) {
                    const mesh = currentSelection.mesh;
                    const instanceIds = currentSelection.instanceIds;
                    
                    let customPivot = null;
                    if ((mesh.isBatchedMesh || mesh.isInstancedMesh) && mesh.userData.customPivots && instanceIds.length > 0) {
                        if (mesh.userData.customPivots.has(instanceIds[0])) {
                            customPivot = mesh.userData.customPivots.get(instanceIds[0]);
                        }
                    } else if (mesh.userData.customPivot) {
                        customPivot = mesh.userData.customPivot;
                    }

                    if (customPivot) {
                        mesh.updateMatrixWorld();
                        const center = calculateAvgOrigin(mesh, instanceIds);
                        
                        const firstId = instanceIds[0];
                        const tempMat = new THREE.Matrix4();
                        mesh.getMatrixAt(firstId, tempMat);
                        const worldMatrix = tempMat.premultiply(mesh.matrixWorld);
                        const targetWorld = customPivot.clone().applyMatrix4(worldMatrix);
                        
                        pivotOffset.subVectors(targetWorld, center);
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
                pivotOffset.subVectors(selectionHelper.position, dragStartAvgOrigin);
                isCustomPivot = true;
                
                previousHelperMatrix.copy(selectionHelper.matrixWorld);
                return;
            }

            if (blockbenchScaleMode && transformControls.mode === 'scale' && !isUniformScale) {
                 if (!dragInitialBoundingBox.isEmpty()) {
                    const deltaScale = selectionHelper.scale; // Since initial is 1,1,1
                    const shift = new THREE.Vector3();
                    
                    if (Math.abs(deltaScale.x - 1) > 0.0001) {
                        const isPositive = dragAnchorDirections.x;
                        const fixedVal = isPositive ? dragInitialBoundingBox.min.x : dragInitialBoundingBox.max.x;
                        shift.x = fixedVal * (1 - deltaScale.x);
                    }
                    if (Math.abs(deltaScale.y - 1) > 0.0001) {
                        const isPositive = dragAnchorDirections.y;
                        const fixedVal = isPositive ? dragInitialBoundingBox.min.y : dragInitialBoundingBox.max.y;
                        shift.y = fixedVal * (1 - deltaScale.y);
                    }
                    if (Math.abs(deltaScale.z - 1) > 0.0001) {
                        const isPositive = dragAnchorDirections.z;
                        const fixedVal = isPositive ? dragInitialBoundingBox.min.z : dragInitialBoundingBox.max.z;
                        shift.z = fixedVal * (1 - deltaScale.z);
                    }
                    
                    const shiftWorld = shift.clone().applyQuaternion(selectionHelper.quaternion);
                    selectionHelper.position.copy(dragInitialPosition).add(shiftWorld);
                    selectionHelper.updateMatrixWorld();
                }
            }

            selectionHelper.updateMatrixWorld();
            const tempMatrix = new THREE.Matrix4();
            const deltaMatrix = new THREE.Matrix4();

            // Calculate delta: current * inverse(previous)
            tempMatrix.copy(previousHelperMatrix).invert();
            deltaMatrix.multiplyMatrices(selectionHelper.matrixWorld, tempMatrix);

            if (currentSelection.groupId) {
                const groups = getGroups();
                const group = groups.get(currentSelection.groupId);
                if (group) {
                    if (!group.position) group.position = calculateAvgOrigin(null, null, currentSelection.groupId);
                    if (!group.quaternion) group.quaternion = new THREE.Quaternion();
                    if (!group.scale) group.scale = new THREE.Vector3(1, 1, 1);

                    group.position.applyMatrix4(deltaMatrix);
                    group.quaternion.copy(selectionHelper.quaternion);
                    group.scale.copy(selectionHelper.scale);
                }

                const children = getAllGroupChildren(currentSelection.groupId);
                const instanceMatrix = new THREE.Matrix4();
                
                children.forEach(child => {
                    const mesh = child.mesh;
                    const id = child.instanceId;
                    
                    const meshWorldInverse = mesh.matrixWorld.clone().invert();
                    const localDelta = new THREE.Matrix4();
                    localDelta.multiplyMatrices(meshWorldInverse, deltaMatrix);
                    localDelta.multiply(mesh.matrixWorld);
                    
                    mesh.getMatrixAt(id, instanceMatrix);
                    instanceMatrix.premultiply(localDelta);
                    mesh.setMatrixAt(id, instanceMatrix);
                    
                    if (mesh.isInstancedMesh) {
                        mesh.instanceMatrix.needsUpdate = true;
                    }
                });
            } else {
                const instanceMatrix = new THREE.Matrix4();
                const meshWorldInverse = currentSelection.mesh.matrixWorld.clone().invert();
                
                // We need to apply delta in Mesh Local Space.
                // Delta is in World Space.
                // NewInstanceMatrix = Inverse(MeshWorld) * Delta * MeshWorld * OldInstanceMatrix
                
                const localDelta = new THREE.Matrix4();
                localDelta.multiplyMatrices(meshWorldInverse, deltaMatrix);
                localDelta.multiply(currentSelection.mesh.matrixWorld);

                currentSelection.instanceIds.forEach(id => {
                    currentSelection.mesh.getMatrixAt(id, instanceMatrix);
                    instanceMatrix.premultiply(localDelta);
                    currentSelection.mesh.setMatrixAt(id, instanceMatrix);

                    // If this object belongs to a group, we might need to update group bounds?
                    // Actually, since we use getGroupLocalBoundingBox which calculates bounds dynamically from children,
                    // the group bounds will automatically update when children move.
                    // However, the group transform (position/rotation) stays rigid, which is what we want.
                });
                if (currentSelection.mesh.isInstancedMesh) {
                    currentSelection.mesh.instanceMatrix.needsUpdate = true;
                }
            }

            previousHelperMatrix.copy(selectionHelper.matrixWorld);
            updateSelectionOverlay();
        }
    });

    // key handling
    const handleKeyPress = (key) => {
        const resetHelperRotationForWorldSpace = () => {
            if (currentSpace === 'world' && currentSelection.mesh && currentSelection.instanceIds.length > 0) {
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
                
                // Update selection helper rotation based on new space
                if (currentSelection.mesh && currentSelection.instanceIds.length > 0) {
                    if (currentSpace === 'world') {
                        selectionHelper.quaternion.set(0, 0, 0, 1);
                    } else {
                        const firstId = currentSelection.instanceIds[0];
                        const instanceMatrix = new THREE.Matrix4();
                        currentSelection.mesh.getMatrixAt(firstId, instanceMatrix);
                        const worldMatrix = instanceMatrix.premultiply(currentSelection.mesh.matrixWorld);
                        
                        // Use getRotationFromMatrix to avoid shear issues
                        const quaternion = getRotationFromMatrix(worldMatrix);
                        selectionHelper.quaternion.copy(quaternion);
                    }
                    selectionHelper.updateMatrixWorld();
                    previousHelperMatrix.copy(selectionHelper.matrixWorld);
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
                if (currentSelection.mesh && currentSelection.instanceIds.length > 0) {
                    const mesh = currentSelection.mesh;
                    const instanceIds = currentSelection.instanceIds;
                    
                    // 1. Capture Gizmo Position (Target)
                    const targetPosition = selectionHelper.position.clone();
                    
                    // 2. Loop max 10 times to remove shear if needed
                    let shearRemoved = false;
                    let attempts = 0;
                    const maxAttempts = 10;

                    while (!shearRemoved && attempts < maxAttempts) {
                        attempts++;
                        let maxShear = 0;

                        instanceIds.forEach(id => {
                            const matrix = new THREE.Matrix4();
                            mesh.getMatrixAt(id, matrix);
                            
                            // Check shear (dot product of normalized basis vectors)
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
                            
                            mesh.setMatrixAt(id, matrix);
                        });

                        if (maxShear < 0.0001) {
                            shearRemoved = true;
                        }
                    }
                    if (mesh.isInstancedMesh) {
                        mesh.instanceMatrix.needsUpdate = true;
                    }

                    // 3. Move Object to Gizmo
                    const currentCenter = SelectionCenter(mesh, instanceIds, pivotMode, isCustomPivot, pivotOffset);
                    
                    // Apply offset
                    const offset = new THREE.Vector3().subVectors(targetPosition, currentCenter);
                    const inverseMeshWorld = mesh.matrixWorld.clone().invert();
                    const tempMat = new THREE.Matrix4();
                    
                    instanceIds.forEach(id => {
                        mesh.getMatrixAt(id, tempMat);
                        tempMat.premultiply(mesh.matrixWorld);
                        
                        // Add offset in World Space
                        tempMat.elements[12] += offset.x;
                        tempMat.elements[13] += offset.y;
                        tempMat.elements[14] += offset.z;
                        
                        tempMat.premultiply(inverseMeshWorld);
                        mesh.setMatrixAt(id, tempMat);
                    });
                    if (mesh.isInstancedMesh) {
                        mesh.instanceMatrix.needsUpdate = true;
                    }

                    updateHelperPosition();
                    updateSelectionOverlay();
                    console.log('객체 스케일을 균일하게 조정 (Shear 제거, 10회 반복, 위치 보정)');
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

        // Handle Ctrl + Alt for pivot reset (order-independent)
        if (event.altKey && event.ctrlKey) {
            if (event.key === 'Alt' || event.key === 'Control') {
                event.preventDefault();
                pivotOffset.set(0, 0, 0);
                isCustomPivot = false;
                if (currentSelection.mesh) {
                    delete currentSelection.mesh.userData.customPivot;
                    delete currentSelection.mesh.userData.isCustomPivot;
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

        const intersects = raycaster.intersectObjects(loadedObjectGroup.children, true);
        if (intersects.length > 0) {
            let targetIntersect = null;
            // Find first InstancedMesh or BatchedMesh intersection
            for (const intersect of intersects) {
                if (intersect.object.isInstancedMesh || intersect.object.isBatchedMesh) {
                    targetIntersect = intersect;
                    break;
                }
            }

            if (targetIntersect) {
                const object = targetIntersect.object;
                const instanceId = object.isBatchedMesh ? targetIntersect.batchId : targetIntersect.instanceId;
                
                if (instanceId !== undefined) {
                    let idsToSelect = [instanceId];
                    
                    // Group selection by itemId for BatchedMesh
                    if (object.isBatchedMesh && object.userData.itemIds) {
                        const targetItemId = object.userData.itemIds.get(instanceId);
                        if (targetItemId !== undefined) {
                            idsToSelect = [];
                            for (const [id, itemId] of object.userData.itemIds) {
                                if (itemId === targetItemId) {
                                    idsToSelect.push(id);
                                }
                            }
                        }
                    }

                    // Check for Group Membership
                    // We use the first instanceId to check for group membership
                    // Assuming all instances in an item belong to the same group
                    const key = getGroupKey(object, idsToSelect[0]);
                    const objectToGroup = getObjectToGroup();
                    const immediateGroupId = objectToGroup.get(key);

                    if (immediateGroupId) {
                        const groupChain = getGroupChain(immediateGroupId);
                        
                        // Determine what to select
                        let nextGroupIdToSelect = groupChain[0]; // Default to Root

                        if (currentSelection.groupId) {
                            const currentIndex = groupChain.indexOf(currentSelection.groupId);
                            if (currentIndex !== -1) {
                                // Current selection is in the chain
                                if (currentIndex < groupChain.length - 1) {
                                    // Select next level down
                                    nextGroupIdToSelect = groupChain[currentIndex + 1];
                                } else {
                                    // We are at the immediate parent, next step is the object itself
                                    nextGroupIdToSelect = null; 
                                }
                            } else {
                                // Current selection is unrelated, start at Root
                                nextGroupIdToSelect = groupChain[0];
                            }
                        }

                        if (nextGroupIdToSelect) {
                            applySelection(null, [], nextGroupIdToSelect);
                        } else {
                            // Select Object
                            const isSameMesh = currentSelection.mesh === object;
                            const isSameSelection = isSameMesh && 
                                currentSelection.instanceIds.length === idsToSelect.length &&
                                currentSelection.instanceIds.every(id => idsToSelect.includes(id));

                            if (!isSameSelection) {
                                applySelection(object, idsToSelect);
                            }
                        }
                    } else {
                        // Check if already selected (simple check: same mesh and same set of IDs)
                        const isSameMesh = currentSelection.mesh === object;
                        const isSameSelection = isSameMesh && 
                            currentSelection.instanceIds.length === idsToSelect.length &&
                            currentSelection.instanceIds.every(id => idsToSelect.includes(id));

                        if (!isSameSelection) {
                            applySelection(object, idsToSelect);
                        }
                    }
                }
            } else {
                resetSelectionAndDeselect();
            }
        } else {
            resetSelectionAndDeselect();
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
            if (currentSelection.mesh && (transformControls.mode === 'translate' || transformControls.mode === 'scale')) {
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