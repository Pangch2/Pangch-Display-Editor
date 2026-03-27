import {
    Mesh,
    BatchedMesh,
    InstancedMesh,
    Vector3,
    Quaternion,
    Matrix4,
    Group,
    MathUtils
} from 'three/webgpu';

// Types
export interface GroupChildObject {
    type: 'object';
    mesh: Mesh | BatchedMesh | InstancedMesh;
    instanceId: number;
    id?: string;
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
    position: Vector3;
    quaternion: Quaternion;
    scale: Vector3;
    pivot?: Vector3;
    isCustomPivot?: boolean;
    matrix?: Matrix4;
}

export interface CloneJobEntry {
    mesh: Mesh | BatchedMesh | InstancedMesh;
    instanceId: number;
    targetGroupId: string;
    coveredByGroup: boolean;
}

export interface CollectCloneContext {
    planBatchCallback?: (mesh: Mesh | BatchedMesh | InstancedMesh, instanceId: number, targetGroupId: string) => void;
    _groupIdMap?: Map<string, string>;
}

type PivotInput = Vector3 | [number, number, number] | { x: number; y: number; z: number } | null | undefined;

// Constants
export const DEFAULT_GROUP_PIVOT = new Vector3(0.5, 0.5, 0.5);

// Utils
function _nearlyEqual(a: number, b: number, eps: number = 1e-6): boolean {
    return Math.abs(a - b) <= eps;
}

function _parseGroupNameIndex(name: string | null | undefined): number | null {
    if (!name) return null;
    const normalized = String(name).trim().toLowerCase();
    if (normalized === 'group') return 1;

    const m = normalized.match(/^group(\d+)$/);
    if (!m) return null;
    const n = Number.parseInt(m[1], 10);
    if (!Number.isFinite(n) || n <= 0) return null;
    return n;
}

function _getNextGroupName(groups: Map<string, GroupData>): string {
    const used = new Set<number>();
    for (const g of groups.values()) {
        const idx = _parseGroupNameIndex(g?.name);
        if (idx !== null) used.add(idx);
    }

    let next = 1;
    while (used.has(next)) next++;
    return next === 1 ? 'group' : `group${next}`;
}

function _getCloneName(sourceName: string | null | undefined, groups: Map<string, GroupData>): string {
    const base = (sourceName || 'Group').trim();
    // 이름 끝에 숫자가 있는지 확인 (공백 유무 상관없이 매칭)
    const match = base.match(/^(.*?)\s*(\d+)$/);

    let namePart = base;
    let nextNum = 1;

    if (match) {
        // 숫자가 있다면 기본 이름과 다음 숫자를 추출
        namePart = match[1].trim() || base;
        nextNum = parseInt(match[2], 10) + 1;
    }

    const existingNames = new Set<string>();
    for (const g of groups.values()) {
        if (g.name) existingNames.add(g.name);
    }

    // 고유한 이름을 찾을 때까지 숫자 증가
    let candidate = `${namePart} ${nextNum}`.trim();
    while (existingNames.has(candidate)) {
        nextNum++;
        candidate = `${namePart} ${nextNum}`.trim();
    }
    return candidate;
}

export function normalizePivotToVector3(pivot: PivotInput, out: Vector3 = new Vector3()): Vector3 | null {
    if (!pivot) return null;
    if ((pivot as Vector3).isVector3) return out.copy(pivot as Vector3);
    if (Array.isArray(pivot) && pivot.length >= 3) return out.set(pivot[0], pivot[1], pivot[2]);
    if (typeof pivot === 'object' && 'x' in pivot && 'y' in pivot && 'z' in pivot) {
        return out.set(pivot.x, pivot.y, pivot.z);
    }
    return null;
}

