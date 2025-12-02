import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import * as THREE from 'three/webgpu';

let scene, camera, renderer, controls, loadedObjectGroup;
let transformControls = null;
let selectionHelper = null;
let previousHelperMatrix = new THREE.Matrix4();

// Selection State
let currentSelection = {
    mesh: null,
    instanceIds: []
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
let draggingMode = null;
let isGizmoBusy = false;
let blockbenchScaleMode = false;
let dragAnchorDirections = { x: true, y: true, z: true };
let previousGizmoMode = 'translate';
let isPivotEditMode = false;
let isUniformScale = false;

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

function updateSelectionOverlay() {
    if (selectionOverlay) {
        if (selectionOverlay.parent) {
            selectionOverlay.parent.remove(selectionOverlay);
        }
        selectionOverlay.traverse(child => {
            if (child.geometry) child.geometry.dispose();
            if (child.material) child.material.dispose();
        });
        selectionOverlay = null;
    }

    if (!currentSelection.mesh || currentSelection.instanceIds.length === 0) return;

    const mesh = currentSelection.mesh;
    const box = new THREE.Box3();
    const tempMat = new THREE.Matrix4();
    const tempBox = new THREE.Box3();

    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
    const geoBox = mesh.geometry.boundingBox;

    for (const id of currentSelection.instanceIds) {
        mesh.getMatrixAt(id, tempMat);
        tempBox.copy(geoBox).applyMatrix4(tempMat);
        box.union(tempBox);
    }

    const size = new THREE.Vector3();
    box.getSize(size);
    const center = new THREE.Vector3();
    box.getCenter(center);

    const overlayGeometry = new THREE.BoxGeometry(size.x, size.y, size.z);
    overlayGeometry.translate(center.x, center.y, center.z);
    const edges = new THREE.EdgesGeometry(overlayGeometry);
    const overlayMaterial = new THREE.LineBasicMaterial({
        color: 0xFFD147,
        depthTest: false,
        depthWrite: false,
        transparent: true,
        opacity: 0.9
    });

    selectionOverlay = new THREE.LineSegments(edges, overlayMaterial);
    selectionOverlay.renderOrder = 1000;
    selectionOverlay.matrixAutoUpdate = false;
    scene.add(selectionOverlay);
}

function resetSelectionAndDeselect() {
    if (currentSelection.mesh) {
        transformControls.detach();
        currentSelection = { mesh: null, instanceIds: [] };
        updateSelectionOverlay();
        lastDirections = { X: null, Y: null, Z: null };
        console.log('선택 해제');
    }
}

function applySelection(mesh, instanceIds) {
    currentSelection = { mesh, instanceIds };
    
    // Calculate center of selection
    const center = new THREE.Vector3();
    const tempPos = new THREE.Vector3();
    const tempMat = new THREE.Matrix4();
    
    instanceIds.forEach(id => {
        mesh.getMatrixAt(id, tempMat);
        tempPos.setFromMatrixPosition(tempMat);
        center.add(tempPos);
    });
    center.divideScalar(instanceIds.length);

    // Position helper
    selectionHelper.position.copy(center);
    selectionHelper.quaternion.set(0, 0, 0, 1);
    selectionHelper.scale.set(1, 1, 1);
    selectionHelper.updateMatrixWorld();

    transformControls.attach(selectionHelper);
    previousHelperMatrix.copy(selectionHelper.matrixWorld);
    
    updateSelectionOverlay();
    console.log(`선택됨: InstancedMesh (IDs: ${instanceIds.join(',')})`);
}

function initGizmo({scene: s, camera: cam, renderer: rend, controls: orbitControls, loadedObjectGroup: lg, setControls}) {
    scene = s; camera = cam; renderer = rend; controls = orbitControls; loadedObjectGroup = lg;

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
        } else {
            draggingMode = null;
            isUniformScale = false;
        }
    });

    transformControls.addEventListener('change', (event) => {
        if (transformControls.dragging && currentSelection.mesh) {
            const tempMatrix = new THREE.Matrix4();
            const deltaMatrix = new THREE.Matrix4();

            // Calculate delta: current * inverse(previous)
            tempMatrix.copy(previousHelperMatrix).invert();
            deltaMatrix.multiplyMatrices(selectionHelper.matrixWorld, tempMatrix);

            const instanceMatrix = new THREE.Matrix4();
            currentSelection.instanceIds.forEach(id => {
                currentSelection.mesh.getMatrixAt(id, instanceMatrix);
                instanceMatrix.premultiply(deltaMatrix);
                currentSelection.mesh.setMatrixAt(id, instanceMatrix);
            });
            currentSelection.mesh.instanceMatrix.needsUpdate = true;

            previousHelperMatrix.copy(selectionHelper.matrixWorld);
            updateSelectionOverlay();
        }
    });

    // key handling
    const handleKeyPress = (key) => {
        switch (key) {
            case 't':
                transformControls.setMode('translate');
                break;
            case 'r':
                transformControls.setMode('rotate');
                break;
            case 's':
                transformControls.setMode('scale');
                break;
            case 'x': {
                currentSpace = currentSpace === 'world' ? 'local' : 'world';
                transformControls.setSpace(currentSpace);
                console.log('TransformControls Space:', currentSpace);
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
    const mouse = new THREE.Vector2();
    let mouseDownPos = null;

    loadedObjectGroup.userData.resetSelection = resetSelectionAndDeselect;

    renderer.domElement.addEventListener('pointerdown', (event) => {
        if (isGizmoBusy) return;
        if (event.button !== 0) return;
        if (transformControls.dragging) return;
        mouseDownPos = { x: event.clientX, y: event.clientY };
    });

    renderer.domElement.addEventListener('pointerup', (event) => {
        if (!mouseDownPos) return;
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
            // Find first InstancedMesh intersection
            for (const intersect of intersects) {
                if (intersect.object.isInstancedMesh) {
                    targetIntersect = intersect;
                    break;
                }
            }

            if (targetIntersect) {
                const { object, instanceId } = targetIntersect;
                // Check if already selected
                if (currentSelection.mesh === object && currentSelection.instanceIds.includes(instanceId)) {
                    // Already selected, maybe do nothing or toggle? For now, just re-select (no-op)
                } else {
                    applySelection(object, [instanceId]);
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
        getSelectedObject: () => currentSelection.mesh // Return mesh or null
    };
}

export { initGizmo };
