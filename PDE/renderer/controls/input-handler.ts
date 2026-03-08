import * as THREE from 'three/webgpu';
import type { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import * as VertexState from './vertex-state';
import * as Overlay from './overlay';
import * as Select from './select';
import { resetCustomPivot } from './custom-pivot-remove';
import { removeShearFromSelection } from './shear-remove';
import { focusCameraOnSelection } from './camera';
import { initDrag } from './drag';
import type { DragInterface } from './drag';
import { processVertexSnap } from './vertex-translate';
import { processVertexRotate } from './vertex-rotate';
import { processVertexScale } from './vertex-scale';
import { toggleBlockbenchScaleMode } from './blockbench-scale';
import type { PdeMesh, OrbitControlsLike, GizmoLines, GizmoState, PivotResetFlags } from './gizmo';

const { selectedVertexKeys, vertexQueue } = VertexState;

interface InputHandlerParams {
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    renderer: THREE.Renderer;
    controls: OrbitControlsLike;
    loadedObjectGroup: THREE.Group;
    transformControls: TransformControls;
    selectionHelper: THREE.Mesh;
    gizmoLines: GizmoLines;
    setControls: (c: OrbitControlsLike) => void;
    // States
    isVertexMode: () => boolean;
    setVertexMode: (v: boolean) => void;
    currentSpace: () => 'world' | 'local';
    setCurrentSpace: (s: 'world' | 'local') => void;
    pivotMode: () => string;
    setPivotMode: (m: string) => void;
    isPivotEditMode: () => boolean;
    setIsPivotEditMode: (v: boolean) => void;
    isGizmoBusy: () => boolean;
    setIsGizmoBusy: (v: boolean) => void;
    isUniformScale: () => boolean;
    setIsUniformScale: (v: boolean) => void;
    pivotOffset: THREE.Vector3;
    isCustomPivot: () => boolean;
    setIsCustomPivot: (v: boolean) => void;
    // Functions
    updateHelperPosition: () => void;
    updateSelectionOverlay: () => void;
    resetSelectionAndDeselect: () => void;
    duplicateSelected: () => void;
    deleteSelectedItems: () => void;
    createGroup: () => string | undefined;
    ungroupGroup: (id: string) => void;
    SelectionCenter: (pm: string, icp: boolean, po: THREE.Vector3) => THREE.Vector3;
    _pushToVertexQueue: () => void;
    _promoteVertexQueueBundleOnExit: () => boolean;
    _replaceSelectionWithObjectsMap: (m: Map<PdeMesh, Set<number>>, opt?: { anchorMode?: string }) => void;
    _replaceSelectionWithGroupsAndObjects: (g: Set<string>, m: Map<PdeMesh, Set<number>>, opt?: { anchorMode?: string; preserveAnchors?: boolean }) => void;
    _selectAllObjectsVisibleInScene: () => Map<PdeMesh, Set<number>>;
    _getSingleSelectedGroupId: () => string | null;
    _getSelectionCenterWorld: (out?: THREE.Vector3) => THREE.Vector3;
    _recomputePivotStateForSelection: () => void;
    _revertEphemeralPivotUndoIfAny: () => void;
    _isMultiSelection: () => boolean;
    _getSelectionBoundingBox: () => THREE.Box3 | null;
    _clearGizmoAnchor: () => void;
    _setSelectionAnchorMode: (mode: 'default' | 'center') => void;
    _commitSelectionChange: () => void;
    _getPrimaryWorldMatrix: (out?: THREE.Matrix4) => THREE.Matrix4 | null;
    _getGizmoState: () => GizmoState;
    _setGizmoState: (updates: Partial<GizmoState>) => void;
    _getGroups: () => any;
    _getGroupOriginWorld: (id: string, out?: THREE.Vector3) => THREE.Vector3;
    _shouldUseGroupPivot: (g: any) => boolean;
    _normalizePivotToVector3: (p: any, out?: THREE.Vector3) => THREE.Vector3 | null;
    _getGroupWorldMatrix: (g: any, out?: THREE.Matrix4) => THREE.Matrix4;
    getGroupWorldMatrixWithFallback: (id: string, out?: THREE.Matrix4) => THREE.Matrix4;
    _getDisplayType: (m: THREE.Object3D, id: number) => string;
    _getInstanceLocalBoxMin: (m: THREE.Object3D, id: number, out?: THREE.Vector3) => THREE.Vector3 | null;
    _getInstanceWorldMatrixForOrigin: (m: THREE.Object3D, id: number, out?: THREE.Matrix4) => THREE.Matrix4;
    _isItemDisplayHatEnabled: (m: THREE.Object3D, id: number) => boolean;
    _DEFAULT_GROUP_PIVOT: THREE.Vector3;
    _resolveMultiAnchorInitialWorld: (out?: THREE.Vector3) => THREE.Vector3 | null;
    _setMultiAnchorInitial: (worldPos: THREE.Vector3) => void;
    _getObjectToGroup: () => Map<string, string>;
    _getGroupKey: (m: THREE.Object3D, id: number) => string;
    _getGroupChain: (id: string) => string[];
    _getInstanceCount: (m: PdeMesh) => number;
    _isInstanceValid: (m: PdeMesh, id: number) => boolean;
    _getSelectionCallbacks: () => any;
    // Shared Anchor State
    _getAnchorState: () => {
        multiExplicitPivot: boolean;
        multiAnchorValid: boolean;
        multiAnchorInitialValid: boolean;
        multiAnchorInitialLocalValid: boolean;
        gizmoAnchorValid: boolean;
        selectionAnchorMode: 'default' | 'center';
        gizmoAnchorPosition: THREE.Vector3;
        multiOriginAnchorPosition: THREE.Vector3;
    };
    _setAnchorState: (updates: any) => void;
    // Private shared for drag
    _draggingState: {
        previousGizmoMode: string;
        _pivotEditPreviousPivotMode: string | null;
        dragStartPivotBaseWorld: THREE.Vector3;
    };
}

export function initInputHandler(params: InputHandlerParams) {
    const {
        camera, renderer, loadedObjectGroup, transformControls, selectionHelper, gizmoLines,
        isVertexMode, setVertexMode, currentSpace, setCurrentSpace, pivotMode, setPivotMode,
        isPivotEditMode, setIsPivotEditMode, isGizmoBusy, setIsGizmoBusy,
        setIsUniformScale, pivotOffset, isCustomPivot, setIsCustomPivot,
        updateHelperPosition, updateSelectionOverlay, resetSelectionAndDeselect,
        duplicateSelected, deleteSelectedItems, createGroup, ungroupGroup, SelectionCenter,
        _pushToVertexQueue, _promoteVertexQueueBundleOnExit, _replaceSelectionWithObjectsMap,
        _replaceSelectionWithGroupsAndObjects, _selectAllObjectsVisibleInScene, _getSingleSelectedGroupId,
        _getSelectionCenterWorld, _recomputePivotStateForSelection, _revertEphemeralPivotUndoIfAny,
        _isMultiSelection, _getSelectionBoundingBox, _clearGizmoAnchor, _setSelectionAnchorMode,
        _getGizmoState, _setGizmoState, _getGroups,
        _getGroupOriginWorld, _shouldUseGroupPivot, _normalizePivotToVector3, _getGroupWorldMatrix,
        _getDisplayType, _getInstanceLocalBoxMin, _getInstanceWorldMatrixForOrigin,
        _isItemDisplayHatEnabled, _DEFAULT_GROUP_PIVOT, _resolveMultiAnchorInitialWorld,
        _setMultiAnchorInitial, _getObjectToGroup, _getGroupKey, _getGroupChain, _getInstanceCount,
        _isInstanceValid, _getSelectionCallbacks, _getAnchorState, _setAnchorState, _draggingState
    } = params;

    let { controls } = params;

    const mouseInput = new THREE.Vector2();
    let detectedAnchorDirections: { x: boolean | null; y: boolean | null; z: boolean | null } = { x: null, y: null, z: null };

    // ── Gizmo Axis Detection ──────────────────────────────────────────────

    const raycaster = new THREE.Raycaster();
    raycaster.layers.enable(2);
    const mouse = new THREE.Vector2();
    let mouseDownPos: { x: number; y: number } | null = null;
    const cameraMatrixOnPointerDown = new THREE.Matrix4();

    renderer.domElement.addEventListener('pointerdown', (event: PointerEvent) => {
        const rect = renderer.domElement.getBoundingClientRect();
        mouseInput.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        mouseInput.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

        detectedAnchorDirections = { x: null, y: null, z: null };

        if (!transformControls.dragging) {
            raycaster.setFromCamera(mouseInput, camera);
            const gizmo = transformControls.getHelper();
            const intersects = raycaster.intersectObject(gizmo, true);

            if (intersects.length > 0) {
                const object = intersects[0].object;
                if (object.name === 'XYZ') {
                    setIsUniformScale(true);
                } else {
                    setIsUniformScale(false);
                    const check = (axis: string): boolean | null => {
                        if (gizmoLines[axis as keyof GizmoLines].negative.includes(object as THREE.Mesh)) return false;
                        if (gizmoLines[axis as keyof GizmoLines].original.includes(object as THREE.Mesh)) return true;
                        return null;
                    };
                    detectedAnchorDirections.x = check('X');
                    detectedAnchorDirections.y = check('Y');
                    detectedAnchorDirections.z = check('Z');
                }
            }
        }
    }, true);

    // ── Shortcut Key Binding Logic ─────────────────────────────────────────

    const handleKeyPress = (key: string): void => {
        const resetHelperRotationForWorldSpace = () => {
            if (currentSpace() !== 'world') return;
            const items = Select.getSelectedItems();
            if (items.length > 0) {
                selectionHelper.quaternion.set(0, 0, 0, 1);
                selectionHelper.updateMatrixWorld();
                // No access to previousHelperMatrix here, but it's updated in gizmo.ts's transformControls change listener
            }
        };

        switch (key) {
            case 'v':
                const newMode = !isVertexMode();
                setVertexMode(newMode);
                console.log(newMode ? 'Vertex mode activated' : 'Vertex mode deactivated');

                if (newMode) {
                    transformControls.detach();
                } else {
                    _promoteVertexQueueBundleOnExit();
                    VertexState.clearVertexState();
                    updateHelperPosition();
                }
                updateSelectionOverlay();
                break;

            case 't':
                transformControls.setMode('translate');
                resetHelperRotationForWorldSpace();
                break;
            case 'r':
                transformControls.setMode('rotate');
                resetHelperRotationForWorldSpace();
                break;
            case 's':
                transformControls.setMode('scale');
                resetHelperRotationForWorldSpace();
                break;
            case 'd':
                duplicateSelected();
                break;
            case 'x': {
                const newSpace = currentSpace() === 'world' ? 'local' : 'world';
                setCurrentSpace(newSpace);
                transformControls.setSpace(newSpace);
                updateHelperPosition();
                updateSelectionOverlay();
                console.log('TransformControls Space:', newSpace);
                break;
            }
            case 'z': {
                const oldPos = selectionHelper.position.clone();
                const oldKey = `CENTER_${oldPos.x.toFixed(4)}_${oldPos.y.toFixed(4)}_${oldPos.z.toFixed(4)}`;
                const wasCenterSelected = selectedVertexKeys.has(oldKey);

                if (pivotMode() === 'center') {
                    const prevPos = selectionHelper.position.clone();
                    updateHelperPosition();
                    if (prevPos.distanceTo(selectionHelper.position) < 0.001) {
                        setPivotMode('origin');
                        updateHelperPosition();
                    }
                } else {
                    setPivotMode('center');
                    updateHelperPosition();
                }

                if (wasCenterSelected) {
                    selectedVertexKeys.delete(oldKey);
                    const newPos = selectionHelper.position;
                    const newKey = `CENTER_${newPos.x.toFixed(4)}_${newPos.y.toFixed(4)}_${newPos.z.toFixed(4)}`;
                    selectedVertexKeys.add(newKey);
                }

                updateSelectionOverlay();
                console.log('Pivot Mode:', pivotMode());
                break;
            }
            case 'q': {
                const items = Select.getSelectedItems();
                if (items.length > 0) {
                    removeShearFromSelection(
                        items,
                        selectionHelper,
                        Select.currentSelection,
                        loadedObjectGroup,
                        pivotMode(),
                        isCustomPivot(),
                        pivotOffset,
                        { SelectionCenter, updateHelperPosition, updateSelectionOverlay }
                    );
                }
                break;
            }
            case 'b': {
                toggleBlockbenchScaleMode();
                break;
            }
            case 'g': {
                const groupCount = Select.currentSelection.groups ? Select.currentSelection.groups.size : 0;
                const hasObjects = Select.currentSelection.objects && Select.currentSelection.objects.size > 0;

                if (groupCount === 1 && !hasObjects) {
                    const gid = Array.from(Select.currentSelection.groups)[0];
                    if (gid) ungroupGroup(gid);
                    resetSelectionAndDeselect();
                    break;
                }

                const items = Select.getSelectedItems();
                if (items.length > 0) createGroup();
                break;
            }
        }
    };

    window.addEventListener('keydown', (event: KeyboardEvent) => {
        if ((event.target as HTMLElement).tagName === 'INPUT' || (event.target as HTMLElement).tagName === 'TEXTAREA') return;

        if (event.key.toLowerCase() === 'f') {
            event.preventDefault();
            focusCameraOnSelection(camera, controls, Select.hasAnySelection(), _getSelectionBoundingBox, _getSelectionCenterWorld);
            return;
        }

        if (event.key === 'Delete' || event.key === 'Backspace') {
            event.preventDefault();
            deleteSelectedItems();
            return;
        }

        if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'a') {
            event.preventDefault();
            const all = _selectAllObjectsVisibleInScene();

            let totalCount = 0;
            for (const [, ids] of all) totalCount += ids.size;

            const mode = (totalCount > 1) ? 'center' : 'default';
            _replaceSelectionWithObjectsMap(all, { anchorMode: mode });
            return;
        }

        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
            event.preventDefault();
            const groupIds = new Set<string>();
            const meshToIds = new Map<PdeMesh, Set<number>>();

            if (loadedObjectGroup) {
                const objectToGroup = _getObjectToGroup();
                loadedObjectGroup.traverse((obj: THREE.Object3D) => {
                    if (!obj || (!(obj as THREE.InstancedMesh).isInstancedMesh && !(obj as THREE.BatchedMesh).isBatchedMesh)) return;
                    if (obj.visible === false) return;

                    const instanceCount = _getInstanceCount(obj as PdeMesh);
                    if (instanceCount <= 0) return;

                    for (let instanceId = 0; instanceId < instanceCount; instanceId++) {
                        if (!_isInstanceValid(obj as PdeMesh, instanceId)) continue;

                        const key = _getGroupKey(obj, instanceId);
                        const immediateGroupId = objectToGroup.get(key);
                        if (immediateGroupId) {
                            const chain = _getGroupChain(immediateGroupId);
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

            _replaceSelectionWithGroupsAndObjects(groupIds, meshToIds, { anchorMode: mode });
            return;
        }

        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'g') {
            event.preventDefault();
            const hasGroups = Select.currentSelection.groups && Select.currentSelection.groups.size > 0;
            if (hasGroups) {
                const ids = Array.from(Select.currentSelection.groups);
                ids.sort((a, b) => _getGroupChain(a).length - _getGroupChain(b).length).reverse();
                ids.forEach(id => ungroupGroup(id));
                resetSelectionAndDeselect();
            }
            return;
        }

        if (event.key === 'Alt') {
            event.preventDefault();
            if (!isPivotEditMode()) {
                setIsPivotEditMode(true);
                _draggingState.previousGizmoMode = transformControls.mode;
                _draggingState._pivotEditPreviousPivotMode = pivotMode();
                transformControls.setMode('translate');
            }
        }

        if (event.altKey && event.ctrlKey) {
            if (event.key === 'Alt' || event.key === 'Control') {
                event.preventDefault();

                const anchorState = _getAnchorState();
                const _pivotResetFlags: PivotResetFlags = {
                    isCustomPivot: isCustomPivot(),
                    multiExplicitPivot:          anchorState.multiExplicitPivot,
                    multiAnchorValid:             anchorState.multiAnchorValid,
                    multiAnchorInitialValid:      anchorState.multiAnchorInitialValid,
                    multiAnchorInitialLocalValid: anchorState.multiAnchorInitialLocalValid,
                    gizmoAnchorValid:             anchorState.gizmoAnchorValid,
                    selectionAnchorMode:          anchorState.selectionAnchorMode,
                };

                resetCustomPivot(
                    Select.currentSelection,
                    pivotOffset,
                    anchorState.multiOriginAnchorPosition,
                    anchorState.gizmoAnchorPosition,
                    _pivotResetFlags,
                    {
                        isMultiSelection:               _isMultiSelection,
                        revertEphemeralPivotUndoIfAny:  _revertEphemeralPivotUndoIfAny,
                        resolveMultiAnchorInitialWorld:  _resolveMultiAnchorInitialWorld,
                        setMultiAnchorInitial:           _setMultiAnchorInitial,
                        getGroups: _getGroups,
                        getGroupOriginWorld: _getGroupOriginWorld,
                        shouldUseGroupPivot: _shouldUseGroupPivot,
                        normalizePivotToVector3: _normalizePivotToVector3,
                        getGroupWorldMatrix: _getGroupWorldMatrix,
                        getDisplayType: _getDisplayType,
                        getInstanceLocalBoxMin: _getInstanceLocalBoxMin,
                        getInstanceWorldMatrixForOrigin: _getInstanceWorldMatrixForOrigin,
                        isItemDisplayHatEnabled: _isItemDisplayHatEnabled,
                        DEFAULT_GROUP_PIVOT: _DEFAULT_GROUP_PIVOT,
                    }
                );

                setIsCustomPivot(_pivotResetFlags.isCustomPivot);
                _setAnchorState({
                    multiExplicitPivot: _pivotResetFlags.multiExplicitPivot,
                    multiAnchorValid: _pivotResetFlags.multiAnchorValid,
                    multiAnchorInitialValid: _pivotResetFlags.multiAnchorInitialValid,
                    multiAnchorInitialLocalValid: _pivotResetFlags.multiAnchorInitialLocalValid,
                    gizmoAnchorValid: _pivotResetFlags.gizmoAnchorValid,
                    selectionAnchorMode: _pivotResetFlags.selectionAnchorMode
                });

                _recomputePivotStateForSelection();
                updateHelperPosition();

                if (transformControls.dragging) {
                    Overlay.prepareMultiSelectionDrag(Select.currentSelection);
                    // Selection helper matrices are updated in gizmo.ts's listeners
                }

                if (isVertexMode()) _pushToVertexQueue();
                updateSelectionOverlay();

                console.log('Pivot reset to origin');
            }
        }

        if (isGizmoBusy()) return;
        const key = event.key.toLowerCase();
        const keysToHandle = ['t', 'r', 's', 'x', 'z', 'q', 'b', 'g', 'd', 'v'];
        if (transformControls.dragging && keysToHandle.includes(key)) {
            setIsGizmoBusy(true);
            const attachedObject = transformControls.object;
            transformControls.pointerUp({ button: 0 } as PointerEvent);
            const oldTarget = controls.target.clone();
            controls.dispose();
            const newControls = new (controls.constructor as any)(camera, renderer.domElement);
            newControls.screenSpacePanning = true;
            newControls.target.copy(oldTarget);
            newControls.update();
            params.setControls(newControls);
            controls = newControls;
            setTimeout(() => {
                if (attachedObject) {
                    transformControls.detach();
                    transformControls.attach(attachedObject);
                }
                handleKeyPress(key);
                setIsGizmoBusy(false);
            }, 0);
            return;
        }
        if (keysToHandle.includes(key)) {
            setIsGizmoBusy(true);
            handleKeyPress(key);
            setTimeout(() => { setIsGizmoBusy(false); }, 50);
        }
    });

    window.addEventListener('keyup', (event: KeyboardEvent) => {
        if (event.key === 'Alt') {
            if (isPivotEditMode()) {
                if (transformControls.dragging) {
                    selectionHelper.updateMatrixWorld();
                }

                setIsPivotEditMode(false);
                transformControls.setMode(_draggingState.previousGizmoMode);
                _draggingState._pivotEditPreviousPivotMode = null;

                if (transformControls.dragging) {
                    Overlay.prepareMultiSelectionDrag(Select.currentSelection);
                    updateSelectionOverlay();
                }
            }
        }
    });

    const clearAltState = () => {
        if (isPivotEditMode()) {
            setIsPivotEditMode(false);
            try {
                transformControls.setMode(_draggingState.previousGizmoMode);
            } catch (err) {
                console.warn('Failed to restore transformControls mode on blur/visibility change', err);
            }
        }
        setIsGizmoBusy(false);
        try {
            if (transformControls && transformControls.dragging) {
                transformControls.pointerUp({ button: 0 } as PointerEvent);
            }
        } catch (_err) {}
    };

    const resetOrbitControls = () => {
        if (controls && params.setControls) {
            const oldTarget = controls.target.clone();
            const oldScreenSpacePanning = controls.screenSpacePanning;
            controls.dispose();

            const newControls = new (controls.constructor as any)(camera, renderer.domElement);
            newControls.screenSpacePanning = oldScreenSpacePanning;
            newControls.target.copy(oldTarget);
            newControls.update();

            params.setControls(newControls);
            controls = newControls;
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

    // ── Raycaster & pointer handling ──────────────────────────────────────────

    function getHoveredVertex(mouseNDC: THREE.Vector2): THREE.Sprite | null {
        if (!isVertexMode()) return null;
        return Overlay.getHoveredVertex(mouseNDC, camera, renderer);
    }

    const dragControls: DragInterface = initDrag({
        renderer,
        camera,
        getControls: () => controls,
        transformControls: transformControls,
        loadedObjectGroup,
        getSelectionCallbacks: _getSelectionCallbacks
    });

    renderer.domElement.addEventListener('pointermove', (event: PointerEvent) => {
        if (transformControls.dragging || dragControls.isMarqueeActiveOrCandidate()) return;

        if (isVertexMode()) {
            const rect = renderer.domElement.getBoundingClientRect();
            const m = new THREE.Vector2(
                ((event.clientX - rect.left) / rect.width) * 2 - 1,
                -((event.clientY - rect.top) / rect.height) * 2 + 1
            );

            const hovered = getHoveredVertex(m);
            Overlay.updateVertexHoverHighlight(hovered, selectedVertexKeys);

            if (hovered) {
                renderer.domElement.style.cursor = 'pointer';
            } else if (isVertexMode()) {
                renderer.domElement.style.cursor = '';
            }
        }
    });

    renderer.domElement.addEventListener('pointerdown', (event: PointerEvent) => {
        if (isGizmoBusy()) return;
        if (event.button !== 0) return;

        if (isVertexMode()) {
            const rect = renderer.domElement.getBoundingClientRect();
            const m = new THREE.Vector2(
                ((event.clientX - rect.left) / rect.width) * 2 - 1,
                -((event.clientY - rect.top) / rect.height) * 2 + 1
            );

            const v = getHoveredVertex(m);
            if (v && v.userData && v.userData.key) {
                const key = v.userData.key as string;

                if (selectedVertexKeys.has(key)) {
                    selectedVertexKeys.delete(key);
                } else {
                    selectedVertexKeys.add(key);

                    if (selectedVertexKeys.size === 2) {
                        const handled = processVertexSnap(selectedVertexKeys, {
                            isVertexMode: isVertexMode(),
                            gizmoMode: transformControls.mode,
                            currentSelection: Select.currentSelection, loadedObjectGroup, selectionHelper: selectionHelper,
                            getGizmoState: _getGizmoState, setGizmoState: _setGizmoState,
                            getGroups: _getGroups, getGroupWorldMatrixWithFallback: params.getGroupWorldMatrixWithFallback, getGroupWorldMatrix: _getGroupWorldMatrix,
                            updateHelperPosition, updateSelectionOverlay,
                            _isMultiSelection, _getSingleSelectedGroupId, SelectionCenter,
                            vertexQueue
                        });

                        if (!handled && transformControls.mode === 'rotate') {
                            processVertexRotate(selectedVertexKeys, {
                                isVertexMode: isVertexMode(),
                                gizmoMode: transformControls.mode,
                                currentSelection: Select.currentSelection, loadedObjectGroup, selectionHelper: selectionHelper,
                                getGizmoState: _getGizmoState, setGizmoState: _setGizmoState,
                                getGroups: _getGroups, getGroupWorldMatrixWithFallback: params.getGroupWorldMatrixWithFallback,
                                updateHelperPosition, updateSelectionOverlay,
                                SelectionCenter,
                                vertexQueue
                            });
                        }

                        if (!handled && transformControls.mode === 'scale') {
                            processVertexScale(selectedVertexKeys, {
                                isVertexMode: isVertexMode(),
                                gizmoMode: transformControls.mode,
                                isCtrlDown: event.ctrlKey || event.metaKey,
                                currentSelection: Select.currentSelection, loadedObjectGroup, selectionHelper: selectionHelper,
                                getGizmoState: _getGizmoState, setGizmoState: _setGizmoState,
                                getGroups: _getGroups, getGroupWorldMatrixWithFallback: params.getGroupWorldMatrixWithFallback,
                                updateHelperPosition, updateSelectionOverlay,
                                SelectionCenter,
                                vertexQueue,
                                getSelectedItems: Select.getSelectedItems
                            });
                        }
                    }
                }

                Overlay.refreshSelectionPointColors(selectedVertexKeys);
                mouseDownPos = null;
                return;
            }
        }

        if (dragControls.onPointerDown(event)) {
            mouseDownPos = { x: event.clientX, y: event.clientY };
            cameraMatrixOnPointerDown.copy(camera.matrixWorld);
            return;
        }

        mouseDownPos = { x: event.clientX, y: event.clientY };
        cameraMatrixOnPointerDown.copy(camera.matrixWorld);
    }, true);

    renderer.domElement.addEventListener('pointermove', (event: PointerEvent) => {
        dragControls.onPointerMove(event);
    });

    renderer.domElement.addEventListener('pointerup', (event: PointerEvent) => {
        if (dragControls.onPointerUp(event)) {
            mouseDownPos = null;
            return;
        }

        if (!mouseDownPos) return;

        if (!camera.matrixWorld.equals(cameraMatrixOnPointerDown)) {
            mouseDownPos = null;
            return;
        }

        const dist = Math.sqrt((event.clientX - mouseDownPos.x) ** 2 + (event.clientY - mouseDownPos.y) ** 2);
        if (dist > 5) { mouseDownPos = null; return; }
        mouseDownPos = null;

        const rect = renderer.domElement.getBoundingClientRect();
        mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(mouse, camera);

        Select.handleSelectionClick(raycaster, event, loadedObjectGroup, {
            onDeselect: resetSelectionAndDeselect,
            recomputePivotState: _recomputePivotStateForSelection,
            updateHelperPosition: updateHelperPosition,
            updateSelectionOverlay: updateSelectionOverlay,
            pushToVertexQueue: _pushToVertexQueue,
            hasVertexQueue: () => vertexQueue.length > 0,
            revertEphemeralPivotUndoIfAny: _revertEphemeralPivotUndoIfAny,
            detachTransformControls: () => { if (transformControls) transformControls.detach(); },
            clearGizmoAnchor: _clearGizmoAnchor,
            setSelectionAnchorMode: _setSelectionAnchorMode,
            resetPivotState: () => {
                pivotOffset.set(0, 0, 0);
                setIsCustomPivot(false);
            },
            isVertexMode: isVertexMode()
        });
    });

    return {
        updateDetectedAnchorDirections: (x: boolean | null, y: boolean | null, z: boolean | null) => {
            detectedAnchorDirections = { x, y, z };
        },
        getDetectedAnchorDirections: () => detectedAnchorDirections,
        getMouseInput: () => mouseInput,
        updateControls: (newControls: OrbitControlsLike) => {
            controls = newControls;
        }
    };
}
