import { Group, InstancedMesh, type Object3D } from 'three/webgpu';
import { entityVisibleAttributeName, setEntityStateAttributes } from '../entity-material';

type SceneVisibilityData = {
    objectUuidToInstance?: Map<string, { mesh: Object3D; instanceId: number }>;
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
    const ref = ud.objectUuidToInstance?.get(uuid);
    let groupId = ref ? ud.objectToGroup?.get(`${ref.mesh.uuid}_${ref.instanceId}`) ?? null : null;
    while (groupId) {
        if (hiddenGroups(root).has(groupId)) return false;
        groupId = ud.groups?.get(groupId)?.parent ?? null;
    }
    return true;
}

export function applySceneVisibility(root: Group): void {
    const refs = (root.userData as SceneVisibilityData).objectUuidToInstance;
    if (!refs) return;
    for (const [uuid, ref] of refs) {
        if (!(ref.mesh as InstancedMesh).isInstancedMesh) continue;
        const mesh = ref.mesh as InstancedMesh;
        let visibility = mesh.geometry.getAttribute(entityVisibleAttributeName);
        if (!visibility) {
            setEntityStateAttributes(mesh.geometry, mesh.instanceMatrix.count);
            visibility = mesh.geometry.getAttribute(entityVisibleAttributeName);
        }
        visibility.setX(ref.instanceId, isSceneObjectVisible(root, uuid) ? 1 : 0);
        visibility.needsUpdate = true;
    }
}

export function setSceneItemEnabled(root: Group, type: 'group' | 'object', id: string, enabled: boolean): void {
    const hidden = type === 'group' ? hiddenGroups(root) : hiddenObjects(root);
    if (enabled) hidden.delete(id);
    else hidden.add(id);
    applySceneVisibility(root);
    window.dispatchEvent(new CustomEvent('pde:scene-updated'));
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
}
