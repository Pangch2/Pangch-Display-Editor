import { Group, Matrix4, Vector3 } from 'three/webgpu';
import { applyDeltaToSelection } from '../selection/drag';
import { mergeInstanceIds } from '../selection/instance-ranges';
import * as GroupUtils from '../grouping/group';
import type { SelectedItem } from '../selection/select';
import { objectPivot, objectUuidAt, setInstanceHasHat, objectWorldMatrix, setObjectIsCustomPivot, setObjectPivot } from '../../scene-store/object-access';
import { ObjectStore } from '../../scene-store/object-store';
import { ObjectBatch } from '../../scene-store/object-batch';
import { copyMirrorPlane, getMirrorPlane, setMirrorPlane, worldXReflection } from './mirror-planes';

type MirrorPairKey = 'objectMirrorPairs' | 'groupMirrorPairs';

let mirrorModeling = false;

export const mirrorModelingPivot = new Vector3();

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
        const pairedId = pairs.get(child.id);
        const partnerId = pairedId ?? unpairedPartners[partnerIndex++]?.id;
        if (!partnerIds.has(partnerId)) continue;
        if (!pairedId) copyMirrorPlane(loadedObjectGroup, a!, b!, child.id, partnerId);
        linkMirrorGroupPair(loadedObjectGroup, child.id, partnerId);
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

export function getLinkedMirrorUuid(loadedObjectGroup: Group, uuid: string): string | undefined {
    return getMirrorPairs(loadedObjectGroup, 'objectMirrorPairs').get(uuid);
}

export function syncLinkedMirrorPivot(loadedObjectGroup: Group, uuid: string, localPivot: Vector3): void {
    if (!mirrorModeling) return;
    const partnerUuid = getLinkedMirrorUuid(loadedObjectGroup, uuid);
    const refs = loadedObjectGroup.userData.objectUuidToInstance as Map<string, { mesh: ObjectBatch; instanceId: number }> | undefined;
    const source = refs?.get(uuid);
    const partner = partnerUuid ? refs?.get(partnerUuid) : undefined;
    if (!source || !partner) return;

    const sourceMatrix = objectWorldMatrix(loadedObjectGroup, uuid, new Matrix4())!;
    const partnerMatrix = objectWorldMatrix(loadedObjectGroup, partnerUuid!, new Matrix4())!;
    const mirroredPivot = localPivot.clone()
        .applyMatrix4(sourceMatrix)
        .applyMatrix4(getMirrorPlane(loadedObjectGroup, uuid, partnerUuid))
        .applyMatrix4(partnerMatrix.invert());
    setObjectPivot(loadedObjectGroup, partnerUuid!, mirroredPivot);
    setObjectIsCustomPivot(loadedObjectGroup, partnerUuid!, true);
}

export function syncLinkedMirrorGroupPivot(loadedObjectGroup: Group, groupId: string, worldPivot: Vector3): void {
    if (!mirrorModeling) return;
    const partnerId = getLinkedMirrorGroupId(loadedObjectGroup, groupId);
    const groups = GroupUtils.getGroups(loadedObjectGroup);
    const partner = partnerId ? groups.get(partnerId) : undefined;
    if (!groups.has(groupId) || !partner) return;
    partner.pivot = worldPivot.clone().applyMatrix4(getMirrorPlane(loadedObjectGroup, groupId, partnerId));
    partner.isCustomPivot = true;
}

function getItemUuid(loadedObjectGroup: Group, { mesh, instanceId }: SelectedItem): string | undefined {
    return objectUuidAt(loadedObjectGroup, mesh, instanceId);
}

export function getLinkedMirrorSelection(loadedObjectGroup: Group, items: SelectedItem[], groupIds: Set<string>): {
    objects: Map<ObjectBatch, Set<number>>;
    groups: Set<string>;
} {
    const objects = new Map<ObjectBatch, Set<number>>();
    const groups = new Set<string>();
    if (!mirrorModeling) return { objects, groups };

    const selectedUuids = new Set(items.map(item => getItemUuid(loadedObjectGroup, item)).filter((uuid): uuid is string => !!uuid));
    const objectPairs = getMirrorPairs(loadedObjectGroup, 'objectMirrorPairs');
    const refs = loadedObjectGroup.userData.objectUuidToInstance as Map<string, { mesh: ObjectBatch; instanceId: number }> | undefined;
    const allGroups = GroupUtils.getGroups(loadedObjectGroup);
    const objectToGroup = GroupUtils.getObjectToGroup(loadedObjectGroup);
    // A partner inside a selected group already moves with that group; mirroring it too would move it twice.
    const insideSelectedGroup = (groupId: string | undefined): boolean => {
        for (const seen = new Set<string>(); groupId && !seen.has(groupId); groupId = allGroups.get(groupId)?.parent ?? undefined) {
            if (groupIds.has(groupId)) return true;
            seen.add(groupId);
        }
        return false;
    };
    for (const uuid of selectedUuids) {
        const partnerUuid = objectPairs.get(uuid);
        const partner = partnerUuid && !selectedUuids.has(partnerUuid) && !insideSelectedGroup(objectToGroup.get(partnerUuid))
            ? refs?.get(partnerUuid) : undefined;
        if (!partner) continue;
        const ids = objects.get(partner.mesh) ?? new Set<number>();
        ids.add(partner.instanceId);
        objects.set(partner.mesh, ids);
    }

    for (const groupId of groupIds) {
        const partnerId = getLinkedMirrorGroupId(loadedObjectGroup, groupId);
        if (partnerId && !insideSelectedGroup(partnerId)) groups.add(partnerId);
    }
    return { objects, groups };
}

