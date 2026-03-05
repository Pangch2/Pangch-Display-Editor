import * as THREE from 'three/webgpu';

// Types
export interface GroupChildObject {
    type: 'object';
    mesh: THREE.Mesh | THREE.BatchedMesh | THREE.InstancedMesh;
    instanceId: number;
}

export interface GroupChildGroup {
    type: 'group';
    id: string;
}

export type GroupChild = GroupChildObject | GroupChildGroup;

export interface GroupData {
    id: string;
    isCollection: boolean;
    children: GroupChild[];
    parent: string | null;
    name: string;
    position: THREE.Vector3;
    quaternion: THREE.Quaternion;
    scale: THREE.Vector3;
    pivot?: THREE.Vector3;
    isCustomPivot?: boolean;
    matrix?: THREE.Matrix4;
}

export interface CloneJobEntry {
    mesh: THREE.Mesh | THREE.BatchedMesh | THREE.InstancedMesh;
    instanceId: number;
    targetGroupId: string;
    coveredByGroup: boolean;
}

export interface CollectCloneContext {
    planBatchCallback?: (mesh: THREE.Mesh | THREE.BatchedMesh | THREE.InstancedMesh, instanceId: number, targetGroupId: string) => void;
    _groupIdMap?: Map<string, string>;
}

type PivotInput = THREE.Vector3 | [number, number, number] | { x: number; y: number; z: number } | null | undefined;

// Constants
export const DEFAULT_GROUP_PIVOT = new THREE.Vector3(0.5, 0.5, 0.5);

// Utils
function _nearlyEqual(a: number, b: number, eps: number = 1e-6): boolean {
    return Math.abs(a - b) <= eps;
}

export function normalizePivotToVector3(pivot: PivotInput, out: THREE.Vector3 = new THREE.Vector3()): THREE.Vector3 | null {
    if (!pivot) return null;
    if ((pivot as THREE.Vector3).isVector3) return out.copy(pivot as THREE.Vector3);
    if (Array.isArray(pivot) && pivot.length >= 3) return out.set(pivot[0], pivot[1], pivot[2]);
    if (typeof pivot === 'object' && 'x' in pivot && 'y' in pivot && 'z' in pivot) {
        return out.set(pivot.x, pivot.y, pivot.z);
    }
    return null;
}

export function isCustomGroupPivot(pivot: PivotInput): boolean {
    const v = normalizePivotToVector3(pivot, new THREE.Vector3());
    if (!v) return false;
    return !(
        _nearlyEqual(v.x, DEFAULT_GROUP_PIVOT.x) &&
        _nearlyEqual(v.y, DEFAULT_GROUP_PIVOT.y) &&
        _nearlyEqual(v.z, DEFAULT_GROUP_PIVOT.z)
    );
}

export function shouldUseGroupPivot(group: GroupData | null | undefined): boolean {
    if (!group) return false;
    if (group.isCustomPivot) return true;
    return isCustomGroupPivot(group.pivot ?? null);
}

// Accessors
export function getGroups(loadedObjectGroup: THREE.Group): Map<string, GroupData> {
    if (!loadedObjectGroup || !loadedObjectGroup.userData) return new Map();
    if (!loadedObjectGroup.userData.groups) {
        loadedObjectGroup.userData.groups = new Map<string, GroupData>();
    }
    return loadedObjectGroup.userData.groups;
}

export function getObjectToGroup(loadedObjectGroup: THREE.Group): Map<string, string> {
    if (!loadedObjectGroup || !loadedObjectGroup.userData) return new Map();
    if (!loadedObjectGroup.userData.objectToGroup) {
        loadedObjectGroup.userData.objectToGroup = new Map<string, string>();
    }
    return loadedObjectGroup.userData.objectToGroup;
}

export function getGroupKey(mesh: THREE.Mesh | THREE.BatchedMesh | THREE.InstancedMesh, instanceId: number): string {
    return `${mesh.uuid}_${instanceId}`;
}

export function getGroupChain(loadedObjectGroup: THREE.Group, startGroupId: string): string[] {
    const groups = getGroups(loadedObjectGroup);
    const chain: string[] = [];
    let currentId: string | null = startGroupId;
    while (currentId) {
        const group = groups.get(currentId);
        if (!group) break;
        chain.unshift(currentId);
        currentId = group.parent;
    }
    return chain;
}

