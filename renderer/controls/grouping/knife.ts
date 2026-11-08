import { Box3, Group, Matrix4, Vector3 } from 'three/webgpu';
import { duplicateGroupsAndObjects, type DuplicationSelection } from './duplicate';
import * as GroupUtils from './group';
import * as Overlay from '../selection/overlay';
import { toMeshMap, type SelectionState, type SelectedItem } from '../selection/select';
import { getLinkedMirrorSelection, getMirrorPairs, linkMirrorPair } from '../transform/mirroring';
import { copyMirrorPlane } from '../transform/mirror-planes';
import { getInstanceMatrix, getInstanceValue, invalidateBatchBounds, instanceValueSize, objectUuidAt, setInstanceMatrix, setInstanceValue } from '../../scene-store/object-access';
import { ObjectBatch } from '../../scene-store/object-batch';

type KnifeItem = { mesh: ObjectBatch; instanceId: number };

export interface KnifeResult extends DuplicationSelection {
    changed: boolean;
    created: DuplicationSelection;
}

function getItemKey({ mesh, instanceId }: KnifeItem): string {
    return GroupUtils.getGroupKey(mesh, instanceId);
}

function getItemUuid(loadedObjectGroup: Group, item: KnifeItem): string | undefined {
    return objectUuidAt(loadedObjectGroup, item.mesh, item.instanceId);
}

function groupItemsByMesh(items: KnifeItem[]): Map<ObjectBatch, KnifeItem[]> {
    const groups = new Map<ObjectBatch, KnifeItem[]>();
    for (const item of items) {
        const group = groups.get(item.mesh) ?? [];
        group.push(item);
        groups.set(item.mesh, group);
    }
    return groups;
}

function collectKnifeItems(loadedObjectGroup: Group, selection: SelectionState, includeMirrors: boolean): KnifeItem[] {
    const items = new Map<string, KnifeItem>();
    const add = (item: KnifeItem): void => { items.set(getItemKey(item), item); };
    const directItems: SelectedItem[] = [];

    selection.groups.forEach(groupId => GroupUtils.getAllGroupChildren(loadedObjectGroup, groupId).forEach(add));
    toMeshMap(selection.objects).forEach((ids, mesh) => ids.forEach(instanceId => {
        const item = { type: 'object' as const, mesh, instanceId };
        directItems.push(item);
        add(item);
    }));

    if (includeMirrors) {
        const linked = getLinkedMirrorSelection(loadedObjectGroup, directItems, selection.groups);
        linked.groups.forEach(groupId => GroupUtils.getAllGroupChildren(loadedObjectGroup, groupId).forEach(add));
        linked.objects.forEach((ids, mesh) => ids.forEach(instanceId => add({ mesh, instanceId })));
    }

    return [...items.values()];
}

const knifeUvScale = 'instancedKnifeUvScale', knifeUvOffset = 'instancedKnifeUvOffset';
const readUv = (item: KnifeItem, name: string): Vector3 | null => instanceValueSize(item.mesh, name) ? new Vector3(
    getInstanceValue(item.mesh, item.instanceId, name, 0), getInstanceValue(item.mesh, item.instanceId, name, 1), getInstanceValue(item.mesh, item.instanceId, name, 2)) : null;
const writeUv = (item: KnifeItem, name: string, value: Vector3): void => {
    value.toArray().forEach((component, index) => setInstanceValue(item.mesh, item.instanceId, name, component, index));
};

function getCellMatrix(bounds: Box3, x: number, y: number, z: number, index: number, out = new Matrix4()): Matrix4 {
    const scaleX = 1 / x;
    const scaleY = 1 / y;
    const scaleZ = 1 / z;
    const column = index % x;
    const row = Math.floor(index / x) % y;
    const layer = Math.floor(index / (x * y));
    return out.makeScale(scaleX, scaleY, scaleZ).setPosition(
        bounds.min.x * (1 - scaleX) + column * (bounds.max.x - bounds.min.x) / x,
        bounds.min.y * (1 - scaleY) + row * (bounds.max.y - bounds.min.y) / y,
        bounds.min.z * (1 - scaleZ) + layer * (bounds.max.z - bounds.min.z) / z
    );
}

function duplicateItems(loadedObjectGroup: Group, sources: KnifeItem[], count: number): Map<string, KnifeItem[]> {
    const copies = new Map<string, KnifeItem[]>();

    for (const meshSources of groupItemsByMesh(sources).values()) {
        const duplicated = duplicateGroupsAndObjects(loadedObjectGroup, null, meshSources.flatMap(source => Array(count).fill(source)));
        const items = Array.from(duplicated.objects, ([mesh, ids]) => [...ids].map(instanceId => ({ mesh, instanceId }))).flat();
        meshSources.forEach((source, index) => copies.set(getItemKey(source), items.slice(index * count, (index + 1) * count)));
    }

    return copies;
}

