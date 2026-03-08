import * as THREE from 'three/webgpu';
import type { SelectedItem } from '../selection/select';
import type { GroupData } from '../structure/group';
import {
    computeBlockbenchPivotFrame,
    transformBoxToPivotFrame,
    detectBlockbenchScaleAxes
} from './blockbench-scale';
import { unionTransformedBox3 } from '../selection/overlay';

type PdeMesh = THREE.InstancedMesh | THREE.BatchedMesh | THREE.Mesh;

// ─── Internal temporaries ────────────────────────────────────────────────────

const _tmpPrevInvMatrix = new THREE.Matrix4();
const _tmpInstanceMatrix = new THREE.Matrix4();
const _tmpMeshWorldInverse = new THREE.Matrix4();
const _tmpLocalDelta = new THREE.Matrix4();

// ─── buildMeshToInstanceIds ──────────────────────────────────────────────────

/**
 * 선택된 아이템 배열로부터 mesh → instanceId[] 맵을 구성합니다.
 */
export function buildMeshToInstanceIds(
    items: SelectedItem[],
    out: Map<THREE.Object3D, number[]>
): void {
    out.clear();
    for (const { mesh, instanceId } of items) {
        if (!mesh) continue;
        let list = out.get(mesh);
        if (!list) { list = []; out.set(mesh, list); }
        list.push(instanceId);
    }
}

// ─── computeDeltaMatrix ──────────────────────────────────────────────────────

/**
 * 이전 프레임 헬퍼 행렬과 현재 matrixWorld로부터 프레임 간 델타 행렬을 계산합니다.
 */
export function computeDeltaMatrix(
    currentHelperMatrixWorld: THREE.Matrix4,
    previousHelperMatrix: THREE.Matrix4,
    out: THREE.Matrix4
): void {
    _tmpPrevInvMatrix.copy(previousHelperMatrix).invert();
    out.multiplyMatrices(currentHelperMatrixWorld, _tmpPrevInvMatrix);
}

// ─── applyDeltaToInstances ───────────────────────────────────────────────────

/**
 * 델타 행렬을 모든 선택된 인스턴스(InstancedMesh)에 로컬 공간으로 변환하여 적용합니다.
 */
export function applyDeltaToInstances(
    meshToInstanceIds: Map<THREE.Object3D, number[]>,
    deltaMatrix: THREE.Matrix4
): void {
    for (const [mesh, instanceIds] of meshToInstanceIds) {
        _tmpMeshWorldInverse.copy((mesh as THREE.Object3D).matrixWorld).invert();
        _tmpLocalDelta.multiplyMatrices(_tmpMeshWorldInverse, deltaMatrix);
        _tmpLocalDelta.multiply((mesh as THREE.Object3D).matrixWorld);

        for (let i = 0; i < instanceIds.length; i++) {
            const instanceId = instanceIds[i];
            (mesh as THREE.InstancedMesh).getMatrixAt(instanceId, _tmpInstanceMatrix);
            _tmpInstanceMatrix.premultiply(_tmpLocalDelta);
            (mesh as THREE.InstancedMesh).setMatrixAt(instanceId, _tmpInstanceMatrix);
        }

        if ((mesh as THREE.InstancedMesh).isInstancedMesh) {
            (mesh as THREE.InstancedMesh).instanceMatrix.needsUpdate = true;
        }
    }
}

// ─── applyDeltaToGroups ──────────────────────────────────────────────────────

export interface ApplyDeltaToGroupsParams {
    groups: Map<string, GroupData>;
    selectedRootGroupIds: Set<string>;
    deltaMatrix: THREE.Matrix4;
    getAllDescendantGroups: (id: string) => string[];
}

/**
 * 델타 행렬을 모든 선택된 루트 그룹 및 하위 그룹에 적용합니다.
 */
