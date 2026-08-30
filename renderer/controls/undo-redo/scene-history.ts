import { BufferAttribute, BufferGeometry, Group, InstancedMesh, InterleavedBufferAttribute, Matrix4, Material, Mesh, Quaternion, Vector3 } from 'three/webgpu';

import { record } from './undo-redo.js';
import { getAllDescendantGroups, getAllGroupChildren, normalizePivotToVector3, type GroupData } from '../grouping/group';
import { deleteSelectedItems, type DeletedSceneDelta } from '../grouping/delete';
import type { QueueItem } from '../vertex/vertex-swap';

interface HistorySelection {
    groups: Set<string>;
    objects: Map<Mesh | InstancedMesh, Set<number>>;
    primary: { type: 'group'; id: string } | { type: 'object'; mesh: Mesh | InstancedMesh; instanceId: number } | null;
}

export interface HistoryGizmoState {
    isVertexMode: boolean;
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

interface TransformObjectState {
    mesh: Mesh | InstancedMesh;
    instanceIds: number[];
    matrices?: Float32Array;
    position?: Vector3;
    quaternion?: Quaternion;
    scale?: Vector3;
    matrix?: Matrix4;
    hadCustomPivots: boolean;
    customPivots: Array<{ key: number | string; value?: Vector3 }>;
    hadCustomPivot: boolean;
    customPivot?: Vector3;
    hadIsCustomPivot: boolean;
    isCustomPivot?: boolean;
}

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
    objects: TransformObjectState[];
    groups: TransformGroupState[];
}

export interface TransformHistoryState {
    transform: TransformState;
    ui: HistoryUiState;
}

type GeometryAttribute = BufferAttribute | InterleavedBufferAttribute;

interface GeometryObjectState {
    mesh: Mesh | InstancedMesh;
    geometry: BufferGeometry;
    material: Material | Material[];
    attributes: Array<{ attribute: GeometryAttribute; array: ArrayLike<number> & { slice(): ArrayLike<number> } }>;
}

export interface GeometryHistoryState extends TransformHistoryState {
    geometries: GeometryObjectState[];
}

interface GroupEntryState {
    id: string;
    exists: boolean;
    group?: GroupData;
    data?: GroupData;
}

interface ParentEntryState {
    key: string;
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
}

let currentSelection: HistorySelection | null = null;
let captureGizmoState: (() => HistoryGizmoState) | null = null;
let restoreGizmoState: ((state: HistoryGizmoState) => void) | null = null;
const retainedResourceCounts = new WeakMap<object, number>();

export function isSceneHistoryResourceRetained(resource: object): boolean {
    return (retainedResourceCounts.get(resource) ?? 0) > 0;
}

export function retainHistoryResources(resources: Iterable<object>, disposeIfUnused: (resource: object) => void): () => void {
    const retained = [...new Set(resources)];
    retained.forEach(resource => retainedResourceCounts.set(resource, (retainedResourceCounts.get(resource) ?? 0) + 1));
    return () => retained.forEach(resource => {
        const count = (retainedResourceCounts.get(resource) ?? 1) - 1;
        if (count > 0) retainedResourceCounts.set(resource, count);
        else {
            retainedResourceCounts.delete(resource);
            disposeIfUnused(resource);
        }
    });
}

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
    return {
        groups: new Set(currentSelection.groups),
        objects: new Map(Array.from(currentSelection.objects, ([mesh, ids]) => [mesh, new Set(ids)])),
        primary: currentSelection.primary ? { ...currentSelection.primary } : null
    };
}

export function captureHistoryUiState(): HistoryUiState {
    return { selection: captureSelection(), gizmo: captureGizmoState ? cloneValue(captureGizmoState()) : null };
}

