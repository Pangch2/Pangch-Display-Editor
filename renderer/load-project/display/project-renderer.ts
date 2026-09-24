import * as THREE from 'three/webgpu';
import { loadedObjectGroup, type LoadedSelection, currentLoadGen, beginPbdeLoadGeneration } from './display-instancing';
import { headGeometries, PLAYER_HEAD_ATLAS_SIZE, PLAYER_HEAD_BLOCK_WIDTH, PLAYER_HEAD_BLOCK_HEIGHT, PLAYER_HEAD_BLOCKS_PER_ROW, type PlayerHeadSkin, type PlayerHeadAtlas, getPlayerHeadRenderMatrix, clearImageHeadBlackMaterial, mergeIndexedGeometries, createHeadGeometries, createPlayerHeadAtlasGeometry, loadPlayerHeadImage, drawPlayerHeadSlot, getProjectPlayerHeadAtlases, notifyPlayerHeadAtlasesChanged, getOrCreatePlayerHeadAtlas, createPlayerHeadAtlas, takePlayerHeadSlot } from './player-head-atlas';
import { type GroupData, type GeometryInstanceBatch, type GeometryInstanceMeta, type GeometryMeta, type OtherItem, type WorkerMetadata } from '../pbde/pbde-types';
import { INITIAL_INSTANCES_PER_INSTANCED_MESH, type Brightness, type SignatureGroup, type MaterialUpdate, setInstanceSkyBrightness, addLoadedInstance, addTextDisplayItems, getInstancedCapacity, buildPartHashKeys, getGeometryBufferKey, getInstancePartUvTransform, getInstanceDisplayType, getAppendableInstanceCapacity } from './display-instancing';
import { getMaterialKey, addProjectBlockAtlas, remapBlockAtlasMetadata, clearBlockRenderResources, clearBlockMaterialPromises, sharedPlaceholderMaterial, ensureSharedPlaceholder, getBlockMaterial } from './block-render-resources';
import { dragSelectedAttributeName, entityVisibleAttributeName, setEntityStateAttributes } from '../../entity-material';
import { parsePbdeProject } from '../scene/scene-parser';
import { mainThreadAssetProvider } from '../pbde/pbde-assets';
import { isPbdeLogEnabled, pbdeLogNames } from '../pbde/pbde-log';
import { resetTextDisplayAtlases, type TextDisplayOptions } from './text-display';
import { isSceneHistoryResourceRetained } from '../../controls/undo-redo/scene-history';
import { planUvTransforms, relativeUvTransform as getRelativeUvTransform } from '../batching/geometry-batching';
import { setInstanceModelTransform } from '../batching/instance-model-transform';
import { applyAtlasAppend, atlasBatchSignature, getTintParts, planAtlasAppend, rebaseAtlasInstances, setAtlasBatchState } from '../batching/atlas-instance-batch';

function _clearSceneAndCaches(): void {
    // 1-1. 캐시된 텍스처 및 리소스 완벽 해제
    // 1-1-b. 블럭 텍스처/머티리얼 캐시 해제 및 초기화
    clearBlockRenderResources();

    // 1-2. 씬에 있는 객체의 지오메트리 및 재질 해제
    const disposedGeometries = new Set<THREE.BufferGeometry>();
    const disposedMaterials = new Set<THREE.Material>();
    const disposedTextures = new Set<THREE.Texture>();
    loadedObjectGroup.traverse(object => {
        if (object.isMesh) {
            // 최적화: 재사용되는 지오메트리는 dispose하지 않도록 예외 처리
            if (object.geometry && !disposedGeometries.has(object.geometry) && object.geometry !== headGeometries?.base && object.geometry !== headGeometries?.layer && object.geometry !== headGeometries?.merged) {
                object.geometry.dispose();
                disposedGeometries.add(object.geometry);
            }
            if (object.material) {
                const materials = Array.isArray(object.material) ? object.material : [object.material];
                materials.forEach(material => {
                    if (material.map && !disposedTextures.has(material.map)) {
                        material.map.dispose();
                        disposedTextures.add(material.map);
                    }
                    if (!disposedMaterials.has(material)) {
                        material.dispose();
                        disposedMaterials.add(material);
                    }
                });
            }
        }
    });

    // 1-3. 그룹에서 모든 자식 객체 제거
    clearImageHeadBlackMaterial();
    while (loadedObjectGroup.children.length > 0) {
        loadedObjectGroup.remove(loadedObjectGroup.children[0]);
    }

    // 1-4. Three.js 전역 캐시 비우기
    THREE.Cache.clear();
}

/**
 * Newly added helper to perform selection on a set of meshes.
 * Extracted from _loadAndRenderPbde to allow batch selection control.
 */
export function performSelection(newlyAddedSelectableMeshes: LoadedSelection, anchorMode = 'center') {
    if (loadedObjectGroup.userData.headPainterActive) return;
    const selectGroupsObjectsFn = (loadedObjectGroup.userData as Record<string, unknown>)?.replaceSelectionWithGroupsAndObjects as
        | undefined
        | ((groupIds: Set<string>, meshToIds: Map<THREE.Object3D, Set<number>>, opts?: unknown) => void);
    const selectObjectsFn = (loadedObjectGroup.userData as Record<string, unknown>)?.replaceSelectionWithObjectsMap as
        | undefined
        | ((meshToIds: Map<THREE.Object3D, Set<number>>, opts?: unknown) => void);

    if (newlyAddedSelectableMeshes.size > 0) {
        const groupsMap = (loadedObjectGroup.userData.groups as Map<string, GroupData>) ?? new Map<string, GroupData>();
        const objectToGroupMap = (loadedObjectGroup.userData.objectToGroup as Map<string, string>) ?? new Map<string, string>();

        const resolveRootGroupId = (groupId: string | null | undefined): string | null => {
            if (!groupId) return null;
            let current = groupId;
            for (let i = 0; i < 128; i++) {
                const g = groupsMap.get(current);
                if (!g) break;
                const parent = g.parent;
                if (!parent) break;
                current = parent;
            }
            return current || null;
        };

        const groupIds = new Set<string>();
        const meshToIds = new Map<any, Set<number>>();

        for (const [mesh, instanceIds] of newlyAddedSelectableMeshes) {
            if (!mesh) continue;
            const instancedMesh = mesh as THREE.InstancedMesh;

            if (!instancedMesh.isInstancedMesh) continue;

            if (instanceIds.size === 0) continue;

            let ids: Set<number> | null = null;
            for (const instanceId of instanceIds) {
                const key = `${mesh.uuid}_${instanceId}`;
                const immediateGroupId = objectToGroupMap.get(key);
                if (immediateGroupId) {
                    const root = resolveRootGroupId(immediateGroupId) ?? immediateGroupId;
                    if (root) groupIds.add(root);
                    continue;
                }

                if (!ids) ids = new Set<number>();
                ids.add(instanceId);
            }

            if (ids && ids.size > 0) {
                meshToIds.set(mesh, ids);
            }
        }

        // Group-priority selection: if an instance belongs to a group, select the (root) group instead.
        if (typeof selectGroupsObjectsFn === 'function') {
            selectGroupsObjectsFn(groupIds, meshToIds, { anchorMode, primaryIsRangeStart: true });
        } else if (typeof selectObjectsFn === 'function') {
            // Fallback: select raw objects if gizmo API is not available.
            selectObjectsFn(meshToIds, { anchorMode });
        }
    }
}

