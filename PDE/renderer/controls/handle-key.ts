import {
    InstancedMesh,
    BatchedMesh,
    Mesh,
    Vector3,
    Matrix4,
    Quaternion,
    Group,
    PerspectiveCamera,
    Renderer,
    Object3D,
    Box3
} from 'three/webgpu';
import type { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { resetCustomPivot } from './custom-pivot-remove';
import { removeShearFromSelection } from './shear-remove';
import { focusCameraOnSelection } from './camera';
import { toggleBlockbenchScaleMode } from './blockbench-scale';
import type { SelectionState, SelectedItem } from './select';
import type { GroupData } from './group';
import type { QueueItem } from './vertex-swap';

// ─── Local types ──────────────────────────────────────────────────────────────

type PdeMesh = InstancedMesh | BatchedMesh | Mesh;

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

export interface HandleKeyParams {
    // -- Primitive state (getter/setter) --
    getIsVertexMode(): boolean;
    setIsVertexMode(v: boolean): void;
    getCurrentSpace(): 'world' | 'local';
    setCurrentSpace(v: 'world' | 'local'): void;
    getPivotMode(): string;
    setPivotMode(v: string): void;
    getIsCustomPivot(): boolean;
    setIsCustomPivot(v: boolean): void;
    getIsGizmoBusy(): boolean;
    setIsGizmoBusy(v: boolean): void;
    getIsPivotEditMode(): boolean;
    setIsPivotEditMode(v: boolean): void;
    getPreviousGizmoMode(): string;
    setPreviousGizmoMode(v: string): void;
    getPivotEditPreviousPivotMode(): string | null;
    setPivotEditPreviousPivotMode(v: string | null): void;
    getMultiSelectionExplicitPivot(): boolean;
    setMultiSelectionExplicitPivot(v: boolean): void;
    getMultiSelectionOriginAnchorValid(): boolean;
    setMultiSelectionOriginAnchorValid(v: boolean): void;
    getMultiSelectionOriginAnchorInitialValid(): boolean;
    setMultiSelectionOriginAnchorInitialValid(v: boolean): void;
    getMultiSelectionOriginAnchorInitialLocalValid(): boolean;
    setMultiSelectionOriginAnchorInitialLocalValid(v: boolean): void;
    getGizmoAnchorValid(): boolean;
    setGizmoAnchorValid(v: boolean): void;
    getSelectionAnchorMode(): 'default' | 'center';
    setSelectionAnchorMode(v: 'default' | 'center'): void;
    getControls(): OrbitControlsLike;
    setInternalControls(v: OrbitControlsLike): void;

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
    camera: PerspectiveCamera;
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
        const normalizeSelectionStateForVertexEntry = () => {
            if (!p.hasAnySelection()) return;

            // Entering vertex mode should match a fresh reselect baseline.
            p.revertEphemeralPivotUndoIfAny();

            p.setMultiSelectionExplicitPivot(false);
            p.setMultiSelectionOriginAnchorValid(false);
            p.setMultiSelectionOriginAnchorInitialValid(false);
            p.setMultiSelectionOriginAnchorInitialLocalValid(false);
            p.setGizmoAnchorValid(false);

            p.multiSelectionOriginAnchorPosition.set(0, 0, 0);
            p.gizmoAnchorPosition.set(0, 0, 0);

            p.setSelectionAnchorMode('default');
            p.pivotOffset.set(0, 0, 0);
            p.setIsCustomPivot(false);

            p.recomputePivotStateForSelection();
            p.updateHelperPosition();
        };

        const resetHelperRotationForWorldSpace = () => {
            if (p.getCurrentSpace() !== 'world') return;
            const items = p.getSelectedItems();
            if (items.length > 0) {
                p.getSelectionHelper().quaternion.set(0, 0, 0, 1);
                p.getSelectionHelper().updateMatrixWorld();
                p.previousHelperMatrix.copy(p.getSelectionHelper().matrixWorld);
            }
        };

        switch (key) {
            case 'v':
                const nextVertexMode = !p.getIsVertexMode();
                p.setIsVertexMode(nextVertexMode);
                console.log(p.getIsVertexMode() ? 'Vertex mode activated' : 'Vertex mode deactivated');

                if (p.getIsVertexMode()) {
                    normalizeSelectionStateForVertexEntry();
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
                const newSpace = p.getCurrentSpace() === 'world' ? 'local' : 'world';
                p.setCurrentSpace(newSpace);
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

                if (p.getPivotMode() === 'center') {
                    const prevPos = p.getSelectionHelper().position.clone();
                    p.updateHelperPosition();
                    if (prevPos.distanceTo(p.getSelectionHelper().position) < 0.001) {
                        p.setPivotMode('origin');
                        p.recomputePivotStateForSelection();
                        p.updateHelperPosition();
                    }
                } else {
                    p.setPivotMode('center');
                    p.recomputePivotStateForSelection();
                    // center 모드 진입 시 origin 앵커 초기값 무효화:
                    // 이후 이동 → origin 복귀 시 Block 1이 현재 primary 위치로 재캡처하게 함.
                    // (초기값이 살아있으면 _resolveMultiAnchorInitialWorld가 이동 전 위치를 반환)
                    // 단, explicit multi-selection pivot이 있는 경우는 앵커를 보존:
                    //   보존해야 _resolveMultiAnchorInitialWorld가 커스텀 피벗 위치로 복귀 가능.
                    //   explicit pivot은 local 좌표 추적이므로 이동 후에도 올바른 world 위치 반환.
                    if (p.isMultiSelection() && !p.getMultiSelectionExplicitPivot()) {
                        p.setMultiSelectionOriginAnchorValid(false);
                        p.setMultiSelectionOriginAnchorInitialValid(false);
                        p.setMultiSelectionOriginAnchorInitialLocalValid(false);
                    }
                    p.updateHelperPosition();
                }

                if (wasCenterSelected) {
                    p.selectedVertexKeys.delete(oldKey);
                    const newPos = p.getSelectionHelper().position;
                    const newKey = `CENTER_${newPos.x.toFixed(4)}_${newPos.y.toFixed(4)}_${newPos.z.toFixed(4)}`;
                    p.selectedVertexKeys.add(newKey);
                }

                p.updateSelectionOverlay();
                console.log('Pivot Mode:', p.getPivotMode());
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
                        p.getPivotMode(),
                        p.getIsCustomPivot(),
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
                p.getControls(),
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
                    if (!obj || (!(obj as InstancedMesh).isInstancedMesh && !(obj as BatchedMesh).isBatchedMesh)) return;
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
            if (!p.getIsPivotEditMode()) {
                p.setIsPivotEditMode(true);
                p.setPreviousGizmoMode(p.getTransformControls().mode);
                p.setPivotEditPreviousPivotMode(p.getPivotMode());
                p.getTransformControls().setMode('translate');
            }
        }

        if (event.altKey && event.ctrlKey) {
            if (event.key === 'Alt' || event.key === 'Control') {
                event.preventDefault();

                const _pivotResetFlags: PivotResetFlags = {
                    isCustomPivot:               p.getIsCustomPivot(),
                    multiExplicitPivot:          p.getMultiSelectionExplicitPivot(),
                    multiAnchorValid:             p.getMultiSelectionOriginAnchorValid(),
                    multiAnchorInitialValid:      p.getMultiSelectionOriginAnchorInitialValid(),
                    multiAnchorInitialLocalValid: p.getMultiSelectionOriginAnchorInitialLocalValid(),
                    gizmoAnchorValid:             p.getGizmoAnchorValid(),
                    selectionAnchorMode:          p.getSelectionAnchorMode(),
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

                p.setIsCustomPivot(_pivotResetFlags.isCustomPivot);
                p.setMultiSelectionExplicitPivot(_pivotResetFlags.multiExplicitPivot);
                p.setMultiSelectionOriginAnchorValid(_pivotResetFlags.multiAnchorValid);
                p.setMultiSelectionOriginAnchorInitialValid(_pivotResetFlags.multiAnchorInitialValid);
                p.setMultiSelectionOriginAnchorInitialLocalValid(_pivotResetFlags.multiAnchorInitialLocalValid);
                p.setGizmoAnchorValid(_pivotResetFlags.gizmoAnchorValid);
                p.setSelectionAnchorMode(_pivotResetFlags.selectionAnchorMode);

                p.recomputePivotStateForSelection();
                p.updateHelperPosition();

                if (p.getTransformControls().dragging) {
                    p.prepareMultiSelectionDrag(p.currentSelection);
                    p.dragInitialMatrix.copy(p.getSelectionHelper().matrixWorld);
                    p.dragInitialPosition.copy(p.getSelectionHelper().position);
                    p.dragInitialQuaternion.copy(p.getSelectionHelper().quaternion);
                    p.dragInitialScale.copy(p.getSelectionHelper().scale);
                }

                if (p.getIsVertexMode()) p.pushToVertexQueue();
                p.updateSelectionOverlay();

                console.log('Pivot reset to origin');
            }
        }

        if (p.getIsGizmoBusy()) return;
        const key = event.key.toLowerCase();
        const keysToHandle = ['t', 'r', 's', 'x', 'z', 'q', 'b', 'g', 'd', 'v'];
        if (p.getTransformControls().dragging && keysToHandle.includes(key)) {
            p.setIsGizmoBusy(true);
            const attachedObject = p.getTransformControls().object;
            p.getTransformControls().pointerUp({ button: 0 } as PointerEvent);
            const currentControls = p.getControls();
            const oldTarget = currentControls.target.clone();
            currentControls.dispose();
            const newControls = new (currentControls.constructor as any)(p.camera, (p.renderer as any).domElement);
            newControls.screenSpacePanning = true;
            newControls.target.copy(oldTarget);
            newControls.update();
            if (p.setExternalControls) p.setExternalControls(newControls);
            p.setInternalControls(newControls);
            setTimeout(() => {
                if (attachedObject) {
                    p.getTransformControls().detach();
                    p.getTransformControls().attach(attachedObject);
                }
                handleKeyPress(key);
                p.setIsGizmoBusy(false);
            }, 0);
            return;
        }
        if (keysToHandle.includes(key)) {
            p.setIsGizmoBusy(true);
            handleKeyPress(key);
            setTimeout(() => { p.setIsGizmoBusy(false); }, 50);
        }
    });

    // ── keyup ────────────────────────────────────────────────────────────────

    window.addEventListener('keyup', (event: KeyboardEvent) => {
        if (event.key === 'Alt') {
            if (p.getIsPivotEditMode()) {
                if (p.getTransformControls().dragging) {
                    p.getSelectionHelper().updateMatrixWorld();
                    p.previousHelperMatrix.copy(p.getSelectionHelper().matrixWorld);
                }

                p.setIsPivotEditMode(false);
                p.getTransformControls().setMode(p.getPreviousGizmoMode());
                p.setPivotEditPreviousPivotMode(null);

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
        if (p.getIsPivotEditMode()) {
            p.setIsPivotEditMode(false);
            try {
                p.getTransformControls().setMode(p.getPreviousGizmoMode());
            } catch (err) {
                console.warn('Failed to restore transformControls mode on blur/visibility change', err);
            }
        }
        p.setIsGizmoBusy(false);
        try {
            if (p.getTransformControls() && p.getTransformControls().dragging) {
                p.getTransformControls().pointerUp({ button: 0 } as PointerEvent);
            }
        } catch (_err) {}
    };

    const resetOrbitControls = () => {
        const currentControls = p.getControls();
        if (currentControls && p.setExternalControls) {
            const oldTarget = currentControls.target.clone();
            const oldScreenSpacePanning = currentControls.screenSpacePanning;
            currentControls.dispose();

            const newControls = new (currentControls.constructor as any)(p.camera, (p.renderer as any).domElement);
            newControls.screenSpacePanning = oldScreenSpacePanning;
            newControls.target.copy(oldTarget);
            newControls.update();

            p.setExternalControls(newControls);
            p.setInternalControls(newControls);
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
