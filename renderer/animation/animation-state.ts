import { Group, Matrix4, Quaternion, Vector3, type InstancedMesh, type Mesh } from 'three/webgpu';
import { getInstanceModelTransform } from '../load-project/batching/instance-model-transform';
import { deferredPlayerHeadTexture, getPlayerHeadRenderMatrix, getPlayerHeadTexture, previewPlayerHeadTextures } from '../load-project/display/player-head-atlas';
import { getGroupWorldMatrix, shouldUseGroupPivot, normalizePivotToVector3, type GroupData } from '../controls/grouping/group';
import { activeAnimation, animationClips, animationLayers, animationLayerPlayback, animationTimelineEnd, animationChannels, animationPlayback, channelValue, isDisplayReplacement, keyTransform, putKey, sampleTrack, setKeyCurve,
    sampleChannelValues, sampleTexture, sampleProperties, samplePivot, transformMatrix, type AnimationData, type AnimationClip, type AnimationChannel,
    type AnimationTrack, type AnimationProperties, type AnimationVector, type AnimationTransform } from './animation-data';
import { decomposeDisplayMatrix } from './display-transformation';
import { applyAnimationProperties, hasPendingAnimationProperties } from './animation-properties';
import { applyAnimationMeshPreview, canReuseAnimationMeshPreview, createAnimationMeshPreview, restoreAnimationMeshPreview,
    type AnimationMeshPreview } from './animation-mesh-preview';

type PoseNode = { type: 'group' | 'object'; parent: string | null; matrix: number[]; texture?: string; hasHat?: boolean; properties?: AnimationProperties;
    pivot?: number[]; isCustomPivot?: boolean; animatePivot?: boolean; matrixAutoUpdate?: boolean };
export type AnimationPose = Map<string, PoseNode>;
type AnimationSession = { enabled: boolean; tick: number; base: AnimationPose; local: AnimationPose; playbackTick?: number;
    playbackSeconds?: number; playbackFinished?: boolean; transition?: { from: AnimationPose; duration: number }; meshPreview?: AnimationMeshPreview };
export type AnimationSnapshot = { data?: AnimationData; base: AnimationPose; local: AnimationPose; pose: AnimationPose };

export function animationProjectData(root: Group): AnimationData | undefined { return root.userData.animation; }
export function animationData(root: Group): AnimationClip | undefined {
    const data = animationProjectData(root);
    return data && activeAnimation(data);
}
export function animationSession(root: Group): AnimationSession {
    return root.userData.animationSession ??= { enabled: false, tick: 0, base: new Map(), local: new Map() };
}

export function renderModelTransform(root: Group, id: string, mesh: InstancedMesh, instanceId: number, out = new Matrix4()): Matrix4 {
    const matrix = getInstanceModelTransform(mesh, instanceId, out);
    if (root.userData.objectIsItemDisplay?.has(id) && root.userData.objectNames?.get(id)?.split('[')[0].replace(/^minecraft:/, '') === 'player_head') {
        matrix.multiply(getPlayerHeadRenderMatrix(root.userData.objectDisplayTypes?.get(id)));
    }
    return matrix;
}

export function captureAnimationPose(root: Group): AnimationPose {
    const pose: AnimationPose = new Map();
    const data = root.userData;
    for (const [id, group] of (data.groups ?? new Map()) as Map<string, GroupData>) {
        pose.set(id, { type: 'group', parent: group.parent ?? null, matrix: getGroupWorldMatrix(group).toArray(),
            properties: { nbt: group.nbt ?? '' },
            pivot: normalizePivotToVector3(group.pivot)?.toArray(), isCustomPivot: group.isCustomPivot, animatePivot: shouldUseGroupPivot(group) });
    }
    root.updateWorldMatrix(true, true);
    const inverse = root.matrixWorld.clone().invert();
    const meshTransforms = new Map<Mesh, Matrix4>();
    const modelTransform = new Matrix4();
    for (const [id, { mesh, instanceId }] of (data.objectUuidToInstance ?? new Map()) as Map<string, { mesh: Mesh | InstancedMesh; instanceId: number }>) {
        if (data.animationPreviewObjectIds?.has(id)) continue;
        const matrix = new Matrix4();
        if ((mesh as InstancedMesh).isInstancedMesh) {
            (mesh as InstancedMesh).getMatrixAt(instanceId, matrix);
            matrix.multiply(renderModelTransform(root, id, mesh as InstancedMesh, instanceId, modelTransform).invert());
        }
        let meshTransform = meshTransforms.get(mesh);
        if (!meshTransform) meshTransforms.set(mesh, meshTransform = inverse.clone().multiply(mesh.matrixWorld));
        matrix.premultiply(meshTransform);
        const texture = data.objectTextures?.get(id);
        const brightness = data.objectBrightness?.get(id);
        const options = data.objectTextDisplayOptions?.get(id);
        const pivot = (mesh as InstancedMesh).isInstancedMesh && mesh.userData.customPivots
            ? mesh.userData.customPivots?.get(instanceId) ?? mesh.userData.customPivots?.get(String(instanceId))
            : mesh.userData.customPivot;
        pose.set(id, { type: 'object', parent: data.objectToGroup?.get(`${mesh.uuid}_${instanceId}`) ?? null,
            properties: { nbt: data.objectNbt?.get(id) ?? '', name: data.objectNames?.get(id) ?? mesh.name ?? '',
                brightness: brightness ? { sky: brightness.sky ?? 15, block: brightness.block ?? 0 } : null,
                displayType: options ? 'text_display' : data.objectIsItemDisplay?.has(id) ? 'item_display' : 'block_display',
                options: options && structuredClone(options) },
            matrix: matrix.toArray(), matrixAutoUpdate: data.animationSession?.meshPreview?.meshes.get(mesh)?.autoUpdate ?? mesh.matrixAutoUpdate,
            pivot: pivot ? ((mesh as InstancedMesh).isInstancedMesh ? pivot.clone().applyMatrix4(modelTransform.clone().invert()) : pivot).toArray() : undefined,
            isCustomPivot: mesh.userData.isCustomPivot,
            hasHat: mesh.userData.hasHat?.[instanceId],
            texture: data.objectNames?.get(id)?.split('[')[0].replace(/^minecraft:/, '') === 'player_head'
                ? texture === deferredPlayerHeadTexture ? getPlayerHeadTexture(id, data) : texture : undefined });
    }
    return pose;
}

