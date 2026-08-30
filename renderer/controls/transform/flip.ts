import { BoxGeometry, Group, InstancedMesh, Matrix4, Mesh, Vector3 } from 'three/webgpu';
import { applyDeltaToSelection } from '../selection/drag';
import { flipPlayerHeadTextures, getPlayerHeadRenderMatrix, replaceDisplayObjects, type DisplayReplacementResult } from '../../load-project/mesh-builder';
import { findMirroredBlockName } from '../../load-project/scene-parser';
import { mainThreadAssetProvider } from '../../load-project/pbde-assets';
import { replaceMirrorUuid } from './mirroring';
import * as Overlay from '../selection/overlay';
import * as GroupUtils from '../grouping/group';

type PdeMesh = InstancedMesh | Mesh;
export type FlipAxis = 'x' | 'y' | 'z';
export type FlipResult = Array<string | undefined> & { history?: DisplayReplacementResult['history'] };

export function resolveMirroredBlockNames(
    loadedObjectGroup: Group,
    uuids: Array<string | undefined>,
    axis: FlipAxis
): Promise<Array<string | null | undefined>> {
    const userData = loadedObjectGroup.userData;
    const isItemDisplay = userData.objectIsItemDisplay as Set<string> | undefined;
    const names = userData.objectNames as Map<string, string> | undefined;
    const blockProps = userData.objectBlockProps as Map<string, Record<string, string>> | undefined;
    const byName = new Map<string, Promise<string | null>>();
    return Promise.all(uuids.map(uuid => {
        if (!uuid || isItemDisplay?.has(uuid) || !blockProps?.get(uuid)) return undefined;
        const name = names?.get(uuid) ?? '';
        let result = byName.get(name);
        if (!result) {
            result = findMirroredBlockName(name, axis, mainThreadAssetProvider);
            byName.set(name, result);
        }
        return result;
    }));
}

function getWorldReflection(axis: FlipAxis, pivot: Vector3, target = new Matrix4()): Matrix4 {
    const axisIndex = { x: 0, y: 1, z: 2 }[axis];
    target.identity().elements[axisIndex * 5] = -1;
    target.elements[12 + axisIndex] = 2 * pivot.getComponent(axisIndex);
    return target;
}

function reflectDisplayMatrix(
    matrix: Matrix4,
    mesh: PdeMesh,
    instanceId: number,
    axis: FlipAxis,
    pivotWorld?: Vector3,
    center = false,
    inverseMeshWorld?: Matrix4
): void {
    matrix.premultiply(mesh.matrixWorld);
    const pivot = pivotWorld ?? new Vector3().setFromMatrixPosition(matrix);
    const reflection = new Matrix4();
    matrix.premultiply(getWorldReflection(axis, pivot, reflection));
    const isBlock = Overlay.getDisplayType(mesh, instanceId) === 'block_display';
    const localPivot = center || isBlock && (mesh.userData.customPivots as Map<number, Vector3> | undefined)?.has(instanceId)
        ? Overlay.getInstanceLocalBox(mesh, instanceId)?.getCenter(new Vector3())
        : isBlock ? Overlay.getInstanceLocalBoxMin(mesh, instanceId) : null;
    matrix.multiply(getWorldReflection(axis, localPivot ?? new Vector3(), reflection));
    matrix.premultiply(inverseMeshWorld ?? mesh.matrixWorld.clone().invert());
}

function reflectCustomPivot(
    mesh: PdeMesh,
    instanceId: number,
    axis: FlipAxis,
    pivotWorld: Vector3 | undefined,
    previousMatrix: Matrix4,
    matrix: Matrix4
): void {
    const pivot = (mesh.userData.customPivots as Map<number, Vector3> | undefined)?.get(instanceId);
    if (!pivot) return;
    const previousWorld = mesh.matrixWorld.clone().multiply(previousMatrix);
    const reflectionPivot = pivotWorld ?? new Vector3().setFromMatrixPosition(previousWorld);
    pivot.applyMatrix4(previousWorld)
        .applyMatrix4(getWorldReflection(axis, reflectionPivot))
        .applyMatrix4(mesh.matrixWorld.clone().multiply(matrix).invert());
}

