import * as THREE from 'three/webgpu';
import * as GroupUtils from './group';
import * as Overlay from './overlay';

// --- Types ---

export type PrimarySelection = 
    | { type: 'group'; id: string }
    | { type: 'object'; mesh: THREE.Mesh | THREE.BatchedMesh | THREE.InstancedMesh; instanceId: number };

export interface SelectionState {
    groups: Set<string>;
    objects: Map<THREE.Mesh | THREE.BatchedMesh | THREE.InstancedMesh, Set<number>>;
    primary: PrimarySelection | null;
}

export interface SelectionCallbacks {
    pushToVertexQueue?: () => void;
    revertEphemeralPivotUndoIfAny?: () => void;
    detachTransformControls?: () => void;
    clearGizmoAnchor?: () => void;
    setSelectionAnchorMode?: (mode: string) => void;
    resetPivotState?: () => void;
    hasVertexQueue?: () => boolean;
    updateHelperPosition?: () => void;
    updateSelectionOverlay?: () => void;
    recomputePivotState?: () => void;
    isVertexMode?: boolean;
    onDeselect?: () => void;
}

export interface SelectedItem {
    type: 'object';
    mesh: THREE.Mesh | THREE.BatchedMesh | THREE.InstancedMesh;
    instanceId: number;
}

// --- Selection State ---

export const currentSelection: SelectionState = {
    groups: new Set<string>(),
    objects: new Map<THREE.Mesh | THREE.BatchedMesh | THREE.InstancedMesh, Set<number>>(),
    primary: null
};

let loadedObjectGroupForSelect: THREE.Group | null = null;
let _selectedItemsCacheKey: string | null = null;
let _selectedItemsCache: SelectedItem[] | null = null;

// --- Internal Helpers ---

function _getSelectionCacheKey(): string {
    if (!hasAnySelection()) return 'none';

    const g = currentSelection.groups && currentSelection.groups.size > 0
        ? Array.from(currentSelection.groups).sort().join('|')
        : '';

    const oParts: string[] = [];
    if (currentSelection.objects && currentSelection.objects.size > 0) {
        for (const [mesh, ids] of currentSelection.objects) {
            oParts.push(`${mesh.uuid}:${Array.from(ids).sort().join(',')}`);
        }
    }
    oParts.sort();

    return `g:${g};o:${oParts.join('|')}`;
}

// --- Public API ---

export function invalidateSelectionCaches(): void {
    _selectedItemsCacheKey = null;
    _selectedItemsCache = null;
}

export function getSelectedItems(): SelectedItem[] {
    const key = _getSelectionCacheKey();
    if (_selectedItemsCacheKey === key && _selectedItemsCache) return _selectedItemsCache;

    const items: SelectedItem[] = [];
    const seen = new Set<string>();

    if (currentSelection.groups && currentSelection.groups.size > 0) {
        if (loadedObjectGroupForSelect) {
            for (const groupId of currentSelection.groups) {
                const children = GroupUtils.getAllGroupChildren(loadedObjectGroupForSelect, groupId);
                children.forEach((child) => {
                    const uniqueKey = `${child.mesh.uuid}_${child.instanceId}`;
                    if (!seen.has(uniqueKey)) {
                        seen.add(uniqueKey);
                        items.push({ type: 'object', mesh: child.mesh, instanceId: child.instanceId });
                    }
                });
            }
        }
    }

    if (currentSelection.objects && currentSelection.objects.size > 0) {
        for (const [mesh, ids] of currentSelection.objects) {
            for (const id of ids) {
                const uniqueKey = `${mesh.uuid}_${id}`;
                if (!seen.has(uniqueKey)) {
                    seen.add(uniqueKey);
                    items.push({ type: 'object', mesh, instanceId: id });
                }
            }
        }
    }

    _selectedItemsCacheKey = key;
    _selectedItemsCache = items;
    return items;
}

export function setLoadedObjectGroup(group: THREE.Group): void {
    loadedObjectGroupForSelect = group;
}

