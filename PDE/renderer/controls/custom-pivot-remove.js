import * as THREE from 'three/webgpu';

/**
 * Resets the custom pivot for the current selection (triggered by Alt+Ctrl).
 *
 * @param {object} currentSelection - The current selection state (groups, objects, primary).
 * @param {THREE.Vector3} pivotOffset - Mutated in-place: reset to (0,0,0).
 * @param {THREE.Vector3} multiAnchorPos - _multiSelectionOriginAnchorPosition, mutated in-place.
 * @param {THREE.Vector3} gizmoAnchorPos - _gizmoAnchorPosition, mutated in-place.
 * @param {object} flags - Mutable flag state:
 *   {
 *     isCustomPivot,                 // boolean (read/write)
 *     multiExplicitPivot,            // boolean (read/write) — _multiSelectionExplicitPivot
 *     multiAnchorValid,              // boolean (write) — _multiSelectionOriginAnchorValid
 *     multiAnchorInitialValid,       // boolean (write) — _multiSelectionOriginAnchorInitialValid
 *     multiAnchorInitialLocalValid,  // boolean (write) — _multiSelectionOriginAnchorInitialLocalValid
 *     gizmoAnchorValid,              // boolean (write) — _gizmoAnchorValid
 *     selectionAnchorMode,           // string  (write) — _selectionAnchorMode
 *   }
 * @param {object} deps - Dependencies / callbacks:
 *   {
 *     isMultiSelection,           // () => bool
 *     revertEphemeralPivotUndoIfAny, // () => void
 *     resolveMultiAnchorInitialWorld, // (out: THREE.Vector3) => THREE.Vector3 | null
 *     setMultiAnchorInitial,      // (worldPos: THREE.Vector3) => void
 *     getGroups,                  // () => Map
 *     getGroupOriginWorld,        // (groupId, out) => THREE.Vector3
 *     shouldUseGroupPivot,        // (group) => bool
 *     normalizePivotToVector3,    // (pivot, out) => THREE.Vector3 | null
 *     getGroupWorldMatrix,        // (group, out) => THREE.Matrix4
 *     getDisplayType,             // (mesh, instanceId) => string
 *     getInstanceLocalBoxMin,     // (mesh, instanceId, out) => THREE.Vector3 | null
 *     getInstanceWorldMatrixForOrigin, // (mesh, instanceId, out) => THREE.Matrix4
 *     isItemDisplayHatEnabled,    // (mesh, instanceId) => bool
 *     DEFAULT_GROUP_PIVOT,        // THREE.Vector3
 *   }
 */
