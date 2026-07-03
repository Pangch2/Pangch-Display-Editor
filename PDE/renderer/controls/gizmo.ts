import {
    Group,
    Object3D,
    PerspectiveCamera,
    Quaternion,
    Raycaster,
    Renderer,
    Scene,
    Matrix4,
    Vector3,
    Vector2
} from 'three/webgpu';
import { setupGizmo } from './gizmo-setup';
import {
    clearSelectionState,
    createSelectionOverlay,
    createSelectionState,
    replaceSelectionWithObjectsMap,
    setObjectSelection
} from './overlay';
import { initHandleKey } from './handle-key';
import {
    beginCustomPivotDrag,
    cancelCustomPivotMode,
    createCustomPivotState,
    endCustomPivotDrag,
    getCustomPivotWorld,
    handleCustomPivotKeyDown,
    handleCustomPivotKeyUp,
    restorePreviousTransformMode,
    setAltPressed
} from './custom-pivot';
import type { MatrixInstanceObject } from './custom-pivot';

type PivotMode = 'origin' | 'center';
type TransformSpace = 'world' | 'local';

export interface InitGizmoParams {
    scene: Scene;
    camera: PerspectiveCamera;
    renderer: Renderer;
    controls: { enabled: boolean };
    loadedObjectGroup: Group;
}

export interface InitGizmoResult {
    updateGizmo: () => void;
}

const raycaster = new Raycaster();
const pointerNdc = new Vector2();
const selectedCenter = new Vector3();
const previousAnchorMatrix = new Matrix4();
const deltaMatrix = new Matrix4();
const inverseMatrix = new Matrix4();
const instanceMatrix = new Matrix4();
const worldMatrix = new Matrix4();
const pivotPosition = new Vector3();
const originPosition = new Vector3();
const selectedQuaternion = new Quaternion();
const preservedQuaternion = new Quaternion();
const lockedScaleQuaternion = new Quaternion();
const rotationMatrix = new Matrix4();
const basisX = new Vector3();
const basisY = new Vector3();
const basisZ = new Vector3();

