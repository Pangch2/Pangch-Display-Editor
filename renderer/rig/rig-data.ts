import { Euler, Matrix4, Vector3, type Group } from 'three/webgpu';
import { getInstanceLocalBox, getInstanceWorldMatrix, objectRef } from '../scene-store/object-access';

export type Vec3 = [number, number, number];
/**
 * A Blockbench armature bone. `origin` is where it turns, given like Blockbench in its parent's unrotated frame (its offset from the
 * parent's origin turns with the parent); `rotation` (degrees, ZYX like Blockbench) turns its own frame, and the bone points along its +Y.
 */
export type RigBone = { id: string; name: string; parent: string | null; origin: Vec3; rotation: Vec3; length: number; width: number; color: number };
/** A Blockbench null object: never exported; with ikTarget (chain end bone) and ikSource (chain start bone) the chain reaches for it. */
export type RigNull = { id: string; name: string; parent: string | null; position: Vec3; ikTarget?: string; ikSource?: string; ikPole?: string };
/** weights: display uuid → bone id → weight. A display is one skinned "vertex": it follows the weighted blend of its bones' moves. */
export type RigArmature = { id: string; name: string; bones: RigBone[]; nulls: RigNull[]; weights: Record<string, Record<string, number>> };
export type RigData = { armatures: RigArmature[] };

export const rigBoneColors = [0x6cb8ff, 0xffd34d, 0xff8a3d, 0x7ed957, 0xc58cff, 0xff7eb6, 0x4de0d0, 0xe0e0e0];
const degrees = Math.PI / 180;

export function rigData(root: Group): RigData { return root.userData.rig ??= { armatures: [] }; }
export function captureRig(root: Group): RigData { return structuredClone(rigData(root)); }
export function restoreRig(root: Group, rig: RigData): void { root.userData.rig = structuredClone(rig); }

export function findRigNode(root: Group, id: string): { armature: RigArmature; bone?: RigBone; null?: RigNull } | undefined {
    for (const armature of rigData(root).armatures) {
        if (armature.id === id) return { armature };
        const bone = armature.bones.find(entry => entry.id === id);
        if (bone) return { armature, bone };
        const point = armature.nulls.find(entry => entry.id === id);
        if (point) return { armature, null: point };
    }
    return undefined;
}

/** Bone and null ids; these are animation targets next to groups and objects. */
export function rigNodeIds(root: Group): Set<string> {
    return new Set((root.userData.rig as RigData | undefined)?.armatures.flatMap(armature => [...armature.bones, ...armature.nulls].map(node => node.id)) ?? []);
}

export function rigRestLocal(armature: RigArmature, node: RigBone | RigNull): Matrix4 {
    const base = node.parent ? armature.bones.find(bone => bone.id === node.parent)?.origin ?? [0, 0, 0] : [0, 0, 0];
    const at = 'origin' in node ? node.origin : node.position;
    const value = new Matrix4().makeTranslation(at[0] - base[0], at[1] - base[1], at[2] - base[2]);
    if ('rotation' in node) value.multiply(new Matrix4().makeRotationFromEuler(new Euler(node.rotation[0] * degrees, node.rotation[1] * degrees, node.rotation[2] * degrees, 'ZYX')));
    return value;
}

/** Rest (bind) pose of every bone and null in root space. A parent cycle is cut where it closes. */
export function rigRestWorlds(armature: RigArmature): Map<string, Matrix4> {
    const nodes = new Map<string, RigBone | RigNull>([...armature.bones, ...armature.nulls].map(node => [node.id, node]));
    const worlds = new Map<string, Matrix4>(), visiting = new Set<string>();
    const visit = (id: string): Matrix4 => {
        const known = worlds.get(id);
        if (known) return known;
        const node = nodes.get(id)!;
        visiting.add(id);
        const parent = node.parent && nodes.has(node.parent) && !visiting.has(node.parent) ? visit(node.parent) : undefined;
        const world = parent ? parent.clone().multiply(rigRestLocal(armature, node)) : rigRestLocal(armature, node);
        visiting.delete(id);
        worlds.set(id, world);
        return world;
    };
    nodes.forEach((_, id) => visit(id));
    return worlds;
}

