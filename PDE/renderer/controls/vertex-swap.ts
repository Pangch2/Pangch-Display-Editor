import * as THREE from 'three/webgpu';
import * as Overlay from './overlay';
import { GroupData } from './group';

const _TMP_MAT4_A = new THREE.Matrix4();
const _ZERO_VEC3 = new THREE.Vector3(0, 0, 0);

export type SelectionSource = 
    | { type: 'group'; id: string }
    | { type: 'object'; mesh: THREE.InstancedMesh | THREE.BatchedMesh | THREE.Mesh; instanceId: number };

export interface QueueEntry {
    type: 'group' | 'object';
    id?: string;
    mesh?: THREE.InstancedMesh | THREE.BatchedMesh | THREE.Mesh;
    instanceId?: number;
    gizmoLocalPosition: THREE.Vector3;
    gizmoLocalQuaternion: THREE.Quaternion;
}

export interface QueueBundle {
    type: 'bundle';
    items: QueueEntry[];
}

export type QueueItem = QueueEntry | QueueBundle;

export interface SwapContext {
    currentSelection: {
        groups: Set<string>;
        objects: Map<THREE.Object3D, Set<number>>;
        primary: SelectionSource | null;
    };
    getGroups: () => Map<string, GroupData>;
    getGroupWorldMatrixWithFallback: (id: string, target: THREE.Matrix4) => THREE.Matrix4;
    setGizmoState: (state: any) => void;
    getGizmoState: () => any;
    updateHelperPosition: () => void;
    SelectionCenter: (mode: string, useOffset: boolean, target: THREE.Vector3) => THREE.Vector3;
    vertexQueue: QueueItem[];
}

export interface SwapOptions {
    preserveSelection?: boolean;
}