if (import.meta.env.DEV) {
    const testGroup = new Group();
    const source = new ObjectBatch(undefined!, undefined!, 1);
    const partner = new ObjectBatch(undefined!, undefined!, 1);
    partner.position.x = -1;
    partner.updateMatrixWorld(true);
    testGroup.userData.objectUuidToInstance = new ObjectStore([
        ['source', { mesh: source, instanceId: 0 }],
        ['partner', { mesh: partner, instanceId: 0 }]
    ]);
    linkMirrorPair(getMirrorPairs(testGroup, 'objectMirrorPairs'), 'source', 'partner');
    const groupChild = new ObjectBatch(undefined!, undefined!, 1);
    groupChild.setMatrixAt(0, new Matrix4());
    testGroup.userData.objectUuidToInstance.set('groupChild', { mesh: groupChild, instanceId: 0 });
    testGroup.userData.groups = new Map([
        ['sourceGroup', { id: 'sourceGroup', children: [], parent: null, matrix: new Matrix4().makeTranslation(0.75, 0, 0) }],
        ['partnerGroup', {
            id: 'partnerGroup', children: [{ type: 'object', id: 'groupChild' }], parent: null,
            matrix: worldXReflection.clone().multiply(new Matrix4().makeTranslation(0.75, 0, 0))
        }]
    ]);
    linkMirrorPair(getMirrorPairs(testGroup, 'groupMirrorPairs'), 'sourceGroup', 'partnerGroup');
    const previous = mirrorModeling;
    mirrorModeling = true;
    console.assert(getLinkedMirrorSelection(testGroup, [{ type: 'object', mesh: source, instanceId: 0 }], new Set()).objects.get(partner)?.has(0), 'Mirror partner selection failed.');
    syncLinkedMirrorPivot(testGroup, 'source', new Vector3(1, 2, 3));
    syncLinkedMirrorGroupPivot(testGroup, 'sourceGroup', new Vector3(1, 2, 3));
    console.assert(objectPivot(testGroup, 'partner')!.equals(new Vector3(0, 2, 3)), 'Object custom pivot X was not mirrored across X=0.');
    source.userData.displayType = 'block_display';
    syncLinkedMirrorPivot(testGroup, 'source', new Vector3(1.046789, 0, 0));
    console.assert(Math.abs(objectPivot(testGroup, 'partner')!.x + 0.046789) < 1e-9, 'Block display pivot did not mirror around X=0.5.');
    syncLinkedMirrorPivot(testGroup, 'source', new Vector3(0, 0, 0));
    console.assert(Math.abs(objectPivot(testGroup, 'partner')!.x - 1) < 1e-9, 'Block display origin pivot did not mirror to X=1.');
    source.userData.displayType = 'item_display';
    setInstanceHasHat(source, 0, true);
    partner.userData.displayType = 'item_display';
    partner.position.set(0, 0, 0);
    partner.updateMatrixWorld(true);
    syncLinkedMirrorPivot(testGroup, 'source', new Vector3(0.279198, 0, 0));
    console.assert(Math.abs(objectPivot(testGroup, 'partner')!.x + 0.279198) < 1e-9, 'Centered item pivot used the block reflection plane.');
    const centeredRotation = worldXReflection.clone().multiply(new Matrix4().makeRotationZ(Math.PI / 2)).multiply(worldXReflection);
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
    groupChild.setMatrixAt(0, new Matrix4().makeTranslation(-2, 0, 0));
    const pivotDelta = new Matrix4().makeTranslation(2, 0, 0)
        .multiply(new Matrix4().makeRotationZ(Math.PI / 2))
        .multiply(new Matrix4().makeTranslation(-2, 0, 0));
    applyLinkedMirrorDelta(testGroup, pivotDelta, [], new Set(['sourceGroup']));
    groupChild.getMatrixAt(0, childMatrix);
    console.assert(new Vector3().setFromMatrixPosition(childMatrix).distanceTo(new Vector3(-2, 0, 0)) < 1e-9, 'Mirrored group transform ignored the reflected custom pivot.');
    source.setMatrixAt(0, new Matrix4().makeTranslation(1, 0, 0));
    partner.setMatrixAt(0, new Matrix4().makeTranslation(-1, 0, 0));
    applyDeltaToSelection({
        deltaMatrix: new Matrix4().makeRotationY(Math.PI / 2),
        meshToInstanceRanges: new Map([[source, [{ start: 0, count: 1 }]], [partner, [{ start: 0, count: 1 }]]]),
        loadedObjectGroup: testGroup
    });
    const turnedPlane = new Matrix4().makeScale(1, 1, -1).elements;
    console.assert(getMirrorPlane(testGroup, 'source', 'partner').elements.every((value, index) => Math.abs(value - turnedPlane[index]) < 1e-9),
        'Rotating both mirror sides together did not turn their mirror plane.');
    applyLinkedMirrorDelta(testGroup, new Matrix4().makeTranslation(0, 0, -1), [{ type: 'object', mesh: source, instanceId: 0 }], new Set());
    partner.getMatrixAt(0, childMatrix);
    console.assert(new Vector3().setFromMatrixPosition(childMatrix).distanceTo(new Vector3(0, 0, 2)) < 1e-9, 'Mirror delta ignored the turned mirror plane.');
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

    // Partners are batched by their pair's mirror plane, so each side reflects across its own plane.
    const batches = new Map<string, { plane: Matrix4; objects: Map<ObjectBatch, Set<number>>; groups: Set<string> }>();
    const batchFor = (id: string, partnerId: string | undefined) => {
        const plane = getMirrorPlane(loadedObjectGroup, id, partnerId);
        const key = plane.elements.join();
        let batch = batches.get(key);
        if (!batch) batches.set(key, batch = { plane, objects: new Map(), groups: new Set() });
        return batch;
    };
    const covered = new Map<ObjectBatch, Set<number>>();
    const add = (target: Map<ObjectBatch, Set<number>>, mesh: ObjectBatch, instanceId: number): void => {
        const ids = target.get(mesh) ?? new Set<number>();
        ids.add(instanceId);
        target.set(mesh, ids);
    };
    const groupPairs = getMirrorPairs(loadedObjectGroup, 'groupMirrorPairs');
    for (const groupId of linked.groups) {
        const batch = batchFor(groupId, groupPairs.get(groupId));
        batch.groups.add(groupId);
        for (const child of GroupUtils.getAllGroupChildren(loadedObjectGroup, groupId)) {
            add(batch.objects, child.mesh, child.instanceId);
            add(covered, child.mesh, child.instanceId);
        }
    }
    const objectPairs = getMirrorPairs(loadedObjectGroup, 'objectMirrorPairs');
    linked.objects.forEach((ids, mesh) => ids.forEach(instanceId => {
        if (covered.get(mesh)?.has(instanceId)) return;
        const uuid = objectUuidAt(loadedObjectGroup, mesh, instanceId)!;
        add(batchFor(uuid, objectPairs.get(uuid)).objects, mesh, instanceId);
    }));
    for (const { plane, objects, groups } of batches.values()) {
        applyDeltaToSelection({
            deltaMatrix: plane.clone().multiply(deltaMatrix).multiply(plane.clone().invert()),
            meshToInstanceRanges: new Map(Array.from(objects, ([mesh, ids]) => [mesh, mergeInstanceIds([...ids])])),
            selectedGroupIds: groups,
            loadedObjectGroup
        });
    }
}

/** A group pair made around existing mirror pairs mirrors across the same plane as its contents. */
export function inheritLinkedMirrorPlane(
    loadedObjectGroup: Group,
    linked: { objects: Map<ObjectBatch, Set<number>>; groups: Set<string> },
    a: string,
    b: string
): void {
    const [mesh, ids] = linked.objects.entries().next().value ?? [];
    const uuid = mesh ? objectUuidAt(loadedObjectGroup, mesh, ids!.values().next().value!) : undefined;
    const groupId = linked.groups.values().next().value;
    const [source, partner] = uuid ? [uuid, getLinkedMirrorUuid(loadedObjectGroup, uuid)]
        : groupId ? [groupId, getMirrorPairs(loadedObjectGroup, 'groupMirrorPairs').get(groupId)] : [];
    setMirrorPlane(loadedObjectGroup, a, b, source && partner ? getMirrorPlane(loadedObjectGroup, source, partner) : undefined);
}