export function applyDeltaToGroups({
    groups,
    selectedRootGroupIds,
    deltaMatrix,
    getAllDescendantGroups
}: ApplyDeltaToGroupsParams): void {
    const toUpdate = new Set<string>();

    for (const rootId of selectedRootGroupIds) {
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

        g.matrix.premultiply(deltaMatrix);
        if (!g.position) g.position = new THREE.Vector3();
        if (!g.quaternion) g.quaternion = new THREE.Quaternion();
        if (!g.scale) g.scale = new THREE.Vector3(1, 1, 1);
        g.matrix.decompose(g.position, g.quaternion, g.scale);
    }
}

// ─── initBlockbenchDragState ─────────────────────────────────────────────────

export interface InitBlockbenchDragParams {
    selectionHelper: THREE.Mesh;
    currentSpace: 'world' | 'local';
    singleGroupId: string | null;
    items: SelectedItem[];
    dragInitialBoundingBox: THREE.Box3;
    getGroupLocalBoundingBox: (id: string) => THREE.Box3;
    getGroupWorldMatrixWithFallback: (id: string, out: THREE.Matrix4) => THREE.Matrix4;
    getInstanceLocalBox: (mesh: PdeMesh, instanceId: number) => THREE.Box3 | null;
    getInstanceWorldMatrix: (mesh: PdeMesh, instanceId: number, out: THREE.Matrix4) => THREE.Matrix4;
    camera: THREE.PerspectiveCamera;
    mouseInput: THREE.Vector2;
    detectedAnchorDirections: { x: boolean | null; y: boolean | null; z: boolean | null };
    updateDetectedAnchorDirections: (x: boolean, y: boolean, z: boolean) => void;
}

export interface InitBlockbenchDragResult {
    dragAnchorDirections: { x: boolean; y: boolean; z: boolean };
}

/**
 * Blockbench 스케일 모드 드래그 시작 시 초기 바운딩 박스 및 앵커 방향을 계산합니다.
 * dragInitialBoundingBox는 in-place로 수정됩니다.
 */
export function initBlockbenchDragState({
    selectionHelper,
    currentSpace,
    singleGroupId,
    items,
    dragInitialBoundingBox,
    getGroupLocalBoundingBox,
    getGroupWorldMatrixWithFallback,
    getInstanceLocalBox,
    getInstanceWorldMatrix,
    camera,
    mouseInput,
    detectedAnchorDirections,
    updateDetectedAnchorDirections
}: InitBlockbenchDragParams): InitBlockbenchDragResult {
    const tmpA = new THREE.Matrix4();
    const tmpB = new THREE.Matrix4();

    dragInitialBoundingBox.makeEmpty();
    selectionHelper.updateMatrixWorld();
    computeBlockbenchPivotFrame(selectionHelper, currentSpace);

    if (singleGroupId) {
        const groupLocalBox = getGroupLocalBoundingBox(singleGroupId);
        if (!groupLocalBox.isEmpty()) {
            const groupWorldMat = getGroupWorldMatrixWithFallback(singleGroupId, tmpA);
            const combinedMat = transformBoxToPivotFrame(groupWorldMat, tmpB);
            unionTransformedBox3(dragInitialBoundingBox, groupLocalBox, combinedMat);
        }
    } else if (items.length > 0) {
        const tempMat = new THREE.Matrix4();
        for (const { mesh, instanceId } of items) {
            const localBox = getInstanceLocalBox(mesh, instanceId);
            if (!localBox) continue;
            getInstanceWorldMatrix(mesh, instanceId, tempMat);
            const combinedMat = transformBoxToPivotFrame(tempMat, tmpA);
            unionTransformedBox3(dragInitialBoundingBox, localBox, combinedMat);
        }
    }

    const newDirections = detectBlockbenchScaleAxes(camera, mouseInput, selectionHelper, currentSpace, detectedAnchorDirections);
    updateDetectedAnchorDirections(newDirections.x, newDirections.y, newDirections.z);

    return { dragAnchorDirections: newDirections };
}
