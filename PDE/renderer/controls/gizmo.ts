import * as THREE from 'three/webgpu';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { setupGizmo, type GizmoLines } from './gizmo-setup';
import {
    currentSelection,
    type SelectedItem,
    type SelectionCallbacks,
    type SelectionAnchorMode,
    getSelectedItems,
    hasAnySelection,
    isMultiSelection,
    invalidateSelectionCaches,
    clearSelectionState,
    handleSelectionClick,
} from './select';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface GizmoInitOptions {
    scene: THREE.Scene;
    camera: THREE.Camera;
    renderer: THREE.WebGPURenderer;
    controls: any; // OrbitControls
    loadedObjectGroup: THREE.Object3D;
    setControls: (controls: any) => void;
}

export interface GizmoAPI {
    getTransformControls: () => TransformControls;
    /** 렌더 루프에서 매 프레임 호출해 축 방향 가시성을 갱신한다. */
    updateGizmo: () => void;
    resetSelection: () => void;
    getSelectedObject: () => THREE.Object3D | null;
}

type PivotMode = 'origin' | 'center';
type TransformSpace = 'world' | 'local';
type GizmoMode = 'translate' | 'rotate' | 'scale';

// ─── GizmoController ──────────────────────────────────────────────────────────

export class GizmoController {
    // 씬 레퍼런스
    private camera!: THREE.Camera;
    private renderer!: THREE.WebGPURenderer;
    private controls: any;
    private loadedObjectGroup!: THREE.Object3D;
    private setControlsFn!: (c: any) => void;

    // TransformControls / Helper
    private transformControls!: TransformControls;
    private selectionHelper!: THREE.Mesh;
    private gizmoLines!: GizmoLines;

    // 피벗 · 공간 상태
    private pivotMode: PivotMode = 'origin';
    private currentSpace: TransformSpace = 'world';
    private isCustomPivot  = false;
    private pivotOffset    = new THREE.Vector3();

    // 기즈모 앵커 (멀티셀렉션 안정성)
    private _gizmoAnchorPos   = new THREE.Vector3();
    private _gizmoAnchorValid = false;

    // 멀티셀렉션 origin 앵커
    private _multiOriginAnchorPos   = new THREE.Vector3();
    private _multiOriginAnchorValid = false;

    // 멀티셀렉션 누적 회전 (No-Basis 회전용)
    private _multiAccumulatedRotation = new THREE.Quaternion();

    // 선택 앵커 모드
    private _selectionAnchorMode: SelectionAnchorMode = 'default';

    // 드래그 상태
    private _prevHelperMatrix = new THREE.Matrix4();
    private _dragStartPivotBaseWorld = new THREE.Vector3();
    private _draggingMode: GizmoMode | null = null;
    private _isGizmoBusy    = false;

    // 피벗 편집 모드
    private _isPivotEditMode       = false;
    private _pivotEditPrevMode: GizmoMode = 'translate';

    // 재사용 임시 객체 (hot path)
    private readonly _TMP_MAT4_A = new THREE.Matrix4();
    private readonly _TMP_MAT4_B = new THREE.Matrix4();
    private readonly _tmpPrevInvMat     = new THREE.Matrix4();
    private readonly _tmpDeltaMat       = new THREE.Matrix4();
    private readonly _tmpInstanceMat    = new THREE.Matrix4();
    private readonly _tmpMeshWorldInv   = new THREE.Matrix4();
    private readonly _tmpLocalDelta     = new THREE.Matrix4();
    private readonly _meshToInstanceIds = new Map<THREE.Object3D, number[]>();

    // 마지막 축 방향 (프레임별 비교를 위한 캐시)
    private _lastDirections: Record<'X' | 'Y' | 'Z', 'positive' | 'negative' | null> =
        { X: null, Y: null, Z: null };

