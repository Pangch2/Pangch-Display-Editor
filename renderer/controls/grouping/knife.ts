import { Box3, BufferAttribute, Group, InterleavedBufferAttribute, InstancedMesh, Matrix4, Mesh, Vector3 } from 'three/webgpu';
import { duplicateGroupsAndObjects, type DuplicationSelection } from './duplicate';
import * as GroupUtils from './group';
import * as Overlay from '../selection/overlay';
import type { SelectionState, SelectedItem } from '../selection/select';
import { getLinkedMirrorSelection, getMirrorPairs, linkMirrorPair } from '../transform/mirroring';

type KnifeItem = { mesh: Mesh | InstancedMesh; instanceId: number };
type KnifeUvAttribute = BufferAttribute | InterleavedBufferAttribute;

export interface KnifeResult extends DuplicationSelection {
    changed: boolean;
}

function getItemKey({ mesh, instanceId }: KnifeItem): string {
    return GroupUtils.getGroupKey(mesh, instanceId);
}

function getItemUuid(loadedObjectGroup: Group, item: KnifeItem): string | undefined {
    return (loadedObjectGroup.userData.instanceKeyToObjectUuid as Map<string, string> | undefined)?.get(getItemKey(item));
}

function collectKnifeItems(loadedObjectGroup: Group, selection: SelectionState, includeMirrors: boolean): KnifeItem[] {
    const items = new Map<string, KnifeItem>();
    const add = (item: KnifeItem): void => { items.set(getItemKey(item), item); };
    const directItems: SelectedItem[] = [];

    selection.groups.forEach(groupId => GroupUtils.getAllGroupChildren(loadedObjectGroup, groupId).forEach(add));
    selection.objects.forEach((ids, mesh) => ids.forEach(instanceId => {
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

function getObjectMatrix(item: KnifeItem, out: Matrix4): Matrix4 {
    if (item.mesh.isInstancedMesh) return item.mesh.getMatrixAt(item.instanceId, out);
    if (item.mesh.matrixAutoUpdate) item.mesh.updateMatrix();
    return out.copy(item.mesh.matrix);
}

function setObjectMatrix(item: KnifeItem, value: Matrix4): void {
    if (item.mesh.isInstancedMesh) {
        item.mesh.setMatrixAt(item.instanceId, value);
        return;
    }

    item.mesh.matrix.copy(value);
    value.decompose(item.mesh.position, item.mesh.quaternion, item.mesh.scale);
    item.mesh.matrixWorldNeedsUpdate = true;
}

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

function duplicateItems(loadedObjectGroup: Group, source: KnifeItem, count: number): KnifeItem[] {
    const duplicated = duplicateGroupsAndObjects(loadedObjectGroup, null, Array(count).fill(source));
    return Array.from(duplicated.objects, ([mesh, ids]) => [...ids].map(instanceId => ({ mesh, instanceId }))).flat();
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
        objects: new Map(Array.from(selection.objects, ([mesh, ids]) => [mesh, new Set(ids)])),
        changed: items.length > 0 && pieceCount > 1
    };
    if (!result.changed) return result;
    if (!Number.isSafeInteger(pieceCount)) throw new Error('나이프 결과가 너무 큽니다.');

    const selectedDirectKeys = new Set(Array.from(selection.objects, ([mesh, ids]) =>
        [...ids].map(instanceId => GroupUtils.getGroupKey(mesh, instanceId))
    ).flat());
    const copiesByUuid = new Map<string, Array<string | undefined>>();
    const updatedMeshes = new Set<Mesh | InstancedMesh>();
    const updatedAttributes = new Set<KnifeUvAttribute>();
    const originalMatrix = new Matrix4();
    const pieceMatrix = new Matrix4();
    const modelInverse = new Matrix4();
    const cellMatrix = new Matrix4();

    for (const source of items) {
        const geometryBounds = Overlay.getInstanceLocalBox(source.mesh, source.instanceId);
        if (!geometryBounds) throw new Error('나눌 수 없는 오브젝트가 선택되어 있습니다.');

        const modelMatrix = (source.mesh.userData.localMatrices as Map<number, Matrix4> | undefined)?.get(source.instanceId);
        const bounds = geometryBounds.clone();
        if (modelMatrix) bounds.applyMatrix4(modelMatrix);
        getObjectMatrix(source, originalMatrix);

        const sourceUvScale = source.mesh.geometry.getAttribute('instancedKnifeUvScale') as KnifeUvAttribute | undefined;
        const sourceUvOffset = source.mesh.geometry.getAttribute('instancedKnifeUvOffset') as KnifeUvAttribute | undefined;
        const originalUvScale = sourceUvScale
            ? new Vector3(sourceUvScale.getX(source.instanceId), sourceUvScale.getY(source.instanceId), sourceUvScale.getZ(source.instanceId))
            : null;
        const originalUvOffset = sourceUvOffset
            ? new Vector3(sourceUvOffset.getX(source.instanceId), sourceUvOffset.getY(source.instanceId), sourceUvOffset.getZ(source.instanceId))
            : null;

        const pieces = [source, ...duplicateItems(loadedObjectGroup, source, pieceCount - 1)];
        if (pieces.length !== pieceCount) throw new Error('오브젝트 복제에 실패했습니다.');

        const uuids = pieces.map(item => getItemUuid(loadedObjectGroup, item));
        const sourceUuid = uuids[0];
        if (sourceUuid) copiesByUuid.set(sourceUuid, uuids);

        for (let index = 0; index < pieces.length; index++) {
            getCellMatrix(bounds, x, y, z, index, cellMatrix);
            pieceMatrix.copy(originalMatrix);
            if (modelMatrix && Math.abs(modelMatrix.determinant()) > 1e-10) {
                pieceMatrix.multiply(modelInverse.copy(modelMatrix).invert()).multiply(cellMatrix).multiply(modelMatrix);
            } else {
                pieceMatrix.multiply(cellMatrix);
            }
            setObjectMatrix(pieces[index], pieceMatrix);
            updatedMeshes.add(pieces[index].mesh);

            if (originalUvScale && originalUvOffset) {
                const uvScale = pieces[index].mesh.geometry.getAttribute('instancedKnifeUvScale') as KnifeUvAttribute | undefined;
                const uvOffset = pieces[index].mesh.geometry.getAttribute('instancedKnifeUvOffset') as KnifeUvAttribute | undefined;
                if (uvScale && uvOffset) {
                    const column = index % x;
                    const row = Math.floor(index / x) % y;
                    const layer = Math.floor(index / (x * y));
                    uvScale.setXYZ(pieces[index].instanceId, originalUvScale.x / x, originalUvScale.y / y, originalUvScale.z / z);
                    uvOffset.setXYZ(
                        pieces[index].instanceId,
                        originalUvOffset.x + originalUvScale.x * column / x,
                        originalUvOffset.y + originalUvScale.y * row / y,
                        originalUvOffset.z + originalUvScale.z * layer / z
                    );
                    updatedAttributes.add(uvScale);
                    updatedAttributes.add(uvOffset);
                }
            }

            if (index > 0 && selectedDirectKeys.has(getItemKey(source))) {
                const ids = result.objects.get(pieces[index].mesh) ?? new Set<number>();
                ids.add(pieces[index].instanceId);
                result.objects.set(pieces[index].mesh, ids);
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
            }
        }
    }

    updatedMeshes.forEach(mesh => {
        if (mesh.isInstancedMesh) {
            mesh.instanceMatrix.needsUpdate = true;
            mesh.computeBoundingSphere();
        }
    });
    updatedAttributes.forEach(attribute => { attribute.needsUpdate = true; });
    return result;
}

if (import.meta.env.DEV) {
    const bounds = new Box3(new Vector3(0, 0, 0), new Vector3(2, 2, 1));
    const union = new Box3();
    for (let index = 0; index < 8; index++) union.union(bounds.clone().applyMatrix4(getCellMatrix(bounds, 2, 2, 2, index)));
    console.assert(union.min.equals(bounds.min) && union.max.equals(bounds.max), 'Knife cells must preserve the original bounds.');
}
