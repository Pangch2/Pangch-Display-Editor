import {
    Matrix4,
    Vector3,
    InstancedMesh,
    BatchedMesh,
    Mesh,
    Quaternion,
    Object3D,
    Box3
} from 'three/webgpu';
import * as Overlay from './overlay';
import { GroupData } from './group';
import type { GizmoState } from './gizmo';

const _TMP_MAT4_A = new Matrix4();
const _ZERO_VEC3 = new Vector3(0, 0, 0);

export type SelectionSource = 
    | { type: 'group'; id: string }
    | { type: 'object'; mesh: InstancedMesh | BatchedMesh | Mesh; instanceId: number };

export interface QueueEntry {
    type: 'group' | 'object';
    id?: string;
    mesh?: InstancedMesh | BatchedMesh | Mesh;
    instanceId?: number;
    gizmoLocalPosition: Vector3;
    gizmoLocalQuaternion: Quaternion;
    promoteOnExit?: boolean;
    isPrimary?: boolean;
    selectionAnchorMode?: 'default' | 'center';
}

export interface QueueBundle {
    type: 'bundle';
    items: QueueEntry[];
    promoteOnExit?: boolean;
    selectionAnchorMode?: 'default' | 'center';
    isCustomPivot?: boolean;
    pivotOffset?: Vector3;
}

export type QueueItem = QueueEntry | QueueBundle;

export interface SwapContext {
    currentSelection: {
        groups: Set<string>;
        objects: Map<Object3D, Set<number>>;
        primary: SelectionSource | null;
    };
    getGroups: () => Map<string, GroupData>;
    getGroupWorldMatrixWithFallback: (id: string, target: Matrix4) => Matrix4;
    setGizmoState: (state: Partial<GizmoState>) => void;
    getGizmoState: () => GizmoState;
    setMultiAnchorInitial?: (worldPos: Vector3) => void;
    updateHelperPosition: () => void;
    SelectionCenter: (mode: string, useOffset: boolean, target: Vector3) => Vector3;
    vertexQueue: QueueItem[];
}

export interface SwapOptions {
    preserveSelection?: boolean;
    targetAnchorWorld?: Vector3;
}

