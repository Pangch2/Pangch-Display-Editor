import { Group, Matrix4, Quaternion, Vector3 } from 'three/webgpu';

import { record } from './undo-redo.js';
import { getAllDescendantGroups, getAllGroupChildren, normalizePivotToVector3, type GroupData } from '../grouping/group';
import type { SelectionState } from '../selection/select';
import { getLinkedMirrorSelection } from '../transform/mirroring';
import { getMirrorPlane, setMirrorPlane } from '../transform/mirror-planes';
import { deleteSelectedItems, type DeletedSceneDelta } from '../grouping/delete';
import type { QueueItem, SelectionSource } from '../vertex/vertex-swap';
import { animationSession, captureAnimationSnapshot, recordAnimationTransform, restoreAnimationSnapshot, rebaseAnimationStructure, syncAnimationTargets, type AnimationSnapshot } from '../../animation/animation-state';
import type { ReplacementDelta } from '../../load-project/display/mesh-builder';
import { getInstanceCount, hasObjectPivotData, invalidateBatchBounds, markInstanceMatrices, objectHeadValues, objectIsCustomPivot, objectPivot, objectRef, objectSlots, objectUuidAt, readInstanceMatrix, readObjectRef, setObjectHeadValues, setObjectIsCustomPivot, setObjectPivot, writeInstanceMatrix, type ObjectHeadValues } from '../../scene-store/object-access';
import { ObjectStore } from '../../scene-store/object-store';
import { ObjectBatch } from '../../scene-store/object-batch';

type HistorySelection = SelectionState;

export interface HistoryGizmoState {
    isVertexMode: boolean;
    pivotMode: string;
    vertexQueue: QueueItem[];
    selectedVertexKeys: Set<string>;
    isCustomPivot: boolean;
    pivotOffset: Vector3;
    gizmoAnchorValid: boolean;
    gizmoAnchorPosition: Vector3;
    multiSelectionOriginAnchorValid: boolean;
    multiSelectionOriginAnchorPosition: Vector3;
    multiSelectionOriginAnchorInitialValid: boolean;
    multiSelectionOriginAnchorInitialPosition: Vector3;
    multiSelectionOriginAnchorInitialLocalValid: boolean;
    multiSelectionOriginAnchorInitialLocal: Vector3;
    multiSelectionExplicitPivot: boolean;
    multiSelectionAccumulatedRotation: Quaternion;
    selectionAnchorMode: 'default' | 'center';
}

export interface HistoryUiState {
    selection: HistorySelection | null;
    gizmo: HistoryGizmoState | null;
}

/** Per-object transforms by uuid. Restoring writes each object's current slot, wherever slot moves put it. */
interface TransformObjectsState {
    uuids: string[];
    /** Batch-local instance matrices, 16 floats per object. */
    matrices: Float32Array;
    /** Sparse: set only for objects that have one. */
    pivots: Array<Vector3 | undefined>;
    isCustomPivots: Array<boolean | undefined>;
    /** Where the objects sat, in uuid order, while the slot table had this version: a later capture reads by slot while it still does. */
    slots?: CapturedSlots;
}

type CapturedSlots = { store: ObjectStore; version: number; runs: Array<{ mesh: ObjectBatch; ids: number[] }> };

interface TransformGroupState {
    id: string;
    position?: Vector3;
    quaternion?: Quaternion;
    scale?: Vector3;
    matrix?: Matrix4;
    pivot?: Vector3;
    hadIsCustomPivot: boolean;
    isCustomPivot?: boolean;
}

interface TransformState {
    objects: TransformObjectsState;
    groups: TransformGroupState[];
    mirrorPlanes: Array<[a: string, b: string, plane: Matrix4]>;
}

export interface TransformHistoryState {
    transform: TransformState;
    ui: HistoryUiState;
    animation?: AnimationSnapshot;
}

/** Vertex, knife and smart-scale edits change only matrices, pivots and head UV values, so those are all it keeps. */
export interface GeometryHistoryState extends TransformHistoryState {
    /** By index into transform.objects; only objects whose batch carries head values. */
    headValues: Map<number, ObjectHeadValues>;
}

interface GroupEntryState {
    id: string;
    exists: boolean;
    group?: GroupData;
    data?: GroupData;
}

interface ParentEntryState {
    uuid: string;
    exists: boolean;
    groupId?: string;
}

