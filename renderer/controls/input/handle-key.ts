import {
    InstancedMesh,
    Mesh,
    Vector3,
    Matrix4,
    Quaternion,
    Group,
    Camera,
    Renderer,
    Object3D,
    Box3
} from 'three/webgpu';
import type { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { resetCustomPivot } from '../pivot/custom-pivot-remove';
import { removeShearFromSelection } from '../pivot/shear-remove';
import { focusCameraOnSelection } from './camera';
import { toggleBlockbenchScaleMode } from '../gizmo/blockbench-scale';
import { toggleShading } from '../../entityMaterial.js';
import type { SelectionState, SelectedItem } from '../selection/select';
import type { GroupData } from '../grouping/group';
import type { QueueItem } from '../vertex/vertex-swap';

// ─── Local types ──────────────────────────────────────────────────────────────

type PdeMesh = InstancedMesh | Mesh;

interface OrbitControlsLike {
    enabled: boolean;
    target: Vector3;
    screenSpacePanning: boolean;
    dispose(): void;
    update(): boolean;
}

interface PivotResetFlags {
    isCustomPivot: boolean;
    multiExplicitPivot: boolean;
    multiAnchorValid: boolean;
    multiAnchorInitialValid: boolean;
    multiAnchorInitialLocalValid: boolean;
    gizmoAnchorValid: boolean;
    selectionAnchorMode: 'default' | 'center';
}

// ─── Public interface ─────────────────────────────────────────────────────────

export interface HandleKeyState {
    isVertexMode: boolean;
    currentSpace: 'world' | 'local';
    pivotMode: string;
    isCustomPivot: boolean;
    isGizmoBusy: boolean;
    isPivotEditMode: boolean;
    previousGizmoMode: string;
    pivotEditPreviousPivotMode: string | null;
    multiSelectionExplicitPivot: boolean;
    multiSelectionOriginAnchorValid: boolean;
    multiSelectionOriginAnchorInitialValid: boolean;
    multiSelectionOriginAnchorInitialLocalValid: boolean;
    gizmoAnchorValid: boolean;
    selectionAnchorMode: 'default' | 'center';
    controls: OrbitControlsLike;
}

export interface HandleKeyParams {
    // -- Primitive state --
    state: HandleKeyState;

    // -- Object references (mutated in-place) --
    pivotOffset: Vector3;
    multiSelectionOriginAnchorPosition: Vector3;
    gizmoAnchorPosition: Vector3;
    previousHelperMatrix: Matrix4;
    currentSelection: SelectionState;
    selectedVertexKeys: Set<string>;
    vertexQueue: QueueItem[];
    dragInitialMatrix: Matrix4;
    dragInitialPosition: Vector3;
    dragInitialQuaternion: Quaternion;
    dragInitialScale: Vector3;
    loadedObjectGroup: Group;

    // -- Readonly references --
    camera: Camera;
    renderer: Renderer;
    getTransformControls(): TransformControls;
    getSelectionHelper(): Mesh;
    setExternalControls?: (c: OrbitControlsLike) => void;
    DEFAULT_GROUP_PIVOT: Vector3;

    // -- Selection / UI callbacks --
    updateHelperPosition(): void;
    updateSelectionOverlay(): void;
    hasAnySelection(): boolean;
    isMultiSelection(): boolean;
    getSingleSelectedGroupId(): string | null;
    getSelectedItems(): SelectedItem[];
    recomputePivotStateForSelection(): void;
    revertEphemeralPivotUndoIfAny(): void;

    // -- Selection manipulation callbacks --
    duplicateSelected(): void;
    resetSelectionAndDeselect(): void;
    deleteSelectedItems(): void;
    createGroup(): string | undefined;
    ungroupGroup(id: string): void;
    promoteVertexQueueBundleOnExit(): boolean;
    pushToVertexQueue(): void;
    replaceSelectionWithObjectsMap(
        meshToIds: Map<PdeMesh, Set<number>>,
        options?: { anchorMode?: string }
    ): void;
    replaceSelectionWithGroupsAndObjects(
        groupIds: Set<string>,
        meshToIds: Map<PdeMesh, Set<number>>,
        options?: { anchorMode?: string; preserveAnchors?: boolean }
    ): void;
    selectAllObjectsVisibleInScene(): Map<PdeMesh, Set<number>>;

    // -- Pivot callbacks --
    SelectionCenter(pivotMode: string, isCustomPivot: boolean, pivotOffset: Vector3): Vector3;
    getSelectionBoundingBox(): Box3;
    getSelectionCenterWorld(out?: Vector3): Vector3;
    resolveMultiAnchorInitialWorld(out?: Vector3): Vector3 | null;
    setMultiAnchorInitial(worldPos: Vector3): void;

    // -- Group callbacks --
    getGroupChain(id: string): string[];
    getObjectToGroup(): Map<string, string>;
    getGroupKey(mesh: Object3D, instanceId: number): string;
    getGroups(): Map<string, GroupData>;
    getGroupOriginWorld(id: string, out?: Vector3): Vector3;
    getGroupWorldMatrix(g: GroupData, out?: Matrix4): Matrix4;
    shouldUseGroupPivot(g: GroupData): boolean;
    normalizePivotToVector3(pivot: Vector3 | undefined, out?: Vector3): Vector3 | null;

    // -- Instance / overlay callbacks --
    getInstanceCount(mesh: PdeMesh): number;
    isInstanceValid(mesh: PdeMesh, instanceId: number): boolean;
    getDisplayType(mesh: PdeMesh, instanceId?: number): string | undefined;
    getInstanceLocalBoxMin(mesh: PdeMesh, instanceId: number | undefined, out: Vector3): Vector3 | null;
    getInstanceWorldMatrixForOrigin(mesh: PdeMesh, instanceId: number | undefined, out: Matrix4): Matrix4;
    isItemDisplayHatEnabled(mesh: PdeMesh, instanceId?: number): boolean;
    prepareMultiSelectionDrag(selection: SelectionState): void;
}

// ─── Main export ──────────────────────────────────────────────────────────────

export function initHandleKey(p: HandleKeyParams): void {

    // ── Inner key handler ────────────────────────────────────────────────────

    const handleKeyPress = (key: string): void => {
        const resetHelperRotationForWorldSpace = () => {
            if (p.state.currentSpace !== 'world') return;
            const items = p.getSelectedItems();
            if (items.length > 0) {
                p.getSelectionHelper().quaternion.set(0, 0, 0, 1);
                p.getSelectionHelper().updateMatrixWorld();
                p.previousHelperMatrix.copy(p.getSelectionHelper().matrixWorld);
            }
        };

        switch (key) {
            case 'v':
                p.state.isVertexMode = !p.state.isVertexMode;
                console.log(p.state.isVertexMode ? 'Vertex mode activated' : 'Vertex mode deactivated');

                if (p.state.isVertexMode) {
                    p.vertexQueue.length = 0;
                    p.selectedVertexKeys.clear();
                    p.getTransformControls().detach();
                } else {
                    p.promoteVertexQueueBundleOnExit();
                    p.vertexQueue.length = 0;
                    p.selectedVertexKeys.clear();
                    p.recomputePivotStateForSelection();
                    p.updateHelperPosition();
                }
                p.updateSelectionOverlay();
                break;

            case 't':
                p.getTransformControls().setMode('translate');
                resetHelperRotationForWorldSpace();
                break;
            case 'r':
                p.getTransformControls().setMode('rotate');
                resetHelperRotationForWorldSpace();
                break;
            case 's':
                p.getTransformControls().setMode('scale');
                resetHelperRotationForWorldSpace();
                break;
            case 'd':
                p.duplicateSelected();
                break;
            case 'x': {
                const newSpace = p.state.currentSpace === 'world' ? 'local' : 'world';
                p.state.currentSpace = newSpace;
                p.getTransformControls().setSpace(newSpace);
                p.updateHelperPosition();
                p.updateSelectionOverlay();
                console.log('TransformControls Space:', newSpace);
                break;
            }
            case 'z': {
                const oldPos = p.getSelectionHelper().position.clone();
                const oldKey = `CENTER_${oldPos.x.toFixed(4)}_${oldPos.y.toFixed(4)}_${oldPos.z.toFixed(4)}`;
                const wasCenterSelected = p.selectedVertexKeys.has(oldKey);

                if (p.state.pivotMode === 'center') {
                    const prevPos = p.getSelectionHelper().position.clone();
                    p.updateHelperPosition();
                    if (prevPos.distanceTo(p.getSelectionHelper().position) < 0.001) {
                        p.state.pivotMode = 'origin';
                        p.recomputePivotStateForSelection();
                        p.updateHelperPosition();
                    }
                } else {
                    p.state.pivotMode = 'center';
                    p.recomputePivotStateForSelection();
                    p.updateHelperPosition();
                }

                if (wasCenterSelected) {
                    p.selectedVertexKeys.delete(oldKey);
                    const newPos = p.getSelectionHelper().position;
                    const newKey = `CENTER_${newPos.x.toFixed(4)}_${newPos.y.toFixed(4)}_${newPos.z.toFixed(4)}`;
                    p.selectedVertexKeys.add(newKey);
                }

                p.updateSelectionOverlay();
                console.log('Pivot Mode:', p.state.pivotMode);
                break;
            }
            case 'q': {
                const items = p.getSelectedItems();
                if (items.length > 0) {
                    removeShearFromSelection(
                        items,
                        p.getSelectionHelper(),
                        p.currentSelection,
                        p.loadedObjectGroup,
                        p.state.pivotMode,
                        p.state.isCustomPivot,
                        p.pivotOffset,
                        {
                            SelectionCenter: p.SelectionCenter,
                            updateHelperPosition: p.updateHelperPosition,
                            updateSelectionOverlay: p.updateSelectionOverlay
                        }
                    );
                }
                break;
            }
            case 'b': {
                toggleBlockbenchScaleMode();
                break;
            }
            case 'l':
                console.log(toggleShading() ? 'Shading on' : 'Shading off');
                break;
            case 'g': {
                const groupCount = p.currentSelection.groups ? p.currentSelection.groups.size : 0;
                const hasObjects = p.currentSelection.objects && p.currentSelection.objects.size > 0;

                if (groupCount === 1 && !hasObjects) {
                    const gid = Array.from(p.currentSelection.groups)[0];
                    if (gid) p.ungroupGroup(gid);
                    p.resetSelectionAndDeselect();
                    break;
                }

                const items = p.getSelectedItems();
                if (items.length > 0) p.createGroup();
                break;
            }
        }
    };

    // ── keydown ──────────────────────────────────────────────────────────────

    window.addEventListener('keydown', (event: KeyboardEvent) => {
        if ((event.target as HTMLElement).tagName === 'INPUT' || (event.target as HTMLElement).tagName === 'TEXTAREA') return;

        if (event.key.toLowerCase() === 'f') {
            event.preventDefault();
            focusCameraOnSelection(
                p.camera,
                p.state.controls,
                p.hasAnySelection(),
                p.getSelectionBoundingBox,
                (out) => p.getSelectionCenterWorld(out)
            );
            return;
        }

        if (event.key === 'Delete' || event.key === 'Backspace') {
            event.preventDefault();
            p.deleteSelectedItems();
            return;
        }

        if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'a') {
            event.preventDefault();
            const all = p.selectAllObjectsVisibleInScene();

            let totalCount = 0;
            for (const [, ids] of all) totalCount += ids.size;

            const mode = (totalCount > 1) ? 'center' : 'default';
            p.replaceSelectionWithObjectsMap(all, { anchorMode: mode });
            return;
        }

        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
            event.preventDefault();
            const groupIds = new Set<string>();
            const meshToIds = new Map<PdeMesh, Set<number>>();

            if (p.loadedObjectGroup) {
                const objectToGroup = p.getObjectToGroup();
                p.loadedObjectGroup.traverse((obj: Object3D) => {
                    if (!obj || !(obj as InstancedMesh).isInstancedMesh) return;
                    if (obj.visible === false) return;

                    const instanceCount = p.getInstanceCount(obj as PdeMesh);
                    if (instanceCount <= 0) return;

                    for (let instanceId = 0; instanceId < instanceCount; instanceId++) {
                        if (!p.isInstanceValid(obj as PdeMesh, instanceId)) continue;

                        const key = p.getGroupKey(obj, instanceId);
                        const immediateGroupId = objectToGroup.get(key);
                        if (immediateGroupId) {
                            const chain = p.getGroupChain(immediateGroupId);
                            const root = chain && chain.length > 0 ? chain[0] : immediateGroupId;
                            if (root) groupIds.add(root);
                            continue;
                        }

                        let set = meshToIds.get(obj as PdeMesh);
                        if (!set) {
                            set = new Set();
                            meshToIds.set(obj as PdeMesh, set);
                        }
                        set.add(instanceId);
                    }
                });
            }

            let objectCount = 0;
            for (const [, ids] of meshToIds) objectCount += ids.size;

            const totalCount = groupIds.size + objectCount;
            const mode = (totalCount > 1) ? 'center' : 'default';

            p.replaceSelectionWithGroupsAndObjects(groupIds, meshToIds, { anchorMode: mode });
            return;
        }

        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'g') {
            event.preventDefault();
            const hasGroups = p.currentSelection.groups && p.currentSelection.groups.size > 0;
            if (hasGroups) {
                const ids = Array.from(p.currentSelection.groups);
                ids.sort((a, b) => p.getGroupChain(a).length - p.getGroupChain(b).length).reverse();
                ids.forEach(id => p.ungroupGroup(id));
                p.resetSelectionAndDeselect();
            }
            return;
        }

        if (event.key === 'Alt') {
            event.preventDefault();
            if (!p.state.isPivotEditMode) {
                p.state.isPivotEditMode = true;
                p.state.previousGizmoMode = p.getTransformControls().mode;
                p.state.pivotEditPreviousPivotMode = p.state.pivotMode;
                p.getTransformControls().setMode('translate');
            }
        }

        if (event.altKey && event.ctrlKey) {
            if (event.key === 'Alt' || event.key === 'Control') {
                event.preventDefault();

                const _pivotResetFlags: PivotResetFlags = {
                    isCustomPivot:               p.state.isCustomPivot,
                    multiExplicitPivot:          p.state.multiSelectionExplicitPivot,
                    multiAnchorValid:             p.state.multiSelectionOriginAnchorValid,
                    multiAnchorInitialValid:      p.state.multiSelectionOriginAnchorInitialValid,
                    multiAnchorInitialLocalValid: p.state.multiSelectionOriginAnchorInitialLocalValid,
                    gizmoAnchorValid:             p.state.gizmoAnchorValid,
                    selectionAnchorMode:          p.state.selectionAnchorMode,
                };

                resetCustomPivot(
                    p.currentSelection,
                    p.pivotOffset,
                    p.multiSelectionOriginAnchorPosition,
                    p.gizmoAnchorPosition,
                    _pivotResetFlags,
                    {
                        isMultiSelection:               p.isMultiSelection,
                        revertEphemeralPivotUndoIfAny:  p.revertEphemeralPivotUndoIfAny,
                        getGroups:                       p.getGroups,
                        DEFAULT_GROUP_PIVOT:             p.DEFAULT_GROUP_PIVOT,
                    }
                );

                p.state.isCustomPivot = _pivotResetFlags.isCustomPivot;
                p.state.multiSelectionExplicitPivot = _pivotResetFlags.multiExplicitPivot;
                p.state.multiSelectionOriginAnchorValid = _pivotResetFlags.multiAnchorValid;
                p.state.multiSelectionOriginAnchorInitialValid = _pivotResetFlags.multiAnchorInitialValid;
                p.state.multiSelectionOriginAnchorInitialLocalValid = _pivotResetFlags.multiAnchorInitialLocalValid;
                p.state.gizmoAnchorValid = _pivotResetFlags.gizmoAnchorValid;
                p.state.selectionAnchorMode = _pivotResetFlags.selectionAnchorMode;

                p.recomputePivotStateForSelection();
                p.updateHelperPosition();

                if (p.getTransformControls().dragging) {
                    p.prepareMultiSelectionDrag(p.currentSelection);
                    p.dragInitialMatrix.copy(p.getSelectionHelper().matrixWorld);
                    p.dragInitialPosition.copy(p.getSelectionHelper().position);
                    p.dragInitialQuaternion.copy(p.getSelectionHelper().quaternion);
                    p.dragInitialScale.copy(p.getSelectionHelper().scale);
                }

                if (p.state.isVertexMode) p.pushToVertexQueue();
                p.updateSelectionOverlay();

                console.log('Pivot reset to origin');
            }
        }

        if (p.state.isGizmoBusy) return;
        const key = event.key.toLowerCase();
        const keysToHandle = ['t', 'r', 's', 'x', 'z', 'q', 'b', 'g', 'd', 'v', 'l'];
        if (p.getTransformControls().dragging && keysToHandle.includes(key)) {
            p.state.isGizmoBusy = true;
            const attachedObject = p.getTransformControls().object;
            p.getTransformControls().pointerUp({ button: 0 } as PointerEvent);
            const currentControls = p.state.controls;
            const oldTarget = currentControls.target.clone();
            currentControls.dispose();
            const newControls = new (currentControls.constructor as any)(p.camera, (p.renderer as any).domElement);
            newControls.screenSpacePanning = true;
            newControls.target.copy(oldTarget);
            newControls.update();
            if (p.setExternalControls) p.setExternalControls(newControls);
            p.state.controls = newControls;
            setTimeout(() => {
                if (attachedObject) {
                    p.getTransformControls().detach();
                    p.getTransformControls().attach(attachedObject);
                }
                handleKeyPress(key);
                p.state.isGizmoBusy = false;
            }, 0);
            return;
        }
        if (keysToHandle.includes(key)) {
            p.state.isGizmoBusy = true;
            handleKeyPress(key);
            setTimeout(() => { p.state.isGizmoBusy = false; }, 50);
        }
    });

    // ── keyup ────────────────────────────────────────────────────────────────

    window.addEventListener('keyup', (event: KeyboardEvent) => {
        if (event.key === 'Alt') {
            if (p.state.isPivotEditMode) {
                if (p.getTransformControls().dragging) {
                    p.getSelectionHelper().updateMatrixWorld();
                    p.previousHelperMatrix.copy(p.getSelectionHelper().matrixWorld);
                }

                p.state.isPivotEditMode = false;
                p.getTransformControls().setMode(p.state.previousGizmoMode);
                p.state.pivotEditPreviousPivotMode = null;

                if (p.getTransformControls().dragging) {
                    p.prepareMultiSelectionDrag(p.currentSelection);
                    p.dragInitialMatrix.copy(p.getSelectionHelper().matrixWorld);
                    p.dragInitialPosition.copy(p.getSelectionHelper().position);
                    p.dragInitialQuaternion.copy(p.getSelectionHelper().quaternion);
                    p.dragInitialScale.copy(p.getSelectionHelper().scale);
                    p.updateSelectionOverlay();
                }
            }
        }
    });

    // ── blur / visibilitychange / focus ──────────────────────────────────────

    const clearAltState = () => {
        if (p.state.isPivotEditMode) {
            p.state.isPivotEditMode = false;
            try {
                p.getTransformControls().setMode(p.state.previousGizmoMode);
            } catch (err) {
                console.warn('Failed to restore transformControls mode on blur/visibility change', err);
            }
        }
        p.state.isGizmoBusy = false;
        try {
            if (p.getTransformControls() && p.getTransformControls().dragging) {
                p.getTransformControls().pointerUp({ button: 0 } as PointerEvent);
            }
        } catch (_err) {}
    };

    const resetOrbitControls = () => {
        const currentControls = p.state.controls;
        if (currentControls && p.setExternalControls) {
            const oldTarget = currentControls.target.clone();
            const oldScreenSpacePanning = currentControls.screenSpacePanning;
            currentControls.dispose();

            const newControls = new (currentControls.constructor as any)(p.camera, (p.renderer as any).domElement);
            newControls.screenSpacePanning = oldScreenSpacePanning;
            newControls.target.copy(oldTarget);
            newControls.update();

            p.setExternalControls(newControls);
            p.state.controls = newControls;
        }
    };

    window.addEventListener('blur', () => {
        clearAltState();
        resetOrbitControls();
    });
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            clearAltState();
            resetOrbitControls();
        }
    });
    window.addEventListener('focus', () => {
        clearAltState();
    });
}
