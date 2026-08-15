import { Group, InstancedMesh, InterleavedBufferAttribute, type BufferAttribute, type Object3D } from 'three/webgpu';
import { entityVisibleAttributeName, setEntityStateAttributes } from '../entity-material';
import { getAllGroupChildren } from './grouping/group';

type SceneVisibilityData = {
    objectUuidToInstance?: Map<string, { mesh: Object3D; instanceId: number }>;
    objectToGroup?: Map<string, string>;
    groups?: Map<string, { parent: string | null }>;
};

type VisibilityAttribute = BufferAttribute | InterleavedBufferAttribute;
type VisibleInstanceCache = {
    attribute: VisibilityAttribute | undefined;
    count: number;
    ids: Set<number>;
    snapshot?: number[];
};

const visibleInstances = new WeakMap<InstancedMesh, VisibleInstanceCache>();

const hiddenObjects = (root: Group): Set<string> => root.userData.hiddenObjectUuids ??= new Set<string>();
const hiddenGroups = (root: Group): Set<string> => root.userData.hiddenGroupIds ??= new Set<string>();

export function isSceneItemEnabled(root: Group, type: 'group' | 'object', id: string): boolean {
    return !(type === 'group' ? hiddenGroups(root) : hiddenObjects(root)).has(id);
}

export function isSceneObjectVisible(root: Group, uuid: string): boolean {
    if (hiddenObjects(root).has(uuid)) return false;
    const ud = root.userData as SceneVisibilityData;
    const ref = ud.objectUuidToInstance?.get(uuid);
    let groupId = ref ? ud.objectToGroup?.get(`${ref.mesh.uuid}_${ref.instanceId}`) ?? null : null;
    while (groupId) {
        if (hiddenGroups(root).has(groupId)) return false;
        groupId = ud.groups?.get(groupId)?.parent ?? null;
    }
    return true;
}

export function getVisibleInstanceIds(mesh: InstancedMesh): readonly number[] {
    const attribute = mesh.geometry.getAttribute(entityVisibleAttributeName);
    const cached = visibleInstances.get(mesh);
    if (cached?.attribute === attribute && cached.count === mesh.count) {
        return cached.snapshot ??= [...cached.ids];
    }

    const ids = new Set<number>();
    for (let instanceId = 0; instanceId < mesh.count; instanceId++) {
        if (attribute?.getX(instanceId) !== 0) ids.add(instanceId);
    }
    const snapshot = [...ids];
    visibleInstances.set(mesh, { attribute, count: mesh.count, ids, snapshot });
    return snapshot;
}

export function applySceneVisibility(root: Group, objectUuids?: Iterable<string>): void {
    const refs = (root.userData as SceneVisibilityData).objectUuidToInstance;
    if (!refs) return;
    const fullUpdate = objectUuids === undefined;
    const updates = new Map<InstancedMesh, { attribute: VisibilityAttribute; ids: Set<number>; changed: boolean }>();
    for (const uuid of objectUuids ?? refs.keys()) {
        const ref = refs.get(uuid);
        if (!ref) continue;
        if (!(ref.mesh as InstancedMesh).isInstancedMesh) continue;
        const mesh = ref.mesh as InstancedMesh;
        let update = updates.get(mesh);
        if (!update) {
            let attribute = mesh.geometry.getAttribute(entityVisibleAttributeName);
            if (!attribute) {
                setEntityStateAttributes(mesh.geometry, mesh.instanceMatrix.count);
                attribute = mesh.geometry.getAttribute(entityVisibleAttributeName)!;
            }
            update = { attribute, ids: new Set(), changed: false };
            updates.set(mesh, update);
        }
        const visible = isSceneObjectVisible(root, uuid);
        if (fullUpdate && visible) update.ids.add(ref.instanceId);
        if (update.attribute.getX(ref.instanceId) === Number(visible)) continue;
        update.attribute.setX(ref.instanceId, Number(visible));
        update.changed = true;
        if (!fullUpdate) {
            if (update.attribute instanceof InterleavedBufferAttribute) {
                update.attribute.data.addUpdateRange(
                    ref.instanceId * update.attribute.data.stride + update.attribute.offset,
                    1
                );
            } else {
                update.attribute.addUpdateRange(ref.instanceId * update.attribute.itemSize, update.attribute.itemSize);
            }
        }

        const cached = visibleInstances.get(mesh);
        if (!fullUpdate && cached?.attribute === update.attribute && cached.count === mesh.count) {
            if (visible) cached.ids.add(ref.instanceId);
            else cached.ids.delete(ref.instanceId);
            cached.snapshot = undefined;
        } else if (!fullUpdate) {
            visibleInstances.delete(mesh);
        }
    }
    for (const [mesh, update] of updates) {
        if (update.changed) {
            if (fullUpdate) {
                if (update.attribute instanceof InterleavedBufferAttribute) update.attribute.data.clearUpdateRanges();
                else update.attribute.clearUpdateRanges();
            }
            update.attribute.needsUpdate = true;
        }
        if (fullUpdate) {
            visibleInstances.set(mesh, {
                attribute: update.attribute,
                count: mesh.count,
                ids: update.ids,
                snapshot: [...update.ids]
            });
        }
        // ponytail: mixed visible/hidden slots still share one draw; compact buffers only if profiling justifies the remapping cost.
        mesh.visible = (fullUpdate ? update.ids.size : getVisibleInstanceIds(mesh).length) > 0;
    }
}

