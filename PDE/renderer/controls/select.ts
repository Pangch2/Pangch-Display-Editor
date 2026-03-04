import * as THREE from 'three/webgpu';

// ─── Types ────────────────────────────────────────────────────────────────────

export type SelectionAnchorMode = 'default' | 'center';

export interface PrimaryObject {
    type: 'object';
    mesh: THREE.InstancedMesh | THREE.BatchedMesh;
    instanceId: number;
}
export type Primary = PrimaryObject | null;

export interface SelectionState {
    objects: Map<THREE.Object3D, Set<number>>;
    primary: Primary;
}

export interface SelectedItem {
    mesh: THREE.InstancedMesh | THREE.BatchedMesh;
    instanceId: number;
}

export interface PickResult {
    mesh: THREE.InstancedMesh | THREE.BatchedMesh;
    instanceId: number;
}

export interface SelectionCallbacks {
    detachTransformControls?: () => void;
    clearGizmoAnchor?: () => void;
    setSelectionAnchorMode?: (mode: SelectionAnchorMode) => void;
    resetPivotState?: () => void;
    updateHelperPosition?: () => void;
    updateSelectionOverlay?: () => void;
    recomputePivotState?: () => void;
    onDeselect?: () => void;
}

export interface BeginReplaceOptions {
    anchorMode?: SelectionAnchorMode;
    detachTransform?: boolean;
}

// ─── State ────────────────────────────────────────────────────────────────────

export const currentSelection: SelectionState = {
    objects: new Map(),
    primary: null,
};

// ─── Cache ────────────────────────────────────────────────────────────────────

let _cacheKey: string | null = null;
let _cache: SelectedItem[] | null = null;

export function invalidateSelectionCaches(): void {
    _cacheKey = null;
    _cache = null;
}

function _buildCacheKey(): string {
    if (!hasAnySelection()) return 'none';

    const oParts: string[] = [];
    for (const [mesh, ids] of currentSelection.objects) {
        oParts.push(`${mesh.uuid}:${Array.from(ids).sort().join(',')}`);
    }
    oParts.sort();

    return oParts.join('|');
}

/**
 * 현재 선택된 모든 인스턴스를 반환한다.
 * 그룹 지원은 group 모듈 연결 후 추가 예정이므로 현재는 objects만 반환한다.
 */
export function getSelectedItems(): SelectedItem[] {
    const key = _buildCacheKey();
    if (_cacheKey === key && _cache) return _cache;

    const items: SelectedItem[] = [];
    const seen = new Set<string>();

    for (const [mesh, ids] of currentSelection.objects) {
        for (const id of ids) {
            const k = `${mesh.uuid}_${id}`;
            if (!seen.has(k)) {
                seen.add(k);
                items.push({ mesh: mesh as THREE.InstancedMesh | THREE.BatchedMesh, instanceId: id });
            }
        }
    }

    _cacheKey = key;
    _cache = items;
    return items;
}

// ─── Query Helpers ────────────────────────────────────────────────────────────

export function hasAnySelection(): boolean {
    return currentSelection.objects.size > 0;
}

export function isMultiSelection(): boolean {
    let objectCount = 0;
    for (const ids of currentSelection.objects.values()) objectCount += ids.size;
    return objectCount > 1;
}

export function getSingleSelectedMeshEntry(): { mesh: THREE.Object3D; instanceId: number } | null {
    if (currentSelection.objects.size !== 1) return null;
    const [mesh, ids] = currentSelection.objects.entries().next().value!;
    if (!mesh || !ids || ids.size !== 1) return null;
    return { mesh, instanceId: Array.from(ids as Set<number>)[0] };
}

export function setPrimaryToFirstAvailable(): void {
    for (const [mesh, ids] of currentSelection.objects) {
        if (ids.size > 0) {
            currentSelection.primary = {
                type: 'object',
                mesh: mesh as THREE.InstancedMesh | THREE.BatchedMesh,
                instanceId: Array.from(ids)[0],
            };
            return;
        }
    }
    currentSelection.primary = null;
}

// ─── Raycasting ───────────────────────────────────────────────────────────────

/**
 * Raycaster로 loadedObjectGroup을 순회해 가장 가까운 인스턴스를 반환한다.
 * overlay 모듈 없이 THREE.InstancedMesh 기본 raycast()를 사용한다.
 */
