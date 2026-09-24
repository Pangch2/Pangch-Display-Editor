import * as THREE from 'three/webgpu';
import * as Overlay from '../../controls/selection/overlay';
import * as GroupUtils from '../../controls/grouping/group';
import { type DeletedSceneDelta, deleteSelectedItems } from '../../controls/grouping/delete';
import { loadedObjectGroup, type GlobalBrightness, type Brightness, setInstanceSkyBrightness, isInstancedGeometryAttribute, addTextDisplayItems } from './display-instancing';
import { getPlayerHeadRenderMatrix, PLAYER_HEAD_LAYER_SCALE, getPlayerHeadTexture } from './player-head-atlas';
import { getItemDisplayModelMatrix } from '../scene/scene-parser';
import { isApplying } from '../../controls/undo-redo/undo-redo';
import { changeInstanceModelTransform, removeInstanceModelTransform } from '../batching/instance-model-transform';
import { isSceneHistoryResourceRetained } from '../../controls/undo-redo/scene-history';
import { entityVisibleAttributeName, setEntityStateAttributes, dragSelectedAttributeName } from '../../entity-material';
import { type GroupData, type OtherItem } from '../pbde/pbde-types';
import { textDisplayInstanceAttributeNames, createTextDisplayTemplates, getTextDisplayTemplateKey, type TextDisplayOptions } from './text-display';
import { loadAndRenderPbde, performSelection } from './project-renderer';
import { compressSync, strToU8 } from 'fflate';
import { getLinkedMirrorUuid, isMirrorModelingEnabled, replaceMirrorUuid } from '../../controls/transform/mirroring';

export { loadedObjectGroup, beginPbdeLoadGeneration, type GlobalBrightness, type LoadedSelection } from './display-instancing';
export { deferredPlayerHeadTexture } from './player-head-atlas';
export { getPlayerHeadRenderMatrix } from './player-head-atlas';
export { type PlayerHeadPaintSurface } from './player-head-atlas';
export { notifyPlayerHeadAtlasesChanged } from './player-head-atlas';
export { type PlayerHeadAtlasFace } from './player-head-atlas';
export { getPlayerHeadAtlasFaces } from './player-head-atlas';
export { createImageHeadAtlasMeshes } from './player-head-atlas';
export { mirrorPlayerHeadPaint } from './player-head-atlas';
export { performSelection } from './project-renderer';
export { loadAndRenderPbde } from './project-renderer';
export { capturePlayerHeadAtlasState } from './player-head-atlas';
export { restorePlayerHeadAtlasState } from './player-head-atlas';
export { cleanupUnusedPlayerHeadAtlasSlots } from './player-head-atlas';
export { getPlayerHeadPaintSurface } from './player-head-atlas';
export { readPlayerHeadPaint } from './player-head-atlas';
export { writePlayerHeadPaint } from './player-head-atlas';
export { commitPlayerHeadPaint } from './player-head-atlas';
export { getPlayerHeadTexture } from './player-head-atlas';
export { replacePlayerHeadTextureReference } from './player-head-atlas';
export { setPlayerHeadLayerVisible } from './player-head-atlas';
export { updatePlayerHeadTexture } from './player-head-atlas';
export { flipPlayerHeadTextures } from './player-head-atlas';

export type DisplayReplacementResult = string[] & {
    history?: { removed: DeletedSceneDelta; created: Map<THREE.InstancedMesh, Set<number>> };
};
export async function updateDisplayObjectMatrix(objectUuid: string, name: string): Promise<void> {
    const userData = loadedObjectGroup.userData;
    const ref = (userData.objectUuidToInstance as Map<string, { mesh: THREE.InstancedMesh; instanceId: number }> | undefined)?.get(objectUuid);
    if (!ref) throw new Error('변경할 디스플레이 오브젝트를 찾을 수 없습니다.');

    const names = userData.objectNames as Map<string, string>;
    const displayTypes = userData.objectDisplayTypes as Map<string, string>;
    const oldName = names.get(objectUuid) ?? name;
    const oldDisplayType = displayTypes.get(objectUuid);
    const newDisplayType = /\bdisplay=([^,\]]+)/.exec(name)?.[1];
    const matrix = new THREE.Matrix4();
    ref.mesh.getMatrixAt(ref.instanceId, matrix);

    if (name.startsWith('player_head')) {
        matrix.multiply(getPlayerHeadRenderMatrix(oldDisplayType).invert()).multiply(getPlayerHeadRenderMatrix(newDisplayType));
    } else {
        const [oldModelMatrix, newModelMatrix] = await Promise.all([
            getItemDisplayModelMatrix(oldName),
            getItemDisplayModelMatrix(name)
        ]);
        if (!oldModelMatrix || !newModelMatrix) throw new Error('디스플레이 행렬을 계산할 수 없습니다.');
        changeInstanceModelTransform(ref.mesh, ref.instanceId, matrix, oldModelMatrix, newModelMatrix);
    }

    const pivot = (ref.mesh.userData.customPivots as Map<number, THREE.Vector3> | undefined)?.get(ref.instanceId)?.clone()
        ?? Overlay.getInstanceLocalBox(ref.mesh, ref.instanceId)?.getCenter(new THREE.Vector3());
    if (ref.mesh.userData.hasHat) pivot?.setY(Overlay.isItemDisplayHatEnabled(ref.mesh, ref.instanceId) ? 0.03125 : 0);
    if (pivot) {
        const oldMatrix = new THREE.Matrix4();
        ref.mesh.getMatrixAt(ref.instanceId, oldMatrix);
        const target = pivot.clone().applyMatrix4(oldMatrix);
        const offset = target.sub(pivot.clone().applyMatrix4(matrix));
        matrix.elements[12] += offset.x;
        matrix.elements[13] += offset.y;
        matrix.elements[14] += offset.z;
    }

    ref.mesh.setMatrixAt(ref.instanceId, matrix);
    ref.mesh.instanceMatrix.needsUpdate = true;
    ref.mesh.computeBoundingBox();
    ref.mesh.computeBoundingSphere();
    names.set(objectUuid, name);
    if (newDisplayType) displayTypes.set(objectUuid, newDisplayType);
    else displayTypes.delete(objectUuid);
    if (!isApplying()) window.dispatchEvent(new CustomEvent('pde:scene-updated'));
}

