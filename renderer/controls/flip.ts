import { BoxGeometry, Group, InstancedMesh, Matrix4, Mesh, Vector3 } from 'three/webgpu';
import { applyDeltaToSelection } from './selection/drag';
import { flipPlayerHeadTexture, replaceDisplayObjects } from '../load-project/mesh-builder';
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
    const localPivot = center
        ? Overlay.getInstanceLocalBox(mesh, instanceId)?.getCenter(new Vector3()) ?? new Vector3()
        : new Vector3();
    worldMatrix.multiply(getWorldReflection(axis, localPivot));
    matrix.copy(mesh.matrixWorld.clone().invert().multiply(worldMatrix));
}

function reflectDisplayPosition(matrix: Matrix4, mesh: PdeMesh, axis: FlipAxis, pivotWorld: Vector3): void {
    const axisIndex = { x: 0, y: 1, z: 2 }[axis];
    const position = new Vector3().setFromMatrixPosition(matrix).applyMatrix4(mesh.matrixWorld);
    position.setComponent(axisIndex, 2 * pivotWorld.getComponent(axisIndex) - position.getComponent(axisIndex));
    matrix.setPosition(position.applyMatrix4(mesh.matrixWorld.clone().invert()));
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
            if (pivotWorld) {
                const ref = refs?.get(uuid);
                if (ref) {
                    const matrix = new Matrix4();
                    ref.mesh.getMatrixAt(ref.instanceId, matrix);
                    const previousMatrix = matrix.clone();
                    reflectDisplayPosition(matrix, ref.mesh, axis, pivotWorld);
                    reflectCustomPivot(ref.mesh, ref.instanceId, axis, pivotWorld, previousMatrix, matrix);
                    ref.mesh.setMatrixAt(ref.instanceId, matrix);
                    ref.mesh.instanceMatrix.needsUpdate = true;
                }
            }
            flipPlayerHeadTexture(uuid);
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
}
