import { Matrix4, Quaternion, Vector3, type Group } from 'three/webgpu';
import type { GroupData } from '../controls/grouping/group';
import type { AnimationData, AnimationIk } from './animation-data';
import type { AnimationPose } from './animation-state';

// CCD closes in slowly near full reach; passes stop early once the tip is within reach.
const passes = 64, reach = 1e-4;

// A bone's joint: its custom pivot (world, kept current by evaluateAnimation), else its origin.
function jointPosition(pose: AnimationPose, id: string, out: Vector3): Vector3 | undefined {
    const node = pose.get(id);
    if (!node) return undefined;
    return node.type === 'group' && node.animatePivot && node.pivot ? out.fromArray(node.pivot) : out.set(node.matrix[12], node.matrix[13], node.matrix[14]);
}

/** The groups a chain turns, top first. */
function chainJoints(parentOf: (id: string) => string | null | undefined, { bone, chain }: AnimationIk): string[] {
    const joints: string[] = [];
    for (let id = parentOf(bone); id && joints.length < chain; id = parentOf(id)) joints.unshift(id);
    return joints;
}

/** Every group an IK chain moves, so the group-only preview treats them as animated. */
export function ikBones(pose: AnimationPose, chains: AnimationIk[] | undefined): string[] {
    return (chains ?? []).flatMap(entry => [entry.bone, ...chainJoints(id => pose.get(id)?.parent, entry)]);
}

/** CCD in world space on an evaluated pose; replaces the nodes it moves (pose nodes are shared and never mutated). */
export function applyAnimationIk(pose: AnimationPose, chains: AnimationIk[] | undefined): void {
    if (!chains?.length) return;
    const children = new Map<string, string[]>();
    for (const [id, node] of pose) if (node.parent) {
        const list = children.get(node.parent);
        if (list) list.push(id); else children.set(node.parent, [id]);
    }
    const goal = new Vector3(), tip = new Vector3(), center = new Vector3(), from = new Vector3(), to = new Vector3();
    const turn = new Quaternion(), step = new Matrix4(), rotation = new Matrix4(), back = new Matrix4();
    for (const entry of chains) {
        const joints = chainJoints(id => pose.get(id)?.parent, entry);
        if (!joints.length || !jointPosition(pose, entry.target, goal) || !jointPosition(pose, entry.bone, tip)) continue;
        // turns[i]: how far joints[i] and everything under it have turned so far.
        const turns = joints.map(() => new Matrix4()), centers = joints.map(id => jointPosition(pose, id, new Vector3())!);
        for (let pass = 0; pass < passes && tip.distanceToSquared(goal) > reach * reach; pass++) {
            for (let index = joints.length - 1; index >= 0; index--) {
                center.copy(centers[index]).applyMatrix4(turns[index]);
                from.subVectors(tip, center); to.subVectors(goal, center);
                if (from.lengthSq() < 1e-12 || to.lengthSq() < 1e-12) continue;
                turn.setFromUnitVectors(from.normalize(), to.normalize());
                step.makeTranslation(center.x, center.y, center.z).multiply(rotation.makeRotationFromQuaternion(turn))
                    .multiply(back.makeTranslation(-center.x, -center.y, -center.z));
                for (let below = index; below < joints.length; below++) turns[below].premultiply(step);
                tip.applyMatrix4(step);
            }
        }
        const move = (id: string, index: number): void => {
            const node = pose.get(id)!, at = joints.indexOf(id), value = turns[at < 0 ? index : at];
            const next = { ...node, matrix: new Matrix4().fromArray(node.matrix).premultiply(value).toArray() };
            if (node.type === 'group' && node.pivot) next.pivot = new Vector3().fromArray(node.pivot).applyMatrix4(value).toArray();
            pose.set(id, next);
            for (const child of children.get(id) ?? []) move(child, at < 0 ? index : at);
        };
        move(joints[0], 0);
    }
}

export function addAnimationIk(root: Group, entry: AnimationIk): void {
    const data = root.userData.animation as AnimationData | undefined, groups = root.userData.groups as Map<string, GroupData> | undefined;
    const { bone, target, chain } = entry;
    if (!data || !groups?.has(bone) || !groups.has(target) || bone === target) throw new Error('끝 본과 타깃으로 서로 다른 그룹을 골라 주세요.');
    if (!Number.isSafeInteger(chain) || chain < 1 || chain > 64) throw new Error('체인 길이는 1~64 사이 정수여야 합니다.');
    const parentOf = (id: string) => groups.get(id)?.parent;
    const joints = chainJoints(parentOf, entry);
    if (joints.length < chain) throw new Error(`끝 본 위에 그룹이 ${chain}개 이상 있어야 합니다.`);
    for (let id: string | null | undefined = target; id; id = parentOf(id)) {
        if (id === joints[0]) throw new Error('타깃은 IK 체인 밖의 그룹이어야 합니다.');
    }
    if (data.ik?.some(other => other.bone === bone)) throw new Error('이미 IK가 있는 본입니다.');
    (data.ik ??= []).push({ bone, target, chain });
}

export function removeAnimationIk(root: Group, bone: string): void {
    const data = root.userData.animation as AnimationData | undefined;
    if (!data?.ik) return;
    data.ik = data.ik.filter(entry => entry.bone !== bone);
    if (!data.ik.length) delete data.ik;
}