export function resetCustomPivot(
    currentSelection,
    pivotOffset,
    multiAnchorPos,
    gizmoAnchorPos,
    flags,
    deps
) {
    const {
        isMultiSelection,
        revertEphemeralPivotUndoIfAny,
        resolveMultiAnchorInitialWorld,
        setMultiAnchorInitial,
        getGroups,
        getGroupOriginWorld,
        shouldUseGroupPivot,
        normalizePivotToVector3,
        getGroupWorldMatrix,
        getDisplayType,
        getInstanceLocalBoxMin,
        getInstanceWorldMatrixForOrigin,
        isItemDisplayHatEnabled,
        DEFAULT_GROUP_PIVOT,
    } = deps;

    const isMultiReset = isMultiSelection();
    // Use the dedicated flag — not isCustomPivot, which can be inherited from
    // single-object context via preserveMultiCustomPivot and cause a two-press bug.
    const hadExplicitMultiPivot = isMultiReset && flags.multiExplicitPivot;

    // Reset should also drop any ephemeral multi-selection pivot edits.
    revertEphemeralPivotUndoIfAny();

    pivotOffset.set(0, 0, 0);
    flags.isCustomPivot = false;
    flags.multiExplicitPivot = false;

    if (isMultiReset) {
        if (hadExplicitMultiPivot) {
            // Had an explicitly created multi-selection custom pivot → revert it.
            // Individual object/group pivots are preserved.
            // Gizmo restores to the initial anchor recomputed from primary-local coords
            // so it correctly follows the object after moves (not a stale world snapshot).
            const _resolvedInitial = resolveMultiAnchorInitialWorld(new THREE.Vector3());
            if (_resolvedInitial) {
                multiAnchorPos.copy(_resolvedInitial);
                flags.multiAnchorValid = true;
                gizmoAnchorPos.copy(_resolvedInitial);
                flags.gizmoAnchorValid = true;
                flags.selectionAnchorMode = 'default';
            } else {
                // Fallback: live-compute from primary's current transform (with its own pivot respected).
                const targetPos = new THREE.Vector3();
                let found = false;
                if (currentSelection.primary) {
                    const prim = currentSelection.primary;
                    if (prim.type === 'group') {
                        const groups = getGroups();
                        const group = groups.get(prim.id);
                        if (group) {
                            if (shouldUseGroupPivot(group)) {
                                const localPivot = normalizePivotToVector3(group.pivot, new THREE.Vector3());
                                if (localPivot) {
                                    const groupMatrix = getGroupWorldMatrix(group, new THREE.Matrix4());
                                    targetPos.copy(localPivot.applyMatrix4(groupMatrix));
                                    found = true;
                                }
                            }
                            if (!found) { getGroupOriginWorld(prim.id, targetPos); found = true; }
                        }
                    } else if (prim.type === 'object' && prim.mesh) {
                        const { mesh, instanceId } = prim;
                        const tempMat = new THREE.Matrix4();
                        let custom = null;
                        if (mesh.isBatchedMesh || mesh.isInstancedMesh) {
                            if (mesh.userData.customPivots && mesh.userData.customPivots.has(instanceId))
                                custom = mesh.userData.customPivots.get(instanceId);
                        } else { if (mesh.userData.customPivot) custom = mesh.userData.customPivot; }
                        if (custom) {
                            mesh.getMatrixAt(instanceId, tempMat);
                            tempMat.premultiply(mesh.matrixWorld);
                            targetPos.copy(custom.clone().applyMatrix4(tempMat)); found = true;
                        }
                        if (!found) {
                            const displayType = getDisplayType(mesh, instanceId);
                            if (displayType === 'block_display') {
                                const localPivot = getInstanceLocalBoxMin(mesh, instanceId, new THREE.Vector3());
                                if (localPivot) {
                                    const worldMatrix = getInstanceWorldMatrixForOrigin(mesh, instanceId, tempMat);
                                    targetPos.copy(localPivot.applyMatrix4(worldMatrix)); found = true;
                                }
                            }
                            if (!found) {
                                getInstanceWorldMatrixForOrigin(mesh, instanceId, tempMat);
                                const localY = isItemDisplayHatEnabled(mesh, instanceId) ? 0.03125 : 0;
                                targetPos.set(0, localY, 0).applyMatrix4(tempMat); found = true;
                            }
                        }
                    }
                }

                if (found) {
                    multiAnchorPos.copy(targetPos);
                    flags.multiAnchorValid = true;
                    setMultiAnchorInitial(targetPos); // also sets multiAnchorInitialValid / LocalValid
                    gizmoAnchorPos.copy(targetPos);
                    flags.gizmoAnchorValid = true;
                    flags.selectionAnchorMode = 'default';
                } else {
                    flags.multiAnchorValid = false;
                    flags.multiAnchorInitialValid = false;
                    flags.multiAnchorInitialLocalValid = false;
                    flags.gizmoAnchorValid = false;
                    flags.selectionAnchorMode = 'center';
                }
            }
        } else {
            // No explicit custom pivot was active: clear ALL per-object/group pivots.
            if (currentSelection.groups && currentSelection.groups.size > 0) {
                const groups = getGroups();
                for (const groupId of currentSelection.groups) {
                    const group = groups.get(groupId);
                    if (!group) continue;
                    group.pivot = DEFAULT_GROUP_PIVOT.clone();
                    delete group.isCustomPivot;
                }
            }
            if (currentSelection.objects && currentSelection.objects.size > 0) {
                for (const [mesh, ids] of currentSelection.objects) {
                    if (!mesh) continue;
                    if ((mesh.isBatchedMesh || mesh.isInstancedMesh) && mesh.userData.customPivots) {
                        for (const id of ids) mesh.userData.customPivots.delete(id);
                    }
                    delete mesh.userData.customPivot;
                    delete mesh.userData.isCustomPivot;
                }
            }

            // Recompute gizmo from primary's CURRENT live transform (pivots now cleared).
            const targetPos = new THREE.Vector3();
            let found = false;

            if (currentSelection.primary) {
                const prim = currentSelection.primary;

                if (prim.type === 'group') {
                    // Pivots cleared above → shouldUseGroupPivot is false → getGroupOriginWorld.
                    getGroupOriginWorld(prim.id, targetPos);
                    found = true;
                } else if (prim.type === 'object' && prim.mesh) {
                    const { mesh, instanceId } = prim;
                    const tempMat = new THREE.Matrix4();
                    const displayType = getDisplayType(mesh, instanceId);
                    if (displayType === 'block_display') {
                        const localPivot = getInstanceLocalBoxMin(mesh, instanceId, new THREE.Vector3());
                        if (localPivot) {
                            const worldMatrix = getInstanceWorldMatrixForOrigin(mesh, instanceId, tempMat);
                            targetPos.copy(localPivot.applyMatrix4(worldMatrix));
                            found = true;
                        }
                    }
                    if (!found) {
                        getInstanceWorldMatrixForOrigin(mesh, instanceId, tempMat);
                        const localY = isItemDisplayHatEnabled(mesh, instanceId) ? 0.03125 : 0;
                        targetPos.set(0, localY, 0).applyMatrix4(tempMat);
                        found = true;
                    }
                }
            }

            if (found) {
                multiAnchorPos.copy(targetPos);
                flags.multiAnchorValid = true;
                setMultiAnchorInitial(targetPos); // also sets multiAnchorInitialValid / LocalValid
                gizmoAnchorPos.copy(targetPos);
                flags.gizmoAnchorValid = true;
                flags.selectionAnchorMode = 'default';
            } else {
                flags.multiAnchorValid = false;
                flags.multiAnchorInitialValid = false;
                flags.multiAnchorInitialLocalValid = false;
                flags.gizmoAnchorValid = false;
                flags.selectionAnchorMode = 'center';
            }
        }
    } else {
        // Single selection: clear ALL individual pivots and reset to geometric origin.
        if (currentSelection.groups && currentSelection.groups.size > 0) {
            const groups = getGroups();
            for (const groupId of currentSelection.groups) {
                const group = groups.get(groupId);
                if (!group) continue;
                group.pivot = DEFAULT_GROUP_PIVOT.clone();
                delete group.isCustomPivot;
            }
        }

        if (currentSelection.objects && currentSelection.objects.size > 0) {
            for (const [mesh, ids] of currentSelection.objects) {
                if (!mesh) continue;
                if ((mesh.isBatchedMesh || mesh.isInstancedMesh) && mesh.userData.customPivots) {
                    for (const id of ids) mesh.userData.customPivots.delete(id);
                }
                delete mesh.userData.customPivot;
                delete mesh.userData.isCustomPivot;
            }
        }

        flags.multiAnchorValid = false;
        flags.selectionAnchorMode = 'default';
    }
}