function matrix(node: PoseNode): Matrix4 { return new Matrix4().fromArray(node.matrix); }
const localTransforms = new WeakMap<PoseNode, AnimationTransform>();
function localTransform(node: PoseNode): AnimationTransform {
    let transform = localTransforms.get(node);
    // Local/base pose nodes are immutable; frame sampling can share their decomposition.
    if (!transform) localTransforms.set(node, transform = keyTransform(matrix(node)));
    return transform;
}
function close(a: Matrix4, b: Matrix4): boolean {
    return a.elements.every((value, i) => Math.abs(value - b.elements[i]) <= 2e-5 * Math.max(1, Math.abs(value), Math.abs(b.elements[i])));
}
function relative(world: Matrix4, parent?: PoseNode, allowSingular = false): Matrix4 {
    if (!parent) return world.clone();
    const inverse = matrix(parent);
    let result: Matrix4;
    if (inverse.determinant() === 0) {
        if (!allowSingular) throw new Error('부모의 0 스케일로 애니메이션 좌표를 변환할 수 없습니다.');
        const parts = decomposeDisplayMatrix(inverse.clone().transpose().toArray());
        result = new Matrix4().makeRotationFromQuaternion(new Quaternion().fromArray(parts.right_rotation).invert())
            .multiply(new Matrix4().makeScale(...parts.scale.map(value => value ? 1 / value : 0) as [number, number, number]))
            .multiply(new Matrix4().makeRotationFromQuaternion(new Quaternion().fromArray(parts.left_rotation).invert()))
            .multiply(new Matrix4().makeTranslation(-parts.translation[0], -parts.translation[1], -parts.translation[2])).multiply(world);
        const reconstructed = inverse.clone().multiply(result);
        if (!reconstructed.elements.every((value, index) => Math.abs(value - world.elements[index]) < 2e-5)) throw new Error('0 스케일 부모와 자식의 기본 포즈가 호환되지 않습니다.');
    } else result = inverse.invert().multiply(world);
    if (!result.elements.every(Number.isFinite)) throw new Error('애니메이션 좌표를 변환할 수 없습니다.');
    return result;
}
function localize(pose: AnimationPose, allowSingular = true): AnimationPose {
    return new Map([...pose].map(([id, node]) => [id, { ...node, matrix: relative(matrix(node), pose.get(node.parent), allowSingular).toArray() }]));
}

function samePivot(a?: number[] | null, b?: number[] | null): boolean {
    return a === b || !!a && !!b && a.every((value, index) => Math.abs(value - b[index]) < 2e-5);
}

function pivotKey(node: PoseNode, previous?: number[] | null): number[] | null {
    if (!node.pivot || node.type === 'group' && !node.animatePivot) return null;
    if (node.type === 'object') return node.pivot;
    const value = matrix(node);
    if (previous && samePivot(new Vector3().fromArray(previous).applyMatrix4(value).toArray(), node.pivot)) return previous;
    const point = value.clone().setPosition(new Vector3().fromArray(node.pivot));
    return new Vector3().setFromMatrixPosition(relative(point, node, true)).toArray();
}

const localChannelValues = new WeakMap<PoseNode, Partial<Record<AnimationChannel, number[]>>>();

function isLocalTransform(value: AnimationTransform, node: PoseNode): boolean {
    if (Array.isArray(value)) return value.every((component, index) => component === node.matrix[index % 4 * 4 + Math.floor(index / 4)]);
    const base = localTransform(node);
    return !Array.isArray(base) && (['translation', 'left_rotation', 'scale', 'right_rotation'] as const).every(field =>
        value[field].every((component, index) => component === base[field][index]));
}

function isUnchangedObjectTrack(track: AnimationTrack, tick: number, node: PoseNode | undefined): boolean {
    if (!node) return false;
    let fullAnchor = false;
    for (let index = 0; index < track.keys.length; index++) {
        const key = track.keys[index];
        // A future step cannot affect an existing full transform anchor until its own tick.
        if (fullAnchor && key.tick > tick && key.curve === 'step' && Object.values(key.curves ?? {}).every(curve => curve === 'step')) continue;
        // Replacement rotation/scale fitting is discrete; only translation can move before arrival.
        if (fullAnchor && key.tick > tick && isDisplayReplacement(track.keys, index)) {
            if ((!key.channels || key.channels.includes('translation'))
                && [0, 1, 2].some(axis => channelValue(key.transform, 'translation', axis) !== node.matrix[12 + axis])) return false;
            for (const values of [key.values?.translation, key.pre?.translation]) {
                if (values?.some((value, axis) => value !== node.matrix[12 + axis])) return false;
            }
            continue;
        }
        if ((!key.channels || key.channels.length) && !isLocalTransform(key.transform, node)) return false;
        if (key.values || key.pre) for (const values of [key.values, key.pre]) for (const channel of animationChannels) {
            if (!values?.[channel]) continue;
            let cached = localChannelValues.get(node);
            if (!cached) localChannelValues.set(node, cached = {});
            const base = cached[channel] ??= [0, 1, 2].map(axis => channelValue(localTransform(node), channel, axis));
            if (values[channel].some((value, axis) => value !== base[axis])) return false;
        }
        fullAnchor ||= !key.channels || key.channels.length === animationChannels.length;
        if (key.tick <= tick) {
            if (key.properties && !sameProperties(key.properties, node.properties)
                || key.texture !== undefined && key.texture !== node.texture || key.pivot !== undefined) return false;
        } else if (key.curve !== 'step' && key.properties?.displayType === 'text_display' && node.properties?.displayType === 'text_display'
            && !sameProperties(key.properties, node.properties)) return false;
    }
    return true;
}

