import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import * as THREE from 'three/webgpu';

// Gizmo module/internal state
let scene, camera, renderer, controls, loadedObjectGroup;
let transformControls = null;
let selectedObject = null;
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
let draggingMode = null;
let isGizmoBusy = false;

// Helpers (originally in renderer.js)
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

function updatePivot(wrapper) {
    if (!wrapper) return;
    const content = wrapper.children[0];
    if (!content) return;

    let targetPivotLocal = new THREE.Vector3(0, 0, 0);
    if (pivotMode === 'center') {
        const box = new THREE.Box3();
        content.traverse(child => {
            if (child.isMesh) {
                if (!child.geometry.boundingBox) child.geometry.computeBoundingBox();
                box.union(child.geometry.boundingBox);
            }
        });
        box.getCenter(targetPivotLocal);
    }

    content.updateWorldMatrix(true, false);
    const targetPivotWorld = targetPivotLocal.clone().applyMatrix4(content.matrixWorld);
    const adjustmentOffset = targetPivotWorld.clone().sub(wrapper.position);
    if (adjustmentOffset.lengthSq() > 0.000001) {
        wrapper.position.add(adjustmentOffset);
        const localCounter = adjustmentOffset.clone().applyQuaternion(wrapper.quaternion.clone().invert());
        const inverseTranslate = new THREE.Matrix4().makeTranslation(-localCounter.x, -localCounter.y, -localCounter.z);
        content.matrix.premultiply(inverseTranslate);
        content.matrixWorldNeedsUpdate = true;
    }
}

