import {
    BufferAttribute,
    BufferGeometry,
    Group,
    InterleavedBufferAttribute,
    InstancedMesh,
    Matrix4,
    Material,
    Mesh,
    Object3D,
    Quaternion,
    Vector3
} from 'three/webgpu';

import { record } from './undo-redo.js';
import { getAllDescendantGroups, getAllGroupChildren, normalizePivotToVector3, type GroupData } from '../grouping/group';
import type { QueueItem } from '../vertex/vertex-swap';

interface HistorySelection {
    groups: Set<string>;
    objects: Map<Mesh | InstancedMesh, Set<number>>;
    primary: { type: 'group'; id: string } | { type: 'object'; mesh: Mesh | InstancedMesh; instanceId: number } | null;
}

let currentSelection: HistorySelection | null = null;

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

let captureGizmoState: (() => HistoryGizmoState) | null = null;
let restoreGizmoState: ((state: HistoryGizmoState) => void) | null = null;

type TypedArray = Exclude<BufferAttribute['array'], number[]>;
type HistoryAttribute = BufferAttribute | InterleavedBufferAttribute;

interface AttributeSnapshot {
    attribute: HistoryAttribute;
    array: TypedArray;
}

function isInstancedGeometryAttribute(attribute: unknown): attribute is HistoryAttribute {
    const candidate = attribute as BufferAttribute & {
        isInstancedBufferAttribute?: boolean;
        isInterleavedBufferAttribute?: boolean;
        data?: { isInstancedInterleavedBuffer?: boolean };
    };
    return !!(candidate?.isInstancedBufferAttribute
        || (candidate?.isInterleavedBufferAttribute && candidate.data?.isInstancedInterleavedBuffer));
}

interface ObjectSnapshot {
    object: Object3D;
    children: Object3D[];
    position: Vector3;
    quaternion: Quaternion;
    scale: Vector3;
    matrix: Matrix4;
    visible: boolean;
    userData: Record<string, unknown>;
    geometry?: BufferGeometry;
    material?: Material | Material[];
    count?: number;
    attributes: AttributeSnapshot[];
}