export function evaluateAnimation(local: AnimationPose, data: AnimationClip | undefined, tick: number, base?: AnimationPose,
    layers: Array<{ clip: AnimationClip; tick: number }> = data ? [{ clip: data, tick }] : []): AnimationPose {
    const world: AnimationPose = new Map();
    base = layers.some(layer => layer.clip.tracks.length) ? base ?? evaluateAnimation(local, undefined, 0) : undefined;
    const tracks = new Map<string, { track: AnimationTrack; tick: number; rate: number }>();
    for (const layer of layers) {
        const excluded = new Set(layer.clip.excludedNodes);
        for (const track of layer.clip.tracks) {
            if (!excluded.has(track.id)) tracks.set(track.id, { track, tick: layer.tick, rate: layer.clip.tickRate ?? 20 });
        }
    }
    const matrices = new Map<string, Matrix4>();
    const visiting = new Set<string>();
    const visit = (id: string): PoseNode => {
        if (world.has(id)) return world.get(id)!;
        if (visiting.has(id)) throw new Error('순환 애니메이션 계층입니다.');
        visiting.add(id);
        const node = local.get(id)!;
        const entry = tracks.get(id), track = entry?.track, trackTick = entry?.tick ?? tick;
        const parent = node.parent && local.has(node.parent) ? visit(node.parent) : undefined;
        const baseNode = base?.get(id);
        if (baseNode && !track?.keys.length && (!parent || parent === base?.get(node.parent))) {
            world.set(id, baseNode); visiting.delete(id);
            return baseNode;
        }
        const value = track?.keys.length ? sampleTrack(track.keys, trackTick, entry.rate,
            track.keys.some(key => key.channels || key.values || key.pre || key.curves) ? localTransform(node) : undefined, pivotKey(baseNode ?? node)) : matrix(node);
        if (parent) {
            let parentMatrix = matrices.get(node.parent);
            if (!parentMatrix) matrices.set(node.parent, parentMatrix = matrix(parent));
            value.premultiply(parentMatrix);
        }
        const result = { ...node, matrix: value.elements, texture: track ? sampleTexture(track.keys, trackTick, node.texture) : node.texture,
            properties: track ? sampleProperties(track.keys, trackTick, node.properties) : node.properties };
        if (node.animatePivot && node.pivot && baseNode && matrix(baseNode).determinant() !== 0) {
            result.pivot = new Vector3().fromArray(node.pivot).applyMatrix4(matrix(baseNode).invert()).applyMatrix4(value).toArray();
        }
        const pivot = track && samplePivot(track.keys, trackTick);
        if (pivot !== undefined) {
            result.pivot = pivot === null ? node.type === 'group' && !node.animatePivot ? node.pivot : undefined : node.type === 'group'
                ? new Vector3().fromArray(pivot).applyMatrix4(value).toArray() : pivot;
            result.isCustomPivot = pivot !== null;
            result.animatePivot = node.type === 'group' && pivot !== null;
        }
        world.set(id, result);
        matrices.set(id, value);
        visiting.delete(id);
        return result;
    };
    local.forEach((_, id) => visit(id));
    return world;
}

function applyGroupPose(root: Group, id: string, node: PoseNode, value = matrix(node)): boolean {
    const group = root.userData.groups?.get(id) as GroupData | undefined;
    if (!group) return false;
    const pivot = normalizePivotToVector3(group.pivot);
    const pivotUnchanged = node.pivot ? pivot && node.pivot.every((value, index) => value === pivot.getComponent(index)) : !pivot;
    const changed = !getGroupWorldMatrix(group).equals(value)
        || !pivotUnchanged || group.isCustomPivot !== node.isCustomPivot;
    if (!changed) return false;
    group.matrix = value;
    group.position ??= new Vector3(); group.quaternion ??= new Quaternion(); group.scale ??= new Vector3();
    value.decompose(group.position, group.quaternion, group.scale);
    // The matrix remains authoritative, including singular and sheared poses.
    if (!Number.isFinite(group.quaternion.w)) group.quaternion.identity();
    group.pivot = node.pivot ? new Vector3().fromArray(node.pivot) : undefined;
    group.isCustomPivot = node.isCustomPivot;
    return true;
}

export function applyAnimationPose(root: Group, pose: AnimationPose, restoreBase = false): void {
    const session = root.userData.animationSession as AnimationSession | undefined;
    if (session?.meshPreview) {
        restoreAnimationMeshPreview(session.meshPreview);
        delete session.meshPreview;
    }
    root.updateWorldMatrix(true, true);
    const data = root.userData;
    const pending = applyAnimationProperties(root, pose);
    let changed = false;
    const meshes = new Set<Mesh | InstancedMesh>();
    const parentTransforms = new Map<Matrix4, Matrix4>();
    const modelTransform = new Matrix4();
    for (const [id, node] of pose) {
        if (pending.has(id)) continue;
        const value = matrix(node);
        if (node.type === 'group') {
            changed = applyGroupPose(root, id, node, value) || changed;
            continue;
        }
        const ref = data.objectUuidToInstance?.get(id) as { mesh: Mesh | InstancedMesh; instanceId: number } | undefined;
        if (!ref) continue;
        const { mesh, instanceId } = ref;
        if ((mesh as InstancedMesh).isInstancedMesh) {
            if (node.pivot) {
                const pivot = new Vector3().fromArray(node.pivot)
                    .applyMatrix4(renderModelTransform(root, id, mesh as InstancedMesh, instanceId, modelTransform).invert());
                if (!mesh.userData.customPivots?.get(instanceId)?.equals(pivot)) changed = true;
                (mesh.userData.customPivots ??= new Map()).set(instanceId, pivot);
            } else {
                if (mesh.userData.customPivot) mesh.userData.customPivots ??= new Map();
                changed = (mesh.userData.customPivots?.delete(instanceId) ?? false) || changed;
            }
            mesh.userData.customPivots?.delete(String(instanceId));
        } else if (node.pivot) {
            const pivot = new Vector3().fromArray(node.pivot);
            if (!mesh.userData.customPivot?.equals(pivot)) changed = true;
            mesh.userData.customPivot = pivot;
        } else { changed ||= !!mesh.userData.customPivot; delete mesh.userData.customPivot; }
        if (restoreBase) {
            changed ||= mesh.userData.isCustomPivot !== node.isCustomPivot;
            if (node.isCustomPivot === undefined) delete mesh.userData.isCustomPivot;
            else mesh.userData.isCustomPivot = node.isCustomPivot;
        }
        const parent = (mesh as InstancedMesh).isInstancedMesh ? mesh.matrixWorld : mesh.parent?.matrixWorld ?? root.matrixWorld;
        let parentTransform = parentTransforms.get(parent);
        if (!parentTransform) parentTransforms.set(parent, parentTransform = parent.clone().invert().multiply(root.matrixWorld));
        value.premultiply(parentTransform);
        if ((mesh as InstancedMesh).isInstancedMesh) {
            const instancedMesh = mesh as InstancedMesh;
            value.multiply(renderModelTransform(root, id, instancedMesh, instanceId, modelTransform));
            if (value.elements.every((component, index) => Math.fround(component) === instancedMesh.instanceMatrix.array[instanceId * 16 + index])) continue;
            instancedMesh.setMatrixAt(instanceId, value);
            instancedMesh.instanceMatrix.addUpdateRange(instanceId * 16, 16);
        } else {
            mesh.matrixAutoUpdate = restoreBase ? node.matrixAutoUpdate ?? true : false;
            if (mesh.matrix.equals(value)) continue;
            mesh.matrix.copy(value);
            value.decompose(mesh.position, mesh.quaternion, mesh.scale);
            mesh.matrixWorldNeedsUpdate = true;
        }
        meshes.add(mesh);
    }
    for (const mesh of meshes) {
        if ((mesh as InstancedMesh).isInstancedMesh) (mesh as InstancedMesh).instanceMatrix.needsUpdate = true;
        mesh.boundingBox = null; mesh.boundingSphere = null;
    }
    if (changed || meshes.size) data.animationPreviewRevision = (data.animationPreviewRevision ?? 0) + 1;
    root.updateMatrixWorld(true);
    previewPlayerHeadTextures(root, new Map([...pose].flatMap(([id, node]) => node.texture ? [[id, node.texture] as const] : [])));
}