export interface GroupStructureHistoryState {
    groups: GroupEntryState[];
    objectParents: ParentEntryState[];
    sceneOrder?: Array<{ type: 'group' | 'object'; id: string }>;
    groupMirrorPairs: Map<string, string>;
    objectMirrorPairs: Map<string, string>;
    ui: HistoryUiState;
    animation?: AnimationSnapshot;
}

let currentSelection: HistorySelection | null = null;
let captureGizmoState: (() => HistoryGizmoState) | null = null;
let restoreGizmoState: ((state: HistoryGizmoState) => void) | null = null;
function cloneValue<T>(value: T, seen = new Map<object, unknown>()): T {
    if (!value || typeof value !== 'object') return value;
    const object = value as object & { isObject3D?: boolean; isMaterial?: boolean; isTexture?: boolean; isBufferGeometry?: boolean; clone?: () => unknown };
    if (object.isObject3D || object.isMaterial || object.isTexture || object.isBufferGeometry) return value;
    if (seen.has(object)) return seen.get(object) as T;
    if (ArrayBuffer.isView(value)) return (value as unknown as { slice(): unknown }).slice() as T;
    if (value instanceof ArrayBuffer) return value.slice(0) as T;
    if (typeof object.clone === 'function') return object.clone() as T;
    if (value instanceof Map) {
        const copy = new Map();
        seen.set(object, copy);
        value.forEach((entry, key) => copy.set(cloneValue(key, seen), cloneValue(entry, seen)));
        return copy as T;
    }
    if (value instanceof Set) {
        const copy = new Set();
        seen.set(object, copy);
        value.forEach(entry => copy.add(cloneValue(entry, seen)));
        return copy as T;
    }
    if (Array.isArray(value)) {
        const copy: unknown[] = [];
        seen.set(object, copy);
        value.forEach(entry => copy.push(cloneValue(entry, seen)));
        return copy as T;
    }
    const copy: Record<string, unknown> = {};
    seen.set(object, copy);
    Object.entries(value).forEach(([key, entry]) => { copy[key] = cloneValue(entry, seen); });
    return copy as T;
}

function captureSelection(): HistorySelection | null {
    if (!currentSelection) return null;
    return cloneSelection(currentSelection);
}

function cloneSelection(selection: HistorySelection): HistorySelection {
    return { groups: new Set(selection.groups), objects: new Set(selection.objects), primary: selection.primary ? { ...selection.primary } : null };
}

export function captureHistoryUiState(): HistoryUiState {
    return { selection: captureSelection(), gizmo: captureGizmoState ? cloneValue(captureGizmoState()) : null };
}

export function restoreHistoryUiState(state: HistoryUiState): void {
    if (currentSelection && state.selection) {
        Object.assign(currentSelection, cloneSelection(state.selection));
    }
    if (restoreGizmoState && state.gizmo) restoreGizmoState(cloneValue(state.gizmo));
}

export function setHistorySelection(selection: HistorySelection): void {
    currentSelection = selection;
}

export function setHistoryGizmoState(capture: () => HistoryGizmoState, restore: (state: HistoryGizmoState) => void): void {
    captureGizmoState = capture;
    restoreGizmoState = restore;
}

export function refreshHistory(root?: Group): void {
    root?.updateMatrixWorld(true);
    window.dispatchEvent(new CustomEvent('pde:scene-updated'));
    window.dispatchEvent(new CustomEvent('pde:history-restored', { detail: { scene: true } }));
}

export function recordStateChange<T>({ before, after, apply, refresh, dispose, animation }: {
    before: T;
    after: T;
    apply: (state: T) => void | Promise<void>;
    refresh?: () => void | Promise<void>;
    dispose?: () => void;
    animation?: { root: Group; targets: Iterable<string> };
}): void {
    const beforeAnimation = animation && animationSession(animation.root).enabled ? captureAnimationSnapshot(animation.root) : undefined;
    if (animation && beforeAnimation) recordAnimationTransform(animation.root, beforeAnimation, animation.targets);
    const afterAnimation = beforeAnimation && captureAnimationSnapshot(animation!.root);
    const applySafely = async (next: T, rollback: T, nextAnimation?: AnimationSnapshot, rollbackAnimation?: AnimationSnapshot): Promise<void> => {
        try {
            await apply(next);
            if (animation) restoreAnimationSnapshot(animation.root, nextAnimation);
            await refresh?.();
        } catch (error) {
            try {
                await apply(rollback);
                if (animation) restoreAnimationSnapshot(animation.root, rollbackAnimation);
                await refresh?.();
            } catch (rollbackError) { console.error('History rollback failed.', rollbackError); }
            throw error;
        }
    };
    record({ undo: () => applySafely(before, after, beforeAnimation, afterAnimation), redo: () => applySafely(after, before, afterAnimation, beforeAnimation), dispose });
}