    // 마우스 다운 위치 (클릭 판별)
    private _mouseDownPos: { x: number; y: number } | null = null;
    private _cameraMatOnPointerDown = new THREE.Matrix4();

    // ─── Init / Dispose ────────────────────────────────────────────────────

    init(options: GizmoInitOptions): GizmoAPI {
        const { scene, camera, renderer, controls, loadedObjectGroup, setControls } = options;
        this.camera = camera;
        this.renderer = renderer;
        this.controls = controls;
        this.loadedObjectGroup = loadedObjectGroup;
        this.setControlsFn = setControls;

        // Selection helper: invisible mesh, gizmo위치와 방향의 기준
        this.selectionHelper = new THREE.Mesh(
            new THREE.BoxGeometry(0.1, 0.1, 0.1),
            new THREE.MeshBasicMaterial({ visible: false }),
        );
        scene.add(this.selectionHelper);

        const setup = setupGizmo(camera, renderer, scene);
        this.transformControls = setup.transformControls;
        this.gizmoLines = setup.gizmoLines;

        this._prevHelperMatrix.copy(this.selectionHelper.matrixWorld);

        // upload-pbde.ts가 씬 재로드 전 loadedObjectGroup.userData.resetSelection()을
        // 호출해 선택 상태를 초기화할 수 있도록 등록한다.
        loadedObjectGroup.userData.resetSelection = () => this.resetSelectionAndDeselect();

        this._bindEvents();

        return {
            getTransformControls: () => this.transformControls,
            updateGizmo: () => this._updateGizmoAxes(),
            resetSelection: () => this.resetSelectionAndDeselect(),
            getSelectedObject: () => {
                const p = currentSelection.primary;
                return p?.type === 'object' ? p.mesh : null;
            },
        };
    }

    dispose(): void {
        this.renderer.domElement.removeEventListener('pointerdown', this._onPointerDown, true);
        this.renderer.domElement.removeEventListener('pointermove', this._onPointerMove);
        this.renderer.domElement.removeEventListener('pointerup',   this._onPointerUp);
        window.removeEventListener('keydown', this._onKeyDown);
        window.removeEventListener('keyup',   this._onKeyUp);
        window.removeEventListener('blur',    this._onBlur);
        document.removeEventListener('visibilitychange', this._onVisibilityChange);
        this.transformControls.removeEventListener('dragging-changed', this._onDraggingChanged);
        this.transformControls.removeEventListener('change',           this._onTransformChange);
    }

    // ─── Selection ────────────────────────────────────────────────────────

    resetSelectionAndDeselect(): void {
        if (!hasAnySelection()) return;
        this.transformControls.detach();
        clearSelectionState();
        this._clearGizmoAnchor();
        this.pivotOffset.set(0, 0, 0);
        this.isCustomPivot = false;
        this._selectionAnchorMode = 'default';
        invalidateSelectionCaches();
        this.updateSelectionOverlay();
        this._lastDirections = { X: null, Y: null, Z: null };
    }

    applySelection(
        mesh: THREE.Object3D | null,
        instanceIds: number[],
        _groupId: string | null = null,
    ): void {
        clearSelectionState();
        this._clearGizmoAnchor();
        this._selectionAnchorMode = 'default';

        if (mesh && instanceIds.length > 0) {
            const set = new Set(instanceIds);
            currentSelection.objects.set(mesh, set);
            currentSelection.primary = {
                type: 'object',
                mesh: mesh as THREE.InstancedMesh | THREE.BatchedMesh,
                instanceId: instanceIds[0],
            };
        }

        invalidateSelectionCaches();
        this._recomputePivotState();
        this.updateHelperPosition();
        this.updateSelectionOverlay();
    }

    // ─── Pivot / State ────────────────────────────────────────────────────