export function reflectGroups(loadedObjectGroup: Group, groupIds: Set<string>, axis: FlipAxis, pivotWorld: Vector3, originPivotWorld = pivotWorld): void {
    if (groupIds.size === 0) return;
    const groups = GroupUtils.getGroups(loadedObjectGroup);
    const reflectedIds = new Set(groupIds);
    groupIds.forEach(id => GroupUtils.getAllDescendantGroups(loadedObjectGroup, id).forEach(childId => reflectedIds.add(childId)));
    const defaultPivots = new Map([...reflectedIds].flatMap(id => {
        const group = groups.get(id);
        return group && !GroupUtils.shouldUseGroupPivot(group)
            ? [[id, group.children.length > 0 ? Overlay.getGroupOriginWorld(id) : group.position.clone()] as const]
            : [];
    }));
    const worldReflection = getWorldReflection(axis, pivotWorld);
    const originReflection = getWorldReflection(axis, originPivotWorld);
    applyDeltaToSelection({
        deltaMatrix: worldReflection,
        selectedGroupIds: groupIds,
        loadedObjectGroup
    });

    const localReflection = getWorldReflection(axis, new Vector3());
    for (const id of reflectedIds) {
        const group = groups.get(id);
        if (!group?.matrix) continue;
        group.pivot = defaultPivots.get(id)?.applyMatrix4(originReflection) ?? group.pivot;
        group.matrix.multiply(localReflection).decompose(group.position, group.quaternion, group.scale);
    }
}