export function performSelectionSwap(
    src: SelectionSource | null,
    targetSrc: SelectionSource | null,
    context: SwapContext,
    options: SwapOptions = {}
): void {
    const {
        currentSelection,
        getGroups,
        getGroupWorldMatrixWithFallback,
        setGizmoState,
        getGizmoState,
        updateHelperPosition,
        SelectionCenter,
        vertexQueue
    } = context;

    if (!targetSrc) return;

    const matchesSource = (a: any, b: SelectionSource): boolean => {
        if (!a || !b || a.type !== b.type) return false;
        if (a.type === 'group') return a.id === (b as any).id;
        return a.mesh === (b as any).mesh && a.instanceId === (b as any).instanceId;
    };

    const toSelectionSource = (source: SelectionSource | null): SelectionSource | null => {
        if (!source) return null;
        if (source.type === 'group') return { type: 'group', id: source.id };
        return { type: 'object', mesh: source.mesh, instanceId: source.instanceId };
    };

    const isSelectedSource = (source: SelectionSource | null): boolean => {
        if (!source) return false;
        if (source.type === 'group') return currentSelection.groups.has(source.id);
        const ids = currentSelection.objects.get(source.mesh);
        return !!(ids && ids.has(source.instanceId));
    };

    const findQueueLocation = (source: SelectionSource | null): { kind: 'direct' | 'bundle'; itemIndex: number; subIndex?: number } | null => {
        if (!source || !Array.isArray(vertexQueue)) return null;
        for (let i = 0; i < vertexQueue.length; i++) {
            const qItem = vertexQueue[i];
            if (!qItem) continue;
            if ('items' in qItem && Array.isArray(qItem.items)) {
                for (let j = 0; j < qItem.items.length; j++) {
                    if (matchesSource(qItem.items[j], source)) {
                        return { kind: 'bundle', itemIndex: i, subIndex: j };
                    }
                }
                continue;
            }
            if (matchesSource(qItem, source)) {
                return { kind: 'direct', itemIndex: i };
            }
        }
        return null;
    };

    const state = getGizmoState();

    const computeAndApplyPivotState = (source: SelectionSource): void => {
        let pivotWorld: THREE.Vector3 | null = null;

        if (source.type === 'object') {
            const { mesh, instanceId } = source;

            const getWorldPivot = (id: number): THREE.Vector3 | null => {
                let local: THREE.Vector3 | null = null;
                if (mesh.userData.customPivots) {
                    local = mesh.userData.customPivots.get(id);
                    if (!local) {
                        const k = String(id);
                        local = mesh.userData.customPivots.get(k);
                    }
                }
                if (local) {
                    const m = _TMP_MAT4_A;
                    if ((mesh as any).isBatchedMesh || (mesh as any).isInstancedMesh) {
                        (mesh as any).getMatrixAt(id, m);
                    } else {
                        m.copy(mesh.matrix);
                    }
                    m.premultiply(mesh.matrixWorld);
                    return local.clone().applyMatrix4(m);
                }
                return null;
            };

            if ((mesh as any).isBatchedMesh || (mesh as any).isInstancedMesh) {
                pivotWorld = getWorldPivot(instanceId);
            } else if (mesh.userData.customPivot) {
                pivotWorld = mesh.userData.customPivot.clone().applyMatrix4(mesh.matrixWorld);
            }
        } else if (source.type === 'group') {
            const groups = getGroups();
            const group = groups.get(source.id);
            if (group && group.isCustomPivot && group.pivot) {
                const gMat = getGroupWorldMatrixWithFallback(source.id, _TMP_MAT4_A);
                pivotWorld = group.pivot.clone().applyMatrix4(gMat);
            }
        }

        if (pivotWorld) {
            const origin = SelectionCenter('origin', false, _ZERO_VEC3);
            const offset = new THREE.Vector3().subVectors(pivotWorld, origin);
            setGizmoState({ ...state, isCustomPivot: true, pivotOffset: offset });
        } else {
            setGizmoState({ ...state, isCustomPivot: false, pivotOffset: new THREE.Vector3(0, 0, 0) });
        }
    };

    const createQueueEntry = (source: SelectionSource): QueueEntry => {
        const targetLocalPivot = new THREE.Vector3(0, 0, 0);
        let hasCustomPivot = false;

        if (state.pivotMode !== 'center') {
            if (source.type === 'object') {
                const { mesh, instanceId } = source;
                if ((mesh as any).isBatchedMesh || (mesh as any).isInstancedMesh) {
                    let pivot: THREE.Vector3 | null = null;
                    if (mesh.userData.customPivots) {
                        pivot = mesh.userData.customPivots.get(instanceId);
                        if (!pivot) {
                            const key = String(instanceId);
                            pivot = mesh.userData.customPivots.get(key);
                        }
                    }
                    if (pivot) {
                        targetLocalPivot.copy(pivot);
                        hasCustomPivot = true;
                    }
                } else if (mesh.userData.customPivot) {
                    targetLocalPivot.copy(mesh.userData.customPivot);
                    hasCustomPivot = true;
                }

                if (!hasCustomPivot) {
                    const displayType = Overlay.getDisplayType(mesh, instanceId);
                    if (displayType === 'block_display') {
                        Overlay.getInstanceLocalBoxMin(mesh, instanceId, targetLocalPivot);
                    }
                }
            } else if (source.type === 'group') {
                const groups = getGroups();
                const group = groups.get(source.id);
                if (group && group.isCustomPivot && group.pivot) {
                    targetLocalPivot.copy(group.pivot);
                    hasCustomPivot = true;
                }

                if (!hasCustomPivot) {
                    const box = Overlay.getGroupLocalBoundingBox(source.id);
                    if (box && !box.isEmpty()) {
                        targetLocalPivot.copy(box.min);
                    }
                }
            }
        }

        if (state.pivotMode === 'center') {
            let localBox: THREE.Box3 | null = null;
            if (source.type === 'object') {
                localBox = Overlay.getInstanceLocalBox(source.mesh, source.instanceId);
            } else if (source.type === 'group') {
                localBox = Overlay.getGroupLocalBoundingBox(source.id);
            }
            if (localBox && !localBox.isEmpty()) {
                localBox.getCenter(targetLocalPivot);
            }
        }

        return {
            type: source.type,
            id: source.type === 'group' ? source.id : undefined,
            mesh: source.type === 'object' ? source.mesh : undefined,
            instanceId: source.type === 'object' ? source.instanceId : undefined,
            gizmoLocalPosition: targetLocalPivot,
            gizmoLocalQuaternion: new THREE.Quaternion()
        };
    };

    const groupCount = currentSelection.groups ? currentSelection.groups.size : 0;
    let objectIdCount = 0;
    if (currentSelection.objects && currentSelection.objects.size > 0) {
        for (const ids of currentSelection.objects.values()) {
            objectIdCount += ids.size;
        }
    }
    const activeSelectionCount = groupCount + objectIdCount;
    const hasActiveSelection = activeSelectionCount > 0;
    
    const isSwap = !!options.preserveSelection;
    const shouldReplaceWithSrc = !!src && (!isSwap || !hasActiveSelection);

    if (isSwap && src) {
        const srcSelected = isSelectedSource(src);
        const targetInQueue = findQueueLocation(targetSrc);
        const srcInQueue = findQueueLocation(src);
        const targetSelected = isSelectedSource(targetSrc);

        const executeFullSwap = (queuedLocation: { kind: 'direct' | 'bundle'; itemIndex: number; subIndex?: number }, newPrimarySrc: SelectionSource) => {
            const qItem = vertexQueue[queuedLocation.itemIndex];
            const itemsToSelect: SelectionSource[] = [];
            
            if ('items' in qItem && Array.isArray(qItem.items)) {
                itemsToSelect.push(...qItem.items.map(item => ({
                    type: item.type,
                    id: item.id,
                    mesh: item.mesh,
                    instanceId: item.instanceId
                } as SelectionSource)));
            } else {
                itemsToSelect.push({
                    type: qItem.type,
                    id: (qItem as QueueEntry).id,
                    mesh: (qItem as QueueEntry).mesh,
                    instanceId: (qItem as QueueEntry).instanceId
                } as SelectionSource);
            }

            const itemsToQueue: SelectionSource[] = [];
            if (currentSelection.groups) {
                for (const gid of currentSelection.groups) itemsToQueue.push({ type: 'group', id: gid });
            }
            if (currentSelection.objects) {
                for (const [mesh, ids] of currentSelection.objects) {
                    for (const id of ids) itemsToQueue.push({ type: 'object', mesh: mesh as any, instanceId: id });
                }
            }

            currentSelection.groups.clear();
            currentSelection.objects.clear();
            currentSelection.primary = null;

            for (const item of itemsToSelect) {
                if (item.type === 'group') {
                    currentSelection.groups.add(item.id);
                } else {
                    let set = currentSelection.objects.get(item.mesh);
                    if (!set) {
                        set = new Set();
                        currentSelection.objects.set(item.mesh, set);
                    }
                    set.add(item.instanceId);
                }
            }
            currentSelection.primary = toSelectionSource(newPrimarySrc);

            let newQueueItem: QueueItem | null = null;
            if (itemsToQueue.length === 1) {
                newQueueItem = createQueueEntry(itemsToQueue[0]);
            } else if (itemsToQueue.length > 1) {
                const bundleItems = itemsToQueue.map(item => createQueueEntry(item));
                newQueueItem = { type: 'bundle', items: bundleItems };
            }

            if (newQueueItem) {
                vertexQueue[queuedLocation.itemIndex] = newQueueItem;
            }

            computeAndApplyPivotState(newPrimarySrc);
            updateHelperPosition();
        };

        if (srcSelected && targetInQueue) {
            executeFullSwap(targetInQueue, targetSrc);
            return;
        }

        if (targetSelected && srcInQueue) {
            executeFullSwap(srcInQueue, src);
            return;
        }
    }

    if (shouldReplaceWithSrc && src) {
         currentSelection.groups.clear();
         currentSelection.objects.clear();
         currentSelection.primary = null;

         if (src.type === 'group') {
             currentSelection.groups.add(src.id);
             currentSelection.primary = { type: 'group', id: src.id };
         } else {
             const { mesh, instanceId } = src;
             const ids = new Set<number>();
             ids.add(instanceId);

             currentSelection.objects.set(mesh, ids);
             currentSelection.primary = { type: 'object', mesh, instanceId };
         }

         computeAndApplyPivotState(src);
         updateHelperPosition();
    }

    let isTargetSelected = false;
    if (targetSrc.type === 'group') {
        if (currentSelection.groups.has(targetSrc.id)) isTargetSelected = true;
    } else if (targetSrc.type === 'object') {
        const ids = currentSelection.objects.get(targetSrc.mesh);
        if (ids && ids.has(targetSrc.instanceId)) isTargetSelected = true;
    }
    
    if (isTargetSelected) {
         if (isSwap) return;
         while (vertexQueue.length > 0) vertexQueue.shift();
         return;
    }

    if (isSwap && Array.isArray(vertexQueue) && vertexQueue.length > 0) {
        const targetInBundle = vertexQueue.some((item) => {
            if (!item || !('items' in item) || !Array.isArray(item.items)) return false;
            return item.items.some((sub) => matchesSource(sub, targetSrc));
        });

        if (targetInBundle) return;
    }

    vertexQueue.push(createQueueEntry(targetSrc));
    while (vertexQueue.length > 1) vertexQueue.shift();
}