function disposeUnusedTextDisplayResources(geometry: THREE.BufferGeometry, material: THREE.Material): void {
    let geometryUsed = false;
    let materialUsed = false;
    let textureUsed = false;
    const texture = (material as THREE.Material & { map?: THREE.Texture | null }).map;
    loadedObjectGroup.traverse(object => {
        if (!(object as THREE.Mesh).isMesh) return;
        const mesh = object as THREE.Mesh;
        geometryUsed ||= mesh.geometry === geometry;
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        materialUsed ||= materials.includes(material);
        textureUsed ||= !!texture && materials.some(candidate => (
            candidate as THREE.Material & { map?: THREE.Texture | null }
        ).map === texture);
    });
    if (!geometryUsed && !isSceneHistoryResourceRetained(geometry)) geometry.dispose();
    const atlasMaterial = !!material.userData.textDisplayAtlas;
    if (!materialUsed && !atlasMaterial && !isSceneHistoryResourceRetained(material)) material.dispose();
    if (texture && !textureUsed && !atlasMaterial && !isSceneHistoryResourceRetained(texture)) texture.dispose();
}

export function isolateTextDisplay(objectUuid: string): void {
    const userData = loadedObjectGroup.userData;
    const refs = userData.objectUuidToInstance as Map<string, { mesh: THREE.InstancedMesh; instanceId: number }> | undefined;
    const ref = refs?.get(objectUuid);
    if (!ref || ref.mesh.count <= 1 || Overlay.getDisplayType(ref.mesh, ref.instanceId) !== 'text_display') return;

    const oldMesh = ref.mesh;
    const oldInstanceId = ref.instanceId;
    const oldLastInstanceId = oldMesh.count - 1;
    const geometry = oldMesh.geometry.clone();
    for (const attributeName of textDisplayInstanceAttributeNames) {
        const source = oldMesh.geometry.getAttribute(attributeName);
        const values = new Float32Array(source.itemSize);
        for (let component = 0; component < source.itemSize; component++) {
            values[component] = source.getComponent(oldInstanceId, component);
        }
        geometry.setAttribute(attributeName, new THREE.InstancedBufferAttribute(values, source.itemSize));
    }
    geometry.boundingBox = Overlay.getInstanceLocalBox(oldMesh, oldInstanceId)?.clone() ?? geometry.boundingBox;
    if (geometry.boundingBox) geometry.boundingSphere = geometry.boundingBox.getBoundingSphere(new THREE.Sphere());
    setEntityStateAttributes(geometry, 1, [oldMesh.geometry.getAttribute(entityVisibleAttributeName)?.getX(oldInstanceId) ?? 1]);
    const mesh = new THREE.InstancedMesh(geometry, oldMesh.material, 1);
    mesh.instanceMatrix = new THREE.StorageInstancedBufferAttribute(1, 16);
    const matrix = new THREE.Matrix4();
    oldMesh.getMatrixAt(oldInstanceId, matrix);
    mesh.setMatrixAt(0, matrix);
    mesh.instanceMatrix.needsUpdate = true;
    mesh.userData.displayType = 'text_display';
    mesh.frustumCulled = oldMesh.frustumCulled;
    mesh.renderOrder = oldMesh.renderOrder;
    mesh.visible = oldMesh.visible;
    mesh.layers.mask = oldMesh.layers.mask;

    const brightness = (userData.objectBrightness as Map<string, Brightness> | undefined)?.get(objectUuid);
    setInstanceSkyBrightness(mesh, 0, brightness);
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    for (const key of ['customPivots', 'localMatrices', 'displayTypes', 'textDisplayTemplateKeys'] as const) {
        const values = oldMesh.userData[key] as Map<number, unknown> | undefined;
        const value = values?.get(oldInstanceId);
        if (value !== undefined) mesh.userData[key] = new Map([[0, value]]);
    }

    const oldKey = GroupUtils.getGroupKey(oldMesh, oldInstanceId);
    const newKey = GroupUtils.getGroupKey(mesh, 0);
    const keyToUuid = userData.instanceKeyToObjectUuid as Map<string, string>;
    keyToUuid.delete(oldKey);
    keyToUuid.set(newKey, objectUuid);
    refs!.set(objectUuid, { mesh, instanceId: 0 });
    const objectToGroup = userData.objectToGroup as Map<string, string> | undefined;
    const groupId = objectToGroup?.get(oldKey);
    objectToGroup?.delete(oldKey);
    if (groupId) {
        objectToGroup!.set(newKey, groupId);
        const group = (userData.groups as Map<string, GroupData> | undefined)?.get(groupId);
        const child = group?.children.find(candidate => candidate.type === 'object' && candidate.id === objectUuid);
        if (child?.type === 'object') {
            child.mesh = mesh;
            child.instanceId = 0;
        }
    }

    if (oldInstanceId < oldLastInstanceId) {
        oldMesh.getMatrixAt(oldLastInstanceId, matrix);
        oldMesh.setMatrixAt(oldInstanceId, matrix);
        if (oldMesh.instanceColor) {
            const color = new THREE.Color();
            oldMesh.getColorAt(oldLastInstanceId, color);
            oldMesh.setColorAt(oldInstanceId, color);
        }
        for (const attribute of Object.values(oldMesh.geometry.attributes)) {
            if (!isInstancedGeometryAttribute(attribute)) continue;
            const instanced = attribute;
            if (instanced.isInterleavedBufferAttribute) {
                for (let component = 0; component < instanced.itemSize; component++) {
                    instanced.setComponent(oldInstanceId, component, instanced.getComponent(oldLastInstanceId, component));
                }
            } else {
                const source = oldLastInstanceId * instanced.itemSize;
                const target = oldInstanceId * instanced.itemSize;
                instanced.array.copyWithin(target, source, source + instanced.itemSize);
            }
            instanced.needsUpdate = true;
        }
        for (const key of ['customPivots', 'localMatrices', 'displayTypes', 'textDisplayTemplateKeys'] as const) {
            const values = oldMesh.userData[key] as Map<number, unknown> | undefined;
            values?.delete(oldInstanceId);
            if (values?.has(oldLastInstanceId)) values.set(oldInstanceId, values.get(oldLastInstanceId));
            values?.delete(oldLastInstanceId);
        }
        GroupUtils.updateGroupReferenceForMovedInstance(loadedObjectGroup, oldMesh, oldLastInstanceId, oldInstanceId);
    } else {
        for (const key of ['customPivots', 'localMatrices', 'displayTypes', 'textDisplayTemplateKeys'] as const) {
            (oldMesh.userData[key] as Map<number, unknown> | undefined)?.delete(oldInstanceId);
        }
    }
    oldMesh.count--;
    oldMesh.instanceMatrix.needsUpdate = true;
    if (oldMesh.instanceColor) oldMesh.instanceColor.needsUpdate = true;
    oldMesh.computeBoundingBox();
    oldMesh.computeBoundingSphere();
    mesh.computeBoundingBox();
    mesh.computeBoundingSphere();
    loadedObjectGroup.add(mesh);

    window.dispatchEvent(new CustomEvent('pde:replace-object-selection', { detail: [{
        oldMesh,
        oldInstanceId,
        oldLastInstanceId,
        mesh,
        instanceId: 0
    }] }));
}

