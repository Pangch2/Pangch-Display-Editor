import { Group, Matrix3, Matrix4, Quaternion, Vector3 } from 'three/webgpu';
import { deferredPlayerHeadTexture, getPlayerHeadRenderMatrix, getPlayerHeadTexture, previewPlayerHeadTextures } from '../load-project/display/player-head-atlas';
import { getGroupWorldMatrix, shouldUseGroupPivot, normalizePivotToVector3, type GroupData } from '../controls/grouping/group';
import { activeAnimation, animationClips, minecraftTransformParts, animationLayers, animationLayerPlayback, animationTimelineEnd, animationChannels, animationPlayback, channelValue, isDisplayReplacement, keyCurve, keyHasChannel, keyTransform, putKey, sampleTrack, setKeyCurve,
    sampleChannelValues, offsetAnimationChannel, sampleTexture, clipKeyTicks, interpolationTick, sampleProperties, samplePivot, transformMatrix, type AnimationData, type AnimationClip, type AnimationChannel,
    type AnimationTrack, type AnimationProperties, type AnimationVector, type AnimationCurve, type AnimationTransform, type AnimationLayerTiming, type AnimationLayerCarry, type AnimationIk, layerRanges, setLayerRanges } from './animation-data';
import { applyAnimationIk, ikBones } from './animation-ik';
import { applyRigPose, hasRigSkin, rigPoseNodes } from '../rig/rig-pose';
import { rigNodeIds, type RigData } from '../rig/rig-data';
import { decomposeDisplayMatrix } from './display-transformation';
import { animationCameraObject, isAnimationCameraPreview, previewAnimationCamera, setAnimationCameraPreview } from './animation-camera';
import { applySceneVisibility } from '../controls/scene-visibility';
import { applyAnimationProperties, hasPendingAnimationProperties } from './animation-properties';
import { applyAnimationMeshPreview, canReuseAnimationMeshPreview, createAnimationMeshPreview, restoreAnimationMeshPreview,
    type AnimationMeshPreview } from './animation-mesh-preview';
import { dragDeltaMatrix, dragSelectedAttributeName } from '../entity-material';
import { getBatchMatrixVersion, getDisplayType, getInstanceHasHat, getInstanceLocalBox, getInstanceValue, getInstanceIsCustomPivot, getInstanceMatrix, getInstanceModelMatrix, getInstancePivot, getInstanceWorldMatrix, invalidateBatchBounds,
    objectRef, readInstanceMatrix, setInstanceIsCustomPivot, setInstanceMatrix, setInstancePivot, type ObjectBatch } from '../scene-store/object-access';