export function syncAnimationTargets(root: Group): void {
    const session = animationSession(root);
    if (!session.enabled || root.userData.animationPreviewObjectIds?.size) return;
    if (session.meshPreview) session.meshPreview.valid = false;
    const { groups, objectUuidToInstance: objects } = root.userData;
    if (session.local.size === (groups?.size ?? 0) + (objects?.size ?? 0) && session.base.size === session.local.size) {
        let unchanged = true;
        for (const [id, node] of session.local) {
            if (!(node.type === 'group' ? groups : objects)?.has(id)) { unchanged = false; break; }
        }
        if (unchanged) return;
    }
    const current = captureAnimationPose(root);
    const next = new Map(session.local);
    for (const [id, node] of current) {
        if (!next.has(id)) next.set(id, { ...node, matrix: relative(matrix(node), current.get(node.parent)).toArray() });
    }
    for (const id of next.keys()) if (!current.has(id)) next.delete(id);
    session.local = next;
    session.base = evaluateAnimation(next, undefined, 0);
}

export function setAnimationEnabled(root: Group, enabled: boolean): void {
    const session = animationSession(root);
    if (session.enabled === enabled) return;
    root.userData.animationPreviewRevision = (root.userData.animationPreviewRevision ?? 0) + 1;
    if (enabled) {
        const base = captureAnimationPose(root);
        const local = localize(base);
        session.base = base; session.local = local;
        root.userData.animation ??= { duration: 100, tracks: [] } satisfies AnimationData;
        session.enabled = true;
        if (animationData(root)!.tracks.length) previewAnimation(root, session.tick);
    } else {
        syncAnimationTargets(root);
        applyAnimationPose(root, session.base, true);
        session.enabled = false;
    }
}

function applyPreview(root: Group, tick: number, layers?: Array<{ clip: AnimationClip; tick: number }>, elapsed = 0): void {
    const session = animationSession(root);
    if (!session.enabled) return;
    const nextTick = Math.max(0, Math.floor(tick));
    if (!Number.isFinite(tick) || !Number.isSafeInteger(nextTick)) throw new Error('잘못된 애니메이션 시간입니다.');
    if (nextTick !== session.tick) window.dispatchEvent(new Event('pde:before-animation-preview'));
    const clip = animationData(root);
    const groupOnly = !session.transition && !hasPendingAnimationProperties(root) && (layers ?? (clip ? [{ clip, tick }] : [])).every(({ clip, tick }) =>
        clip.tracks.every(track => track.type === 'group' || !track.keys.length || clip.excludedNodes?.includes(track.id)
            || isUnchangedObjectTrack(track, tick, session.local.get(track.id))));
    const animatedGroups = new Set((layers ?? (clip ? [{ clip, tick }] : [])).flatMap(({ clip }) =>
        clip.tracks.filter(track => track.type === 'group' && track.keys.length && !clip.excludedNodes?.includes(track.id)).map(track => track.id)));
    let preview = session.meshPreview;
    if (!preview || !groupOnly || !canReuseAnimationMeshPreview(root, preview, session.local, session.base, animatedGroups)) {
        syncAnimationTargets(root);
        if (preview) { restoreAnimationMeshPreview(preview); delete session.meshPreview; }
        preview = groupOnly ? createAnimationMeshPreview(root, session.local, session.base, animatedGroups) : undefined;
        if (preview) {
            applyAnimationPose(root, session.base, true);
            for (const state of preview.meshes.values()) state.version = state.mesh.instanceMatrix.version;
            session.meshPreview = preview;
        }
    }
    session.tick = nextTick;
    if (preview && groupOnly) {
        const pose = evaluateAnimation(preview.local, clip, session.tick, preview.groupBase, layers);
        applyAnimationProperties(root, pose);
        let changed = false;
        for (const [id, node] of pose) changed = applyGroupPose(root, id, node) || changed;
        if (changed) root.userData.animationPreviewRevision = (root.userData.animationPreviewRevision ?? 0) + 1;
        applyAnimationMeshPreview(root, preview, pose);
        return;
    }
    let pose = evaluateAnimation(session.local, animationData(root), session.tick, session.base, layers);
    if (session.transition) {
        const amount = Math.min(1, elapsed / session.transition.duration);
        pose = new Map([...pose].map(([id, node]) => {
            const from = session.transition.from.get(id);
            return [id, from && amount < 1 ? { ...node, matrix: sampleTrack([
                { tick: 0, transform: keyTransform(matrix(from)) }, { tick: 1, transform: keyTransform(matrix(node)) }
            ], amount).toArray() } : node];
        }));
        if (amount >= 1) delete session.transition;
    }
    applyAnimationPose(root, pose);
}

export function previewAnimation(root: Group, tick?: number): void {
    const session = animationSession(root);
    delete session.transition;
    const data = animationProjectData(root), primary = animationData(root);
    if (tick === undefined && session.enabled && primary?.loopMode === 'loop' && session.playbackTick !== undefined
        && Math.floor(session.playbackTick) !== session.tick) {
        previewAnimationPlayback(root, session.playbackTick, session.playbackSeconds);
        return;
    }
    tick = Math.round(tick ?? session.tick);
    session.playbackTick = tick;
    session.playbackSeconds = tick / (primary?.tickRate ?? 20); session.playbackFinished = false;
    const clips = primary && data ? animationLayers(data, primary) : [];
    const layers = clips.map(clip => ({ clip, ...animationLayerPlayback(primary!, clip, tick) })).filter(frame => frame.tick !== undefined);
    const timed = clips.some(clip => primary!.layerTimings?.some(timing => timing.id === (clip.id ?? 'default')));
    applyPreview(root, tick, primary ? [{ clip: primary, tick: timed ? animationPlayback(primary, tick).tick : tick }, ...layers] : undefined);
}

export function previewAnimationPlayback(root: Group, elapsed: number, seconds?: number): boolean {
    const data = animationProjectData(root), primary = animationData(root);
    if (!data || !primary || !Number.isFinite(elapsed) || elapsed < 0 || !Number.isSafeInteger(Math.floor(elapsed))) throw new Error('잘못된 애니메이션 재생 시간입니다.');
    seconds ??= elapsed / (primary.tickRate ?? 20);
    if (!Number.isFinite(seconds) || seconds < 0) throw new Error('잘못된 애니메이션 재생 시간입니다.');
    const clips = [primary, ...animationLayers(data, primary)];
    const timed = clips.slice(1).some(clip => primary.layerTimings?.some(timing => timing.id === (clip.id ?? 'default')));
    const tick = timed && primary.loopMode === 'loop'
        ? animationPlayback({ ...primary, endTick: animationTimelineEnd(data, primary) }, elapsed).tick : elapsed;
    const layerSeconds = tick === elapsed ? seconds : tick / (primary.tickRate ?? 20);
    const frames = clips.map(clip => {
        if (clip === primary) return { clip, ...animationPlayback(clip, tick) };
        const timing = primary.layerTimings?.find(timing => timing.id === (clip.id ?? 'default'));
        const independent = !timing || timing.interval !== undefined;
        return { clip, ...animationLayerPlayback(primary, clip, independent ? elapsed : tick, independent ? seconds : layerSeconds) };
    });
    const session = animationSession(root);
    session.playbackTick = elapsed; session.playbackSeconds = seconds;
    applyPreview(root, timed ? tick : frames[0].tick!, frames.filter(frame => frame.tick !== undefined), elapsed);
    return session.playbackFinished = frames.every(frame => frame.finished) && !session.transition;
}