export function setSceneItemEnabled(root: Group, type: 'group' | 'object', id: string, enabled: boolean): void {
    let objectUuids = [id];
    if (type === 'group') {
        const keyToUuid = root.userData.instanceKeyToObjectUuid as Map<string, string> | undefined;
        objectUuids = getAllGroupChildren(root, id).flatMap(child => {
            const uuid = child.id ?? keyToUuid?.get(`${child.mesh.uuid}_${child.instanceId}`);
            return uuid && (!enabled ? isSceneObjectVisible(root, uuid) : true) ? [uuid] : [];
        });
    }

    const hidden = type === 'group' ? hiddenGroups(root) : hiddenObjects(root);
    if (enabled) hidden.delete(id);
    else hidden.add(id);
    if (type === 'group' && enabled) objectUuids = objectUuids.filter(uuid => isSceneObjectVisible(root, uuid));
    applySceneVisibility(root, objectUuids);
    window.dispatchEvent(new CustomEvent('pde:scene-visibility-changed', { detail: { type, id } }));
}

if (import.meta.env.DEV) {
    const root = new Group();
    const object = new Group();
    root.userData.objectUuidToInstance = new Map([['child', { mesh: object, instanceId: 0 }]]);
    root.userData.objectToGroup = new Map([[`${object.uuid}_0`, 'parent']]);
    root.userData.groups = new Map([['parent', { parent: null }]]);
    root.userData.hiddenGroupIds = new Set(['parent']);
    console.assert(!isSceneObjectVisible(root, 'child'), 'Hidden groups must hide enabled children.');
    root.userData.hiddenGroupIds.clear();
    root.userData.hiddenObjectUuids = new Set(['child']);
    console.assert(!isSceneObjectVisible(root, 'child'), 'A child must keep its hidden state after its group is enabled.');

    const mesh = new InstancedMesh(undefined, undefined, 2);
    root.userData.objectUuidToInstance = new Map([
        ['visible', { mesh, instanceId: 0 }],
        ['hidden', { mesh, instanceId: 1 }]
    ]);
    root.userData.objectToGroup = new Map();
    root.userData.hiddenObjectUuids = new Set(['hidden']);
    applySceneVisibility(root);
    console.assert(getVisibleInstanceIds(mesh).join() === '0', 'Visible instance cache included a hidden instance.');
    root.userData.hiddenObjectUuids.add('visible');
    applySceneVisibility(root, ['visible']);
    console.assert(getVisibleInstanceIds(mesh).length === 0, 'Partial visibility update left a hidden instance selectable.');
    console.assert(!mesh.visible, 'A fully hidden instance batch must leave the render traversal.');
}