    private _recomputePivotState(): void {
        // CustomPivot 모듈 없이는 단일 오브젝트 선택만 처리
        if (!isMultiSelection()) {
            const entry = currentSelection.objects.size > 0
                ? currentSelection.objects.entries().next().value
                : null;
            if (entry) {
                const [mesh, ids] = entry as [THREE.Object3D, Set<number>];
                const hasCustom = (mesh as any).userData?.customPivots?.has(Array.from(ids)[0])
                    || (mesh as any).userData?.customPivot;
                if (!hasCustom) {
                    this.isCustomPivot  = false;
                    this.pivotOffset.set(0, 0, 0);
                }
            }
        }
    }

    private _clearGizmoAnchor(): void {
        this._gizmoAnchorValid = false;
        this._gizmoAnchorPos.set(0, 0, 0);
        this._multiOriginAnchorValid = false;
        this._multiOriginAnchorPos.set(0, 0, 0);
        this._multiAccumulatedRotation.set(0, 0, 0, 1);
    }

    /** 선택 콜백 객체 생성 (select.ts API에 전달) */
    private _getCallbacks(): SelectionCallbacks {
        return {
            detachTransformControls:  () => this.transformControls.detach(),
            clearGizmoAnchor:         () => this._clearGizmoAnchor(),
            setSelectionAnchorMode:   (m) => { this._selectionAnchorMode = m; },
            resetPivotState:          () => {
                this.pivotOffset.set(0, 0, 0);
                this.isCustomPivot = false;
            },
            updateHelperPosition:    () => this.updateHelperPosition(),
            updateSelectionOverlay:  () => this.updateSelectionOverlay(),
            recomputePivotState:     () => this._recomputePivotState(),
            onDeselect:              () => this.resetSelectionAndDeselect(),
        };
    }

    // ─── Position Helpers ─────────────────────────────────────────────────

    private _getInstanceWorldPos(item: SelectedItem, out: THREE.Vector3): THREE.Vector3 {
        const mat = this._TMP_MAT4_A;
        (item.mesh as THREE.InstancedMesh).getMatrixAt(item.instanceId, mat);
        mat.premultiply(item.mesh.matrixWorld);
        return out.setFromMatrixPosition(mat);
    }

    private _getDisplayType(mesh: THREE.InstancedMesh | THREE.BatchedMesh, instanceId: number): string | undefined {
        const anyMesh = mesh as any;
        if (anyMesh.isBatchedMesh && anyMesh.userData?.displayTypes) {
            return anyMesh.userData.displayTypes.get(instanceId);
        }
        return anyMesh.userData?.displayType;
    }

    private _isItemDisplayHatEnabled(mesh: THREE.InstancedMesh | THREE.BatchedMesh, instanceId: number): boolean {
        const anyMesh = mesh as any;
        return !!(
            this._getDisplayType(mesh, instanceId) === 'item_display'
            && anyMesh.userData?.hasHat
            && anyMesh.userData.hasHat[instanceId]
        );
    }

    private _getInstanceLocalBoxMin(item: SelectedItem, out: THREE.Vector3): THREE.Vector3 | null {
        const mesh = item.mesh as any;

        if (mesh.isBatchedMesh) {
            const geomId = mesh.userData?.instanceGeometryIds?.[item.instanceId];
            const box = geomId !== undefined
                ? mesh.userData?.geometryBounds?.get?.(geomId)
                : null;
            if (!box) return null;
            return out.copy(box.min);
        }

        const instanced = item.mesh as THREE.InstancedMesh;
        const geometry = instanced.geometry;
        if (!geometry.boundingBox) geometry.computeBoundingBox();
        if (!geometry.boundingBox) return null;
        return out.copy(geometry.boundingBox.min);
    }

    private _getInstanceWorldMatrixForOrigin(item: SelectedItem, out: THREE.Matrix4): THREE.Matrix4 {
        out.identity();
        const mesh = item.mesh as any;

        mesh.getMatrixAt(item.instanceId, out);

        if (mesh.isBatchedMesh && mesh.userData?.localMatrices?.has?.(item.instanceId)) {
            this._TMP_MAT4_B.copy(mesh.userData.localMatrices.get(item.instanceId)).invert();
            out.multiply(this._TMP_MAT4_B);
        }

        return out.premultiply(item.mesh.matrixWorld);
    }

