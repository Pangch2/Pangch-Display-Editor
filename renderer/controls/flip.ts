import { BoxGeometry, Group, InstancedMesh, Matrix4, Mesh, Vector3 } from 'three/webgpu';
import { applyDeltaToSelection } from './selection/drag';
import { flipPlayerHeadTextures, replaceDisplayObjects } from '../load-project/mesh-builder';
import { findMirroredBlockName } from '../load-project/scene-parser';
import { mainThreadAssetProvider } from '../load-project/pbde-assets';
import { replaceMirrorUuid } from './mirroring';
import * as Overlay from './selection/overlay';

type PdeMesh = InstancedMesh | Mesh;
export type FlipAxis = 'x' | 'y' | 'z';

function getWorldReflection(axis: FlipAxis, pivot: Vector3): Matrix4 {
    const axisIndex = { x: 0, y: 1, z: 2 }[axis];
    const scale = new Vector3(1, 1, 1).setComponent(axisIndex, -1);
    const reflection = new Matrix4().makeScale(scale.x, scale.y, scale.z);
    reflection.elements[12 + axisIndex] = 2 * pivot.getComponent(axisIndex);
    return reflection;
}

function reflectDisplayMatrix(matrix: Matrix4, mesh: PdeMesh, instanceId: number, axis: FlipAxis, pivotWorld?: Vector3, center = false): void {
    const worldMatrix = mesh.matrixWorld.clone().multiply(matrix);
    const pivot = pivotWorld ?? new Vector3().setFromMatrixPosition(worldMatrix);
    worldMatrix.premultiply(getWorldReflection(axis, pivot));
    const isBlock = Overlay.getDisplayType(mesh, instanceId) === 'block_display';
    const localPivot = center || (isBlock && (mesh.userData.customPivots as Map<number, Vector3> | undefined)?.has(instanceId))
        ? Overlay.getInstanceLocalBox(mesh, instanceId)?.getCenter(new Vector3())
        : isBlock ? Overlay.getInstanceLocalBoxMin(mesh, instanceId) : null;
    worldMatrix.multiply(getWorldReflection(axis, localPivot ?? new Vector3()));
    matrix.copy(mesh.matrixWorld.clone().invert().multiply(worldMatrix));
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

export function reflectGroups(loadedObjectGroup: Group, groupIds: Set<string>, axis: FlipAxis, pivotWorld: Vector3): void {
    if (groupIds.size === 0) return;
    applyDeltaToSelection({
        deltaMatrix: getWorldReflection(axis, pivotWorld),
        selectedGroupIds: groupIds,
        loadedObjectGroup
    });
}

export async function flipObjectUuids(
    loadedObjectGroup: Group,
    uuids: Array<string | undefined>,
    axis: FlipAxis,
    pivotWorld?: Vector3,
    activePivotMode = 'origin',
    onPreviewApplied?: () => void
): Promise<Array<string | undefined>> {
    const userData = loadedObjectGroup.userData;
    const isItemDisplay = userData.objectIsItemDisplay as Set<string> | undefined;
    const names = userData.objectNames as Map<string, string> | undefined;
    const blockProps = userData.objectBlockProps as Map<string, Record<string, string>> | undefined;
    const refs = userData.objectUuidToInstance as Map<string, { mesh: PdeMesh; instanceId: number }> | undefined;
    const result = [...uuids];
    const nextNames = await Promise.all(uuids.map(uuid => {
        if (!uuid || isItemDisplay?.has(uuid) || !blockProps?.get(uuid)) return undefined;
        return findMirroredBlockName(names?.get(uuid) ?? '', axis, mainThreadAssetProvider);
    }));
    await flipPlayerHeadTextures(uuids.filter((uuid): uuid is string =>
        !!uuid && (names?.get(uuid) ?? '').startsWith('player_head')
    ));
    const pending: Array<{
        index: number;
        uuid: string;
        ref: { mesh: PdeMesh; instanceId: number };
        previousMatrix: Matrix4;
        previousCustomPivot?: Vector3;
        nextName: string;
    }> = [];
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
            reflectDisplayMatrix(matrix, ref.mesh, ref.instanceId, axis, pivotWorld, activePivotMode === 'center');
            reflectCustomPivot(ref.mesh, ref.instanceId, axis, pivotWorld, previousMatrix, matrix);
            ref.mesh.setMatrixAt(ref.instanceId, matrix);
            ref.mesh.instanceMatrix.needsUpdate = true;
            continue;
        }

        const ref = refs?.get(uuid);
        if (!ref) continue;
        const nextName = nextNames[index];
        const matrix = new Matrix4();
        ref.mesh.getMatrixAt(ref.instanceId, matrix);
        const previousMatrix = matrix.clone();
        const previousCustomPivot = (ref.mesh.userData.customPivots as Map<number, Vector3> | undefined)?.get(ref.instanceId)?.clone();
        reflectDisplayMatrix(matrix, ref.mesh, ref.instanceId, axis, pivotWorld, activePivotMode === 'center');
        reflectCustomPivot(ref.mesh, ref.instanceId, axis, pivotWorld, previousMatrix, matrix);
        ref.mesh.setMatrixAt(ref.instanceId, matrix);
        ref.mesh.instanceMatrix.needsUpdate = true;

        if (isItemDisplay?.has(uuid) || !nextName) {
            continue;
        }
        pending.push({ index, uuid, ref, previousMatrix, previousCustomPivot, nextName });
    }
    onPreviewApplied?.();

    if (pending.length > 0) {
        const replacement = replaceDisplayObjects(pending.map(({ uuid, nextName }) => ({
            objectUuid: uuid,
            name: nextName,
            transformContext: { pivotMode: activePivotMode }
        })));
        let newUuids: string[];
        try {
            newUuids = await replacement;
        } catch (error) {
            for (const { ref, previousMatrix, previousCustomPivot } of pending) {
                ref.mesh.setMatrixAt(ref.instanceId, previousMatrix);
                if (previousCustomPivot) (ref.mesh.userData.customPivots as Map<number, Vector3>).set(ref.instanceId, previousCustomPivot);
                ref.mesh.instanceMatrix.needsUpdate = true;
            }
            throw error;
        }
        pending.forEach(({ index, uuid }, replacementIndex) => {
            const newUuid = newUuids[replacementIndex];
            replaceMirrorUuid(loadedObjectGroup, uuid, newUuid);
            result[index] = newUuid;
        });
    }
    return result;
}