type StructuralSelection = {
    groups: Set<string>;
    objects: Map<ObjectBatch, Set<number>>;
};

/** The uuids of the registered objects in the given slots, deduplicated. */
function slotUuids(root: Group, meshToInstanceIds: Map<ObjectBatch, Iterable<number>>): string[] {
    const uuids = new Set<string>();
    meshToInstanceIds.forEach((ids, mesh) => {
        const count = getInstanceCount(mesh);
        for (const id of ids) {
            if (!Number.isInteger(id) || id < 0 || id >= count) continue;
            const uuid = objectUuidAt(root, mesh, id);
            if (uuid) uuids.add(uuid);
        }
    });
    return [...uuids];
}

function captureObjectSelectionResolver(root: Group, objects: StructuralSelection['objects']): () => StructuralSelection['objects'] {
    const uuids = slotUuids(root, objects);
    return () => objectSlots(root, uuids);
}

function recordCreatedAnimationKeys(root: Group, created: StructuralSelection): void {
    if (!animationSession(root).enabled || animationSession(root).tick === 0) return;
    const ids = new Set<string>();
    const addObject = (mesh: ObjectBatch, instanceId: number) => {
        const id = objectUuidAt(root, mesh, instanceId);
        if (id) ids.add(id);
    };
    for (const id of created.groups) {
        ids.add(id);
        getAllDescendantGroups(root, id).forEach(childId => ids.add(childId));
        getAllGroupChildren(root, id).forEach(({ mesh, instanceId }) => addObject(mesh, instanceId));
    }
    created.objects.forEach((instanceIds, mesh) => {
        for (const instanceId of instanceIds) addObject(mesh, instanceId);
    });
    recordAnimationTransform(root, captureAnimationSnapshot(root), ids);
}

export function recordCreationChange(
    root: Group,
    created: StructuralSelection,
    beforeUi: HistoryUiState,
    afterUi = captureHistoryUiState()
): void {
    syncAnimationTargets(root);
    recordCreatedAnimationKeys(root, created);
    const coveredGroups = new Set(created.groups);
    created.groups.forEach(id => getAllDescendantGroups(root, id).forEach(childId => coveredGroups.add(childId)));
    const objectToGroup = root.userData.objectToGroup as Map<string, string> | undefined;
    const uncoveredObjects = new Map<ObjectBatch, Set<number>>();
    created.objects.forEach((instanceIds, mesh) => {
        let uncovered: Set<number> | undefined;
        for (const instanceId of instanceIds) {
            if (coveredGroups.has(objectToGroup?.get(objectUuidAt(root, mesh, instanceId) ?? '') ?? '')) continue;
            (uncovered ??= new Set()).add(instanceId);
        }
        if (uncovered) uncoveredObjects.set(mesh, uncovered);
    });
    const creation = { groups: new Set(created.groups), objects: uncoveredObjects };
    const resolveObjects = captureObjectSelectionResolver(root, creation.objects);
    let detached: DeletedSceneDelta | null = null;
    recordStateChange({
        before: { present: false, ui: beforeUi },
        after: { present: true, ui: afterUi },
        apply: async state => {
            if (state.present) detached?.undo();
            else if (detached) detached.redo();
            else detached = deleteSelectedItems(root, { ...creation, objects: resolveObjects() }, { resetSelectionAndDeselect: () => {} });
            restoreHistoryUiState(state.ui);
        },
        refresh: () => refreshHistory(root),
        dispose: () => detached?.dispose()
    });
}

