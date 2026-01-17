import * as THREE from 'three/webgpu';

export let blockbenchScaleMode = false;

// Helpers to avoid allocations
const _BB_PIVOT_FRAME_MAT4 = new THREE.Matrix4();
const _BB_PIVOT_FRAME_MAT4_INV = new THREE.Matrix4();
export const _BB_PIVOT_FRAME_MAT3 = new THREE.Matrix3();

export function toggleBlockbenchScaleMode() {
    blockbenchScaleMode = !blockbenchScaleMode;
    console.log(`blockbench scale모드 ${blockbenchScaleMode ? '켜짐' : '꺼짐'}`);
    return blockbenchScaleMode;
}

export function computeBlockbenchPivotFrame(selectionHelper, currentSpace) {
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

export function getBlockbenchPivotFrameMatrices() {
    return {
        mat4: _BB_PIVOT_FRAME_MAT4,
        invMat4: _BB_PIVOT_FRAME_MAT4_INV,
        mat3: _BB_PIVOT_FRAME_MAT3
    };
}

export function transformBoxToPivotFrame(worldMatrix, tempMat4 = new THREE.Matrix4()) {
    // Transform: Object Local -> World -> Pivot Frame
    // matrix = InvPivotFrame * WorldMatrix
    return tempMat4.copy(_BB_PIVOT_FRAME_MAT4_INV).multiply(worldMatrix);
}

export function detectBlockbenchScaleAxes(camera, mouseInput, selectionHelper, currentSpace, defaultDetectedKeys) {
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

    return {
        x: defaultDetectedKeys.x !== null ? defaultDetectedKeys.x : checkAxis(1, 0, 0),
        y: defaultDetectedKeys.y !== null ? defaultDetectedKeys.y : checkAxis(0, 1, 0),
        z: defaultDetectedKeys.z !== null ? defaultDetectedKeys.z : checkAxis(0, 0, 1)
    };
}

export function computeBlockbenchScaleShift(selectionHelper, dragInitialScale, dragInitialPosition, dragInitialBoundingBox, dragAnchorDirections, currentSpace) {
    if (dragInitialBoundingBox.isEmpty()) return null;

    const deltaScale = selectionHelper.scale; 
    const shift = new THREE.Vector3();
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