export function getAllGroupChildren(loadedObjectGroup: THREE.Group, groupId: string): GroupChildObject[] {
    const groups = getGroups(loadedObjectGroup);
    const group = groups.get(groupId);
    if (!group) return [];

    const out: GroupChildObject[] = [];
    const stack: GroupChild[] = Array.isArray(group.children) ? group.children.slice().reverse() : [];
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

export function getAllDescendantGroups(loadedObjectGroup: THREE.Group, groupId: string): string[] {
    const groups = getGroups(loadedObjectGroup);
    const group = groups.get(groupId);
    if (!group) return [];

    const out: string[] = [];
    const stack: string[] = [];
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

export function getGroupWorldMatrix(group: GroupData | null | undefined, out: THREE.Matrix4 = new THREE.Matrix4()): THREE.Matrix4 {
    out.identity();
    if (!group) return out;
    if (group.matrix) return out.copy(group.matrix);

    const gPos = group.position || new THREE.Vector3();
    const gQuat = group.quaternion || new THREE.Quaternion();
    const gScale = group.scale || new THREE.Vector3(1, 1, 1);
    return out.compose(gPos, gQuat, gScale);
}

// Structure Modification
export function updateGroupReferenceForMovedInstance(
    loadedObjectGroup: THREE.Group,
    mesh: THREE.Mesh | THREE.BatchedMesh | THREE.InstancedMesh,
    oldInstanceId: number,
    newInstanceId: number
): void {
    const objectToGroup = getObjectToGroup(loadedObjectGroup);
    const groups = getGroups(loadedObjectGroup);

    const oldKey = getGroupKey(mesh, oldInstanceId);
    const newKey = getGroupKey(mesh, newInstanceId);

    const groupId = objectToGroup.get(oldKey);

    objectToGroup.delete(oldKey);

    if (groupId) {
        objectToGroup.set(newKey, groupId);

        const group = groups.get(groupId);
        if (group && Array.isArray(group.children)) {
            const childEntry = group.children.find(
                (c): c is GroupChildObject => c.type === 'object' && c.mesh === mesh && c.instanceId === oldInstanceId
            );
            if (childEntry) {
                childEntry.instanceId = newInstanceId;
            }
        }
    }
}

export function createGroupStructure(
    loadedObjectGroup: THREE.Group,
    selectedGroupIds: string[],
    selectedObjects: { mesh: THREE.Mesh | THREE.BatchedMesh | THREE.InstancedMesh; instanceId: number }[],
    initialPosition: THREE.Vector3
): string {
    const groups = getGroups(loadedObjectGroup);
    const objectToGroup = getObjectToGroup(loadedObjectGroup);

    const newGroupId = THREE.MathUtils.generateUUID();
    const newGroup: GroupData = {
        id: newGroupId,
        isCollection: true,
        children: [],
        parent: null,
        name: 'Group',
        position: initialPosition.clone(),
        quaternion: new THREE.Quaternion(),
        scale: new THREE.Vector3(1, 1, 1)
    };

    let commonParentId: string | null | undefined = undefined;
    const considerParentId = (gid: string | null | undefined): void => {
        if (commonParentId === undefined) commonParentId = gid ?? null;
        else if (commonParentId !== (gid ?? null)) commonParentId = null;
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

    for (const childGroupId of selectedGroupIds) {
        const childGroup = groups.get(childGroupId);
        if (!childGroup) continue;

        if (childGroup.parent) {
            const oldParent = groups.get(childGroup.parent);
            if (oldParent && Array.isArray(oldParent.children)) {
                oldParent.children = oldParent.children.filter(c => !(c && c.type === 'group' && (c as GroupChildGroup).id === childGroupId));
            }
        }

        childGroup.parent = newGroupId;
        newGroup.children.push({ type: 'group', id: childGroupId });
    }

    for (const { mesh, instanceId } of selectedObjects) {
        if (!mesh && (mesh as unknown) !== 0) continue;
        const key = getGroupKey(mesh, instanceId);
        const oldGroupId = objectToGroup.get(key);
        if (oldGroupId) {
            const oldGroup = groups.get(oldGroupId);
            if (oldGroup && Array.isArray(oldGroup.children)) {
                oldGroup.children = oldGroup.children.filter(c => !(c && c.type === 'object' && (c as GroupChildObject).mesh === mesh && (c as GroupChildObject).instanceId === instanceId));
            }
        }
        newGroup.children.push({ type: 'object', mesh, instanceId });
        objectToGroup.set(key, newGroupId);
    }

    groups.set(newGroupId, newGroup);
    return newGroupId;
}

export function ungroupGroupStructure(
    loadedObjectGroup: THREE.Group,
    groupId: string
): { parentId: string | null; children: GroupChild[] } | null {
    const groups = getGroups(loadedObjectGroup);
    const objectToGroup = getObjectToGroup(loadedObjectGroup);
    const group = groups.get(groupId);
    if (!group) return null;

    const parentId = group.parent || null;
    const parentGroup = parentId ? groups.get(parentId) : null;

    const children = Array.isArray(group.children) ? group.children.slice() : [];

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

    if (parentGroup) {
        if (!Array.isArray(parentGroup.children)) parentGroup.children = [];
        const idx = parentGroup.children.findIndex(c => c && c.type === 'group' && (c as GroupChildGroup).id === groupId);
        if (idx !== -1) {
            parentGroup.children.splice(idx, 1, ...children);
        } else {
            parentGroup.children.push(...children);
        }
    }

    groups.delete(groupId);
    return { parentId, children };
}

export function cloneGroupStructure(
    loadedObjectGroup: THREE.Group,
    groupId: string,
    parentId: string | null,
    idMap?: Map<string, string>
): string | null {
    const groups = getGroups(loadedObjectGroup);
    const sourceGroup = groups.get(groupId);
    if (!sourceGroup) return null;

    const newGroupId = THREE.MathUtils.generateUUID();
    if (idMap) idMap.set(groupId, newGroupId);

    let newPivot: THREE.Vector3 | undefined = undefined;
    if (sourceGroup.pivot) {
        newPivot = normalizePivotToVector3(sourceGroup.pivot, new THREE.Vector3()) ?? undefined;
    }

    const newGroup: GroupData = {
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

    if (parentId) {
        const parentGroup = groups.get(parentId);
        if (parentGroup) {
            if (!Array.isArray(parentGroup.children)) parentGroup.children = [];
            parentGroup.children.push({ type: 'group', id: newGroupId });
        }
    }

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

export function collectCloneJobsFromGroup(
    loadedObjectGroup: THREE.Group,
    groupId: string,
    newGroupId: string,
    ctx: CollectCloneContext | null,
    outJobs: CloneJobEntry[]
): void {
    const groups = getGroups(loadedObjectGroup);
    const sourceGroup = groups.get(groupId);
    if (!sourceGroup || !Array.isArray(sourceGroup.children)) return;

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
