import { Matrix4, Vector3, type Group } from 'three/webgpu';
import type { GroupData } from '../controls/grouping/group';
import { animationClips, keyTransform, transformMatrix, validateAnimation, type AnimationClip, type AnimationData, type AnimationKey, type AnimationTrack } from './animation-data';
import { addAnimationIk } from './animation-ik';
import { captureAnimationSnapshot, evaluateAnimation, simplifyBakedKeys, type AnimationPose } from './animation-state';

/** Bone (group) tracks and IK chains keyed by group name path; each key is a turn of its bone's rest pose about the bone's joint. */
export type AnimationFile = { format: 'pde-animation'; version: 1; animation: AnimationData };

function bonePath(groups: Map<string, GroupData>, id: string): string {
    const names: string[] = [];
    for (let group = groups.get(id); group; group = group.parent ? groups.get(group.parent) : undefined) names.unshift(group.name);
    return names.join('/');
}

function restBones(root: Group): { local: AnimationPose; base: AnimationPose; groups: Map<string, GroupData> } {
    const snapshot = captureAnimationSnapshot(root), groups = root.userData.groups as Map<string, GroupData> | undefined;
    if (!snapshot || !groups?.size) throw new Error('본(그룹)이 있는 모델에서 애니메이션 모드를 켜 주세요.');
    const local: AnimationPose = new Map([...snapshot.local].filter(([, node]) => node.type === 'group'));
    return { local, base: new Map([...snapshot.base].filter(([id]) => local.has(id))), groups };
}

// A key K is stored as D = (L·J)⁻¹·K·J: L the bone's rest local transform, J the move to its joint, so D carries no bone length.
function restFrame(local: AnimationPose, base: AnimationPose, id: string): { frame: Matrix4; joint: Matrix4 } | undefined {
    const node = local.get(id), world = base.get(id);
    if (!node || !world) return undefined;
    const rest = new Matrix4().fromArray(node.matrix), inverse = new Matrix4().fromArray(world.matrix);
    if (rest.determinant() === 0 || inverse.determinant() === 0) return undefined;
    const point = node.animatePivot && node.pivot ? new Vector3().fromArray(node.pivot).applyMatrix4(inverse.invert()) : new Vector3();
    const joint = new Matrix4().makeTranslation(point.x, point.y, point.z);
    return { frame: rest.multiply(joint), joint };
}

const clipFields = ({ name, duration, tickRate, loopMode, loopDelay, endTick, transitionTicks, globalInterpolation }: AnimationClip) =>
    ({ name, duration, tickRate, loopMode, loopDelay, endTick, transitionTicks, globalInterpolation });

export function exportAnimationFile(root: Group, clips: AnimationClip[]): string {
    const { local, base, groups } = restBones(root), project = root.userData.animation as AnimationData;
    const ids = new Set(clips.map(clip => clip.id ?? 'default'));
    let count = 0;
    const exported = clips.map((clip): AnimationClip => {
        const poses = new Map<number, AnimationPose>();
        const pose = (tick: number) => poses.get(tick) ?? poses.set(tick, evaluateAnimation(local, clip, tick, base)).get(tick)!;
        const tracks: AnimationTrack[] = [];
        for (const track of clip.tracks) {
            const rest = track.type === 'group' && track.keys.length && !clip.excludedNodes?.includes(track.id) && restFrame(local, base, track.id);
            if (!rest) continue;
            const inverse = rest.frame.clone().invert(), first = track.keys[0].tick, last = track.keys[track.keys.length - 1].tick;
            // Channel keys and expressions only sample exactly, so they are baked per tick and simplified below.
            const dense = track.keys.some(key => key.channels || key.values || key.pre || key.curves);
            if (dense && last - first > 100_000) throw new Error('100,000틱을 넘는 본 트랙은 내보낼 수 없습니다.');
            const ticks = dense ? Array.from({ length: last - first + 1 }, (_, index) => first + index) : track.keys.map(key => key.tick);
            const keys = ticks.map((tick): AnimationKey => {
                const world = pose(tick), node = world.get(track.id)!, parent = node.parent ? world.get(node.parent) : undefined;
                const value = new Matrix4().fromArray(node.matrix), parentMatrix = parent && new Matrix4().fromArray(parent.matrix);
                if (parentMatrix?.determinant() === 0) throw new Error(`스케일이 0인 부모 본이 있어 내보낼 수 없습니다: ${bonePath(groups, track.id)}`);
                if (parentMatrix) value.premultiply(parentMatrix.invert());
                const curve = dense ? undefined : track.keys.find(key => key.tick === tick)?.curve;
                return { tick, transform: keyTransform(value.premultiply(inverse).multiply(rest.joint)), ...curve === undefined ? {} : { curve } };
            });
            const result: AnimationTrack = { type: 'group', id: bonePath(groups, track.id), keys };
            if (dense) simplifyBakedKeys(result, [track], [], null);
            if (tracks.some(other => other.id === result.id)) throw new Error(`이름 경로가 같은 본이 둘 이상입니다. 이름을 바꿔 주세요: ${result.id}`);
            tracks.push(result);
        }
        count += tracks.length;
        return { id: clip.id ?? 'default', ...clipFields(clip), tracks, layers: clip.layers?.filter(id => ids.has(id)),
            layerTimings: clip.layerTimings?.filter(timing => ids.has(timing.id)) };
    });
    if (!count) throw new Error('내보낼 본(그룹) 키프레임이 없습니다. 오브젝트 키프레임은 다른 모델에 옮길 수 없습니다.');
    const ik = project.ik?.filter(entry => groups.has(entry.bone) && groups.has(entry.target))
        .map(entry => ({ ...entry, bone: bonePath(groups, entry.bone), target: bonePath(groups, entry.target) }));
    const animation: AnimationData = JSON.parse(JSON.stringify({ ...exported[0], clips: exported.slice(1), ik: ik?.length ? ik : undefined }));
    validateAnimation(animation, new Set(), new Set([...exported.flatMap(clip => clip.tracks.map(track => track.id)), ...(ik ?? []).flatMap(entry => [entry.bone, entry.target])]));
    return JSON.stringify({ format: 'pde-animation', version: 1, animation } satisfies AnimationFile);
}

