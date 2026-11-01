import { Group, InstancedMesh, Matrix4, Mesh, Vector3 } from 'three/webgpu';
import { applyDeltaToSelection } from '../selection/drag';
import { mergeInstanceIds } from '../selection/instance-ranges';
import * as GroupUtils from '../grouping/group';
import * as Overlay from '../selection/overlay';
import type { SelectedItem } from '../selection/select';

type PdeMesh = InstancedMesh | Mesh;
type MirrorPairKey = 'objectMirrorPairs' | 'groupMirrorPairs';

const worldXReflection = new Matrix4().makeScale(-1, 1, 1).setPosition(-1, 0, 0);
const centeredXReflection = new Matrix4().makeScale(-1, 1, 1);
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

export function linkMirrorGroupPair(loadedObjectGroup: Group, a?: string, b?: string): void {
    const groups = GroupUtils.getGroups(loadedObjectGroup);
    const source = groups.get(a);
    const partner = groups.get(b);
    if (!source || !partner) return;
    const pairs = getMirrorPairs(loadedObjectGroup, 'groupMirrorPairs');
    linkMirrorPair(pairs, a, b);
    const children = source.children.filter(child => child.type === 'group');
    const partnerChildren = partner.children.filter(child => child.type === 'group');
    if (children.length !== partnerChildren.length) return;
    const partnerIds = new Set(partnerChildren.map(child => child.id));
    const unpairedPartners = partnerChildren.filter(child => !pairs.has(child.id));
    if (children.filter(child => !pairs.has(child.id)).length !== unpairedPartners.length) return;
    let partnerIndex = 0;
    for (const child of children) {
        const partnerId = pairs.get(child.id) ?? unpairedPartners[partnerIndex++]?.id;
        if (partnerIds.has(partnerId)) linkMirrorGroupPair(loadedObjectGroup, child.id, partnerId);
    }
}

