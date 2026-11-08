import {
    Vector3,
    Matrix4,
    Renderer,
    Camera,
    Group,
    Quaternion
} from 'three/webgpu';
import * as Select from './select';
import type { SelectionCallbacks } from './select';
import * as Overlay from './overlay';
import * as GroupUtils from '../grouping/group';
import { getVisibleInstanceIds } from '../scene-visibility';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import type { InstanceIdRange } from './instance-ranges';
import { matchesPointerShortcut } from '../input/shortcuts';
import { invalidateBatchBounds, objectBatches, objectRef, transformInstanceMatrices, type ObjectBatch } from '../../scene-store/object-access';
import { transformJointMirrorPlanes } from '../transform/mirror-planes';

interface OrbitControlsLike {
    enabled: boolean;
    target: Vector3;
    update(): void;
}

const _TMP_MAT4_A = new Matrix4();
const _TMP_CORNERS = new Array(8).fill(0).map(() => new Vector3());

export function projectedBoxIntersectsMarquee(
    corners: Vector3[],
    cornerCount: number,
    minX: number,
    maxX: number,
    minY: number,
    maxY: number
): boolean {
    const points = corners.slice(0, cornerCount).sort((a, b) => a.x - b.x || a.y - b.y);
    if (points.length === 0) return false;

    const hull: Vector3[] = [];
    const appendPoint = (point: Vector3) => {
        while (hull.length >= 2) {
            const a = hull[hull.length - 2];
            const b = hull[hull.length - 1];
            if ((b.x - a.x) * (point.y - a.y) - (b.y - a.y) * (point.x - a.x) > 0) break;
            hull.pop();
        }
        hull.push(point);
    };

    for (const point of points) appendPoint(point);
    const lowerLength = hull.length;
    for (let i = points.length - 2; i >= 0; i--) {
        while (hull.length > lowerLength) {
            const a = hull[hull.length - 2];
            const b = hull[hull.length - 1];
            const point = points[i];
            if ((b.x - a.x) * (point.y - a.y) - (b.y - a.y) * (point.x - a.x) > 0) break;
            hull.pop();
        }
        hull.push(points[i]);
    }
    hull.pop();

    for (let i = 0; i < hull.length; i++) {
        const a = hull[i];
        const b = hull[(i + 1) % hull.length];
        const axisX = a.y - b.y;
        const axisY = b.x - a.x;
        if (axisX === 0 && axisY === 0) continue;

        let hullMin = Infinity;
        let hullMax = -Infinity;
        for (const point of hull) {
            const projection = point.x * axisX + point.y * axisY;
            hullMin = Math.min(hullMin, projection);
            hullMax = Math.max(hullMax, projection);
        }

        const rectMin = Math.min(minX * axisX, maxX * axisX) + Math.min(minY * axisY, maxY * axisY);
        const rectMax = Math.max(minX * axisX, maxX * axisX) + Math.max(minY * axisY, maxY * axisY);
        if (hullMax < rectMin || hullMin > rectMax) return false;
    }

    return true;
}

export interface DragInitOptions {
    renderer: Renderer;
    getCamera: () => Camera;
    getControls: () => OrbitControlsLike;
    transformControls: TransformControls;
    loadedObjectGroup: Group;
    getSelectionCallbacks: () => SelectionCallbacks;
}

export interface DragInterface {
    abortMarquee: () => void;
    isMarqueeActiveOrCandidate: () => boolean;
    onPointerDown: (event: PointerEvent | MouseEvent) => boolean;
    onPointerMove: (event: PointerEvent | MouseEvent) => boolean;
    onPointerUp: (event: PointerEvent | MouseEvent) => boolean;
}

export interface ApplyDeltaParams {
    deltaMatrix: Matrix4;
    meshToInstanceIds?: Map<ObjectBatch, number[]>;
    meshToInstanceRanges?: Map<ObjectBatch, InstanceIdRange[]>;
    selectedGroupIds?: Set<string>;
    loadedObjectGroup: Group;
}