if (import.meta.env.DEV) {
    const example = new Matrix4().set(-0.8660254038, -0.5, 0, -0.125, -0.5, 0.8660254038, 0, 1.09125, 0, 0, -1, 0.5, 0, 0, 0, 1);
    reflectDisplayMatrix(example, new Mesh(), 0, 'x');
    console.assert(Math.abs(example.elements[4] - 0.5) < 1e-9 && Math.abs(example.elements[1] - 0.5) < 1e-9 && Math.abs(example.elements[12] + 0.125) < 1e-9, 'X-axis display reflection failed.');
    const centered = new Matrix4().makeTranslation(-9.9, 0, 0);
    reflectDisplayMatrix(centered, new Mesh(new BoxGeometry(1, 1, 1).translate(0.5, 0.5, 0.5)), 0, 'x', new Vector3(-9.4, 0, 0), true);
    console.assert(Math.abs(centered.elements[12] + 9.9) < 1e-9, 'Center display reflection moved the block origin.');
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
    group.userData.groups = new Map([['group', { id: 'group', children: [], matrix: groupMatrix, position: new Vector3(2, 0, 0), quaternion: undefined, scale: new Vector3(2, 3, 4) }]]);
    reflectGroups(group, new Set(['group']), 'x', new Vector3(2, 0, 0));
    const flippedGroup = group.userData.groups.get('group');
    console.assert(flippedGroup.position.x === 2 && flippedGroup.matrix.determinant() < 0, 'Group reflection did not update the root group transform.');
}