/** Writes a root-space rest pose back as Blockbench origin/rotation; descendants keep their offsets, so they move along. */
export function setRigRestWorld(armature: RigArmature, id: string, world: Matrix4): void {
    const node = armature.bones.find(bone => bone.id === id) ?? armature.nulls.find(point => point.id === id);
    if (!node) return;
    const parentWorld = node.parent ? rigRestWorlds(armature).get(node.parent) : undefined;
    const local = parentWorld ? parentWorld.clone().invert().multiply(world) : world.clone();
    const base = node.parent ? armature.bones.find(bone => bone.id === node.parent)?.origin ?? [0, 0, 0] : [0, 0, 0];
    const position = new Vector3().setFromMatrixPosition(local).add(new Vector3(...base));
    const before = 'origin' in node ? node.origin : node.position;
    const delta = position.clone().sub(new Vector3(...before));
    if ('origin' in node) {
        node.origin = position.toArray() as Vec3;
        const turn = new Euler().setFromRotationMatrix(new Matrix4().extractRotation(local), 'ZYX');
        node.rotation = [turn.x / degrees, turn.y / degrees, turn.z / degrees];
    } else node.position = position.toArray() as Vec3;
    if (!delta.lengthSq()) return;
    for (const child of rigDescendants(armature, id)) {
        const value = 'origin' in child ? child.origin : child.position;
        for (let axis = 0; axis < 3; axis++) value[axis] += delta.getComponent(axis);
    }
}

export function rigDescendants(armature: RigArmature, id: string): (RigBone | RigNull)[] {
    const result: (RigBone | RigNull)[] = [], queue = [id];
    while (queue.length) {
        const parent = queue.shift()!;
        for (const node of [...armature.bones, ...armature.nulls]) if (node.parent === parent && !result.includes(node)) { result.push(node); queue.push(node.id); }
    }
    return result;
}

function uniqueName(names: string[], base: string): string {
    if (!names.includes(base)) return base;
    let index = 2;
    while (names.includes(`${base}${index}`)) index++;
    return `${base}${index}`;
}

function tip(bone: RigBone | undefined): Vec3 {
    return bone ? [bone.origin[0], bone.origin[1] + bone.length, bone.origin[2]] : [0, 0, 0];
}

export function addRigArmature(root: Group): RigArmature {
    const rig = rigData(root);
    const armature: RigArmature = { id: crypto.randomUUID(), name: uniqueName(rig.armatures.map(entry => entry.name), 'armature'), bones: [], nulls: [], weights: {} };
    rig.armatures.push(armature);
    addRigBone(root, armature.id, null);
    return armature;
}

/** Like Blockbench, a new child bone starts at its parent's tip. */
export function addRigBone(root: Group, armatureId: string, parent: string | null): RigBone {
    const armature = rigData(root).armatures.find(entry => entry.id === armatureId);
    if (!armature) throw new Error('아마추어를 먼저 선택해 주세요.');
    const parentBone = parent ? armature.bones.find(bone => bone.id === parent) : undefined;
    const bone: RigBone = { id: crypto.randomUUID(), name: uniqueName(armature.bones.map(entry => entry.name), 'bone'), parent: parentBone?.id ?? null,
        origin: tip(parentBone), rotation: [0, 0, 0], length: 0.5, width: 0.125, color: armature.bones.length % rigBoneColors.length };
    armature.bones.push(bone);
    return bone;
}

export function addRigNull(root: Group, armatureId: string, parent: string | null): RigNull {
    const armature = rigData(root).armatures.find(entry => entry.id === armatureId);
    if (!armature) throw new Error('아마추어를 먼저 선택해 주세요.');
    const parentBone = parent ? armature.bones.find(bone => bone.id === parent) : undefined;
    const point: RigNull = { id: crypto.randomUUID(), name: uniqueName(armature.nulls.map(entry => entry.name), 'null'), parent: parentBone?.id ?? null, position: tip(parentBone) };
    armature.nulls.push(point);
    return point;
}

export function removeRigNode(root: Group, id: string): void {
    const rig = rigData(root), found = findRigNode(root, id);
    if (!found) return;
    const { armature } = found;
    if (!found.bone && !found.null) { rig.armatures = rig.armatures.filter(entry => entry !== armature); return; }
    const removed = new Set([id, ...rigDescendants(armature, id).map(node => node.id)]);
    armature.bones = armature.bones.filter(bone => !removed.has(bone.id));
    armature.nulls = armature.nulls.filter(point => !removed.has(point.id));
    for (const weights of Object.values(armature.weights)) for (const bone of removed) delete weights[bone];
    for (const point of armature.nulls) for (const key of ['ikTarget', 'ikSource', 'ikPole'] as const) if (point[key] && removed.has(point[key]!)) delete point[key];
}

/** Clipped nodes: copies of some nodes with everything under them, and each top node's rest pose, so a paste lands where they were. */
export type RigClip = { nodes: (RigBone | RigNull)[]; worlds: Record<string, number[]> };

