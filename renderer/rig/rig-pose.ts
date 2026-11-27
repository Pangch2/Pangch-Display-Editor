import { Matrix4, Quaternion, Vector3, type Group } from 'three/webgpu';
import type { AnimationPose } from '../animation/animation-state';
import { rigRestWorlds, type RigData, type RigNull } from './rig-data';

/** Bones and nulls as animation pose nodes: their shown pose while the preview poses them, else their rest pose. */
export function rigPoseNodes(root: Group): Array<[string, { type: 'bone' | 'null'; parent: string | null; matrix: number[] }]> {
    const rig = root.userData.rig as RigData | undefined, posed = root.userData.rigPose as Map<string, number[]> | undefined;
    return rig?.armatures.flatMap(armature => {
        const rest = rigRestWorlds(armature);
        return [...armature.bones.map(node => [node, 'bone'] as const), ...armature.nulls.map(node => [node, 'null'] as const)]
            .map(([node, type]): [string, { type: 'bone' | 'null'; parent: string | null; matrix: number[] }] =>
                [node.id, { type, parent: node.parent, matrix: posed?.get(node.id) ?? rest.get(node.id)!.toArray() }]);
    }) ?? [];
}

/** True when bound displays follow bones, so the preview must write every display rather than whole batches. */
export function hasRigSkin(root: Group): boolean {
    return !!(root.userData.rig as RigData | undefined)?.armatures.some(armature => Object.keys(armature.weights).length);
}

const position = (pose: AnimationPose, id: string | undefined, out = new Vector3()) => {
    const node = id ? pose.get(id) : undefined;
    return node && out.set(node.matrix[12], node.matrix[13], node.matrix[14]);
};

/** FABRIK as in Blockbench (fabrik.ts): lengths hold, the first joint stays, an optional pole picks the bend plane. */
export function fabrik(points: Vector3[], goal: Vector3, pole?: Vector3, passes = 100, reach = 1e-4): void {
    const lengths = points.slice(1).map((point, index) => point.distanceTo(points[index])), start = points[0].clone();
    const total = lengths.reduce((sum, length) => sum + length, 0), last = points.length - 1;
    const step = (from: Vector3, toward: Vector3, length: number) => {
        const direction = toward.clone().sub(from);
        return direction.lengthSq() > 1e-18 ? from.clone().addScaledVector(direction.normalize(), length) : toward;
    };
    if (start.distanceTo(goal) >= total) {
        for (let index = 0; index < last; index++) points[index + 1].copy(step(points[index], goal, lengths[index]));
        return;
    }
    const bend = () => {
        for (let index = 1; index < last; index++) {
            const axis = points[index + 1].clone().sub(points[index - 1]);
            if (axis.lengthSq() < 1e-18) continue;
            axis.normalize();
            const center = points[index - 1].clone().addScaledVector(axis, points[index].clone().sub(points[index - 1]).dot(axis));
            const joint = points[index].clone().sub(center), radius = joint.length();
            const toward = pole ? pole.clone().sub(center) : joint.clone();
            toward.addScaledVector(axis, -toward.dot(axis));
            // A straight chain has no bend direction; nudge it off the line so it can fold.
            if (toward.lengthSq() < 1e-18) toward.copy(Math.abs(axis.x) < .9 ? new Vector3(1, 0, 0) : new Vector3(0, 0, 1)).addScaledVector(axis, -(Math.abs(axis.x) < .9 ? axis.x : axis.z));
            points[index].copy(center).addScaledVector(toward.normalize(), Math.max(radius, 1e-3));
        }
    };
    if (pole) bend();
    else if (points.slice(1, last).every((point, index) => {
        const a = points[index], b = points[index + 2];
        return point.clone().sub(a).cross(b.clone().sub(a)).lengthSq() < 1e-18;
    })) bend();
    for (let pass = 0; pass < passes && points[last].distanceTo(goal) > reach; pass++) {
        points[last].copy(goal);
        for (let index = last - 1; index >= 0; index--) points[index].copy(step(points[index + 1], points[index], lengths[index]));
        points[0].copy(start);
        for (let index = 0; index < last; index++) points[index + 1].copy(step(points[index], points[index + 1], lengths[index]));
        if (pole) bend();
    }
}