export function knifeSelection(
    loadedObjectGroup: Group,
    selection: SelectionState,
    x: number,
    y: number,
    z: number,
    includeMirrors = false
): KnifeResult {
    if (![x, y, z].every(value => Number.isInteger(value) && value >= 1)) {
        throw new Error('X, Y, Z에 1 이상의 정수를 입력해 주세요.');
    }

    const pieceCount = x * y * z;
    const items = collectKnifeItems(loadedObjectGroup, selection, includeMirrors);
    const result: KnifeResult = {
        groups: new Set(selection.groups),
        objects: toMeshMap(selection.objects),
        changed: items.length > 0 && pieceCount > 1,
        created: { groups: new Set(), objects: new Map() }
    };
    if (!result.changed) return result;
    if (!Number.isSafeInteger(pieceCount)) throw new Error('나이프 결과가 너무 큽니다.');

    const selectedDirectKeys = new Set(Array.from(toMeshMap(selection.objects), ([mesh, ids]) =>
        [...ids].map(instanceId => GroupUtils.getGroupKey(mesh, instanceId))
    ).flat());
    const copiesByUuid = new Map<string, Array<string | undefined>>();
    const updatedMeshes = new Set<ObjectBatch>();
    const originalMatrix = new Matrix4();
    const pieceMatrix = new Matrix4();
    const cellMatrix = new Matrix4();
    const boundsByItem = new Map(items.map(item => {
        const bounds = Overlay.getInstanceLocalBox(item.mesh, item.instanceId);
        if (!bounds) throw new Error('나눌 수 없는 오브젝트가 선택되어 있습니다.');
        return [getItemKey(item), bounds] as const;
    }));
    const duplicatedItems = duplicateItems(loadedObjectGroup, items, pieceCount - 1);

    for (const source of items) {
        const bounds = boundsByItem.get(getItemKey(source))!.clone();
        getInstanceMatrix(source.mesh, source.instanceId, originalMatrix);
        const originalUvScale = readUv(source, knifeUvScale);
        const originalUvOffset = readUv(source, knifeUvOffset);

        const pieces = [source, ...(duplicatedItems.get(getItemKey(source)) ?? [])];
        if (pieces.length !== pieceCount) throw new Error('오브젝트 복제에 실패했습니다.');

        const uuids = pieces.map(item => getItemUuid(loadedObjectGroup, item));
        const sourceUuid = uuids[0];
        if (sourceUuid) copiesByUuid.set(sourceUuid, uuids);

        for (let index = 0; index < pieces.length; index++) {
            getCellMatrix(bounds, x, y, z, index, cellMatrix);
            pieceMatrix.copy(originalMatrix).multiply(cellMatrix);
            setInstanceMatrix(pieces[index].mesh, pieces[index].instanceId, pieceMatrix);
            updatedMeshes.add(pieces[index].mesh);

            if (originalUvScale && originalUvOffset && instanceValueSize(pieces[index].mesh, knifeUvScale) && instanceValueSize(pieces[index].mesh, knifeUvOffset)) {
                const column = index % x;
                const row = Math.floor(index / x) % y;
                const layer = Math.floor(index / (x * y));
                writeUv(pieces[index], knifeUvScale, new Vector3(originalUvScale.x / x, originalUvScale.y / y, originalUvScale.z / z));
                writeUv(pieces[index], knifeUvOffset, new Vector3(
                    originalUvOffset.x + originalUvScale.x * column / x,
                    originalUvOffset.y + originalUvScale.y * row / y,
                    originalUvOffset.z + originalUvScale.z * layer / z));
            }

            if (index > 0 && selectedDirectKeys.has(getItemKey(source))) {
                const ids = result.objects.get(pieces[index].mesh) ?? new Set<number>();
                ids.add(pieces[index].instanceId);
                result.objects.set(pieces[index].mesh, ids);
            }
            if (index > 0) {
                const ids = result.created.objects.get(pieces[index].mesh) ?? new Set<number>();
                ids.add(pieces[index].instanceId);
                result.created.objects.set(pieces[index].mesh, ids);
            }
        }
    }

    if (includeMirrors) {
        const pairs = getMirrorPairs(loadedObjectGroup, 'objectMirrorPairs');
        const linked = new Set<string>();
        for (const [uuid, copies] of copiesByUuid) {
            const partnerUuid = pairs.get(uuid);
            const partnerCopies = partnerUuid ? copiesByUuid.get(partnerUuid) : undefined;
            if (!partnerUuid || !partnerCopies) continue;
            const pairKey = [uuid, partnerUuid].sort().join('|');
            if (linked.has(pairKey)) continue;
            linked.add(pairKey);
            for (let index = 1; index < pieceCount; index++) {
                linkMirrorPair(pairs, copies[index], partnerCopies[index]);
                if (copies[index] && partnerCopies[index]) copyMirrorPlane(loadedObjectGroup, uuid, partnerUuid, copies[index]!, partnerCopies[index]!);
            }
        }
    }

    updatedMeshes.forEach(invalidateBatchBounds);
    return result;
}

if (import.meta.env.DEV) {
    const bounds = new Box3(new Vector3(0, 0, 0), new Vector3(2, 2, 1));
    const union = new Box3();
    for (let index = 0; index < 8; index++) union.union(bounds.clone().applyMatrix4(getCellMatrix(bounds, 2, 2, 2, index)));
    console.assert(union.min.equals(bounds.min) && union.max.equals(bounds.max), 'Knife cells must preserve the original bounds.');
    const mesh = new ObjectBatch(undefined, undefined, 2);
    console.assert(groupItemsByMesh([{ mesh, instanceId: 0 }, { mesh, instanceId: 1 }]).get(mesh)?.length === 2, 'Knife copies from one mesh must stay in one batch.');
}
