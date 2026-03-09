import * as THREE from 'three/webgpu';
import * as Select from './select';
import type { SelectionCallbacks } from './select';
import * as Overlay from './overlay.js';
import * as GroupUtils from './group';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';

// Helper aliases
const { getInstanceCount, isInstanceValid, getInstanceWorldMatrixForOrigin, isItemDisplayHatEnabled } = Overlay;
const { getGroupKey, getGroupChain, getObjectToGroup } = GroupUtils;

interface OrbitControlsLike {
    enabled: boolean;
    target: THREE.Vector3;
    update(): void;
}

const _TMP_MAT4_A = new THREE.Matrix4();
const _TMP_CORNERS = new Array(8).fill(0).map(() => new THREE.Vector3());

export interface DragInitOptions {
    renderer: THREE.Renderer;
    camera: THREE.Camera;
    getControls: () => OrbitControlsLike;
    transformControls: TransformControls;
    loadedObjectGroup: THREE.Group;
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
    deltaMatrix: THREE.Matrix4;
    meshToInstanceIds: Map<THREE.Object3D, number[]>;
    selectedGroupIds: Set<string>;
    loadedObjectGroup: THREE.Group;
}

export function applyDeltaToSelection(params: ApplyDeltaParams): void {
    const { deltaMatrix, meshToInstanceIds, selectedGroupIds, loadedObjectGroup } = params;

    const tmpMeshWorldInverse = new THREE.Matrix4();
    const tmpLocalDelta = new THREE.Matrix4();
    const tmpInstanceMatrix = new THREE.Matrix4();

    for (const [mesh, instanceIds] of meshToInstanceIds) {
        tmpMeshWorldInverse.copy((mesh as THREE.Object3D).matrixWorld).invert();
        tmpLocalDelta.multiplyMatrices(tmpMeshWorldInverse, deltaMatrix);
        tmpLocalDelta.multiply((mesh as THREE.Object3D).matrixWorld);

        for (let i = 0; i < instanceIds.length; i++) {
            const instanceId = instanceIds[i];
            (mesh as THREE.InstancedMesh).getMatrixAt(instanceId, tmpInstanceMatrix);
            tmpInstanceMatrix.premultiply(tmpLocalDelta);
            (mesh as THREE.InstancedMesh).setMatrixAt(instanceId, tmpInstanceMatrix);
        }

        if ((mesh as THREE.InstancedMesh).isInstancedMesh) {
            (mesh as THREE.InstancedMesh).instanceMatrix.needsUpdate = true;
        }
    }

    if (selectedGroupIds && selectedGroupIds.size > 0) {
        const groups = GroupUtils.getGroups(loadedObjectGroup);
        const toUpdate = new Set<string>();

        for (const rootId of selectedGroupIds) {
            if (!rootId) continue;
            toUpdate.add(rootId);
            const descendants = GroupUtils.getAllDescendantGroups(loadedObjectGroup, rootId);
            for (const subId of descendants) toUpdate.add(subId);
        }

        for (const id of toUpdate) {
            const g = groups.get(id);
            if (!g) continue;

            if (!g.matrix) {
                const gPos = g.position || new THREE.Vector3();
                const gQuat = g.quaternion || new THREE.Quaternion();
                const gScale = g.scale || new THREE.Vector3(1, 1, 1);
                g.matrix = new THREE.Matrix4().compose(gPos, gQuat, gScale);
            }

            g.matrix.premultiply(deltaMatrix);
            if (!g.position) g.position = new THREE.Vector3();
            if (!g.quaternion) g.quaternion = new THREE.Quaternion();
            if (!g.scale) g.scale = new THREE.Vector3(1, 1, 1);
            g.matrix.decompose(g.position, g.quaternion, g.scale);
        }
    }
}

/**
 * 드래그 및 영역 선택(Marquee Selection) 로직을 관리하는 모듈
 */