export async function updateTextDisplay(objectUuid: string, name: string, options: TextDisplayOptions): Promise<void> {
    const userData = loadedObjectGroup.userData;
    const refs = userData.objectUuidToInstance as Map<string, { mesh: THREE.InstancedMesh; instanceId: number }> | undefined;
    let ref = refs?.get(objectUuid);
    if (!ref || Overlay.getDisplayType(ref.mesh, ref.instanceId) !== 'text_display') {
        throw new Error('변경할 텍스트 디스플레이를 찾을 수 없습니다.');
    }

    const templateKey = getTextDisplayTemplateKey({ name, options });
    const replacement = (await createTextDisplayTemplates([{ name, options, atlasKey: objectUuid }])).get(templateKey)!;
    const replacementMaterial = replacement.material as THREE.MeshBasicNodeMaterial;
    if (ref.mesh.material === replacementMaterial) {
        for (const attributeName of textDisplayInstanceAttributeNames) {
            const target = ref.mesh.geometry.getAttribute(attributeName);
            const source = replacement.geometry.getAttribute(attributeName);
            for (let component = 0; component < target.itemSize; component++) {
                target.setComponent(ref.instanceId, component, source.getComponent(0, component));
            }
            target.needsUpdate = true;
        }
        ref.mesh.geometry.boundingBox?.union(replacement.geometry.boundingBox!);
        if (ref.mesh.geometry.boundingBox) ref.mesh.geometry.boundingSphere = ref.mesh.geometry.boundingBox.getBoundingSphere(new THREE.Sphere());
        ref.mesh.computeBoundingSphere();
        replacement.geometry.dispose();
        (userData.objectNames as Map<string, string>).set(objectUuid, name);
        const optionMap = (userData.objectTextDisplayOptions as Map<string, TextDisplayOptions> | undefined)
            ?? (userData.objectTextDisplayOptions = new Map<string, TextDisplayOptions>());
        optionMap.set(objectUuid, { ...options });
        const templateKeys = (ref.mesh.userData.textDisplayTemplateKeys as Map<number, string> | undefined)
            ?? (ref.mesh.userData.textDisplayTemplateKeys = new Map<number, string>());
        templateKeys.set(ref.instanceId, templateKey);
        Overlay.updateSelectionOverlayObject(ref.mesh, ref.instanceId);
        return;
    }

    isolateTextDisplay(objectUuid);
    ref = refs?.get(objectUuid);
    if (!ref) throw new Error('변경할 텍스트 디스플레이를 찾을 수 없습니다.');
    const oldGeometry = ref.mesh.geometry;
    const oldMaterial = ref.mesh.material as THREE.Material;
    const oldBounds = oldGeometry.boundingBox?.clone();
    const currentMaterial = oldMaterial as THREE.MeshBasicNodeMaterial;
    const boundsUnchanged = !!oldBounds?.equals(replacement.geometry.boundingBox!);
    if (
        boundsUnchanged
        && ref.mesh.userData.textDisplayMaterialOwned
        && !replacementMaterial.userData.textDisplayAtlas
        && currentMaterial.map
        && replacementMaterial.map
        && currentMaterial.map.image.width === replacementMaterial.map.image.width
        && currentMaterial.map.image.height === replacementMaterial.map.image.height
    ) {
        const pipelineChanged = currentMaterial.depthWrite !== replacementMaterial.depthWrite
            || currentMaterial.alphaTest !== replacementMaterial.alphaTest;
        currentMaterial.map.image = replacementMaterial.map.image;
        currentMaterial.map.needsUpdate = true;
        currentMaterial.depthWrite = replacementMaterial.depthWrite;
        currentMaterial.alphaTest = replacementMaterial.alphaTest;
        currentMaterial.visible = replacementMaterial.visible;
        if (pipelineChanged) currentMaterial.needsUpdate = true;
        replacement.geometry.dispose();
        replacementMaterial.map.dispose();
        replacementMaterial.dispose();
    } else {
        setEntityStateAttributes(replacement.geometry, 1, [
            oldGeometry.getAttribute(entityVisibleAttributeName)?.getX(ref.instanceId) ?? 1
        ]);
        replacement.geometry.getAttribute(dragSelectedAttributeName).setX(
            0,
            oldGeometry.getAttribute(dragSelectedAttributeName)?.getX(ref.instanceId) ?? 0
        );
        if (import.meta.env.DEV) console.assert(
            replacement.geometry.getAttribute(dragSelectedAttributeName) !== oldGeometry.getAttribute(dragSelectedAttributeName)
            && replacement.geometry.getAttribute(entityVisibleAttributeName) !== oldGeometry.getAttribute(entityVisibleAttributeName),
            'Text display replacement must own its entity state attributes.'
        );
        ref.mesh.geometry = replacement.geometry;
        ref.mesh.material = replacementMaterial;
        ref.mesh.userData.textDisplayMaterialOwned = !replacementMaterial.userData.textDisplayAtlas;
        ref.mesh.computeBoundingBox();
        ref.mesh.computeBoundingSphere();
        disposeUnusedTextDisplayResources(oldGeometry, oldMaterial);
    }
    (userData.objectNames as Map<string, string>).set(objectUuid, name);
    const optionMap = (userData.objectTextDisplayOptions as Map<string, TextDisplayOptions> | undefined)
        ?? (userData.objectTextDisplayOptions = new Map<string, TextDisplayOptions>());
    optionMap.set(objectUuid, { ...options });
    (ref.mesh.userData.textDisplayTemplateKeys as Map<number, string> | undefined)
        ?.set(ref.instanceId, templateKey);
    Overlay.updateSelectionOverlayObject(ref.mesh, ref.instanceId);
}