export function copyRigNodes(armature: RigArmature, ids: Iterable<string>): RigClip {
    const clipped = new Set<string>();
    for (const id of ids) if ([...armature.bones, ...armature.nulls].some(node => node.id === id)) {
        clipped.add(id);
        for (const child of rigDescendants(armature, id)) clipped.add(child.id);
    }
    const rest = rigRestWorlds(armature), nodes = [...armature.bones, ...armature.nulls].filter(node => clipped.has(node.id)).map(node => structuredClone(node));
    return { nodes, worlds: Object.fromEntries(nodes.filter(node => !node.parent || !clipped.has(node.parent)).map(node => [node.id, rest.get(node.id)!.toArray()])) };
}

/**
 * Adds the clip with new ids and unique names, as Blockbench pastes and duplicates. Top nodes go under `parent` (undefined keeps
 * each one's own parent) at their copied rest pose; IK links inside the clip point at the copies. Returns the new top ids.
 */
export function pasteRigNodes(armature: RigArmature, clip: RigClip, parent?: string | null): string[] {
    const ids = new Map(clip.nodes.map(node => [node.id, crypto.randomUUID()]));
    const names = [...armature.bones, ...armature.nulls].map(node => node.name), existing = new Set([...armature.bones, ...armature.nulls].map(node => node.id));
    for (const node of clip.nodes) {
        const copy = structuredClone(node), top = node.id in clip.worlds;
        copy.id = ids.get(node.id)!;
        copy.name = uniqueName(names, node.name.replace(/\d+$/, '') || node.name);
        names.push(copy.name);
        copy.parent = top ? (parent === undefined ? node.parent : parent) : ids.get(node.parent!)!;
        if (top && copy.parent && !armature.bones.some(bone => bone.id === copy.parent)) copy.parent = null;
        if ('origin' in copy) { armature.bones.push(copy); continue; }
        for (const key of ['ikTarget', 'ikSource', 'ikPole'] as const) {
            const link = copy[key];
            if (link && ids.has(link)) copy[key] = ids.get(link);
            else if (link && !existing.has(link)) delete copy[key];
        }
        armature.nulls.push(copy);
    }
    return Object.entries(clip.worlds).map(([id, world]) => {
        setRigRestWorld(armature, ids.get(id)!, new Matrix4().fromArray(world));
        return ids.get(id)!;
    });
}

/** Moves a bone or null under another bone of its armature (null: to the top), keeping where it and everything under it are. */
export function reparentRigNode(armature: RigArmature, id: string, parent: string | null): void {
    const node = armature.bones.find(bone => bone.id === id) ?? armature.nulls.find(point => point.id === id);
    if (!node) throw new Error('옮길 본을 찾을 수 없습니다.');
    if (parent !== null && (!armature.bones.some(bone => bone.id === parent) || parent === id || rigDescendants(armature, id).some(child => child.id === parent))) {
        throw new Error('본은 같은 아마추어의 다른 본 아래로만 옮길 수 있고, 자기 자신이나 자식 아래로는 옮길 수 없습니다.');
    }
    if (node.parent === parent) return;
    const world = rigRestWorlds(armature).get(id)!;
    node.parent = parent;
    setRigRestWorld(armature, id, world);
}

function objectCenter(root: Group, id: string): Vector3 | undefined {
    const ref = objectRef(root, id);
    if (!ref) return undefined;
    ref.mesh.updateWorldMatrix(true, false);
    const world = getInstanceWorldMatrix(ref.mesh, ref.instanceId, new Matrix4());
    root.updateWorldMatrix(true, false);
    return (getInstanceLocalBox(ref.mesh, ref.instanceId)?.getCenter(new Vector3()) ?? new Vector3()).applyMatrix4(world).applyMatrix4(root.matrixWorld.clone().invert());
}

/** Distance from a point to each bone's rest segment (origin to tip). */
export function nearestRigBone(armature: RigArmature, point: Vector3, worlds = rigRestWorlds(armature)): RigBone | undefined {
    let best: RigBone | undefined, distance = Infinity;
    const start = new Vector3(), end = new Vector3(), closest = new Vector3();
    for (const bone of armature.bones) {
        const world = worlds.get(bone.id)!;
        start.setFromMatrixPosition(world);
        end.set(0, bone.length, 0).applyMatrix4(world);
        const segment = end.clone().sub(start), amount = segment.lengthSq() ? Math.min(1, Math.max(0, point.clone().sub(start).dot(segment) / segment.lengthSq())) : 0;
        const value = closest.copy(start).addScaledVector(segment, amount).distanceTo(point);
        if (value < distance) { distance = value; best = bone; }
    }
    return best;
}

