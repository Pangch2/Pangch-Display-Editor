import * as THREE from 'three/webgpu';
import type { SelectionState } from '../selection/select';
import type { QueueItem, QueueBundle, QueueEntry } from './vertex-swap';

// ─── Types ──────────────────────────────────────────────────────────────────

type PdeMesh = THREE.InstancedMesh | THREE.BatchedMesh | THREE.Mesh;

// ─── State ──────────────────────────────────────────────────────────────────

export const selectedVertexKeys = new Set<string>();
export const vertexQueue: QueueItem[] = [];
let suppressVertexQueue = false;

const VERTEX_QUEUE_MAX_SIZE = 1;

const _unitCubeCorners: THREE.Vector3[] = [
    new THREE.Vector3(-0.5, -0.5, -0.5),
    new THREE.Vector3( 0.5, -0.5, -0.5),
    new THREE.Vector3( 0.5,  0.5, -0.5),
    new THREE.Vector3(-0.5,  0.5, -0.5),
    new THREE.Vector3(-0.5, -0.5,  0.5),
    new THREE.Vector3( 0.5, -0.5,  0.5),
    new THREE.Vector3( 0.5,  0.5,  0.5),
    new THREE.Vector3(-0.5,  0.5,  0.5)
];

// ─── Accessors ──────────────────────────────────────────────────────────────

export function getSuppressVertexQueue(): boolean {
    return suppressVertexQueue;
}

export function setSuppressVertexQueue(value: boolean): void {
    suppressVertexQueue = value;
}

export function clearVertexState(): void {
    vertexQueue.length = 0;
    selectedVertexKeys.clear();
}

// ─── Logic ───────────────────────────────────────────────────────────────────

export function pushToVertexQueue(params: {
    isVertexMode: boolean;
    currentSelection: SelectionState;
    selectionHelper: THREE.Mesh | null;
    getSelectionCenterWorld: (out: THREE.Vector3) => THREE.Vector3;
    getGroupWorldMatrixWithFallback: (groupId: string, out: THREE.Matrix4) => THREE.Matrix4;
    getInstanceWorldMatrix: (mesh: PdeMesh, instanceId: number, out: THREE.Matrix4) => THREE.Matrix4;
    getRotationFromMatrix: (m: THREE.Matrix4) => THREE.Quaternion;
    getGroupWorldAABB: (groupId: string) => THREE.Box3 | null;
    isInstanceValid: (mesh: PdeMesh, instanceId: number) => boolean;
    getInstanceLocalBox: (mesh: PdeMesh, instanceId: number) => THREE.Box3 | null;
}): void {
    const {
        isVertexMode,
        currentSelection,
        selectionHelper,
        getSelectionCenterWorld,
        getGroupWorldMatrixWithFallback,
        getInstanceWorldMatrix,
        getRotationFromMatrix,
        getGroupWorldAABB,
        isInstanceValid,
        getInstanceLocalBox
    } = params;

    if (suppressVertexQueue || !isVertexMode) return;

    let currentGizmoPos: THREE.Vector3 | null = null;
    let currentGizmoQuat: THREE.Quaternion | null = null;
    if ((currentSelection.groups.size > 0 || currentSelection.objects.size > 0)) {
        currentGizmoPos = new THREE.Vector3();
        currentGizmoQuat = new THREE.Quaternion();
        if (selectionHelper) {
            currentGizmoPos.copy(selectionHelper.position);
            currentGizmoQuat.copy(selectionHelper.quaternion);
        } else {
            getSelectionCenterWorld(currentGizmoPos);
            currentGizmoQuat.identity();
        }
    }

    const centerKey = currentGizmoPos
        ? `CENTER_${currentGizmoPos.x.toFixed(4)}_${currentGizmoPos.y.toFixed(4)}_${currentGizmoPos.z.toFixed(4)}`
        : null;
    const isCenterSelected = centerKey ? selectedVertexKeys.has(centerKey) : false;

    if (isCenterSelected && centerKey) {
        selectedVertexKeys.delete(centerKey);
    }

    const itemsToAdd: Array<{ type: 'group' | 'object'; id?: string; mesh?: PdeMesh; instanceId?: number }> = [];
    if (currentSelection.groups.size > 0) {
        for (const gid of currentSelection.groups) {
            itemsToAdd.push({ type: 'group', id: gid });
        }
    }
    if (currentSelection.objects.size > 0) {
        for (const [mesh, ids] of currentSelection.objects) {
            for (const id of ids) {
                itemsToAdd.push({ type: 'object', mesh, instanceId: id });
            }
        }
    }

    const tempMat = new THREE.Matrix4();
    const tempInv = new THREE.Matrix4();

    const bundleItems: QueueEntry[] = [];
    for (const item of itemsToAdd) {
        let localPos: THREE.Vector3 | null = null;
        let localQuat: THREE.Quaternion | null = null;

        if (currentGizmoPos) {
            if (item.type === 'group') {
                getGroupWorldMatrixWithFallback(item.id!, tempMat);
            } else {
                getInstanceWorldMatrix(item.mesh!, item.instanceId!, tempMat);
            }

            tempInv.copy(tempMat).invert();
            localPos = currentGizmoPos.clone().applyMatrix4(tempInv);

            if (currentGizmoQuat) {
                const objQuat = getRotationFromMatrix(tempMat);
                localQuat = objQuat.invert().multiply(currentGizmoQuat);
            }
        }

        bundleItems.push({ ...item, gizmoLocalPosition: localPos, gizmoLocalQuaternion: localQuat });

        if (isCenterSelected && localPos) {
            const idStr = item.type === 'group'
                ? `G_${item.id}`
                : `O_${item.mesh!.uuid}_${item.instanceId}`;
            const qKey = `QUEUE_${idStr}_${localPos.x.toFixed(4)}_${localPos.y.toFixed(4)}_${localPos.z.toFixed(4)}`;
            selectedVertexKeys.add(qKey);
        }
    }

    if (bundleItems.length > 0) {
        vertexQueue.push({ type: 'bundle', items: bundleItems } as QueueBundle);
    }

    while (vertexQueue.length > VERTEX_QUEUE_MAX_SIZE) {
        const removedItem = vertexQueue.shift()!;

        const removeKeysForSubItem = (sub: QueueEntry) => {
            const idStr = sub.type === 'group'
                ? `G_${sub.id}`
                : `O_${sub.mesh!.uuid}_${sub.instanceId}`;
            const prefix = `QUEUE_${idStr}_`;

            for (const key of selectedVertexKeys) {
                if (key.startsWith(prefix)) {
                    selectedVertexKeys.delete(key);
                }
            }

            let matrix: THREE.Matrix4 | null = null;
            const tempSize = new THREE.Vector3();
            const tempCenter = new THREE.Vector3();

            if (sub.type === 'group') {
                const groupId = sub.id as string;
                const worldBox = getGroupWorldAABB(groupId);
                if (worldBox && !worldBox.isEmpty()) {
                    worldBox.getSize(tempSize);
                    worldBox.getCenter(tempCenter);
                    matrix = new THREE.Matrix4();
                    matrix.makeTranslation(tempCenter.x, tempCenter.y, tempCenter.z);
                    matrix.scale(tempSize);
                }
            } else if (sub.type === 'object') {
                const { mesh, instanceId } = sub;
                if (mesh && instanceId !== undefined && isInstanceValid(mesh, instanceId)) {
                    const localBox = getInstanceLocalBox(mesh, instanceId);
                    if (localBox) {
                        localBox.getSize(tempSize);
                        localBox.getCenter(tempCenter);

                        const worldMat = getInstanceWorldMatrix(mesh, instanceId, new THREE.Matrix4());
                        matrix = new THREE.Matrix4();
                        matrix.makeTranslation(tempCenter.x, tempCenter.y, tempCenter.z);
                        matrix.scale(tempSize);
                        matrix.premultiply(worldMat);
                    }
                }
            }

            if (matrix) {
                const v = new THREE.Vector3();
                for (const corner of _unitCubeCorners) {
                    v.copy(corner).applyMatrix4(matrix);
                    const key = `${v.x.toFixed(4)}_${v.y.toFixed(4)}_${v.z.toFixed(4)}`;
                    if (selectedVertexKeys.has(key)) {
                        selectedVertexKeys.delete(key);
                    }
                }
            }
        };

        if ((removedItem as QueueBundle).type === 'bundle') {
            (removedItem as QueueBundle).items.forEach(removeKeysForSubItem);
        } else {
            removeKeysForSubItem(removedItem as QueueEntry);
        }
    }
}