window.addEventListener('pde:history-restored', event => {
    if (!(event as CustomEvent<{ scene?: boolean }>).detail?.scene) return;
    const userData = loadedObjectGroup.userData;
    const options = userData.objectTextDisplayOptions as Map<string, TextDisplayOptions> | undefined;
    const names = userData.objectNames as Map<string, string> | undefined;
    if (!options || !names) return;
    void Promise.all([...options].map(([uuid, value]) => updateTextDisplay(uuid, names.get(uuid) ?? '', value)))
        .catch(error => console.error('텍스트 디스플레이 복원에 실패했습니다.', error));
});

export async function replaceDisplayObjects(requests: Array<{
    objectUuid: string;
    name: string;
    transformContext?: { pivotMode: string; pivotWorld?: THREE.Vector3 };
    isItemDisplay?: boolean;
    isTextDisplay?: boolean;
    options?: TextDisplayOptions;
}>, syncMirror = true): Promise<DisplayReplacementResult> {
    if (requests.length === 0) return [] as DisplayReplacementResult;
    const requestedCount = requests.length;
    if (syncMirror && isMirrorModelingEnabled()) {
        const requestedUuids = new Set(requests.map(request => request.objectUuid));
        requests = requests.concat(requests.flatMap(request => {
            const partnerUuid = getLinkedMirrorUuid(loadedObjectGroup, request.objectUuid);
            if (!partnerUuid || requestedUuids.has(partnerUuid)) return [];
            requestedUuids.add(partnerUuid);
            return [{
                ...request,
                objectUuid: partnerUuid,
                transformContext: request.transformContext && { pivotMode: request.transformContext.pivotMode }
            }];
        }));
    }
    const ud = loadedObjectGroup.userData;
    const refs = ud.objectUuidToInstance as Map<string, { mesh: THREE.InstancedMesh; instanceId: number }>;
    const preserveVisibleSize = localStorage.getItem('pdeObjectReplaceMode') === 'preserve-visible-size';
    const getOverlaySize = (mesh: THREE.InstancedMesh, instanceId: number, instanceMatrix: THREE.Matrix4): THREE.Vector3 | null => {
        const box = Overlay.getInstanceLocalBox(mesh, instanceId);
        if (!box) return null;
        const matrix = instanceMatrix.clone().scale(box.getSize(new THREE.Vector3())).premultiply(mesh.matrixWorld);
        return new THREE.Vector3(
            new THREE.Vector3().setFromMatrixColumn(matrix, 0).length(),
            new THREE.Vector3().setFromMatrixColumn(matrix, 1).length(),
            new THREE.Vector3().setFromMatrixColumn(matrix, 2).length()
        );
    };
    const previousSceneOrder = (ud.sceneOrder as Array<{ type: 'group' | 'object'; id: string }> | undefined)?.slice();
    const sceneIndexes = new Map(previousSceneOrder?.map((entry, index) => [entry.type === 'object' ? entry.id : '', index]) ?? []);
    const previousGroupChildren = new Map<string, GroupData['children']>();
    const replacements = requests.map(({ objectUuid, name, transformContext, isItemDisplay: requestedItemDisplay, isTextDisplay = false, options }) => {
        const oldRef = refs?.get(objectUuid);
        if (!oldRef?.mesh?.isInstancedMesh) throw new Error('교체할 오브젝트를 찾을 수 없습니다.');

        const oldMatrix = new THREE.Matrix4();
        oldRef.mesh.getMatrixAt(oldRef.instanceId, oldMatrix);
        const displayedMatrix = oldMatrix.clone();
        removeInstanceModelTransform(oldRef.mesh, oldRef.instanceId, oldMatrix);
        const oldOverlaySize = preserveVisibleSize ? getOverlaySize(oldRef.mesh, oldRef.instanceId, displayedMatrix) : null;
        const oldName = (ud.objectNames as Map<string, string> | undefined)?.get(objectUuid) ?? '';
        const wasPlayerHead = oldName.startsWith('player_head');
        const isPlayerHead = name.startsWith('player_head');
        const oldDisplayType = (ud.objectDisplayTypes as Map<string, string> | undefined)?.get(objectUuid);
        const oldGeometryDisplayType = Overlay.getDisplayType(oldRef.mesh, oldRef.instanceId);
        const oldPlayerHeadScale = wasPlayerHead && Overlay.isItemDisplayHatEnabled(oldRef.mesh, oldRef.instanceId) ? PLAYER_HEAD_LAYER_SCALE : 1;
        if (isPlayerHead) oldMatrix.multiply(getPlayerHeadRenderMatrix(oldDisplayType).invert());
        const groupId = (ud.objectToGroup as Map<string, string> | undefined)?.get(`${oldRef.mesh.uuid}_${oldRef.instanceId}`);
        const group = groupId ? (ud.groups as Map<string, GroupData> | undefined)?.get(groupId) : undefined;
        if (groupId && group && !previousGroupChildren.has(groupId)) previousGroupChildren.set(groupId, [...group.children]);
        const wasItemDisplay = (ud.objectIsItemDisplay as Set<string> | undefined)?.has(objectUuid) ?? false;
        const isItemDisplay = !isTextDisplay && (requestedItemDisplay ?? wasItemDisplay);
        const displayTypeChanged = oldGeometryDisplayType !== (isTextDisplay ? 'text_display' : isItemDisplay ? 'item_display' : 'block_display');
        const customPivot = (oldRef.mesh.userData.customPivots as Map<number, THREE.Vector3> | undefined)?.get(oldRef.instanceId)?.clone();
        const pivot = transformContext?.pivotMode === 'center' || displayTypeChanged
            ? Overlay.getInstanceLocalBox(oldRef.mesh, oldRef.instanceId)?.getCenter(new THREE.Vector3())
            : customPivot ?? (oldGeometryDisplayType === 'block_display' && !wasPlayerHead && !isPlayerHead
                ? Overlay.getInstanceLocalBoxMin(oldRef.mesh, oldRef.instanceId)
                : Overlay.getInstanceLocalBox(oldRef.mesh, oldRef.instanceId)?.getCenter(new THREE.Vector3()));
        const pivotParent = transformContext?.pivotWorld ? undefined : pivot?.clone().applyMatrix4(displayedMatrix);
        const pivotWorld = transformContext?.pivotWorld?.clone()
            ?? pivotParent?.clone().applyMatrix4(oldRef.mesh.matrixWorld);
        const replacementUuid = THREE.MathUtils.generateUUID();
        const label = (ud.objectLabels as Map<string, string> | undefined)?.get(objectUuid);
        const texture = getPlayerHeadTexture(objectUuid);
        return {
            objectUuid, replacementUuid, label, groupId, oldMesh: oldRef.mesh, oldInstanceId: oldRef.instanceId,
            sceneIndex: sceneIndexes.get(objectUuid) ?? -1,
            customPivot,
            customPivotParent: customPivot?.clone().applyMatrix4(displayedMatrix),
            pivotParent,
            pivotWorld,
            displayedMatrix,
            oldOverlaySize,
            oldPlayerHeadScale,
            displayTypeChanged,
            transformContext,
            node: {
                uuid: replacementUuid,
                name,
                nbt: (ud.objectNbt as Map<string, string> | undefined)?.get(objectUuid) ?? '',
                transforms: oldMatrix.clone().transpose().toArray(),
                brightness: (ud.objectBrightness as Map<string, unknown> | undefined)?.get(objectUuid),
                tagHead: texture ? { Value: btoa(JSON.stringify({ textures: { SKIN: { url: texture } } })) } : undefined,
                isBlockDisplay: !isTextDisplay && !isItemDisplay,
                isItemDisplay,
                isTextDisplay,
                options: isTextDisplay ? options : undefined
            }
        };
    });
    if (import.meta.env.DEV) console.assert(
        replacements.every((replacement, index) => replacement.objectUuid === requests[index].objectUuid),
        'Display replacement batch order changed.'
    );
    const directTextItems: OtherItem[] | null = replacements.every(state => state.node.isTextDisplay && state.displayTypeChanged)
        ? replacements.map(({ node }) => ({
            type: 'textDisplay',
            uuid: node.uuid,
            groupId: null,
            transform: node.transforms,
            name: node.name,
            nbt: node.nbt,
            brightness: node.brightness,
            options: node.options
        }))
        : null;
    if (directTextItems) {
        const keyToUuid = ud.instanceKeyToObjectUuid as Map<string, string>;
        await addTextDisplayItems(directTextItems, (mesh, instanceId, uuid) => {
            keyToUuid.set(GroupUtils.getGroupKey(mesh, instanceId), uuid);
            refs.set(uuid, { mesh, instanceId });
        });
        const names = ud.objectNames as Map<string, string>;
        const labels = ud.objectLabels as Map<string, string>;
        const textOptions = ud.objectTextDisplayOptions as Map<string, TextDisplayOptions>;
        const objectNbt = ud.objectNbt as Map<string, string>;
        const brightness = ud.objectBrightness as Map<string, unknown>;
        for (const item of directTextItems) {
            names.set(item.uuid, item.name ?? '');
            labels.set(item.uuid, 'text_display');
            textOptions.set(item.uuid, { ...((item.options as TextDisplayOptions | undefined) ?? {}) });
            objectNbt.set(item.uuid, typeof item.nbt === 'string' ? item.nbt : '');
            if (item.brightness) brightness.set(item.uuid, item.brightness);
        }
        if (import.meta.env.DEV) console.assert(
            directTextItems.every(item => refs.has(item.uuid)),
            'Direct text display replacement did not register every object.'
        );
    } else {
        const json = strToU8(JSON.stringify([{ children: replacements.map(({ node }) => node) }]));
        const raw = new Uint8Array(18 + json.length);
        raw.set([80, 82, 74, 50], 0);
        raw.set(strToU8('scene.json'), 4);
        new DataView(raw.buffer).setUint32(14, json.length, true);
        raw.set(json, 18);
        const added = await loadAndRenderPbde(new File([compressSync(raw)], 'object-update.pbde'), true);
        if (replacements.some(state => !refs.has(state.replacementUuid))) {
            deleteSelectedItems(loadedObjectGroup, {
                groups: new Set(),
                objects: new Map([...added].filter(([object]) => (object as THREE.Mesh).isMesh)) as Map<THREE.Mesh, Set<number>>
            }, { resetSelectionAndDeselect: () => {} })?.dispose();
            if (previousSceneOrder) ud.sceneOrder = previousSceneOrder;
            if (import.meta.env.DEV) console.assert(
                replacements.every(state => refs.has(state.objectUuid) && !refs.has(state.replacementUuid)),
                'Failed display replacement must preserve the original objects.'
            );
            throw new Error('선택한 속성 조합은 표시할 모델이 없어 적용할 수 없습니다.');
        }
    }
    const deletionStates = new Map<THREE.InstancedMesh, typeof replacements>();
    const boundsDirtyMeshes = new Set<THREE.InstancedMesh>();
    for (const state of replacements) {
        const states = deletionStates.get(state.oldMesh) ?? [];
        states.push(state);
        deletionStates.set(state.oldMesh, states);
    }
    const selectionReplacements: Array<{
        oldMesh: THREE.InstancedMesh;
        oldInstanceId: number;
        oldLastInstanceId: number;
        mesh: THREE.InstancedMesh;
        instanceId: number;
    }> = [];
    const deletionOrder = Array.from(deletionStates, ([mesh, states]) => {
        let oldLastInstanceId = mesh.count - 1;
        return states.sort((a, b) => b.oldInstanceId - a.oldInstanceId)
            .map(state => ({ state, oldLastInstanceId: oldLastInstanceId-- }));
    }).flat();
    const removed = deleteSelectedItems(loadedObjectGroup, {
        groups: new Set(),
        objects: new Map(Array.from(deletionStates, ([mesh, states]) => [mesh, new Set(states.map(state => state.oldInstanceId))]))
    }, { resetSelectionAndDeselect: () => {} });
    if (!removed) throw new Error('교체할 오브젝트를 삭제할 수 없습니다.');

    const replacementUuids = new Map(replacements.map(state => [state.objectUuid, state.replacementUuid]));
    if (previousSceneOrder) {
        const nextSceneOrder = previousSceneOrder.map(entry => {
            const replacementUuid = entry.type === 'object' ? replacementUuids.get(entry.id) : undefined;
            return replacementUuid ? { type: 'object' as const, id: replacementUuid } : entry;
        });
        for (const state of replacements) {
            if (state.sceneIndex < 0) nextSceneOrder.push({ type: 'object', id: state.replacementUuid });
        }
        ud.sceneOrder = nextSceneOrder;
        if (import.meta.env.DEV) console.assert(previousSceneOrder.every((entry, index) => (
            nextSceneOrder[index].id === (entry.type === 'object' ? replacementUuids.get(entry.id) ?? entry.id : entry.id)
        )), 'Display replacement changed scene order.');
    }
    for (const [groupId, children] of previousGroupChildren) {
        const group = (ud.groups as Map<string, GroupData>).get(groupId);
        group.children = children.map(child => {
            const replacementUuid = child.type === 'object' && child.id ? replacementUuids.get(child.id) : undefined;
            if (!replacementUuid) return child;
            const replacement = refs.get(replacementUuid);
            if (!replacement) throw new Error('변경한 오브젝트 모델을 만들 수 없습니다.');
            (ud.objectToGroup as Map<string, string>).set(`${replacement.mesh.uuid}_${replacement.instanceId}`, groupId);
            return { ...child, id: replacementUuid, mesh: replacement.mesh, instanceId: replacement.instanceId };
        });
    }

    for (const state of replacements) {
        if (state.label !== undefined) (ud.objectLabels as Map<string, string>).set(state.replacementUuid, state.label);

        const replacement = refs.get(state.replacementUuid);
        if (!replacement) throw new Error('변경한 오브젝트 모델을 만들 수 없습니다.');
        const playerHeadLayerScale = state.oldPlayerHeadScale / (
            state.node.name.startsWith('player_head') && Overlay.isItemDisplayHatEnabled(replacement.mesh, replacement.instanceId)
                ? PLAYER_HEAD_LAYER_SCALE : 1
        );
        const scaleReplacementMatrix = (replacementMatrix: THREE.Matrix4): void => {
            replacementMatrix.scale(new THREE.Vector3().setScalar(playerHeadLayerScale));
            if (!state.oldOverlaySize) return;
            const newOverlaySize = getOverlaySize(replacement.mesh, replacement.instanceId, replacementMatrix);
            if (!newOverlaySize) return;
            const ratio = new THREE.Vector3(
                newOverlaySize.x > 1e-10 && state.oldOverlaySize.x > 1e-10 ? state.oldOverlaySize.x / newOverlaySize.x : 1,
                newOverlaySize.y > 1e-10 && state.oldOverlaySize.y > 1e-10 ? state.oldOverlaySize.y / newOverlaySize.y : 1,
                newOverlaySize.z > 1e-10 && state.oldOverlaySize.z > 1e-10 ? state.oldOverlaySize.z / newOverlaySize.z : 1
            );
            replacementMatrix.scale(ratio);
            if (import.meta.env.DEV && Math.min(...state.oldOverlaySize.toArray(), ...newOverlaySize.toArray()) > 1e-10) {
                console.assert(getOverlaySize(replacement.mesh, replacement.instanceId, replacementMatrix)!.distanceTo(state.oldOverlaySize) < 1e-6, 'Replacement overlay size changed.');
            }
        };
        if (state.displayTypeChanged) {
            const replacementMatrix = state.displayedMatrix.clone();
            scaleReplacementMatrix(replacementMatrix);
            const offset = new THREE.Vector3();
            if (state.pivotWorld) {
                const replacementPivot = Overlay.getInstanceLocalBox(replacement.mesh, replacement.instanceId)?.getCenter(new THREE.Vector3());
                if (replacementPivot) {
                    const target = state.pivotParent?.clone()
                        ?? state.pivotWorld.clone().applyMatrix4(replacement.mesh.matrixWorld.clone().invert());
                    offset.copy(target.sub(replacementPivot.applyMatrix4(replacementMatrix)));
                }
            }
            replacementMatrix.elements[12] += offset.x;
            replacementMatrix.elements[13] += offset.y;
            replacementMatrix.elements[14] += offset.z;
            replacement.mesh.setMatrixAt(replacement.instanceId, replacementMatrix);
            replacement.mesh.instanceMatrix.needsUpdate = true;
            boundsDirtyMeshes.add(replacement.mesh);
        } else if (state.pivotWorld && (!state.customPivot || state.transformContext?.pivotMode === 'center')) {
            const replacementMatrix = new THREE.Matrix4();
            replacement.mesh.getMatrixAt(replacement.instanceId, replacementMatrix);
            scaleReplacementMatrix(replacementMatrix);
            const replacementDisplayType = Overlay.getDisplayType(replacement.mesh, replacement.instanceId);
            const replacementPivot = state.transformContext?.pivotMode === 'center'
                ? Overlay.getInstanceLocalBox(replacement.mesh, replacement.instanceId)?.getCenter(new THREE.Vector3())
                : replacementDisplayType === 'block_display'
                ? Overlay.getInstanceLocalBoxMin(replacement.mesh, replacement.instanceId)
                : Overlay.getInstanceLocalBox(replacement.mesh, replacement.instanceId)?.getCenter(new THREE.Vector3());
            if (replacementPivot) {
                const target = state.pivotParent?.clone()
                    ?? state.pivotWorld.clone().applyMatrix4(replacement.mesh.matrixWorld.clone().invert());
                const offset = target.sub(replacementPivot.applyMatrix4(replacementMatrix));
                replacementMatrix.elements[12] += offset.x;
                replacementMatrix.elements[13] += offset.y;
                replacementMatrix.elements[14] += offset.z;
                replacement.mesh.setMatrixAt(replacement.instanceId, replacementMatrix);
                replacement.mesh.instanceMatrix.needsUpdate = true;
            }
        } else if (playerHeadLayerScale !== 1 || state.oldOverlaySize) {
            const replacementMatrix = new THREE.Matrix4();
            replacement.mesh.getMatrixAt(replacement.instanceId, replacementMatrix);
            scaleReplacementMatrix(replacementMatrix);
            replacement.mesh.setMatrixAt(replacement.instanceId, replacementMatrix);
            replacement.mesh.instanceMatrix.needsUpdate = true;
        }
        if (state.customPivotParent) {
            if (!replacement.mesh.userData.customPivots) replacement.mesh.userData.customPivots = new Map<number, THREE.Vector3>();
            const replacementMatrix = new THREE.Matrix4();
            replacement.mesh.getMatrixAt(replacement.instanceId, replacementMatrix);
            replacement.mesh.userData.customPivots.set(
                replacement.instanceId,
                state.customPivotParent.applyMatrix4(replacementMatrix.invert())
            );
        }

    }
    for (const mesh of boundsDirtyMeshes) {
        mesh.computeBoundingBox();
        mesh.computeBoundingSphere();
    }
    for (const state of replacements) replaceMirrorUuid(loadedObjectGroup, state.objectUuid, state.replacementUuid);
    for (const { state, oldLastInstanceId } of deletionOrder) {
        const replacement = refs.get(state.replacementUuid)!;
        selectionReplacements.push({
            oldMesh: state.oldMesh, oldInstanceId: state.oldInstanceId, oldLastInstanceId,
            mesh: replacement.mesh, instanceId: replacement.instanceId
        });
    }
    window.dispatchEvent(new CustomEvent('pde:replace-object-selection', { detail: selectionReplacements }));
    if (!isApplying()) window.dispatchEvent(new CustomEvent('pde:scene-updated'));
    const result = replacements.slice(0, requestedCount).map(({ replacementUuid }) => replacementUuid) as DisplayReplacementResult;
    const created = new Map<THREE.InstancedMesh, Set<number>>();
    for (const state of replacements) {
        const replacement = refs.get(state.replacementUuid);
        if (!replacement) continue;
        const ids = created.get(replacement.mesh) ?? new Set<number>();
        ids.add(replacement.instanceId);
        created.set(replacement.mesh, ids);
    }
    result.history = { removed, created };
    return result;
}