    private _getInstanceOriginAnchorPos(item: SelectedItem, out: THREE.Vector3): THREE.Vector3 {
        const displayType = this._getDisplayType(item.mesh, item.instanceId);
        const mat = this._TMP_MAT4_A;

        if (displayType === 'block_display') {
            const localMin = this._getInstanceLocalBoxMin(item, out);
            if (localMin) {
                this._getInstanceWorldMatrixForOrigin(item, mat);
                return localMin.applyMatrix4(mat);
            }
        }

        this._getInstanceWorldMatrixForOrigin(item, mat);
        const localY = this._isItemDisplayHatEnabled(item.mesh, item.instanceId) ? 0.03125 : 0;
        return out.set(0, localY, 0).applyMatrix4(mat);
    }

    private _getInstanceWorldMat(item: SelectedItem, out: THREE.Matrix4): THREE.Matrix4 {
        (item.mesh as THREE.InstancedMesh).getMatrixAt(item.instanceId, out);
        return out.premultiply(item.mesh.matrixWorld);
    }

    private _calculateAvgOrigin(): THREE.Vector3 {
        const items = getSelectedItems();
        const sum = new THREE.Vector3();
        if (items.length === 0) return sum;
        const tmp = new THREE.Vector3();
        items.forEach(item => sum.add(this._getInstanceOriginAnchorPos(item, tmp)));
        return sum.divideScalar(items.length);
    }

    /** 현재 pivotMode에 따른 기즈모 위치를 계산한다. */
    private _selectionCenter(): THREE.Vector3 {
        const items = getSelectedItems();
        if (items.length === 0) return new THREE.Vector3();

        if (this.pivotMode === 'center') {
            const box = new THREE.Box3();
            const tmp = new THREE.Vector3();
            items.forEach(item => box.expandByPoint(this._getInstanceWorldPos(item, tmp)));
            return box.isEmpty() ? this._calculateAvgOrigin() : box.getCenter(new THREE.Vector3());
        }

        // pivotMode === 'origin'
        const p = currentSelection.primary;
        if (p?.type === 'object') {
            const pos = new THREE.Vector3();
            this._getInstanceOriginAnchorPos({ mesh: p.mesh, instanceId: p.instanceId }, pos);
            if (this.isCustomPivot) pos.add(this.pivotOffset);
            return pos;
        }

        return this._calculateAvgOrigin();
    }

    // ─── Helper Update ────────────────────────────────────────────────────

    updateHelperPosition(): void {
        const items = getSelectedItems();
        if (items.length === 0 && !hasAnySelection()) return;

        const isMulti = isMultiSelection();

        // 멀티셀렉션 origin 앵커 처리
        if (this.pivotMode === 'origin' && isMulti) {
            if (!this._multiOriginAnchorValid && this._gizmoAnchorValid) {
                this._multiOriginAnchorPos.copy(this._gizmoAnchorPos);
                this._multiOriginAnchorValid = true;
            }
            if (this._multiOriginAnchorValid) {
                this.selectionHelper.position.copy(this._multiOriginAnchorPos);
                this._gizmoAnchorPos.copy(this._multiOriginAnchorPos);
                this._gizmoAnchorValid = true;
            } else {
                const center = this._computeHelperPos();
                this.selectionHelper.position.copy(center);
                this._gizmoAnchorPos.copy(center);
                this._gizmoAnchorValid = true;
                this._multiOriginAnchorPos.copy(center);
                this._multiOriginAnchorValid = true;
            }
        } else {
            const center = this._selectionAnchorMode === 'center'
                ? this._calculateAvgOrigin()
                : this._computeHelperPos();
            this.selectionHelper.position.copy(center);
            this._gizmoAnchorPos.copy(center);
            this._gizmoAnchorValid = true;

            if (this.pivotMode === 'origin' && isMulti) {
                this._multiOriginAnchorPos.copy(center);
                this._multiOriginAnchorValid = true;
            }
        }

        // 회전 설정
        this._updateHelperRotation(items, isMulti);

        this.selectionHelper.updateMatrixWorld();
        this._prevHelperMatrix.copy(this.selectionHelper.matrixWorld);

        this.transformControls.attach(this.selectionHelper);
    }

