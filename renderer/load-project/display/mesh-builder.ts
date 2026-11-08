import { BufferGeometry, Euler, InstancedBufferAttribute, Material, MathUtils, Matrix4, Mesh, MeshBasicNodeMaterial, Quaternion, Sphere, StorageInstancedBufferAttribute, Texture, Vector3 } from 'three/webgpu';
import * as Overlay from '../../controls/selection/overlay';
import { type DeletedSceneDelta, deleteSelectedItems } from '../../controls/grouping/delete';
import { loadedObjectGroup, type GlobalBrightness, type Brightness, setInstanceSkyBrightness, addTextDisplayItems } from './display-instancing';
import { getPlayerHeadRenderMatrix, PLAYER_HEAD_LAYER_SCALE, getPlayerHeadTexture } from './player-head-atlas';
import { getItemDisplayModelMatrix } from '../scene/scene-parser';
import { isApplying } from '../../controls/undo-redo/undo-redo';
import { changeInstanceModelTransform, removeInstanceModelTransform } from '../batching/instance-model-transform';
import { trackProjectEdit } from '../../save/pending-edits';
import { entityVisibleAttributeName, setEntityStateAttributes, dragSelectedAttributeName } from '../../entity-material';
import { type OtherItem } from '../pbde/pbde-types';
import { textDisplayInstanceAttributeNames, createTextDisplayTemplates, getTextDisplayTemplateKey, type TextDisplayOptions } from './text-display';
import { appendDisplayObjects, loadAndRenderPbde, performSelection } from './project-renderer';
import { compressSync, strToU8 } from 'fflate';
import { getLinkedMirrorUuid, isMirrorModelingEnabled } from '../../controls/transform/mirroring';
import { applySceneVisibility } from '../../controls/scene-visibility';
import { getInstancePivot, isObjectBatch, objectSlots, setInstancePivot } from '../../scene-store/object-access';
import { cloneBatchGeometry } from '../../scene-store/row-store';
import { ObjectBatch } from '../../scene-store/object-batch';
import { removeInstances } from '../../scene-store/object-batches';
export { previewObjectModels as previewDisplayObjects } from './object-model-preview';

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

/** A replacement in history: the same objects with their old models (undo) or their new ones (redo). */
export type ReplacementDelta = { objectIds: string[]; undo(): void; redo(): void; dispose(): void };

export type DisplayReplacementResult = string[] & { history?: ReplacementDelta };
export function updateDisplayObjectMatrix(objectUuid: string, name: string, preview = false): Promise<void> {
    return trackProjectEdit(updateObjectMatrix(objectUuid, name, preview));
}

async function updateObjectMatrix(objectUuid: string, name: string, preview: boolean): Promise<void> {
    const userData = loadedObjectGroup.userData;
    const ref = (userData.objectUuidToInstance as Map<string, { mesh: ObjectBatch; instanceId: number }> | undefined)?.get(objectUuid);
    if (!ref) throw new Error('변경할 디스플레이 오브젝트를 찾을 수 없습니다.');

    const names = userData.objectNames as Map<string, string>;
    const displayTypes = userData.objectDisplayTypes as Map<string, string>;
    const oldName = names.get(objectUuid) ?? name;
    const oldDisplayType = displayTypes.get(objectUuid);
    const newDisplayType = /\bdisplay=([^,\]]+)/.exec(name)?.[1];
    const matrix = new Matrix4();
    ref.mesh.getMatrixAt(ref.instanceId, matrix);
    const pivotParent = getInstancePivot(ref.mesh, ref.instanceId)?.clone().applyMatrix4(matrix);

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

    if (pivotParent) setInstancePivot(ref.mesh, ref.instanceId, pivotParent.applyMatrix4(matrix.clone().invert()));

    ref.mesh.setMatrixAt(ref.instanceId, matrix);
    ref.mesh.instanceMatrix.needsUpdate = true;
    if (preview) {
        ref.mesh.boundingBox = null;
        ref.mesh.boundingSphere = null;
    } else {
        ref.mesh.computeBoundingBox();
        ref.mesh.computeBoundingSphere();
    }
    names.set(objectUuid, name);
    if (newDisplayType) displayTypes.set(objectUuid, newDisplayType);
    else displayTypes.delete(objectUuid);
    if (!isApplying() && !preview) window.dispatchEvent(new CustomEvent('pde:scene-updated'));
}