export function recordReplacementChange(
    root: Group,
    replacement: ReplacementDelta,
    beforeUi: HistoryUiState,
    afterUi = captureHistoryUiState()
): void {
    recordStateChange({
        before: { replaced: false, ui: beforeUi },
        after: { replaced: true, ui: afterUi },
        apply: state => {
            if (state.replaced) replacement.redo();
            else replacement.undo();
            restoreHistoryUiState(state.ui);
        },
        refresh: () => refreshHistory(root),
        dispose: () => replacement.dispose(),
        // The objects keep their ids, so their animation keys are restored with the snapshot, not with the objects.
        animation: { root, targets: animationSession(root).tick > 0 ? replacement.objectIds : [] }
    });
}

export async function recordReplacementTransformChange(
    root: Group,
    before: TransformHistoryState,
    after: TransformHistoryState,
    replacements: ReplacementDelta[],
    auxiliary?: { before: unknown; after: unknown; apply: (state: unknown) => void | Promise<void> }
): Promise<void> {
    try {
        recordAnimationTransform(root, before.animation,
            animationSession(root).tick > 0 ? replacements.flatMap(replacement => replacement.objectIds) : []);
    }
    catch (error) {
        for (const replacement of [...replacements].reverse()) {
            replacement.undo();
            replacement.dispose();
        }
        if (auxiliary) await auxiliary.apply(auxiliary.before);
        applyTransformHistoryState(root, before);
        refreshHistory(root);
        window.alert(error instanceof Error ? error.message : String(error));
        return;
    }
    after.animation = captureAnimationSnapshot(root);
    recordStateChange({
        before: { transformed: false, value: before },
        after: { transformed: true, value: after },
        apply: async state => {
            if (state.transformed) replacements.forEach(replacement => replacement.redo());
            else [...replacements].reverse().forEach(replacement => replacement.undo());
            if (auxiliary) await auxiliary.apply(state.transformed ? auxiliary.after : auxiliary.before);
            applyTransformHistoryState(root, state.value);
        },
        refresh: () => refreshHistory(root),
        dispose: () => replacements.forEach(replacement => replacement.dispose())
    });
}

function captureTransformObjects(root: Group, uuids: string[], slots?: CapturedSlots): TransformObjectsState {
    const store = root.userData.objectUuidToInstance as ObjectStore | undefined;
    let state: TransformObjectsState;
    if (slots && store && slots.store === store && slots.version === store.version) {
        // No object changed slot since `slots` was read: copy by slot instead of looking each uuid up.
        state = { uuids, matrices: new Float32Array(uuids.length * 16), pivots: [], isCustomPivots: [], slots };
        let index = 0;
        for (const { mesh, ids } of slots.runs) for (const id of ids) readInstanceMatrix(mesh, id, state.matrices, 16 * index++);
    } else {
        state = { uuids: [], matrices: new Float32Array(uuids.length * 16), pivots: [], isCustomPivots: [] };
        const ref = { mesh: null as unknown as ObjectBatch, instanceId: 0 };
        for (const uuid of uuids) {
            if (!readObjectRef(root, uuid, ref)) continue;
            const index = state.uuids.push(uuid) - 1;
            readInstanceMatrix(ref.mesh, ref.instanceId, state.matrices, index * 16);
        }
        if (state.uuids.length < uuids.length) state.matrices = state.matrices.slice(0, state.uuids.length * 16);
    }
    if (hasObjectPivotData(root)) state.uuids.forEach((uuid, index) => {
        const pivot = objectPivot(root, uuid), isCustomPivot = objectIsCustomPivot(root, uuid);
        if (pivot) state.pivots[index] = pivot.clone();
        if (isCustomPivot !== undefined) state.isCustomPivots[index] = isCustomPivot;
    });
    return state;
}

function captureTransformGroup(group: GroupData): TransformGroupState {
    return {
        id: group.id,
        position: group.position?.clone(),
        quaternion: group.quaternion?.clone(),
        scale: group.scale?.clone(),
        matrix: group.matrix?.clone(),
        pivot: normalizePivotToVector3(group.pivot)?.clone(),
        hadIsCustomPivot: Object.prototype.hasOwnProperty.call(group, 'isCustomPivot'),
        isCustomPivot: group.isCustomPivot
    };
}

function captureMirrorPlanes(root: Group, uuids: string[], groupIds: string[]): TransformState['mirrorPlanes'] {
    const planes: TransformState['mirrorPlanes'] = [];
    for (const [key, ids] of [['objectMirrorPairs', uuids], ['groupMirrorPairs', groupIds]] as const) {
        const pairs = root.userData[key] as Map<string, string> | undefined;
        if (!pairs?.size) continue;
        for (const id of ids) {
            const partner = pairs.get(id);
            if (partner) planes.push([id, partner, getMirrorPlane(root, id, partner).clone()]);
        }
    }
    return planes;
}