export function placeAnimationLayer(root: Group, id: string, tick = animationSession(root).tick): void {
    const project = animationProjectData(root), primary = animationData(root);
    if (!project || !primary || !animationLayers(project, primary).some(clip => (clip.id ?? 'default') === id)
        || !Number.isSafeInteger(tick) || tick < 0) throw new Error('동작을 선택하고 0 이상의 정수 틱에 배치해 주세요.');
    const timing = primary.layerTimings?.find(timing => timing.id === id) ?? { id, starts: [] };
    timing.starts = timing.interval === undefined ? [...new Set([...timing.starts, tick])].sort((a, b) => a - b) : [tick];
    primary.layerTimings = [...(primary.layerTimings ?? []).filter(entry => entry.id !== id), timing];
}

export function selectAnimationClip(root: Group, id: string, transitionTicks = 0): void {
    const data = animationProjectData(root);
    if (!data || !animationClips(data).some(clip => (clip.id ?? 'default') === id)) throw new Error('애니메이션을 찾을 수 없습니다.');
    const session = animationSession(root);
    const from = transitionTicks > 0 && session.enabled ? captureAnimationPose(root) : undefined;
    data.activeClip = id;
    session.tick = 0; session.playbackTick = 0; session.playbackSeconds = 0; session.playbackFinished = false;
    session.transition = from ? { from, duration: transitionTicks } : undefined;
    if (session.enabled) previewAnimationPlayback(root, 0);
}

export function createAnimationClip(root: Group, name: string, duplicate = false): string {
    const project = animationProjectData(root), current = animationData(root);
    name = name.trim();
    if (!project || !current || !name || name.length > 120 || animationClips(project).some(clip => (clip.name ?? '기본') === name)) throw new Error('애니메이션 이름은 중복되지 않는 1~120자여야 합니다.');
    const clip: AnimationClip = duplicate ? structuredClone({ ...current, clips: undefined, activeClip: undefined,
        layers: animationLayers(project, current).map(clip => clip.id ?? 'default') })
        : { duration: 100, tickRate: current.tickRate, tracks: [], loopMode: 'hold', layers: [] };
    clip.id = crypto.randomUUID(); clip.name = name;
    (project.clips ??= []).push(clip);
    selectAnimationClip(root, clip.id);
    return clip.id;
}

export function deleteAnimationClip(root: Group): void {
    const project = animationProjectData(root), current = animationData(root);
    if (!project || !current) return;
    const remaining = animationClips(project).filter(clip => clip !== current);
    if (!remaining.length) throw new Error('마지막 애니메이션은 삭제할 수 없습니다.');
    for (const clip of remaining) {
        clip.layers = (clip.layers ?? project.layers ?? []).filter(id => id !== (current.id ?? 'default'));
        if (clip.layerTimings) clip.layerTimings = clip.layerTimings.filter(timing => timing.id !== (current.id ?? 'default'));
    }
    const first = remaining[0];
    root.userData.animation = { ...first, clips: remaining.slice(1), activeClip: first.id ?? 'default' } satisfies AnimationData;
    selectAnimationClip(root, first.id ?? 'default');
}

export function captureAnimationSnapshot(root: Group): AnimationSnapshot | undefined {
    if (!animationData(root) && !animationSession(root).enabled) return undefined;
    syncAnimationTargets(root);
    const session = animationSession(root), pose = captureAnimationPose(root);
    const base = session.enabled ? session.base : pose;
    // Base/local nodes are replaced, never mutated; history only needs independent maps.
    return { data: structuredClone(animationProjectData(root)), base: new Map(base), local: new Map(session.enabled ? session.local : localize(base)), pose };
}

export function restoreAnimationSnapshot(root: Group, snapshot?: AnimationSnapshot): void {
    if (!snapshot) return;
    const session = animationSession(root);
    root.userData.animation = structuredClone(snapshot.data);
    session.base = new Map(snapshot.base); session.local = new Map(snapshot.local);
    if (session.enabled) previewAnimation(root);
    else applyAnimationPose(root, snapshot.base, true);
}

export function remapAnimationSnapshot(snapshot: AnimationSnapshot | undefined, ids: Map<string, string>): AnimationSnapshot | undefined {
    if (!snapshot || !ids.size) return snapshot;
    const result = { ...snapshot, data: structuredClone(snapshot.data) };
    for (const name of ['base', 'local', 'pose'] as const) result[name] = new Map([...result[name]].map(([id, node]) =>
        [ids.get(id) ?? id, node.parent && ids.has(node.parent) ? { ...node, parent: ids.get(node.parent)! } : node]));
    for (const clip of result.data ? animationClips(result.data) : []) {
        for (const track of clip.tracks) track.id = ids.get(track.id) ?? track.id;
        if (clip.excludedNodes) clip.excludedNodes = clip.excludedNodes.map(id => ids.get(id) ?? id);
    }
    return result;
}