    private _computeHelperPos(): THREE.Vector3 {
        return this._selectionCenter();
    }

    /**
     * 순수 회전 쿼터니언을 추출한다. (shear가 섞인 세계행렬에서도 정확히 동작)
     */
    private _getRotationFromMatrix(matrix: THREE.Matrix4): THREE.Quaternion {
        const x = new THREE.Vector3().setFromMatrixColumn(matrix, 0);
        const y = new THREE.Vector3().setFromMatrixColumn(matrix, 1);

        x.normalize();
        const yDotX = y.dot(x);
        y.sub(x.clone().multiplyScalar(yDotX)).normalize();
        const z = new THREE.Vector3().crossVectors(x, y).normalize();

        const R = new THREE.Matrix4().makeBasis(x, y, z);
        return new THREE.Quaternion().setFromRotationMatrix(R);
    }

    private _updateHelperRotation(items: SelectedItem[], isMulti: boolean): void {
        if (this.currentSpace === 'world') {
            this.selectionHelper.quaternion.set(0, 0, 0, 1);
            this.selectionHelper.scale.set(1, 1, 1);
            return;
        }
        // local space: gizmo.js의 getRotationFromMatrix 방식으로 재직교화
        const p = currentSelection.primary;
        if (p?.type === 'object') {
            const mat = this._TMP_MAT4_A;
            this._getInstanceWorldMat({ mesh: p.mesh, instanceId: p.instanceId }, mat);
            this.selectionHelper.quaternion.copy(this._getRotationFromMatrix(mat));
        } else if (!p && isMulti) {
            // No primary (Ctrl+A) → 누적 회전 사용
            this.selectionHelper.quaternion.copy(this._multiAccumulatedRotation);
        } else {
            this.selectionHelper.quaternion.set(0, 0, 0, 1);
        }
        this.selectionHelper.scale.set(1, 1, 1);
    }

    updateSelectionOverlay(): void {
        // overlay 모듈 연결 전: 이벤트만 디스패치
        window.dispatchEvent(
            new CustomEvent('pde:selection-changed', { detail: currentSelection }),
        );
    }

    // ─── Instance Transform ───────────────────────────────────────────────

    private _applyDeltaToInstances(): void {
        const items = getSelectedItems();
        this._meshToInstanceIds.clear();
        for (const { mesh, instanceId } of items) {
            let list = this._meshToInstanceIds.get(mesh);
            if (!list) { list = []; this._meshToInstanceIds.set(mesh, list); }
            list.push(instanceId);
        }

        const delta = this._tmpDeltaMat;

        for (const [mesh, ids] of this._meshToInstanceIds) {
            this._tmpMeshWorldInv.copy(mesh.matrixWorld).invert();
            this._tmpLocalDelta.multiplyMatrices(this._tmpMeshWorldInv, delta);
            this._tmpLocalDelta.multiply(mesh.matrixWorld);

            for (const id of ids) {
                (mesh as THREE.InstancedMesh).getMatrixAt(id, this._tmpInstanceMat);
                this._tmpInstanceMat.premultiply(this._tmpLocalDelta);
                (mesh as THREE.InstancedMesh).setMatrixAt(id, this._tmpInstanceMat);
            }
            if ((mesh as THREE.InstancedMesh).instanceMatrix) {
                (mesh as THREE.InstancedMesh).instanceMatrix.needsUpdate = true;
            }
        }

        // 선택된 메시의 bounding sphere 무효화
        for (const mesh of this._meshToInstanceIds.keys()) {
            (mesh as any).boundingSphere = null;
        }
    }