function captureObjectTransformState(root: Group, uuids: string[], groupIds: Iterable<string>, slots?: CapturedSlots): TransformHistoryState {
    const groups = root.userData.groups as Map<string, GroupData> | undefined;
    const groupList = [...new Set(groupIds)];
    return {
        ui: captureHistoryUiState(),
        animation: captureAnimationSnapshot(root),
        transform: {
            objects: captureTransformObjects(root, uuids, slots),
            groups: groupList.map(id => groups?.get(id)).filter((group): group is GroupData => !!group).map(captureTransformGroup),
            mirrorPlanes: captureMirrorPlanes(root, uuids, groupList)
        }
    };
}

export function captureTransformState(root: Group, meshToInstanceIds: Map<ObjectBatch, Iterable<number>>, groupIds: Iterable<string>): TransformHistoryState {
    return captureObjectTransformState(root, slotUuids(root, meshToInstanceIds), groupIds);
}

export function captureSelectionTransformState(root: Group, meshToInstanceIds: Map<ObjectBatch, Iterable<number>>, groupIds: Iterable<string>): TransformHistoryState {
    // Each valid slot's uuid once, grouped by batch in first-seen order (as slotUuids orders them). Per-batch flags
    // instead of Sets: a group selection can hold the whole project. The slots are kept, so matrices are read by slot.
    const slots = new Map<ObjectBatch, { seen: Uint8Array; uuids: string[]; ids: number[] }>();
    const add = (mesh: ObjectBatch, instanceId: number): void => {
        let entry = slots.get(mesh);
        if (!entry) slots.set(mesh, entry = { seen: new Uint8Array(getInstanceCount(mesh)), uuids: [], ids: [] });
        if (!Number.isInteger(instanceId) || instanceId < 0 || instanceId >= entry.seen.length || entry.seen[instanceId]) return;
        entry.seen[instanceId] = 1;
        const uuid = objectUuidAt(root, mesh, instanceId);
        if (!uuid) return;
        entry.uuids.push(uuid);
        entry.ids.push(instanceId);
    };
    meshToInstanceIds.forEach((ids, mesh) => { for (const id of ids) add(mesh, id); });
    const groups = new Set<string>();
    for (const groupId of new Set(groupIds)) {
        groups.add(groupId);
        getAllDescendantGroups(root, groupId).forEach(id => groups.add(id));
        for (const { mesh, instanceId } of getAllGroupChildren(root, groupId)) add(mesh, instanceId);
    }
    const store = root.userData.objectUuidToInstance as ObjectStore | undefined;
    const captured = store && typeof store.version === 'number'
        ? { store, version: store.version, runs: [...slots].map(([mesh, entry]) => ({ mesh, ids: entry.ids })) } : undefined;
    return captureObjectTransformState(root, [...slots.values()].flatMap(entry => entry.uuids), groups, captured);
}

export function captureVertexHistoryState(
    root: Group,
    selection: SelectionState,
    queue: QueueItem[],
    source?: SelectionSource
): TransformHistoryState {
    const objects = objectSlots(root, selection.objects);
    const groups = new Set(selection.groups);
    const addObject = (mesh: ObjectBatch, instanceId: number): void => {
        const ids = objects.get(mesh) ?? new Set<number>();
        ids.add(instanceId);
        objects.set(mesh, ids);
    };

    // Queued sources can move even though they are no longer selected.
    for (const item of queue) {
        for (const entry of item.type === 'bundle' ? item.items : [item]) {
            if (entry.type === 'group') groups.add(entry.id!);
            else {
                const ref = entry.id ? objectRef(root, entry.id) : undefined;
                if (ref) addObject(ref.mesh, ref.instanceId);
            }
        }
    }
    if (source?.type === 'group') groups.add(source.id);
    else if (source?.type === 'object') addObject(source.mesh, source.instanceId);

    // Snap applies mirror deltas to group descendants as well as direct objects.
    for (const groupId of [...groups]) {
        getAllDescendantGroups(root, groupId).forEach(id => groups.add(id));
        getAllGroupChildren(root, groupId).forEach(({ mesh, instanceId }) => addObject(mesh, instanceId));
    }
    const items = Array.from(objects, ([mesh, ids]) =>
        [...ids].map(instanceId => ({ type: 'object' as const, mesh, instanceId }))
    ).flat();
    const linked = getLinkedMirrorSelection(root, items, groups);
    linked.objects.forEach((ids, mesh) => ids.forEach(id => addObject(mesh, id)));
    linked.groups.forEach(id => groups.add(id));

    const before = captureSelectionTransformState(root, objects, groups);
    // The first click is a pending snap gesture, not a selection to restore on undo.
    before.ui.gizmo?.selectedVertexKeys.clear();
    return before;
}

