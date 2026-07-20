import { Group, InstancedMesh, Matrix4, Mesh, Object3D, Vector3 } from 'three/webgpu';
import { applyDeltaToSelection } from './selection/drag';
import { mergeInstanceIds } from './selection/instance-ranges';
import { getGroupKey } from './grouping/group';
import type { SelectedItem } from './selection/select';
import type { InstanceIdRange } from './selection/instance-ranges';

type PdeMesh = InstancedMesh | Mesh;
type MirrorPairKey = 'objectMirrorPairs' | 'groupMirrorPairs';

const worldXReflection = new Matrix4().makeScale(-1, 1, 1).setPosition(-1, 0, 0);
let mirrorModeling = false;

export const mirrorModelingPivot = new Vector3(-0.5, 0.5, 0.5);

export function setMirrorModeling(enabled: boolean): void {
    mirrorModeling = enabled;
}

export function isMirrorModelingEnabled(): boolean {
    return mirrorModeling;
}

export function getMirrorPairs(loadedObjectGroup: Group, key: MirrorPairKey): Map<string, string> {
    return loadedObjectGroup.userData[key] ??= new Map<string, string>();
}

export function linkMirrorPair(pairs: Map<string, string>, a?: string, b?: string): void {
    if (!a || !b) return;
    const oldA = pairs.get(a);
    const oldB = pairs.get(b);
    if (oldA) pairs.delete(oldA);
    if (oldB) pairs.delete(oldB);
    pairs.set(a, b);
    pairs.set(b, a);
}

export function replaceMirrorUuid(loadedObjectGroup: Group, oldUuid: string, newUuid: string): void {
    const pairs = getMirrorPairs(loadedObjectGroup, 'objectMirrorPairs');
    const partner = pairs.get(oldUuid);
    pairs.delete(oldUuid);
    if (!partner) return;
    pairs.set(partner, newUuid);
    pairs.set(newUuid, partner);
}

function getItemUuid(loadedObjectGroup: Group, { mesh, instanceId }: SelectedItem): string | undefined {
    return (loadedObjectGroup.userData.instanceKeyToObjectUuid as Map<string, string> | undefined)
        ?.get(getGroupKey(mesh, instanceId));
}

function rangesForItems(items: SelectedItem[]): Map<Object3D, InstanceIdRange[]> {
    const idsByMesh = new Map<Object3D, number[]>();
    for (const { mesh, instanceId } of items) {
        const ids = idsByMesh.get(mesh) ?? [];
        ids.push(instanceId);
        idsByMesh.set(mesh, ids);
    }
    return new Map(Array.from(idsByMesh, ([mesh, ids]) => [mesh, mergeInstanceIds(ids)]));
}

export function applyLinkedMirrorDelta(
    loadedObjectGroup: Group,
    deltaMatrix: Matrix4,
    items: SelectedItem[],
    groupIds: Set<string>
): void {
    const selectedUuids = new Set(items.map(item => getItemUuid(loadedObjectGroup, item)).filter((uuid): uuid is string => !!uuid));
    const objectPairs = getMirrorPairs(loadedObjectGroup, 'objectMirrorPairs');
    const uuidToInstance = loadedObjectGroup.userData.objectUuidToInstance as Map<string, { mesh: PdeMesh; instanceId: number }> | undefined;
    const partnerItems: SelectedItem[] = [];
    for (const uuid of selectedUuids) {
        const partnerUuid = objectPairs.get(uuid);
        const partner = partnerUuid && !selectedUuids.has(partnerUuid) ? uuidToInstance?.get(partnerUuid) : undefined;
        if (partner) partnerItems.push({ type: 'object', ...partner });
    }

    const groupPairs = getMirrorPairs(loadedObjectGroup, 'groupMirrorPairs');
    const partnerGroupIds = new Set<string>();
    for (const groupId of groupIds) {
        const partnerId = groupPairs.get(groupId);
        if (partnerId && !groupIds.has(partnerId)) partnerGroupIds.add(partnerId);
    }
    if (partnerItems.length === 0 && partnerGroupIds.size === 0) return;

    const mirroredDelta = worldXReflection.clone().multiply(deltaMatrix).multiply(worldXReflection);
    applyDeltaToSelection({
        deltaMatrix: mirroredDelta,
        meshToInstanceRanges: rangesForItems(partnerItems),
        selectedGroupIds: partnerGroupIds,
        loadedObjectGroup
    });
}