export function applyDeltaToSelection(params: ApplyDeltaParams): void {
    const { deltaMatrix, meshToInstanceIds, meshToInstanceRanges, selectedGroupIds, loadedObjectGroup } = params;

    const tmpMeshWorldInverse = new Matrix4();
    const tmpLocalDelta = new Matrix4();
    const meshToRanges = meshToInstanceRanges ?? new Map(
        Array.from(meshToInstanceIds ?? [], ([mesh, instanceIds]) => [
            mesh,
            instanceIds.map(start => ({ start, count: 1 }))
        ])
    );

    for (const [mesh, ranges] of meshToRanges) {
        tmpMeshWorldInverse.copy(mesh.matrixWorld).invert();
        tmpLocalDelta.multiplyMatrices(tmpMeshWorldInverse, deltaMatrix);
        tmpLocalDelta.multiply(mesh.matrixWorld);

        for (const { start, count } of ranges) transformInstanceMatrices(mesh, tmpLocalDelta, start, count);
        invalidateBatchBounds(mesh);
    }

    const toUpdate = new Set<string>();
    if (selectedGroupIds && selectedGroupIds.size > 0) {
        const groups = GroupUtils.getGroups(loadedObjectGroup);

        for (const rootId of selectedGroupIds) {
            if (!rootId) continue;
            toUpdate.add(rootId);
            const descendants = GroupUtils.getAllDescendantGroups(loadedObjectGroup, rootId);
            for (const subId of descendants) toUpdate.add(subId);
        }

        for (const id of toUpdate) {
            const g = groups.get(id);
            if (!g) continue;

            if (GroupUtils.shouldUseGroupPivot(g)) {
                g.pivot = GroupUtils.normalizePivotToVector3(g.pivot)?.applyMatrix4(deltaMatrix);
            }

            if (!g.matrix) {
                const gPos = g.position || new Vector3();
                const gQuat = g.quaternion || new Quaternion();
                const gScale = g.scale || new Vector3(1, 1, 1);
                g.matrix = new Matrix4().compose(gPos, gQuat, gScale);
            }

            g.matrix.premultiply(deltaMatrix);
            if (!g.position) g.position = new Vector3();
            if (!g.quaternion) g.quaternion = new Quaternion();
            if (!g.scale) g.scale = new Vector3(1, 1, 1);
            g.matrix.decompose(g.position, g.quaternion, g.scale);
        }
    }

    transformJointMirrorPlanes(loadedObjectGroup, deltaMatrix, uuid => {
        const ref = objectRef(loadedObjectGroup, uuid);
        return !!ref && !!meshToRanges.get(ref.mesh)?.some(({ start, count }) => ref.instanceId >= start && ref.instanceId < start + count);
    }, id => toUpdate.has(id));
}

/**
 * 드래그 및 영역 선택(Marquee Selection) 로직을 관리하는 모듈
 */
