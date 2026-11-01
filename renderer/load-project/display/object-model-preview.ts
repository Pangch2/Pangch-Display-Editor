import { InterleavedBufferAttribute, MathUtils, Matrix4, type BufferAttribute, type InstancedMesh, type Mesh } from 'three/webgpu';
import type { replaceDisplayObjects } from './mesh-builder';
import type { ParsedPbdeProject } from '../scene/scene-parser';
import type { GroupData, GroupChildObject } from '../../controls/grouping/group';
import { loadedObjectGroup, currentLoadGen, setInstanceSkyBrightness } from './display-instancing';
import { appendDisplayObjectPreview } from './project-renderer';
import { getPlayerHeadTexture } from './player-head-atlas';
import { parseDisplayProject } from '../scene/display-project-parser';
import { deleteSelectedItems } from '../../controls/grouping/delete';
import { isSceneHistoryResourceRetained } from '../../controls/undo-redo/scene-history';
import { dragSelectedAttributeName, entityVisibleAttributeName } from '../../entity-material';
import { yieldPreview } from '../../animation/yield-preview';

type DisplayRequest = Parameters<typeof replaceDisplayObjects>[0][number];
type ObjectRef = { mesh: InstancedMesh; instanceId: number };
type SelectionReplacement = { oldMesh: InstancedMesh; oldInstanceId: number; oldLastInstanceId: number; mesh: InstancedMesh; instanceId: number };
const modelMaps = ['objectNames', 'objectBlockProps', 'objectDisplayTypes', 'objectTextDisplayOptions', 'objectTextures', 'objectLabels'] as const;
type PooledMesh = { mesh: InstancedMesh; count: number; geometry: InstancedMesh['geometry']; material: InstancedMesh['material']; attributes: ReturnType<typeof modelAttributes> };
type ModelPool = { valid: boolean; meshes: PooledMesh[]; models: Map<string, { ref: ObjectRef; values: unknown[]; item: boolean }> };
type PreparedProject = { project: ParsedPbdeProject; pool?: ModelPool };
let preparedProjects = new WeakMap<object, Map<string, PreparedProject>>();
const meshPools = new WeakMap<InstancedMesh, ModelPool>();

function modelAttributes(mesh: InstancedMesh) {
    return Object.entries(mesh.geometry.attributes as Record<string, BufferAttribute | InterleavedBufferAttribute>)
        .filter(([name]) => name !== entityVisibleAttributeName && name !== dragSelectedAttributeName)
        .map(([name, attribute]) => ({ name, attribute, version: attribute instanceof InterleavedBufferAttribute ? attribute.data.version : attribute.version }));
}

function poolUnchanged(pool: ModelPool): boolean {
    return pool.valid && pool.meshes.every(({ mesh, geometry, material, attributes }) => mesh.geometry === geometry && mesh.material === material
        && attributes.every(({ name, attribute, version }) => mesh.geometry.getAttribute(name) === attribute
            && (attribute instanceof InterleavedBufferAttribute ? attribute.data.version : attribute.version) === version));
}

function disposeMesh(mesh: InstancedMesh): void {
    if (mesh.count) return;
    mesh.removeFromParent();
    if (!isSceneHistoryResourceRetained(mesh)) mesh.dispose();
    if (!isSceneHistoryResourceRetained(mesh.geometry)) mesh.geometry.dispose();
}

function dropPool(entry: PreparedProject): void {
    if (!entry.pool) return;
    for (const { mesh } of entry.pool.meshes) { meshPools.delete(mesh); disposeMesh(mesh); }
    delete entry.pool;
}

function invalidatePools(): void {
    const cache = preparedProjects.get(loadedObjectGroup.userData.objectUuidToInstance);
    for (const entry of cache?.values() ?? []) dropPool(entry);
}
window.addEventListener('pde:scene-updated', invalidatePools);
window.addEventListener('pde:history-restored', invalidatePools);
window.addEventListener('pde:before-project-load', () => { invalidatePools(); preparedProjects = new WeakMap(); });