export async function flipObjectUuids(
    loadedObjectGroup: Group,
    uuids: Array<string | undefined>,
    axis: FlipAxis,
    pivotWorld?: Vector3,
    activePivotMode = 'origin',
    onPreviewApplied?: () => void,
    centeredPivotWorld?: Vector3,
    previewSynchronously = false,
    resolvedNextNames?: Array<string | null | undefined>
): Promise<FlipResult> {
    const userData = loadedObjectGroup.userData;
    const isItemDisplay = userData.objectIsItemDisplay as Set<string> | undefined;
    const names = userData.objectNames as Map<string, string> | undefined;
    const refs = userData.objectUuidToInstance as Map<string, { mesh: PdeMesh; instanceId: number }> | undefined;
    const result = [...uuids] as FlipResult;
    const nextNamesPromise = resolvedNextNames
        ? Promise.resolve(resolvedNextNames)
        : resolveMirroredBlockNames(loadedObjectGroup, uuids, axis);
    const playerHeadTextures = flipPlayerHeadTextures(uuids.filter((uuid): uuid is string =>
        !!uuid && (names?.get(uuid) ?? '').startsWith('player_head')
    ), axis);
    const reflected: Array<{
        index: number;
        uuid: string;
        ref: { mesh: PdeMesh; instanceId: number };
        previousMatrix: Matrix4;
        previousCustomPivot?: Vector3;
    }> = [];
    const applyPreview = (): void => {
        const inverseWorldMatrices = new Map<PdeMesh, Matrix4>();
        const dirtyMeshes = new Set<PdeMesh>();
        for (let index = 0; index < uuids.length; index++) {
            const uuid = uuids[index];
            if (!uuid) continue;
            const name = names?.get(uuid) ?? '';
            if (name.startsWith('player_head')) {
                const ref = refs?.get(uuid);
                if (!ref) continue;
                const matrix = new Matrix4();
                ref.mesh.getMatrixAt(ref.instanceId, matrix);
                const previousMatrix = matrix.clone();
                const renderMatrix = getPlayerHeadRenderMatrix((userData.objectDisplayTypes as Map<string, string> | undefined)?.get(uuid));
                const headPivotWorld = centeredPivotWorld ?? pivotWorld;
                const center = !centeredPivotWorld && activePivotMode === 'center';
                const reflectRenderedMatrix = axis === 'y' && center;
                if (!reflectRenderedMatrix) matrix.multiply(renderMatrix.clone().invert());
                const inverseWorld = inverseWorldMatrices.get(ref.mesh) ?? ref.mesh.matrixWorld.clone().invert();
                inverseWorldMatrices.set(ref.mesh, inverseWorld);
                reflectDisplayMatrix(matrix, ref.mesh, ref.instanceId, axis, headPivotWorld, center, inverseWorld);
                if (!reflectRenderedMatrix) matrix.multiply(renderMatrix);
                reflectCustomPivot(ref.mesh, ref.instanceId, axis, headPivotWorld, previousMatrix, matrix);
                ref.mesh.setMatrixAt(ref.instanceId, matrix);
                dirtyMeshes.add(ref.mesh);
                continue;
            }

            const ref = refs?.get(uuid);
            if (!ref) continue;
            const matrix = new Matrix4();
            ref.mesh.getMatrixAt(ref.instanceId, matrix);
            const previousMatrix = matrix.clone();
            const previousCustomPivot = (ref.mesh.userData.customPivots as Map<number, Vector3> | undefined)?.get(ref.instanceId)?.clone();
            const objectPivotWorld = isItemDisplay?.has(uuid) || Overlay.getDisplayType(ref.mesh, ref.instanceId) === 'text_display'
                ? centeredPivotWorld ?? pivotWorld
                : pivotWorld;
            const inverseWorld = inverseWorldMatrices.get(ref.mesh) ?? ref.mesh.matrixWorld.clone().invert();
            inverseWorldMatrices.set(ref.mesh, inverseWorld);
            reflectDisplayMatrix(matrix, ref.mesh, ref.instanceId, axis, objectPivotWorld, activePivotMode === 'center', inverseWorld);
            reflectCustomPivot(ref.mesh, ref.instanceId, axis, objectPivotWorld, previousMatrix, matrix);
            ref.mesh.setMatrixAt(ref.instanceId, matrix);
            dirtyMeshes.add(ref.mesh);

            reflected.push({ index, uuid, ref, previousMatrix, previousCustomPivot });
        }
        dirtyMeshes.forEach(mesh => { mesh.instanceMatrix.needsUpdate = true; });
        onPreviewApplied?.();
    };
    if (previewSynchronously) applyPreview();
    await playerHeadTextures;
    if (!previewSynchronously) applyPreview();
    const nextNames = await nextNamesPromise;

    const pending = reflected.flatMap(entry => {
        const nextName = nextNames[entry.index];
        return isItemDisplay?.has(entry.uuid) || !nextName ? [] : [{ ...entry, nextName }];
    });
    if (pending.length > 0) {
        const replacement = replaceDisplayObjects(pending.map(({ uuid, nextName }) => ({
            objectUuid: uuid,
            name: nextName,
            transformContext: { pivotMode: activePivotMode }
        })), false);
        let replacementResult: DisplayReplacementResult;
        try {
            replacementResult = await replacement;
        } catch (error) {
            if (!previewSynchronously) {
                for (const { ref, previousMatrix, previousCustomPivot } of pending) {
                    ref.mesh.setMatrixAt(ref.instanceId, previousMatrix);
                    if (previousCustomPivot) (ref.mesh.userData.customPivots as Map<number, Vector3>).set(ref.instanceId, previousCustomPivot);
                    ref.mesh.instanceMatrix.needsUpdate = true;
                }
            }
            throw error;
        }
        pending.forEach(({ index, uuid }, replacementIndex) => {
            const newUuid = replacementResult[replacementIndex];
            replaceMirrorUuid(loadedObjectGroup, uuid, newUuid);
            result[index] = newUuid;
        });
        result.history = replacementResult.history;
    }
    return result;
}

