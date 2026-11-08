import { Group, Vector3, Matrix4, Raycaster } from 'three/webgpu';
import * as GroupUtils from '../grouping/group';
import * as Overlay from './overlay';
import { entityVisibleAttributeName } from '../../entity-material';
import { getVisibleInstanceIds } from '../scene-visibility';
import { intersectSceneInstances } from './instance-raycast';
import { matchesPointerShortcut } from '../input/shortcuts';
import { getInstanceValue, isObjectBatch, objectBatches, objectRef, objectSlots, objectUuidAt, type ObjectBatch, type ObjectRef } from '../../scene-store/object-access';

// --- Types ---

export type PrimarySelection =
    | { type: 'group'; id: string }
    | { type: 'object'; uuid: string };

export interface SelectionState {
    groups: Set<string>;
    /** Selected object uuids. */
    objects: Set<string>;
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

/** A selected object's current slot. Resolved on read: slots move, uuids do not. */
export interface SelectedItem {
    type: 'object';
    mesh: ObjectBatch;
    instanceId: number;
}

// --- Selection State ---

export const currentSelection: SelectionState = {
    groups: new Set<string>(),
    objects: new Set<string>(),
    primary: null
};

let loadedObjectGroupForSelect: Group | null = null;
let _selectedItemsCacheKey: string | null = null;
let _selectedItemsCache: SelectedItem[] | null = null;
let _selectedItemsCacheUuids: (string | undefined)[] = [];

// --- Internal Helpers ---

function _getSelectionCacheKey(): string {
    if (!hasAnySelection()) return 'none';
    return `g:${Array.from(currentSelection.groups).sort().join('|')};o:${Array.from(currentSelection.objects).sort().join('|')}`;
}

/** Cached items stay valid only while every object is still in the slot it was resolved to. */
function _cachedSlotsCurrent(): boolean {
    const root = loadedObjectGroupForSelect;
    if (!root || !_selectedItemsCache) return false;
    for (let index = 0; index < _selectedItemsCache.length; index++) {
        const uuid = _selectedItemsCacheUuids[index], item = _selectedItemsCache[index];
        if (!uuid) continue;
        const ref = objectRef(root, uuid);
        if (ref?.mesh !== item.mesh || ref.instanceId !== item.instanceId) return false;
    }
    return true;
}

// --- Public API ---

export function invalidateSelectionCaches(): void {
    _selectedItemsCacheKey = null;
    _selectedItemsCache = null;
}

/** The selection's current slots grouped by batch, for one operation that writes per batch; slots move, so never keep them. */
export function toMeshMap(uuids: Iterable<string> = currentSelection.objects): Map<ObjectBatch, Set<number>> {
    return loadedObjectGroupForSelect ? objectSlots(loadedObjectGroupForSelect, uuids) : new Map();
}

/** The uuids of the objects in the given slots. Unregistered slots are skipped. */
export function toObjectUuids(meshToIds: Map<ObjectBatch, Set<number>> | null | undefined): Set<string> {
    const uuids = new Set<string>();
    const root = loadedObjectGroupForSelect;
    if (!root || !meshToIds) return uuids;
    for (const [mesh, ids] of meshToIds) for (const id of ids) {
        const uuid = objectUuidAt(root, mesh, id);
        if (uuid) uuids.add(uuid);
    }
    return uuids;
}

/** The uuid of the object in a slot. */
export function slotObjectUuid(mesh: ObjectBatch, instanceId: number): string | undefined {
    return loadedObjectGroupForSelect ? objectUuidAt(loadedObjectGroupForSelect, mesh, instanceId) : undefined;
}

/** An object's current slot. */
export function selectedObjectRef(uuid: string): ObjectRef | undefined {
    return loadedObjectGroupForSelect ? objectRef(loadedObjectGroupForSelect, uuid) : undefined;
}

/** The primary object's current slot; undefined when the primary is a group or missing. */
export function getPrimaryObjectRef(selection: SelectionState = currentSelection): ObjectRef | undefined {
    return selection.primary?.type === 'object' ? selectedObjectRef(selection.primary.uuid) : undefined;
}

export function isSlotSelected(mesh: ObjectBatch, instanceId: number, selection: SelectionState = currentSelection): boolean {
    const uuid = slotObjectUuid(mesh, instanceId);
    return !!uuid && selection.objects.has(uuid);
}

export function cloneSelection(selection: SelectionState): SelectionState {
    return {
        groups: new Set(selection.groups),
        objects: new Set(selection.objects),
        primary: selection.primary ? { ...selection.primary } : null
    };
}

export function getSelectedItems(): SelectedItem[] {
    const key = _getSelectionCacheKey();
    if (_selectedItemsCacheKey === key && _cachedSlotsCurrent()) return _selectedItemsCache!;

    const items: SelectedItem[] = [];
    const uuids: (string | undefined)[] = [];
    const seen = new Set<string>();
    const root = loadedObjectGroupForSelect;

    if (root) {
        for (const groupId of currentSelection.groups) {
            for (const child of GroupUtils.getAllGroupChildren(root, groupId)) {
                if (!child.mesh) continue;
                const uniqueKey = `${child.mesh.uuid}_${child.instanceId}`;
                if (seen.has(uniqueKey)) continue;
                seen.add(uniqueKey);
                items.push({ type: 'object', mesh: child.mesh, instanceId: child.instanceId });
                uuids.push(child.id ?? objectUuidAt(root, child.mesh, child.instanceId));
            }
        }
        for (const uuid of currentSelection.objects) {
            const ref = objectRef(root, uuid);
            if (!ref) continue;
            const uniqueKey = `${ref.mesh.uuid}_${ref.instanceId}`;
            if (seen.has(uniqueKey)) continue;
            seen.add(uniqueKey);
            items.push({ type: 'object', mesh: ref.mesh, instanceId: ref.instanceId });
            uuids.push(uuid);
        }
    }

    _selectedItemsCacheKey = key;
    _selectedItemsCache = items;
    _selectedItemsCacheUuids = uuids;
    return items;
}

export function setLoadedObjectGroup(group: Group): void {
    loadedObjectGroupForSelect = group;
}

export function calculateAvgOrigin(): Vector3 {
    const center = new Vector3();
    const items = getSelectedItems();
    if (items.length === 0) return center;

    const tempPos = new Vector3();
    const tempMat = new Matrix4();

    items.forEach(({ mesh, instanceId }) => {
        Overlay.getInstanceWorldMatrixForOrigin(mesh, instanceId, tempMat);
        Overlay.getInstanceLocalOriginOffset(mesh, instanceId, tempPos).applyMatrix4(tempMat);
        center.add(tempPos);
    });

    center.divideScalar(items.length);
    return center;
}

export function pickInstance(
    raycaster: Raycaster,
    rootGroup: Group
): ObjectRef | null {
    const hit = intersectSceneInstances(raycaster, rootGroup, isInstanceRendered);
    return isObjectBatch(hit?.object) && hit.instanceId !== undefined ? { mesh: hit.object, instanceId: hit.instanceId } : null;
}

export function isInstanceRendered(mesh: ObjectBatch, instanceId: number): boolean {
    return getInstanceValue(mesh, instanceId, entityVisibleAttributeName) !== 0;
}

export function getSingleSelectedGroupId(): string | null {
    if (!currentSelection.groups || currentSelection.groups.size !== 1) return null;
    if (currentSelection.objects && currentSelection.objects.size > 0) return null;
    return Array.from(currentSelection.groups)[0] || null;
}

export function getSingleSelectedMeshEntry(): ObjectRef | null {
    if (currentSelection.groups.size > 0 || currentSelection.objects.size !== 1) return null;
    const [uuid] = currentSelection.objects;
    return selectedObjectRef(uuid) ?? null;
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
    const [groupId] = currentSelection.groups;
    if (groupId) {
        currentSelection.primary = { type: 'group', id: groupId };
        return;
    }
    const [uuid] = currentSelection.objects;
    currentSelection.primary = uuid ? { type: 'object', uuid } : null;
}

export function replaceSelectionWithObjects(
    objectUuids: Iterable<string>,
    callbacks: SelectionCallbacks,
    { anchorMode = 'default' } = {}
): void {
    const uuids = new Set(objectUuids);
    if (uuids.size === 0) {
        resetSelectionAndDeselect(callbacks);
        return;
    }

    beginSelectionReplace(callbacks, { anchorMode, detachTransform: true });
    for (const uuid of uuids) currentSelection.objects.add(uuid);

    if (callbacks.recomputePivotState) callbacks.recomputePivotState();
    if (callbacks.updateHelperPosition) callbacks.updateHelperPosition();
    if (callbacks.updateSelectionOverlay) callbacks.updateSelectionOverlay();
}

export function replaceSelectionWithGroupsAndObjects(
    groupIds: Iterable<string> | null | undefined,
    objectUuids: Iterable<string> | null | undefined,
    callbacks: SelectionCallbacks,
    {
        anchorMode = 'default',
        primaryIsRangeStart = false,
        preserveAnchors = false,
        explicitPrimary = null,
        detachTransform = true
    }: {
        anchorMode?: string;
        primaryIsRangeStart?: boolean;
        preserveAnchors?: boolean;
        explicitPrimary?: PrimarySelection | null;
        detachTransform?: boolean;
    } = {}
): void {
    const groups = [...groupIds ?? []].filter(Boolean);
    const objects = [...objectUuids ?? []].filter(Boolean);
    if (groups.length === 0 && objects.length === 0) {
        resetSelectionAndDeselect(callbacks);
        return;
    }

    beginSelectionReplace(callbacks, { anchorMode, detachTransform, preserveAnchors });
    for (const gid of groups) currentSelection.groups.add(gid);
    for (const uuid of objects) currentSelection.objects.add(uuid);

    const isExplicitPrimaryValid = !!explicitPrimary && (
        (explicitPrimary.type === 'group' && currentSelection.groups.has(explicitPrimary.id)) ||
        (explicitPrimary.type === 'object' && currentSelection.objects.has(explicitPrimary.uuid))
    );

    if (isExplicitPrimaryValid && explicitPrimary) {
        currentSelection.primary = { ...explicitPrimary };
    } else if (primaryIsRangeStart) {
        if (groups[0]) currentSelection.primary = { type: 'group', id: groups[0] };
        else if (objects[0]) currentSelection.primary = { type: 'object', uuid: objects[0] };
    }

    if (callbacks.recomputePivotState) callbacks.recomputePivotState();
    if (callbacks.updateHelperPosition) callbacks.updateHelperPosition();
    if (callbacks.updateSelectionOverlay) callbacks.updateSelectionOverlay();
}

export function getSelectAllSceneSelection(loadedObjectGroup: Group): {
    groups: Set<string>; objects: Set<string>; anchorMode: 'default' | 'center';
} {
    const groups = new Set<string>(), objects = new Set<string>();
    if (loadedObjectGroup) {
        const objectToGroup = GroupUtils.getObjectToGroup(loadedObjectGroup);
        for (const mesh of objectBatches(loadedObjectGroup)) {
            if (mesh.visible === false) continue;
            const count = Overlay.getInstanceCount(mesh);
            for (let id = 0; id < count; id++) {
                if (!Overlay.isInstanceValid(mesh, id) || !isInstanceRendered(mesh, id)) continue;
                const uuid = objectUuidAt(loadedObjectGroup, mesh, id);
                if (!uuid) continue;
                const groupId = objectToGroup.get(uuid);
                if (groupId) {
                    const chain = GroupUtils.getGroupChain(loadedObjectGroup, groupId);
                    groups.add(chain[0] ?? groupId);
                } else objects.add(uuid);
            }
        }
    }
    return { groups, objects, anchorMode: groups.size + objects.size > 1 ? 'center' : 'default' };
}

export function selectAllObjectsVisibleInScene(loadedObjectGroup: Group): Set<string> {
    const uuids = new Set<string>();
    if (!loadedObjectGroup) return uuids;

    for (const mesh of objectBatches(loadedObjectGroup)) {
        if (mesh.visible === false || Overlay.getInstanceCount(mesh) <= 0) continue;
        for (const id of getVisibleInstanceIds(mesh)) {
            const uuid = objectUuidAt(loadedObjectGroup, mesh, id);
            if (uuid) uuids.add(uuid);
        }
    }

    return uuids;
}

export function isMultiSelection(): boolean {
    return currentSelection.groups.size + currentSelection.objects.size > 1;
}

export function commitSelectionChange(callbacks: SelectionCallbacks): void {
    invalidateSelectionCaches();
    if (hasAnySelection()) {
        if (!currentSelection.primary) {
            setPrimaryToFirstAvailable();
        }
    } else {
        if (callbacks.detachTransformControls) callbacks.detachTransformControls();
        if (callbacks.clearGizmoAnchor) callbacks.clearGizmoAnchor();
        if (callbacks.resetPivotState) callbacks.resetPivotState();
    }

    if (callbacks.recomputePivotState) callbacks.recomputePivotState();
    if (callbacks.updateHelperPosition) callbacks.updateHelperPosition();
    if (callbacks.updateSelectionOverlay) callbacks.updateSelectionOverlay();
}

function clearPrimaryIf(type: 'group' | 'object', id: string): void {
    const primary = currentSelection.primary;
    if (primary && primary.type === type && (primary.type === 'group' ? primary.id : primary.uuid) === id) currentSelection.primary = null;
}

export function handleSelectionClick(
    raycaster: Raycaster,
    event: MouseEvent | { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey?: boolean },
    loadedObjectGroup: Group,
    callbacks: SelectionCallbacks
): void {
    const picked = pickInstance(raycaster, loadedObjectGroup);
    const pickedUuid = picked ? objectUuidAt(loadedObjectGroup, picked.mesh, picked.instanceId) : undefined;
    const additive = matchesPointerShortcut(event, 'multiSelect');

    if (!picked || !pickedUuid) {
        if (!additive) {
            if (callbacks.onDeselect) {
                callbacks.onDeselect();
            } else {
                resetSelectionAndDeselect(callbacks);
            }
        }
        return;
    }

    const immediateGroupId = GroupUtils.getObjectToGroup(loadedObjectGroup).get(pickedUuid);

    const bypassGroupSelection = matchesPointerShortcut(event, 'boxSelect');

    let target: { type: 'object'; uuid: string } | { type: 'group'; id: string } = { type: 'object', uuid: pickedUuid };
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
                if (additive || callbacks.isVertexMode) {
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

    if (additive) {
        if (groupToDeselect && currentSelection.groups.delete(groupToDeselect)) clearPrimaryIf('group', groupToDeselect);

        if (target.type === 'group') {
            const gid = target.id;
            if (currentSelection.groups.delete(gid)) {
                clearPrimaryIf('group', gid);
            } else {
                currentSelection.groups.add(gid);
                if (!currentSelection.primary) currentSelection.primary = { type: 'group', id: gid };
            }
        } else if (currentSelection.objects.delete(target.uuid)) {
            clearPrimaryIf('object', target.uuid);
        } else {
            currentSelection.objects.add(target.uuid);
            if (!currentSelection.primary) currentSelection.primary = { type: 'object', uuid: target.uuid };
        }
    } else {
        let performedSurgicalUpdate = false;

        const isTargetAlreadySelected = target.type === 'group'
            ? currentSelection.groups.has(target.id)
            : currentSelection.objects.has(target.uuid);

        if (callbacks.isVertexMode && target.type !== 'group' && (groupToDeselect || isTargetAlreadySelected)) {
            if (groupToDeselect && currentSelection.groups.delete(groupToDeselect)) {
                clearPrimaryIf('group', groupToDeselect);
            } else if (isTargetAlreadySelected) {
                currentSelection.objects.delete(target.uuid);
                clearPrimaryIf('object', target.uuid);
            }

            invalidateSelectionCaches();
            if (callbacks.recomputePivotState) callbacks.recomputePivotState();
            if (callbacks.updateHelperPosition) callbacks.updateHelperPosition();

            beginSelectionReplace(callbacks, { detachTransform: true });

            currentSelection.objects.add(target.uuid);
            currentSelection.primary = { type: 'object', uuid: target.uuid };

            performedSurgicalUpdate = true;
        } else if (groupToDeselect) {
            if (currentSelection.groups.delete(groupToDeselect)) clearPrimaryIf('group', groupToDeselect);

            if (target.type === 'group') {
                currentSelection.groups.add(target.id);
                if (!currentSelection.primary) currentSelection.primary = { type: 'group', id: target.id };
            } else {
                currentSelection.objects.add(target.uuid);
                if (!currentSelection.primary) currentSelection.primary = { type: 'object', uuid: target.uuid };
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
                currentSelection.objects.add(target.uuid);
                currentSelection.primary = { type: 'object', uuid: target.uuid };
            }
        }
    }

    commitSelectionChange(callbacks);
}
