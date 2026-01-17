import * as THREE from 'three/webgpu';

// Constants
export const DEFAULT_GROUP_PIVOT = new THREE.Vector3(0.5, 0.5, 0.5);
const _ZERO_VEC3 = new THREE.Vector3(0, 0, 0); // Used internally if needed, or export if needed

// Utils
function _nearlyEqual(a, b, eps = 1e-6) {
    return Math.abs(a - b) <= eps;
}

export function normalizePivotToVector3(pivot, out = new THREE.Vector3()) {
    if (!pivot) return null;
    if (pivot.isVector3) return out.copy(pivot);
    if (Array.isArray(pivot) && pivot.length >= 3) return out.set(pivot[0], pivot[1], pivot[2]);
    if (typeof pivot === 'object' && pivot.x !== undefined && pivot.y !== undefined && pivot.z !== undefined) {
        return out.set(pivot.x, pivot.y, pivot.z);
    }
    return null;
}

export function isCustomGroupPivot(pivot) {
    const v = normalizePivotToVector3(pivot, new THREE.Vector3());
    if (!v) return false;
    return !(
        _nearlyEqual(v.x, DEFAULT_GROUP_PIVOT.x) &&
        _nearlyEqual(v.y, DEFAULT_GROUP_PIVOT.y) &&
        _nearlyEqual(v.z, DEFAULT_GROUP_PIVOT.z)
    );
}

export function shouldUseGroupPivot(group) {
    if (!group) return false;
    if (group.isCustomPivot) return true;
    return isCustomGroupPivot(group.pivot);
}

// Accessors
export function getGroups(loadedObjectGroup) {
    if (!loadedObjectGroup || !loadedObjectGroup.userData) return new Map();
    if (!loadedObjectGroup.userData.groups) {
        loadedObjectGroup.userData.groups = new Map();
    }
    return loadedObjectGroup.userData.groups;
}

export function getObjectToGroup(loadedObjectGroup) {
    if (!loadedObjectGroup || !loadedObjectGroup.userData) return new Map();
    if (!loadedObjectGroup.userData.objectToGroup) {
        loadedObjectGroup.userData.objectToGroup = new Map();
    }
    return loadedObjectGroup.userData.objectToGroup;
}

export function getGroupKey(mesh, instanceId) {
    return `${mesh.uuid}_${instanceId}`;
}

export function getGroupChain(loadedObjectGroup, startGroupId) {
    const groups = getGroups(loadedObjectGroup);
    const chain = [];
    let currentId = startGroupId;
    while (currentId) {
        const group = groups.get(currentId);
        if (!group) break;
        chain.unshift(currentId); // [Root, ..., Parent]
        currentId = group.parent;
    }
    return chain;
}

export function getAllGroupChildren(loadedObjectGroup, groupId) {
    const groups = getGroups(loadedObjectGroup);
    const group = groups.get(groupId);
    if (!group) return [];

    const out = [];
    const stack = Array.isArray(group.children) ? group.children.slice().reverse() : [];
    while (stack.length > 0) {
        const child = stack.pop();
        if (!child) continue;

        if (child.type === 'group') {
            const sub = groups.get(child.id);
            if (sub && Array.isArray(sub.children) && sub.children.length > 0) {
                for (let i = sub.children.length - 1; i >= 0; i--) {
                    stack.push(sub.children[i]);
                }
            }
        } else {
            out.push(child);
        }
    }
    return out;
}

export function getAllDescendantGroups(loadedObjectGroup, groupId) {
    const groups = getGroups(loadedObjectGroup);
    const group = groups.get(groupId);
    if (!group) return [];

    const out = [];
    const stack = [];
    if (Array.isArray(group.children)) {
        for (let i = group.children.length - 1; i >= 0; i--) {
            const child = group.children[i];
            if (child && child.type === 'group') stack.push(child.id);
        }
    }

    while (stack.length > 0) {
        const id = stack.pop();
        if (!id) continue;
        out.push(id);
        const sub = groups.get(id);
        if (!sub || !Array.isArray(sub.children)) continue;
        for (let i = sub.children.length - 1; i >= 0; i--) {
            const child = sub.children[i];
            if (child && child.type === 'group') stack.push(child.id);
        }
    }
    return out;
}