export function calculateAvgOrigin(): THREE.Vector3 {
    const center = new THREE.Vector3();
    const items = getSelectedItems();
    if (items.length === 0) return center;

    const tempPos = new THREE.Vector3();
    const tempMat = new THREE.Matrix4();

    items.forEach(({ mesh, instanceId }) => {
        Overlay.getInstanceWorldMatrixForOrigin(mesh, instanceId, tempMat);
        const localY = Overlay.isItemDisplayHatEnabled(mesh, instanceId) ? 0.03125 : 0;
        tempPos.set(0, localY, 0).applyMatrix4(tempMat);
        center.add(tempPos);
    });

    center.divideScalar(items.length);
    return center;
}

export function pickInstanceByOverlayBox(
    raycaster: THREE.Raycaster, 
    rootGroup: THREE.Group
): { mesh: THREE.Mesh | THREE.BatchedMesh | THREE.InstancedMesh; instanceId: number } | null {
    const rayWorld = raycaster.ray.clone();
    const best: { mesh: THREE.Mesh | THREE.BatchedMesh | THREE.InstancedMesh | null; instanceId: number | undefined; distance: number } = { 
        mesh: null, 
        instanceId: undefined, 
        distance: Infinity 
    };

    rootGroup.traverse((obj) => {
        if (!obj || (!('isInstancedMesh' in obj) && !('isBatchedMesh' in obj))) return;
        if (obj.visible === false) return;
        if (!raycaster.layers.test(obj.layers)) return;

        const mesh = obj as THREE.InstancedMesh | THREE.BatchedMesh;
        const instanceCount = Overlay.getInstanceCount(mesh);

        if (instanceCount <= 0) return;

        for (let instanceId = 0; instanceId < instanceCount; instanceId++) {
            if (!Overlay.isInstanceValid(mesh, instanceId)) continue;

            const box = Overlay.getInstanceLocalBox(mesh, instanceId);
            if (!box) continue;

            const matrixWorld = Overlay.getInstanceWorldMatrix(mesh, instanceId, new THREE.Matrix4());
            const invMatrix = matrixWorld.clone().invert();
            const localRay = rayWorld.clone().applyMatrix4(invMatrix);
            
            const intersect = localRay.intersectBox(box, new THREE.Vector3());
            if (intersect) {
                const hitPointWorld = intersect.clone().applyMatrix4(matrixWorld);
                const dist = rayWorld.origin.distanceTo(hitPointWorld);
                
                if (dist < best.distance) {
                    best.distance = dist;
                    best.mesh = mesh;
                    best.instanceId = instanceId;
                }
            }
        }
    });

    if (!best.mesh || best.instanceId === undefined) return null;
    return { mesh: best.mesh, instanceId: best.instanceId };
}

export function getSingleSelectedGroupId(): string | null {
    if (!currentSelection.groups || currentSelection.groups.size !== 1) return null;
    if (currentSelection.objects && currentSelection.objects.size > 0) return null;
    return Array.from(currentSelection.groups)[0] || null;
}

export function getSingleSelectedMeshEntry(): { mesh: THREE.Mesh | THREE.BatchedMesh | THREE.InstancedMesh; instanceId: number } | null {
    if (currentSelection.groups && currentSelection.groups.size > 0) return null;
    if (!currentSelection.objects || currentSelection.objects.size !== 1) return null;
    
    const entry = currentSelection.objects.entries().next().value;
    if (!entry) return null;
    
    const [mesh, ids] = entry as [THREE.Mesh | THREE.BatchedMesh | THREE.InstancedMesh, Set<number>];
    return (mesh && ids && ids.size === 1) ? { mesh, instanceId: Array.from(ids)[0] as number } : null;
}

export function hasAnySelection(): boolean {
    return (currentSelection.groups.size > 0) || (currentSelection.objects.size > 0);
}

export function clearSelectionState(callbacks?: SelectionCallbacks): void {
    if (callbacks && callbacks.pushToVertexQueue) {
        callbacks.pushToVertexQueue();
    }
    
    currentSelection.groups.clear();
    currentSelection.objects.clear();
    currentSelection.primary = null;
    invalidateSelectionCaches();
}

