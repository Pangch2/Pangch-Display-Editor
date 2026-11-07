import { Group, InstancedMesh } from 'three/webgpu';
import { setEntityStateAttributes } from '../entity-material';
import { getAllGroupChildren } from './grouping/group';
import { batchOf, getVisibleInstanceIds, setInstanceVisible, type ObjectBatch } from '../scene-store/object-access';
import { ObjectStore } from '../scene-store/object-store';

export { getVisibleInstanceIds };

type SceneVisibilityData = {
    objectUuidToInstance?: Map<string, { mesh: ObjectBatch; instanceId: number }>;
    objectToGroup?: Map<string, string>;
    groups?: Map<string, { parent: string | null }>;
};

const hiddenObjects = (root: Group): Set<string> => root.userData.hiddenObjectUuids ??= new Set<string>();
const hiddenGroups = (root: Group): Set<string> => root.userData.hiddenGroupIds ??= new Set<string>();

export function isSceneItemEnabled(root: Group, type: 'group' | 'object', id: string): boolean {
    return !(type === 'group' ? hiddenGroups(root) : hiddenObjects(root)).has(id);
}

export function isSceneObjectVisible(root: Group, uuid: string): boolean {
    if (hiddenObjects(root).has(uuid)) return false;
    const ud = root.userData as SceneVisibilityData;
    let groupId = ud.objectToGroup?.get(uuid) ?? null;
    while (groupId) {
        if (hiddenGroups(root).has(groupId)) return false;
        groupId = ud.groups?.get(groupId)?.parent ?? null;
    }
    return true;
}

export function applySceneVisibility(root: Group, objectUuids?: Iterable<string>): void {
    const refs = (root.userData as SceneVisibilityData).objectUuidToInstance;
    if (!refs) return;
    const batches = new Set<ObjectBatch>();
    for (const uuid of objectUuids ?? refs.keys()) {
        const ref = refs.get(uuid);
        if (!ref) continue;
        batches.add(ref.mesh);
        setInstanceVisible(ref.mesh, ref.instanceId, isSceneObjectVisible(root, uuid));
    }
    // Hidden slots in a partly visible batch are dropped by the GPU cull pass (gpu-draw).
    for (const batch of batches) batch.visible = getVisibleInstanceIds(batch).length > 0;
}

export function setSceneItemEnabled(root: Group, type: 'group' | 'object', id: string, enabled: boolean): void {
    let objectUuids = [id];
    if (type === 'group') {
        objectUuids = getAllGroupChildren(root, id).flatMap(({ id: uuid }) => !enabled && !isSceneObjectVisible(root, uuid) ? [] : [uuid]);
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
    root.userData.objectToGroup = new Map([['child', 'parent']]);
    root.userData.groups = new Map([['parent', { parent: null }]]);
    root.userData.hiddenGroupIds = new Set(['parent']);
    console.assert(!isSceneObjectVisible(root, 'child'), 'Hidden groups must hide enabled children.');
    root.userData.hiddenGroupIds.clear();
    root.userData.hiddenObjectUuids = new Set(['child']);
    console.assert(!isSceneObjectVisible(root, 'child'), 'A child must keep its hidden state after its group is enabled.');

    const mesh = new InstancedMesh(undefined, undefined, 2);
    setEntityStateAttributes(mesh.geometry, 2);
    const batch = batchOf(mesh);
    root.userData.objectUuidToInstance = new ObjectStore([
        ['visible', { mesh: batch, instanceId: 0 }],
        ['hidden', { mesh: batch, instanceId: 1 }]
    ]);
    root.userData.objectToGroup = new Map();
    root.userData.hiddenObjectUuids = new Set(['hidden']);
    applySceneVisibility(root);
    console.assert(getVisibleInstanceIds(batch).join() === '0', 'Visible instance cache included a hidden instance.');
    root.userData.hiddenObjectUuids.add('visible');
    applySceneVisibility(root, ['visible']);
    console.assert(getVisibleInstanceIds(batch).length === 0, 'Partial visibility update left a hidden instance selectable.');
    console.assert(!mesh.visible, 'A fully hidden instance batch must leave the render traversal.');
}