interface TransformObjectSnapshot {
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

interface TransformGroupSnapshot {
    id: string;
    position?: Vector3;
    quaternion?: Quaternion;
    scale?: Vector3;
    matrix?: Matrix4;
    pivot?: Vector3;
    hadIsCustomPivot: boolean;
    isCustomPivot?: boolean;
}

interface TransformSnapshot {
    objects: TransformObjectSnapshot[];
    groups: TransformGroupSnapshot[];
}

export interface SceneSnapshot {
    children: Object3D[];
    objects: ObjectSnapshot[];
    userData: Record<string, unknown>;
    selection: HistorySelection | null;
    gizmo: HistoryGizmoState | null;
    metadataOnly: boolean;
    transform?: TransformSnapshot;
}

function captureSelection(): HistorySelection | null {
    if (!currentSelection) return null;
    return {
        groups: new Set(currentSelection.groups),
        objects: new Map(Array.from(currentSelection.objects, ([mesh, ids]) => [mesh, new Set(ids)])),
        primary: currentSelection.primary ? { ...currentSelection.primary } : null
    };
}

export function setHistorySelection(selection: HistorySelection): void {
    currentSelection = selection;
}

export function setHistoryGizmoState(
    capture: () => HistoryGizmoState,
    restore: (state: HistoryGizmoState) => void
): void {
    captureGizmoState = capture;
    restoreGizmoState = restore;
}

function cloneValue<T>(value: T, seen = new Map<object, unknown>()): T {
    if (!value || typeof value !== 'object') return value;
    const object = value as object & {
        isObject3D?: boolean;
        isMaterial?: boolean;
        isTexture?: boolean;
        isBufferGeometry?: boolean;
        clone?: () => unknown;
    };
    if (object.isObject3D || object.isMaterial || object.isTexture || object.isBufferGeometry) return value;
    if (seen.has(object)) return seen.get(object) as T;
    if (ArrayBuffer.isView(value)) return (value as TypedArray).slice() as T;
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

function captureObject(object: Object3D): ObjectSnapshot {
    const attributes: AttributeSnapshot[] = [];
    if ((object as InstancedMesh).isInstancedMesh) {
        const mesh = object as InstancedMesh;
        attributes.push({ attribute: mesh.instanceMatrix, array: mesh.instanceMatrix.array.slice() as TypedArray });
        if (mesh.instanceColor) attributes.push({ attribute: mesh.instanceColor, array: mesh.instanceColor.array.slice() as TypedArray });
        const capturedArrays = new Set(attributes.map(({ attribute }) => attribute.array));
        Object.values(mesh.geometry.attributes).forEach(attribute => {
            if (!isInstancedGeometryAttribute(attribute) || capturedArrays.has(attribute.array)) return;
            capturedArrays.add(attribute.array);
            attributes.push({ attribute, array: attribute.array.slice() as TypedArray });
        });
    }
    return {
        object,
        children: [...object.children],
        position: object.position.clone(),
        quaternion: object.quaternion.clone(),
        scale: object.scale.clone(),
        matrix: object.matrix.clone(),
        visible: object.visible,
        userData: cloneValue(object.userData),
        geometry: (object as Mesh).isMesh ? (object as Mesh).geometry : undefined,
        material: (object as Mesh).isMesh ? (object as Mesh).material : undefined,
        count: (object as InstancedMesh).isInstancedMesh ? (object as InstancedMesh).count : undefined,
        attributes
    };
}

function captureTransformObject(mesh: Mesh | InstancedMesh, instanceIds: Iterable<number>): TransformObjectSnapshot {
    const isInstanced = (mesh as InstancedMesh).isInstancedMesh;
    const ids = [...new Set(instanceIds)]
        .filter(id => Number.isInteger(id) && (!isInstanced || (id >= 0 && id < (mesh as InstancedMesh).count)))
        .sort((a, b) => a - b);
    const pivotMap = mesh.userData.customPivots as Map<number | string, Vector3> | undefined;
    const customPivots = ids.flatMap(id => ([id, String(id)] as const)
        .map(key => ({ key, value: pivotMap?.get(key)?.clone() })));
    const snapshot: TransformObjectSnapshot = {
        mesh,
        instanceIds: ids,
        hadCustomPivots: Object.prototype.hasOwnProperty.call(mesh.userData, 'customPivots'),
        customPivots,
        hadCustomPivot: Object.prototype.hasOwnProperty.call(mesh.userData, 'customPivot'),
        customPivot: (mesh.userData.customPivot as Vector3 | undefined)?.clone(),
        hadIsCustomPivot: Object.prototype.hasOwnProperty.call(mesh.userData, 'isCustomPivot'),
        isCustomPivot: mesh.userData.isCustomPivot as boolean | undefined
    };
    if (isInstanced) {
        snapshot.matrices = new Float32Array(ids.length * 16);
        const matrix = new Matrix4();
        ids.forEach((instanceId, index) => {
            (mesh as InstancedMesh).getMatrixAt(instanceId, matrix);
            matrix.toArray(snapshot.matrices!, index * 16);
        });
    } else {
        snapshot.position = mesh.position.clone();
        snapshot.quaternion = mesh.quaternion.clone();
        snapshot.scale = mesh.scale.clone();
        snapshot.matrix = mesh.matrix.clone();
    }
    return snapshot;
}

function captureTransformGroup(group: GroupData): TransformGroupSnapshot {
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

export function captureTransformState(
    root: Group,
    meshToInstanceIds: Map<Mesh | InstancedMesh, Iterable<number>>,
    groupIds: Iterable<string>
): SceneSnapshot {
    const groups = root.userData.groups as Map<string, GroupData> | undefined;
    return {
        children: [],
        objects: [],
        userData: {},
        selection: captureSelection(),
        gizmo: captureGizmoState ? cloneValue(captureGizmoState()) : null,
        metadataOnly: false,
        transform: {
            objects: Array.from(meshToInstanceIds, ([mesh, instanceIds]) => captureTransformObject(mesh, instanceIds)),
            groups: Array.from(new Set(groupIds), id => groups?.get(id)).filter((group): group is GroupData => !!group).map(captureTransformGroup)
        }
    };
}

export function captureSelectionTransformState(
    root: Group,
    meshToInstanceIds: Map<Mesh | InstancedMesh, Iterable<number>>,
    groupIds: Iterable<string>
): SceneSnapshot {
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

function restoreTransformState(root: Group, transform: TransformSnapshot): void {
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
            } else {
                pivotMap?.delete(key);
            }
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

if (import.meta.env.DEV) {
    const mesh = new InstancedMesh(new BufferGeometry(), undefined!, 2);
    mesh.setMatrixAt(0, new Matrix4().makeTranslation(1, 0, 0));
    mesh.setMatrixAt(1, new Matrix4().makeTranslation(2, 0, 0));
    mesh.userData.customPivots = new Map([[0, new Vector3(1, 0, 0)], [1, new Vector3(2, 0, 0)]]);
    const selectedOnly = captureTransformObject(mesh, [0]);
    mesh.setMatrixAt(0, new Matrix4().makeTranslation(3, 0, 0));
    mesh.setMatrixAt(1, new Matrix4().makeTranslation(4, 0, 0));
    mesh.userData.customPivots.set(0, new Vector3(3, 0, 0));
    mesh.userData.customPivots.set(1, new Vector3(4, 0, 0));
    restoreTransformState(new Group(), { objects: [selectedOnly], groups: [] });
    const restored = mesh.getMatrixAt(0, new Matrix4());
    const untouched = mesh.getMatrixAt(1, new Matrix4());
    console.assert(restored.elements[12] === 1 && untouched.elements[12] === 4, 'Transform history must restore only selected instances.');
    console.assert(mesh.userData.customPivots.get(0).x === 1 && mesh.userData.customPivots.get(1).x === 4, 'Transform history must restore only selected pivots.');

    const object = new Mesh();
    object.position.x = 1;
    object.updateMatrix();
    const objectState = captureTransformObject(object, [0]);
    object.position.x = 3;
    object.updateMatrix();
    restoreTransformState(new Group(), { objects: [objectState], groups: [] });
    console.assert(object.position.x === 1, 'Transform history must restore a regular mesh without a scene snapshot.');
}

export function captureSceneState(root: Group, metadataOnly = false): SceneSnapshot {
    const objects: ObjectSnapshot[] = [];
    if (!metadataOnly) root.traverse(object => { if (object !== root) objects.push(captureObject(object)); });
    return {
        children: metadataOnly ? [] : [...root.children],
        objects,
        userData: cloneValue(root.userData),
        selection: captureSelection(),
        gizmo: captureGizmoState ? cloneValue(captureGizmoState()) : null,
        metadataOnly
    };
}

export function restoreSceneState(root: Group, snapshot: SceneSnapshot): void {
    if (snapshot.transform) {
        restoreTransformState(root, snapshot.transform);
    } else if (!snapshot.metadataOnly) {
        root.clear();
        snapshot.objects.forEach(state => state.object.clear());
        snapshot.objects.forEach(state => state.children.forEach(child => state.object.add(child)));
        snapshot.children.forEach(child => root.add(child));

        for (const state of snapshot.objects) {
            const { object } = state;
            object.position.copy(state.position);
            object.quaternion.copy(state.quaternion);
            object.scale.copy(state.scale);
            object.matrix.copy(state.matrix);
            object.visible = state.visible;
            object.userData = cloneValue(state.userData);
            if ((object as Mesh).isMesh) {
                (object as Mesh).geometry = state.geometry!;
                (object as Mesh).material = state.material!;
            }
            if ((object as InstancedMesh).isInstancedMesh) (object as InstancedMesh).count = state.count ?? 0;
            state.attributes.forEach(({ attribute, array }) => {
                attribute.array.set(array);
                attribute.needsUpdate = true;
            });
            if ((object as Mesh).isMesh) {
                const mesh = object as Mesh;
                mesh.computeBoundingBox();
                mesh.computeBoundingSphere();
            }
        }
    }
    if (!snapshot.transform) root.userData = cloneValue(snapshot.userData);
    if (currentSelection && snapshot.selection) {
        currentSelection.groups = new Set(snapshot.selection.groups);
        currentSelection.objects = new Map(Array.from(snapshot.selection.objects, ([mesh, ids]) => [mesh, new Set(ids)]));
        currentSelection.primary = snapshot.selection.primary ? { ...snapshot.selection.primary } : null;
    }
    if (restoreGizmoState && snapshot.gizmo) restoreGizmoState(cloneValue(snapshot.gizmo));
    root.updateMatrixWorld(true);
}

export function recordSceneChange(root: Group, before: SceneSnapshot): void {
    const after = before.transform
        ? captureTransformState(
            root,
            new Map(before.transform.objects.map(state => [state.mesh, state.instanceIds])),
            before.transform.groups.map(state => state.id)
        )
        : captureSceneState(root, before.metadataOnly);
    if (import.meta.env.DEV && before.metadataOnly) console.assert(
        before.objects.length === 0 && after.objects.length === 0,
        'Metadata-only history must not copy scene objects.'
    );
    const refresh = () => {
        window.dispatchEvent(new CustomEvent('pde:scene-updated'));
        window.dispatchEvent(new CustomEvent('pde:history-restored'));
    };
    // ponytail: full-scene snapshots favor correctness; replace with UUID diffs if history memory becomes measurable.
    record({
        undo: () => { restoreSceneState(root, before); refresh(); },
        redo: () => { restoreSceneState(root, after); refresh(); }
    });
}
