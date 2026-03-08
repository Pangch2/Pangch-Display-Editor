import * as THREE from 'three/webgpu';
import * as GroupUtils from './group';
import type { GroupData, GroupChild } from './group';

/**
 * Three.js BatchedMesh의 확장 인터페이스 (userData 및 메서드 포함)
 */
interface ExtendedBatchedMesh extends THREE.BatchedMesh {
    isBatchedMesh: boolean;
    userData: { [key: string]: unknown };
    deleteInstance?(instanceId: number): void;
    setVisibleAt?(instanceId: number, visible: boolean): void;
}

// 성능을 위한 임시 변수
const _TMP_MAT4_A = new THREE.Matrix4();

/**
 * BatchedMesh 인스턴스 삭제 및 관련 데이터 정리
 */
function _deleteBatchedMeshInstances(mesh: ExtendedBatchedMesh, instanceIds: number[]): void {
    if (!mesh || !mesh.isBatchedMesh) return;

    for (const instanceId of instanceIds) {
        // 1. 실제 인스턴스 삭제 또는 숨김
        if (typeof mesh.deleteInstance === 'function') {
            mesh.deleteInstance(instanceId);
        } else if (typeof mesh.setVisibleAt === 'function') {
            mesh.setVisibleAt(instanceId, false);
        }

        // 2. UserData 내의 Map/Array 정리
        if (mesh.userData) {
            if (Array.isArray(mesh.userData.instanceGeometryIds)) {
                mesh.userData.instanceGeometryIds[instanceId] = undefined;
            }
            if (mesh.userData.localMatrices instanceof Map) {
                mesh.userData.localMatrices.delete(instanceId);
            }
            if (mesh.userData.displayTypes instanceof Map) {
                mesh.userData.displayTypes.delete(instanceId);
            }
            if (mesh.userData.customPivots instanceof Map) {
                mesh.userData.customPivots.delete(instanceId);
            }
        }
    }
}

/**
 * InstancedMesh에서 swap-pop 발생 시 그룹 내 인스턴스 ID 참조 업데이트
 * group.ts::updateGroupReferenceForMovedInstance 호출 래퍼
 */
function _updateGroupReferenceForMovedInstance(loadedObjectGroup: THREE.Group, mesh: THREE.Mesh, oldInstanceId: number, newInstanceId: number): void {
    GroupUtils.updateGroupReferenceForMovedInstance(loadedObjectGroup, mesh, oldInstanceId, newInstanceId);
}

/**
 * InstancedMesh 인스턴스 삭제 (Swap-Pop 방식)
 */
function _deleteInstancedMeshInstances(loadedObjectGroup: THREE.Group, mesh: THREE.InstancedMesh, instanceIdsSortedDescending: number[]): void {
    if (!mesh || !mesh.isInstancedMesh) return;

    const instanceMatrix = mesh.instanceMatrix;
    const uvAttr = (mesh.geometry && mesh.geometry.attributes) ? (mesh.geometry.attributes.instancedUvOffset as THREE.BufferAttribute) : null;
    const hasHatArray = mesh.userData ? (mesh.userData.hasHat as boolean[]) : null;

    const swapData = (srcIdx: number, dstIdx: number) => {
        // 행렬 복사
        _TMP_MAT4_A.fromArray(instanceMatrix.array as number[], srcIdx * 16);
        _TMP_MAT4_A.toArray(instanceMatrix.array as number[], dstIdx * 16);

        // UV 오프셋 복사
        if (uvAttr) {
            const u = uvAttr.getX(srcIdx);
            const v = uvAttr.getY(srcIdx);
            uvAttr.setXY(dstIdx, u, v);
        }

        // Hat 여부 복사
        if (Array.isArray(hasHatArray)) {
            hasHatArray[dstIdx] = hasHatArray[srcIdx];
        }
    };

    for (const deleteIdx of instanceIdsSortedDescending) {
        const lastIdx = mesh.count - 1;
        
        if (deleteIdx < lastIdx) {
            swapData(lastIdx, deleteIdx);
            // 마지막 인스턴스가 삭제된 위치로 이동했으므로 그룹 참조 갱신
            _updateGroupReferenceForMovedInstance(loadedObjectGroup, mesh, lastIdx, deleteIdx);
        }
        
        mesh.count--;
    }

    mesh.instanceMatrix.needsUpdate = true;
    if (uvAttr) uvAttr.needsUpdate = true;
}

export interface DeleteSelectionCallbacks {
    resetSelectionAndDeselect: () => void;
}