    // ─── Event Handlers ───────────────────────────────────────────────────

    private _onDraggingChanged = (event: any): void => {
        this.controls.enabled = !event.value;

        if (event.value) {
            // Drag 시작
            this._draggingMode = this.transformControls.mode as GizmoMode;

            if (this._isPivotEditMode) {
                this._dragStartPivotBaseWorld.copy(this._selectionCenter());
            }
        } else {
            // Drag 종료
            if (this._draggingMode === 'rotate' && isMultiSelection() && !currentSelection.primary) {
                this._multiAccumulatedRotation.copy(this.selectionHelper.quaternion);
            }

            this._draggingMode = null;

            if (this._isPivotEditMode) {
                this._persistPivotAfterDrag();
                if (isMultiSelection()) {
                    this._multiOriginAnchorPos.copy(this.selectionHelper.position);
                    this._multiOriginAnchorValid = true;
                }
            } else {
                this._recomputePivotState();
                if (isMultiSelection() && this.pivotMode === 'origin') {
                    this._multiOriginAnchorPos.copy(this.selectionHelper.position);
                    this._multiOriginAnchorValid = true;
                }
            }

            this.selectionHelper.scale.set(1, 1, 1);
            this.selectionHelper.updateMatrixWorld();
            this._prevHelperMatrix.copy(this.selectionHelper.matrixWorld);
        }
    };

    private _onTransformChange = (): void => {
        if (!this.transformControls.dragging || !hasAnySelection()) return;

        if (this._isPivotEditMode && this.transformControls.mode === 'translate') {
            this.pivotOffset.subVectors(this.selectionHelper.position, this._dragStartPivotBaseWorld);
            this.isCustomPivot = true;
            if (isMultiSelection()) {
                this._multiOriginAnchorPos.copy(this.selectionHelper.position);
                this._multiOriginAnchorValid = true;
            }
            this._prevHelperMatrix.copy(this.selectionHelper.matrixWorld);
            return;
        }

        this.selectionHelper.updateMatrixWorld();
        this._tmpPrevInvMat.copy(this._prevHelperMatrix).invert();
        this._tmpDeltaMat.multiplyMatrices(this.selectionHelper.matrixWorld, this._tmpPrevInvMat);

        this._applyDeltaToInstances();

        this._prevHelperMatrix.copy(this.selectionHelper.matrixWorld);
    };

    // 피벗 드래그 종료 시 피벗 데이터 저장 (단일 오브젝트 선택만)
    private _persistPivotAfterDrag(): void {
        const p = currentSelection.primary;
        if (!p || p.type !== 'object') return;

        const pivotWorld = this.selectionHelper.position.clone();
        const mat = new THREE.Matrix4();
        this._getInstanceWorldMat({ mesh: p.mesh, instanceId: p.instanceId }, mat);
        const localPivot = pivotWorld.applyMatrix4(mat.invert());

        const mesh = p.mesh as any;
        if (!mesh.userData.customPivots) mesh.userData.customPivots = new Map();
        mesh.userData.customPivots.set(p.instanceId, localPivot);
        mesh.userData.isCustomPivot = true;

        this._gizmoAnchorPos.copy(this.selectionHelper.position);
        this._gizmoAnchorValid = true;
        this._selectionAnchorMode = 'default';
    }

    private _onPointerDown = (event: PointerEvent): void => {
        if (this._isGizmoBusy || event.button !== 0) return;

        // TransformControls가 드래그 중이면 축 감지만 수행
        if (this.transformControls.dragging) {
            return;
        }

        this._mouseDownPos = { x: event.clientX, y: event.clientY };
        this._cameraMatOnPointerDown.copy(this.camera.matrixWorld);
    };