function restoreTransformObjects(root: Group, state: TransformObjectsState): void {
    const rows = new Map<ObjectBatch, Array<[instanceId: number, index: number]>>();
    state.uuids.forEach((uuid, index) => {
        const ref = objectRef(root, uuid);
        if (!ref) return;
        setObjectPivot(root, uuid, state.pivots[index]?.clone());
        setObjectIsCustomPivot(root, uuid, state.isCustomPivots[index]);
        let list = rows.get(ref.mesh);
        if (!list) rows.set(ref.mesh, list = []);
        list.push([ref.instanceId, index]);
    });
    // Rows sorted by slot upload as contiguous spans.
    for (const [batch, list] of rows) {
        list.sort((a, b) => a[0] - b[0]);
        let start = -1, end = -1;
        for (const [id, index] of list) {
            writeInstanceMatrix(batch, id, state.matrices, index * 16);
            if (id === end) { end++; continue; }
            if (start >= 0) markInstanceMatrices(batch, start, end - start);
            start = id;
            end = id + 1;
        }
        if (start >= 0) markInstanceMatrices(batch, start, end - start);
        invalidateBatchBounds(batch);
    }
}

function restoreTransformState(root: Group, transform: TransformState): void {
    restoreTransformObjects(root, transform.objects);
    for (const [a, b, plane] of transform.mirrorPlanes) setMirrorPlane(root, a, b, plane);
    const groups = root.userData.groups as Map<string, GroupData> | undefined;
    for (const state of transform.groups) {
        const group = groups?.get(state.id) as Partial<GroupData> | undefined;
        if (!group) continue;
        group.position = state.position?.clone();
        group.quaternion = state.quaternion?.clone();
        group.scale = state.scale?.clone();
        group.matrix = state.matrix?.clone();
        group.pivot = state.pivot?.clone();
        if (state.hadIsCustomPivot) group.isCustomPivot = state.isCustomPivot;
        else delete group.isCustomPivot;
    }
}

export function applyTransformHistoryState(root: Group, state: TransformHistoryState): void {
    restoreTransformState(root, state.transform);
    restoreAnimationSnapshot(root, state.animation);
    restoreHistoryUiState(state.ui);
}

export function recordTransformChange(root: Group, before: TransformHistoryState): void {
    try { recordAnimationTransform(root, before.animation); }
    catch (error) {
        applyTransformHistoryState(root, before);
        refreshHistory(root);
        window.alert(error instanceof Error ? error.message : String(error));
        return;
    }
    const after = captureObjectTransformState(root, before.transform.objects.uuids, before.transform.groups.map(state => state.id), before.transform.objects.slots);
    recordStateChange({
        before,
        after,
        apply: state => applyTransformHistoryState(root, state),
        refresh: () => refreshHistory(root)
    });
}

function withHeadValues(root: Group, transform: TransformHistoryState): GeometryHistoryState {
    const headValues = new Map<number, ObjectHeadValues>();
    transform.transform.objects.uuids.forEach((uuid, index) => {
        const values = objectHeadValues(root, uuid);
        if (Object.keys(values).length) headValues.set(index, values);
    });
    return { ...transform, headValues };
}

export function captureSelectionGeometryState(
    root: Group,
    meshToInstanceIds: Map<ObjectBatch, Iterable<number>>,
    groupIds: Iterable<string>
): GeometryHistoryState {
    return withHeadValues(root, captureSelectionTransformState(root, meshToInstanceIds, groupIds));
}

function captureObjectGeometryState(root: Group, before: GeometryHistoryState): GeometryHistoryState {
    return withHeadValues(root, captureObjectTransformState(root, before.transform.objects.uuids, before.transform.groups.map(state => state.id), before.transform.objects.slots));
}