export function recordAnimationTransform(root: Group, before?: AnimationSnapshot, targets: Iterable<string> = [], channels?: AnimationChannel[]): void {
    if (!before || !animationSession(root).enabled) return;
    const session = animationSession(root), after = captureAnimationPose(root);
    const project = structuredClone(animationProjectData(root)!);
    const data = activeAnimation(project);
    const forced = new Set(targets);
    const oldTracks = new Map(before.data && activeAnimation(before.data).tracks.map(track => [track.id, track]));
    const localValue = new Matrix4(), expected = new Matrix4(), parentValue = new Matrix4(), worldValue = new Matrix4();
    for (const [id, node] of after) {
        const old = before.local.get(id);
        if (!old) continue;
        const previous = before.pose.get(id);
        const unchanged = previous && previous.matrix.every((component, index) => component === node.matrix[index]);
        const oldTrack = oldTracks.get(id);
        let pivotChanged = false, pivot: number[] | null | undefined;
        if (previous && (!(unchanged || node.type === 'object') || !samePivot(previous.pivot, node.pivot)
            || previous.animatePivot !== node.animatePivot)) {
            const sampled = oldTrack && samplePivot(oldTrack.keys, session.tick);
            const previousPivot = sampled === undefined ? pivotKey(previous) : sampled;
            pivot = pivotKey(node, previousPivot);
            pivotChanged = !samePivot(previousPivot, pivot);
        }
        const textureChanged = node.texture !== (oldTrack ? sampleTexture(oldTrack.keys, session.tick, old.texture) : old.texture);
        const propertiesChanged = !sameProperties(node.properties, oldTrack ? sampleProperties(oldTrack.keys, session.tick, old.properties) : old.properties);
        if (unchanged && !textureChanged && !propertiesChanged && !pivotChanged && !forced.has(id)) continue;
        const previousLocal = oldTrack ? sampleTrack(oldTrack.keys, session.tick, data.tickRate, keyTransform(matrix(old)), pivotKey(before.base.get(id) ?? old)) : localValue.fromArray(old.matrix);
        expected.copy(previousLocal);
        if (node.parent && after.has(node.parent)) expected.premultiply(parentValue.fromArray(after.get(node.parent)!.matrix));
        const parentBefore = before.pose.get(node.parent), parentAfter = after.get(node.parent);
        const parentChanged = parentBefore && parentAfter && !parentBefore.matrix.every((component, index) => component === parentAfter.matrix[index]);
        worldValue.fromArray(node.matrix);
        if (parentChanged && close(expected, worldValue) && !textureChanged && !propertiesChanged && !pivotChanged && !forced.has(id)) continue;
        const value = unchanged && close(expected, worldValue) ? previousLocal : relative(worldValue, after.get(node.parent));
        let track = data.tracks.find(entry => entry.id === id);
        if (!track) data.tracks.push(track = { type: node.type, id, keys: [] });
        const first = !track.keys.length;
        const transform = keyTransform(value), previousTransform = keyTransform(previousLocal);
        const changedChannels = channels ?? (forced.has(id) || pivotChanged ? animationChannels : animationChannels.filter(channel =>
            [0, 1, 2].some(axis => Math.abs(channelValue(transform, channel, axis) - channelValue(previousTransform, channel, axis)) > 1e-5)));
        if (!channels && !changedChannels.length && !close(value, previousLocal)) changedChannels.push(...animationChannels);
        putKey(track, session.tick, value, matrix(old), changedChannels);
        if (changedChannels.includes('rotation')) {
            const previousAngles = oldTrack ? sampleChannelValues(oldTrack.keys, 'rotation', session.tick, data.tickRate) : [0, 1, 2].map(axis => channelValue(previousTransform, 'rotation', axis));
            const rotation = [0, 1, 2].map(axis => channelValue(transform, 'rotation', axis));
            // At gimbal lock only X +/- Z is defined; retain the previous split between those axes.
            if (Math.abs(Math.abs(rotation[1]) - 90) < 1e-5) {
                const sign = Math.sign(rotation[1]);
                const delta = rotation[0] - previousAngles[0] - sign * previousAngles[2];
                const offset = (delta - Math.round(delta / 360) * 360) / 2;
                rotation[0] = previousAngles[0] + offset;
                rotation[2] = previousAngles[2] + sign * offset;
            }
            // XYZ Euler angles have two equivalent branches; keep the one continuous with the edited pose.
            const candidates = [rotation, [rotation[0] + 180, 180 - rotation[1], rotation[2] + 180]]
                .map(angles => angles.map((angle, axis) => angle + Math.round((previousAngles[axis] - angle) / 360) * 360));
            const distance = (angles: number[]) => angles.reduce((sum, angle, axis) => sum + (angle - previousAngles[axis]) ** 2, 0);
            const angles = (distance(candidates[1]) < distance(candidates[0]) ? candidates[1] : candidates[0]) as AnimationVector;
            (track.keys.find(key => key.tick === session.tick)!.values ??= {}).rotation = angles;
        }
        if (pivotChanged) {
            if (session.tick > 0 && !track.keys.some(key => key.tick === 0 && key.pivot !== undefined)) {
                const zero = track.keys.find(key => key.tick === 0);
                if (zero) zero.pivot = pivotKey(before.base.get(id)!);
            }
            track.keys.find(key => key.tick === session.tick)!.pivot = pivot;
        }
        if (first && session.tick > 0 && old.texture !== undefined) track.keys[0].texture = old.texture;
        if (node.texture !== undefined) track.keys.find(key => key.tick === session.tick)!.texture = node.texture;
        if (first && session.tick > 0 && old.properties) track.keys[0].properties = structuredClone(old.properties);
        if (node.properties) track.keys.find(key => key.tick === session.tick)!.properties = structuredClone(node.properties);
        const index = track.keys.findIndex(key => key.tick === session.tick);
        // A stationary replacement's center/size fitting must arrive together with its model.
        if (unchanged && propertiesChanged && index > 0 && isDisplayReplacement(track.keys, index)
            && close(previousLocal, transformMatrix(track.keys[index - 1].transform))) setKeyCurve(track.keys[index], 'all', 'step');
    }
    root.userData.animation = project;
    window.dispatchEvent(new Event('pde:animation-changed'));
}

function sameProperties(a?: AnimationProperties, b?: AnimationProperties): boolean {
    return a === b || !!a && !!b && a.nbt === b.nbt && a.name === b.name && a.displayType === b.displayType
        && !!a.brightness === !!b.brightness && a.brightness?.sky === b.brightness?.sky && a.brightness?.block === b.brightness?.block
        && (a.options === b.options || JSON.stringify(a.options) === JSON.stringify(b.options));
}

export function cloneAnimationTarget(root: Group, source: string, target: string, parent?: string | null): void {
    const data = animationProjectData(root);
    for (const clip of data ? animationClips(data) : []) {
        const track = clip.tracks.find(entry => entry.id === source);
        if (track) clip.tracks.push({ ...structuredClone(track), id: target });
        if (clip.excludedNodes?.includes(source)) clip.excludedNodes.push(target);
    }
    const session = animationSession(root), node = session.local.get(source);
    if (session.enabled && node) {
        session.local.set(target, { ...structuredClone(node), parent: parent === undefined ? node.parent : parent });
    }
}