export function getGroupWorldMatrix(group, out = new THREE.Matrix4()) {
    out.identity();
    if (!group) return out;
    if (group.matrix) return out.copy(group.matrix);

    const gPos = group.position || new THREE.Vector3();
    const gQuat = group.quaternion || new THREE.Quaternion();
    const gScale = group.scale || new THREE.Vector3(1, 1, 1);
    return out.compose(gPos, gQuat, gScale);
}

// Structure Modification
export function updateGroupReferenceForMovedInstance(loadedObjectGroup, mesh, oldInstanceId, newInstanceId) {
    const objectToGroup = getObjectToGroup(loadedObjectGroup);
    const groups = getGroups(loadedObjectGroup);
    
    const oldKey = getGroupKey(mesh, oldInstanceId);
    const newKey = getGroupKey(mesh, newInstanceId);
    
    const groupId = objectToGroup.get(oldKey);
    
    // Always clean up the old key
    objectToGroup.delete(oldKey);

    if (groupId) {
        // Update map to new key
        objectToGroup.set(newKey, groupId);

        // Update parent group's children list
        const group = groups.get(groupId);
        if (group && Array.isArray(group.children)) {
            const childEntry = group.children.find(c => c.type === 'object' && c.mesh === mesh && c.instanceId === oldInstanceId);
            if (childEntry) {
                childEntry.instanceId = newInstanceId;
            }
        }
    }
}

export function createGroupStructure(loadedObjectGroup, selectedGroupIds, selectedObjects, initialPosition) {
    const groups = getGroups(loadedObjectGroup);
    const objectToGroup = getObjectToGroup(loadedObjectGroup);

    const newGroupId = THREE.MathUtils.generateUUID();
    const newGroup = {
        id: newGroupId,
        isCollection: true,
        children: [],
        parent: null,
        name: 'Group',
        position: initialPosition.clone(),
        quaternion: new THREE.Quaternion(),
        scale: new THREE.Vector3(1, 1, 1)
    };

    // Determine common parent group for all selected roots (groups + objects)
    let commonParentId = undefined;
    const considerParentId = (gid) => {
        if (commonParentId === undefined) commonParentId = gid;
        else if (commonParentId !== gid) commonParentId = null;
    };

    for (const gid of selectedGroupIds) {
        const g = groups.get(gid);
        considerParentId(g ? g.parent : undefined);
        if (commonParentId === null) break;
    }
    if (commonParentId !== null) {
        for (const { mesh, instanceId } of selectedObjects) {
            const key = getGroupKey(mesh, instanceId);
            considerParentId(objectToGroup.get(key));
            if (commonParentId === null) break;
        }
    }

    if (commonParentId) {
        newGroup.parent = commonParentId;
        const parentGroup = groups.get(commonParentId);
        if (parentGroup) {
            if (!Array.isArray(parentGroup.children)) parentGroup.children = [];
            parentGroup.children.push({ type: 'group', id: newGroupId });
        }
    }

    // Attach selected groups
    for (const childGroupId of selectedGroupIds) {
        const childGroup = groups.get(childGroupId);
        if (!childGroup) continue;

        if (childGroup.parent) {
            const oldParent = groups.get(childGroup.parent);
            if (oldParent && Array.isArray(oldParent.children)) {
                oldParent.children = oldParent.children.filter(c => !(c && c.type === 'group' && c.id === childGroupId));
            }
        }

        childGroup.parent = newGroupId;
        newGroup.children.push({ type: 'group', id: childGroupId });
    }

    // Attach selected objects
    for (const { mesh, instanceId } of selectedObjects) {
        if (!mesh && mesh !== 0) continue;
        const key = getGroupKey(mesh, instanceId);
        const oldGroupId = objectToGroup.get(key);
        if (oldGroupId) {
            const oldGroup = groups.get(oldGroupId);
            if (oldGroup && Array.isArray(oldGroup.children)) {
                oldGroup.children = oldGroup.children.filter(c => !(c && c.type === 'object' && c.mesh === mesh && c.instanceId === instanceId));
            }
        }
        newGroup.children.push({ type: 'object', mesh, instanceId });
        objectToGroup.set(key, newGroupId);
    }

    groups.set(newGroupId, newGroup);
    return newGroupId;
}

