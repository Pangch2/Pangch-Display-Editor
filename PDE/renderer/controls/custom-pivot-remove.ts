import * as THREE from 'three/webgpu';

interface SelectionElement {
    type: 'group' | 'object';
    id?: string;
    mesh?: THREE.Mesh | THREE.BatchedMesh | THREE.InstancedMesh;
    instanceId?: number;
}

interface CurrentSelection {
    primary?: SelectionElement;
    groups?: Set<string>;
    objects?: Map<THREE.Mesh | THREE.BatchedMesh | THREE.InstancedMesh, Set<number>>;
}

interface PivotFlags {
    isCustomPivot: boolean;
    multiExplicitPivot: boolean;
    multiAnchorValid: boolean;
    multiAnchorInitialValid: boolean;
    multiAnchorInitialLocalValid: boolean;
    gizmoAnchorValid: boolean;
    selectionAnchorMode: 'default' | 'center';
}

interface PivotDeps {
    isMultiSelection: () => boolean;
    revertEphemeralPivotUndoIfAny: () => void;
    resolveMultiAnchorInitialWorld: (out: THREE.Vector3) => THREE.Vector3 | null;
    setMultiAnchorInitial: (worldPos: THREE.Vector3) => void;
    getGroups: () => Map<string, any>;
    getGroupOriginWorld: (groupId: string, out: THREE.Vector3) => THREE.Vector3;
    shouldUseGroupPivot: (group: any) => boolean;
    normalizePivotToVector3: (pivot: any, out: THREE.Vector3) => THREE.Vector3 | null;
    getGroupWorldMatrix: (group: any, out: THREE.Matrix4) => THREE.Matrix4;
    getDisplayType: (mesh: any, instanceId?: number) => string;
    getInstanceLocalBoxMin: (mesh: any, instanceId: number | undefined, out: THREE.Vector3) => THREE.Vector3 | null;
    getInstanceWorldMatrixForOrigin: (mesh: any, instanceId: number | undefined, out: THREE.Matrix4) => THREE.Matrix4;
    isItemDisplayHatEnabled: (mesh: any, instanceId?: number) => boolean;
    DEFAULT_GROUP_PIVOT: THREE.Vector3;
}

/**
 * Resets the custom pivot for the current selection (triggered by Alt+Ctrl).
 */
export function resetCustomPivot(
    currentSelection: CurrentSelection,
    pivotOffset: THREE.Vector3,
    multiAnchorPos: THREE.Vector3,
    gizmoAnchorPos: THREE.Vector3,
    flags: PivotFlags,
    deps: PivotDeps
): void {
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
    const hadExplicitMultiPivot = isMultiReset && flags.multiExplicitPivot;

    // Reset should also drop any ephemeral multi-selection pivot edits.
    revertEphemeralPivotUndoIfAny();

    pivotOffset.set(0, 0, 0);
    flags.isCustomPivot = false;
    flags.multiExplicitPivot = false;

    if (isMultiReset) {
        if (hadExplicitMultiPivot) {
            const _resolvedInitial = resolveMultiAnchorInitialWorld(new THREE.Vector3());
            if (_resolvedInitial) {
                multiAnchorPos.copy(_resolvedInitial);
                flags.multiAnchorValid = true;
                gizmoAnchorPos.copy(_resolvedInitial);
                flags.gizmoAnchorValid = true;
                flags.selectionAnchorMode = 'default';
            } else {
                const targetPos = new THREE.Vector3();
                let found = false;
                if (currentSelection.primary) {
                    const prim = currentSelection.primary;
                    if (prim.type === 'group' && prim.id) {
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
                        if ((mesh as any).isBatchedMesh || (mesh as any).isInstancedMesh) {
                            if (mesh.userData.customPivots && mesh.userData.customPivots.has(instanceId))
                                custom = mesh.userData.customPivots.get(instanceId);
                        } else { if (mesh.userData.customPivot) custom = mesh.userData.customPivot; }
                        
                        if (custom) {
                            (mesh as any).getMatrixAt(instanceId, tempMat);
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
                    setMultiAnchorInitial(targetPos);
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
                    if (((mesh as any).isBatchedMesh || (mesh as any).isInstancedMesh) && mesh.userData.customPivots) {
                        for (const id of ids) mesh.userData.customPivots.delete(id);
                    }
                    delete mesh.userData.customPivot;
                    delete mesh.userData.isCustomPivot;
                }
            }

            const targetPos = new THREE.Vector3();
            let found = false;

            if (currentSelection.primary) {
                const prim = currentSelection.primary;
                if (prim.type === 'group' && prim.id) {
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
                setMultiAnchorInitial(targetPos);
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
                if (((mesh as any).isBatchedMesh || (mesh as any).isInstancedMesh) && mesh.userData.customPivots) {
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