    private _onPointerMove = (_event: PointerEvent): void => {};

    private _onPointerUp = (event: PointerEvent): void => {
        if (!this._mouseDownPos || event.button !== 0) return;

        // 카메라가 이동했으면 클릭이 아닌 드래그
        if (!this.camera.matrixWorld.equals(this._cameraMatOnPointerDown)) {
            this._mouseDownPos = null;
            return;
        }

        const dx = event.clientX - this._mouseDownPos.x;
        const dy = event.clientY - this._mouseDownPos.y;
        this._mouseDownPos = null;
        if (Math.hypot(dx, dy) > 5) return;

        const rect = this.renderer.domElement.getBoundingClientRect();
        const mouse = new THREE.Vector2(
            ((event.clientX - rect.left) / rect.width) * 2 - 1,
            -((event.clientY - rect.top) / rect.height) * 2 + 1,
        );

        const raycaster = new THREE.Raycaster();
        raycaster.setFromCamera(mouse, this.camera);

        handleSelectionClick(raycaster, event, this.loadedObjectGroup, this._getCallbacks());
    };

    private _handleKeyPress = (key: string): void => {
        const resetHelperRot = () => {
            if (this.currentSpace !== 'world') return;
            if (getSelectedItems().length > 0) {
                this.selectionHelper.quaternion.set(0, 0, 0, 1);
                this.selectionHelper.updateMatrixWorld();
                this._prevHelperMatrix.copy(this.selectionHelper.matrixWorld);
            }
        };

        switch (key) {
            case 't': this.transformControls.setMode('translate'); resetHelperRot(); break;
            case 'r': this.transformControls.setMode('rotate');    resetHelperRot(); break;
            case 's': this.transformControls.setMode('scale');     resetHelperRot(); break;
            case 'x': {
                this.currentSpace = this.currentSpace === 'world' ? 'local' : 'world';
                this.transformControls.setSpace(this.currentSpace);
                this.updateHelperPosition();
                this.updateSelectionOverlay();
                break;
            }
            case 'z': {
                const prevPos = this.selectionHelper.position.clone();
                if (this.pivotMode === 'center') {
                    this.pivotMode = 'origin';
                } else {
                    this.pivotMode = 'center';
                }
                // 멀티셀렉션 origin 앵커 무효화 (pivot 기준 변경)
                this._multiOriginAnchorValid = false;
                this.updateHelperPosition();
                this.updateSelectionOverlay();
                break;
            }
        }
    };

    private _onKeyDown = (event: KeyboardEvent): void => {
        if ((event.target as HTMLElement).tagName === 'INPUT' ||
            (event.target as HTMLElement).tagName === 'TEXTAREA') return;

        // Alt: 피벗 편집 모드 진입
        if (event.key === 'Alt') {
            event.preventDefault();
            if (!this._isPivotEditMode) {
                this._isPivotEditMode = true;
                this._pivotEditPrevMode = this.transformControls.mode as GizmoMode;
                this._dragStartPivotBaseWorld.copy(this._selectionCenter());
                this.transformControls.setMode('translate');
            }
            return;
        }

        if (this._isGizmoBusy) return;

        const key = event.key.toLowerCase();
        const handledKeys = ['t', 'r', 's', 'x', 'z'];
        if (!handledKeys.includes(key)) return;

        if (this.transformControls.dragging) {
            // 드래그 중 키 입력 → controls 재생성 후 처리
            this._isGizmoBusy = true;
            this.transformControls.pointerUp({ button: 0 } as any);
            const oldTarget = this.controls.target.clone();
            this.controls.dispose();
            const NewControls = this.controls.constructor;
            const newControls = new NewControls(this.camera, this.renderer.domElement);
            newControls.screenSpacePanning = true;
            newControls.target.copy(oldTarget);
            newControls.update();
            this.setControlsFn(newControls);
            this.controls = newControls;

            const attached = this.transformControls.object;
            setTimeout(() => {
                if (attached) {
                    this.transformControls.detach();
                    this.transformControls.attach(attached);
                }
                this._handleKeyPress(key);
                this._isGizmoBusy = false;
            }, 0);
            return;
        }

        this._isGizmoBusy = true;
        this._handleKeyPress(key);
        setTimeout(() => { this._isGizmoBusy = false; }, 50);
    };