export async function addDisplayObject(name: string, isItemDisplay: boolean): Promise<string> {
    const uuid = THREE.MathUtils.generateUUID();
    const transforms = name === 'player_head'
        ? new THREE.Matrix4().compose(
            new THREE.Vector3(0, 0.5, 0),
            new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI, 0, -Math.PI)),
            new THREE.Vector3(1, 1, 1)
        ).transpose().toArray()
        : new THREE.Matrix4().toArray();
    const json = strToU8(JSON.stringify([{ children: [{
        uuid,
        name,
        nbt: '',
        transforms,
        isBlockDisplay: !isItemDisplay,
        isItemDisplay
    }] }]));
    const raw = new Uint8Array(18 + json.length);
    raw.set([80, 82, 74, 50], 0);
    raw.set(strToU8('scene.json'), 4);
    new DataView(raw.buffer).setUint32(14, json.length, true);
    raw.set(json, 18);

    performSelection(
        await loadAndRenderPbde(new File([compressSync(raw)], 'object-add.pbde'), true),
        'default'
    );
    if (!isApplying()) window.dispatchEvent(new CustomEvent('pde:scene-updated'));
    return uuid;
}

export async function addTextDisplay(objectUuids: string[] = []): Promise<{ uuid: string; history?: DisplayReplacementResult['history'] }> {
    const options: TextDisplayOptions = {
        color: '#FFFFFF', alpha: 1, backgroundColor: '#000000', backgroundAlpha: 1,
        bold: false, italic: false, underline: false, strikeThrough: false, obfuscated: false,
        lineLength: 50, align: 'center', font: 'minecraft:default'
    };
    if (objectUuids.length) {
        const result = await replaceDisplayObjects(objectUuids.map(objectUuid => ({
            objectUuid, name: '텍스트 입력', isTextDisplay: true, options
        })));
        return { uuid: result[0], history: result.history };
    }
    const uuid = THREE.MathUtils.generateUUID();
    const json = strToU8(JSON.stringify([{ children: [{
        uuid,
        name: '텍스트 입력',
        nbt: '',
        transforms: new THREE.Matrix4().toArray(),
        isTextDisplay: true,
        options
    }] }]));
    const raw = new Uint8Array(18 + json.length);
    raw.set([80, 82, 74, 50], 0);
    raw.set(strToU8('scene.json'), 4);
    new DataView(raw.buffer).setUint32(14, json.length, true);
    raw.set(json, 18);

    const pivotMode = (loadedObjectGroup.userData.getPivotMode as (() => string) | undefined)?.();
    performSelection(
        await loadAndRenderPbde(new File([compressSync(raw)], 'text-display-add.pbde'), true),
        pivotMode === 'center' ? 'center' : 'default'
    );
    window.dispatchEvent(new CustomEvent('pde:scene-updated'));
    return { uuid };
}