export function applyGeometryHistoryState(root: Group, state: GeometryHistoryState): void {
    restoreTransformState(root, state.transform);
    state.headValues.forEach((values, index) => setObjectHeadValues(root, state.transform.objects.uuids[index], values));
    restoreAnimationSnapshot(root, state.animation);
    restoreHistoryUiState(state.ui);
}

export function recordGeometryChange(root: Group, before: GeometryHistoryState): void {
    try { recordAnimationTransform(root, before.animation); }
    catch (error) {
        applyGeometryHistoryState(root, before);
        refreshHistory(root);
        window.alert(error instanceof Error ? error.message : String(error));
        return;
    }
    recordStateChange({
        before,
        after: captureObjectGeometryState(root, before),
        apply: state => applyGeometryHistoryState(root, state),
        refresh: () => refreshHistory(root)
    });
}

export function recordGeometryAndCreationChange(
    root: Group,
    before: GeometryHistoryState,
    created: StructuralSelection
): void {
    const resolveObjects = captureObjectSelectionResolver(root, created.objects);
    try {
        recordAnimationTransform(root, before.animation);
        recordCreatedAnimationKeys(root, created);
    }
    catch (error) {
        deleteSelectedItems(root, created, { resetSelectionAndDeselect: () => {} }).dispose();
        applyGeometryHistoryState(root, before);
        refreshHistory(root);
        window.alert(error instanceof Error ? error.message : String(error));
        return;
    }
    const after = captureObjectGeometryState(root, before);
    let detached: DeletedSceneDelta | null = null;
    recordStateChange({
        before: { geometry: before, created: false },
        after: { geometry: after, created: true },
        apply: state => {
            if (state.created) detached?.undo();
            else if (detached) detached.redo();
            else detached = deleteSelectedItems(root, { ...created, objects: resolveObjects() }, { resetSelectionAndDeselect: () => {} });
            applyGeometryHistoryState(root, state.geometry);
        },
        refresh: () => refreshHistory(root),
        dispose: () => detached?.dispose()
    });
}

export function captureGroupStructureState(
    root: Group,
    groupIds: Iterable<string>,
    objects: Iterable<{ mesh: ObjectBatch; instanceId: number }> = []
): GroupStructureHistoryState {
    const groups = root.userData.groups as Map<string, GroupData> | undefined;
    const objectToGroup = root.userData.objectToGroup as Map<string, string> | undefined;
    const ids = new Set(groupIds);
    const affectedObjects = new Set<string>();
    const addObject = ({ mesh, instanceId }: { mesh: ObjectBatch; instanceId: number }): void => {
        const uuid = objectUuidAt(root, mesh, instanceId);
        if (uuid) affectedObjects.add(uuid);
    };
    for (const object of objects) addObject(object);
    for (const id of [...ids]) {
        getAllDescendantGroups(root, id).forEach(childId => ids.add(childId));
        getAllGroupChildren(root, id).forEach(child => affectedObjects.add(child.id));
        let parentId = groups?.get(id)?.parent;
        while (parentId) {
            ids.add(parentId);
            parentId = groups?.get(parentId)?.parent;
        }
    }
    const objectParents: ParentEntryState[] = [];
    for (const uuid of affectedObjects) {
        const groupId = objectToGroup?.get(uuid);
        objectParents.push({ uuid, exists: !!groupId, groupId });
        if (groupId) ids.add(groupId);
    }
    const capturePairs = (name: 'groupMirrorPairs' | 'objectMirrorPairs') => {
        const pairs = root.userData[name] as Map<string, string> | undefined;
        const keys = name === 'groupMirrorPairs' ? ids : new Set<string>();
        return new Map([...keys].flatMap(key => {
            const partner = pairs?.get(key);
            return partner ? [[key, partner] as const] : [];
        }));
    };
    return {
        animation: captureAnimationSnapshot(root),
        groups: [...ids].map(id => {
            const group = groups?.get(id);
            return { id, exists: !!group, group, data: group ? cloneValue(group) : undefined };
        }),
        objectParents,
        sceneOrder: (root.userData.sceneOrder as Array<{ type: 'group' | 'object'; id: string }> | undefined)?.slice(),
        groupMirrorPairs: capturePairs('groupMirrorPairs'),
        objectMirrorPairs: capturePairs('objectMirrorPairs'),
        ui: captureHistoryUiState()
    };
}