export function pickInstance(
    raycaster: THREE.Raycaster,
    rootGroup: THREE.Object3D,
): PickResult | null {
    const hits: THREE.Intersection[] = [];

    rootGroup.traverse((obj) => {
        if (!obj.visible) return;
        if (!(obj as THREE.InstancedMesh).isInstancedMesh && !(obj as any).isBatchedMesh) return;
        raycaster.intersectObject(obj, false, hits);
    });

    if (hits.length === 0) return null;
    hits.sort((a, b) => a.distance - b.distance);

    const hit = hits[0];
    const instanceId = (hit as any).instanceId ?? (hit as any).batchId ?? 0;
    return {
        mesh: hit.object as THREE.InstancedMesh | THREE.BatchedMesh,
        instanceId,
    };
}

// ─── Selection Mutation ───────────────────────────────────────────────────────

export function clearSelectionState(): void {
    currentSelection.objects.clear();
    currentSelection.primary = null;
    invalidateSelectionCaches();
}

export function beginSelectionReplace(
    callbacks: SelectionCallbacks,
    options: BeginReplaceOptions = {},
): void {
    const { anchorMode = 'default', detachTransform = false } = options;

    if (detachTransform) callbacks.detachTransformControls?.();

    clearSelectionState();
    callbacks.clearGizmoAnchor?.();

    callbacks.setSelectionAnchorMode?.(anchorMode);
    callbacks.resetPivotState?.();

    currentSelection.primary = null;
    invalidateSelectionCaches();
}

export function commitSelectionChange(callbacks: SelectionCallbacks): void {
    invalidateSelectionCaches();
    if (hasAnySelection() && !currentSelection.primary) setPrimaryToFirstAvailable();
    callbacks.recomputePivotState?.();
    callbacks.updateHelperPosition?.();
    callbacks.updateSelectionOverlay?.();
}

// ─── Click Handler ────────────────────────────────────────────────────────────

/**
 * 마우스 클릭 이벤트에 따라 선택 상태를 갱신한다.
 * 그룹 계층 드릴다운은 group 모듈 연결 후 추가 예정이다.
 */
export function handleSelectionClick(
    raycaster: THREE.Raycaster,
    event: PointerEvent,
    loadedObjectGroup: THREE.Object3D,
    callbacks: SelectionCallbacks,
): void {
    const picked = pickInstance(raycaster, loadedObjectGroup);

    if (!picked) {
        // 배경 클릭 시 Shift가 없으면 전체 해제
        if (!event.shiftKey) {
            if (callbacks.onDeselect) {
                callbacks.onDeselect();
            } else {
                beginSelectionReplace(callbacks, { detachTransform: true });
            }
        }
        commitSelectionChange(callbacks);
        return;
    }

    const { mesh, instanceId } = picked;
    const isShift = event.shiftKey;

    if (isShift) {
        // 다중 선택 (토글 로직)
        let set = currentSelection.objects.get(mesh);
        
        if (set && set.has(instanceId)) {
            // 이미 선택된 경우 제거
            set.delete(instanceId);
            if (set.size === 0) currentSelection.objects.delete(mesh);
            
            // 제거된 게 primary였다면 초기화 (commit 시 다음 후보가 primary가 됨)
            const p = currentSelection.primary as PrimaryObject | null;
            if (p?.type === 'object' && p.mesh === mesh && p.instanceId === instanceId) {
                currentSelection.primary = null;
            }
        } else {
            // 새로 선택 추가
            if (!set) {
                set = new Set();
                currentSelection.objects.set(mesh, set);
            }
            set.add(instanceId);
            
            // "처음 선택한 오브젝트가 기준" -> 이미 primary가 있다면 건드리지 않음
            if (!currentSelection.primary) {
                currentSelection.primary = { type: 'object', mesh, instanceId };
            }
        }
    } else {
        // 단일 선택 (기존 선택 교체)
        beginSelectionReplace(callbacks, { detachTransform: true });
        const set = new Set([instanceId]);
        currentSelection.objects.set(mesh, set);
        currentSelection.primary = { type: 'object', mesh, instanceId };
    }

    commitSelectionChange(callbacks);
}
