import { Color, InstancedBufferAttribute, Matrix4, type InstancedMesh } from 'three/webgpu';
import { planUvTransforms, relativeUvTransform, type UvTransform } from './geometry-batching';
import type { GeometryInstanceMeta, GeometryMeta } from '../pbde/pbde-types';

type AtlasPart = Pick<GeometryMeta, 'texPath' | 'uvTransform' | 'tintHex' | 'modelMatrix'>;
export type AtlasBatchState = {
    parts: AtlasPart[];
    uvPlan: ReturnType<typeof planUvTransforms>;
    tintParts: number[];
};

export function atlasBatchSignature(shapeKey: string, parts: AtlasPart[]): string {
    // The page and transparency class must agree. Atlas regions, model names,
    // tint colors, and transient buffer IDs are instance data, not batch keys.
    return `${shapeKey}|pages:${parts.map(part => part.texPath).join('|')}`;
}

export function getTintParts(parts: AtlasPart[], instances: GeometryInstanceMeta[]): number[] {
    return parts.flatMap((part, index) => instances.some(instance =>
        instance.partTints?.[index] !== undefined && instance.partTints[index] !== (part.tintHex ?? 0xffffff)
    ) ? [index] : []);
}

export function setAtlasBatchState(mesh: InstancedMesh, parts: AtlasPart[], uvPlan: AtlasBatchState['uvPlan'], tintParts: number[]): void {
    const atlasBatch = {
        parts: parts.map(part => ({ texPath: part.texPath, uvTransform: part.uvTransform?.slice(), tintHex: part.tintHex, modelMatrix: part.modelMatrix.slice() })),
        uvPlan: { slots: [...uvPlan.slots], sourceParts: [...uvPlan.sourceParts] },
        tintParts: [...tintParts]
    };
    // BufferGeometry.clone shares userData; replace it instead of mutating it so
    // duplicates and geometry undo snapshots keep their original UV layout.
    mesh.geometry.userData = { ...mesh.geometry.userData, atlasBatch };
}

export function rebaseAtlasInstances(source: AtlasPart[], target: AtlasPart[], instances: GeometryInstanceMeta[]): GeometryInstanceMeta[] {
    const correction = new Matrix4().fromArray(source[0].modelMatrix)
        .multiply(new Matrix4().fromArray(target[0].modelMatrix).invert());
    return instances.map(instance => ({
        ...instance,
        transform: new Matrix4().fromArray(instance.transform).transpose().multiply(correction).transpose().toArray(),
        modelTransform: new Matrix4().fromArray(instance.modelTransform ?? new Matrix4().elements).multiply(correction).toArray(),
        atlasUvTransforms: source.map((part, index) => instance.atlasUvTransforms?.[index] ?? instance.atlasUvTransform ?? part.uvTransform!),
        partTints: source.map((part, index) => instance.partTints?.[index] ?? part.tintHex ?? 0xffffff)
    }));
}

export function planAtlasAppend(mesh: InstancedMesh, source: AtlasPart[], incoming: GeometryInstanceMeta[]) {
    const state = mesh.geometry.userData.atlasBatch as AtlasBatchState;
    const existing: GeometryInstanceMeta[] = [];
    const color = new Color();
    for (let index = 0; index < mesh.count; index++) {
        const atlasUvTransforms = state.parts.map((part, partIndex): UvTransform => {
            const base = part.uvTransform!;
            const slot = state.uvPlan.slots[partIndex];
            if (slot < 0) return base;
            const name = state.uvPlan.sourceParts.length === 1 ? 'instancedUvTransform' : `instancedUvTransform${slot}`;
            const attribute = mesh.geometry.getAttribute(name);
            return [base[0] * attribute.getX(index), base[1] * attribute.getY(index),
                base[2] * attribute.getX(index) + attribute.getZ(index), base[3] * attribute.getY(index) + attribute.getW(index)];
        });
        const partTints = state.parts.map((part, partIndex) => {
            if (!state.tintParts.includes(partIndex)) return part.tintHex ?? 0xffffff;
            const attribute = mesh.geometry.getAttribute(`instancedTint${partIndex}`);
            return color.setRGB(attribute.getX(index), attribute.getY(index), attribute.getZ(index)).getHex();
        });
        existing.push({ transform: [], uuid: '', groupId: null, atlasUvTransforms, partTints });
    }
    const instances = rebaseAtlasInstances(source, state.parts, incoming);
    const allInstances = [...existing, ...instances];
    return { parts: state.parts, instances, allInstances, uvPlan: planUvTransforms(state.parts, allInstances), tintParts: getTintParts(state.parts, allInstances) };
}

export function applyAtlasAppend(mesh: InstancedMesh, plan: ReturnType<typeof planAtlasAppend>) {
    const oldGeometry = mesh.geometry;
    const geometry = oldGeometry.clone();
    const capacity = mesh.instanceMatrix.count;
    for (const name of Object.keys(geometry.attributes)) {
        if (/^instanced(?:UvTransform\d*|Tint\d+)$/.test(name)) geometry.deleteAttribute(name);
    }
    for (const [slot, partIndex] of plan.uvPlan.sourceParts.entries()) {
        const values = new Float32Array(capacity * 4);
        for (let index = 0; index < capacity; index++) {
            values.set(relativeUvTransform(plan.parts[partIndex].uvTransform, plan.allInstances[index]?.atlasUvTransforms?.[partIndex]), index * 4);
        }
        const name = plan.uvPlan.sourceParts.length === 1 ? 'instancedUvTransform' : `instancedUvTransform${slot}`;
        geometry.setAttribute(name, new InstancedBufferAttribute(values, 4));
    }
    const color = new Color();
    for (const partIndex of plan.tintParts) {
        const values = new Float32Array(capacity * 3);
        for (let index = 0; index < capacity; index++) {
            color.setHex(plan.allInstances[index]?.partTints?.[partIndex] ?? plan.parts[partIndex].tintHex ?? 0xffffff).toArray(values, index * 3);
        }
        geometry.setAttribute(`instancedTint${partIndex}`, new InstancedBufferAttribute(values, 3));
    }
    mesh.geometry = geometry;
    setAtlasBatchState(mesh, plan.parts, plan.uvPlan, plan.tintParts);
    return oldGeometry;
}