export function removeAnimationTargets(root: Group, ids: Set<string>): () => void {
    const data = animationProjectData(root), session = animationSession(root);
    const removed = (data ? animationClips(data) : []).map(clip => ({ id: clip.id ?? 'default',
        tracks: clip.tracks.filter(track => ids.has(track.id)), excluded: clip.excludedNodes?.filter(id => ids.has(id)) ?? [] }));
    const local = new Map([...session.local].filter(([id]) => ids.has(id)));
    for (const clip of data ? animationClips(data) : []) {
        clip.tracks = clip.tracks.filter(track => !ids.has(track.id));
        if (clip.excludedNodes) clip.excludedNodes = clip.excludedNodes.filter(id => !ids.has(id));
    }
    ids.forEach(id => { session.local.delete(id); session.base.delete(id); });
    return () => {
        const current = animationProjectData(root);
        for (const clip of current ? animationClips(current) : []) {
            const saved = removed.find(entry => entry.id === (clip.id ?? 'default'));
            if (!saved) continue;
            clip.tracks.push(...saved.tracks.filter(track => !clip.tracks.some(entry => entry.id === track.id)));
            if (saved.excluded.length) clip.excludedNodes = [...new Set([...(clip.excludedNodes ?? []), ...saved.excluded])];
        }
        local.forEach((node, id) => session.local.set(id, node));
        session.base = evaluateAnimation(session.local, undefined, 0);
        if (session.enabled) previewAnimation(root);
    };
}

export function assertAnimationParentsInvertible(root: Group, parentIds: Iterable<string | null | undefined>): void {
    const data = animationProjectData(root);
    const ids = [...new Set(parentIds)].filter((id): id is string => !!id);
    if (!data || !ids.length) return;
    const snapshot = captureAnimationSnapshot(root)!;
    const check = (pose: AnimationPose) => {
        for (const id of ids) if (pose.has(id) && matrix(pose.get(id)!).determinant() === 0) {
            throw new Error('부모의 0 스케일로 애니메이션 좌표를 변환할 수 없습니다.');
        }
    };
    check(snapshot.base);
    for (const clip of animationClips(data)) {
        const ticks = new Set([0, ...clip.tracks.flatMap(track => track.keys.map(key => key.tick))]);
        for (const tick of ticks) check(evaluateAnimation(snapshot.local, clip, tick));
    }
}

function translateAnimationTrack(track: AnimationTrack, conversion: Matrix4): AnimationTrack | undefined {
    const offset = new Vector3().setFromMatrixPosition(conversion).toArray();
    if (!conversion.clone().setPosition(0, 0, 0).elements.every((value, index) => Math.abs(value - (index % 5 === 0 ? 1 : 0)) < 1e-12)) return undefined;
    const result = structuredClone(track);
    for (const key of result.keys) for (const [axis, amount] of offset.entries()) {
        if (amount === 0) continue;
        if (Array.isArray(key.transform)) key.transform[axis * 4 + 3] += amount;
        else key.transform.translation[axis] += amount;
        for (const vector of [key.values?.translation, key.pre?.translation]) {
            if (!vector) continue;
            const value = vector[axis];
            const translated = typeof value === 'number' ? value + amount
                : `(${value.replace(/\bvalue\b/g, `(value-(${amount}))`)})+(${amount})`;
            if (typeof translated === 'string' && translated.length > 1024) return undefined;
            vector[axis] = translated;
        }
    }
    return result;
}

// Callers roll back the structure if a coordinate conversion fails.
export function rebaseAnimationStructure(root: Group, before?: AnimationSnapshot): void {
    if (!before) return;
    const after = captureAnimationPose(root), data = structuredClone(before.data);
    const oldLocal = before.local;
    const nextBase: AnimationPose = new Map();
    const changed = new Set<string>();
    for (const [id, node] of after) {
        const old = before.base.get(id);
        if (!old || old.parent !== node.parent) changed.add(id);
        nextBase.set(id, { ...node, texture: old?.texture ?? node.texture, hasHat: old?.hasHat ?? node.hasHat, properties: old?.properties ?? node.properties,
            pivot: old ? old.pivot : node.pivot, isCustomPivot: old ? old.isCustomPivot : node.isCustomPivot,
            animatePivot: old ? old.animatePivot : node.animatePivot, matrix: old?.matrix ?? node.matrix });
    }
    const nextLocal = localize(nextBase);
    const parentPose = (id: string | null, pose: AnimationPose): PoseNode | undefined => {
        if (!id || pose.has(id)) return pose.get(id);
        const node = nextLocal.get(id);
        if (!node) return undefined;
        const parent = parentPose(node.parent, pose);
        return { ...node, matrix: (parent ? matrix(node).premultiply(matrix(parent)) : matrix(node)).toArray() };
    };
    for (const clip of data ? animationClips(data) : []) {
        const nextTracks = clip.tracks.filter(track => after.has(track.id) && !changed.has(track.id));
        if (!changed.size) { clip.tracks = nextTracks; continue; }
        const originalClip = animationClips(before.data!).find(entry => (entry.id ?? 'default') === (clip.id ?? 'default'))!;
        const animatedParents = new Set(originalClip.tracks.filter(track => !originalClip.excludedNodes?.includes(track.id)).map(track => track.id));
        let poses: Map<number, AnimationPose> | undefined;
        for (const id of changed) {
            const old = oldLocal.get(id);
            if (!old) continue;
            const node = after.get(id)!;
            const original = originalClip.tracks.find(track => track.id === id);
            const oldParents: string[] = [], changedParents: string[] = [];
            for (let parent = old.parent; parent; parent = oldLocal.get(parent)?.parent) oldParents.push(parent);
            let common = node.parent;
            while (common && !oldParents.includes(common)) {
                changedParents.push(common); common = nextLocal.get(common)?.parent;
            }
            changedParents.push(...oldParents.slice(0, common ? oldParents.indexOf(common) : oldParents.length));
            if (changedParents.every(parent => !animatedParents.has(parent))) {
                if (!original) continue;
                const conversion = relative(old.parent ? matrix(before.base.get(old.parent)!) : new Matrix4(), nextBase.get(node.parent));
                const translated = translateAnimationTrack(original, conversion);
                if (translated) { nextTracks.push(translated); continue; }
            }
            poses ??= new Map(animationBakeTicks(originalClip).map(tick => [tick, evaluateAnimation(oldLocal, originalClip, tick)]));
            const track: AnimationTrack = { type: node.type, id, keys: [] };
            let previous: PoseNode | undefined;
            for (const [tick, pose] of poses) {
                const world = pose.get(id) ?? node;
                const parent = parentPose(node.parent, pose);
                putKey(track, tick, relative(matrix(world), parent), matrix(nextLocal.get(id)!));
                const key = track.keys[track.keys.length - 1];
                if (!previous || previous.texture !== world.texture) key.texture = world.texture;
                if (world.properties && (!previous || !sameProperties(previous.properties, world.properties))) key.properties = structuredClone(world.properties);
                key.pivot = original?.keys.find(key => key.tick === tick)?.pivot;
                previous = world;
            }
            if (originalClip.tracks.length) nextTracks.push(track);
        }
        clip.tracks = nextTracks;
        if (clip.excludedNodes) clip.excludedNodes = clip.excludedNodes.filter(id => after.has(id));
    }
    if (data) root.userData.animation = data;
    const session = animationSession(root);
    session.base = nextBase; session.local = nextLocal;
    if (session.enabled) previewAnimation(root);
    else applyAnimationPose(root, nextBase);
}

