import { Box3, InstancedMesh, Matrix4, type BufferGeometry, type Group, type Material } from 'three/webgpu';
import { dragSelectedAttributeName, entityVisibleAttributeName } from '../../entity-material';
import { getInstancedCapacity, setInstanceSkyBrightness } from '../display/display-instancing';
import { getPlayerHeadRenderMatrix, PLAYER_HEAD_ATLAS_SIZE, PLAYER_HEAD_BLOCKS_PER_ROW, PLAYER_HEAD_BLOCK_WIDTH, PLAYER_HEAD_BLOCK_HEIGHT, type PlayerHeadSkin } from '../display/player-head-atlas';
import type { OtherItem } from '../pbde/pbde-types';

export function findAppendablePlayerHeadMesh(root: Group, material: Material, geometry: BufferGeometry): InstancedMesh | undefined {
    geometry.computeBoundingSphere();
    const identity = new Matrix4();
    let last: InstancedMesh | undefined;
    for (const child of root.children) {
        const mesh = child as InstancedMesh;
        if (!mesh.isMesh) return;
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        if (mesh.renderOrder !== 0 || !materials.some(material => material.transparent)) continue;
        // Appending must preserve the entire transparent draw sequence for
        // every camera. Different sort centers or object transforms fall back.
        if (mesh.matrixAutoUpdate) mesh.updateMatrix();
        if (!mesh.matrix.equals(identity)) return;
        mesh.geometry.computeBoundingSphere();
        if (!mesh.geometry.boundingSphere!.center.equals(geometry.boundingSphere!.center)) return;
        if (!last || mesh.id > last.id) last = mesh;
    }
    if (!last?.userData.playerHeadBatch || last.material !== material || getInstancedCapacity(last) <= last.count) return;
    if (last.userData.hasHat?.slice(0, last.count).some(Boolean)) return;
    for (const name of ['position', 'normal', 'uv', 'uvMirrorCenter', 'headLayer']) {
        const current = last.geometry.getAttribute(name), expected = geometry.getAttribute(name);
        if (!current || current.count !== expected.count || current.itemSize !== expected.itemSize) return;
        for (let vertex = 0; vertex < expected.count; vertex++) for (let component = 0; component < expected.itemSize; component++) {
            if (current.getComponent(vertex, component) !== expected.getComponent(vertex, component)) return;
        }
    }
    const current = last.geometry.getIndex(), expected = geometry.getIndex();
    if (!current || !expected || current.count !== expected.count || current.array.some((value, index) => value !== expected.array[index])) return;
    return last;
}

export function appendPlayerHeadEntries(mesh: InstancedMesh, entries: Array<{ item: OtherItem; skin: PlayerHeadSkin }>, register: (item: OtherItem, instanceId: number) => void): number {
    const count = Math.min(entries.length, getInstancedCapacity(mesh) - mesh.count);
    if (entries.slice(0, count).some(entry => entry.skin.hasHat)) return 0;
    // Double-sided transparent head materials draw back faces before front
    // faces. Only disjoint, fully opaque base heads can share those passes.
    mesh.geometry.computeBoundingBox();
    const localBox = mesh.geometry.boundingBox!;
    const boxes: Box3[] = [];
    const matrix = new Matrix4();
    const bounds = new Box3();
    for (let index = 0; index < mesh.count + count; index++) {
        if (index < mesh.count) mesh.getMatrixAt(index, matrix);
        else {
            const { item } = entries[index - mesh.count];
            matrix.fromArray(item.transform).transpose().multiply(getPlayerHeadRenderMatrix(item.displayType));
            matrix.fromArray(Float32Array.from(matrix.elements));
        }
        const box = localBox.clone().applyMatrix4(matrix);
        box.expandByScalar(1e-5 * Math.max(1, ...box.min.toArray().map(Math.abs), ...box.max.toArray().map(Math.abs)));
        boxes.push(box); bounds.union(box);
    }
    const size = bounds.max.clone().sub(bounds.min);
    const axis = size.x >= size.y && size.x >= size.z ? 'x' : size.y >= size.z ? 'y' : 'z';
    boxes.sort((a, b) => a.min[axis] - b.min[axis]);
    // ponytail: sweep can be quadratic for a thin layout; a spatial index is
    // only needed if profiling shows large opaque head imports spending time here.
    for (let index = 0; index < boxes.length; index++) for (let next = index + 1; next < boxes.length && boxes[next].min[axis] <= boxes[index].max[axis]; next++) {
        if (boxes[index].intersectsBox(boxes[next])) return 0;
    }
    const attributes = mesh.geometry.attributes;
    for (let index = 0; index < count; index++) {
        const { item, skin } = entries[index];
        const instanceId = mesh.count + index;
        const matrix = new Matrix4().fromArray(item.transform).transpose().multiply(getPlayerHeadRenderMatrix(item.displayType));
        mesh.setMatrixAt(instanceId, matrix);
        const x = (skin.slot % PLAYER_HEAD_BLOCKS_PER_ROW) * PLAYER_HEAD_BLOCK_WIDTH;
        const y = Math.floor(skin.slot / PLAYER_HEAD_BLOCKS_PER_ROW) * PLAYER_HEAD_BLOCK_HEIGHT;
        attributes.instancedUvOffset.setXY(instanceId, x / PLAYER_HEAD_ATLAS_SIZE, 1 - (y + PLAYER_HEAD_BLOCK_HEIGHT) / PLAYER_HEAD_ATLAS_SIZE);
        attributes.instancedUvFlip.setXY(instanceId, 0, 0);
        attributes.instancedKnifeUvScale.setXYZ(instanceId, 1, 1, 1);
        attributes.instancedKnifeUvOffset.setXYZ(instanceId, 0, 0, 0);
        attributes.headLayerVisible.setX(instanceId, 1);
        attributes[dragSelectedAttributeName].setX(instanceId, 0);
        attributes[entityVisibleAttributeName].setX(instanceId, 1);
        mesh.userData.hasHat[instanceId] = skin.hasHat;
        setInstanceSkyBrightness(mesh, instanceId, item.brightness);
        register(item, instanceId);
    }
    mesh.count += count;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    for (const name of ['instancedUvOffset', 'instancedUvFlip', 'instancedKnifeUvScale', 'instancedKnifeUvOffset', 'headLayerVisible', dragSelectedAttributeName, entityVisibleAttributeName]) attributes[name].needsUpdate = true;
    mesh.visible = true;
    mesh.computeBoundingBox();
    mesh.computeBoundingSphere();
    return count;
}