/** Binds displays to one armature (leaving any other) with automatic weights: the nearest bone gets all of it, as Blockbench does when a vertex sits inside one bone. */
export function bindRigObjects(root: Group, armatureId: string, ids: Iterable<string>): number {
    const rig = rigData(root), armature = rig.armatures.find(entry => entry.id === armatureId);
    if (!armature?.bones.length) throw new Error('본이 있는 아마추어를 선택해 주세요.');
    const worlds = rigRestWorlds(armature);
    let count = 0;
    for (const id of ids) {
        const center = objectCenter(root, id), bone = center && nearestRigBone(armature, center, worlds);
        if (!bone) continue;
        for (const other of rig.armatures) delete other.weights[id];
        armature.weights[id] = { [bone.id]: 1 };
        count++;
    }
    return count;
}

export function unbindRigObjects(root: Group, ids: Iterable<string>): void {
    for (const id of ids) for (const armature of rigData(root).armatures) delete armature.weights[id];
}

/** Sets one bone's weight on bound displays (0 removes it); like Blockbench, weights are normalized only when they are used. */
export function setRigWeight(root: Group, boneId: string, ids: Iterable<string>, weight: number): number {
    const found = findRigNode(root, boneId);
    if (!found?.bone) throw new Error('가중치를 줄 본을 선택해 주세요.');
    if (!Number.isFinite(weight) || weight < 0 || weight > 1) throw new Error('가중치는 0~1 사이여야 합니다.');
    let count = 0;
    for (const id of ids) {
        const weights = found.armature.weights[id];
        if (!weights) continue;
        if (weight > 0) weights[boneId] = weight; else delete weights[boneId];
        count++;
    }
    return count;
}

const vector = (value: unknown): value is Vec3 => Array.isArray(value) && value.length === 3 && value.every(entry => typeof entry === 'number' && Number.isFinite(entry));
const text = (value: unknown, limit = 120): value is string => typeof value === 'string' && value.length > 0 && value.length <= limit;

/** Validates a saved rig; drops weights of displays that are not in the project. */
export function validateRig(value: any, objects: Set<string>): asserts value is RigData {
    if (!value || typeof value !== 'object' || !Array.isArray(value.armatures)) throw new Error('잘못된 본 데이터입니다.');
    const ids = new Set<string>();
    const unique = (id: unknown) => { if (!text(id, 128) || ids.has(id)) throw new Error('잘못된 본 ID입니다.'); ids.add(id); };
    for (const armature of value.armatures) {
        if (!armature || !Array.isArray(armature.bones) || !Array.isArray(armature.nulls) || !armature.weights || typeof armature.weights !== 'object' || Array.isArray(armature.weights)
            || !text(armature.name)) throw new Error('잘못된 아마추어입니다.');
        unique(armature.id);
        const bones = new Set<string>(), nulls = new Set<string>();
        for (const bone of armature.bones) {
            if (!bone || !text(bone.name) || !vector(bone.origin) || !vector(bone.rotation) || !(bone.length >= 0 && bone.length < 1e6) || !(bone.width >= 0 && bone.width < 1e6)
                || !Number.isSafeInteger(bone.color)) throw new Error('잘못된 본입니다.');
            unique(bone.id); bones.add(bone.id);
        }
        for (const point of armature.nulls) {
            if (!point || !text(point.name) || !vector(point.position)) throw new Error('잘못된 Null 오브젝트입니다.');
            unique(point.id); nulls.add(point.id);
        }
        const parents = new Map<string, string | null>(armature.bones.map((bone: RigBone) => [bone.id, bone.parent]));
        for (const node of [...armature.bones, ...armature.nulls]) {
            if (node.parent !== null && !bones.has(node.parent)) throw new Error('잘못된 본 부모입니다.');
            const seen = new Set<string>();
            for (let id: string | null | undefined = node.parent; id; id = parents.get(id)) {
                if (seen.has(id) || id === node.id) throw new Error('본 계층이 순환합니다.');
                seen.add(id);
            }
        }
        for (const point of armature.nulls) if (point.ikTarget !== undefined && !bones.has(point.ikTarget) || point.ikSource !== undefined && !bones.has(point.ikSource)
            || point.ikPole !== undefined && !nulls.has(point.ikPole)) throw new Error('잘못된 IK 설정입니다.');
        for (const [id, weights] of Object.entries(armature.weights as Record<string, unknown>)) {
            if (!objects.has(id)) { delete armature.weights[id]; continue; }
            if (!weights || typeof weights !== 'object' || Object.entries(weights).some(([bone, weight]) => !bones.has(bone) || typeof weight !== 'number' || !(weight >= 0 && weight <= 1))) {
                throw new Error('잘못된 본 가중치입니다.');
            }
        }
    }
}