export function beginSelectionReplace(
    callbacks: SelectionCallbacks, 
    { anchorMode = 'default', detachTransform = false, preserveAnchors = false } = {}
): void {
    if (callbacks.revertEphemeralPivotUndoIfAny) callbacks.revertEphemeralPivotUndoIfAny();
    if (detachTransform && callbacks.detachTransformControls) callbacks.detachTransformControls();
    
    clearSelectionState(callbacks);
    
    if (!preserveAnchors && callbacks.clearGizmoAnchor) callbacks.clearGizmoAnchor();
    if (callbacks.setSelectionAnchorMode) callbacks.setSelectionAnchorMode(anchorMode);
    if (callbacks.resetPivotState) callbacks.resetPivotState();

    currentSelection.primary = null;
    invalidateSelectionCaches();
}

export function resetSelectionAndDeselect(callbacks: SelectionCallbacks): void {
     if (hasAnySelection() || (callbacks.hasVertexQueue && callbacks.hasVertexQueue())) {
         beginSelectionReplace(callbacks, { detachTransform: true });
         if (callbacks.updateHelperPosition) callbacks.updateHelperPosition();
         if (callbacks.updateSelectionOverlay) callbacks.updateSelectionOverlay();
     }
}

export function setPrimaryToFirstAvailable(): void {
    if (currentSelection.groups.size > 0) {
        const id = Array.from(currentSelection.groups)[0];
        currentSelection.primary = id ? { type: 'group', id } : null;
        return;
    }
    if (currentSelection.objects.size > 0) {
        for (const [mesh, ids] of currentSelection.objects) {
            if (ids.size > 0) {
                 const firstId = Array.from(ids)[0] as number;
                 currentSelection.primary = { type: 'object', mesh, instanceId: firstId };
                 return;
            }
        }
    }
    currentSelection.primary = null;
}

export function replaceSelectionWithObjectsMap(
    meshToIds: Map<THREE.Mesh | THREE.BatchedMesh | THREE.InstancedMesh, Set<number>>, 
    callbacks: SelectionCallbacks, 
    { anchorMode = 'default' } = {}
): void {
    if (!meshToIds || meshToIds.size === 0) {
        resetSelectionAndDeselect(callbacks);
        return;
    }

    beginSelectionReplace(callbacks, { anchorMode, detachTransform: true });

    for (const [mesh, ids] of meshToIds) {
        if (!mesh || !ids || ids.size === 0) continue;
        currentSelection.objects.set(mesh, new Set(ids));
    }

    if (callbacks.recomputePivotState) callbacks.recomputePivotState();
    if (callbacks.updateHelperPosition) callbacks.updateHelperPosition();
    if (callbacks.updateSelectionOverlay) callbacks.updateSelectionOverlay();
}

export function replaceSelectionWithGroupsAndObjects(
    groupIds: Set<string>, 
    meshToIds: Map<THREE.Mesh | THREE.BatchedMesh | THREE.InstancedMesh, Set<number>>, 
    callbacks: SelectionCallbacks, 
    { anchorMode = 'default', primaryIsRangeStart = false, preserveAnchors = false } = {}
): void {
    const hasGroups = groupIds && groupIds.size > 0;
    const hasObjects = meshToIds && meshToIds.size > 0;
    if (!hasGroups && !hasObjects) {
        resetSelectionAndDeselect(callbacks);
        return;
    }

    beginSelectionReplace(callbacks, { anchorMode, detachTransform: true, preserveAnchors });

    let firstGroupId: string | null = null;
    let firstObjectMesh: THREE.Mesh | THREE.BatchedMesh | THREE.InstancedMesh | null = null;
    let firstObjectInstanceId: number | null = null;

    if (hasGroups) {
        for (const gid of groupIds) {
            if (gid) {
                currentSelection.groups.add(gid);
                if (!firstGroupId) firstGroupId = gid;
            }
        }
    }
    if (hasObjects) {
        for (const [mesh, ids] of meshToIds) {
            if (!mesh || !ids || ids.size === 0) continue;
            currentSelection.objects.set(mesh, new Set(ids));
            if (!firstObjectMesh) {
                firstObjectMesh = mesh;
                firstObjectInstanceId = Array.from(ids)[0] as number;
            }
        }
    }

    if (primaryIsRangeStart) {
        if (firstGroupId) {
            currentSelection.primary = { type: 'group', id: firstGroupId };
        } else if (firstObjectMesh && firstObjectInstanceId !== null) {
            currentSelection.primary = { type: 'object', mesh: firstObjectMesh, instanceId: firstObjectInstanceId };
        }
    }

    if (callbacks.recomputePivotState) callbacks.recomputePivotState();
    if (callbacks.updateHelperPosition) callbacks.updateHelperPosition();
    if (callbacks.updateSelectionOverlay) callbacks.updateSelectionOverlay();
}

