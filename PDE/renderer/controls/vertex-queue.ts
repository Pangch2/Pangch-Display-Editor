import * as THREE from 'three/webgpu';
import * as Overlay from './overlay';
import type { SelectionState } from './select';
import type { QueueItem, QueueBundle, QueueEntry } from './vertex-swap';

type PdeMesh = THREE.InstancedMesh | THREE.BatchedMesh | THREE.Mesh;

// ─── Shared temporaries ──────────────────────────────────────────────────────

const _TMP_MAT4_A = new THREE.Matrix4();
const _TMP_MAT4_B = new THREE.Matrix4();
const _TMP_VEC3_A = new THREE.Vector3();
const _TMP_VEC3_B = new THREE.Vector3();

// ─── Constants ───────────────────────────────────────────────────────────────

export const VERTEX_QUEUE_MAX_SIZE = 1;

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

// ─── Local helper: world AABB for a group ─────────────────────────────────────

function getGroupWorldAABB(groupId: string): THREE.Box3 | null {
    const localBox = Overlay.getGroupLocalBoundingBox(groupId);
    if (!localBox || localBox.isEmpty()) return null;
    const worldMat = Overlay.getGroupWorldMatrixWithFallback(groupId, new THREE.Matrix4());
    const worldBox = new THREE.Box3();
    const corners = [
        new THREE.Vector3(localBox.min.x, localBox.min.y, localBox.min.z),
        new THREE.Vector3(localBox.max.x, localBox.min.y, localBox.min.z),
        new THREE.Vector3(localBox.min.x, localBox.max.y, localBox.min.z),
        new THREE.Vector3(localBox.max.x, localBox.max.y, localBox.min.z),
        new THREE.Vector3(localBox.min.x, localBox.min.y, localBox.max.z),
        new THREE.Vector3(localBox.max.x, localBox.min.y, localBox.max.z),
        new THREE.Vector3(localBox.min.x, localBox.max.y, localBox.max.z),
        new THREE.Vector3(localBox.max.x, localBox.max.y, localBox.max.z),
    ];
    for (const corner of corners) {
        worldBox.expandByPoint(corner.applyMatrix4(worldMat));
    }
    return worldBox;
}

// ─── pushToVertexQueue ────────────────────────────────────────────────────────

export interface PushVertexQueueParams {
    suppressVertexQueue: boolean;
    isVertexMode: boolean;
    selectionAnchorMode: 'default' | 'center';
    isCustomPivot: boolean;
    pivotOffset: THREE.Vector3;
    multiSelectionExplicitPivot: boolean;
    multiSelectionOriginAnchorValid: boolean;
    multiSelectionOriginAnchorPosition: THREE.Vector3;
    currentSelection: SelectionState;
    selectedVertexKeys: Set<string>;
    vertexQueue: QueueItem[];
    selectionHelper: THREE.Mesh | null;
    getSelectionCenterWorld(out?: THREE.Vector3): THREE.Vector3;
    getSelectionOriginWorld(out?: THREE.Vector3): THREE.Vector3;
}