export function promoteVertexQueueBundleOnExit(params: {
    isInstanceValid: (mesh: PdeMesh, instanceId: number) => boolean;
    replaceSelectionWithGroupsAndObjects: (groupIds: Set<string>, meshToIds: Map<PdeMesh, Set<number>>, options?: { anchorMode?: string; preserveAnchors?: boolean }) => void;
}): boolean {
    const { isInstanceValid, replaceSelectionWithGroupsAndObjects } = params;

    if (!Array.isArray(vertexQueue) || vertexQueue.length === 0) return false;

    const bundle = vertexQueue.find((item): item is QueueBundle =>
        item != null && item.type === 'bundle' && Array.isArray((item as QueueBundle).items)
    );
    if (!bundle || !bundle.items || bundle.items.length === 0) return false;

    const groupIds = new Set<string>();
    const meshToIds = new Map<PdeMesh, Set<number>>();

    for (const sub of bundle.items) {
        if (!sub) continue;
        if (sub.type === 'group' && sub.id) {
            groupIds.add(sub.id);
            continue;
        }
        if (sub.type === 'object' && sub.mesh && Number.isInteger(sub.instanceId) && isInstanceValid(sub.mesh, sub.instanceId!)) {
            let ids = meshToIds.get(sub.mesh);
            if (!ids) {
                ids = new Set();
                meshToIds.set(sub.mesh, ids);
            }
            ids.add(sub.instanceId!);
        }
    }

    let total = groupIds.size;
    for (const ids of meshToIds.values()) total += ids.size;
    if (total <= 1) return false;

    replaceSelectionWithGroupsAndObjects(groupIds, meshToIds, { anchorMode: 'default', preserveAnchors: true });
    return true;
}
