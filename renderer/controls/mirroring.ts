import { Group, InstancedMesh, Matrix4, Mesh, Vector3 } from 'three/webgpu';
import { applyDeltaToSelection } from './selection/drag';
import { mergeInstanceIds } from './selection/instance-ranges';
import * as GroupUtils from './grouping/group';
import type { SelectedItem } from './selection/select';

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

export function getLinkedMirrorUuid(loadedObjectGroup: Group, uuid: string): string | undefined {
    return getMirrorPairs(loadedObjectGroup, 'objectMirrorPairs').get(uuid);
}

export function syncLinkedMirrorPivot(loadedObjectGroup: Group, uuid: string, localPivot: Vector3): void {
    if (!mirrorModeling) return;
    const partnerUuid = getLinkedMirrorUuid(loadedObjectGroup, uuid);
    const refs = loadedObjectGroup.userData.objectUuidToInstance as Map<string, { mesh: PdeMesh; instanceId: number }> | undefined;
    const source = refs?.get(uuid);
    const partner = partnerUuid ? refs?.get(partnerUuid) : undefined;
    if (!source || !partner) return;

    const sourceMatrix = source.mesh.isInstancedMesh
        ? source.mesh.getMatrixAt(source.instanceId, new Matrix4())
        : source.mesh.matrix;
    const partnerMatrix = partner.mesh.isInstancedMesh
        ? partner.mesh.getMatrixAt(partner.instanceId, new Matrix4())
        : partner.mesh.matrix;
    const mirroredPivot = localPivot.clone()
        .applyMatrix4(source.mesh.matrixWorld.clone().multiply(sourceMatrix))
        .applyMatrix4(worldXReflection)
        .applyMatrix4(partner.mesh.matrixWorld.clone().multiply(partnerMatrix).invert());
    const pivots = (partner.mesh.userData.customPivots ??= new Map<number, Vector3>()) as Map<number, Vector3>;
    pivots.set(partner.instanceId, mirroredPivot);
    partner.mesh.userData.isCustomPivot = true;
}

export function syncLinkedMirrorGroupPivot(loadedObjectGroup: Group, groupId: string, worldPivot: Vector3): void {
    if (!mirrorModeling) return;
    const partnerId = getMirrorPairs(loadedObjectGroup, 'groupMirrorPairs').get(groupId);
    const groups = GroupUtils.getGroups(loadedObjectGroup);
    const partner = partnerId ? groups.get(partnerId) : undefined;
    if (!groups.has(groupId) || !partner) return;
    partner.pivot = worldPivot.clone().setX(-worldPivot.x);
    partner.isCustomPivot = true;
}

function getItemUuid(loadedObjectGroup: Group, { mesh, instanceId }: SelectedItem): string | undefined {
    return (loadedObjectGroup.userData.instanceKeyToObjectUuid as Map<string, string> | undefined)
        ?.get(GroupUtils.getGroupKey(mesh, instanceId));
}

export function getLinkedMirrorSelection(loadedObjectGroup: Group, items: SelectedItem[], groupIds: Set<string>): {
    objects: Map<PdeMesh, Set<number>>;
    groups: Set<string>;
} {
    const objects = new Map<PdeMesh, Set<number>>();
    const groups = new Set<string>();
    if (!mirrorModeling) return { objects, groups };

    const selectedUuids = new Set(items.map(item => getItemUuid(loadedObjectGroup, item)).filter((uuid): uuid is string => !!uuid));
    const objectPairs = getMirrorPairs(loadedObjectGroup, 'objectMirrorPairs');
    const refs = loadedObjectGroup.userData.objectUuidToInstance as Map<string, { mesh: PdeMesh; instanceId: number }> | undefined;
    for (const uuid of selectedUuids) {
        const partnerUuid = objectPairs.get(uuid);
        const partner = partnerUuid && !selectedUuids.has(partnerUuid) ? refs?.get(partnerUuid) : undefined;
        if (!partner) continue;
        const ids = objects.get(partner.mesh) ?? new Set<number>();
        ids.add(partner.instanceId);
        objects.set(partner.mesh, ids);
    }

    const groupPairs = getMirrorPairs(loadedObjectGroup, 'groupMirrorPairs');
    for (const groupId of groupIds) {
        const partnerId = groupPairs.get(groupId);
        if (partnerId && !groupIds.has(partnerId)) groups.add(partnerId);
    }
    return { objects, groups };
}