if (import.meta.env.DEV) {
    const example = new Matrix4().set(-0.8660254038, -0.5, 0, -0.125, -0.5, 0.8660254038, 0, 1.09125, 0, 0, -1, 0.5, 0, 0, 0, 1);
    reflectDisplayMatrix(example, new Mesh(), 0, 'x');
    console.assert(Math.abs(example.elements[4] - 0.5) < 1e-9 && Math.abs(example.elements[1] - 0.5) < 1e-9 && Math.abs(example.elements[12] + 0.125) < 1e-9, 'X-axis display reflection failed.');
    const headRender = getPlayerHeadRenderMatrix();
    const head = new Matrix4().makeTranslation(0.25941, 0, 0).multiply(headRender);
    head.multiply(headRender.clone().invert());
    reflectDisplayMatrix(head, new Mesh(), 0, 'x', new Vector3());
    head.multiply(headRender);
    console.assert(Math.abs(head.elements[12] + 0.25941) < 1e-9, 'Mirrored player head changed its logical X offset.');
    const centeredMesh = new Mesh(new BoxGeometry(1, 1, 1).translate(0.5, 0.5, 0.5));
    centeredMesh.userData.displayType = 'block_display';
    const centered = new Matrix4().makeTranslation(-9.9, 0, 0);
    reflectDisplayMatrix(centered, centeredMesh, 0, 'x', new Vector3(-9.4, 0, 0), true);
    console.assert(Math.abs(centered.elements[12] + 9.9) < 1e-9, 'Center display reflection moved the block origin.');
    const offsetItem = new Mesh(new BoxGeometry(1, 1, 1).translate(0, -0.5, 0));
    offsetItem.userData.displayType = 'item_display';
    const offsetItemMatrix = new Matrix4().makeTranslation(0, 2, 0);
    reflectDisplayMatrix(offsetItemMatrix, offsetItem, 0, 'y', new Vector3(), true);
    console.assert(Math.abs(offsetItemMatrix.elements[13] + 1) < 1e-9, 'Y-axis item reflection ignored its local center.');
    const item = new InstancedMesh(new BoxGeometry(1, 1, 1), undefined!, 1);
    item.setMatrixAt(0, new Matrix4());
    const itemGroup = new Group();
    itemGroup.userData.objectIsItemDisplay = new Set(['item']);
    itemGroup.userData.objectNames = new Map([['item', 'stone']]);
    itemGroup.userData.objectUuidToInstance = new Map([['item', { mesh: item, instanceId: 0 }]]);
    void flipObjectUuids(itemGroup, ['item'], 'x', new Vector3(-0.5, 0, 0), 'center', undefined, new Vector3()).then(() => {
        const itemMatrix = new Matrix4();
        item.getMatrixAt(0, itemMatrix);
        console.assert(Math.abs(itemMatrix.elements[12]) < 1e-9, 'Centered item display reflection added a block-size gap.');
    });
    const synchronousItem = new InstancedMesh(new BoxGeometry(1, 1, 1), undefined!, 1);
    synchronousItem.setMatrixAt(0, new Matrix4().makeTranslation(0.25, 0, 0));
    const synchronousGroup = new Group();
    synchronousGroup.userData.objectIsItemDisplay = new Set(['synchronous-item']);
    synchronousGroup.userData.objectNames = new Map([['synchronous-item', 'stone']]);
    synchronousGroup.userData.objectUuidToInstance = new Map([['synchronous-item', { mesh: synchronousItem, instanceId: 0 }]]);
    let synchronousPreviewApplied = false;
    void flipObjectUuids(synchronousGroup, ['synchronous-item'], 'x', new Vector3(), 'center', () => {
        synchronousPreviewApplied = true;
    }, new Vector3(), true);
    const synchronousMatrix = new Matrix4();
    synchronousItem.getMatrixAt(0, synchronousMatrix);
    console.assert(synchronousPreviewApplied && Math.abs(synchronousMatrix.elements[12] + 0.25) < 1e-9, 'Synchronous mirror preview was not ready for smart scale.');
    const text = new InstancedMesh(new BoxGeometry(1, 1, 1), undefined!, 1);
    text.userData.displayType = 'text_display';
    text.setMatrixAt(0, new Matrix4());
    itemGroup.userData.objectUuidToInstance.set('text', { mesh: text, instanceId: 0 });
    void flipObjectUuids(itemGroup, ['text'], 'x', new Vector3(-0.5, 0, 0), 'center', undefined, new Vector3()).then(() => {
        const textMatrix = new Matrix4();
        text.getMatrixAt(0, textMatrix);
        console.assert(Math.abs(textMatrix.elements[12]) < 1e-9, 'Mirrored text display added a block-size gap.');
    });
    const fence = new Mesh(new BoxGeometry(0.25, 1, 0.25).translate(0.5, 0.5, 0.5));
    fence.userData.displayType = 'block_display';
    const fenceMatrix = new Matrix4();
    reflectDisplayMatrix(fenceMatrix, fence, 0, 'x', new Vector3(0.375, 0, 0));
    console.assert(Math.abs(fenceMatrix.elements[12]) < 1e-9, 'Non-full block reflection moved the mesh.');
    const block = new InstancedMesh(new BoxGeometry(1, 1, 1), undefined, 1);
    const blockMatrix = new Matrix4().makeTranslation(-3, 1.5, 0);
    block.setMatrixAt(0, blockMatrix);
    block.userData.displayTypes = new Map([[0, 'block_display']]);
    block.userData.customPivots = new Map([[0, new Vector3(1, 0, 1)]]);
    const expectedBlockBounds = Overlay.getInstanceLocalBox(block, 0)!.applyMatrix4(blockMatrix);
    const blockPivot = block.userData.customPivots.get(0).clone().applyMatrix4(blockMatrix);
    const previousBlockMatrix = blockMatrix.clone();
    reflectDisplayMatrix(blockMatrix, block, 0, 'x', blockPivot);
    reflectCustomPivot(block, 0, 'x', blockPivot, previousBlockMatrix, blockMatrix);
    block.setMatrixAt(0, blockMatrix);
    expectedBlockBounds.applyMatrix4(getWorldReflection('x', blockPivot));
    const reflectedBlockBounds = Overlay.getInstanceLocalBox(block, 0)!.applyMatrix4(blockMatrix);
    console.assert(Math.abs(blockMatrix.elements[12] + 1) < 1e-9, 'X+1 custom block pivot produced the wrong position.');
    console.assert(reflectedBlockBounds.min.distanceTo(expectedBlockBounds.min) < 1e-9 && reflectedBlockBounds.max.distanceTo(expectedBlockBounds.max) < 1e-9, 'Custom block pivot reflection added a block-size offset.');
    console.assert(block.userData.customPivots.get(0).clone().applyMatrix4(blockMatrix).distanceTo(blockPivot) < 1e-9, 'Custom block pivot moved during reflection.');
    const group = new Group();
    const groupMatrix = new Matrix4().makeScale(2, 3, 4).setPosition(2, 0, 0);
    group.userData.groups = new Map([['group', { id: 'group', children: [], matrix: groupMatrix, position: new Vector3(2, 0, 0), quaternion: undefined, scale: new Vector3(2, 3, 4), pivot: GroupUtils.DEFAULT_GROUP_PIVOT.clone() }]]);
    reflectGroups(group, new Set(['group']), 'x', new Vector3(-0.5, 0, 0));
    const flippedGroup = group.userData.groups.get('group');
    console.assert(flippedGroup.position.x === -3 && flippedGroup.scale.equals(new Vector3(2, 3, 4)) && flippedGroup.pivot.x === -3, 'Group reflection left a negative scale or stale world pivot.');
}