/** Adds the file's clips as new clips on the bones whose name path (else unique name) matches; returns the first added clip's id. */
export function importAnimationFile(root: Group, value: unknown): string {
    const file = value as AnimationFile | undefined, source = file?.animation;
    if (!file || typeof file !== 'object' || file.format !== 'pde-animation' || file.version !== 1 || !source || typeof source !== 'object') throw new Error('PDE 애니메이션(.pdeanim) 파일이 아닙니다.');
    const paths = new Set<string>(), clipList = Array.isArray(source.clips) ? [source, ...source.clips] : [source];
    for (const clip of clipList) for (const track of Array.isArray(clip?.tracks) ? clip.tracks : []) paths.add(track?.id);
    for (const entry of Array.isArray(source.ik) ? source.ik : []) { paths.add(entry?.bone); paths.add(entry?.target); }
    validateAnimation(source, new Set(), paths);
    const project = root.userData.animation as AnimationData | undefined;
    if (!project) throw new Error('애니메이션 모드를 켜 주세요.');
    const { local, base, groups } = restBones(root);
    const byPath = new Map<string, string>(), byName = new Map<string, string | null>();
    for (const [id, group] of groups) {
        byPath.set(bonePath(groups, id), id);
        byName.set(group.name, byName.has(group.name) ? null : id);
    }
    const resolve = (path: string) => byPath.get(path) ?? byName.get(path.slice(path.lastIndexOf('/') + 1)) ?? undefined;
    const clipIds = new Map(animationClips(source).map(clip => [clip.id ?? 'default', crypto.randomUUID()]));
    const names = new Set(animationClips(project).map(clip => clip.name ?? '기본'));
    let count = 0;
    const added = animationClips(source).map((clip): AnimationClip => {
        const tracks: AnimationTrack[] = [];
        for (const track of clip.tracks) {
            const id = resolve(track.id), rest = id && !tracks.some(other => other.id === id) && restFrame(local, base, id);
            if (!rest) continue;
            const back = rest.joint.clone().invert();
            tracks.push({ type: 'group', id: id!, keys: track.keys.map(({ tick, transform, curve }) =>
                ({ tick, transform: keyTransform(rest.frame.clone().multiply(transformMatrix(transform)).multiply(back)), ...curve === undefined ? {} : { curve } })) });
        }
        count += tracks.length;
        const original = (clip.name ?? '기본').slice(0, 110);
        let name = original;
        for (let index = 2; names.has(name); index++) name = `${original} ${index}`;
        names.add(name);
        return { ...clipFields(clip), id: clipIds.get(clip.id ?? 'default'), name, tracks, layers: clip.layers?.map(id => clipIds.get(id)!),
            layerTimings: clip.layerTimings?.map(timing => ({ ...timing, id: clipIds.get(timing.id)! })) };
    });
    if (!count) throw new Error('이 모델에서 이름이 같은 본(그룹)을 찾지 못했습니다.');
    const clips: AnimationClip[] = JSON.parse(JSON.stringify(added));
    validateAnimation({ ...clips[0], clips: clips.slice(1) }, new Set(), new Set(groups.keys()));
    (project.clips ??= []).push(...clips);
    for (const entry of source.ik ?? []) {
        const bone = resolve(entry.bone), target = resolve(entry.target);
        if (!bone || !target || project.ik?.some(other => other.bone === bone)) continue;
        // A chain longer than this model's hierarchy is skipped rather than failing the whole import.
        try { addAnimationIk(root, { bone, target, chain: entry.chain }); } catch { /* skipped */ }
    }
    return clips[0].id!;
}