function restoreGroupStructureState(root: Group, state: GroupStructureHistoryState): void {
    const groups = root.userData.groups as Map<string, GroupData>;
    for (const entry of state.groups) {
        if (!entry.exists) {
            groups.delete(entry.id);
            continue;
        }
        const group = entry.group!;
        Object.keys(group).forEach(key => delete (group as unknown as Record<string, unknown>)[key]);
        Object.assign(group, cloneValue(entry.data!));
        groups.set(entry.id, group);
    }
    const objectToGroup = root.userData.objectToGroup as Map<string, string>;
    for (const entry of state.objectParents) {
        if (entry.exists) objectToGroup.set(entry.uuid, entry.groupId!);
        else objectToGroup.delete(entry.uuid);
    }
    if (state.sceneOrder) root.userData.sceneOrder = state.sceneOrder.slice();
    for (const name of ['groupMirrorPairs', 'objectMirrorPairs'] as const) {
        const pairs = root.userData[name] as Map<string, string> | undefined;
        if (!pairs) continue;
        const values = state[name];
        const keys = new Set([...state.groups.map(entry => entry.id), ...values.keys()]);
        keys.forEach(key => values.has(key) ? pairs.set(key, values.get(key)!) : pairs.delete(key));
    }
    restoreAnimationSnapshot(root, state.animation);
    restoreHistoryUiState(state.ui);
}

export function recordGroupStructureChange(
    root: Group,
    before: GroupStructureHistoryState,
    extraGroupIds: Iterable<string> = [],
    extraObjects: Iterable<{ mesh: ObjectBatch; instanceId: number }> = []
): void {
    try { rebaseAnimationStructure(root, before.animation); }
    catch (error) {
        const groups = root.userData.groups as Map<string, GroupData>;
        for (const id of extraGroupIds) if (!before.groups.some(entry => entry.id === id)) groups.delete(id);
        restoreGroupStructureState(root, before);
        refreshHistory(root);
        window.alert(error instanceof Error ? error.message : String(error));
        return;
    }
    const ids = new Set([...before.groups.map(entry => entry.id), ...extraGroupIds]);
    const objects = [...before.objectParents.flatMap(entry => objectRef(root, entry.uuid) ?? []), ...extraObjects];
    const after = captureGroupStructureState(root, ids, objects);
    // Expanding captured ancestors also finds untouched siblings, which must not become creations to undo.
    after.groups = after.groups.filter(entry => ids.has(entry.id));
    const allIds = new Set([...before.groups.map(entry => entry.id), ...after.groups.map(entry => entry.id)]);
    for (const id of allIds) {
        if (!before.groups.some(entry => entry.id === id)) before.groups.push({ id, exists: false });
        if (!after.groups.some(entry => entry.id === id)) after.groups.push({ id, exists: false });
    }
    recordStateChange({
        before,
        after,
        apply: state => restoreGroupStructureState(root, state),
        refresh: () => refreshHistory(root)
    });
}

if (import.meta.env.DEV) {
    const root = new Group();
    const mesh = new ObjectBatch(undefined, undefined, 3);
    root.add(mesh);
    root.userData.objectUuidToInstance = new ObjectStore([['a', { mesh, instanceId: 0 }], ['b', { mesh, instanceId: 1 }]]);
    mesh.setMatrixAt(0, new Matrix4().makeTranslation(1, 0, 0));
    mesh.setMatrixAt(1, new Matrix4().makeTranslation(2, 0, 0));
    const selectedOnly = captureTransformObjects(root, ['a']);
    // 'a' moves to slot 2 (as a delete would move it); restoring must follow the uuid.
    mesh.setMatrixAt(2, new Matrix4().makeTranslation(3, 0, 0));
    mesh.setMatrixAt(1, new Matrix4().makeTranslation(4, 0, 0));
    root.userData.objectUuidToInstance.set('a', { mesh, instanceId: 2 });
    restoreTransformObjects(root, selectedOnly);
    const x = (id: number) => mesh.getMatrixAt(id, new Matrix4()).elements[12];
    console.assert(x(2) === 1 && x(1) === 4, 'Transform history did not follow the object to its new slot.');
}