type PoseNode = { type: 'group' | 'object' | 'bone' | 'null'; parent: string | null; matrix: number[]; texture?: string; hasHat?: boolean; properties?: AnimationProperties;
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

export function renderModelTransform(root: Group, id: string, mesh: ObjectBatch, instanceId: number, out = new Matrix4()): Matrix4 {
    const matrix = getInstanceModelMatrix(mesh, instanceId, out);
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
    const meshTransforms = new Map<ObjectBatch, Matrix4>();
    const modelTransform = new Matrix4();
    for (const [id, { mesh, instanceId }] of (data.objectUuidToInstance ?? new Map()) as Map<string, { mesh: ObjectBatch; instanceId: number }>) {
        if (data.animationPreviewObjectIds?.has(id)) continue;
        const matrix = getInstanceMatrix(mesh, instanceId, new Matrix4());
        matrix.multiply(renderModelTransform(root, id, mesh, instanceId, modelTransform).invert());
        let meshTransform = meshTransforms.get(mesh);
        if (!meshTransform) meshTransforms.set(mesh, meshTransform = inverse.clone().multiply(mesh.matrixWorld));
        matrix.premultiply(meshTransform);
        const texture = data.objectTextures?.get(id);
        const brightness = data.objectBrightness?.get(id);
        const options = data.objectTextDisplayOptions?.get(id);
        const pivot = getInstancePivot(mesh, instanceId);
        pose.set(id, { type: 'object', parent: data.objectToGroup?.get(id) ?? null,
            properties: { nbt: data.objectNbt?.get(id) ?? '', name: data.objectNames?.get(id) ?? mesh.name ?? '',
                brightness: brightness ? { sky: brightness.sky ?? 15, block: brightness.block ?? 0 } : null,
                displayType: options ? 'text_display' : data.objectIsItemDisplay?.has(id) ? 'item_display' : 'block_display',
                options: options && structuredClone(options) },
            matrix: matrix.toArray(), matrixAutoUpdate: data.animationSession?.meshPreview?.meshes.get(mesh)?.autoUpdate ?? mesh.matrixAutoUpdate,
            pivot: pivot ? pivot.clone().applyMatrix4(modelTransform.clone().invert()).toArray() : undefined,
            isCustomPivot: getInstanceIsCustomPivot(mesh, instanceId),
            hasHat: getInstanceHasHat(mesh, instanceId),
            texture: data.objectNames?.get(id)?.split('[')[0].replace(/^minecraft:/, '') === 'player_head'
                ? texture === deferredPlayerHeadTexture ? getPlayerHeadTexture(id, data) : texture : undefined });
    }
    for (const [id, node] of rigPoseNodes(root)) pose.set(id, node);
    return pose;
}

// Bones and nulls have no scene object; the preview keeps their shown pose for drawing, picking and key recording.
function storeRigPose(root: Group, pose: AnimationPose): boolean {
    let changed = false;
    for (const [id, node] of pose) {
        if (node.type !== 'bone' && node.type !== 'null') continue;
        const posed: Map<string, number[]> = root.userData.rigPose ??= new Map();
        if (posed.get(id)?.every((value, index) => value === node.matrix[index])) continue;
        posed.set(id, [...node.matrix]);
        changed = true;
    }
    return changed;
}

function matrix(node: PoseNode): Matrix4 { return new Matrix4().fromArray(node.matrix); }
const currentMatrix = new Float32Array(16);
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
// base + Σ (to - from) * times per channel: translation and scale add their difference, rotation applies its turn.
// Changes are summed before composing so a sign-crossing scale is never decomposed midway.
function layerOffset(base: Matrix4, from: Matrix4, changes: Array<[to: Matrix4, times: number]>): Matrix4 {
    const [b, f] = [base, from].map(value => minecraftTransformParts(keyTransform(value)));
    const translation = [...b.translation], scale = [...b.scale], rotation = new Quaternion().fromArray(b.left_rotation);
    for (const [to, times] of changes) {
        const t = minecraftTransformParts(keyTransform(to));
        for (let axis = 0; axis < 3; axis++) {
            translation[axis] += (t.translation[axis] - f.translation[axis]) * times;
            scale[axis] += (t.scale[axis] - f.scale[axis]) * times;
        }
        const turn = new Quaternion().fromArray(f.left_rotation).invert().multiply(new Quaternion().fromArray(t.left_rotation));
        const sin = Math.hypot(turn.x, turn.y, turn.z);
        if (times !== 1) turn.setFromAxisAngle(sin < 1e-12 ? new Vector3(1, 0, 0) : new Vector3(turn.x / sin, turn.y / sin, turn.z / sin), 2 * Math.atan2(sin, turn.w) * times);
        rotation.multiply(turn);
    }
    return transformMatrix({ translation, left_rotation: rotation.toArray(), scale, right_rotation: b.right_rotation });
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

/** `display` (group IK, bone IK and skinning) is only passed for what is shown; key conversions keep the authored (FK) pose. */
export function evaluateAnimation(local: AnimationPose, data: AnimationClip | undefined, tick: number, base?: AnimationPose,
    layers: Array<{ clip: AnimationClip; tick: number; carry?: AnimationLayerCarry }> = data ? [{ clip: data, tick }] : [],
    display?: { ik?: AnimationIk[]; rig?: RigData }): AnimationPose {
    const world: AnimationPose = new Map();
    base = layers.some(layer => layer.clip.tracks.length) ? base ?? evaluateAnimation(local, undefined, 0) : undefined;
    type TrackEntry = { track: AnimationTrack; tick: number; rate: number; carry?: AnimationLayerCarry; below?: TrackEntry };
    const tracks = new Map<string, TrackEntry>();
    for (const layer of layers) {
        const excluded = new Set(layer.clip.excludedNodes), ticks = clipKeyTicks(layer.clip);
        for (const track of layer.clip.tracks) {
            if (!excluded.has(track.id)) tracks.set(track.id, { track, tick: interpolationTick(track.keys, layer.tick, ticks), rate: layer.clip.tickRate ?? 20,
                carry: layer.carry && ticks ? { ...layer.carry, tick: interpolationTick(track.keys, layer.carry.tick, ticks) } : layer.carry, below: tracks.get(track.id) });
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
        const sample = ({ track, rate }: TrackEntry, at: number) => sampleTrack(track.keys, at, rate,
            track.keys.some(key => key.channels || key.values || key.pre || key.curves) ? localTransform(node) : undefined, pivotKey(baseNode ?? node));
        // A layer over a part that a lower clip also keys adds its change since its first key on top of that clip's pose.
        const sampleEntry = (entry: TrackEntry): Matrix4 => {
            const value = sample(entry, entry.tick), below = entry.below?.track.keys.length ? entry.below : undefined;
            if (!below && !entry.carry) return value;
            const first = sample(entry, entry.track.keys[0].tick);
            const changes: Array<[Matrix4, number]> = entry.carry ? [[sample(entry, entry.carry.tick), entry.carry.weight]] : [];
            return below ? layerOffset(sampleEntry(below), first, [[value, 1], ...changes]) : layerOffset(value, first, changes);
        };
        const value = track?.keys.length ? sampleEntry(entry!) : matrix(node);
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
    applyAnimationIk(world, display?.ik);
    applyRigPose(world, display?.rig);
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
    const meshes = new Set<ObjectBatch>();
    const parentTransforms = new Map<Matrix4, Matrix4>();
    const modelTransform = new Matrix4();
    for (const [id, node] of pose) {
        if (pending.has(id)) continue;
        if (node.type === 'bone' || node.type === 'null') continue;
        const value = matrix(node);
        if (node.type === 'group') {
            changed = applyGroupPose(root, id, node, value) || changed;
            continue;
        }
        const ref = data.objectUuidToInstance?.get(id) as { mesh: ObjectBatch; instanceId: number } | undefined;
        if (!ref) continue;
        const { mesh, instanceId } = ref;
        const pivot = node.pivot && new Vector3().fromArray(node.pivot).applyMatrix4(renderModelTransform(root, id, mesh, instanceId, modelTransform).invert());
        const current = getInstancePivot(mesh, instanceId);
        if (pivot ? !current?.equals(pivot) : !!current) changed = true;
        setInstancePivot(mesh, instanceId, pivot || undefined);
        if (restoreBase) {
            changed ||= getInstanceIsCustomPivot(mesh, instanceId) !== node.isCustomPivot;
            setInstanceIsCustomPivot(mesh, instanceId, node.isCustomPivot);
        }
        const parent = mesh.matrixWorld;
        let parentTransform = parentTransforms.get(parent);
        if (!parentTransform) parentTransforms.set(parent, parentTransform = parent.clone().invert().multiply(root.matrixWorld));
        value.premultiply(parentTransform);
        value.multiply(renderModelTransform(root, id, mesh, instanceId, modelTransform));
        readInstanceMatrix(mesh, instanceId, currentMatrix);
        if (value.elements.every((component, index) => Math.fround(component) === currentMatrix[index])) continue;
        setInstanceMatrix(mesh, instanceId, value);
        meshes.add(mesh);
    }
    meshes.forEach(invalidateBatchBounds);
    changed = storeRigPose(root, pose) || changed;
    if (changed || meshes.size) data.animationPreviewRevision = (data.animationPreviewRevision ?? 0) + 1;
    root.updateMatrixWorld(true);
    previewPlayerHeadTextures(root, new Map([...pose].flatMap(([id, node]) => node.texture ? [[id, node.texture] as const] : [])));
}

export function syncAnimationTargets(root: Group): void {
    const session = animationSession(root);
    if (!session.enabled || root.userData.animationPreviewObjectIds?.size) return;
    if (session.meshPreview) session.meshPreview.valid = false;
    const { groups, objectUuidToInstance: objects } = root.userData, rigNodes = rigNodeIds(root);
    if (session.local.size === (groups?.size ?? 0) + (objects?.size ?? 0) + rigNodes.size && session.base.size === session.local.size) {
        let unchanged = true;
        for (const [id, node] of session.local) {
            if (!(node.type === 'group' ? groups : node.type === 'object' ? objects : rigNodes)?.has(id)) { unchanged = false; break; }
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
        setAnimationCameraPreview(root, false);
        syncAnimationTargets(root);
        applyAnimationPose(root, session.base, true);
        delete root.userData.rigPose;
        session.enabled = false;
    }
    const camera = root.userData.animation?.camera as string | undefined;
    if (camera) applySceneVisibility(root, [camera]);
    window.dispatchEvent(new Event('pde:animation-mode-changed'));
}

function applyPreview(root: Group, tick: number, layers?: Array<{ clip: AnimationClip; tick: number; carry?: AnimationLayerCarry }>, elapsed = 0): void {
    const session = animationSession(root);
    if (!session.enabled) return;
    const nextTick = Math.max(0, Math.floor(tick));
    if (!Number.isFinite(tick) || !Number.isSafeInteger(nextTick)) throw new Error('잘못된 애니메이션 시간입니다.');
    if (nextTick !== session.tick) window.dispatchEvent(new Event('pde:before-animation-preview'));
    const clip = animationData(root);
    const groupOnly = !session.transition && !hasPendingAnimationProperties(root) && !hasRigSkin(root) && (layers ?? (clip ? [{ clip, tick }] : [])).every(({ clip, tick }) =>
        clip.tracks.every(track => track.type !== 'object' || !track.keys.length || clip.excludedNodes?.includes(track.id)
            || isUnchangedObjectTrack(track, tick, session.local.get(track.id))));
    const ik = animationProjectData(root)?.ik, display = { ik, rig: root.userData.rig as RigData | undefined };
    const animatedGroups = new Set([...(layers ?? (clip ? [{ clip, tick }] : [])).flatMap(({ clip }) =>
        clip.tracks.filter(track => track.type === 'group' && track.keys.length && !clip.excludedNodes?.includes(track.id)).map(track => track.id)),
        ...ikBones(session.local, ik)]);
    let preview = session.meshPreview;
    if (!preview || !groupOnly || !canReuseAnimationMeshPreview(root, preview, session.local, session.base, animatedGroups)) {
        syncAnimationTargets(root);
        if (preview) { restoreAnimationMeshPreview(preview); delete session.meshPreview; }
        preview = groupOnly ? createAnimationMeshPreview(root, session.local, session.base, animatedGroups) : undefined;
        if (preview) {
            applyAnimationPose(root, session.base, true);
            for (const state of preview.meshes.values()) state.version = getBatchMatrixVersion(state.mesh);
            session.meshPreview = preview;
        }
    }
    session.tick = nextTick;
    if (preview && groupOnly) {
        const pose = evaluateAnimation(preview.local, clip, session.tick, preview.groupBase, layers, display);
        applyAnimationProperties(root, pose);
        let changed = storeRigPose(root, pose);
        for (const [id, node] of pose) changed = applyGroupPose(root, id, node) || changed;
        if (changed) root.userData.animationPreviewRevision = (root.userData.animationPreviewRevision ?? 0) + 1;
        applyAnimationMeshPreview(root, preview, pose);
        previewCamera(root);
        return;
    }
    let pose = evaluateAnimation(session.local, animationData(root), session.tick, session.base, layers, display);
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
    previewCamera(root);
}

export function previewCamera(root: Group): void {
    if (!isAnimationCameraPreview(root)) return;
    const id = animationCameraObject(root), pose = id && animationCameraPose(root, id);
    if (!id || !pose) { previewAnimationCamera(root); return; }
    previewAnimationCamera(root, id, pose);
}

const turnedAround = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI);
/** A text display reads from its +Z side while the camera looks along -Z, so a text standing in for the camera is turned half way round. */
export function cameraModelQuaternion(displayType?: string): Quaternion {
    return displayType === 'text_display' ? turnedAround.clone() : new Quaternion();
}

/**
 * The camera object's pose in world space (rigid): where the game looks from and along. Its position is the middle of whatever model the
 * object shows, so swapping the model neither moves the view nor the object, and its rotation is the display rotation turned for that model.
 */
export function animationCameraPose(root: Group, id: string): Matrix4 | undefined {
    const ref = objectRef(root, id);
    if (!ref) return undefined;
    ref.mesh.updateWorldMatrix(true, false);
    const world = getInstanceWorldMatrix(ref.mesh, ref.instanceId, new Matrix4());
    // While the object is dragged its matrix only changes on release; the drag preview is a separate delta.
    if (getInstanceValue(ref.mesh, ref.instanceId, dragSelectedAttributeName)) world.premultiply(dragDeltaMatrix);
    const center = (getInstanceLocalBox(ref.mesh, ref.instanceId)?.getCenter(new Vector3()) ?? new Vector3()).applyMatrix4(world);
    const quaternion = new Quaternion();
    world.multiply(renderModelTransform(root, id, ref.mesh, ref.instanceId).invert()).decompose(new Vector3(), quaternion, new Vector3());
    quaternion.multiply(cameraModelQuaternion(getDisplayType(ref.mesh, ref.instanceId)));
    return new Matrix4().compose(center, quaternion, new Vector3(1, 1, 1));
}

/** Puts the camera object at a world-space view (its display transform) so a key can record it. */
export function placeAnimationCamera(root: Group, id: string, world: Matrix4): void {
    const ref = objectRef(root, id);
    if (!ref) throw new Error('카메라 오브젝트를 찾을 수 없습니다.');
    ref.mesh.updateWorldMatrix(true, false);
    const model = renderModelTransform(root, id, ref.mesh, ref.instanceId);
    const quaternion = new Quaternion(), scale = new Vector3(), position = new Vector3(), view = new Quaternion();
    getInstanceWorldMatrix(ref.mesh, ref.instanceId, new Matrix4()).multiply(model.clone().invert()).decompose(position, quaternion, scale);
    world.decompose(position, view, new Vector3());
    // Keep the object's size; turn it to the view, then put the middle of its model on the view's position.
    const turned = view.multiply(cameraModelQuaternion(getDisplayType(ref.mesh, ref.instanceId)).invert());
    const center = (getInstanceLocalBox(ref.mesh, ref.instanceId)?.getCenter(new Vector3()) ?? new Vector3()).applyMatrix4(
        new Matrix4().compose(new Vector3(), turned, scale).multiply(model));
    const display = new Matrix4().compose(position.sub(center), turned, scale);
    setInstanceMatrix(ref.mesh, ref.instanceId, ref.mesh.matrixWorld.clone().invert().multiply(display).multiply(model));
    invalidateBatchBounds(ref.mesh);
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
        // Endless repeats run on real time; bounded ranges follow the looped timeline like fixed starts.
        const independent = !timing || timing.interval !== undefined && timing.ends?.length !== timing.starts.length;
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
    setLayerRanges(timing, [[tick, undefined], ...layerRanges(timing)]);
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

// `duplicate`: true copies the current clip, a clip copies that clip.
export function createAnimationClip(root: Group, name: string, duplicate: boolean | AnimationClip = false): string {
    const project = animationProjectData(root), current = animationData(root);
    name = name.trim();
    if (!project || !current || !name || name.length > 120 || animationClips(project).some(clip => (clip.name ?? '기본') === name)) throw new Error('애니메이션 이름은 중복되지 않는 1~120자여야 합니다.');
    const source = duplicate === true ? current : duplicate || undefined;
    const clip: AnimationClip = source ? structuredClone({ ...source, clips: undefined, activeClip: undefined, camera: undefined, ik: undefined,
        layers: animationLayers(project, source).map(clip => clip.id ?? 'default') })
        : { duration: 100, tickRate: current.tickRate, tracks: [], loopMode: 'hold', layers: [] };
    clip.id = crypto.randomUUID(); clip.name = name;
    (project.clips ??= []).push(clip);
    selectAnimationClip(root, clip.id);
    return clip.id;
}

// The first clip is the project object itself, so reordering rebuilds it; project-only fields must not leak into sub-clips.
function setAnimationClips(root: Group, clips: AnimationClip[], activeClip: string): void {
    const { camera, ik } = animationProjectData(root)!;
    const [first, ...rest] = clips.map(({ clips: _clips, activeClip: _active, camera: _camera, ik: _ik, ...clip }: AnimationData) => clip);
    root.userData.animation = { ...first, clips: rest, activeClip, ...camera === undefined ? {} : { camera }, ...ik === undefined ? {} : { ik } } satisfies AnimationData;
}

export function deleteAnimationClip(root: Group, id?: string): void {
    const project = animationProjectData(root), current = animationData(root);
    if (!project || !current) return;
    const target = id === undefined ? current : animationClips(project).find(clip => (clip.id ?? 'default') === id);
    if (!target) throw new Error('애니메이션을 찾을 수 없습니다.');
    const remaining = animationClips(project).filter(clip => clip !== target), targetId = target.id ?? 'default';
    if (!remaining.length) throw new Error('마지막 애니메이션은 삭제할 수 없습니다.');
    for (const clip of remaining) {
        if (clip.layers) clip.layers = clip.layers.filter(id => id !== targetId);
        if (clip.layerTimings) clip.layerTimings = clip.layerTimings.filter(timing => timing.id !== targetId);
    }
    const active = target === current ? remaining[0] : current;
    setAnimationClips(root, remaining, active.id ?? 'default');
    if (target === current) selectAnimationClip(root, active.id ?? 'default');
}

// List order is layer priority: later clips win where parts overlap.
export function moveAnimationClip(root: Group, id: string, offset: number): void {
    const project = animationProjectData(root), current = animationData(root);
    if (!project || !current) return;
    const clips = animationClips(project), from = clips.findIndex(clip => (clip.id ?? 'default') === id), to = from + offset;
    if (from < 0 || to < 0 || to >= clips.length) return;
    clips.splice(to, 0, ...clips.splice(from, 1));
    setAnimationClips(root, clips, current.id ?? 'default');
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

export function recordAnimationTransform(root: Group, before?: AnimationSnapshot, targets: Iterable<string> = [], channels?: AnimationChannel[]): void {
    if (!before || !animationSession(root).enabled) return;
    const session = animationSession(root), after = captureAnimationPose(root);
    const project = structuredClone(animationProjectData(root)!);
    const data = activeAnimation(project);
    const forced = new Set(targets);
    const oldTracks = new Map(before.data && activeAnimation(before.data).tracks.map(track => [track.id, track]));
    const oldTicks = clipKeyTicks(before.data && activeAnimation(before.data));
    const localValue = new Matrix4(), expected = new Matrix4(), parentValue = new Matrix4(), worldValue = new Matrix4();
    for (const [id, node] of after) {
        const old = before.local.get(id);
        if (!old) continue;
        const previous = before.pose.get(id);
        const unchanged = previous && previous.matrix.every((component, index) => component === node.matrix[index]);
        const oldTrack = oldTracks.get(id);
        // The shown pose samples old keys at the global-interpolation tick; the new key lands at session.tick.
        const oldTick = oldTrack ? interpolationTick(oldTrack.keys, session.tick, oldTicks) : session.tick;
        let pivotChanged = false, pivot: number[] | null | undefined;
        if (previous && (!(unchanged || node.type === 'object') || !samePivot(previous.pivot, node.pivot)
            || previous.animatePivot !== node.animatePivot)) {
            const sampled = oldTrack && samplePivot(oldTrack.keys, oldTick);
            const previousPivot = sampled === undefined ? pivotKey(previous) : sampled;
            pivot = pivotKey(node, previousPivot);
            pivotChanged = !samePivot(previousPivot, pivot);
        }
        const textureChanged = node.texture !== (oldTrack ? sampleTexture(oldTrack.keys, oldTick, old.texture) : old.texture);
        const oldProperties = oldTrack ? sampleProperties(oldTrack.keys, oldTick, old.properties) : old.properties;
        const propertiesChanged = !sameProperties(node.properties, oldProperties);
        // History snapshots a model swap after it ran, so `previous` already shows the new model's fit; only the clip sample tells the fit apart.
        // shortcut: a swap while a layer clip plays bakes that layer's offset into the key; pass the pose from before the swap to separate them.
        const swapped = unchanged && (node.properties?.name !== oldProperties?.name || node.properties?.displayType !== oldProperties?.displayType);
        if (unchanged && !textureChanged && !propertiesChanged && !pivotChanged && !forced.has(id)) continue;
        const previousLocal = oldTrack ? sampleTrack(oldTrack.keys, oldTick, data.tickRate, keyTransform(matrix(old)), pivotKey(before.base.get(id) ?? old)) : localValue.fromArray(old.matrix);
        // Compare against the displayed local, which includes playing layers, so a layer's pose is never baked into this clip.
        expected.copy(previousLocal);
        if (previous && !swapped) try { expected.copy(relative(new Matrix4().fromArray(previous.matrix), before.pose.get(node.parent), true)); } catch { /* singular parent: use the clip sample */ }
        const shown = expected.clone();
        if (node.parent && after.has(node.parent)) expected.premultiply(parentValue.fromArray(after.get(node.parent)!.matrix));
        const parentBefore = before.pose.get(node.parent), parentAfter = after.get(node.parent);
        const parentChanged = parentBefore && parentAfter && !parentBefore.matrix.every((component, index) => component === parentAfter.matrix[index]);
        worldValue.fromArray(node.matrix);
        if (parentChanged && close(expected, worldValue) && !textureChanged && !propertiesChanged && !pivotChanged && !forced.has(id)) continue;
        // The shown pose is this clip's sample plus a playing layer's offset; keep only the edit in this clip's key.
        const value = close(expected, worldValue) ? previousLocal : close(shown, previousLocal) ? relative(worldValue, after.get(node.parent))
            : layerOffset(relative(worldValue, after.get(node.parent)), shown, [[previousLocal, 1]]);
        let track = data.tracks.find(entry => entry.id === id);
        if (!track) data.tracks.push(track = { type: node.type, id, keys: [] });
        const first = !track.keys.length;
        const transform = keyTransform(value), previousTransform = keyTransform(previousLocal);
        const changedChannels = channels ?? (forced.has(id) || pivotChanged ? animationChannels : animationChannels.filter(channel =>
            [0, 1, 2].some(axis => Math.abs(channelValue(transform, channel, axis) - channelValue(previousTransform, channel, axis)) > 1e-5)));
        if (!channels && !changedChannels.length && !close(value, previousLocal)) changedChannels.push(...animationChannels);
        putKey(track, session.tick, value, matrix(old), changedChannels);
        if (changedChannels.includes('rotation')) {
            const previousAngles = oldTrack ? sampleChannelValues(oldTrack.keys, 'rotation', oldTick, data.tickRate) : [0, 1, 2].map(axis => channelValue(previousTransform, 'rotation', axis));
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
        if (session.tick === 0) for (const channel of changedChannels) {
            const sampledPivot = oldTrack && samplePivot(oldTrack.keys, 0);
            const anchor = sampledPivot === undefined ? pivotKey(previous ?? before.base.get(id) ?? old) : sampledPivot;
            // Future keys already compensate rotation/scale around their stored pivot during sampling.
            const from = channel === 'translation' && anchor ? new Vector3().fromArray(anchor).applyMatrix4(previousLocal).toArray()
                : sampleChannelValues(oldTrack?.keys ?? [], channel, 0, data.tickRate, previousTransform);
            const to = channel === 'translation' && anchor ? new Vector3().fromArray(anchor).applyMatrix4(value).toArray()
                : sampleChannelValues(track.keys, channel, 0, data.tickRate, transform);
            offsetAnimationChannel(track, channel, from, to);
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
        // Replacement keys are recognized against an earlier model key, so an existing track gets the base model too.
        if (session.tick > 0 && old.properties && (first || propertiesChanged
            && !track.keys.some(key => key.tick < session.tick && key.properties))) track.keys[0].properties = structuredClone(old.properties);
        if (node.properties) track.keys.find(key => key.tick === session.tick)!.properties = structuredClone(node.properties);
        const index = track.keys.findIndex(key => key.tick === session.tick);
        if (unchanged && propertiesChanged && index > 0 && isDisplayReplacement(track.keys, index)) {
            // A stationary replacement's center/size fitting must arrive together with its model.
            if (close(previousLocal, transformMatrix(track.keys[index - 1].transform))) setKeyCurve(track.keys[index], 'all', 'step');
            fitReplacement(track, index, previousLocal, value, data.tickRate, keyTransform(matrix(old)));
        }
    }
    root.userData.animation = project;
    window.dispatchEvent(new Event('pde:animation-changed'));
}

// The fitting offset belongs to the new model only: the old model keeps its path into the key,
// and later keys recorded for the old model take the same offset and size change (a head's 0.5 render scale) in their own local frame.
// The next model key (recorded keys carry their model) shows its own model at its own size; the new model keeps its fit on the way there.
// shortcut: a fit that turns the model (camera icon) carries only its translation and scale into later keys; carry the rotation too if that matters.
function fitReplacement(track: AnimationTrack, index: number, unfitted: Matrix4, fitted: Matrix4, rate: number | undefined, base: AnimationTransform): void {
    const from = new Vector3().setFromMatrixPosition(unfitted), delta = new Vector3().setFromMatrixPosition(fitted).sub(from);
    const scale = (value: Matrix4) => [0, 1, 2].map(axis => channelValue(keyTransform(value), 'scale', axis));
    const scaleFrom = scale(unfitted), scaleTo = scale(fitted);
    const moved = delta.lengthSq() >= 1e-20, scaled = scaleFrom.some((value, axis) => Math.abs(scaleTo[axis] - value) >= 1e-10);
    if (!moved && !scaled) return;
    const key = track.keys[index];
    if (moved && keyCurve(key, 'translation') !== 'step') (key.pre ??= {}).translation = from.toArray() as AnimationVector;
    const linear = new Matrix3().setFromMatrix4(unfitted);
    if (linear.determinant() === 0) return;
    const local = delta.applyMatrix3(linear.invert());
    let end = index + 1;
    while (end < track.keys.length && !track.keys[end].properties) end++;
    const later = track.keys.slice(index + 1, end), next = track.keys[end];
    // Without its own scale the next model would inherit the fitted one; its key holds the size it was recorded with.
    if (scaled && next?.channels && !next.channels.includes('scale')) next.channels.push('scale');
    const offsets = [...later, ...next ? [next] : []].map(entry => local.clone().applyMatrix3(new Matrix3().setFromMatrix4(sampleTrack(track.keys, entry.tick, rate, base))).toArray());
    later.forEach((entry, i) => {
        offsetAnimationChannel({ ...track, keys: [entry] }, 'translation', [0, 0, 0], offsets[i]);
        offsetAnimationChannel({ ...track, keys: [entry] }, 'scale', scaleFrom, scaleTo);
    });
    if (!moved || !next || !keyHasChannel(next, 'translation') || keyCurve(next, 'translation') === 'step') return;
    const offset = offsets[later.length];
    const into = next.pre?.translation ?? next.values?.translation ?? [0, 1, 2].map(axis => channelValue(next.transform, 'translation', axis));
    (next.pre ??= {}).translation = into.map((value, axis) => typeof value === 'string' ? `(${value})+(${offset[axis]})` : value + offset[axis]) as AnimationVector;
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
            const sources = [original, ...changedParents.map(parent => originalClip.tracks.find(entry => entry.id === parent))].filter((entry): entry is AnimationTrack => !!entry);
            simplifyBakedKeys(track, sources, clipKeyTicks(originalClip) ?? [], pivotKey(nextBase.get(id)!));
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
    const { tracks } = clip;
    const ticks = [...new Set([0, ...tracks.flatMap(track => track.keys.map(key => key.tick))])].sort((a, b) => a - b);
    if (!tracks.some(track => track.keys.some(key => key.channels || key.values || key.curves || key.pre))) return ticks;
    const end = Math.max(clip.endTick ?? 0, ticks[ticks.length - 1]);
    // shortcut: procedural hierarchy conversion bakes whole ticks, stream the bake before allowing more than 100,000 frames.
    if (end > 100_000) throw new Error('계층 변환에 필요한 애니메이션이 100,000틱을 초과합니다. 클립을 나눈 뒤 다시 시도해 주세요.');
    return Array.from({ length: end + 1 }, (_, tick) => tick);
}

// Baking samples every tick so curves, expressions and a turning parent's arc survive; keep the source key ticks
// and only the samples their interpolation cannot rebuild.
// shortcut: with global interpolation the extra keys a turning parent leaves also split other parts' segments; fit against the final clip ticks if that matters.
export function simplifyBakedKeys(track: AnimationTrack, sources: AnimationTrack[], fixedTicks: number[], nodePivot: number[] | null): void {
    const { keys } = track, fixed = new Set([...fixedTicks, ...sources.flatMap(source => source.keys.map(key => key.tick))]);
    const kept = keys.map((key, index) => index === 0 || index === keys.length - 1 || fixed.has(key.tick)
        || key.texture !== undefined || !!key.properties || key.pivot !== undefined);
    const exact = keys.map(key => transformMatrix(key.transform).elements);
    for (let start = 0, end = 1; end < keys.length; end++) {
        if (!kept[end]) continue;
        // Interior keys carry no pivot or model, so every piece of this span samples from the same context.
        const before = keys.slice(0, start + 1).reverse();
        const context = { pivot: before.find(key => key.pivot !== undefined)?.pivot, properties: before.find(key => key.properties)?.properties };
        const worst = (a: number, b: number, curve?: AnimationCurve) => {
            const span = [{ ...keys[a], ...context }, { ...keys[b], curve }];
            let index = -1, error = 1e-5;
            for (let i = a + 1; i < b; i++) {
                const sampled = sampleTrack(span, keys[i].tick, undefined, undefined, nodePivot).elements;
                const value = Math.max(...sampled.map((component, k) => Math.abs(component - exact[i][k])));
                if (value > error) { error = value; index = i; }
            }
            return index;
        };
        // An eased or stepped source segment keeps its curve instead of extra keys.
        const curves = [undefined, ...new Set(sources.flatMap(source => source.keys.filter(key => key.tick === keys[end].tick)
            .flatMap(key => [key.curve, ...Object.values(key.curves ?? {})])).filter(curve => curve !== undefined))];
        const fit = curves.findIndex(curve => worst(start, end, curve) < 0);
        if (fit > 0) keys[end].curve = curves[fit];
        else if (fit < 0) for (const parts = [[start, end]]; parts.length;) {
            const [a, b] = parts.pop()!, index = worst(a, b);
            if (index >= 0) { kept[index] = true; parts.push([a, index], [index, b]); }
        }
        start = end;
    }
    track.keys = keys.filter((_, index) => kept[index]);
}

export function serializeAnimation(root: Group, objects: Set<string>, groups: Set<string>, selection: boolean): AnimationData | undefined {
    const data = animationProjectData(root);
    if (!data) return undefined;
    // Bones and nulls are saved with the whole project only.
    const ids = new Set([...objects, ...groups, ...selection ? [] : rigNodeIds(root)]);
    const result = structuredClone(data);
    const snapshot = selection ? captureAnimationSnapshot(root)! : undefined;
    const needsRebase = selection && [...ids].some(id => {
        const parent = snapshot.local.get(id)?.parent;
        return parent && !ids.has(parent);
    });
    if (result.camera && !objects.has(result.camera)) delete result.camera;
    // Bones deleted since the chain was made are dropped here, so saving never fails on them.
    if (result.ik) result.ik = result.ik.filter(entry => groups.has(entry.bone) && groups.has(entry.target));
    if (!result.ik?.length) delete result.ik;
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
    if (data?.camera) data.camera = objects.get(data.camera) ?? data.camera;
    if (data?.ik) data.ik = data.ik.map(entry => ({ ...entry, bone: groups.get(entry.bone) ?? entry.bone, target: groups.get(entry.target) ?? entry.target }));
    if (data) for (const clip of animationClips(data)) {
        for (const track of clip.tracks) track.id = (track.type === 'group' ? groups : objects).get(track.id) ?? track.id;
        if (clip.excludedNodes) clip.excludedNodes = clip.excludedNodes.map(id => objects.get(id) ?? groups.get(id) ?? id);
    }
    const old = animationProjectData(root);
    if (merge && old && data) {
        const destination = activeAnimation(old), source = activeAnimation(data);
        if (data.camera && !animationCameraObject(root)) old.camera = data.camera;
        const rigged = data.ik?.filter(entry => !old.ik?.some(other => other.bone === entry.bone));
        if (rigged?.length) old.ik = [...(old.ik ?? []), ...rigged];
        const ids = new Map<string, string>();
        const legacy = !data.clips?.length && !data.name && !data.id && !data.loopMode && data.endTick === undefined;
        const compatible = (a: AnimationClip, b: AnimationClip) =>
            (['name', 'tickRate', 'loopMode', 'loopDelay', 'endTick', 'transitionTicks', 'globalInterpolation'] as const).every(field => a[field] === b[field]);
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
            delete copy.clips; delete copy.layers; delete copy.layerTimings; delete copy.activeClip; delete copy.ik;
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
            const layers = (clip.layers ?? []).map(id => ids.get(id)!);
            target.layers = [...new Set([...(target.layers ?? []), ...layers])];
            for (const timing of clip.layerTimings ?? []) {
                const id = ids.get(timing.id)!;
                target.layerTimings = [...(target.layerTimings ?? []).filter(entry => entry.id !== id), { ...timing, id }];
            }
        }
        const sourceId = ids.get(source.id ?? 'default')!;
        const layers = [...(destination.layers ?? []), ...animationLayers(data, source).map(clip => ids.get(clip.id ?? 'default')!)];
        if (sourceId !== (destination.id ?? 'default')) layers.push(sourceId);
        destination.layers = [...new Set(layers)];
        if (source !== data || sourceId !== (destination.id ?? 'default')) for (const timing of source.layerTimings ?? []) {
            const id = ids.get(timing.id)!, ratio = (destination.tickRate ?? 20) / (source.tickRate ?? 20);
            const next: AnimationLayerTiming = { id, starts: [], interval: timing.interval === undefined ? undefined : Math.max(1, Math.round(timing.interval * ratio)) };
            setLayerRanges(next, layerRanges(timing).map(([start, end]) => [Math.round(start * ratio), end === undefined ? undefined : Math.round(end * ratio)]));
            destination.layerTimings = [...(destination.layerTimings ?? []).filter(entry => entry.id !== id), next];
        }
    }
    else if (!merge || data) root.userData.animation = data;
    syncAnimationTargets(root);
    if (merge && data && animationSession(root).enabled) previewAnimation(root);
}
