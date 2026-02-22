import * as THREE from 'three/webgpu';
import * as Overlay from './overlay.js';

const _TMP_MAT4_A = new THREE.Matrix4();
const _ZERO_VEC3 = new THREE.Vector3(0, 0, 0);

export function performSelectionSwap(
    src,
    targetSrc,
    {
        currentSelection,
        getGroups,
        getGroupWorldMatrixWithFallback,
        setGizmoState,
        getGizmoState,
        updateHelperPosition,
        SelectionCenter,
        vertexQueue
    },
    options = {}
) {
    if (!targetSrc) return;

    const matchesSource = (a, b) => {
        if (!a || !b || a.type !== b.type) return false;
        if (a.type === 'group') return a.id === b.id;
        return a.mesh === b.mesh && a.instanceId === b.instanceId;
    };

    const toSelectionSource = (source) => {
        if (!source) return null;
        if (source.type === 'group') return { type: 'group', id: source.id };
        return { type: 'object', mesh: source.mesh, instanceId: source.instanceId };
    };

    const isSelectedSource = (source) => {
        if (!source) return false;
        if (source.type === 'group') return currentSelection.groups.has(source.id);
        const ids = currentSelection.objects.get(source.mesh);
        return !!(ids && ids.has(source.instanceId));
    };

    const removeSelectedSource = (source) => {
        if (!source) return;
        if (source.type === 'group') {
            currentSelection.groups.delete(source.id);
            return;
        }
        const ids = currentSelection.objects.get(source.mesh);
        if (!ids) return;
        ids.delete(source.instanceId);
        if (ids.size === 0) currentSelection.objects.delete(source.mesh);
    };

    const addSelectedSource = (source) => {
        if (!source) return;
        if (source.type === 'group') {
            currentSelection.groups.add(source.id);
            return;
        }
        let ids = currentSelection.objects.get(source.mesh);
        if (!ids) {
            ids = new Set();
            currentSelection.objects.set(source.mesh, ids);
        }
        ids.add(source.instanceId);
    };

    const findQueueLocation = (source) => {
        if (!source || !Array.isArray(vertexQueue)) return null;
        for (let i = 0; i < vertexQueue.length; i++) {
            const qItem = vertexQueue[i];
            if (!qItem) continue;
            if (qItem.type === 'bundle' && Array.isArray(qItem.items)) {
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

    const computeAndApplyPivotState = (source) => {
        let pivotWorld = null;

        if (source.type === 'object') {
            const { mesh, instanceId } = source;

            const getWorldPivot = (id) => {
                let local = null;
                if (mesh.userData.customPivots) {
                    local = mesh.userData.customPivots.get(id);
                    if (!local) {
                        const k = (typeof id === 'number') ? String(id) : Number(id);
                        local = mesh.userData.customPivots.get(k);
                    }
                }
                if (local) {
                    const m = _TMP_MAT4_A;
                    if (mesh.isBatchedMesh || mesh.isInstancedMesh) {
                        mesh.getMatrixAt(id, m);
                    } else {
                        m.copy(mesh.matrix);
                    }
                    m.premultiply(mesh.matrixWorld);
                    return local.clone().applyMatrix4(m);
                }
                return null;
            };

            if (mesh.isBatchedMesh || mesh.isInstancedMesh) {
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
            setGizmoState({ isCustomPivot: true, pivotOffset: offset });
        } else {
            setGizmoState({ isCustomPivot: false, pivotOffset: new THREE.Vector3(0, 0, 0) });
        }
    };

    const createQueueEntry = (source) => {
        const targetLocalPivot = new THREE.Vector3(0, 0, 0);
        let hasCustomPivot = false;

        if (state.pivotMode !== 'center') {
            if (source.type === 'object') {
                const { mesh, instanceId } = source;
                if (mesh.isBatchedMesh || mesh.isInstancedMesh) {
                    let pivot = null;
                    if (mesh.userData.customPivots) {
                        pivot = mesh.userData.customPivots.get(instanceId);
                        if (!pivot) {
                            const key = (typeof instanceId === 'number') ? String(instanceId) : Number(instanceId);
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
            let localBox = null;
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
            id: source.id,
            mesh: source.mesh,
            instanceId: source.instanceId,
            gizmoLocalPosition: targetLocalPivot,
            gizmoLocalQuaternion: new THREE.Quaternion()
        };
    };

    const replaceQueueLocation = (location, newSource) => {
        if (!location || !newSource) return;
        const newEntry = createQueueEntry(newSource);
        if (location.kind === 'bundle') {
            const container = vertexQueue[location.itemIndex];
            if (!container || !Array.isArray(container.items)) return;
            container.items[location.subIndex] = newEntry;
            return;
        }
        vertexQueue[location.itemIndex] = newEntry;
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
    const hasMultiBundleInQueue = Array.isArray(vertexQueue) && vertexQueue.some((item) => {
        return item && item.type === 'bundle' && Array.isArray(item.items) && item.items.length > 1;
    });
    const allowPreserveMemberSwap = !!options.preserveSelection && activeSelectionCount <= 1 && !hasMultiBundleInQueue;

    const shouldReplaceWithSrc = !!src && (!options.preserveSelection || !hasActiveSelection);

    if (allowPreserveMemberSwap && src) {
        const srcSelected = isSelectedSource(src);
        const targetSelected = isSelectedSource(targetSrc);
        const srcInQueue = findQueueLocation(src);
        const targetInQueue = findQueueLocation(targetSrc);

        if (srcSelected && targetInQueue) {
            removeSelectedSource(src);
            addSelectedSource(targetSrc);
            replaceQueueLocation(targetInQueue, src);

            if (currentSelection.primary && matchesSource(currentSelection.primary, src)) {
                currentSelection.primary = toSelectionSource(targetSrc);
            }
            computeAndApplyPivotState(targetSrc);
            return;
        }

        if (targetSelected && srcInQueue) {
            removeSelectedSource(targetSrc);
            addSelectedSource(src);
            replaceQueueLocation(srcInQueue, targetSrc);

            if (currentSelection.primary && matchesSource(currentSelection.primary, targetSrc)) {
                currentSelection.primary = toSelectionSource(src);
            }
            computeAndApplyPivotState(src);
            return;
        }
    }

    // 1. Select Source (A) if provided
    if (shouldReplaceWithSrc) {
         currentSelection.groups.clear();
         currentSelection.objects.clear();
         currentSelection.primary = null;

         if (src.type === 'group') {
             currentSelection.groups.add(src.id);
             currentSelection.primary = { type: 'group', id: src.id };
         } else {
             const { mesh, instanceId } = src;
             const ids = new Set();
             ids.add(instanceId);

             currentSelection.objects.set(mesh, ids);
             currentSelection.primary = { type: 'object', mesh, instanceId };
         }

         // Recompute Pivot State for 'src'
         computeAndApplyPivotState(src);
         updateHelperPosition();
    }

    // 2. Queue Target (B)

    // Check if target is already selected to avoid double overlay
    let isTargetSelected = false;
    if (targetSrc.type === 'group') {
        if (currentSelection.groups.has(targetSrc.id)) isTargetSelected = true;
    } else if (targetSrc.type === 'object') {
        const ids = currentSelection.objects.get(targetSrc.mesh);
        if (ids && ids.has(targetSrc.instanceId)) isTargetSelected = true;
    }
    
    if (isTargetSelected) {
            if (options.preserveSelection && !allowPreserveMemberSwap) return;
         while (vertexQueue.length > 0) vertexQueue.shift();
         return;
    }

    if (options.preserveSelection && !allowPreserveMemberSwap && Array.isArray(vertexQueue) && vertexQueue.length > 0) {
        const targetInBundle = vertexQueue.some((item) => {
            if (!item || item.type !== 'bundle' || !Array.isArray(item.items)) return false;
            return item.items.some((sub) => matchesSource(sub, targetSrc));
        });

        if (targetInBundle) {
            return;
        }
    }

    vertexQueue.push(createQueueEntry(targetSrc));

    while (vertexQueue.length > 1) vertexQueue.shift();
}