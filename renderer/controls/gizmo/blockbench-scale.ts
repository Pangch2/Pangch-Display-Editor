import { 
    Matrix4, 
    Matrix3, 
    Object3D, 
    Quaternion,
    Vector3, 
    Box3 
} from 'three/webgpu';

export let blockbenchScaleMode: boolean = false;

// Helpers to avoid allocations
const _BB_PIVOT_FRAME_MAT4 = new Matrix4();
const _BB_PIVOT_FRAME_MAT4_INV = new Matrix4();
export const _BB_PIVOT_FRAME_MAT3 = new Matrix3();

export function toggleBlockbenchScaleMode(): boolean {
    blockbenchScaleMode = !blockbenchScaleMode;
    console.log(`blockbench scale모드 ${blockbenchScaleMode ? '켜짐' : '꺼짐'}`);
    window.dispatchEvent(new CustomEvent('pde:blockbench-scale-mode-changed', { detail: blockbenchScaleMode }));
    return blockbenchScaleMode;
}

interface PivotFrameMatrices {
    mat4: Matrix4;
    invMat4: Matrix4;
    mat3: Matrix3;
}

export function computeBlockbenchPivotFrame(selectionHelper: Object3D, currentSpace: 'world' | 'local'): PivotFrameMatrices {
    // Default: use the current selectionHelper world matrix
    _BB_PIVOT_FRAME_MAT4.copy(selectionHelper.matrixWorld);

    // In world space mode, Blockbench anchor should behave like world axes.
    if (currentSpace === 'world') {
        _BB_PIVOT_FRAME_MAT4.identity();
        _BB_PIVOT_FRAME_MAT4.setPosition(selectionHelper.position);
    }

    _BB_PIVOT_FRAME_MAT4_INV.copy(_BB_PIVOT_FRAME_MAT4).invert();
    _BB_PIVOT_FRAME_MAT3.setFromMatrix4(_BB_PIVOT_FRAME_MAT4);
    
    return {
        mat4: _BB_PIVOT_FRAME_MAT4,
        invMat4: _BB_PIVOT_FRAME_MAT4_INV,
        mat3: _BB_PIVOT_FRAME_MAT3
    };
}

export function getBlockbenchPivotFrameMatrices(): PivotFrameMatrices {
    return {
        mat4: _BB_PIVOT_FRAME_MAT4,
        invMat4: _BB_PIVOT_FRAME_MAT4_INV,
        mat3: _BB_PIVOT_FRAME_MAT3
    };
}

export function transformBoxToPivotFrame(worldMatrix: Matrix4, tempMat4: Matrix4 = new Matrix4()): Matrix4 {
    // Transform: Object Local -> World -> Pivot Frame
    // matrix = InvPivotFrame * WorldMatrix
    return tempMat4.copy(_BB_PIVOT_FRAME_MAT4_INV).multiply(worldMatrix);
}

interface AxisSelection {
    x: boolean;
    y: boolean;
    z: boolean;
}

export function detectBlockbenchScaleAxes(
    pointStart: Vector3,
    worldQuaternionStart: Quaternion
): AxisSelection {
    const localPointStart = pointStart.clone().applyQuaternion(worldQuaternionStart.clone().invert());

    return {
        x: localPointStart.x > 0,
        y: localPointStart.y > 0,
        z: localPointStart.z > 0
    };
}

if (import.meta.env.DEV) {
    const axes = detectBlockbenchScaleAxes(new Vector3(-1, 1, 1), new Quaternion());
    console.assert(!axes.x && axes.y && axes.z, 'Blockbench scale must follow the grabbed negative handle.');
}

export function computeBlockbenchScaleShift(
    selectionHelper: Object3D, 
    dragInitialScale: Vector3, 
    _dragInitialPosition: Vector3, 
    dragInitialBoundingBox: Box3, 
    dragAnchorDirections: AxisSelection, 
    currentSpace: 'world' | 'local'
): Vector3 | null {
    if (dragInitialBoundingBox.isEmpty()) return null;

    const deltaScale = selectionHelper.scale; 
    const shift = new Vector3();
    let hasShift = false;
    
    if (Math.abs(deltaScale.x - dragInitialScale.x) > 0.0001) {
        const isPositive = dragAnchorDirections.x;
        const fixedVal = isPositive ? dragInitialBoundingBox.min.x : dragInitialBoundingBox.max.x;
        if (Math.abs(dragInitialScale.x) > 1e-6) {
            shift.x = (fixedVal * (dragInitialScale.x - deltaScale.x)) / dragInitialScale.x;
            hasShift = true;
        }
    }
    if (Math.abs(deltaScale.y - dragInitialScale.y) > 0.0001) {
        const isPositive = dragAnchorDirections.y;
        const fixedVal = isPositive ? dragInitialBoundingBox.min.y : dragInitialBoundingBox.max.y;
        if (Math.abs(dragInitialScale.y) > 1e-6) {
            shift.y = (fixedVal * (dragInitialScale.y - deltaScale.y)) / dragInitialScale.y;
            hasShift = true;
        }
    }
    if (Math.abs(deltaScale.z - dragInitialScale.z) > 0.0001) {
        const isPositive = dragAnchorDirections.z;
        const fixedVal = isPositive ? dragInitialBoundingBox.min.z : dragInitialBoundingBox.max.z;
        if (Math.abs(dragInitialScale.z) > 1e-6) {
            shift.z = (fixedVal * (dragInitialScale.z - deltaScale.z)) / dragInitialScale.z;
            hasShift = true;
        }
    }
    
    if (!hasShift) return null;

    // Convert from pivot-frame local shift to world.
    const shiftWorld = shift.clone();
    if (currentSpace === 'local') {
        shiftWorld.applyMatrix3(_BB_PIVOT_FRAME_MAT3);
    }
    
    return shiftWorld;
}