export function ungroupGroupStructure(loadedObjectGroup, groupId) {
    const groups = getGroups(loadedObjectGroup);
    const objectToGroup = getObjectToGroup(loadedObjectGroup);
    const group = groups.get(groupId);
    if (!group) return null;

    const parentId = group.parent || null;
    const parentGroup = parentId ? groups.get(parentId) : null;

    const children = Array.isArray(group.children) ? group.children.slice() : [];

    // Re-parent children to the parent group (or to root when no parent)
    for (const child of children) {
        if (!child) continue;
        if (child.type === 'group') {
            const sub = groups.get(child.id);
            if (sub) sub.parent = parentId;
        } else if (child.type === 'object') {
            const key = getGroupKey(child.mesh, child.instanceId);
            if (parentId) objectToGroup.set(key, parentId);
            else objectToGroup.delete(key);
        }
    }

    // Replace this group in parent's children list, or just drop it if it's root.
    if (parentGroup) {
        if (!Array.isArray(parentGroup.children)) parentGroup.children = [];
        const idx = parentGroup.children.findIndex(c => c && c.type === 'group' && c.id === groupId);
        if (idx !== -1) {
            parentGroup.children.splice(idx, 1, ...children);
        } else {
            parentGroup.children.push(...children);
        }
    }

    groups.delete(groupId);
    return { parentId, children };
}

export function cloneGroupStructure(loadedObjectGroup, groupId, parentId, idMap) {
    const groups = getGroups(loadedObjectGroup);
    const sourceGroup = groups.get(groupId);
    if (!sourceGroup) return null;

    const newGroupId = THREE.MathUtils.generateUUID();
    if (idMap) idMap.set(groupId, newGroupId);

    let newPivot = undefined;
    if (sourceGroup.pivot) {
        newPivot = normalizePivotToVector3(sourceGroup.pivot, new THREE.Vector3());
    }

    const newGroup = {
        id: newGroupId,
        isCollection: true,
        children: [],
        parent: parentId,
        name: sourceGroup.name ? sourceGroup.name + " (Copy)" : "Group (Copy)",
        position: sourceGroup.position ? sourceGroup.position.clone() : new THREE.Vector3(),
        quaternion: sourceGroup.quaternion ? sourceGroup.quaternion.clone() : new THREE.Quaternion(),
        scale: sourceGroup.scale ? sourceGroup.scale.clone() : new THREE.Vector3(1, 1, 1),
        pivot: newPivot,
        isCustomPivot: sourceGroup.isCustomPivot
    };
    
    if (sourceGroup.matrix) newGroup.matrix = sourceGroup.matrix.clone();

    groups.set(newGroupId, newGroup);

    // Add to parent
    if (parentId) {
        const parentGroup = groups.get(parentId);
        if (parentGroup) {
            if (!Array.isArray(parentGroup.children)) parentGroup.children = [];
            parentGroup.children.push({ type: 'group', id: newGroupId });
        }
    }

    // Clone Children (structure only)
    if (Array.isArray(sourceGroup.children)) {
        for (const child of sourceGroup.children) {
            if (!child) continue;
            if (child.type === 'group') {
                cloneGroupStructure(loadedObjectGroup, child.id, newGroupId, idMap);
            }
        }
    }
    
    return newGroupId;
}

export function collectCloneJobsFromGroup(loadedObjectGroup, groupId, newGroupId, ctx, outJobs) {
    const groups = getGroups(loadedObjectGroup);
    const sourceGroup = groups.get(groupId);
    if (!sourceGroup || !Array.isArray(sourceGroup.children)) return;

    // We used to pass `_planWritableBatchFor` function or run it inline.
    // The planner logic is not part of group structure, but object resource management.
    // So this function should only TRAVERSE structure and return the objects found.
    // The calling code (gizmo) should inject the planning logic callback.
    
    for (const child of sourceGroup.children) {
        if (!child) continue;
        if (child.type === 'object') {
            if (ctx && ctx.planBatchCallback) {
                ctx.planBatchCallback(child.mesh, child.instanceId, newGroupId);
            }
            outJobs.push({ mesh: child.mesh, instanceId: child.instanceId, targetGroupId: newGroupId, coveredByGroup: true });
        } else if (child.type === 'group') {
            const mappedChildId = ctx && ctx._groupIdMap ? ctx._groupIdMap.get(child.id) : null;
            collectCloneJobsFromGroup(loadedObjectGroup, child.id, mappedChildId || newGroupId, ctx, outJobs);
        }
    }
}
