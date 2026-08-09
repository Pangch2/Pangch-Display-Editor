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

export interface SceneSnapshot {
    children: Object3D[];
    objects: ObjectSnapshot[];
    userData: Record<string, unknown>;
    selection: HistorySelection | null;
    gizmo: HistoryGizmoState | null;
    metadataOnly: boolean;
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
    if (!snapshot.metadataOnly) {
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
    root.userData = cloneValue(snapshot.userData);
    if (currentSelection && snapshot.selection) {
        currentSelection.groups = new Set(snapshot.selection.groups);
        currentSelection.objects = new Map(Array.from(snapshot.selection.objects, ([mesh, ids]) => [mesh, new Set(ids)]));
        currentSelection.primary = snapshot.selection.primary ? { ...snapshot.selection.primary } : null;
    }
    if (restoreGizmoState && snapshot.gizmo) restoreGizmoState(cloneValue(snapshot.gizmo));
    root.updateMatrixWorld(true);
}

export function recordSceneChange(root: Group, before: SceneSnapshot): void {
    const after = captureSceneState(root, before.metadataOnly);
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