export function isCustomGroupPivot(pivot: PivotInput): boolean {
    const v = normalizePivotToVector3(pivot, new Vector3());
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
export function getGroups(loadedObjectGroup: Group): Map<string, GroupData> {
    // loadedObjectGroup.userData.groups를 lazy-init하여 반환.
    // 모든 모듈이 이 함수를 통해 그룹 데이터에 접근하므로
    // userData.groups Map을 직접 수정하지 말 것.
    if (!loadedObjectGroup || !loadedObjectGroup.userData) return new Map();
    if (!loadedObjectGroup.userData.groups) {
        loadedObjectGroup.userData.groups = new Map<string, GroupData>();
    }
    return loadedObjectGroup.userData.groups;
}

export function getObjectToGroup(loadedObjectGroup: Group): Map<string, string> {
    if (!loadedObjectGroup || !loadedObjectGroup.userData) return new Map();
    if (!loadedObjectGroup.userData.objectToGroup) {
        loadedObjectGroup.userData.objectToGroup = new Map<string, string>();
    }
    return loadedObjectGroup.userData.objectToGroup;
}

export function getGroupKey(mesh: Mesh | BatchedMesh | InstancedMesh, instanceId: number): string {
    return `${mesh.uuid}_${instanceId}`;
}

export function getGroupChain(loadedObjectGroup: Group, startGroupId: string): string[] {
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

export function getAllGroupChildren(loadedObjectGroup: Group, groupId: string): GroupChildObject[] {
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

export function getAllDescendantGroups(loadedObjectGroup: Group, groupId: string): string[] {
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

export function getGroupWorldMatrix(group: GroupData | null | undefined, out: Matrix4 = new Matrix4()): Matrix4 {
    out.identity();
    if (!group) return out;
    if (group.matrix) return out.copy(group.matrix);

    const gPos = group.position || new Vector3();
    const gQuat = group.quaternion || new Quaternion();
    const gScale = group.scale || new Vector3(1, 1, 1);
    return out.compose(gPos, gQuat, gScale);
}

// Structure Modification
export function updateGroupReferenceForMovedInstance(
    loadedObjectGroup: Group,
    mesh: Mesh | BatchedMesh | InstancedMesh,
    oldInstanceId: number,
    newInstanceId: number
): void {
    const objectToGroup = getObjectToGroup(loadedObjectGroup);
    const groups = getGroups(loadedObjectGroup);
    const keyToUuid = loadedObjectGroup?.userData?.instanceKeyToObjectUuid as Map<string, string> | undefined;
    const uuidToInstance = loadedObjectGroup?.userData?.objectUuidToInstance as
        | Map<string, { mesh: Mesh | BatchedMesh | InstancedMesh; instanceId: number }>
        | undefined;

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

    if (keyToUuid) {
        const objectUuid = keyToUuid.get(oldKey);
        if (objectUuid) {
            keyToUuid.delete(oldKey);
            keyToUuid.set(newKey, objectUuid);

            if (uuidToInstance) {
                uuidToInstance.set(objectUuid, { mesh, instanceId: newInstanceId });
            }
        }
    }
}

export function createGroupStructure(
    loadedObjectGroup: Group,
    selectedGroupIds: string[],
    selectedObjects: { mesh: Mesh | BatchedMesh | InstancedMesh; instanceId: number }[],
    initialPosition: Vector3
): string {
    const groups = getGroups(loadedObjectGroup);
    const objectToGroup = getObjectToGroup(loadedObjectGroup);

    const newGroupId = MathUtils.generateUUID();
    const newGroup: GroupData = {
        id: newGroupId,
        isCollection: true,
        children: [],
        parent: null,
        name: "", // Will be determined after cleanup
        position: initialPosition.clone(),
        quaternion: new Quaternion(),
        scale: new Vector3(1, 1, 1)
    };
    const keyToUuid = loadedObjectGroup?.userData?.instanceKeyToObjectUuid as Map<string, string> | undefined;

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

    const affectedGroupIds = new Set<string>();

    for (const childGroupId of selectedGroupIds) {
        const childGroup = groups.get(childGroupId);
        if (!childGroup) continue;

        if (childGroup.parent) {
            affectedGroupIds.add(childGroup.parent);
            const oldParent = groups.get(childGroup.parent);
            if (oldParent && Array.isArray(oldParent.children)) {
                oldParent.children = oldParent.children.filter(c => !(c && c.type === 'group' && (c as GroupChildGroup).id === childGroupId));
            }
        } else {
            // Root group being moved: remove from sceneOrder
            const ud = loadedObjectGroup.userData;
            if (Array.isArray(ud.sceneOrder)) {
                ud.sceneOrder = ud.sceneOrder.filter((entry: any) => !(entry.type === 'group' && entry.id === childGroupId));
            }
        }

        childGroup.parent = newGroupId;
        newGroup.children.push({ type: 'group', id: childGroupId });
    }

    for (const { mesh, instanceId } of selectedObjects) {
        if (!mesh && (mesh as unknown) !== 0) continue;
        const key = getGroupKey(mesh, instanceId);
        const objectUuid = keyToUuid?.get(key);
        const oldGroupId = objectToGroup.get(key);
        if (oldGroupId) {
            affectedGroupIds.add(oldGroupId);
            const oldGroup = groups.get(oldGroupId);
            if (oldGroup && Array.isArray(oldGroup.children)) {
                oldGroup.children = oldGroup.children.filter(c => !(c && c.type === 'object' && (c as GroupChildObject).mesh === mesh && (c as GroupChildObject).instanceId === instanceId));
            }
        } else if (objectUuid) {
            // Root object being moved: remove from sceneOrder
            const ud = loadedObjectGroup.userData;
            if (Array.isArray(ud.sceneOrder)) {
                ud.sceneOrder = ud.sceneOrder.filter((entry: any) => !(entry.type === 'object' && entry.id === objectUuid));
            }
        }
        newGroup.children.push({ type: 'object', mesh, instanceId, id: objectUuid });
        objectToGroup.set(key, newGroupId);
    }

    // Recursive cleanup of empty affected groups
    const cleanupEmptyGroups = (groupId: string) => {
        const g = groups.get(groupId);
        if (!g) return;
        // Only clean up if it's empty
        if (Array.isArray(g.children) && g.children.length === 0) {
            const parentId = g.parent;
            if (parentId) {
                const pg = groups.get(parentId);
                if (pg && Array.isArray(pg.children)) {
                    pg.children = pg.children.filter(c => !(c && c.type === 'group' && (c as GroupChildGroup).id === groupId));
                }
                groups.delete(groupId);
                cleanupEmptyGroups(parentId);
            } else {
                groups.delete(groupId);
                // Also clean up from sceneOrder if it's a root
                const ud = loadedObjectGroup.userData;
                if (Array.isArray(ud.sceneOrder)) {
                    ud.sceneOrder = ud.sceneOrder.filter((entry: any) => !(entry.type === 'group' && entry.id === groupId));
                }
            }
        }
    };

    for (const gid of affectedGroupIds) {
        cleanupEmptyGroups(gid);
    }

    // Now determine the name after cleanup to potentially reuse index 1
    newGroup.name = _getNextGroupName(groups);
    groups.set(newGroupId, newGroup);

    // If it's a root group, add to sceneOrder for consistent tracking
    if (newGroup.parent === null) {
        const ud = loadedObjectGroup.userData;
        if (Array.isArray(ud.sceneOrder)) {
            ud.sceneOrder.push({ type: 'group', id: newGroupId });
        }
    }

    return newGroupId;
}

export function ungroupGroupStructure(
    loadedObjectGroup: Group,
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
    loadedObjectGroup: Group,
    groupId: string,
    parentId: string | null,
    idMap?: Map<string, string>
): string | null {
    const groups = getGroups(loadedObjectGroup);
    const sourceGroup = groups.get(groupId);
    if (!sourceGroup) return null;

    const newGroupId = MathUtils.generateUUID();
    if (idMap) idMap.set(groupId, newGroupId);

    let newPivot: Vector3 | undefined = undefined;
    if (sourceGroup.pivot) {
        newPivot = normalizePivotToVector3(sourceGroup.pivot, new Vector3()) ?? undefined;
    }

    const newGroup: GroupData = {
        id: newGroupId,
        isCollection: true,
        children: [],
        parent: parentId,
        name: _getCloneName(sourceGroup.name, groups),
        position: sourceGroup.position ? sourceGroup.position.clone() : new Vector3(),
        quaternion: sourceGroup.quaternion ? sourceGroup.quaternion.clone() : new Quaternion(),
        scale: sourceGroup.scale ? sourceGroup.scale.clone() : new Vector3(1, 1, 1),
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
    loadedObjectGroup: Group,
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