function disposeUnusedTextDisplayResources(geometry: BufferGeometry, material: Material): void {
    let geometryUsed = false;
    let materialUsed = false;
    let textureUsed = false;
    const texture = (material as Material & { map?: Texture | null }).map;
    loadedObjectGroup.traverse(object => {
        if (!(object as Mesh).isMesh && !isObjectBatch(object)) return;
        const mesh = object as Mesh;
        geometryUsed ||= mesh.geometry === geometry;
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        materialUsed ||= materials.includes(material);
        textureUsed ||= !!texture && materials.some(candidate => (
            candidate as Material & { map?: Texture | null }
        ).map === texture);
    });
    if (!geometryUsed) geometry.dispose();
    const atlasMaterial = !!material.userData.textDisplayAtlas;
    if (!materialUsed && !atlasMaterial) material.dispose();
    if (texture && !textureUsed && !atlasMaterial) texture.dispose();
}

export function isolateTextDisplay(objectUuid: string): void {
    const userData = loadedObjectGroup.userData;
    const refs = userData.objectUuidToInstance as Map<string, { mesh: ObjectBatch; instanceId: number }> | undefined;
    const ref = refs?.get(objectUuid);
    if (!ref || ref.mesh.count <= 1 || Overlay.getDisplayType(ref.mesh, ref.instanceId) !== 'text_display') return;

    const oldMesh = ref.mesh;
    const oldInstanceId = ref.instanceId;
    const oldLastInstanceId = oldMesh.count - 1;
    const geometry = cloneBatchGeometry(oldMesh.geometry);
    for (const attributeName of textDisplayInstanceAttributeNames) {
        const source = oldMesh.geometry.getAttribute(attributeName);
        const values = new Float32Array(source.itemSize);
        for (let component = 0; component < source.itemSize; component++) {
            values[component] = source.getComponent(oldInstanceId, component);
        }
        geometry.setAttribute(attributeName, new InstancedBufferAttribute(values, source.itemSize));
    }
    geometry.boundingBox = Overlay.getInstanceLocalBox(oldMesh, oldInstanceId)?.clone() ?? geometry.boundingBox;
    if (geometry.boundingBox) geometry.boundingSphere = geometry.boundingBox.getBoundingSphere(new Sphere());
    setEntityStateAttributes(geometry, 1, [oldMesh.geometry.getAttribute(entityVisibleAttributeName)?.getX(oldInstanceId) ?? 1]);
    const mesh = new ObjectBatch(geometry, oldMesh.material, 1);
    mesh.instanceMatrix = new StorageInstancedBufferAttribute(1, 16);
    const matrix = new Matrix4();
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

    refs!.set(objectUuid, { mesh, instanceId: 0 });

    removeInstances(loadedObjectGroup, oldMesh, [oldInstanceId]);
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

export function updateTextDisplay(objectUuid: string, name: string, options: TextDisplayOptions): Promise<void> {
    return trackProjectEdit(updateTextObject(objectUuid, name, options));
}

async function updateTextObject(objectUuid: string, name: string, options: TextDisplayOptions): Promise<void> {
    const userData = loadedObjectGroup.userData;
    const refs = userData.objectUuidToInstance as Map<string, { mesh: ObjectBatch; instanceId: number }> | undefined;
    let ref = refs?.get(objectUuid);
    if (!ref || Overlay.getDisplayType(ref.mesh, ref.instanceId) !== 'text_display') {
        throw new Error('변경할 텍스트 디스플레이를 찾을 수 없습니다.');
    }

    const templateKey = getTextDisplayTemplateKey({ name, options });
    const replacement = (await createTextDisplayTemplates([{ name, options, atlasKey: objectUuid }])).get(templateKey)!;
    const replacementMaterial = replacement.material as MeshBasicNodeMaterial;
    if (userData.objectUuidToInstance !== refs) {
        disposeUnusedTextDisplayResources(replacement.geometry, replacementMaterial);
        return;
    }
    const sameGeometry = ref.mesh.geometry.userData.textDisplayGeometryKey === replacement.geometry.userData.textDisplayGeometryKey;
    if (ref.mesh.material === replacementMaterial && sameGeometry) {
        for (const attributeName of textDisplayInstanceAttributeNames) {
            const target = ref.mesh.geometry.getAttribute(attributeName);
            const source = replacement.geometry.getAttribute(attributeName);
            for (let component = 0; component < target.itemSize; component++) {
                target.setComponent(ref.instanceId, component, source.getComponent(0, component));
            }
            target.needsUpdate = true;
        }
        ref.mesh.geometry.boundingBox?.union(replacement.geometry.boundingBox!);
        if (ref.mesh.geometry.boundingBox) ref.mesh.geometry.boundingSphere = ref.mesh.geometry.boundingBox.getBoundingSphere(new Sphere());
        ref.mesh.computeBoundingSphere();
        replacement.geometry.dispose();
        (userData.objectNames as Map<string, string>).set(objectUuid, name);
        const optionMap = (userData.objectTextDisplayOptions as Map<string, TextDisplayOptions> | undefined)
            ?? (userData.objectTextDisplayOptions = new Map<string, TextDisplayOptions>());
        optionMap.set(objectUuid, { ...options });
        ref.mesh.userData.textDisplayBatch = true;
        Overlay.updateSelectionOverlayObject(ref.mesh, ref.instanceId);
        return;
    }

    isolateTextDisplay(objectUuid);
    ref = refs?.get(objectUuid);
    if (!ref) throw new Error('변경할 텍스트 디스플레이를 찾을 수 없습니다.');
    const oldGeometry = ref.mesh.geometry;
    const oldMaterial = ref.mesh.material as Material;
    const oldBounds = oldGeometry.boundingBox?.clone();
    const currentMaterial = oldMaterial as MeshBasicNodeMaterial;
    const boundsUnchanged = !!oldBounds?.equals(replacement.geometry.boundingBox!);
    if (
        boundsUnchanged
        && sameGeometry
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

export function replaceDisplayObjects(requests: Array<{
    objectUuid: string;
    name: string;
    transformContext?: { pivotMode: string; pivotWorld?: Vector3 };
    isItemDisplay?: boolean;
    isTextDisplay?: boolean;
    options?: TextDisplayOptions;
    paintTexture?: string;
}>, syncMirror = true): Promise<DisplayReplacementResult> {
    return trackProjectEdit(replaceObjects(requests, syncMirror));
}

async function replaceObjects(requests: Parameters<typeof replaceDisplayObjects>[0], syncMirror: boolean): Promise<DisplayReplacementResult> {
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
    const refs = ud.objectUuidToInstance as Map<string, { mesh: ObjectBatch; instanceId: number }>;
    const preserveVisibleSize = localStorage.getItem('pdeObjectReplaceMode') === 'preserve-visible-size';
    const getOverlaySize = (mesh: ObjectBatch, instanceId: number, instanceMatrix: Matrix4): Vector3 | null => {
        const box = Overlay.getInstanceLocalBox(mesh, instanceId);
        if (!box) return null;
        const matrix = instanceMatrix.clone().scale(box.getSize(new Vector3())).premultiply(mesh.matrixWorld);
        return new Vector3(
            new Vector3().setFromMatrixColumn(matrix, 0).length(),
            new Vector3().setFromMatrixColumn(matrix, 1).length(),
            new Vector3().setFromMatrixColumn(matrix, 2).length()
        );
    };
    const replacements = requests.map(({ objectUuid, name, transformContext, isItemDisplay: requestedItemDisplay, isTextDisplay = false, options, paintTexture }) => {
        const oldRef = refs?.get(objectUuid);
        if (!isObjectBatch(oldRef?.mesh)) throw new Error('교체할 오브젝트를 찾을 수 없습니다.');

        const oldMatrix = new Matrix4();
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
        const wasItemDisplay = (ud.objectIsItemDisplay as Set<string> | undefined)?.has(objectUuid) ?? false;
        const isItemDisplay = !isTextDisplay && (requestedItemDisplay ?? wasItemDisplay);
        const displayTypeChanged = oldGeometryDisplayType !== (isTextDisplay ? 'text_display' : isItemDisplay ? 'item_display' : 'block_display');
        // Property changes replace the model without moving or resizing the object.
        const preservesObjectTransform = !displayTypeChanged
            && oldName.split('[', 1)[0] === name.split('[', 1)[0];
        const customPivot = getInstancePivot(oldRef.mesh, oldRef.instanceId)?.clone();
        const pivot = transformContext?.pivotMode === 'center' || displayTypeChanged
            ? Overlay.getInstanceLocalBox(oldRef.mesh, oldRef.instanceId)?.getCenter(new Vector3())
            : customPivot ?? (oldGeometryDisplayType === 'block_display' && !wasPlayerHead && !isPlayerHead
                ? Overlay.getInstanceLocalBoxMin(oldRef.mesh, oldRef.instanceId)
                : Overlay.getInstanceLocalBox(oldRef.mesh, oldRef.instanceId)?.getCenter(new Vector3()));
        const pivotParent = transformContext?.pivotWorld ? undefined : pivot?.clone().applyMatrix4(displayedMatrix);
        const pivotWorld = transformContext?.pivotWorld?.clone()
            ?? pivotParent?.clone().applyMatrix4(oldRef.mesh.matrixWorld);
        // The new model is built under a temporary id, then trades places with the object.
        const tempUuid = MathUtils.generateUUID();
        const label = (ud.objectLabels as Map<string, string> | undefined)?.get(objectUuid);
        const texture = paintTexture ?? getPlayerHeadTexture(objectUuid);
        return {
            objectUuid, tempUuid, label, oldMesh: oldRef.mesh, oldInstanceId: oldRef.instanceId,
            customPivot,
            customPivotParent: customPivot?.clone().applyMatrix4(displayedMatrix),
            pivotParent,
            pivotWorld,
            displayedMatrix,
            oldOverlaySize,
            oldPlayerHeadScale,
            displayTypeChanged,
            preservesObjectTransform,
            transformContext,
            node: {
                uuid: tempUuid,
                name,
                nbt: (ud.objectNbt as Map<string, string> | undefined)?.get(objectUuid) ?? '',
                transforms: oldMatrix.clone().transpose().toArray(),
                brightness: (ud.objectBrightness as Map<string, Brightness> | undefined)?.get(objectUuid),
                paintTexture: texture,
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
    const tempUuids = replacements.map(state => state.tempUuid);
    // Appending lists the temporary objects in the scene order; the objects keep their own entries.
    const sceneOrder = ud.sceneOrder;
    // Animation skips the temporary objects while the append awaits; everything after it runs synchronously.
    const staged = (ud.animationPreviewObjectIds ??= new Set<string>()) as Set<string>;
    tempUuids.forEach(uuid => staged.add(uuid));
    try {
        if (directTextItems) {
            await addTextDisplayItems(directTextItems, (mesh, instanceId, uuid) => {
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
            const added = await appendDisplayObjects(replacements.map(({ node }) => node));
            if (tempUuids.some(uuid => !refs.has(uuid))) {
                deleteSelectedItems(loadedObjectGroup, {
                    groups: new Set(),
                    objects: new Map([...added].filter(([object]) => isObjectBatch(object))) as Map<ObjectBatch, Set<number>>
                }, { resetSelectionAndDeselect: () => {} })?.dispose();
                if (import.meta.env.DEV) console.assert(
                    replacements.every(state => refs.has(state.objectUuid) && !refs.has(state.tempUuid)),
                    'Failed display replacement must preserve the original objects.'
                );
                throw new Error('선택한 속성 조합은 표시할 모델이 없어 적용할 수 없습니다.');
            }
        }
    } finally {
        // A project opened during the append owns the scene order now.
        if (ud.objectUuidToInstance === refs) ud.sceneOrder = sceneOrder;
        tempUuids.forEach(uuid => staged.delete(uuid));
    }
    const deletionStates = new Map<ObjectBatch, typeof replacements>();
    const boundsDirtyMeshes = new Set<ObjectBatch>();
    for (const state of replacements) {
        const states = deletionStates.get(state.oldMesh) ?? [];
        states.push(state);
        deletionStates.set(state.oldMesh, states);
    }
    const selectionReplacements: Array<{
        oldMesh: ObjectBatch;
        oldInstanceId: number;
        oldLastInstanceId: number;
        mesh: ObjectBatch;
        instanceId: number;
    }> = [];
    const deletionOrder = Array.from(deletionStates, ([mesh, states]) => {
        let oldLastInstanceId = mesh.count - 1;
        return states.sort((a, b) => b.oldInstanceId - a.oldInstanceId)
            .map(state => ({ state, oldLastInstanceId: oldLastInstanceId-- }));
    }).flat();

    // Fitting writes the new slots while the temporary objects own them (pivots are kept by uuid).
    for (const state of replacements) {
        if (state.label !== undefined) (ud.objectLabels as Map<string, string>).set(state.tempUuid, state.label);

        const replacement = refs.get(state.tempUuid);
        if (!replacement) throw new Error('변경한 오브젝트 모델을 만들 수 없습니다.');
        const playerHeadLayerScale = state.oldPlayerHeadScale / (
            state.node.name.startsWith('player_head') && Overlay.isItemDisplayHatEnabled(replacement.mesh, replacement.instanceId)
                ? PLAYER_HEAD_LAYER_SCALE : 1
        );
        const scaleReplacementMatrix = (replacementMatrix: Matrix4): void => {
            replacementMatrix.scale(new Vector3().setScalar(playerHeadLayerScale));
            if (!state.oldOverlaySize) return;
            const newOverlaySize = getOverlaySize(replacement.mesh, replacement.instanceId, replacementMatrix);
            if (!newOverlaySize) return;
            const ratio = new Vector3(
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
            const offset = new Vector3();
            if (state.pivotWorld) {
                const replacementPivot = Overlay.getInstanceLocalBox(replacement.mesh, replacement.instanceId)?.getCenter(new Vector3());
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
        } else if (!state.preservesObjectTransform && state.pivotWorld && (!state.customPivot || state.transformContext?.pivotMode === 'center')) {
            const replacementMatrix = new Matrix4();
            replacement.mesh.getMatrixAt(replacement.instanceId, replacementMatrix);
            scaleReplacementMatrix(replacementMatrix);
            const replacementDisplayType = Overlay.getDisplayType(replacement.mesh, replacement.instanceId);
            const replacementPivot = state.transformContext?.pivotMode === 'center'
                ? Overlay.getInstanceLocalBox(replacement.mesh, replacement.instanceId)?.getCenter(new Vector3())
                : replacementDisplayType === 'block_display'
                ? Overlay.getInstanceLocalBoxMin(replacement.mesh, replacement.instanceId)
                : Overlay.getInstanceLocalBox(replacement.mesh, replacement.instanceId)?.getCenter(new Vector3());
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
        } else if (!state.preservesObjectTransform && (playerHeadLayerScale !== 1 || state.oldOverlaySize)) {
            const replacementMatrix = new Matrix4();
            replacement.mesh.getMatrixAt(replacement.instanceId, replacementMatrix);
            scaleReplacementMatrix(replacementMatrix);
            replacement.mesh.setMatrixAt(replacement.instanceId, replacementMatrix);
            replacement.mesh.instanceMatrix.needsUpdate = true;
        }
        if (state.customPivotParent) {
            const replacementMatrix = new Matrix4();
            replacement.mesh.getMatrixAt(replacement.instanceId, replacementMatrix);
            setInstancePivot(replacement.mesh, replacement.instanceId, state.customPivotParent.applyMatrix4(replacementMatrix.invert()));
        }

    }
    for (const mesh of boundsDirtyMeshes) {
        mesh.computeBoundingBox();
        mesh.computeBoundingSphere();
    }
    // The objects move to the new slots; the temporary ids take the old slots and leave with them.
    const pairs = replacements.map(state => [state.objectUuid, state.tempUuid] as [string, string]);
    tradeObjects(pairs);
    applySceneVisibility(loadedObjectGroup, pairs.map(([uuid]) => uuid));
    const removed = deleteTemporaryObjects(tempUuids);
    for (const { state, oldLastInstanceId } of deletionOrder) {
        const replacement = refs.get(state.objectUuid)!;
        selectionReplacements.push({
            oldMesh: state.oldMesh, oldInstanceId: state.oldInstanceId, oldLastInstanceId,
            mesh: replacement.mesh, instanceId: replacement.instanceId
        });
    }
    if (import.meta.env.DEV) console.assert(
        replacements.every(state => refs.has(state.objectUuid) && !refs.has(state.tempUuid)),
        'Display replacement must keep the object ids and drop the temporary ones.'
    );
    window.dispatchEvent(new CustomEvent('pde:replace-object-selection', { detail: selectionReplacements }));
    if (!isApplying()) window.dispatchEvent(new CustomEvent('pde:scene-updated'));
    const result = replacements.slice(0, requestedCount).map(({ objectUuid }) => objectUuid) as DisplayReplacementResult;
    result.history = replacementDelta(pairs, removed);
    return result;
}

// Per-object values that come with the model. Place, visibility, mirror pairs, animation and the custom-pivot flag stay.
const modelValueMaps = ['objectNames', 'objectLabels', 'objectDisplayTypes', 'objectBlockProps', 'objectTextDisplayOptions',
    'objectTextures', 'objectNbt', 'objectBrightness', 'objectPivots', 'objectDisplayKinds'] as const;

/** Trades slots and model values between each object and its temporary one; trading twice restores both. */
function tradeObjects(pairs: Array<[string, string]>): void {
    const ud = loadedObjectGroup.userData;
    const refs = ud.objectUuidToInstance as Map<string, { mesh: ObjectBatch; instanceId: number }>;
    const items = ud.objectIsItemDisplay as Set<string> | undefined;
    for (const [uuid, temp] of pairs) {
        const ref = refs.get(uuid)!, tempRef = refs.get(temp)!;
        refs.set(uuid, tempRef);
        refs.set(temp, ref);
        for (const name of modelValueMaps) {
            const map = ud[name] as Map<string, unknown> | undefined;
            if (!map) continue;
            const has = map.has(uuid), value = map.get(uuid);
            if (map.has(temp)) map.set(uuid, map.get(temp)); else map.delete(uuid);
            if (has) map.set(temp, value); else map.delete(temp);
        }
        if (items && items.has(uuid) !== items.has(temp)) {
            const [from, to] = items.has(uuid) ? [uuid, temp] : [temp, uuid];
            items.delete(from);
            items.add(to);
        }
    }
}

function deleteTemporaryObjects(temps: string[]): DeletedSceneDelta {
    const removed = deleteSelectedItems(loadedObjectGroup, { groups: new Set(), objects: objectSlots(loadedObjectGroup, temps) },
        { resetSelectionAndDeselect: () => {}, preserveAnimation: true });
    if (!removed) throw new Error('교체할 오브젝트를 삭제할 수 없습니다.');
    return removed;
}

/** Undo brings the temporary objects back on the old slots, trades back and drops them from the new ones; redo reverses it. */
function replacementDelta(pairs: Array<[string, string]>, removed: DeletedSceneDelta): ReplacementDelta {
    let replaced = true;
    let restored: DeletedSceneDelta | null = null;
    return {
        objectIds: pairs.map(([uuid]) => uuid),
        undo: () => {
            if (!replaced) return;
            removed.undo();
            tradeObjects(pairs);
            if (restored) restored.redo();
            else restored = deleteTemporaryObjects(pairs.map(([, temp]) => temp));
            replaced = false;
        },
        redo: () => {
            if (replaced) return;
            restored!.undo();
            tradeObjects(pairs);
            removed.redo();
            replaced = true;
        },
        dispose: () => {
            removed.dispose();
            restored?.dispose();
        }
    };
}

export async function addDisplayObject(name: string, isItemDisplay: boolean): Promise<string> {
    const uuid = MathUtils.generateUUID();
    const transforms = name === 'player_head'
        ? new Matrix4().compose(
            new Vector3(0, 0.5, 0),
            new Quaternion().setFromEuler(new Euler(Math.PI, 0, -Math.PI)),
            new Vector3(1, 1, 1)
        ).transpose().toArray()
        : new Matrix4().toArray();
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
    const uuid = MathUtils.generateUUID();
    const json = strToU8(JSON.stringify([{ children: [{
        uuid,
        name: '텍스트 입력',
        nbt: '',
        transforms: new Matrix4().toArray(),
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
    transformContext?: { pivotMode: string; pivotWorld?: Vector3 }
): Promise<DisplayReplacementResult> {
    return replaceDisplayObjects([{ objectUuid, name, transformContext }]);
}

export function updateObjectBrightness(objectUuid: string, brightness: { sky: number; block: number }): void {
    const ud = loadedObjectGroup.userData;
    const ref = (ud.objectUuidToInstance as Map<string, { mesh: ObjectBatch; instanceId: number }> | undefined)?.get(objectUuid);
    if (!isObjectBatch(ref?.mesh)) return;
    (ud.objectBrightness as Map<string, { sky: number; block: number }>).set(objectUuid, brightness);
    setInstanceSkyBrightness(ref.mesh, ref.instanceId, brightness);
    if (ref.mesh.instanceColor) ref.mesh.instanceColor.needsUpdate = true;
    if (!isApplying()) window.dispatchEvent(new CustomEvent('pde:scene-updated'));
}

export function updateGlobalBrightness(brightness: GlobalBrightness): void {
    const ud = loadedObjectGroup.userData;
    ud.globalBrightness = brightness;
    const objectBrightness = ud.objectBrightness as Map<string, Brightness> | undefined;
    for (const [uuid, ref] of (ud.objectUuidToInstance as Map<string, { mesh: ObjectBatch; instanceId: number }> | undefined) ?? []) {
        if (!isObjectBatch(ref.mesh)) continue;
        setInstanceSkyBrightness(ref.mesh, ref.instanceId, objectBrightness?.get(uuid));
        if (ref.mesh.instanceColor) ref.mesh.instanceColor.needsUpdate = true;
    }
    if (!isApplying()) window.dispatchEvent(new CustomEvent('pde:scene-updated'));
}
