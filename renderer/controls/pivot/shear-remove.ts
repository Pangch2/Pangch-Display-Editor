import {
    Vector3,
    Object3D,
    Group,
    Matrix4
} from 'three/webgpu';
import * as GroupUtils from '../grouping/group';
import { getInstanceMatrix, getInstancePivot, setInstanceMatrix, setInstancePivot, type ObjectBatch } from '../../scene-store/object-access';
import { toMeshMap, type SelectionState } from '../selection/select';

export interface ShearItem {
    mesh: ObjectBatch;
    instanceId: number;
}

export type ShearSelection = Partial<SelectionState>;

export interface ShearCallbacks {
    SelectionCenter: (pivotMode: string, isCustomPivot: boolean, pivotOffset: Vector3) => Vector3;
    updateHelperPosition: () => void;
    updateSelectionOverlay: () => void;
}

/**
 * 선택된 객체들로부터 Shear(전단 변형)를 제거하고 스케일을 정규화합니다.
 * Gram-Schmidt 직교화 과정을 통해 행렬에서 Shear 성분을 수학적으로 완벽히 제거합니다.
 */
export function removeShearFromSelection(
    items: ShearItem[],
    selectionHelper: Object3D,
    currentSelection: ShearSelection,
    loadedObjectGroup: Group,
    pivotMode: string,
    isCustomPivot: boolean,
    pivotOffset: Vector3,
    callbacks: ShearCallbacks
): void {
    const { SelectionCenter, updateHelperPosition, updateSelectionOverlay } = callbacks;

    if (items.length > 0) {
        const getSelectionItemCount = (): number => {
            return (currentSelection.groups?.size ?? 0) + (currentSelection.objects?.size ?? 0);
        };

        const isMultiSelection = getSelectionItemCount() > 1;
        const targetPosition = selectionHelper.position.clone();
        
        // Store original custom pivot world positions before any matrix modifications
        const originalCustomPivotWorlds = new Map<string, Vector3>();
        const getCustomPivot = (mesh: any, instanceId: number): Vector3 | null => {
            if (!mesh || !mesh.userData) return null;
            return getInstancePivot(mesh, instanceId) ?? null;
        };

        items.forEach(({ mesh, instanceId }) => {
            const customPivot = getCustomPivot(mesh, instanceId);
            if (customPivot) {
                const matrix = new Matrix4();
                getInstanceMatrix(mesh, instanceId, matrix);
                const worldMatrix = matrix.premultiply(mesh.matrixWorld);
                const worldPos = customPivot.clone().applyMatrix4(worldMatrix);
                const key = `${mesh.uuid}_${instanceId}`;
                originalCustomPivotWorlds.set(key, worldPos);
            }
        });

        // Shear removal - Optimized to single pass using Gram-Schmidt Orthogonalization.
        // This method mathematically guarantees 0 shear in one step, so no iteration is needed.
        items.forEach(({mesh, instanceId}) => {
            const matrix = new Matrix4();
            getInstanceMatrix(mesh, instanceId, matrix);
            
            const position = new Vector3().setFromMatrixPosition(matrix);
            
            // Extract basis vectors
            const x = new Vector3().setFromMatrixColumn(matrix, 0);
            const y = new Vector3().setFromMatrixColumn(matrix, 1);
            const z = new Vector3().setFromMatrixColumn(matrix, 2);
            
            // Preserve Scale
            const sx = x.length();
            const sy = y.length();
            const sz = z.length();
            
            // Normalize for orthogonalization
            x.normalize();
            y.normalize();
            z.normalize();
            
            // Gram-Schmidt Orthogonalization (X is reference)
            // Make Y orthogonal to X
            y.sub(x.clone().multiplyScalar(y.dot(x))).normalize();
            // Make Z orthogonal to X and Y
            z.sub(x.clone().multiplyScalar(z.dot(x)))
             .sub(y.clone().multiplyScalar(z.dot(y)))
             .normalize();
            
            // Re-apply Scale
            x.multiplyScalar(sx);
            y.multiplyScalar(sy);
            z.multiplyScalar(sz);
            
            // Reconstruct Matrix
            matrix.makeBasis(x, y, z);
            matrix.setPosition(position);
            
            setInstanceMatrix(mesh, instanceId, matrix);
        });
        

        // For group selections, drop shear-carrying cached matrices BEFORE computing SelectionCenter.
        // This ensures the center used for offset matches what updateHelperPosition() will use next.
        if (currentSelection.groups && currentSelection.groups.size > 0) {
            const groups = GroupUtils.getGroups(loadedObjectGroup);
            const toClear = new Set<string>();
            for (const rootId of currentSelection.groups) {
                if (!rootId) continue;
                toClear.add(rootId);
                const descendants = GroupUtils.getAllDescendantGroups(loadedObjectGroup, rootId);
                for (const subId of descendants) toClear.add(subId);
            }
            for (const id of toClear) {
                const g = groups.get(id);
                if (g && g.matrix) delete g.matrix;
            }
        }

        // Keep the current gizmo position as the visual anchor. For multi-selection origin
        // mode, the gizmo is managed by separate anchor state, so SelectionCenter can disagree
        // with that anchor and create drift if used as a translation source.
        const shouldKeepGizmoPosition = !isMultiSelection || pivotMode === 'center';
        if (shouldKeepGizmoPosition) {
            // Keep gizmo world position fixed, move objects to match it.
            const currentCenter = SelectionCenter(pivotMode, isCustomPivot, pivotOffset);
            const offset = new Vector3().subVectors(targetPosition, currentCenter);

            if (offset.lengthSq() > 1e-12) {
                const tempMat = new Matrix4();

                items.forEach(({mesh, instanceId}) => {
                    const inverseMeshWorld = mesh.matrixWorld.clone().invert();
                    getInstanceMatrix(mesh, instanceId, tempMat);
                    tempMat.premultiply(mesh.matrixWorld);

                    tempMat.elements[12] += offset.x;
                    tempMat.elements[13] += offset.y;
                    tempMat.elements[14] += offset.z;

                    tempMat.premultiply(inverseMeshWorld);
                    setInstanceMatrix(mesh, instanceId, tempMat);
                });
            }

            // Single-object custom pivot: keep stored local pivot aligned with its world position.
            // Without this, reselect recomputes pivotOffset from stale local pivot and gizmo jumps.
            if (
                isCustomPivot &&
                currentSelection.objects &&
                currentSelection.objects.size === 1 &&
                currentSelection.primary?.type === 'object'
            ) {
                for (const [mesh, ids] of toMeshMap(currentSelection.objects)) {
                    if (!mesh || !ids || ids.size === 0) continue;

                    const worldMatrix = new Matrix4();
                    const invWorldMatrix = new Matrix4();


                    for (const instanceId of ids) {
                        const key = `${mesh.uuid}_${instanceId}`;
                        const originalWorldPos = originalCustomPivotWorlds.get(key);
                        const newWorldPos = originalWorldPos
                            ? originalWorldPos.clone().add(offset)
                            : targetPosition.clone();

                        getInstanceMatrix(mesh, instanceId, worldMatrix);
                        worldMatrix.premultiply(mesh.matrixWorld);
                        invWorldMatrix.copy(worldMatrix).invert();
                        setInstancePivot(mesh, instanceId, newWorldPos.applyMatrix4(invWorldMatrix));
                    }
                }
            }
        }

        updateHelperPosition();
        updateSelectionOverlay();
        console.log('스케일 정규화 및 위치 보정 (Shear 제거)');
    }
}