if (import.meta.env.DEV) {
    const testGroup = new Group();
    const source = new Mesh();
    const partner = new Mesh();
    testGroup.userData.instanceKeyToObjectUuid = new Map([[GroupUtils.getGroupKey(source, 0), 'source']]);
    partner.position.x = -1;
    partner.updateMatrix();
    testGroup.userData.objectUuidToInstance = new Map([
        ['source', { mesh: source, instanceId: 0 }],
        ['partner', { mesh: partner, instanceId: 0 }]
    ]);
    linkMirrorPair(getMirrorPairs(testGroup, 'objectMirrorPairs'), 'source', 'partner');
    const groupChild = new InstancedMesh(undefined!, undefined!, 1);
    groupChild.setMatrixAt(0, new Matrix4());
    testGroup.userData.groups = new Map([
        ['sourceGroup', { id: 'sourceGroup', children: [], parent: null, matrix: new Matrix4().makeTranslation(0.75, 0, 0) }],
        ['partnerGroup', {
            id: 'partnerGroup', children: [{ type: 'object', mesh: groupChild, instanceId: 0 }], parent: null,
            matrix: worldXReflection.clone().multiply(new Matrix4().makeTranslation(0.75, 0, 0))
        }]
    ]);
    linkMirrorPair(getMirrorPairs(testGroup, 'groupMirrorPairs'), 'sourceGroup', 'partnerGroup');
    const previous = mirrorModeling;
    mirrorModeling = true;
    console.assert(getLinkedMirrorSelection(testGroup, [{ type: 'object', mesh: source, instanceId: 0 }], new Set()).objects.get(partner)?.has(0), 'Mirror partner selection failed.');
    syncLinkedMirrorPivot(testGroup, 'source', new Vector3(1, 2, 3));
    syncLinkedMirrorGroupPivot(testGroup, 'sourceGroup', new Vector3(1, 2, 3));
    console.assert(partner.userData.customPivots.get(0).equals(new Vector3(-1, 2, 3)), 'Object custom pivot X was not mirrored.');
    const partnerGroup = testGroup.userData.groups.get('partnerGroup');
    console.assert(partnerGroup.pivot.equals(new Vector3(-1, 2, 3)), 'Group world pivot X was not sign-negated.');
    testGroup.userData.groups.get('partnerGroup').matrix.makeTranslation(-1, 0, 0);
    syncLinkedMirrorGroupPivot(testGroup, 'sourceGroup', new Vector3(1, 2, 3));
    console.assert(testGroup.userData.groups.get('partnerGroup').pivot.equals(new Vector3(-1, 2, 3)), 'Group world pivot changed with the mirrored group frame.');
    applyLinkedMirrorDelta(testGroup, new Matrix4().makeTranslation(1, 0, 0), [], new Set(['sourceGroup']));
    const childMatrix = new Matrix4();
    groupChild.getMatrixAt(0, childMatrix);
    console.assert(childMatrix.elements[12] === -1, 'Mirrored group children must update with the group.');
    groupChild.setMatrixAt(0, new Matrix4().makeTranslation(-3, 0, 0));
    const pivotDelta = new Matrix4().makeTranslation(2, 0, 0)
        .multiply(new Matrix4().makeRotationZ(Math.PI / 2))
        .multiply(new Matrix4().makeTranslation(-2, 0, 0));
    applyLinkedMirrorDelta(testGroup, pivotDelta, [], new Set(['sourceGroup']));
    groupChild.getMatrixAt(0, childMatrix);
    console.assert(new Vector3().setFromMatrixPosition(childMatrix).distanceTo(new Vector3(-3, 0, 0)) < 1e-9, 'Mirrored group transform ignored the reflected custom pivot.');
    mirrorModeling = previous;
    const point = new Vector3(3, 2, 1);
    console.assert(point.clone().applyMatrix4(worldXReflection).applyMatrix4(worldXReflection).equals(point), 'Mirror reflection must be reversible.');
}

export function applyLinkedMirrorDelta(
    loadedObjectGroup: Group,
    deltaMatrix: Matrix4,
    items: SelectedItem[],
    groupIds: Set<string>
): void {
    const linked = getLinkedMirrorSelection(loadedObjectGroup, items, groupIds);
    if (linked.objects.size === 0 && linked.groups.size === 0) return;

    for (const groupId of linked.groups) {
        for (const child of GroupUtils.getAllGroupChildren(loadedObjectGroup, groupId)) {
            const ids = linked.objects.get(child.mesh) ?? new Set<number>();
            ids.add(child.instanceId);
            linked.objects.set(child.mesh, ids);
        }
    }

    const mirroredDelta = worldXReflection.clone().multiply(deltaMatrix).multiply(worldXReflection);
    applyDeltaToSelection({
        deltaMatrix: mirroredDelta,
        meshToInstanceRanges: new Map(Array.from(linked.objects, ([mesh, ids]) => [mesh, mergeInstanceIds([...ids])])),
        selectedGroupIds: linked.groups,
        loadedObjectGroup
    });
}