/**
 * 선택된 모든 그룹 및 객체를 씬과 데이터 구조에서 영구 삭제
 */
export function deleteSelectedItems(
    loadedObjectGroup: THREE.Group, 
    currentSelection: { groups: Set<string>; objects: Map<THREE.Mesh, Set<number>> }, 
    { resetSelectionAndDeselect }: DeleteSelectionCallbacks
): void {
    const itemsToDelete = new Map<string, { mesh: THREE.Mesh; instanceId: number }>();

    const collectItem = (mesh: THREE.Mesh, instanceId: number) => {
        if (!mesh) return;
        const k = GroupUtils.getGroupKey(mesh, instanceId);
        if (!itemsToDelete.has(k)) {
            itemsToDelete.set(k, { mesh, instanceId });
        }
    };

    const allGroupsToDelete = new Set<string>();
    if (currentSelection.groups && currentSelection.groups.size > 0) {
        for (const gid of currentSelection.groups) {
            if (gid) {
                allGroupsToDelete.add(gid);
                const descendants = GroupUtils.getAllDescendantGroups(loadedObjectGroup, gid);
                for (const d of descendants) allGroupsToDelete.add(d);
            }
        }
    }

    const groups = GroupUtils.getGroups(loadedObjectGroup) as Map<string, GroupData>;
    const objectToGroup = GroupUtils.getObjectToGroup(loadedObjectGroup) as Map<string, string>;

    for (const gid of allGroupsToDelete) {
        const g = groups.get(gid);
        if (g && Array.isArray(g.children)) {
            for (const child of g.children) {
                if (child.type === 'object') {
                    collectItem(child.mesh, child.instanceId);
                }
            }
        }
    }

    // 2. 개별 선택된 객체 식별
    if (currentSelection.objects && currentSelection.objects.size > 0) {
        for (const [mesh, ids] of currentSelection.objects) {
            if (!mesh || !ids) continue;
            for (const id of ids) {
                collectItem(mesh, id);
            }
        }
    }

    if (itemsToDelete.size === 0 && allGroupsToDelete.size === 0) return;

    // 3. 그룹 구조 정리
    for (const gid of currentSelection.groups) {
         if(!gid) continue;
         const g = groups.get(gid);
         if (g && g.parent) {
             const parent = groups.get(g.parent);
             if (parent && !allGroupsToDelete.has(g.parent)) {
                 if (Array.isArray(parent.children)) {
                     parent.children = parent.children.filter((c: GroupChild) => !(c.type === 'group' && c.id === gid));
                 }
             }
         }
    }

    for (const gid of allGroupsToDelete) {
        groups.delete(gid);
    }

    // 4. 객체 삭제 처리 (메쉬별 그룹화)
    const byMesh = new Map<THREE.Mesh, Set<number>>();

    for (const { mesh, instanceId } of itemsToDelete.values()) {
        const key = GroupUtils.getGroupKey(mesh, instanceId);
        
        if (objectToGroup.has(key)) {
            const parentGroupId = objectToGroup.get(key)!;
            if (groups.has(parentGroupId)) {
                const pg = groups.get(parentGroupId);
                if (pg && Array.isArray(pg.children)) {
                     pg.children = pg.children.filter((c: GroupChild) => !(c.type === 'object' && c.mesh === mesh && c.instanceId === instanceId));
                }
            }
            objectToGroup.delete(key);
        }

        if (!byMesh.has(mesh)) byMesh.set(mesh, new Set());
        byMesh.get(mesh)!.add(instanceId);
    }

    resetSelectionAndDeselect();

    // 5. 실제 메쉬 인스턴스 제거 실행
    // BatchedMesh: 직접 삭제 또는 도시 표본방식(setVisibleAt) 사용
    // InstancedMesh: lastIdx를 삭제 지에 복사하는 Swap-Pop 방식 — 이동된 ID는 _updateGroupReferenceForMovedInstance로 갱신
    for (const [mesh, idSet] of byMesh) {
        if ((mesh as THREE.BatchedMesh).isBatchedMesh) {
            _deleteBatchedMeshInstances(mesh as ExtendedBatchedMesh, Array.from(idSet));
        } else if ((mesh as THREE.InstancedMesh).isInstancedMesh) {
            const sortedIds = Array.from(idSet).sort((a, b) => b - a);
            _deleteInstancedMeshInstances(loadedObjectGroup, mesh as THREE.InstancedMesh, sortedIds);
        }
    }

    console.log('선택된 항목 제거됨 (Real Delete)');
}