interface PivotSnapshot {
    isCustomPivot: boolean;
    pivotOffset: Vector3;
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
        setMultiAnchorInitial,
        updateHelperPosition,
        SelectionCenter,
        vertexQueue
    } = context;

    const initialGizmoState = getGizmoState();
    const initialAnchorMode = initialGizmoState.selectionAnchorMode;

    if (!targetSrc) return;

    const matchesSource = (a: QueueEntry | SelectionSource | null | undefined, b: SelectionSource): boolean => {
        if (!a || !b || a.type !== b.type) return false;
        if (a.type === 'group') return (a as { type: 'group'; id?: string }).id === (b.type === 'group' ? b.id : undefined);
        return a.type === 'object' && b.type === 'object'
            && (a as { type: 'object'; mesh?: InstancedMesh | BatchedMesh | Mesh }).mesh === b.mesh
            && (a as { type: 'object'; instanceId?: number }).instanceId === b.instanceId;
    };

    const toSelectionSource = (source: SelectionSource | null): SelectionSource | null => {
        if (!source) return null;
        if (source.type === 'group') return { type: 'group', id: source.id };
        return { type: 'object', mesh: source.mesh, instanceId: source.instanceId };
    };

    const toSelectionSourceFromEntry = (entry: QueueEntry): SelectionSource => {
        if (entry.type === 'group') {
            return { type: 'group', id: entry.id! };
        }
        return { type: 'object', mesh: entry.mesh!, instanceId: entry.instanceId! };
    };

    const getCurrentPrimary = (): SelectionSource | null => {
        return toSelectionSource(currentSelection.primary as SelectionSource | null);
    };

    const listIncludesSource = (list: SelectionSource[], source: SelectionSource | null): boolean => {
        if (!source) return false;
        return list.some((item) => matchesSource(item, source));
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
            if (matchesSource(qItem as QueueEntry, source)) {
                return { kind: 'direct', itemIndex: i };
            }
        }
        return null;
    };

    const computeAndApplyPivotState = (source: SelectionSource): void => {
        let pivotWorld: Vector3 | null = null;

        if (source.type === 'object') {
            const { mesh, instanceId } = source;

            const getWorldPivot = (id: number): Vector3 | null => {
                let local: Vector3 | null = null;
                if (mesh.userData.customPivots) {
                    local = mesh.userData.customPivots.get(id);
                    if (!local) {
                        const k = String(id);
                        local = mesh.userData.customPivots.get(k);
                    }
                }
                if (local) {
                    const m = _TMP_MAT4_A;
                    if ((mesh as BatchedMesh).isBatchedMesh || (mesh as InstancedMesh).isInstancedMesh) {
                        (mesh as InstancedMesh).getMatrixAt(id, m);
                    } else {
                        m.copy(mesh.matrix);
                    }
                    m.premultiply(mesh.matrixWorld);
                    return local.clone().applyMatrix4(m);
                }
                return null;
            };

            if ((mesh as BatchedMesh).isBatchedMesh || (mesh as InstancedMesh).isInstancedMesh) {
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

        const state = getGizmoState();
        if (pivotWorld) {
            const origin = SelectionCenter('origin', false, _ZERO_VEC3);
            const offset = new Vector3().subVectors(pivotWorld, origin);
            setGizmoState({ ...state, isCustomPivot: true, pivotOffset: offset });
        } else {
            setGizmoState({ ...state, isCustomPivot: false, pivotOffset: new Vector3(0, 0, 0) });
        }
    };

    const getSourceWorldMatrix = (source: SelectionSource, target: Matrix4): Matrix4 => {
        if (source.type === 'group') {
            return getGroupWorldMatrixWithFallback(source.id, target);
        }

        const { mesh, instanceId } = source;
        if ((mesh as BatchedMesh).isBatchedMesh || (mesh as InstancedMesh).isInstancedMesh) {
            (mesh as InstancedMesh).getMatrixAt(instanceId, target);
        } else {
            target.copy(mesh.matrix);
        }

        return target.premultiply(mesh.matrixWorld);
    };

    const getQueueEntryAnchorWorld = (entry: QueueEntry | null | undefined): Vector3 | null => {
        if (!entry || !entry.gizmoLocalPosition) return null;

        const source: SelectionSource = entry.type === 'group'
            ? { type: 'group', id: entry.id! }
            : { type: 'object', mesh: entry.mesh!, instanceId: entry.instanceId! };

        return entry.gizmoLocalPosition.clone().applyMatrix4(getSourceWorldMatrix(source, _TMP_MAT4_A));
    };

    const applySelectionAnchorFromQueue = (
        anchorWorld: Vector3 | null,
        selectionCount: number,
        anchorMode?: 'default' | 'center'
    ): void => {
        if (!anchorWorld) return;

        const updates: Partial<GizmoState> = {
            _gizmoAnchorPosition: anchorWorld,
            _gizmoAnchorValid: true
        };

        if (selectionCount > 1) {
            updates._multiSelectionOriginAnchorPosition = anchorWorld;
            updates._multiSelectionOriginAnchorValid = true;
            if (anchorMode) {
                updates.selectionAnchorMode = anchorMode;
            } else if (initialAnchorMode) {
                updates.selectionAnchorMode = initialAnchorMode;
            }
        } else {
            updates.selectionAnchorMode = 'default';
        }

        console.log(`[Swap] Applying Anchor Mode: ${updates.selectionAnchorMode} (Count: ${selectionCount}, Requested: ${anchorMode})`);
        setGizmoState(updates);

        if (selectionCount > 1) {
            setMultiAnchorInitial?.(anchorWorld.clone());
        }
    };

    const state = getGizmoState();

    const getCurrentSelectionAnchorWorld = (selectionCount: number): Vector3 | null => {
        const state = getGizmoState();
        if (selectionCount > 1 && state._multiSelectionOriginAnchorValid) {
            return state._multiSelectionOriginAnchorPosition.clone();
        }
        if (state._gizmoAnchorValid) {
            return state._gizmoAnchorPosition.clone();
        }
        return null;
    };

    const createQueueEntry = (
        source: SelectionSource,
        promoteOnExit = false,
        anchorWorld?: Vector3 | null,
        isPrimary = false,
        anchorMode?: 'default' | 'center'
    ): QueueEntry => {
        const targetLocalPivot = new Vector3(0, 0, 0);
        let hasCustomPivot = false;

        if (anchorWorld) {
            const inverseWorld = getSourceWorldMatrix(source, _TMP_MAT4_A).clone().invert();
            targetLocalPivot.copy(anchorWorld).applyMatrix4(inverseWorld);
            hasCustomPivot = true;
        }

        if (!hasCustomPivot && state.pivotMode !== 'center') {
            if (source.type === 'object') {
                const { mesh, instanceId } = source;
                if ((mesh as BatchedMesh).isBatchedMesh || (mesh as InstancedMesh).isInstancedMesh) {
                    let pivot: Vector3 | null = null;
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

        if (!hasCustomPivot && state.pivotMode === 'center') {
            let localBox: Box3 | null = null;
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
            gizmoLocalQuaternion: new Quaternion(),
            promoteOnExit,
            isPrimary,
            selectionAnchorMode: anchorMode
        };
    };

    const createQueueItem = (
        sources: SelectionSource[],
        promoteOnExit = false,
        anchorWorld?: Vector3 | null,
        primarySource?: SelectionSource | null,
        pivotSnapshot?: PivotSnapshot
    ): QueueItem | null => {
        const anchorMode = getGizmoState().selectionAnchorMode;
        console.log(`[Swap] Capturing Mode for Queue: ${anchorMode} (Items: ${sources.length})`);
        if (sources.length === 1) {
            return createQueueEntry(sources[0], promoteOnExit, anchorWorld, matchesSource(sources[0], primarySource ?? null), anchorMode);
        }
        if (sources.length > 1) {
            const currentState = getGizmoState();
            const bundlePivot = pivotSnapshot ?? {
                isCustomPivot: currentState.isCustomPivot,
                pivotOffset: currentState.pivotOffset.clone()
            };
            return {
                type: 'bundle',
                items: sources.map((item) => createQueueEntry(item, promoteOnExit, anchorWorld, matchesSource(item, primarySource ?? null), anchorMode)),
                promoteOnExit,
                selectionAnchorMode: anchorMode,
                isCustomPivot: bundlePivot.isCustomPivot,
                pivotOffset: bundlePivot.pivotOffset.clone()
            };
        }
        return null;
    };

    const deriveEffectivePivotSnapshot = (state: GizmoState, selectionCount: number): PivotSnapshot => {
        if (selectionCount > 1 && state._multiSelectionOriginAnchorValid) {
            const originBase = SelectionCenter('origin', false, _ZERO_VEC3);
            return {
                isCustomPivot: true,
                pivotOffset: state._multiSelectionOriginAnchorPosition.clone().sub(originBase)
            };
        }

        if (state.isCustomPivot) {
            return {
                isCustomPivot: true,
                pivotOffset: state.pivotOffset.clone()
            };
        }

        return {
            isCustomPivot: false,
            pivotOffset: new Vector3(0, 0, 0)
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

    // Swap이나 처리가 일어난 후 다중 선택 명시적 피벗 상태 해제
    const clearExplicitPivot = () => {
        const finalState = getGizmoState();
        setGizmoState({ ...finalState, _multiSelectionExplicitPivot: false });
    };

    if (isSwap && src) {
        const srcSelected = isSelectedSource(src);
        const targetInQueue = findQueueLocation(targetSrc);
        const srcInQueue = findQueueLocation(src);
        const targetSelected = isSelectedSource(targetSrc);

        const executeFullSwap = (
            queuedLocation: { kind: 'direct' | 'bundle'; itemIndex: number; subIndex?: number },
            newPrimarySrc: SelectionSource,
            queueSelectionOnExit: boolean
        ) => {
            const qItem = vertexQueue[queuedLocation.itemIndex];
            const queuedEntries: QueueEntry[] = ('items' in qItem && Array.isArray(qItem.items))
                ? qItem.items
                : [qItem as QueueEntry];
            const queuedPivotSnapshot: PivotSnapshot | null = (
                qItem.type === 'bundle' && qItem.pivotOffset
            ) ? {
                isCustomPivot: !!qItem.isCustomPivot,
                pivotOffset: qItem.pivotOffset.clone()
            } : null;

            const queuedAnchorMode = ('selectionAnchorMode' in qItem) ? qItem.selectionAnchorMode : undefined;

            //console.log(
            //    `[Swap] Retrieved payload from Queue: mode=${queuedAnchorMode}, custom=${queuedPivotSnapshot?.isCustomPivot}, offset=${queuedPivotSnapshot?.pivotOffset?.toArray()}`
            //);
            const queuedAnchorEntry = queuedEntries[queuedLocation.subIndex ?? 0] ?? queuedEntries[0];
            const queuedAnchorWorld = getQueueEntryAnchorWorld(queuedAnchorEntry);
            const itemsToSelect: SelectionSource[] = queuedEntries.map((item) => toSelectionSourceFromEntry(item));
            const previousPrimary = getCurrentPrimary();

            const queuedPrimaryEntry = queuedEntries.find((item) => item.isPrimary === true) ?? null;
            const queuedPrimary = queuedPrimaryEntry ? toSelectionSourceFromEntry(queuedPrimaryEntry) : null;

            const itemsToQueue: SelectionSource[] = [];
            if (currentSelection.groups) {
                for (const gid of currentSelection.groups) itemsToQueue.push({ type: 'group', id: gid });
            }
            if (currentSelection.objects) {
                for (const [mesh, ids] of currentSelection.objects) {
                    for (const id of ids) itemsToQueue.push({ type: 'object', mesh: mesh as InstancedMesh | BatchedMesh | Mesh, instanceId: id });
                }
            }
            const currentSelectionAnchorWorld = getCurrentSelectionAnchorWorld(itemsToQueue.length);
            const currentStateSnapshot: PivotSnapshot = deriveEffectivePivotSnapshot(getGizmoState(), itemsToQueue.length);

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

            const primaryToUse =
                (queuedPrimary && listIncludesSource(itemsToSelect, queuedPrimary))
                    ? queuedPrimary
                    : (listIncludesSource(itemsToSelect, newPrimarySrc) ? newPrimarySrc : (itemsToSelect[0] ?? null));

            currentSelection.primary = primaryToUse ? toSelectionSource(primaryToUse) : null;

            const newQueueItem = createQueueItem(
                itemsToQueue,
                queueSelectionOnExit,
                currentSelectionAnchorWorld,
                previousPrimary,
                currentStateSnapshot
            );

            if (newQueueItem) {
                vertexQueue[queuedLocation.itemIndex] = newQueueItem;
            }

            applySelectionAnchorFromQueue(queuedAnchorWorld, itemsToSelect.length, queuedAnchorMode);

            if (queuedPivotSnapshot) {
                const state = getGizmoState();

                // 큐에 들어갈 당시 mode=center 였다면 queuedAnchorWorld가 'center' 위치로 오염되어 있을 수 있음
                // isCustomPivot일 경우, offset을 이용해 진정한 MultiSelectionOriginAnchor를 역산해서 원상복구함
                if (queuedPivotSnapshot.isCustomPivot && itemsToSelect.length > 1) {
                    const originBase = SelectionCenter('origin', false, _ZERO_VEC3);
                    const reconstructedAnchor = originBase.clone().add(queuedPivotSnapshot.pivotOffset);
                    
                    setGizmoState({
                        ...state,
                        isCustomPivot: true,
                        pivotOffset: queuedPivotSnapshot.pivotOffset.clone(),
                        _multiSelectionExplicitPivot: true,
                        _multiSelectionOriginAnchorPosition: reconstructedAnchor,
                        _multiSelectionOriginAnchorValid: true
                    });
                    
                    // 내부 World->Local 매핑 시스템에도 진짜 Origin을 등록해 복구
                    setMultiAnchorInitial?.(reconstructedAnchor);
                } else {
                    setGizmoState({
                        ...state,
                        isCustomPivot: queuedPivotSnapshot.isCustomPivot,
                        pivotOffset: queuedPivotSnapshot.pivotOffset.clone(),
                        _multiSelectionExplicitPivot: queuedPivotSnapshot.isCustomPivot
                    });
                }
            } else if (primaryToUse) {
                computeAndApplyPivotState(primaryToUse);
            }
            updateHelperPosition();
        };

        if (srcSelected && targetInQueue) {
            const _qItem = vertexQueue[targetInQueue.itemIndex];
            const _bundleItems =
                ('items' in _qItem && Array.isArray((_qItem as QueueBundle).items))
                    ? (_qItem as QueueBundle).items
                    : [_qItem as QueueEntry];
            const isSelfBundle =
                _bundleItems.length === activeSelectionCount &&
                _bundleItems.every(item => isSelectedSource(item as SelectionSource));
            if (!isSelfBundle) {
                executeFullSwap(targetInQueue, targetSrc, true);
                clearExplicitPivot();
                return;
            }
            vertexQueue.splice(targetInQueue.itemIndex, 1);
        }

        if (targetSelected && srcInQueue) {
            executeFullSwap(srcInQueue, src, false);
            clearExplicitPivot();
            return;
        }

        // src 미선택 + target 선택됨 + src가 큐에도 없는 경우:
        // src를 selection으로, 기존 selection을 queue로 이동.
        // (다중선택에서 visible 오브젝트를 선택 안의 vertex로 snap하는 경우)
        if (!srcSelected && targetSelected) {
            const previousPrimary = getCurrentPrimary();
            const itemsToQueue: SelectionSource[] = [];
            for (const gid of currentSelection.groups) itemsToQueue.push({ type: 'group', id: gid });
            for (const [mesh, ids] of currentSelection.objects) {
                for (const id of ids) itemsToQueue.push({ type: 'object', mesh: mesh as InstancedMesh | BatchedMesh | Mesh, instanceId: id });
            }
            const currentSelectionAnchorWorld = getCurrentSelectionAnchorWorld(itemsToQueue.length);
            const currentStateSnapshot = deriveEffectivePivotSnapshot(getGizmoState(), itemsToQueue.length);

            currentSelection.groups.clear();
            currentSelection.objects.clear();
            currentSelection.primary = null;

            if (src.type === 'group') {
                currentSelection.groups.add(src.id);
                currentSelection.primary = { type: 'group', id: src.id };
            } else {
                const ids = new Set<number>();
                ids.add(src.instanceId);
                currentSelection.objects.set(src.mesh, ids);
                currentSelection.primary = { type: 'object', mesh: src.mesh, instanceId: src.instanceId };
            }

            vertexQueue.length = 0;
            const newQueueItem = createQueueItem(
                itemsToQueue,
                false,
                currentSelectionAnchorWorld,
                previousPrimary,
                currentStateSnapshot
            );
            if (newQueueItem) {
                vertexQueue.push(newQueueItem);
            }

            if (itemsToQueue.length > 1) {
                setGizmoState({ selectionAnchorMode: 'default' });
            }

            computeAndApplyPivotState(src);
            updateHelperPosition();
            clearExplicitPivot();
            return;
        }
    }
    // isSwap 블록에서 처리되지 않은 경우의 폴백.
    // isSwap=false: src를 selection으로 교체 (단일선택 snap: src가 이동).  
    // isSwap=true, selection이 비어있음: src를 selection으로 올림.
    const shouldReplaceWithSrc = !!src && (!isSwap || !hasActiveSelection);
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

        setGizmoState({ selectionAnchorMode: 'default' });
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
        if (isSwap) {
            clearExplicitPivot();
            return;
        }
        while (vertexQueue.length > 0) vertexQueue.shift();
        clearExplicitPivot();
        return;
    }

    if (isSwap && Array.isArray(vertexQueue) && vertexQueue.length > 0) {
        const targetInBundle = vertexQueue.some((item) => {
            if (!item || !('items' in item) || !Array.isArray(item.items)) return false;
            return item.items.some((sub) => matchesSource(sub, targetSrc));
        });

        if (targetInBundle) {
            clearExplicitPivot();
            return;
        }
    }

    vertexQueue.push(createQueueEntry(targetSrc, false, options.targetAnchorWorld ?? null, false, 'default'));
    while (vertexQueue.length > 1) vertexQueue.shift();

    clearExplicitPivot();
}