function animationBakeTicks(clip: AnimationClip): number[] {
    const ticks = [...new Set([0, ...clip.tracks.flatMap(track => track.keys.map(key => key.tick))])].sort((a, b) => a - b);
    if (!clip.tracks.some(track => track.keys.some(key => key.channels || key.values || key.curves || key.pre))) return ticks;
    const end = Math.max(clip.endTick ?? 0, ticks[ticks.length - 1]);
    // shortcut: procedural hierarchy conversion bakes whole ticks, stream the bake before allowing more than 100,000 frames.
    if (end > 100_000) throw new Error('계층 변환에 필요한 애니메이션이 100,000틱을 초과합니다. 클립을 나눈 뒤 다시 시도해 주세요.');
    return Array.from({ length: end + 1 }, (_, tick) => tick);
}

export function serializeAnimation(root: Group, objects: Set<string>, groups: Set<string>, selection: boolean): AnimationData | undefined {
    const data = animationProjectData(root);
    if (!data) return undefined;
    const ids = new Set([...objects, ...groups]);
    const result = structuredClone(data);
    const snapshot = selection ? captureAnimationSnapshot(root)! : undefined;
    const needsRebase = selection && [...ids].some(id => {
        const parent = snapshot.local.get(id)?.parent;
        return parent && !ids.has(parent);
    });
    for (const clip of animationClips(result)) {
        const source = animationClips(data).find(entry => (entry.id ?? 'default') === (clip.id ?? 'default'))!;
        clip.tracks = clip.tracks.filter(track => ids.has(track.id));
        if (clip.excludedNodes) clip.excludedNodes = clip.excludedNodes.filter(id => ids.has(id));
        if (!needsRebase || !source.tracks.length) continue;
        const ticks = animationBakeTicks(source);
        for (const id of ids) {
            const node = snapshot.local.get(id);
            if (!node?.parent || ids.has(node.parent)) continue;
            const original = clip.tracks.find(track => track.id === id);
            clip.tracks = clip.tracks.filter(track => track.id !== id);
            let previous: PoseNode | undefined;
            clip.tracks.push({ type: node.type, id, keys: ticks.map(tick => {
                const pose = evaluateAnimation(snapshot.local, source, tick).get(id)!;
                const key = { tick, pivot: original?.keys.find(key => key.tick === tick)?.pivot,
                    texture: !previous || previous.texture !== pose.texture ? pose.texture : undefined,
                    properties: !previous || !sameProperties(previous.properties, pose.properties) ? pose.properties : undefined,
                    transform: keyTransform(matrix(pose)) };
                previous = pose;
                return key;
            }) });
        }
    }
    return result;
}

export function importAnimation(root: Group, value: AnimationData | undefined, merge: boolean,
    objects: Map<string, string>, groups: Map<string, string>): void {
    const data = value && structuredClone(value);
    if (data) for (const clip of animationClips(data)) {
        for (const track of clip.tracks) track.id = (track.type === 'group' ? groups : objects).get(track.id) ?? track.id;
        if (clip.excludedNodes) clip.excludedNodes = clip.excludedNodes.map(id => objects.get(id) ?? groups.get(id) ?? id);
    }
    const old = animationProjectData(root);
    if (merge && old && data) {
        const destination = activeAnimation(old), source = activeAnimation(data);
        for (const clip of animationClips(old)) clip.layers ??= [...(old.layers ?? [])];
        const ids = new Map<string, string>();
        const legacy = !data.clips?.length && !data.name && !data.id && !data.loopMode && data.endTick === undefined;
        const compatible = (a: AnimationClip, b: AnimationClip) =>
            (['name', 'tickRate', 'loopMode', 'loopDelay', 'endTick', 'transitionTicks'] as const).every(field => a[field] === b[field]);
        for (const clip of animationClips(data)) {
            const target = animationClips(old).find(entry => clip.id && entry.id === clip.id && compatible(entry, clip))
                ?? (clip === data && compatible(old, clip) ? old : undefined)
                ?? (clip === source && (legacy || compatible(destination, clip)) ? destination : undefined);
            if (target) {
                target.tracks.push(...clip.tracks);
                if (clip.excludedNodes?.length) target.excludedNodes = [...new Set([...(target.excludedNodes ?? []), ...clip.excludedNodes])];
                ids.set(clip.id ?? 'default', target.id ?? 'default');
                continue;
            }
            const copy = structuredClone(clip) as AnimationData;
            delete copy.clips; delete copy.layers; delete copy.layerTimings; delete copy.activeClip;
            copy.id = crypto.randomUUID();
            const originalName = copy.name ?? '기본';
            let suffix = 2;
            while (animationClips(old).some(entry => (entry.name ?? '기본') === (copy.name ?? '기본'))) {
                const ending = ` ${suffix++}`;
                copy.name = originalName.slice(0, 120 - ending.length) + ending;
            }
            (old.clips ??= []).push(copy);
            ids.set(clip.id ?? 'default', copy.id);
        }
        for (const clip of animationClips(data)) {
            const target = animationClips(old).find(entry => (entry.id ?? 'default') === ids.get(clip.id ?? 'default'))!;
            const layers = (clip.layers ?? data.layers ?? []).map(id => ids.get(id)!);
            target.layers = [...new Set([...(target.layers ?? []), ...layers])];
            for (const timing of clip.layerTimings ?? []) {
                const id = ids.get(timing.id)!;
                target.layerTimings = [...(target.layerTimings ?? []).filter(entry => entry.id !== id), { ...timing, id }];
            }
        }
        const sourceId = ids.get(source.id ?? 'default')!;
        const layers = [...destination.layers, ...animationLayers(data, source).map(clip => ids.get(clip.id ?? 'default')!)];
        if (sourceId !== (destination.id ?? 'default')) layers.push(sourceId);
        destination.layers = [...new Set(layers)];
        if (source !== data || sourceId !== (destination.id ?? 'default')) for (const timing of source.layerTimings ?? []) {
            const id = ids.get(timing.id)!, ratio = (destination.tickRate ?? 20) / (source.tickRate ?? 20);
            destination.layerTimings = [...(destination.layerTimings ?? []).filter(entry => entry.id !== id), { id,
                starts: [...new Set(timing.starts.map(tick => Math.round(tick * ratio)))],
                interval: timing.interval === undefined ? undefined : Math.max(1, Math.round(timing.interval * ratio)) }];
        }
    }
    else if (!merge || data) root.userData.animation = data;
    syncAnimationTargets(root);
    if (merge && data && animationSession(root).enabled) previewAnimation(root);
}