function solveNullIk(pose: AnimationPose, children: Map<string, string[]>, point: RigNull): void {
    const chain: string[] = [];
    for (let id: string | null | undefined = point.ikTarget; id; id = pose.get(id)?.parent) {
        chain.unshift(id);
        if (id === point.ikSource) break;
    }
    const goal = position(pose, point.id);
    if (chain[0] !== point.ikSource || chain.length < 2 || !goal) return;
    const before = chain.map(id => position(pose, id)!), solved = before.map(entry => entry.clone());
    fabrik(solved, goal, position(pose, point.ikPole));
    // turns[i]: the world turn applied to chain[i] and everything under it.
    const turns: Matrix4[] = [];
    const turn = new Quaternion(), step = new Matrix4(), rotation = new Matrix4(), back = new Matrix4();
    for (let index = 0; index < chain.length; index++) {
        const above = turns[index - 1] ?? new Matrix4();
        if (index === chain.length - 1) { turns.push(above); break; }
        const joint = before[index].clone().applyMatrix4(above), next = before[index + 1].clone().applyMatrix4(above);
        turn.setFromUnitVectors(next.sub(joint).normalize(), solved[index + 1].clone().sub(solved[index]).normalize());
        step.makeTranslation(joint.x, joint.y, joint.z).multiply(rotation.makeRotationFromQuaternion(turn)).multiply(back.makeTranslation(-joint.x, -joint.y, -joint.z));
        turns.push(step.clone().multiply(above));
    }
    const move = (id: string, index: number): void => {
        const node = pose.get(id)!, at = chain.indexOf(id), value = turns[at < 0 ? index : at];
        pose.set(id, { ...node, matrix: new Matrix4().fromArray(node.matrix).premultiply(value).toArray() });
        for (const child of children.get(id) ?? []) move(child, at < 0 ? index : at);
    };
    move(chain[0], 0);
}

/** Null IK, then skinning, on an evaluated pose; bones/nulls posed by keys and IK move their bound displays. */
export function applyRigPose(pose: AnimationPose, rig: RigData | undefined): void {
    if (!rig?.armatures.length) return;
    for (const armature of rig.armatures) {
        if (armature.nulls.some(point => point.ikTarget && point.ikSource)) {
            const children = new Map<string, string[]>();
            for (const node of [...armature.bones, ...armature.nulls]) if (node.parent) {
                const list = children.get(node.parent);
                if (list) list.push(node.id); else children.set(node.parent, [node.id]);
            }
            for (const point of armature.nulls) if (point.ikTarget && point.ikSource) solveNullIk(pose, children, point);
        }
        const entries = Object.entries(armature.weights);
        if (!entries.length) continue;
        const rest = rigRestWorlds(armature), skins = new Map<string, number[] | null>();
        // A bone's skin matrix carries its rest pose to its current pose.
        const skin = (id: string) => {
            if (!skins.has(id)) {
                const node = pose.get(id), base = rest.get(id);
                skins.set(id, node && base && base.determinant() !== 0 ? new Matrix4().fromArray(node.matrix).multiply(base.clone().invert()).elements : null);
            }
            return skins.get(id)!;
        };
        const blend = new Array<number>(16);
        for (const [id, weights] of entries) {
            const node = pose.get(id);
            if (node?.type !== 'object') continue;
            blend.fill(0);
            let sum = 0;
            for (const [bone, weight] of Object.entries(weights)) {
                const value = weight > 0 ? skin(bone) : null;
                if (!value) continue;
                for (let index = 0; index < 16; index++) blend[index] += value[index] * weight;
                sum += weight;
            }
            if (!sum || blend.every((value, index) => Math.abs(value / sum - (index % 5 === 0 ? 1 : 0)) < 1e-12)) continue;
            pose.set(id, { ...node, matrix: new Matrix4().fromArray(blend.map(value => value / sum)).multiply(new Matrix4().fromArray(node.matrix)).toArray() });
        }
    }
}