    private _onKeyUp = (event: KeyboardEvent): void => {
        if (event.key === 'Alt' && this._isPivotEditMode) {
            if (this.transformControls.dragging) {
                this.selectionHelper.updateMatrixWorld();
                this._prevHelperMatrix.copy(this.selectionHelper.matrixWorld);
            }
            this._isPivotEditMode = false;
            this.transformControls.setMode(this._pivotEditPrevMode);
        }
    };

    private _onBlur = (): void => { this._clearAltState(); };

    private _onVisibilityChange = (): void => {
        if (document.hidden) this._clearAltState();
    };

    private _clearAltState(): void {
        if (this._isPivotEditMode) {
            this._isPivotEditMode = false;
            try { this.transformControls.setMode(this._pivotEditPrevMode); } catch { /* ignore */ }
        }
        this._isGizmoBusy = false;
        try {
            if (this.transformControls?.dragging) this.transformControls.pointerUp({ button: 0 } as any);
        } catch { /* ignore */ }
    }

    // ─── Gizmo Axis Toggling (per-frame) ─────────────────────────────────

    private _updateGizmoAxes(): void {
        if (!hasAnySelection() || !this.transformControls.object) return;
        const mode = this.transformControls.mode;
        if (mode !== 'translate' && mode !== 'scale') return;

        const gizmoPos = this.transformControls.object.position;
        const dir = this.camera.position.clone().sub(gizmoPos).normalize();
        if (this.currentSpace === 'local') {
            dir.applyQuaternion(this.transformControls.object.quaternion.clone().invert());
        }

        const axes: Array<{ axis: 'X' | 'Y' | 'Z'; positive: boolean }> = [
            { axis: 'X', positive: dir.x > 0 },
            { axis: 'Y', positive: dir.y > 0 },
            { axis: 'Z', positive: dir.z > 0 },
        ];

        for (const { axis, positive } of axes) {
            const current = positive ? 'positive' : 'negative';
            if (current === this._lastDirections[axis]) continue;
            this._lastDirections[axis] = current;

            const { original, negative } = this.gizmoLines[axis];
            const showOriginal  = positive ? original  : negative;
            const hideOriginal  = positive ? negative  : original;

            showOriginal.forEach(l => {
                const m = l.material as any;
                m.transparent = true; m._opacity = 1; m.opacity = 1;
            });
            hideOriginal.forEach(l => {
                const m = l.material as any;
                m.transparent = true; m._opacity = 0.001; m.opacity = 0.001;
            });
        }
    }

    // ─── Event Binding ────────────────────────────────────────────────────

    private _bindEvents(): void {
        this.transformControls.addEventListener('dragging-changed', this._onDraggingChanged);
        this.transformControls.addEventListener('change',           this._onTransformChange);

        this.renderer.domElement.addEventListener('pointerdown', this._onPointerDown, true);
        this.renderer.domElement.addEventListener('pointermove', this._onPointerMove);
        this.renderer.domElement.addEventListener('pointerup',   this._onPointerUp);

        window.addEventListener('keydown', this._onKeyDown);
        window.addEventListener('keyup',   this._onKeyUp);
        window.addEventListener('blur',    this._onBlur);
        document.addEventListener('visibilitychange', this._onVisibilityChange);
    }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function initGizmo(options: GizmoInitOptions): GizmoAPI {
    return new GizmoController().init(options);
}