function getLinkedMirrorGroupId(loadedObjectGroup: Group, groupId: string): string | undefined {
    const pairs = getMirrorPairs(loadedObjectGroup, 'groupMirrorPairs');
    if (pairs.has(groupId)) return pairs.get(groupId);
    const groups = GroupUtils.getGroups(loadedObjectGroup);
    let parentId = groups.get(groupId)?.parent;
    while (parentId) {
        const partnerId = pairs.get(parentId);
        if (partnerId) {
            // shortcut: legacy unlinked siblings use saved order; recreate mirrors if their hierarchies diverged.
            linkMirrorGroupPair(loadedObjectGroup, parentId, partnerId);
            return pairs.get(groupId);
        }
        parentId = groups.get(parentId)?.parent;
    }
    return undefined;
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

function getObjectReflection(mesh: PdeMesh, instanceId: number): Matrix4 {
    const displayType = Overlay.getDisplayType(mesh, instanceId);
    return (displayType === 'block_display' || displayType === 'item_display' || displayType === 'text_display')
        ? centeredXReflection
        : worldXReflection;
}

export function syncLinkedMirrorPivot(loadedObjectGroup: Group, uuid: string, localPivot: Vector3): void {
    if (!mirrorModeling) return;
    const partnerUuid = getLinkedMirrorUuid(loadedObjectGroup, uuid);
    const refs = loadedObjectGroup.userData.objectUuidToInstance as Map<string, { mesh: PdeMesh; instanceId: number }> | undefined;
    const source = refs?.get(uuid);
    const partner = partnerUuid ? refs?.get(partnerUuid) : undefined;
    if (!source || !partner) return;

    const sourceMatrix = source.mesh.matrixWorld.clone();
    const partnerMatrix = partner.mesh.matrixWorld.clone();
    if (source.mesh.isInstancedMesh) sourceMatrix.multiply(source.mesh.getMatrixAt(source.instanceId, new Matrix4()));
    if (partner.mesh.isInstancedMesh) partnerMatrix.multiply(partner.mesh.getMatrixAt(partner.instanceId, new Matrix4()));
    const mirroredPivot = localPivot.clone()
        .applyMatrix4(sourceMatrix)
        .applyMatrix4(getObjectReflection(source.mesh, source.instanceId))
        .applyMatrix4(partnerMatrix.invert());
    if (partner.mesh.isInstancedMesh) {
        const pivots = (partner.mesh.userData.customPivots ??= new Map<number, Vector3>()) as Map<number, Vector3>;
        pivots.set(partner.instanceId, mirroredPivot);
    } else partner.mesh.userData.customPivot = mirroredPivot;
    partner.mesh.userData.isCustomPivot = true;
}

export function syncLinkedMirrorGroupPivot(loadedObjectGroup: Group, groupId: string, worldPivot: Vector3): void {
    if (!mirrorModeling) return;
    const partnerId = getLinkedMirrorGroupId(loadedObjectGroup, groupId);
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

    for (const groupId of groupIds) {
        const partnerId = getLinkedMirrorGroupId(loadedObjectGroup, groupId);
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
    partner.updateMatrixWorld(true);
    testGroup.userData.objectUuidToInstance = new Map([
        ['source', { mesh: source, instanceId: 0 }],
        ['partner', { mesh: partner, instanceId: 0 }]
    ]);
    linkMirrorPair(getMirrorPairs(testGroup, 'objectMirrorPairs'), 'source', 'partner');
    replaceMirrorUuid(testGroup, 'source', 'replacement');
    console.assert(getLinkedMirrorUuid(testGroup, 'replacement') === 'partner' && getLinkedMirrorUuid(testGroup, 'partner') === 'replacement', 'Mirror UUID replacement broke the pair.');
    replaceMirrorUuid(testGroup, 'replacement', 'source');
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
    console.assert(partner.userData.customPivot.equals(new Vector3(-1, 2, 3)), 'Object custom pivot X was not mirrored.');
    source.userData.displayType = 'block_display';
    syncLinkedMirrorPivot(testGroup, 'source', new Vector3(1.046789, 0, 0));
    console.assert(Math.abs(partner.userData.customPivot.x + 0.046789) < 1e-9, 'Block display pivot did not mirror around X=0.5.');
    syncLinkedMirrorPivot(testGroup, 'source', new Vector3(0, 0, 0));
    console.assert(Math.abs(partner.userData.customPivot.x - 1) < 1e-9, 'Block display origin pivot did not mirror to X=1.');
    source.userData.displayType = 'item_display';
    source.userData.hasHat = [true];
    partner.userData.displayType = 'item_display';
    partner.position.set(0, 0, 0);
    partner.updateMatrixWorld(true);
    syncLinkedMirrorPivot(testGroup, 'source', new Vector3(0.279198, 0, 0));
    console.assert(Math.abs(partner.userData.customPivot.x + 0.279198) < 1e-9, 'Centered item pivot used the block reflection plane.');
    const centeredRotation = getObjectReflection(source, 0).clone().multiply(new Matrix4().makeRotationZ(Math.PI / 2)).multiply(getObjectReflection(source, 0));
    console.assert(Math.abs(centeredRotation.elements[13]) < 1e-9, 'Player head rotation added a Y offset.');
    delete source.userData.displayType;
    delete partner.userData.displayType;
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

    const groupedObjects = new Map<PdeMesh, Set<number>>();
    for (const groupId of linked.groups) {
        for (const child of GroupUtils.getAllGroupChildren(loadedObjectGroup, groupId)) {
            const ids = linked.objects.get(child.mesh) ?? new Set<number>();
            ids.add(child.instanceId);
            linked.objects.set(child.mesh, ids);
            const groupedIds = groupedObjects.get(child.mesh) ?? new Set<number>();
            groupedIds.add(child.instanceId);
            groupedObjects.set(child.mesh, groupedIds);
        }
    }

    for (const [mesh, ids] of linked.objects) {
        const byReflection = new Map<Matrix4, number[]>();
        for (const instanceId of ids) {
            const reflection = groupedObjects.get(mesh)?.has(instanceId)
                ? worldXReflection
                : getObjectReflection(mesh, instanceId);
            const reflectionIds = byReflection.get(reflection) ?? [];
            reflectionIds.push(instanceId);
            byReflection.set(reflection, reflectionIds);
        }
        for (const [reflection, instanceIds] of byReflection) {
            applyDeltaToSelection({
                deltaMatrix: reflection.clone().multiply(deltaMatrix).multiply(reflection),
                meshToInstanceRanges: new Map([[mesh, mergeInstanceIds(instanceIds)]]),
                loadedObjectGroup
            });
        }
    }
    if (linked.groups.size > 0) {
        applyDeltaToSelection({
            deltaMatrix: worldXReflection.clone().multiply(deltaMatrix).multiply(worldXReflection),
            selectedGroupIds: linked.groups,
            loadedObjectGroup
        });
    }
}