export async function replaceDisplayObject(
    objectUuid: string,
    name: string,
    transformContext?: { pivotMode: string; pivotWorld?: THREE.Vector3 }
): Promise<DisplayReplacementResult> {
    return replaceDisplayObjects([{ objectUuid, name, transformContext }]);
}

export function updateObjectBrightness(objectUuid: string, brightness: { sky: number; block: number }): void {
    const ud = loadedObjectGroup.userData;
    const ref = (ud.objectUuidToInstance as Map<string, { mesh: THREE.InstancedMesh; instanceId: number }> | undefined)?.get(objectUuid);
    if (!ref?.mesh?.isInstancedMesh) return;
    (ud.objectBrightness as Map<string, { sky: number; block: number }>).set(objectUuid, brightness);
    setInstanceSkyBrightness(ref.mesh, ref.instanceId, brightness);
    if (ref.mesh.instanceColor) ref.mesh.instanceColor.needsUpdate = true;
    if (!isApplying()) window.dispatchEvent(new CustomEvent('pde:scene-updated'));
}

export function updateGlobalBrightness(brightness: GlobalBrightness): void {
    const ud = loadedObjectGroup.userData;
    ud.globalBrightness = brightness;
    const objectBrightness = ud.objectBrightness as Map<string, Brightness> | undefined;
    for (const [uuid, ref] of (ud.objectUuidToInstance as Map<string, { mesh: THREE.InstancedMesh; instanceId: number }> | undefined) ?? []) {
        if (!ref.mesh.isInstancedMesh) continue;
        setInstanceSkyBrightness(ref.mesh, ref.instanceId, objectBrightness?.get(uuid));
        if (ref.mesh.instanceColor) ref.mesh.instanceColor.needsUpdate = true;
    }
    if (!isApplying()) window.dispatchEvent(new CustomEvent('pde:scene-updated'));
}