function updateSelectionOverlay(wrapper) {
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

    if (!wrapper) return;
    const content = wrapper.children[0];
    if (!content) return;

    const displayType = wrapper.userData?.displayType;
    let overlayColor;
    if (displayType === 'block_display') {
        overlayColor = 0xFFD147;
    } else if (displayType === 'item_display') {
        overlayColor = 0x2E87EC;
    } else {
        return;
    }

    const localBox = new THREE.Box3();
    content.traverse(child => {
        if (child.isMesh && child.geometry) {
            if (!child.geometry.boundingBox) {
                child.geometry.computeBoundingBox();
            }
            const childBox = child.geometry.boundingBox.clone();
            childBox.applyMatrix4(child.matrix);
            localBox.union(childBox);
        }
    });

    const size = new THREE.Vector3();
    localBox.getSize(size);
    const center = new THREE.Vector3();
    localBox.getCenter(center);
    const overlayGeometry = new THREE.BoxGeometry(size.x, size.y, size.z);
    overlayGeometry.translate(center.x, center.y, center.z);
    const edges = new THREE.EdgesGeometry(overlayGeometry);
    const overlayMaterial = new THREE.LineBasicMaterial({
        color: overlayColor,
        depthTest: true,
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
    if (selectedObject) {
        const wrapper = transformControls.object;
        if (wrapper) {
            if (currentSpace === 'local') {
                const quaternion = wrapper.quaternion.clone();
                const rotationMatrix = new THREE.Matrix4().makeRotationFromQuaternion(quaternion);
                const content = wrapper.children[0];
                if (content) {
                    content.matrix.premultiply(rotationMatrix);
                    content.matrixWorldNeedsUpdate = true;
                }
            }
            wrapper.quaternion.set(0, 0, 0, 1);
            wrapper.scale.set(1, 1, 1);
        }
        transformControls.detach();
        selectedObject = null;
        updateSelectionOverlay(null);
        lastDirections = { X: null, Y: null, Z: null };
        console.log('선택 해제');
    }
}

function initGizmo({scene: s, camera: cam, renderer: rend, controls: orbitControls, loadedObjectGroup: lg, setControls}) {
    scene = s; camera = cam; renderer = rend; controls = orbitControls; loadedObjectGroup = lg;
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
                    // Ensure original and negative have deterministic renderOrder: negative above original

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
        const wrapper = transformControls.object;
        if (!wrapper) return;
        const content = wrapper.children[0];
        if (!content) return;
        if (event.value) {
            dragInitialMatrix.copy(content.matrix);
            dragInitialQuaternion.copy(wrapper.quaternion);
            dragInitialScale.copy(wrapper.scale);
            draggingMode = transformControls.mode;
        } else {
            if (!draggingMode) return;
            if (currentSpace === 'local') {
                if (draggingMode === 'rotate') {
                } else if (draggingMode === 'scale') {
                    const finalScale = wrapper.scale.clone();
                    if (dragInitialScale.x !== 0 && dragInitialScale.y !== 0 && dragInitialScale.z !== 0) {
                        const deltaScale = finalScale.divide(dragInitialScale);
                        const deltaScaleMatrix = new THREE.Matrix4().makeScale(deltaScale.x, deltaScale.y, deltaScale.z);
                        content.matrix.copy(dragInitialMatrix).premultiply(deltaScaleMatrix);
                    }
                }
            } else {
                if (draggingMode === 'scale') {
                    const finalScale = wrapper.scale.clone();
                    const deltaScale = finalScale.divide(dragInitialScale);
                    const deltaScaleMatrix = new THREE.Matrix4().makeScale(deltaScale.x, deltaScale.y, deltaScale.z);
                    content.matrix.copy(dragInitialMatrix).premultiply(deltaScaleMatrix);
                } else if (draggingMode === 'rotate') {
                    const finalQuaternion = wrapper.quaternion.clone();
                    const deltaQuaternion = finalQuaternion.multiply(dragInitialQuaternion.clone().invert());
                    const deltaRotationMatrix = new THREE.Matrix4().makeRotationFromQuaternion(deltaQuaternion);
                    content.matrix.copy(dragInitialMatrix).premultiply(deltaRotationMatrix);
                }
            }
            content.matrixWorldNeedsUpdate = true;
            wrapper.scale.set(1, 1, 1);
            if (!(draggingMode === 'rotate' && currentSpace === 'local')) {
                wrapper.quaternion.copy(dragInitialQuaternion);
            }
            updatePivot(wrapper);
            draggingMode = null;
        }
    });

    // key handling
    const handleKeyPress = (key) => {
        const wrapper = transformControls.object;
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
                if (wrapper) {
                    const content = wrapper.children[0];
                    if (currentSpace === 'local') {
                        content.updateWorldMatrix(true, false);
                        const quaternion = getRotationFromMatrix(content.matrixWorld);
                        wrapper.quaternion.copy(quaternion);
                        const inverseQuaternion = quaternion.clone().invert();
                        const inverseRotationMatrix = new THREE.Matrix4().makeRotationFromQuaternion(inverseQuaternion);
                        content.matrix.premultiply(inverseRotationMatrix);
                        content.matrixWorldNeedsUpdate = true;
                    } else {
                        const quaternion = wrapper.quaternion.clone();
                        const rotationMatrix = new THREE.Matrix4().makeRotationFromQuaternion(quaternion);
                        content.matrix.premultiply(rotationMatrix);
                        content.matrixWorldNeedsUpdate = true;
                        wrapper.quaternion.set(0, 0, 0, 1);
                    }
                    updatePivot(wrapper);
                }
                break;
            }
            case 'z': {
                pivotMode = pivotMode === 'origin' ? 'center' : 'origin';
                console.log('Pivot Mode:', pivotMode);
                if (wrapper) updatePivot(wrapper);
                break;
            }
        }
    };

    window.addEventListener('keydown', (event) => {
        if (event.target.tagName === 'INPUT' || event.target.tagName === 'TEXTAREA') return;
        if (isGizmoBusy) return;
        const key = event.key.toLowerCase();
        const keysToHandle = ['t', 'r', 's', 'x', 'z'];
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
            let targetObject = null;
            for (const intersect of intersects) {
                let obj = intersect.object; let isGizmo = false; let checkParent = obj;
                while (checkParent) {
                    if (checkParent === transformControls || checkParent.isTransformControlsGizmo) { isGizmo = true; break; }
                    checkParent = checkParent.parent;
                }
                if (!isGizmo) { targetObject = obj; break; }
            }
            if (targetObject) {
                while (targetObject.parent && targetObject.parent !== loadedObjectGroup) targetObject = targetObject.parent;
                if (selectedObject !== targetObject) {
                    if (selectedObject) resetSelectionAndDeselect();
                    selectedObject = targetObject;
                    transformControls.attach(selectedObject);
                    if (currentSpace === 'local') {
                        const content = selectedObject.children[0];
                        content.updateWorldMatrix(true, false);
                        const quaternion = getRotationFromMatrix(content.matrixWorld);
                        selectedObject.quaternion.copy(quaternion);
                        const inverseQuaternion = quaternion.clone().invert();
                        const inverseRotationMatrix = new THREE.Matrix4().makeRotationFromQuaternion(inverseQuaternion);
                        content.matrix.premultiply(inverseRotationMatrix);
                        content.matrixWorldNeedsUpdate = true;
                    }
                    updatePivot(selectedObject);
                    updateSelectionOverlay(selectedObject);
                    console.log('선택된 객체:', selectedObject);
                }
            }
        } else {
            if (selectedObject) resetSelectionAndDeselect();
        }
    });

    return {
        getTransformControls: () => transformControls,
        updateGizmo: () => {
            // overlay update
            if (selectedObject && selectionOverlay) {
                const content = selectedObject.children[0];
                if (content) {
                    content.updateWorldMatrix(true, false);
                    selectionOverlay.matrix.copy(content.matrixWorld);
                }
            }
            // gizmo axis positive/negative toggling
            if (selectedObject && (transformControls.mode === 'translate' || transformControls.mode === 'scale')) {
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
        getSelectedObject: () => selectedObject
    };
}

export { initGizmo };