export function initDrag({
    renderer,
    getCamera,
    getControls,
    transformControls,
    loadedObjectGroup,
    getSelectionCallbacks
}: DragInitOptions): DragInterface {
    let marqueeActive = false;
    let marqueeCandidate = false;
    let marqueeIgnoreGroups = false;
    let marqueeStart: { x: number; y: number } | null = null;
    let marqueeDiv: HTMLDivElement | null = null;
    let marqueePrevControlsEnabled = true;

    const abortMarqueeNoControls = () => {
        marqueeActive = false;
        marqueeCandidate = false;
        marqueeIgnoreGroups = false;
        marqueeStart = null;
        if (marqueeDiv && marqueeDiv.parentElement) marqueeDiv.parentElement.removeChild(marqueeDiv);
        marqueeDiv = null;
    };

    const ensureMarqueeDiv = () => {
        if (marqueeDiv) return marqueeDiv;
        marqueeDiv = document.createElement('div');
        marqueeDiv.style.position = 'fixed';
        marqueeDiv.style.pointerEvents = 'none';
        marqueeDiv.style.border = '1px solid rgba(160,160,160,0.95)';
        marqueeDiv.style.background = 'rgba(160,160,160,0.12)';
        marqueeDiv.style.zIndex = '9999';
        marqueeDiv.style.left = '0px';
        marqueeDiv.style.top = '0px';
        marqueeDiv.style.width = '0px';
        marqueeDiv.style.height = '0px';
        document.body.appendChild(marqueeDiv);
        return marqueeDiv;
    };

    const updateMarqueeDiv = (x1: number, y1: number, x2: number, y2: number) => {
        const left = Math.min(x1, x2);
        const top = Math.min(y1, y2);
        const width = Math.abs(x2 - x1);
        const height = Math.abs(y2 - y1);
        const div = ensureMarqueeDiv();
        div.style.left = `${left}px`;
        div.style.top = `${top}px`;
        div.style.width = `${width}px`;
        div.style.height = `${height}px`;
    };

    const stopMarquee = () => {
        marqueeActive = false;
        marqueeCandidate = false;
        marqueeIgnoreGroups = false;
        marqueeStart = null;
        if (marqueeDiv && marqueeDiv.parentElement) marqueeDiv.parentElement.removeChild(marqueeDiv);
        marqueeDiv = null;
        getControls().enabled = marqueePrevControlsEnabled;
    };

    function _replaceSelectionWithObjectsMap(meshToIds: Map<ObjectBatch, Set<number>>, options?: { anchorMode?: string }) {
        Select.replaceSelectionWithObjects(Select.toObjectUuids(meshToIds), getSelectionCallbacks(), options);
    }

    function _replaceSelectionWithGroupsAndObjects(groupIds: Set<string> | null, meshToIds: Map<ObjectBatch, Set<number>>, options?: { anchorMode?: string }) {
        Select.replaceSelectionWithGroupsAndObjects(groupIds, Select.toObjectUuids(meshToIds), getSelectionCallbacks(), options);
    }

    return {
        abortMarquee: abortMarqueeNoControls,

        isMarqueeActiveOrCandidate: () => marqueeActive || marqueeCandidate,

        onPointerDown: (event: PointerEvent | MouseEvent) => {
            // 영역 선택 시작 (실제 드래그 발생 전까지는 후보 상태)
            if (matchesPointerShortcut(event, 'boxSelect') && !transformControls.dragging) {
                marqueeCandidate = true;
                marqueeIgnoreGroups = matchesPointerShortcut(event, 'multiSelect');
                marqueeStart = { x: event.clientX, y: event.clientY };
                marqueePrevControlsEnabled = getControls().enabled;
                // OrbitControls가 드래그를 시작하지 못하도록 비활성화
                getControls().enabled = false;
                return true; // 처리됨
            }
            return false;
        },

        onPointerMove: (event: PointerEvent | MouseEvent) => {
            if (!marqueeStart) return false;

            // 기즈모 조작 등 다른 상호작용이 시작되면 취소
            if (transformControls.dragging) {
                abortMarqueeNoControls();
                return false;
            }

            if (marqueeCandidate && !marqueeActive) {
                const dx = event.clientX - marqueeStart.x;
                const dy = event.clientY - marqueeStart.y;
                const dist = Math.sqrt(dx * dx + dy * dy);
                const threshold = 6;
                if (dist >= threshold) {
                    marqueeActive = true;
                    marqueeCandidate = false;
                    getControls().enabled = false;
                    ensureMarqueeDiv();
                }
            }

            if (!marqueeActive) return false;
            updateMarqueeDiv(marqueeStart.x, marqueeStart.y, event.clientX, event.clientY);
            return true;
        },

        onPointerUp: (event: PointerEvent | MouseEvent) => {
            if (marqueeStart && transformControls.dragging) {
                abortMarqueeNoControls();
                return false;
            }

            if (marqueeActive && marqueeStart) {
                event.preventDefault();

                const ignoreGroups = marqueeIgnoreGroups;
                const canvasRect = renderer.domElement.getBoundingClientRect();
                const x1 = marqueeStart.x;
                const y1 = marqueeStart.y;
                const x2 = event.clientX;
                const y2 = event.clientY;

                const left = Math.max(canvasRect.left, Math.min(x1, x2));
                const right = Math.min(canvasRect.right, Math.max(x1, x2));
                const top = Math.max(canvasRect.top, Math.min(y1, y2));
                const bottom = Math.min(canvasRect.bottom, Math.max(y1, y2));

                stopMarquee();

                const minSize = 6;
                if ((right - left) < minSize || (bottom - top) < minSize) {
                    return true;
                }

                const minX = left - canvasRect.left;
                const maxX = right - canvasRect.left;
                const minY = top - canvasRect.top;
                const maxY = bottom - canvasRect.top;

                const groupIds = ignoreGroups ? null : new Set<string>();
                const meshToIds = new Map<ObjectBatch, Set<number>>();
                const tmpMat = _TMP_MAT4_A;
                const camera = getCamera();


                for (const mesh of objectBatches(loadedObjectGroup)) {
                    if (mesh.visible === false) continue;
                    for (const instanceId of getVisibleInstanceIds(mesh)) {
                        if (!Overlay.isInstanceValid(mesh, instanceId)) continue;

                        const bbox = Overlay.getInstanceLocalBox(mesh, instanceId);
                        if (!bbox) continue;

                        Overlay.getInstanceWorldMatrix(mesh, instanceId, tmpMat);

                        // 투영된 바운딩 박스 계산을 위한 코너 좌표
                        _TMP_CORNERS[0].set(bbox.min.x, bbox.min.y, bbox.min.z);
                        _TMP_CORNERS[1].set(bbox.max.x, bbox.min.y, bbox.min.z);
                        _TMP_CORNERS[2].set(bbox.min.x, bbox.max.y, bbox.min.z);
                        _TMP_CORNERS[3].set(bbox.min.x, bbox.min.y, bbox.max.z);
                        _TMP_CORNERS[4].set(bbox.max.x, bbox.max.y, bbox.min.z);
                        _TMP_CORNERS[5].set(bbox.max.x, bbox.min.y, bbox.max.z);
                        _TMP_CORNERS[6].set(bbox.min.x, bbox.max.y, bbox.max.z);
                        _TMP_CORNERS[7].set(bbox.max.x, bbox.max.y, bbox.max.z);

                        let minSx = Infinity, maxSx = -Infinity;
                        let minSy = Infinity, maxSy = -Infinity;
                        let validCornerCount = 0;

                        for (let i = 0; i < 8; i++) {
                            const v = _TMP_CORNERS[i];
                            v.applyMatrix4(tmpMat);
                            v.project(camera);

                            if (v.z < -1 || v.z > 1) continue;

                            const sx = (v.x * 0.5 + 0.5) * canvasRect.width;
                            const sy = (-v.y * 0.5 + 0.5) * canvasRect.height;

                            _TMP_CORNERS[validCornerCount++].set(sx, sy, v.z);

                            if (sx < minSx) minSx = sx;
                            if (sx > maxSx) maxSx = sx;
                            if (sy < minSy) minSy = sy;
                            if (sy > maxSy) maxSy = sy;
                        }

                        if (validCornerCount === 0) continue;
                        if (minSx > maxX || maxSx < minX || minSy > maxY || maxSy < minY) continue;
                        if (!projectedBoxIntersectsMarquee(_TMP_CORNERS, validCornerCount, minX, maxX, minY, maxY)) continue;

                        if (!ignoreGroups) {
                            const immediateGroupId = GroupUtils.getSlotGroupId(loadedObjectGroup, mesh, instanceId);
                            if (immediateGroupId) {
                                const chain = GroupUtils.getGroupChain(loadedObjectGroup, immediateGroupId);
                                if (groupIds) groupIds.add(chain[0] ?? immediateGroupId);
                                continue;
                            }
                        }

                        let set = meshToIds.get(mesh);
                        if (!set) {
                            set = new Set<number>();
                            meshToIds.set(mesh, set);
                        }
                        set.add(instanceId);
                    }
                }

                if (ignoreGroups) {
                    _replaceSelectionWithObjectsMap(meshToIds, { anchorMode: 'center' });
                } else {
                    _replaceSelectionWithGroupsAndObjects(groupIds, meshToIds, { anchorMode: 'center' });
                }
                return true;
            }

            if (marqueeCandidate) {
                marqueeCandidate = false;
                marqueeIgnoreGroups = false;
                marqueeStart = null;
                getControls().enabled = marqueePrevControlsEnabled;
                return false; 
            }
            
            return false;
        }
    };
}
