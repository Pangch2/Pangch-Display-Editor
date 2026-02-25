import * as THREE from 'three/webgpu';
import * as Select from './select.js';
import * as Overlay from './overlay.js';
import * as GroupUtils from './group.js';

const getInstanceCount = Overlay.getInstanceCount;
const isInstanceValid = Overlay.isInstanceValid;
const getInstanceWorldMatrixForOrigin = Overlay.getInstanceWorldMatrixForOrigin;
const isItemDisplayHatEnabled = Overlay.isItemDisplayHatEnabled;
const getGroupKey = GroupUtils.getGroupKey;
const getGroupChain = GroupUtils.getGroupChain;
const getObjectToGroup = GroupUtils.getObjectToGroup;

const _TMP_MAT4_A = new THREE.Matrix4();
const _TMP_VEC3_A = new THREE.Vector3();
const _TMP_VEC3_B = new THREE.Vector3();
const _TMP_CORNERS = new Array(8).fill(0).map(() => new THREE.Vector3());

export function initDrag({
    renderer,
    camera,
    getControls,
    transformControls,
    loadedObjectGroup,
    getSelectionCallbacks // Function that returns the callbacks object
}) {
    let marqueeActive = false;
    let marqueeCandidate = false;
    let marqueeIgnoreGroups = false;
    let marqueeStart = null;
    let marqueeDiv = null;
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

    const updateMarqueeDiv = (x1, y1, x2, y2) => {
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

    function _replaceSelectionWithObjectsMap(meshToIds, options) {
        Select.replaceSelectionWithObjectsMap(meshToIds, getSelectionCallbacks(), options);
    }

    function _replaceSelectionWithGroupsAndObjects(groupIds, meshToIds, options) {
        Select.replaceSelectionWithGroupsAndObjects(groupIds, meshToIds, getSelectionCallbacks(), options);
    }

    return {
        abortMarquee: abortMarqueeNoControls,

        isMarqueeActiveOrCandidate: () => marqueeActive || marqueeCandidate,

        onPointerDown: (event) => {
            // Ctrl+Drag: marquee selection (start only after the user actually drags)
            if ((event.ctrlKey || event.metaKey) && !transformControls.dragging) {
                // NOTE: We do not raycast here to allow marquee candidate start.
                marqueeCandidate = true;
                marqueeIgnoreGroups = !!event.shiftKey;
                marqueeStart = { x: event.clientX, y: event.clientY };
                marqueePrevControlsEnabled = getControls().enabled;
                // Prevent OrbitControls from starting a drag
                getControls().enabled = false;
                return true; // Handled
            }
            return false;
        },

        onPointerMove: (event) => {
            if (!marqueeStart) return false;

            // If another interaction takes over (e.g. user grabbed the gizmo), abort marquee.
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

        onPointerUp: (event) => {
             // If TransformControls is handling a drag, marquee should not run.
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

                const groupIds = ignoreGroups ? null : new Set();
                const meshToIds = new Map();
                const tmpMat = _TMP_MAT4_A;
                const tmpWorld = _TMP_VEC3_A;
                const tmpNdc = _TMP_VEC3_B;

                const objectToGroup = ignoreGroups ? null : getObjectToGroup(loadedObjectGroup);

                loadedObjectGroup.traverse((obj) => {
                    if (!obj || (!obj.isInstancedMesh && !obj.isBatchedMesh)) return;
                    if (obj.visible === false) return;

                    if (!obj.geometry.boundingBox) obj.geometry.computeBoundingBox();
                    const bbox = obj.geometry.boundingBox;

                    const instanceCount = getInstanceCount(obj);
                    if (instanceCount <= 0) return;

                    for (let instanceId = 0; instanceId < instanceCount; instanceId++) {
                        if (!isInstanceValid(obj, instanceId)) continue;

                        getInstanceWorldMatrixForOrigin(obj, instanceId, tmpMat);
                        const localYOffset = isItemDisplayHatEnabled(obj, instanceId) ? 0.03125 : 0;

                        // Calculate projected bounding box
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
                            const key = getGroupKey(obj, instanceId);
                            const immediateGroupId = objectToGroup.get(key);
                            if (immediateGroupId) {
                                const chain = getGroupChain(loadedObjectGroup, immediateGroupId);
                                const root = chain && chain.length > 0 ? chain[0] : immediateGroupId;
                                if (root) groupIds.add(root);
                                continue;
                            }
                        }

                        let set = meshToIds.get(obj);
                        if (!set) {
                            set = new Set();
                            meshToIds.set(obj, set);
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

            // Ctrl+Click should still work (group bypass) when no marquee actually started.
            if (marqueeCandidate) {
                marqueeCandidate = false;
                marqueeIgnoreGroups = false;
                marqueeStart = null;
                getControls().enabled = marqueePrevControlsEnabled;
                // We return false here so that the "click selection" logic in the caller can proceed
                // (e.g. gizmo.js handling the click)
                return false; 
            }
            
            return false;
        }
    };
}
