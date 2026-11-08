import { Matrix4, type Group } from 'three/webgpu';

// New mirror pairs reflect across world X=0. A pair's plane moves only when both sides get the same transform.
export const worldXReflection = new Matrix4().makeScale(-1, 1, 1);

const pairKey = (a: string, b: string): string => a < b ? `${a}|${b}` : `${b}|${a}`;

function storedPlanes(root: Group): Map<string, Matrix4> {
    return root.userData.mirrorPlanes ??= new Map<string, Matrix4>();
}

/** The reflection mapping one side of the pair onto the other (it is its own inverse). */
export function getMirrorPlane(root: Group, a: string, b: string | undefined): Matrix4 {
    return (b && (root.userData.mirrorPlanes as Map<string, Matrix4> | undefined)?.get(pairKey(a, b))) || worldXReflection;
}

/** Undefined resets the pair to the world X=0 plane. */
export function setMirrorPlane(root: Group, a: string, b: string, plane: Matrix4 | undefined): void {
    if (plane && !plane.equals(worldXReflection)) storedPlanes(root).set(pairKey(a, b), plane.clone());
    else (root.userData.mirrorPlanes as Map<string, Matrix4> | undefined)?.delete(pairKey(a, b));
}

export function copyMirrorPlane(root: Group, fromA: string, fromB: string, toA: string, toB: string): void {
    setMirrorPlane(root, toA, toB, getMirrorPlane(root, fromA, fromB));
}

/** Pairs whose two sides both moved by `delta` keep their mirror relation, so their plane moves with them. */
export function transformJointMirrorPlanes(
    root: Group,
    delta: Matrix4,
    objectMoved: (uuid: string) => boolean,
    groupMoved: (id: string) => boolean
): void {
    let inverse: Matrix4 | undefined;
    for (const [key, moved] of [['objectMirrorPairs', objectMoved], ['groupMirrorPairs', groupMoved]] as const) {
        (root.userData[key] as Map<string, string> | undefined)?.forEach((b, a) => {
            if (a > b || !moved(a) || !moved(b)) return;
            inverse ??= delta.clone().invert();
            setMirrorPlane(root, a, b, delta.clone().multiply(getMirrorPlane(root, a, b)).multiply(inverse));
        });
    }
}