export function initDrag({
    renderer,
    camera,
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

    function _replaceSelectionWithObjectsMap(meshToIds: Map<THREE.Mesh | THREE.BatchedMesh | THREE.InstancedMesh, Set<number>>, options?: { anchorMode?: string }) {
        Select.replaceSelectionWithObjectsMap(meshToIds, getSelectionCallbacks(), options);
    }

    function _replaceSelectionWithGroupsAndObjects(groupIds: Set<string> | null, meshToIds: Map<THREE.Mesh | THREE.BatchedMesh | THREE.InstancedMesh, Set<number>>, options?: { anchorMode?: string }) {
        Select.replaceSelectionWithGroupsAndObjects(groupIds!, meshToIds, getSelectionCallbacks(), options);
    }

    return {
        abortMarquee: abortMarqueeNoControls,

        isMarqueeActiveOrCandidate: () => marqueeActive || marqueeCandidate,

        onPointerDown: (event: PointerEvent | MouseEvent) => {
            // Ctrl+Drag: 영역 선택 시작 (실제 드래그 발생 전까지는 후보 상태)
            if ((event.ctrlKey || event.metaKey) && !transformControls.dragging) {
                marqueeCandidate = true;
                marqueeIgnoreGroups = !!event.shiftKey;
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
                const meshToIds = new Map<THREE.Mesh | THREE.BatchedMesh | THREE.InstancedMesh, Set<number>>();
                const tmpMat = _TMP_MAT4_A;

                const objectToGroup = ignoreGroups ? null : getObjectToGroup(loadedObjectGroup) as Map<string, string>;

                loadedObjectGroup.traverse((obj: THREE.Object3D) => {
                    if (!obj || (!(obj as THREE.InstancedMesh).isInstancedMesh && !(obj as THREE.BatchedMesh).isBatchedMesh)) return;
                    if (obj.visible === false) return;

                    if (!(obj as THREE.Mesh).geometry?.boundingBox) (obj as THREE.Mesh).geometry?.computeBoundingBox();
                    const bbox = (obj as THREE.Mesh).geometry?.boundingBox;
                    if (!bbox) return;

                    const instanceCount = getInstanceCount(obj as THREE.InstancedMesh | THREE.BatchedMesh);
                    if (instanceCount <= 0) return;

                    for (let instanceId = 0; instanceId < instanceCount; instanceId++) {
                        if (!isInstanceValid(obj as THREE.InstancedMesh | THREE.BatchedMesh, instanceId)) continue;

                        getInstanceWorldMatrixForOrigin(obj as THREE.InstancedMesh | THREE.BatchedMesh, instanceId, tmpMat);
                        const localYOffset = isItemDisplayHatEnabled(obj as THREE.InstancedMesh | THREE.BatchedMesh, instanceId) ? 0.03125 : 0;

                        // 투영된 바운딩 박스 계산을 위한 코너 좌표
                        _TMP_CORNERS[0].set(bbox.min.x, bbox.min.y + localYOffset, bbox.min.z);
                        _TMP_CORNERS[1].set(bbox.max.x, bbox.min.y + localYOffset, bbox.min.z);
                        _TMP_CORNERS[2].set(bbox.min.x, bbox.max.y + localYOffset, bbox.min.z);
                        _TMP_CORNERS[3].set(bbox.min.x, bbox.min.y + localYOffset, bbox.max.z);
                        _TMP_CORNERS[4].set(bbox.max.x, bbox.max.y + localYOffset, bbox.min.z);
                        _TMP_CORNERS[5].set(bbox.max.x, bbox.min.y + localYOffset, bbox.max.z);
                        _TMP_CORNERS[6].set(bbox.min.x, bbox.max.y + localYOffset, bbox.max.z);
                        _TMP_CORNERS[7].set(bbox.max.x, bbox.max.y + localYOffset, bbox.max.z);

                        let minSx = Infinity, maxSx = -Infinity;
                        let minSy = Infinity, maxSy = -Infinity;
                        let validCornerCount = 0;

                        for (let i = 0; i < 8; i++) {
                            const v = _TMP_CORNERS[i];
                            v.applyMatrix4(tmpMat);
                            v.project(camera);

                            if (v.z < -1 || v.z > 1) continue;

                            validCornerCount++;
                            const sx = (v.x * 0.5 + 0.5) * canvasRect.width;
                            const sy = (-v.y * 0.5 + 0.5) * canvasRect.height;

                            if (sx < minSx) minSx = sx;
                            if (sx > maxSx) maxSx = sx;
                            if (sy < minSy) minSy = sy;
                            if (sy > maxSy) maxSy = sy;
                        }

                        if (validCornerCount === 0) continue;
                        if (minSx > maxX || maxSx < minX || minSy > maxY || maxSy < minY) continue;

                        if (!ignoreGroups && objectToGroup) {
                            const key = getGroupKey(obj as THREE.InstancedMesh | THREE.BatchedMesh, instanceId);
                            const immediateGroupId = objectToGroup.get(key);
                            if (immediateGroupId) {
                                const chain = getGroupChain(loadedObjectGroup, immediateGroupId) as string[];
                                const root = chain && chain.length > 0 ? chain[0] : immediateGroupId;
                                if (root && groupIds) groupIds.add(root);
                                continue;
                            }
                        }

                        let set = meshToIds.get(obj as THREE.InstancedMesh | THREE.BatchedMesh);
                        if (!set) {
                            set = new Set<number>();
                            meshToIds.set(obj as THREE.InstancedMesh | THREE.BatchedMesh, set);
                        }
                        set.add(instanceId);
                    }
                });

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