/**
 * PBDE 파일을 로드하고 3D 씬에 객체를 배치합니다.
 * @param {File} file - 불러올 .pbde 또는 .bde 파일
 */
export async function loadAndRenderPbde(file: File, isMerge: boolean, overrideGen?: number): Promise<LoadedSelection> {
        const meshUploadStartMs = performance.now();
        const setupStartMs = meshUploadStartMs;

        // 0. 새 프로젝트를 로드하기 전에 현재 선택 상태를 리셋합니다.
        // Single file open case or first file of batch open.
        if (!isMerge && loadedObjectGroup.userData.resetSelection) {
            loadedObjectGroup.userData.resetSelection();
        }

        const myGen = overrideGen !== undefined ? overrideGen : beginPbdeLoadGeneration();

        if (!isMerge) {
            _clearSceneAndCaches();
            resetTextDisplayAtlases();
            loadedObjectGroup.userData.blockAtlasTextures = [];
        } else {
            clearBlockMaterialPromises();
        }
        
        createHeadGeometries();
        const setupElapsedMs = performance.now() - setupStartMs;

        const fileReadStartMs = performance.now();
        const fileBuffer = await file.arrayBuffer();
        const fileReadElapsedMs = performance.now() - fileReadStartMs;
        if (myGen !== currentLoadGen) {
            return new Map<THREE.Object3D, Set<number>>();
        }

        const parseStartMs = performance.now();
        const { metadata, geometryBuffer } = await parsePbdeProject(fileBuffer, mainThreadAssetProvider);
        const parseElapsedMs = performance.now() - parseStartMs;
        if (myGen !== currentLoadGen) {
            return new Map<THREE.Object3D, Set<number>>();
        }

                if (!(geometryBuffer instanceof ArrayBuffer)) {
                    console.error('[Debug] geometryBuffer is not an ArrayBuffer. Aborting render pipeline.');
                    return new Map<THREE.Object3D, Set<number>>();
                }
                const sharedBuffer = geometryBuffer as ArrayBuffer;
                if (!metadata || typeof metadata !== 'object') {
                    console.error('[Debug] Invalid metadata payload from parser.');
                    return new Map<THREE.Object3D, Set<number>>();
                }
                const metadataPayload = metadata as WorkerMetadata;
                if (!Array.isArray(metadataPayload.geometries) || !Array.isArray(metadataPayload.otherItems)) {
                    console.error('[Debug] Invalid metadata payload from parser.');
                    return new Map<THREE.Object3D, Set<number>>();
                }
                const { geometries: geometryMetas, geometryBatches, otherItems, useUint32Indices, atlas, groups, sceneOrder, projectDetails } = metadataPayload;
                if (!isMerge) loadedObjectGroup.userData.projectDetails = projectDetails;
                const activeGeometryBatches = Array.isArray(geometryBatches) && geometryBatches.length > 0 ? geometryBatches : null;

                const newlyAddedSelectableMeshes: LoadedSelection = new Map();

                // Grouping Setup
                const incomingGroups = groups;
                const groupIdRemap = new Map<string, string>();

                // Keep existing group maps on merge; replace on fresh load.
                if (!loadedObjectGroup.userData.groups) loadedObjectGroup.userData.groups = new Map<string, GroupData>();
                if (!loadedObjectGroup.userData.objectToGroup) loadedObjectGroup.userData.objectToGroup = new Map<string, string>();

                const effectiveGroups: Map<string, GroupData> = isMerge
                    ? (loadedObjectGroup.userData.groups as Map<string, GroupData>)
                    : (incomingGroups ?? new Map<string, GroupData>());

                const objectToGroup: Map<string, string> = isMerge
                    ? (loadedObjectGroup.userData.objectToGroup as Map<string, string>)
                    : new Map<string, string>();

                loadedObjectGroup.userData.groups = effectiveGroups;
                loadedObjectGroup.userData.objectToGroup = objectToGroup;

                if (incomingGroups) {
                    // Precompute ID remaps (very unlikely, but safe on merge)
                    if (isMerge) {
                        for (const [id] of incomingGroups) {
                            if (effectiveGroups.has(id)) {
                                groupIdRemap.set(id, THREE.MathUtils.generateUUID());
                            }
                        }
                    }

                    // Merge incoming groups into effectiveGroups
                    for (const [origId, group] of incomingGroups) {
                        const newId = groupIdRemap.get(origId) ?? origId;
                        if (newId !== origId) group.id = newId;

                        if (group.parent && groupIdRemap.has(group.parent)) {
                            group.parent = groupIdRemap.get(group.parent);
                        }
                        if (Array.isArray(group.children)) {
                            for (const child of group.children) {
                                if (child && child.type === 'group' && child.id && groupIdRemap.has(child.id)) {
                                    child.id = groupIdRemap.get(child.id);
                                }
                            }
                        }

                        // Restore THREE objects for group transforms
                        if (group.quaternion) {
                            const q = group.quaternion;
                            if (!(q instanceof THREE.Quaternion)) {
                                const x = q._x !== undefined ? q._x : q.x;
                                const y = q._y !== undefined ? q._y : q.y;
                                const z = q._z !== undefined ? q._z : q.z;
                                const w = q._w !== undefined ? q._w : q.w;
                                group.quaternion = new THREE.Quaternion(x, y, z, w);
                            }
                        }
                        if (group.scale) {
                            const s = group.scale;
                            if (!(s instanceof THREE.Vector3)) {
                                group.scale = new THREE.Vector3(s.x, s.y, s.z);
                            }
                        }
                        if (group.position) {
                            const p = group.position;
                            if (!(p instanceof THREE.Vector3)) {
                                group.position = new THREE.Vector3(p.x, p.y, p.z);
                            }
                        }
                        if (group.pivot && !(group.pivot instanceof THREE.Vector3)) {
                            group.pivot = new THREE.Vector3(group.pivot[0], group.pivot[1], group.pivot[2]);
                        }

                        effectiveGroups.set(newId, group);
                    }
                }

                const groupObjectChildIndices = new WeakMap<GroupData, Map<string, number>>();

                function registerObject(mesh: THREE.Object3D, instanceId: number, uuid: string, groupId: string) {
                    const key = `${mesh.uuid}_${instanceId}`;
                    // Always store reverse lookup: instanceKey → custom uuid
                    (loadedObjectGroup.userData.instanceKeyToObjectUuid as Map<string, string>).set(key, uuid);
                    // Forward reverse lookup: custom uuid → { mesh, instanceId }
                    (loadedObjectGroup.userData.objectUuidToInstance as Map<string, { mesh: THREE.Object3D; instanceId: number }>)
                        .set(uuid, { mesh, instanceId });

                    if (!groupId || !incomingGroups) return;
                    const finalGroupId = groupIdRemap.get(groupId) ?? groupId;
                    objectToGroup.set(key, finalGroupId);

                    const group = effectiveGroups.get(finalGroupId);
                    if (group && Array.isArray(group.children)) {
                        let childIndices = groupObjectChildIndices.get(group);
                        if (!childIndices) {
                            childIndices = new Map<string, number>();
                            for (let index = 0; index < group.children.length; index++) {
                                const child = group.children[index];
                                if (child?.type === 'object' && child.id !== undefined && !childIndices.has(child.id)) {
                                    childIndices.set(child.id, index);
                                }
                            }
                            groupObjectChildIndices.set(group, childIndices);
                        }
                        const childIndex = childIndices.get(uuid);
                        if (childIndex !== undefined) {
                            group.children[childIndex] = { type: 'object', mesh: mesh, instanceId: instanceId, id: uuid };
                        }
                    }
                }

                const atlasStartMs = performance.now();
                if (atlas) {
                    try {
                        const { page, transform } = addProjectBlockAtlas(atlas);
                        remapBlockAtlasMetadata(geometryMetas, activeGeometryBatches, sharedBuffer, atlas.key, page.index, transform);
                    } catch (e) {
                        console.warn("Failed to create atlas texture", e);
                    }
                }
                const atlasElapsedMs = performance.now() - atlasStartMs;

                const geometryItemCount = activeGeometryBatches
                    ? activeGeometryBatches.reduce((sum, batch) => sum + batch.instances.length, 0)
                    : geometryMetas.length;
                if (isPbdeLogEnabled(pbdeLogNames.processingItems)) {
                    console.log(`[Debug] Processing ${geometryItemCount + otherItems.length} items from parser (binary).`);
                }

                // uuid → 표시 이름 맵 구성
                if (!isMerge) {
                    loadedObjectGroup.userData.objectNames = new Map<string, string>();
                    loadedObjectGroup.userData.objectLabels = new Map<string, string>();
                    loadedObjectGroup.userData.objectIsItemDisplay = new Set<string>();
                    loadedObjectGroup.userData.objectDisplayTypes = new Map<string, string>();
                    loadedObjectGroup.userData.objectBlockProps = new Map<string, any>();
                    loadedObjectGroup.userData.objectTextDisplayOptions = new Map<string, TextDisplayOptions>();
                    loadedObjectGroup.userData.objectBrightness = new Map<string, unknown>();
                    loadedObjectGroup.userData.objectTextures = new Map<string, string>();
                    loadedObjectGroup.userData.instanceKeyToObjectUuid = new Map<string, string>();
                    loadedObjectGroup.userData.objectUuidToInstance = new Map<string, { mesh: THREE.Object3D; instanceId: number }>();
                } else {
                    if (!loadedObjectGroup.userData.instanceKeyToObjectUuid)
                        loadedObjectGroup.userData.instanceKeyToObjectUuid = new Map<string, string>();
                    if (!loadedObjectGroup.userData.objectUuidToInstance)
                        loadedObjectGroup.userData.objectUuidToInstance = new Map<string, { mesh: THREE.Object3D; instanceId: number }>();
                }
                const objectNamesMap: Map<string, string> =
                    (loadedObjectGroup.userData.objectNames as Map<string, string>) ?? new Map<string, string>();
                const objectLabels: Map<string, string> =
                    (loadedObjectGroup.userData.objectLabels as Map<string, string>) ?? new Map<string, string>();
                const objectIsItemDisplay: Set<string> =
                    (loadedObjectGroup.userData.objectIsItemDisplay as Set<string>) ?? new Set<string>();
                const objectDisplayTypes: Map<string, string> =
                    (loadedObjectGroup.userData.objectDisplayTypes as Map<string, string>) ?? new Map<string, string>();
                const objectBlockProps: Map<string, any> =
                    (loadedObjectGroup.userData.objectBlockProps as Map<string, any>) ?? new Map<string, any>();
                const objectTextDisplayOptions: Map<string, TextDisplayOptions> =
                    (loadedObjectGroup.userData.objectTextDisplayOptions as Map<string, TextDisplayOptions>) ?? new Map<string, TextDisplayOptions>();
                const objectNbt: Map<string, string> =
                    (loadedObjectGroup.userData.objectNbt as Map<string, string>) ?? new Map<string, string>();
                const objectBrightness: Map<string, unknown> =
                    (loadedObjectGroup.userData.objectBrightness as Map<string, unknown>) ?? new Map<string, unknown>();
                const objectTextures: Map<string, string> =
                    (loadedObjectGroup.userData.objectTextures as Map<string, string>) ?? new Map<string, string>();

                if (activeGeometryBatches) {
                    for (const batch of activeGeometryBatches) {
                        const firstPart = batch.parts[0];
                        for (const instance of batch.instances) {
                            if (instance.uuid && !objectNamesMap.has(instance.uuid) && instance.name) {
                                objectNamesMap.set(instance.uuid, instance.name);
                            }
                            const instanceIsItemDisplay = (instance as any).isItemDisplayModel ?? firstPart?.isItemDisplayModel;
                            const instanceItemDisplayType = (instance as any).itemDisplayType ?? (firstPart as any)?.itemDisplayType;
                            if (instance.uuid && instanceIsItemDisplay) {
                                objectIsItemDisplay.add(instance.uuid);
                                if (instanceItemDisplayType) {
                                    objectDisplayTypes.set(instance.uuid, instanceItemDisplayType);
                                }
                            }
                            const instanceBlockProps = (instance as any).blockProps ?? (firstPart as any)?.blockProps;
                            if (instance.uuid && firstPart && !instanceIsItemDisplay && instanceBlockProps) {
                                objectBlockProps.set(instance.uuid, instanceBlockProps);
                            }
                            if (instance.uuid) objectNbt.set(instance.uuid, instance.nbt ?? '');
                            if (instance.uuid && instance.brightness) objectBrightness.set(instance.uuid, instance.brightness);
                        }
                    }
                } else {
                    for (const meta of geometryMetas) {
                        if (meta.uuid && !objectNamesMap.has(meta.uuid) && meta.name) {
                            objectNamesMap.set(meta.uuid, meta.name);
                        }
                        if (meta.uuid && meta.isItemDisplayModel) {
                            objectIsItemDisplay.add(meta.uuid);
                            if ((meta as any).itemDisplayType) {
                                objectDisplayTypes.set(meta.uuid, (meta as any).itemDisplayType);
                            }
                        }
                        if (meta.uuid && !meta.isItemDisplayModel && (meta as any).blockProps) {
                            objectBlockProps.set(meta.uuid, (meta as any).blockProps);
                        }
                        if (meta.uuid) objectNbt.set(meta.uuid, meta.nbt ?? '');
                        if (meta.uuid && (meta as any).brightness) objectBrightness.set(meta.uuid, (meta as any).brightness);
                    }
                }
                for (const item of otherItems) {
                    if (item.uuid && !objectNamesMap.has(item.uuid) && (item.type === 'textDisplay' || (item as any).name)) {
                        objectNamesMap.set(item.uuid, (item as any).name ?? '');
                    }
                    if (item.uuid && item.type === 'itemDisplay') {
                        objectIsItemDisplay.add(item.uuid);
                        if (item.displayType) {
                            objectDisplayTypes.set(item.uuid, item.displayType);
                        }
                    }
                    if (item.uuid && item.type === 'textDisplay') {
                        if (!objectLabels.has(item.uuid)) objectLabels.set(item.uuid, 'text_display');
                        objectTextDisplayOptions.set(item.uuid, { ...((item.options as TextDisplayOptions | undefined) ?? {}) });
                    }
                    if (item.uuid) objectNbt.set(item.uuid, typeof item.nbt === 'string' ? item.nbt : '');
                    if (item.uuid && item.brightness) objectBrightness.set(item.uuid, item.brightness);
                    if (item.uuid && item.textureUrl) objectTextures.set(item.uuid, item.textureUrl);
                }
                loadedObjectGroup.userData.objectNames = objectNamesMap;
                loadedObjectGroup.userData.objectLabels = objectLabels;
                loadedObjectGroup.userData.objectIsItemDisplay = objectIsItemDisplay;
                loadedObjectGroup.userData.objectDisplayTypes = objectDisplayTypes;
                loadedObjectGroup.userData.objectBlockProps = objectBlockProps;
                loadedObjectGroup.userData.objectTextDisplayOptions = objectTextDisplayOptions;
                loadedObjectGroup.userData.objectNbt = objectNbt;
                loadedObjectGroup.userData.objectBrightness = objectBrightness;
                loadedObjectGroup.userData.objectTextures = objectTextures;

                // 로드 순서 보존 (merge 시는 덧붙임)
                const prevOrder: { type: 'group' | 'object', id: string }[] =
                    isMerge ? (loadedObjectGroup.userData.sceneOrder ?? []) : [];
                loadedObjectGroup.userData.sceneOrder = prevOrder.concat(sceneOrder ?? []);

                const instancedGeometries = new Map<string, THREE.BufferGeometry>();
                const mergedGeometryCache = new Map<string, THREE.BufferGeometry>();
                const instancedMaterials = new Map<string, THREE.Material>();
                const materialPromises = new Map<string, Promise<THREE.Material>>();
                const materialUpdates: MaterialUpdate[] = [];
                let createdInstancedMeshCount = 0;
                
                // Grouping structure: itemId -> all renderable parts for that scene object.
                const blocks = new Map<string, GeometryMeta[]>();

                ensureSharedPlaceholder();
                const placeholderMaterial = sharedPlaceholderMaterial as THREE.Material;

                const ensureInstancedMaterialPromise = (
                    part: GeometryMeta,
                    instancedUvTransformCount: number,
                    instancedUvTransformIndex: number,
                    instancedTintIndex = -1
                ): Promise<THREE.Material> => {
                    const matKey = getMaterialKey(part, instancedUvTransformCount, instancedUvTransformIndex, instancedTintIndex);
                    const cachedMaterial = instancedMaterials.get(matKey);
                    if (cachedMaterial) return Promise.resolve(cachedMaterial);

                    let promise = materialPromises.get(matKey);
                    if (!promise) {
                        promise = getBlockMaterial(part.texPath, part.tintHex, myGen, instancedUvTransformCount, instancedUvTransformIndex, instancedTintIndex).then(material => {
                            if (myGen === currentLoadGen) {
                                instancedMaterials.set(matKey, material);
                            }
                            return material;
                        });
                        materialPromises.set(matKey, promise);
                    }
                    return promise;
                };

                const ensureBufferGeometry = (meta: GeometryMeta): void => {
                    const geomKey = getGeometryBufferKey(meta);
                    let geometry = instancedGeometries.get(geomKey);

                    if (!geometry) {
                        geometry = new THREE.BufferGeometry();
                        const positions = new Float32Array(sharedBuffer, meta.posByteOffset, meta.posLen);
                        const normals = new Float32Array(sharedBuffer, meta.normByteOffset, meta.normLen);
                        const uvs = new Float32Array(sharedBuffer, meta.uvByteOffset, meta.uvLen);
                        const indices = useUint32Indices
                            ? new Uint32Array(sharedBuffer, meta.indicesByteOffset, meta.indicesLen)
                            : new Uint16Array(sharedBuffer, meta.indicesByteOffset, meta.indicesLen);

                        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
                        geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
                        geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
                        geometry.setIndex(new THREE.BufferAttribute(indices, 1));
                        instancedGeometries.set(geomKey, geometry);
                    }
                };

                for (const meta of geometryMetas) {
                    ensureBufferGeometry(meta);

                    const instanceKey = String(meta.itemId);

                    let instanceParts = blocks.get(instanceKey);
                    if (!instanceParts) {
                        instanceParts = [];
                        blocks.set(instanceKey, instanceParts);
                    }
                    instanceParts.push(meta);
                }

                // Process grouped blocks
                // Group instances by Signature (combination of geometries, local transforms, and materials)
                const signatureStartMs = performance.now();
                const signatureGroups = new Map<string, SignatureGroup>();

                const addSignatureGroup = (parts: GeometryMeta[], instances: GeometryInstanceMeta[], shapeKey?: string) => {
                    // Parser part order also indexes each instance's UV transforms.

                    for (const part of parts) {
                        ensureBufferGeometry(part);
                    }

                    const { signature: partSignature, geometryKey } = buildPartHashKeys(parts);
                    const signature = shapeKey ? atlasBatchSignature(shapeKey, parts)
                        : `${instances[0]?.isItemDisplayModel ? 'item' : 'block'}|${partSignature}`;
                    let group = signatureGroups.get(signature);
                    if (!group) {
                        group = { parts, instances: instances.slice(), geometryKey, instancedUvTransformCount: 0, isAtlasBatch: !!shapeKey };
                        signatureGroups.set(signature, group);
                    } else {
                        for (const instance of shapeKey ? rebaseAtlasInstances(parts, group.parts, instances) : instances) group.instances.push(instance);
                    }
                };

                if (activeGeometryBatches) {
                    for (const batch of activeGeometryBatches as GeometryInstanceBatch[]) {
                        addSignatureGroup(batch.parts, batch.instances, batch.shapeKey);
                    }
                } else {
                    for (const [_itemId, parts] of blocks) {
                        addSignatureGroup(parts, [{ transform: parts[0].transform, uuid: parts[0].uuid, groupId: parts[0].groupId }]);
                    }
                }
                const signatureElapsedMs = performance.now() - signatureStartMs;

                const reusableMeshes = new Map<string, THREE.InstancedMesh[]>();
                if (isMerge) {
                    for (const child of loadedObjectGroup.children) {
                        const mesh = child as THREE.InstancedMesh;
                        const signature = mesh.isInstancedMesh ? mesh.userData.pbdeSignature as string | undefined : undefined;
                        if (!signature) continue;
                        const meshes = reusableMeshes.get(signature) ?? [];
                        meshes.push(mesh);
                        reusableMeshes.set(signature, meshes);
                    }
                }

                const materialAwaitStartMs = performance.now();
                const materialPreloadPromises = new Set<Promise<THREE.Material>>();
                for (const [signature, group] of signatureGroups) {
                    group.uvPlan = planUvTransforms(group.parts, group.instances);
                    group.tintParts = getTintParts(group.parts, group.instances);
                    const instancedUvTransformCount = group.uvPlan.sourceParts.length;
                    group.instancedUvTransformCount = instancedUvTransformCount;
                    const reusableCapacity = reusableMeshes.get(signature)?.reduce(
                        (sum, mesh) => sum + Math.max(0, getInstancedCapacity(mesh) - mesh.count), 0
                    ) ?? 0;
                    if ((group.isAtlasBatch || instancedUvTransformCount === 0 && group.tintParts.length === 0) && reusableCapacity >= group.instances.length) continue;
                    for (const [partIndex, part] of group.parts.entries()) {
                        const slot = group.uvPlan.slots[partIndex];
                        materialPreloadPromises.add(ensureInstancedMaterialPromise(part, slot < 0 ? 0 : instancedUvTransformCount, Math.max(0, slot), group.tintParts.includes(partIndex) ? partIndex : -1));
                    }
                }
                const materialPreloadResults = await Promise.allSettled(materialPreloadPromises);
                const failedMaterialPreloads = materialPreloadResults.filter(result => result.status === 'rejected').length;
                if (failedMaterialPreloads > 0) {
                    console.warn(`[PBDE] Material preload failed for ${failedMaterialPreloads} slot${failedMaterialPreloads === 1 ? '' : 's'}; falling back to async material updates.`);
                }
                let materialAwaitElapsedMs = performance.now() - materialAwaitStartMs;

                // Create InstancedMesh for each signature group
                const meshBuildStartMs = performance.now();
                for (const [signature, group] of signatureGroups) {
                        const representativeParts = group.parts;
                        const instances = group.instances;
                        const instancedUvTransformCount = group.instancedUvTransformCount;
                        const usesAtlasUvTransform = instancedUvTransformCount > 0;
                        const hasReusableSignature = group.isAtlasBatch || !usesAtlasUvTransform && group.tintParts!.length === 0;
                        const canReuseExisting = isMerge && hasReusableSignature;
                        const instanceMatrix = new THREE.Matrix4();
                        let transformStart = 0;

                        if (canReuseExisting) {
                            for (const instancedMesh of reusableMeshes.get(signature) ?? []) {
                                const appendCount = Math.min(getInstancedCapacity(instancedMesh) - instancedMesh.count, instances.length - transformStart);
                                if (appendCount <= 0) continue;
                                const appendPlan = group.isAtlasBatch
                                    ? planAtlasAppend(instancedMesh, representativeParts, instances.slice(transformStart, transformStart + appendCount))
                                    : undefined;
                                if (appendPlan) {
                                    const nextMaterials = await Promise.all(appendPlan.parts.map((part, partIndex) => {
                                        const slot = appendPlan.uvPlan.slots[partIndex];
                                        return getBlockMaterial(part.texPath, part.tintHex, myGen,
                                            slot < 0 ? 0 : appendPlan.uvPlan.sourceParts.length, Math.max(0, slot),
                                            appendPlan.tintParts.includes(partIndex) ? partIndex : -1);
                                    }));
                                    if (myGen !== currentLoadGen) return newlyAddedSelectableMeshes;
                                    const oldGeometry = applyAtlasAppend(instancedMesh, appendPlan);
                                    instancedMesh.material = nextMaterials.every(material => material === nextMaterials[0]) ? nextMaterials[0] : nextMaterials;
                                    if (!isSceneHistoryResourceRetained(oldGeometry)) oldGeometry.dispose();
                                }
                                for (let i = 0; i < appendCount; i++) {
                                    const sourceIndex = transformStart + i;
                                    const instanceId = instancedMesh.count + i;
                                    const meta = appendPlan?.instances[i] ?? instances[sourceIndex];
                                    instanceMatrix.fromArray(meta.transform).transpose();
                                    instancedMesh.setMatrixAt(instanceId, instanceMatrix);
                                    setInstanceModelTransform(instancedMesh, instanceId, meta.modelTransform);
                                    for (const [name, value] of [[dragSelectedAttributeName, 0], [entityVisibleAttributeName, 1]] as const) {
                                        const attribute = instancedMesh.geometry.getAttribute(name);
                                        attribute?.setX(instanceId, value);
                                        if (attribute) attribute.needsUpdate = true;
                                    }
                                    setInstanceSkyBrightness(instancedMesh, instanceId, meta.brightness);
                                    registerObject(instancedMesh, instanceId, meta.uuid, meta.groupId);
                                    instancedMesh.userData.displayTypes.set(instanceId, getInstanceDisplayType(meta, representativeParts[0]));
                                    addLoadedInstance(newlyAddedSelectableMeshes, instancedMesh, instanceId);
                                }
                                instancedMesh.count += appendCount;
                                instancedMesh.instanceMatrix.needsUpdate = true;
                                if (instancedMesh.instanceColor) instancedMesh.instanceColor.needsUpdate = true;
                                instancedMesh.visible = true;
                                instancedMesh.computeBoundingBox();
                                instancedMesh.computeBoundingSphere();
                                transformStart += appendCount;
                                if (transformStart === instances.length) break;
                            }
                        }

                        if (transformStart === instances.length) continue;

                        // Merge Geometries
                        const materials: THREE.Material[] = [];
                        const pendingMaterialSlots: Array<{ index: number; promise: Promise<THREE.Material> }> = [];
                        let mergedGeo = mergedGeometryCache.get(group.geometryKey);

                        if (!mergedGeo) {
                            const geometriesToMerge: THREE.BufferGeometry[] = [];
                            const localMatrix = new THREE.Matrix4();

                            for (const part of representativeParts) {
                                const geomKey = getGeometryBufferKey(part);
                                const baseGeo = instancedGeometries.get(geomKey)!;
                                
                                // Clone and apply local transform (modelMatrix)
                                const clonedGeo = baseGeo.clone();
                                localMatrix.fromArray(part.modelMatrix);
                                clonedGeo.applyMatrix4(localMatrix);
                                geometriesToMerge.push(clonedGeo);
                            }

                            mergedGeo = mergeIndexedGeometries(geometriesToMerge) ?? undefined;
                            if (mergedGeo) {
                                // Add groups for multi-material support
                                let start = 0;
                                for (let i = 0; i < geometriesToMerge.length; i++) {
                                    const count = geometriesToMerge[i].getIndex()!.count;
                                    mergedGeo.addGroup(start, count, i);
                                    start += count;
                                }
                                mergedGeometryCache.set(group.geometryKey, mergedGeo);
                            }

                            for (const geometry of geometriesToMerge) {
                                geometry.dispose();
                            }
                        }

                        for (const [partIndex, part] of representativeParts.entries()) {
                            // Prepare Material
                            const slot = group.uvPlan!.slots[partIndex];
                            const uvCount = slot < 0 ? 0 : instancedUvTransformCount;
                            const uvIndex = Math.max(0, slot);
                            const tintIndex = group.tintParts!.includes(partIndex) ? partIndex : -1;
                            const matKey = getMaterialKey(part, uvCount, uvIndex, tintIndex);
                            let material = instancedMaterials.get(matKey);
                            
                            if (!material) {
                                material = placeholderMaterial;
                                ensureInstancedMaterialPromise(part, uvCount, uvIndex, tintIndex);
                                pendingMaterialSlots.push({ index: materials.length, promise: materialPromises.get(matKey)! });
                            }
                            materials.push(material);
                        }

                        if (mergedGeo) {
                            for (let chunkStart = transformStart; chunkStart < instances.length; chunkStart += INITIAL_INSTANCES_PER_INSTANCED_MESH) {
                                const chunkCount = Math.min(INITIAL_INSTANCES_PER_INSTANCED_MESH, instances.length - chunkStart);
                                const chunkCapacity = getAppendableInstanceCapacity(chunkCount);
                                const meshGeometry = mergedGeo.clone();
                                if (usesAtlasUvTransform) {
                                    for (let slot = 0; slot < instancedUvTransformCount; slot++) {
                                        const partIndex = group.uvPlan!.sourceParts[slot];
                                        const baseUvTransform = representativeParts[partIndex]?.uvTransform ?? representativeParts[0]?.uvTransform;
                                        const uvTransforms = new Float32Array(chunkCapacity * 4);
                                        for (let i = 0; i < chunkCount; i++) {
                                            const sourceIndex = chunkStart + i;
                                            const currentUvTransform = getInstancePartUvTransform(instances[sourceIndex], partIndex);
                                            const relativeUvTransform = getRelativeUvTransform(baseUvTransform, currentUvTransform);
                                            uvTransforms.set(relativeUvTransform, i * 4);
                                        }
                                        const attributeName = instancedUvTransformCount === 1
                                            ? 'instancedUvTransform'
                                            : `instancedUvTransform${slot}`;
                                        meshGeometry.setAttribute(attributeName, new THREE.InstancedBufferAttribute(uvTransforms, 4));
                                    }
                                }
                                setEntityStateAttributes(meshGeometry, chunkCapacity);
                                for (const partIndex of group.tintParts!) {
                                    const values = new Float32Array(chunkCapacity * 3).fill(1);
                                    for (let i = 0; i < chunkCount; i++) {
                                        new THREE.Color(instances[chunkStart + i].partTints?.[partIndex] ?? representativeParts[partIndex].tintHex ?? 0xffffff).toArray(values, i * 3);
                                    }
                                    meshGeometry.setAttribute(`instancedTint${partIndex}`, new THREE.InstancedBufferAttribute(values, 3));
                                }
                                const meshMaterial = materials.every(material => material === materials[0]) ? materials[0] : materials;
                                const instancedMesh = new THREE.InstancedMesh(meshGeometry, meshMaterial, chunkCapacity);
                                instancedMesh.instanceMatrix = new THREE.StorageInstancedBufferAttribute(chunkCapacity, 16);
                                instancedMesh.count = chunkCount;
                                
                                instancedMesh.userData.displayType = getInstanceDisplayType(instances[chunkStart], representativeParts[0]);
                                instancedMesh.userData.displayTypes = new Map<number, 'block_display' | 'item_display'>();
                                instancedMesh.userData.pbdeModelMatrix = representativeParts[0].modelMatrix.slice();
                                if (hasReusableSignature) instancedMesh.userData.pbdeSignature = signature;
                                if (group.isAtlasBatch) setAtlasBatchState(instancedMesh, representativeParts, group.uvPlan!, group.tintParts!);
                                
                                instancedMesh.frustumCulled = false;

                                for (let i = 0; i < chunkCount; i++) {
                                    const sourceIndex = chunkStart + i;
                                    const meta = instances[sourceIndex];
                                    instanceMatrix.fromArray(meta.transform).transpose();
                                    instancedMesh.setMatrixAt(i, instanceMatrix);
                                    setInstanceModelTransform(instancedMesh, i, meta.modelTransform);
                                    setInstanceSkyBrightness(instancedMesh, i, meta.brightness);
                                    registerObject(instancedMesh, i, meta.uuid, meta.groupId);
                                    instancedMesh.userData.displayTypes.set(i, getInstanceDisplayType(meta, representativeParts[0]));
                                    addLoadedInstance(newlyAddedSelectableMeshes, instancedMesh, i);
                                }
                                instancedMesh.instanceMatrix.needsUpdate = true;
                                if (instancedMesh.instanceColor) instancedMesh.instanceColor.needsUpdate = true;
                                instancedMesh.computeBoundingSphere();
                                loadedObjectGroup.add(instancedMesh);
                                createdInstancedMeshCount++;

                                // Handle async material loading
                                if (pendingMaterialSlots.length > 0) {
                                    materialUpdates.push({ instancedMesh, materials, pendingMaterialSlots, signature });
                                } else {
                                    if (materials.some(m => m.transparent)) {
                                        instancedMesh.renderOrder = 1;
                                    }
                                }
                            }
                        }
                    }
                const meshBuildElapsedMs = performance.now() - meshBuildStartMs;

                if (materialUpdates.length > 0) {
                    const materialUpdateStartMs = performance.now();
                    await Promise.all(materialUpdates.map(async update => {
                        try {
                            const loadedMats = await Promise.all(update.pendingMaterialSlots.map(slot => slot.promise));
                            if (myGen !== currentLoadGen) return;
                            for (let i = 0; i < update.pendingMaterialSlots.length; i++) {
                                update.materials[update.pendingMaterialSlots[i].index] = loadedMats[i];
                            }
                            update.instancedMesh.material = update.materials;
                            if (update.materials.some(m => m.transparent)) {
                                update.instancedMesh.renderOrder = 1;
                            }
                        } catch (e) {
                            console.warn(`[Texture] Error loading materials for ${update.signature}:`, e);
                        }
                    }));
                    materialAwaitElapsedMs += performance.now() - materialUpdateStartMs;
                }

                const playerHeadItems: Array<OtherItem> = [];
                otherItems.forEach((item) => {
                    if (item.type === 'itemDisplay' && item.textureUrl) {
                        playerHeadItems.push(item);
                    }
                });

                const playerHeadStartMs = performance.now();
                if (!isMerge) {
                    loadedObjectGroup.userData.playerHeadAtlasMaterials = [];
                    notifyPlayerHeadAtlasesChanged();
                }
                if (playerHeadItems.length > 0) {
                    const playerHeadPromise = (async () => {
                        try {
                            if (!headGeometries || !headGeometries.merged) {
                                console.error("Head geometries not available for instancing.");
                                return;
                            }

                            const atlases = getProjectPlayerHeadAtlases();
                            const skinAssignments = new Map<string, { atlas: PlayerHeadAtlas; skin: PlayerHeadSkin }>();
                            const uniqueUrls = [...new Set(playerHeadItems.map(item => item.textureUrl!))];
                            const missingUrls: string[] = [];
                            for (const url of uniqueUrls) {
                                const atlas = atlases.find(candidate => candidate.skins.has(url));
                                const skin = atlas?.skins.get(url);
                                if (atlas && skin) skinAssignments.set(url, { atlas, skin });
                                else missingUrls.push(url);
                            }

                            const loadedSkins = await Promise.all(missingUrls.map(async url => ({ url, image: await loadPlayerHeadImage(url) })));
                            for (const { url, image } of loadedSkins) {
                                const atlas = getOrCreatePlayerHeadAtlas(atlases, createPlayerHeadAtlas);
                                const slot = takePlayerHeadSlot(atlas)!;
                                const skin = { slot, hasHat: drawPlayerHeadSlot(atlas.context, image, slot) };
                                atlas.skins.set(url, skin);
                                atlas.slotUrls[slot] = url;
                                atlas.texture.needsUpdate = true;
                                skinAssignments.set(url, { atlas, skin });
                            }

                            const atlasItems = new Map<PlayerHeadAtlas, Array<{ item: OtherItem; skin: PlayerHeadSkin }>>();
                            for (const item of playerHeadItems) {
                                const assignment = skinAssignments.get(item.textureUrl!);
                                if (!assignment) continue;
                                let items = atlasItems.get(assignment.atlas);
                                if (!items) atlasItems.set(assignment.atlas, items = []);
                                items.push({ item, skin: assignment.skin });
                            }
                            
                            const sharedGeometry = createPlayerHeadAtlasGeometry();

                            let firstAtlas = true;
                            for (const [atlas, entries] of atlasItems) {
                                const geometry = firstAtlas ? sharedGeometry : sharedGeometry.clone();
                                firstAtlas = false;
                                const totalInstances = entries.length;
                                const headCapacity = getAppendableInstanceCapacity(totalInstances);
                                const matrices = new Float32Array(headCapacity * 16);
                                const uvData = new Float32Array(headCapacity * 11);
                                const interleavedUvData = new THREE.InstancedInterleavedBuffer(uvData, 11);
                                const uvOffsets = new THREE.InterleavedBufferAttribute(interleavedUvData, 2, 0);
                                const uvFlips = new THREE.InterleavedBufferAttribute(interleavedUvData, 2, 2);
                                const knifeUvScales = new THREE.InterleavedBufferAttribute(interleavedUvData, 3, 4);
                                const knifeUvOffsets = new THREE.InterleavedBufferAttribute(interleavedUvData, 3, 7);
                                const headLayerVisible = new THREE.InterleavedBufferAttribute(interleavedUvData, 1, 10);
                                const hasHatArray = new Array(totalInstances).fill(false);

                                for (let index = 0; index < headCapacity; index++) {
                                    knifeUvScales.setXYZ(index, 1, 1, 1);
                                    headLayerVisible.setX(index, 1);
                                }

                                entries.forEach(({ item, skin }, index) => {
                                    const matrix = new THREE.Matrix4().fromArray(item.transform).transpose();
                                    matrix.multiply(getPlayerHeadRenderMatrix(item.displayType));
                                    matrix.toArray(matrices, index * 16);
                                    const x = (skin.slot % PLAYER_HEAD_BLOCKS_PER_ROW) * PLAYER_HEAD_BLOCK_WIDTH;
                                    const y = Math.floor(skin.slot / PLAYER_HEAD_BLOCKS_PER_ROW) * PLAYER_HEAD_BLOCK_HEIGHT;
                                    uvOffsets.setXY(index, x / PLAYER_HEAD_ATLAS_SIZE, 1 - (y + PLAYER_HEAD_BLOCK_HEIGHT) / PLAYER_HEAD_ATLAS_SIZE);
                                    hasHatArray[index] = skin.hasHat;
                                });

                                geometry.setAttribute('instancedUvOffset', uvOffsets);
                                geometry.setAttribute('instancedUvFlip', uvFlips);
                                geometry.setAttribute('headLayerVisible', headLayerVisible);
                                geometry.setAttribute('instancedKnifeUvScale', knifeUvScales);
                                geometry.setAttribute('instancedKnifeUvOffset', knifeUvOffsets);
                                setEntityStateAttributes(geometry, headCapacity);

                                const instancedMesh = new THREE.InstancedMesh(geometry, atlas.material, headCapacity);
                                instancedMesh.instanceMatrix = new THREE.StorageInstancedBufferAttribute(matrices, 16);
                                instancedMesh.count = totalInstances;
                                instancedMesh.userData.displayType = 'item_display';
                                instancedMesh.userData.hasHat = hasHatArray;
                                instancedMesh.instanceMatrix.needsUpdate = true;
                                instancedMesh.frustumCulled = false;
                                instancedMesh.layers.enable(2);
                                instancedMesh.computeBoundingSphere();

                                entries.forEach(({ item }, index) => {
                                    setInstanceSkyBrightness(instancedMesh, index, item.brightness as Brightness | undefined);
                                    registerObject(instancedMesh, index, item.uuid, item.groupId);
                                    addLoadedInstance(newlyAddedSelectableMeshes, instancedMesh, index);
                                });
                                if (instancedMesh.instanceColor) instancedMesh.instanceColor.needsUpdate = true;
                                loadedObjectGroup.add(instancedMesh);
                            }

                        } catch (err) {
                            console.error('Player head instancing failed:', err);
                        }
                    })();

                    try { await playerHeadPromise; } catch { /* ignore */ }
                }

                const textItems = otherItems.filter(item => item.type === 'textDisplay');
                await addTextDisplayItems(textItems, registerObject, newlyAddedSelectableMeshes);
                const playerHeadElapsedMs = performance.now() - playerHeadStartMs;

                const meshUploadElapsedMs = performance.now() - meshUploadStartMs;
                if (isPbdeLogEnabled(pbdeLogNames.loadTimings)) {
                    console.log(
                        `[PBDE] Load timings: setup=${setupElapsedMs.toFixed(2)}ms, file=${fileReadElapsedMs.toFixed(2)}ms, parse=${parseElapsedMs.toFixed(2)}ms, atlas=${atlasElapsedMs.toFixed(2)}ms, signatures=${signatureElapsedMs.toFixed(2)}ms, meshBuild=${meshBuildElapsedMs.toFixed(2)}ms, materials=${materialAwaitElapsedMs.toFixed(2)}ms, playerHeads=${playerHeadElapsedMs.toFixed(2)}ms.`
                    );
                }
                if (isPbdeLogEnabled(pbdeLogNames.geometryStats)) {
                    console.log(
                        `[PBDE] Geometry stats: geometryItems=${geometryItemCount}, batches=${activeGeometryBatches?.length ?? 0}, signatures=${signatureGroups.size}, sourceGeometries=${instancedGeometries.size}, mergedGeometries=${mergedGeometryCache.size}, materials=${materialPromises.size}, materialUpdates=${materialUpdates.length}, instancedMeshes=${createdInstancedMeshCount}.`
                    );
                }
                if (isPbdeLogEnabled(pbdeLogNames.meshUploaded)) {
                    console.log(`[PBDE] Mesh uploaded to scene in ${meshUploadElapsedMs.toFixed(2)} ms (${file.name}, ${newlyAddedSelectableMeshes.size} mesh roots, ${loadedObjectGroup.children.length} scene children).`);
                }
                if (isPbdeLogEnabled(pbdeLogNames.finishedProcessing)) {
                    console.log(`[Debug] Finished processing. Total objects in group: ${loadedObjectGroup.children.length}`);
                }
                return newlyAddedSelectableMeshes;

}