export function restoreHistoryUiState(state: HistoryUiState): void {
    if (currentSelection && state.selection) {
        currentSelection.groups = new Set(state.selection.groups);
        currentSelection.objects = new Map(Array.from(state.selection.objects, ([mesh, ids]) => [mesh, new Set(ids)]));
        currentSelection.primary = state.selection.primary ? { ...state.selection.primary } : null;
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

export function recordStateChange<T>({ before, after, apply, refresh, dispose }: {
    before: T;
    after: T;
    apply: (state: T) => void | Promise<void>;
    refresh?: () => void | Promise<void>;
    dispose?: () => void;
}): void {
    const applySafely = async (next: T, rollback: T): Promise<void> => {
        try {
            await apply(next);
            await refresh?.();
        } catch (error) {
            try {
                await apply(rollback);
                await refresh?.();
            } catch (rollbackError) { console.error('History rollback failed.', rollbackError); }
            throw error;
        }
    };
    record({ undo: () => applySafely(before, after), redo: () => applySafely(after, before), dispose });
}

type StructuralSelection = {
    groups: Set<string>;
    objects: Map<Mesh | InstancedMesh, Set<number>>;
};

export function recordCreationChange(
    root: Group,
    created: StructuralSelection,
    beforeUi: HistoryUiState,
    afterUi = captureHistoryUiState()
): void {
    const coveredGroups = new Set(created.groups);
    created.groups.forEach(id => getAllDescendantGroups(root, id).forEach(childId => coveredGroups.add(childId)));
    const objectToGroup = root.userData.objectToGroup as Map<string, string> | undefined;
    const uncoveredObjects = new Map<Mesh | InstancedMesh, Set<number>>();
    created.objects.forEach((instanceIds, mesh) => {
        let uncovered: Set<number> | undefined;
        for (const instanceId of instanceIds) {
            if (coveredGroups.has(objectToGroup?.get(`${mesh.uuid}_${instanceId}`) ?? '')) continue;
            (uncovered ??= new Set()).add(instanceId);
        }
        if (uncovered) uncoveredObjects.set(mesh, uncovered);
    });
    const creation = { groups: new Set(created.groups), objects: uncoveredObjects };
    let detached: DeletedSceneDelta | null = null;
    recordStateChange({
        before: { present: false, ui: beforeUi },
        after: { present: true, ui: afterUi },
        apply: async state => {
            if (state.present) detached?.undo();
            else if (detached) detached.redo();
            else detached = deleteSelectedItems(root, creation, { resetSelectionAndDeselect: () => {} });
            restoreHistoryUiState(state.ui);
        },
        refresh: () => refreshHistory(root),
        dispose: () => detached?.dispose()
    });
}

export function recordReplacementChange(
    root: Group,
    removed: DeletedSceneDelta,
    created: Map<InstancedMesh, Set<number>>,
    beforeUi: HistoryUiState,
    afterUi = captureHistoryUiState()
): void {
    let detachedCreated: DeletedSceneDelta | null = null;
    recordStateChange({
        before: { replaced: false, ui: beforeUi },
        after: { replaced: true, ui: afterUi },
        apply: async state => {
            if (state.replaced) {
                removed.redo();
                detachedCreated?.undo();
            } else {
                if (detachedCreated) detachedCreated.redo();
                else detachedCreated = deleteSelectedItems(root, { groups: new Set(), objects: created }, { resetSelectionAndDeselect: () => {} });
                removed.undo();
            }
            restoreHistoryUiState(state.ui);
        },
        refresh: () => refreshHistory(root),
        dispose: () => {
            removed.dispose();
            detachedCreated?.dispose();
        }
    });
}

export function recordReplacementTransformChange(
    root: Group,
    before: TransformHistoryState,
    after: TransformHistoryState,
    replacements: Array<{ removed: DeletedSceneDelta; created: Map<InstancedMesh, Set<number>> }>,
    auxiliary?: { before: unknown; after: unknown; apply: (state: unknown) => void | Promise<void> }
): void {
    const detachedCreated: Array<DeletedSceneDelta | null> = replacements.map(() => null);
    recordStateChange({
        before: { transformed: false, value: before },
        after: { transformed: true, value: after },
        apply: async state => {
            if (state.transformed) {
                replacements.forEach((replacement, index) => {
                    replacement.removed.redo();
                    detachedCreated[index]?.undo();
                });
            } else {
                [...replacements].reverse().forEach((replacement, reverseIndex) => {
                    const index = replacements.length - reverseIndex - 1;
                    if (detachedCreated[index]) detachedCreated[index]!.redo();
                    else detachedCreated[index] = deleteSelectedItems(root, {
                        groups: new Set(), objects: replacement.created
                    }, { resetSelectionAndDeselect: () => {} });
                    replacement.removed.undo();
                });
            }
            if (auxiliary) await auxiliary.apply(state.transformed ? auxiliary.after : auxiliary.before);
            applyTransformHistoryState(root, state.value);
        },
        refresh: () => refreshHistory(root),
        dispose: () => {
            replacements.forEach(replacement => replacement.removed.dispose());
            detachedCreated.forEach(delta => delta?.dispose());
        }
    });
}

function captureTransformObject(mesh: Mesh | InstancedMesh, instanceIds: Iterable<number>): TransformObjectState {
    const isInstanced = (mesh as InstancedMesh).isInstancedMesh;
    const ids = [...new Set(instanceIds)]
        .filter(id => Number.isInteger(id) && (!isInstanced || (id >= 0 && id < (mesh as InstancedMesh).count)))
        .sort((a, b) => a - b);
    const pivotMap = mesh.userData.customPivots as Map<number | string, Vector3> | undefined;
    const state: TransformObjectState = {
        mesh,
        instanceIds: ids,
        hadCustomPivots: Object.prototype.hasOwnProperty.call(mesh.userData, 'customPivots'),
        customPivots: ids.flatMap(id => ([id, String(id)] as const).map(key => ({ key, value: pivotMap?.get(key)?.clone() }))),
        hadCustomPivot: Object.prototype.hasOwnProperty.call(mesh.userData, 'customPivot'),
        customPivot: (mesh.userData.customPivot as Vector3 | undefined)?.clone(),
        hadIsCustomPivot: Object.prototype.hasOwnProperty.call(mesh.userData, 'isCustomPivot'),
        isCustomPivot: mesh.userData.isCustomPivot as boolean | undefined
    };
    if (isInstanced) {
        state.matrices = new Float32Array(ids.length * 16);
        const matrix = new Matrix4();
        ids.forEach((instanceId, index) => {
            (mesh as InstancedMesh).getMatrixAt(instanceId, matrix);
            matrix.toArray(state.matrices!, index * 16);
        });
    } else {
        state.position = mesh.position.clone();
        state.quaternion = mesh.quaternion.clone();
        state.scale = mesh.scale.clone();
        state.matrix = mesh.matrix.clone();
    }
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

export function captureTransformState(root: Group, meshToInstanceIds: Map<Mesh | InstancedMesh, Iterable<number>>, groupIds: Iterable<string>): TransformHistoryState {
    const groups = root.userData.groups as Map<string, GroupData> | undefined;
    return {
        ui: captureHistoryUiState(),
        transform: {
            objects: Array.from(meshToInstanceIds, ([mesh, instanceIds]) => captureTransformObject(mesh, instanceIds)),
            groups: Array.from(new Set(groupIds), id => groups?.get(id)).filter((group): group is GroupData => !!group).map(captureTransformGroup)
        }
    };
}

export function captureSelectionTransformState(root: Group, meshToInstanceIds: Map<Mesh | InstancedMesh, Iterable<number>>, groupIds: Iterable<string>): TransformHistoryState {
    const objects = new Map<Mesh | InstancedMesh, Set<number>>();
    const add = (mesh: Mesh | InstancedMesh, instanceId: number): void => {
        const ids = objects.get(mesh) ?? new Set<number>();
        ids.add(instanceId);
        objects.set(mesh, ids);
    };
    meshToInstanceIds.forEach((ids, mesh) => { for (const id of ids) add(mesh, id); });
    const groups = new Set<string>();
    for (const groupId of new Set(groupIds)) {
        groups.add(groupId);
        getAllDescendantGroups(root, groupId).forEach(id => groups.add(id));
        getAllGroupChildren(root, groupId).forEach(({ mesh, instanceId }) => add(mesh, instanceId));
    }
    return captureTransformState(root, objects, groups);
}

function restoreTransformState(root: Group, transform: TransformState): void {
    const matrix = new Matrix4();
    for (const state of transform.objects) {
        if ((state.mesh as InstancedMesh).isInstancedMesh) {
            const mesh = state.mesh as InstancedMesh;
            state.instanceIds.forEach((instanceId, index) => {
                matrix.fromArray(state.matrices!, index * 16);
                mesh.setMatrixAt(instanceId, matrix);
                mesh.instanceMatrix.addUpdateRange(instanceId * 16, 16);
            });
            mesh.instanceMatrix.needsUpdate = true;
        } else {
            state.mesh.position.copy(state.position!);
            state.mesh.quaternion.copy(state.quaternion!);
            state.mesh.scale.copy(state.scale!);
            state.mesh.matrix.copy(state.matrix!);
        }
        let pivotMap = state.mesh.userData.customPivots as Map<number | string, Vector3> | undefined;
        if (state.hadCustomPivots && !pivotMap) state.mesh.userData.customPivots = pivotMap = new Map();
        state.customPivots.forEach(({ key, value }) => {
            if (value) {
                if (!pivotMap) state.mesh.userData.customPivots = pivotMap = new Map();
                pivotMap.set(key, value.clone());
            } else pivotMap?.delete(key);
        });
        if (!state.hadCustomPivots && pivotMap?.size === 0) delete state.mesh.userData.customPivots;
        if (state.hadCustomPivot) state.mesh.userData.customPivot = state.customPivot?.clone();
        else delete state.mesh.userData.customPivot;
        if (state.hadIsCustomPivot) state.mesh.userData.isCustomPivot = state.isCustomPivot;
        else delete state.mesh.userData.isCustomPivot;
        state.mesh.boundingBox = null;
        state.mesh.boundingSphere = null;
    }
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
    restoreHistoryUiState(state.ui);
}

export function recordTransformChange(root: Group, before: TransformHistoryState): void {
    const after = captureTransformState(
        root,
        new Map(before.transform.objects.map(state => [state.mesh, state.instanceIds])),
        before.transform.groups.map(state => state.id)
    );
    recordStateChange({
        before,
        after,
        apply: state => applyTransformHistoryState(root, state),
        refresh: () => refreshHistory(root)
    });
}

export function captureSelectionGeometryState(
    root: Group,
    meshToInstanceIds: Map<Mesh | InstancedMesh, Iterable<number>>,
    groupIds: Iterable<string>
): GeometryHistoryState {
    const transform = captureSelectionTransformState(root, meshToInstanceIds, groupIds);
    const meshes = new Set(transform.transform.objects.map(state => state.mesh));
    return {
        ...transform,
        geometries: [...meshes].map(mesh => ({
            mesh,
            geometry: mesh.geometry,
            material: mesh.material,
            attributes: (Object.values(mesh.geometry.attributes) as GeometryAttribute[]).map(attribute => ({
                attribute,
                array: attribute.array.slice() as ArrayLike<number> & { slice(): ArrayLike<number> }
            }))
        }))
    };
}

export function applyGeometryHistoryState(root: Group, state: GeometryHistoryState): void {
    restoreTransformState(root, state.transform);
    for (const object of state.geometries) {
        object.mesh.geometry = object.geometry;
        object.mesh.material = object.material;
        object.attributes.forEach(({ attribute, array }) => {
            attribute.array.set(array);
            attribute.needsUpdate = true;
        });
        object.mesh.computeBoundingBox();
        object.mesh.computeBoundingSphere();
    }
    restoreHistoryUiState(state.ui);
}

export function recordGeometryChange(root: Group, before: GeometryHistoryState): void {
    const after = captureSelectionGeometryState(
        root,
        new Map(before.transform.objects.map(state => [state.mesh, state.instanceIds])),
        before.transform.groups.map(state => state.id)
    );
    const meshes = new Set([...before.geometries, ...after.geometries].map(state => state.mesh));
    const release = retainHistoryResources(
        [...before.geometries, ...after.geometries].flatMap(state => [state.geometry, ...(Array.isArray(state.material) ? state.material : [state.material])]),
        resource => {
            const inUse = [...meshes].some(mesh => mesh.geometry === resource || mesh.material === resource || (Array.isArray(mesh.material) && mesh.material.includes(resource as Material)));
            if (!inUse) (resource as { dispose?: () => void }).dispose?.();
        }
    );
    recordStateChange({
        before,
        after,
        apply: state => applyGeometryHistoryState(root, state),
        refresh: () => refreshHistory(root),
        dispose: release
    });
}

export function recordGeometryAndCreationChange(
    root: Group,
    before: GeometryHistoryState,
    created: StructuralSelection
): void {
    const after = captureSelectionGeometryState(
        root,
        new Map(before.transform.objects.map(state => [state.mesh, state.instanceIds])),
        before.transform.groups.map(state => state.id)
    );
    let detached: DeletedSceneDelta | null = null;
    recordStateChange({
        before: { geometry: before, created: false },
        after: { geometry: after, created: true },
        apply: state => {
            if (state.created) detached?.undo();
            else if (detached) detached.redo();
            else detached = deleteSelectedItems(root, created, { resetSelectionAndDeselect: () => {} });
            applyGeometryHistoryState(root, state.geometry);
        },
        refresh: () => refreshHistory(root),
        dispose: () => detached?.dispose()
    });
}

export function captureGroupStructureState(
    root: Group,
    groupIds: Iterable<string>,
    objects: Iterable<{ mesh: Mesh | InstancedMesh; instanceId: number }> = []
): GroupStructureHistoryState {
    const groups = root.userData.groups as Map<string, GroupData> | undefined;
    const objectToGroup = root.userData.objectToGroup as Map<string, string> | undefined;
    const ids = new Set(groupIds);
    const affectedObjects = new Map<string, { mesh: Mesh | InstancedMesh; instanceId: number }>();
    for (const object of objects) affectedObjects.set(`${object.mesh.uuid}_${object.instanceId}`, object);
    for (const id of [...ids]) {
        getAllDescendantGroups(root, id).forEach(childId => ids.add(childId));
        getAllGroupChildren(root, id).forEach(object => affectedObjects.set(`${object.mesh.uuid}_${object.instanceId}`, object));
        let parentId = groups?.get(id)?.parent;
        while (parentId) {
            ids.add(parentId);
            parentId = groups?.get(parentId)?.parent;
        }
    }
    const objectParents: ParentEntryState[] = [];
    for (const { mesh, instanceId } of affectedObjects.values()) {
        const key = `${mesh.uuid}_${instanceId}`;
        const groupId = objectToGroup?.get(key);
        objectParents.push({ key, exists: !!groupId, groupId });
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
    state.objectParents.forEach(entry => entry.exists ? objectToGroup.set(entry.key, entry.groupId!) : objectToGroup.delete(entry.key));
    if (state.sceneOrder) root.userData.sceneOrder = state.sceneOrder.slice();
    for (const name of ['groupMirrorPairs', 'objectMirrorPairs'] as const) {
        const pairs = root.userData[name] as Map<string, string> | undefined;
        if (!pairs) continue;
        const values = state[name];
        const keys = new Set([...state.groups.map(entry => entry.id), ...values.keys()]);
        keys.forEach(key => values.has(key) ? pairs.set(key, values.get(key)!) : pairs.delete(key));
    }
    restoreHistoryUiState(state.ui);
}

export function recordGroupStructureChange(
    root: Group,
    before: GroupStructureHistoryState,
    extraGroupIds: Iterable<string> = [],
    extraObjects: Iterable<{ mesh: Mesh | InstancedMesh; instanceId: number }> = []
): void {
    const ids = new Set([...before.groups.map(entry => entry.id), ...extraGroupIds]);
    const objects = [
        ...before.objectParents.map(entry => {
            const separator = entry.key.lastIndexOf('_');
            const meshUuid = entry.key.slice(0, separator);
            const mesh = root.getObjectByProperty('uuid', meshUuid) as Mesh | InstancedMesh | undefined;
            return mesh ? { mesh, instanceId: Number(entry.key.slice(separator + 1)) } : null;
        }).filter((entry): entry is { mesh: Mesh | InstancedMesh; instanceId: number } => !!entry),
        ...extraObjects
    ];
    const after = captureGroupStructureState(root, ids, objects);
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
    const mesh = new InstancedMesh(undefined, undefined, 2);
    mesh.setMatrixAt(0, new Matrix4().makeTranslation(1, 0, 0));
    mesh.setMatrixAt(1, new Matrix4().makeTranslation(2, 0, 0));
    const selectedOnly = captureTransformObject(mesh, [0]);
    mesh.setMatrixAt(0, new Matrix4().makeTranslation(3, 0, 0));
    mesh.setMatrixAt(1, new Matrix4().makeTranslation(4, 0, 0));
    restoreTransformState(new Group(), { objects: [selectedOnly], groups: [] });
    console.assert(mesh.getMatrixAt(0, new Matrix4()).elements[12] === 1 && mesh.getMatrixAt(1, new Matrix4()).elements[12] === 4, 'Transform history restored an unselected instance.');
}