export function initGizmo({ scene, camera, renderer, controls, loadedObjectGroup }: InitGizmoParams): InitGizmoResult {
    const selection = createSelectionState();
    const selectionOverlay = createSelectionOverlay(scene);
    const { transformControls } = setupGizmo(camera, renderer, scene);
    const gizmoAnchor = new Object3D();
    let pointerDownX = 0;
    let pointerDownY = 0;
    let pivotMode: PivotMode = 'center';
    let currentSpace: TransformSpace = transformControls.space as TransformSpace;
    let isScaleDragActive = false;
    let hasLockedScaleQuaternion = false;
    const customPivotState = createCustomPivotState();

    initHandleKey({
        getTransformControls: () => transformControls,
        onTransformControlsChanged: () => {
            currentSpace = transformControls.space as TransformSpace;
            hasLockedScaleQuaternion = false;
            if (selection.primary) {
                updateSelectedGizmo(selection.primary.mesh, selection.primary.instanceId);
            }
        },
        togglePivotMode: () => {
            pivotMode = pivotMode === 'center' ? 'origin' : 'center';
            if (selection.primary) {
                updateSelectedGizmo(selection.primary.mesh, selection.primary.instanceId);
            }
            return pivotMode;
        }
    });

    scene.add(gizmoAnchor);
    transformControls.detach();
    transformControls.addEventListener('dragging-changed', (event) => {
        controls.enabled = !event.value;

        if (event.value) {
            beginCustomPivotDrag(customPivotState);
            isScaleDragActive = transformControls.mode === 'scale';
            if (isScaleDragActive) {
                lockedScaleQuaternion.copy(gizmoAnchor.quaternion);
                hasLockedScaleQuaternion = true;
            }
            gizmoAnchor.updateMatrixWorld(true);
            previousAnchorMatrix.copy(gizmoAnchor.matrixWorld);
            return;
        }

        isScaleDragActive = false;

        if (endCustomPivotDrag(customPivotState, selection.objects, gizmoAnchor.position)) {
            console.log('Custom Pivot:', gizmoAnchor.position);
        }

        restorePreviousTransformMode(customPivotState, transformControls);

        if (selection.primary) {
            updateSelectedGizmo(selection.primary.mesh, selection.primary.instanceId);
        }
    });

    transformControls.addEventListener('change', () => {
        if (!transformControls.dragging || !selection.primary) return;

        gizmoAnchor.updateMatrixWorld(true);
        if (isScaleDragActive && hasLockedScaleQuaternion) {
            gizmoAnchor.quaternion.copy(lockedScaleQuaternion);
            gizmoAnchor.updateMatrixWorld(true);
        }

        if (customPivotState.isPivotDrag) {
            previousAnchorMatrix.copy(gizmoAnchor.matrixWorld);
            return;
        }

        inverseMatrix.copy(previousAnchorMatrix).invert();
        deltaMatrix.multiplyMatrices(gizmoAnchor.matrixWorld, inverseMatrix);
        applyDeltaToSelectedObjects(deltaMatrix);
        previousAnchorMatrix.copy(gizmoAnchor.matrixWorld);
        selectionOverlay.update(selection.primary.mesh, selection.primary.instanceId);
    });

    const handleKeyDown = (event: KeyboardEvent): void => {
        handleCustomPivotKeyDown(customPivotState, event, selection.primary !== null, transformControls);
    };

    const handleKeyUp = (event: KeyboardEvent): void => {
        handleCustomPivotKeyUp(customPivotState, event, transformControls);
    };

    const handleWindowBlur = (): void => {
        cancelCustomPivotMode(customPivotState, transformControls);
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', handleWindowBlur);

    const emitSelectionChanged = (): void => {
        window.dispatchEvent(new CustomEvent('pde:selection-changed', { detail: selection }));
    };

    const resetSelection = (): void => {
        hasLockedScaleQuaternion = false;
        clearSelectionState(selection);
        selectionOverlay.clear();
        transformControls.detach();
        emitSelectionChanged();
    };

    const setSelectedObject = (mesh: Object3D, instanceId: number): void => {
        hasLockedScaleQuaternion = false;
        setObjectSelection(selection, mesh, instanceId);
        updateSelectedGizmo(mesh, instanceId);
        emitSelectionChanged();
    };

    const replaceSelectedObjects = (meshToIds: Map<Object3D, Set<number>>): void => {
        hasLockedScaleQuaternion = false;
        replaceSelectionWithObjectsMap(selection, meshToIds);
        if (selection.primary) {
            updateSelectedGizmo(selection.primary.mesh, selection.primary.instanceId);
        } else {
            selectionOverlay.clear();
            transformControls.detach();
        }
        emitSelectionChanged();
    };

    const setPointerFromEvent = (event: PointerEvent | MouseEvent): boolean => {
        const rect = renderer.domElement.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return false;
        pointerNdc.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        pointerNdc.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
        return true;
    };

    const handlePointerDown = (event: PointerEvent): void => {
        if (event.button !== 0) return;
        setAltPressed(customPivotState, event.altKey);
        pointerDownX = event.clientX;
        pointerDownY = event.clientY;
    };

    const handleClick = (event: MouseEvent): void => {
        if (event.button !== 0) return;
        const movedX = event.clientX - pointerDownX;
        const movedY = event.clientY - pointerDownY;
        if ((movedX * movedX) + (movedY * movedY) > 16) return;
        if (!setPointerFromEvent(event)) return;

        raycaster.setFromCamera(pointerNdc, camera);
        const hit = raycaster.intersectObjects(loadedObjectGroup.children, true)[0];
        if (!hit) {
            resetSelection();
            return;
        }

        const instanceId = getHitInstanceId(hit);
        setSelectedObject(hit.object, instanceId);
    };

    function updateSelectedGizmo(mesh: Object3D, instanceId: number): void {
        if (!selectionOverlay.update(mesh, instanceId)) {
            transformControls.detach();
            return;
        }

        selectionOverlay.getCenter(selectedCenter);
        if (getCustomPivotWorld(mesh, instanceId, pivotPosition)) {
            gizmoAnchor.position.copy(pivotPosition);
        } else if (pivotMode === 'origin') {
            getSelectedOrigin(mesh, instanceId, originPosition);
            gizmoAnchor.position.copy(originPosition);
        } else {
            gizmoAnchor.position.copy(selectedCenter);
        }
        if (transformControls.mode === 'scale' && hasLockedScaleQuaternion) {
            gizmoAnchor.quaternion.copy(lockedScaleQuaternion);
        } else if (currentSpace === 'world') {
            gizmoAnchor.quaternion.identity();
        } else {
            getSelectedWorldRotation(mesh, instanceId, selectedQuaternion);
            gizmoAnchor.quaternion.copy(selectedQuaternion);
        }
        gizmoAnchor.scale.set(1, 1, 1);
        gizmoAnchor.updateMatrixWorld(true);
        transformControls.attach(gizmoAnchor);
    }

    function applyDeltaToSelectedObjects(delta: Matrix4): void {
        for (const [mesh, instanceIds] of selection.objects) {
            const matrixObject = mesh as MatrixInstanceObject;

            if (typeof matrixObject.getMatrixAt === 'function' && typeof matrixObject.setMatrixAt === 'function') {
                inverseMatrix.copy(mesh.matrixWorld).invert();
                worldMatrix.multiplyMatrices(inverseMatrix, delta);
                worldMatrix.multiply(mesh.matrixWorld);

                for (const instanceId of instanceIds) {
                    matrixObject.getMatrixAt(instanceId, instanceMatrix);
                    instanceMatrix.premultiply(worldMatrix);
                    matrixObject.setMatrixAt(instanceId, instanceMatrix);
                }

                if (matrixObject.instanceMatrix) matrixObject.instanceMatrix.needsUpdate = true;
                continue;
            }

            const parent = mesh.parent;
            if (parent) {
                inverseMatrix.copy(parent.matrixWorld).invert();
                worldMatrix.multiplyMatrices(inverseMatrix, delta);
                worldMatrix.multiply(parent.matrixWorld);
            } else {
                worldMatrix.copy(delta);
            }

            const preserveRotation = transformControls.mode === 'scale' && transformControls.space === 'world';
            if (preserveRotation) {
                preservedQuaternion.copy(mesh.quaternion);
            }

            mesh.updateMatrix();
            mesh.matrix.premultiply(worldMatrix);
            mesh.matrix.decompose(mesh.position, mesh.quaternion, mesh.scale);
            if (preserveRotation) {
                mesh.quaternion.copy(preservedQuaternion);
                mesh.updateMatrix();
            }
            mesh.updateMatrixWorld(true);
        }
    }

    loadedObjectGroup.userData.resetSelection = resetSelection;
    loadedObjectGroup.userData.replaceSelectionWithObjectsMap = replaceSelectedObjects;

    renderer.domElement.addEventListener('pointerdown', handlePointerDown);
    renderer.domElement.addEventListener('click', handleClick);

    return {
        updateGizmo: () => {}
    };
}

function getHitInstanceId(hit: { instanceId?: number; batchId?: number }): number {
    return hit.instanceId ?? hit.batchId ?? 0;
}

function getSelectedOrigin(mesh: Object3D, instanceId: number, target: Vector3): Vector3 {
    const matrixObject = mesh as MatrixInstanceObject;
    mesh.updateMatrixWorld(true);

    if (typeof matrixObject.getMatrixAt === 'function') {
        matrixObject.getMatrixAt(instanceId, instanceMatrix);
        worldMatrix.multiplyMatrices(mesh.matrixWorld, instanceMatrix);
        return target.setFromMatrixPosition(worldMatrix);
    }

    return target.setFromMatrixPosition(mesh.matrixWorld);
}

function getSelectedWorldRotation(mesh: Object3D, instanceId: number, target: Quaternion): Quaternion {
    const matrixObject = mesh as MatrixInstanceObject;
    mesh.updateMatrixWorld(true);

    if (typeof matrixObject.getMatrixAt === 'function') {
        matrixObject.getMatrixAt(instanceId, instanceMatrix);
        worldMatrix.multiplyMatrices(mesh.matrixWorld, instanceMatrix);
        return getRotationFromMatrix(worldMatrix, target);
    }

    return getRotationFromMatrix(mesh.matrixWorld, target);
}

function getRotationFromMatrix(matrix: Matrix4, target: Quaternion): Quaternion {
    const elements = matrix.elements;
    basisX.set(elements[0], elements[1], elements[2]).normalize();
    basisY.set(elements[4], elements[5], elements[6]).normalize();
    basisZ.set(elements[8], elements[9], elements[10]).normalize();
    rotationMatrix.makeBasis(basisX, basisY, basisZ);
    return target.setFromRotationMatrix(rotationMatrix);
}
