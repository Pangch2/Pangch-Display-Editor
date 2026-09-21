import { Matrix4 } from 'three/webgpu';

export type UvTransform = [number, number, number, number];

export function relativeUvTransform(base?: UvTransform, current?: UvTransform): UvTransform {
    if (!base || !current) return [1, 1, 0, 0];
    const x = base[0] !== 0 ? current[0] / base[0] : 1;
    const y = base[1] !== 0 ? current[1] / base[1] : 1;
    return [x, y, current[2] - base[2] * x, current[3] - base[3] * y];
}

// Parts with the same relative UV change share one attribute, regardless of
// their absolute atlas rectangles. Unchanged parts need no attribute.
export function planUvTransforms(
    parts: { uvTransform?: UvTransform }[],
    instances: { atlasUvTransform?: UvTransform; atlasUvTransforms?: UvTransform[] }[]
): { slots: number[]; sourceParts: number[] } {
    const keys = new Map<string, number>();
    const sourceParts: number[] = [];
    const slots = parts.map((part, partIndex) => {
        const transforms = instances.map(instance => relativeUvTransform(
            part.uvTransform, instance.atlasUvTransforms?.[partIndex] ?? instance.atlasUvTransform
        ));
        if (transforms.every(t => t[0] === 1 && t[1] === 1 && t[2] === 0 && t[3] === 0)) return -1;
        const key = transforms.map(t => t.join(',')).join(';');
        let slot = keys.get(key);
        if (slot === undefined) {
            slot = sourceParts.length;
            keys.set(key, slot);
            sourceParts.push(partIndex);
        }
        return slot;
    });
    return { slots, sourceParts };
}

// Scene matrices are row-major; model matrices are Three.js column-major.
// W * (M * inverse(B)) * B preserves the original W * M vertex positions.
export function relativeModelTransform(model: ArrayLike<number>, base: ArrayLike<number>): number[] | undefined {
    if (Array.from(model).every((value, index) => value === base[index])) return undefined;
    const baseMatrix = new Matrix4().fromArray(base);
    if (baseMatrix.determinant() === 0) throw new Error('Cannot batch a singular model matrix.');
    return new Matrix4().fromArray(model).multiply(baseMatrix.invert()).toArray();
}

export function applyModelTransform(transform: number[] | Float32Array, relative?: number[]): number[] | Float32Array {
    if (!relative) return transform;
    const matrix = new Matrix4().fromArray(transform).transpose();
    matrix.multiply(new Matrix4().fromArray(relative));
    return matrix.transpose().toArray();
}
