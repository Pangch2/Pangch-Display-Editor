import {
    Matrix4,
    Object3D,
    Vector3
} from 'three/webgpu';
import type { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { isAltTabShortcut } from './handle-key';

type TransformMode = 'translate' | 'rotate' | 'scale';

export type MatrixInstanceObject = Object3D & {
    getMatrixAt?: (index: number, matrix: Matrix4) => void;
    setMatrixAt?: (index: number, matrix: Matrix4) => void;
    instanceMatrix?: { needsUpdate: boolean };
};

type CustomPivotUserData = {
    customPivot?: Vector3;
    customPivots?: Map<number, Vector3>;
    isCustomPivot?: boolean;
};

export interface CustomPivotState {
    isAltPressed: boolean;
    isPivotDrag: boolean;
    previousModeBeforePivot: TransformMode | null;
}

const inverseMatrix = new Matrix4();
const instanceMatrix = new Matrix4();
const worldMatrix = new Matrix4();

export function createCustomPivotState(): CustomPivotState {
    return {
        isAltPressed: false,
        isPivotDrag: false,
        previousModeBeforePivot: null
    };
}

export function setAltPressed(state: CustomPivotState, isPressed: boolean): void {
    state.isAltPressed = isPressed;
}

export function handleCustomPivotKeyDown(
    state: CustomPivotState,
    event: KeyboardEvent,
    hasSelection: boolean,
    transformControls: TransformControls
): void {
    if (isAltTabShortcut(event, state.isAltPressed)) {
        cancelCustomPivotMode(state, transformControls);
        return;
    }

    if (event.key !== 'Alt' || state.isAltPressed) return;

    state.isAltPressed = true;
    if (!hasSelection) return;

    if (!state.previousModeBeforePivot) {
        state.previousModeBeforePivot = transformControls.mode as TransformMode;
    }
    transformControls.setMode('translate');
}

export function handleCustomPivotKeyUp(
    state: CustomPivotState,
    event: KeyboardEvent,
    transformControls: TransformControls
): void {
    if (event.key !== 'Alt') return;

    state.isAltPressed = false;
    restorePreviousTransformMode(state, transformControls);
}

export function cancelCustomPivotMode(
    state: CustomPivotState,
    transformControls: TransformControls
): void {
    state.isAltPressed = false;
    state.isPivotDrag = false;
    restorePreviousTransformMode(state, transformControls);
}

export function beginCustomPivotDrag(state: CustomPivotState): boolean {
    state.isPivotDrag = state.isAltPressed;
    return state.isPivotDrag;
}

export function endCustomPivotDrag(
    state: CustomPivotState,
    selectedObjects: Map<Object3D, Set<number>>,
    pivotWorld: Vector3
): boolean {
    if (!state.isPivotDrag) return false;

    commitCustomPivot(selectedObjects, pivotWorld);
    state.isPivotDrag = false;
    return true;
}

export function restorePreviousTransformMode(
    state: CustomPivotState,
    transformControls: TransformControls
): void {
    if (!state.previousModeBeforePivot) return;

    transformControls.setMode(state.previousModeBeforePivot);
    state.previousModeBeforePivot = null;
}

export function getCustomPivotWorld(mesh: Object3D, instanceId: number, target: Vector3): boolean {
    const userData = mesh.userData as CustomPivotUserData;
    const matrixObject = mesh as MatrixInstanceObject;
    const localPivot = typeof matrixObject.getMatrixAt === 'function'
        ? userData.customPivots?.get(instanceId)
        : userData.customPivot;

    if (!localPivot) return false;

    getObjectWorldMatrix(mesh, instanceId, worldMatrix);
    target.copy(localPivot).applyMatrix4(worldMatrix);
    return true;
}

function commitCustomPivot(selectedObjects: Map<Object3D, Set<number>>, pivotWorld: Vector3): void {
    for (const [mesh, instanceIds] of selectedObjects) {
        const matrixObject = mesh as MatrixInstanceObject;
        const userData = mesh.userData as CustomPivotUserData;

        for (const instanceId of instanceIds) {
            getObjectWorldMatrix(mesh, instanceId, worldMatrix);
            inverseMatrix.copy(worldMatrix).invert();
            const localPivot = pivotWorld.clone().applyMatrix4(inverseMatrix);

            if (typeof matrixObject.getMatrixAt === 'function') {
                if (!userData.customPivots) userData.customPivots = new Map<number, Vector3>();
                userData.customPivots.set(instanceId, localPivot);
            } else {
                userData.customPivot = localPivot;
            }
        }

        userData.isCustomPivot = true;
    }
}

function getObjectWorldMatrix(mesh: Object3D, instanceId: number, target: Matrix4): Matrix4 {
    const matrixObject = mesh as MatrixInstanceObject;
    mesh.updateMatrixWorld(true);

    if (typeof matrixObject.getMatrixAt === 'function') {
        matrixObject.getMatrixAt(instanceId, instanceMatrix);
        return target.multiplyMatrices(mesh.matrixWorld, instanceMatrix);
    }

    return target.copy(mesh.matrixWorld);
}