export function pushToVertexQueue(params: PushVertexQueueParams): void {
    const {
        suppressVertexQueue, isVertexMode, selectionAnchorMode, isCustomPivot, pivotOffset,
        multiSelectionOriginAnchorValid, multiSelectionOriginAnchorPosition,
        currentSelection, selectedVertexKeys, vertexQueue, selectionHelper, getSelectionCenterWorld,
        getSelectionOriginWorld
    } = params;

    if (suppressVertexQueue || !isVertexMode) return;

    let currentGizmoPos: THREE.Vector3 | null = null;
    let currentGizmoQuat: THREE.Quaternion | null = null;
    if (currentSelection.groups.size > 0 || currentSelection.objects.size > 0) {
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

    const tempMat = _TMP_MAT4_A;
    const tempInv = _TMP_MAT4_B;

    const bundleItems: QueueEntry[] = [];
    let isBundleCenterAlreadySelected = false; // Multi-selection center selection fix

    for (const item of itemsToAdd) {
        let localPos: THREE.Vector3 | null = null;
        let localQuat: THREE.Quaternion | null = null;

        if (currentGizmoPos) {
            if (item.type === 'group') {
                Overlay.getGroupWorldMatrixWithFallback(item.id!, tempMat);
            } else {
                Overlay.getInstanceWorldMatrix(item.mesh, item.instanceId, tempMat);
            }

            tempInv.copy(tempMat).invert();
            localPos = currentGizmoPos.clone().applyMatrix4(tempInv);

            if (currentGizmoQuat) {
                const objQuat = Overlay.getRotationFromMatrix(tempMat);
                localQuat = objQuat.invert().multiply(currentGizmoQuat);
            }
        }

        bundleItems.push({
            ...item,
            gizmoLocalPosition: localPos,
            gizmoLocalQuaternion: localQuat,
            promoteOnExit: false,
            selectionAnchorMode
        } as QueueEntry);

        const currentPrimary = currentSelection.primary;
        if (currentPrimary) {
            const isPrimary =
                (item.type === 'group' && currentPrimary.type === 'group' && currentPrimary.id === item.id) ||
                (item.type === 'object' && currentPrimary.type === 'object' && currentPrimary.mesh === item.mesh && currentPrimary.instanceId === item.instanceId);
            if (isPrimary) {
                bundleItems[bundleItems.length - 1].isPrimary = true;
            }
        }

        if (isCenterSelected && localPos && !isBundleCenterAlreadySelected) {
            const idStr = item.type === 'group'
                ? `G_${item.id}`
                : `O_${item.mesh!.uuid}_${item.instanceId}`;
            const qKey = `QUEUE_${idStr}_${localPos.x.toFixed(4)}_${localPos.y.toFixed(4)}_${localPos.z.toFixed(4)}`;
            selectedVertexKeys.add(qKey);
            isBundleCenterAlreadySelected = true; // Only add the first one so selectedVertexKeys.size remains 1
        }
    }

    if (bundleItems.length > 0) {
        let effectiveIsCustomPivot = isCustomPivot;
        const effectivePivotOffset = pivotOffset.clone();

        // Multi explicit pivot is tracked by anchor state, not always by isCustomPivot/pivotOffset.
        // Also, if isCustomPivot is already true from a single object, the pivotOffset might be stale
        // relative to the multi-selection originBase. Therefore, ALWAYS derive for multi-selection.
        if (multiSelectionOriginAnchorValid && bundleItems.length > 1) {
            const originBase = getSelectionOriginWorld(_TMP_VEC3_A);
            effectivePivotOffset.copy(multiSelectionOriginAnchorPosition).sub(originBase);
            effectiveIsCustomPivot = true;
        }

        vertexQueue.push({
            type: 'bundle',
            items: bundleItems,
            promoteOnExit: false,
            selectionAnchorMode,
            isCustomPivot: effectiveIsCustomPivot,
            pivotOffset: effectivePivotOffset
        } as QueueBundle);
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
            const tempSize = _TMP_VEC3_A;
            const tempCenter = _TMP_VEC3_B;

            if (sub.type === 'group') {
                const groupId = sub.id as string;
                const worldBox = getGroupWorldAABB(groupId);
                if (worldBox && !worldBox.isEmpty()) {
                    worldBox.getSize(tempSize);
                    worldBox.getCenter(tempCenter);
                    matrix = _TMP_MAT4_B;
                    matrix.makeTranslation(tempCenter.x, tempCenter.y, tempCenter.z);
                    matrix.scale(tempSize);
                }
            } else if (sub.type === 'object') {
                const { mesh, instanceId } = sub;
                if (Overlay.isInstanceValid(mesh, instanceId)) {
                    const localBox = Overlay.getInstanceLocalBox(mesh, instanceId);
                    if (localBox) {
                        localBox.getSize(tempSize);
                        localBox.getCenter(tempCenter);

                        const worldMat = Overlay.getInstanceWorldMatrix(mesh, instanceId, _TMP_MAT4_A);
                        matrix = _TMP_MAT4_B;
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

// ─── promoteVertexQueueBundleOnExit ──────────────────────────────────────────

export interface PromoteVertexQueueParams {
    vertexQueue: QueueItem[];
    replaceSelectionWithGroupsAndObjects(
        groupIds: Set<string>,
        meshToIds: Map<PdeMesh, Set<number>>,
        options?: {
            anchorMode?: string;
            preserveAnchors?: boolean;
            primaryIsRangeStart?: boolean;
            explicitPrimary?: SelectionState['primary'] | null;
        }
    ): void;
}

export function promoteVertexQueueBundleOnExit(params: PromoteVertexQueueParams): boolean {
    const { vertexQueue, replaceSelectionWithGroupsAndObjects } = params;

    if (!Array.isArray(vertexQueue) || vertexQueue.length === 0) return false;

    const queuedItem = vertexQueue.find((item) => item != null && item.promoteOnExit === true);
    if (!queuedItem) return false;

    const queuedItems: QueueEntry[] = queuedItem.type === 'bundle'
        ? (((queuedItem as QueueBundle).items || []).filter(Boolean) as QueueEntry[])
        : [queuedItem as QueueEntry];

    if (queuedItems.length === 0) return false;

    const groupIds = new Set<string>();
    const meshToIds = new Map<PdeMesh, Set<number>>();

    for (const sub of queuedItems) {
        if (!sub) continue;
        if (sub.type === 'group' && sub.id) {
            groupIds.add(sub.id);
            continue;
        }
        if (sub.type === 'object' && sub.mesh && Number.isInteger(sub.instanceId) && Overlay.isInstanceValid(sub.mesh, sub.instanceId!)) {
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
    if (total === 0) return false;

    let explicitPrimary: SelectionState['primary'] | null = null;
    const primarySub = queuedItems.find((sub) => sub.isPrimary === true);
    if (primarySub) {
        if (primarySub.type === 'group' && primarySub.id && groupIds.has(primarySub.id)) {
            explicitPrimary = { type: 'group', id: primarySub.id };
        } else if (
            primarySub.type === 'object' &&
            primarySub.mesh &&
            Number.isInteger(primarySub.instanceId) &&
            !!meshToIds.get(primarySub.mesh)?.has(primarySub.instanceId!)
        ) {
            explicitPrimary = { type: 'object', mesh: primarySub.mesh, instanceId: primarySub.instanceId! };
        }
    }

    replaceSelectionWithGroupsAndObjects(groupIds, meshToIds, {
        anchorMode: 'default',
        preserveAnchors: true,
        primaryIsRangeStart: !explicitPrimary,
        explicitPrimary
    });
    return true;
}