export function selectAllObjectsVisibleInScene(loadedObjectGroup: THREE.Group): Map<THREE.Mesh | THREE.BatchedMesh | THREE.InstancedMesh, Set<number>> {
    const meshToIds = new Map<THREE.Mesh | THREE.BatchedMesh | THREE.InstancedMesh, Set<number>>();
    if (!loadedObjectGroup) return meshToIds;

    loadedObjectGroup.traverse((obj) => {
        if (!obj || (!('isInstancedMesh' in obj) && !('isBatchedMesh' in obj))) return;
        if (obj.visible === false) return;

        const mesh = obj as THREE.InstancedMesh | THREE.BatchedMesh;
        const instanceCount = Overlay.getInstanceCount(mesh);
        if (instanceCount <= 0) return;

        const ids = new Set<number>();
        for (let i = 0; i < instanceCount; i++) {
            if (Overlay.isInstanceValid(mesh, i)) {
                ids.add(i);
            }
        }
        if (ids.size > 0) {
            meshToIds.set(mesh, ids);
        }
    });

    return meshToIds;
}

export function isMultiSelection(): boolean {
    const groupCount = currentSelection.groups.size;
    
    let objectIdCount = 0;
    for (const ids of currentSelection.objects.values()) {
        objectIdCount += ids.size;
    }
    
    return (groupCount + objectIdCount) > 1;
}

export function commitSelectionChange(callbacks: SelectionCallbacks): void {
    invalidateSelectionCaches();
    if (hasAnySelection() && !currentSelection.primary) { 
        setPrimaryToFirstAvailable();
    }
    if (callbacks.recomputePivotState) callbacks.recomputePivotState();
    if (callbacks.updateHelperPosition) callbacks.updateHelperPosition();
    if (callbacks.updateSelectionOverlay) callbacks.updateSelectionOverlay();
}