function notifySelection(replacements: SelectionReplacement[]): void {
    if (!replacements.length) return;
    const data = loadedObjectGroup.userData;
    data.animationPreviewRevision = (data.animationPreviewRevision ?? 0) + 1;
    window.dispatchEvent(new CustomEvent('pde:replace-object-selection', {
        detail: Object.assign(replacements, { preview: true })
    }));
}

export async function previewObjectModels(requests: DisplayRequest[], isCurrent: (request: DisplayRequest) => boolean,
    applied: (ids: string[]) => void): Promise<void> {
    const data = loadedObjectGroup.userData, refs = data.objectUuidToInstance as Map<string, ObjectRef>, generation = currentLoadGen;
    const sameScene = () => loadedObjectGroup.userData === data && data.objectUuidToInstance === refs;
    const current = () => sameScene() && generation === currentLoadGen;
    await yieldPreview();
    if (!current()) return;
    requests = requests.filter(request => refs.has(request.objectUuid) && isCurrent(request));
    if (!requests.length) return;
    const identity = new Matrix4().toArray();
    const nodes = requests.map(request => ({ uuid: request.objectUuid, name: request.name, transforms: identity,
        nbt: data.objectNbt?.get(request.objectUuid) ?? '', isItemDisplay: !!request.isItemDisplay, isTextDisplay: !!request.isTextDisplay,
        isBlockDisplay: !request.isItemDisplay && !request.isTextDisplay, options: request.options,
        paintTexture: request.paintTexture ?? getPlayerHeadTexture(request.objectUuid) }));
    const key = JSON.stringify(nodes.map(({ transforms: _transforms, ...node }) => node));
    let cache = preparedProjects.get(refs);
    if (!cache) preparedProjects.set(refs, cache = new Map());
    let entry = cache.get(key);
    if (!entry) {
        const project = await parseDisplayProject(nodes);
        if (!current()) return;
        const parsedIds = new Set([...project.metadata.geometryBatches?.filter(batch => batch.parts.some(part => part.posLen && part.indicesLen))
            .flatMap(batch => batch.instances.map(instance => instance.uuid)) ?? [],
            ...project.metadata.otherItems.filter(item => item.type === 'textDisplay' || item.type === 'itemDisplay' && item.textureUrl).map(item => item.uuid)]);
        const invalidIds = requests.filter(request => isCurrent(request) && !parsedIds.has(request.objectUuid)).map(request => request.objectUuid);
        if (invalidIds.length) throw Object.assign(new Error('선택한 속성 조합은 표시할 모델이 없어 적용할 수 없습니다.'), { invalidObjectIds: invalidIds });
        entry = { project };
        if (nodes.every(node => parsedIds.has(node.uuid))) {
            // shortcut: retain four prepared replacement sets; larger clip cycles reparse older sets.
            cache.set(key, entry);
            if (cache.size > 4) {
                const oldest = cache.keys().next().value!;
                dropPool(cache.get(oldest)!); cache.delete(oldest);
            }
        }
    } else {
        cache.delete(key); cache.set(key, entry);
    }
    const originalNodes = new Map(nodes.map(node => [node.uuid, node]));
    requests = requests.filter(request => refs.has(request.objectUuid) && isCurrent(request));
    if (!requests.length) return;
    const replacements = requests.map(request => ({ objectUuid: request.objectUuid,
        node: { ...originalNodes.get(request.objectUuid)!, uuid: MathUtils.generateUUID(), brightness: data.objectBrightness?.get(request.objectUuid) } }));
    const temporaryIds = new Set(replacements.map(({ node }) => node.uuid));
    const staged = data.animationPreviewObjectIds ??= new Set<string>();
    for (const id of temporaryIds) staged.add(id);
    const initialMeshes = new Set(loadedObjectGroup.children);
    const ownedMeshes = new Set<InstancedMesh>();
    try {
        // Build each complete model batch once. Activation below never rebuilds geometry or atlas layouts.
        let pool = entry.pool;
        if (pool && (!poolUnchanged(pool) || pool.meshes.some(({ mesh }) => mesh.count !== 0)
            || pool.models.size !== replacements.length || replacements.some(({ objectUuid }) => !pool.models.has(objectUuid)))) { dropPool(entry); pool = undefined; }
        if (pool) {
            for (const { mesh, count } of pool.meshes) {
                mesh.count = count; mesh.visible = false;
                for (const name of [entityVisibleAttributeName, dragSelectedAttributeName]) {
                    const attribute = mesh.geometry.getAttribute(name);
                    if (attribute) { attribute.array.fill(0); attribute.needsUpdate = true; }
                }
                if (mesh.parent !== loadedObjectGroup) loadedObjectGroup.add(mesh);
            }
            for (const { objectUuid, node } of replacements) {
                const model = pool.models.get(objectUuid)!;
                refs.set(node.uuid, model.ref);
                data.instanceKeyToObjectUuid.set(`${model.ref.mesh.uuid}_${model.ref.instanceId}`, node.uuid);
                modelMaps.forEach((name, index) => { if (model.values[index] !== undefined) data[name].set(node.uuid, model.values[index]); });
                if (model.item) data.objectIsItemDisplay.add(node.uuid);
            }
        } else {
            await appendDisplayObjectPreview(entry.project, replacements);
        }
        if (!current()) return;
        for (const { node } of replacements) {
            const ref = refs.get(node.uuid);
            if (!ref) throw new Error('변경한 오브젝트 모델을 만들 수 없습니다.');
            if (!initialMeshes.has(ref.mesh)) ownedMeshes.add(ref.mesh);
        }
        if (ownedMeshes.size) await data.precompileDisplayModels?.([...ownedMeshes], current);
        if (!current()) return;
        if (!pool && cache.get(key) === entry && replacements.length === nodes.length) {
            const meshes = new Set(replacements.map(({ node }) => refs.get(node.uuid)!.mesh));
            pool = { valid: true, meshes: [...meshes].map(mesh => ({ mesh, count: mesh.count, geometry: mesh.geometry,
                material: mesh.material, attributes: modelAttributes(mesh) })), models: new Map(replacements.map(({ objectUuid, node }) =>
                [objectUuid, { ref: refs.get(node.uuid)!, values: modelMaps.map(name => data[name]?.get(node.uuid)), item: !!data.objectIsItemDisplay?.has(node.uuid) }])) };
            entry.pool = pool;
            for (const mesh of meshes) meshPools.set(mesh, pool);
        }
        const childrenByGroup = new Map<GroupData, { children: GroupData['children']; objects: Map<string, GroupChildObject> }>();
        let activationDeadline = performance.now();
        for (let start = 0; start < requests.length; start += 128) {
            if (performance.now() >= activationDeadline) {
                await yieldPreview();
                if (!current()) return;
                activationDeadline = performance.now() + 8;
            }
            const selection: SelectionReplacement[] = [], ids: string[] = [];
            for (let index = start; index < Math.min(start + 128, requests.length); index++) {
                const request = requests[index], { objectUuid, node } = replacements[index];
                const old = refs.get(objectUuid), next = refs.get(node.uuid);
                if (!old || !next || !isCurrent(request)) continue;
                const oldKey = `${old.mesh.uuid}_${old.instanceId}`, nextKey = `${next.mesh.uuid}_${next.instanceId}`;
                const oldVisible = old.mesh.geometry.getAttribute(entityVisibleAttributeName);
                const visible = old.mesh.visible ? oldVisible?.getX(old.instanceId) ?? 1 : 0;
                if (oldVisible) { oldVisible.setX(old.instanceId, 0); oldVisible.needsUpdate = true; }
                const nextVisible = next.mesh.geometry.getAttribute(entityVisibleAttributeName);
                if (nextVisible) { nextVisible.setX(next.instanceId, visible); nextVisible.needsUpdate = true; }
                next.mesh.visible = true;
                setInstanceSkyBrightness(next.mesh, next.instanceId, data.objectBrightness?.get(objectUuid));
                if (next.mesh.instanceColor) next.mesh.instanceColor.needsUpdate = true;
                const groupId = data.objectToGroup?.get(oldKey);
                data.objectToGroup?.delete(oldKey);
                if (groupId) {
                    data.objectToGroup.set(nextKey, groupId);
                    const group = data.groups?.get(groupId) as GroupData | undefined;
                    if (group) {
                        let entry = childrenByGroup.get(group);
                        if (!entry || entry.children !== group.children) {
                            entry = { children: group.children, objects: new Map(group.children.flatMap(child =>
                                child.type === 'object' && child.id ? [[child.id, child] as const] : [])) };
                            childrenByGroup.set(group, entry);
                        }
                        const child = entry.objects.get(objectUuid) ?? group.children.find(child => child.type === 'object' && child.id === objectUuid) as GroupChildObject;
                        if (child) { child.mesh = next.mesh; child.instanceId = next.instanceId; }
                    }
                }
                for (const name of ['objectNames', 'objectBlockProps', 'objectDisplayTypes', 'objectTextDisplayOptions', 'objectTextures']) {
                    const values = data[name] as Map<string, unknown> | undefined;
                    if (values?.has(node.uuid)) { values.set(objectUuid, values.get(node.uuid)); values.delete(node.uuid); }
                    else values?.delete(objectUuid);
                }
                if (!data.objectLabels?.has(objectUuid) && data.objectLabels?.has(node.uuid)) data.objectLabels.set(objectUuid, data.objectLabels.get(node.uuid));
                data.objectLabels?.delete(node.uuid);
                if (data.objectIsItemDisplay?.delete(node.uuid)) data.objectIsItemDisplay.add(objectUuid);
                else data.objectIsItemDisplay?.delete(objectUuid);
                data.objectNbt?.delete(node.uuid); data.objectBrightness?.delete(node.uuid);
                // Retire the old physical slot under the temporary ID; logical IDs and ordering never change.
                refs.set(objectUuid, next); refs.set(node.uuid, old);
                data.instanceKeyToObjectUuid.set(nextKey, objectUuid); data.instanceKeyToObjectUuid.set(oldKey, node.uuid);
                selection.push({ oldMesh: old.mesh, oldInstanceId: old.instanceId, oldLastInstanceId: old.instanceId, ...next });
                ids.push(objectUuid);
            }
            notifySelection(selection);
            if (ids.length) applied(ids);
        }
    } finally {
        if (sameScene()) {
            const objects = new Map<Mesh, Set<number>>();
            for (const id of temporaryIds) {
                const ref = refs.get(id);
                if (!ref) continue;
                if (!initialMeshes.has(ref.mesh)) ref.mesh.userData.animationPreviewMesh = true;
                if (ref.mesh.userData.animationPreviewMesh) ownedMeshes.add(ref.mesh);
                const ids = objects.get(ref.mesh) ?? new Set<number>(); ids.add(ref.instanceId); objects.set(ref.mesh, ids);
            }
            const moved: SelectionReplacement[] = [];
            for (const [mesh, ids] of objects) {
                const pool = meshPools.get(mesh as InstancedMesh);
                if (pool && (!poolUnchanged(pool) || ids.size !== (mesh as InstancedMesh).count)) pool.valid = false;
                let last = (mesh as InstancedMesh).count - 1;
                for (const instanceId of [...ids].sort((a, b) => b - a)) moved.push({ oldMesh: mesh as InstancedMesh,
                    oldInstanceId: instanceId, oldLastInstanceId: last--, mesh: mesh as InstancedMesh, instanceId });
            }
            if (objects.size) deleteSelectedItems(loadedObjectGroup, { groups: new Set(), objects },
                { resetSelectionAndDeselect: () => {}, preserveAnimation: true, undoable: false })?.dispose();
            notifySelection(moved);
            for (const mesh of objects.keys() as Iterable<InstancedMesh>) {
                const pool = meshPools.get(mesh);
                if (pool?.valid && mesh.count === 0) {
                    const state = pool.meshes.find(state => state.mesh === mesh)!;
                    state.attributes = modelAttributes(mesh);
                    mesh.visible = false; loadedObjectGroup.add(mesh);
                }
            }
            for (const mesh of ownedMeshes) if (!mesh.parent && !meshPools.get(mesh)?.valid) {
                disposeMesh(mesh);
            }
        }
        for (const id of temporaryIds) staged.delete(id);
    }
}