export function handleSelectionClick(
    raycaster: THREE.Raycaster,
    event: MouseEvent | { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean },
    loadedObjectGroup: THREE.Group,
    callbacks: SelectionCallbacks
): void {
    const picked = pickInstanceByOverlayBox(raycaster, loadedObjectGroup);
    
    if (!picked) {
        if (!event.shiftKey) {
            if (callbacks.onDeselect) {
                callbacks.onDeselect();
            } else {
                resetSelectionAndDeselect(callbacks);
            }
        }
        return;
    }

    const object = picked.mesh;
    const instanceId = picked.instanceId;
    const idsToSelect = [instanceId];

    const key = GroupUtils.getGroupKey(object, idsToSelect[0]);
    const objectToGroup = GroupUtils.getObjectToGroup(loadedObjectGroup);
    const immediateGroupId = objectToGroup ? objectToGroup.get(key) : null;

    const bypassGroupSelection = !!(event.ctrlKey || event.metaKey);

    let target: { type: 'object'; mesh: THREE.Mesh | THREE.BatchedMesh | THREE.InstancedMesh; ids: number[] } | { type: 'group'; id: string } = { 
        type: 'object', mesh: object, ids: idsToSelect 
    };
    let groupToDeselect: string | null = null;

    if (!bypassGroupSelection && immediateGroupId) {
        const groupChain = GroupUtils.getGroupChain(loadedObjectGroup, immediateGroupId);
        if (groupChain && groupChain.length > 0) {
            let nextGroupIdToSelect: string | null = groupChain[0];

            let deepestSelectedIndex = -1;
            for (let i = groupChain.length - 1; i >= 0; i--) {
                if (currentSelection.groups.has(groupChain[i])) {
                    deepestSelectedIndex = i;
                    break;
                }
            }

            if (deepestSelectedIndex !== -1) {
                if (event.shiftKey || callbacks.isVertexMode) {
                    groupToDeselect = groupChain[deepestSelectedIndex];
                }

                if (deepestSelectedIndex < groupChain.length - 1) {
                    nextGroupIdToSelect = groupChain[deepestSelectedIndex + 1];
                } else {
                    nextGroupIdToSelect = null;
                }
            }

            if (nextGroupIdToSelect) {
                target = { type: 'group', id: nextGroupIdToSelect };
            }
        }
    }

    if (event.shiftKey) {
        if (groupToDeselect) {
            if (currentSelection.groups.has(groupToDeselect)) {
                currentSelection.groups.delete(groupToDeselect);
                if (currentSelection.primary && currentSelection.primary.type === 'group' && currentSelection.primary.id === groupToDeselect) {
                    currentSelection.primary = null;
                }
            }
        }

        if (target.type === 'group') {
            const gid = target.id;
            if (currentSelection.groups.has(gid)) {
                currentSelection.groups.delete(gid);
                if (currentSelection.primary && currentSelection.primary.type === 'group' && currentSelection.primary.id === gid) {
                    currentSelection.primary = null;
                }
            } else {
                currentSelection.groups.add(gid);
                if (!currentSelection.primary) {
                    currentSelection.primary = { type: 'group', id: gid };
                }
            }
        } else {
            let existingSet = currentSelection.objects.get(target.mesh);
            if (!existingSet) {
                existingSet = new Set<number>();
                currentSelection.objects.set(target.mesh, existingSet);
            }

            const firstId = target.ids[0];
            const isSelected = existingSet.has(firstId);

            if (isSelected) {
                for (const id of target.ids) existingSet.delete(id);
                if (existingSet.size === 0) currentSelection.objects.delete(target.mesh);
                
                if (currentSelection.primary && 
                    currentSelection.primary.type === 'object' && 
                    currentSelection.primary.mesh === target.mesh && 
                    target.ids.includes(currentSelection.primary.instanceId)) {
                    currentSelection.primary = null;
                }
            } else {
                for (const id of target.ids) existingSet.add(id);
                if (!currentSelection.primary) {
                    currentSelection.primary = { type: 'object', mesh: target.mesh, instanceId: firstId };
                }
            }
        }
    } else {
        let performedSurgicalUpdate = false;

        if (groupToDeselect) {
            if (currentSelection.groups.has(groupToDeselect)) {
                currentSelection.groups.delete(groupToDeselect);
                if (currentSelection.primary && currentSelection.primary.type === 'group' && currentSelection.primary.id === groupToDeselect) {
                    currentSelection.primary = null;
                }
            }
            
            if (target.type === 'group') {
                currentSelection.groups.add(target.id);
                if (!currentSelection.primary) currentSelection.primary = { type: 'group', id: target.id };
            } else {
                let set = currentSelection.objects.get(target.mesh);
                if (!set) {
                    set = new Set<number>();
                    currentSelection.objects.set(target.mesh, set);
                }
                for (const id of target.ids) set.add(id);
                if (!currentSelection.primary) {
                    currentSelection.primary = { type: 'object', mesh: target.mesh, instanceId: target.ids[0] };
                }
            }

            performedSurgicalUpdate = true;
             if (callbacks.detachTransformControls) callbacks.detachTransformControls();
        }

        if (!performedSurgicalUpdate) {
            beginSelectionReplace(callbacks, { detachTransform: true });
            
            if (target.type === 'group') {
                currentSelection.groups.add(target.id);
                currentSelection.primary = { type: 'group', id: target.id };
            } else {
                const set = new Set(target.ids);
                currentSelection.objects.set(target.mesh, set);
                currentSelection.primary = { type: 'object', mesh: target.mesh, instanceId: target.ids[0] };
            }
        }
    }

    commitSelectionChange(callbacks);
}