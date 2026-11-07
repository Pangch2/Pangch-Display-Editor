import { NodeMaterial } from 'three/webgpu';
import type { BufferAttribute } from 'three/webgpu';
import { Fn, attribute, instanceColor, instanceIndex, mat4, normalLocal, positionLocal, storage, subBuild, transformNormal, uniform, vec2, vec3, vec4 } from 'three/tsl';

/** What a batch proxy exposes to its shaders (`proxy.pdeLayout`, see draw-pool.ts). */
export type PooledLayout = {
    rows: BufferAttribute;
    visibleIds: BufferAttribute;
    slotMember: BufferAttribute;
    memberWorld: BufferAttribute;
    rowStride: number;
    /** Row offset of each instanced attribute. */
    offsets: Map<string, number>;
};
type PooledKey = 'rows' | 'visibleIds' | 'slotMember' | 'memberWorld';
type Builder = { object?: { pdeLayout?: PooledLayout }; hasGeometryAttribute(name: string): boolean };

export const isPooledBuild = (builder: Builder): boolean => builder.object?.pdeLayout !== undefined;

const buildStorage = new WeakMap<object, Map<PooledKey, unknown>>();

// One node per pool buffer and build. Bound per drawn proxy (pools grow, layouts differ), like three's
// referenceAttribute, so proxies with the same material and vertex attributes share programs.
function layoutStorage(builder: Builder, key: PooledKey, type: string) {
    let nodes = buildStorage.get(builder);
    if (!nodes) buildStorage.set(builder, nodes = new Map());
    let node = nodes.get(key);
    if (!node) nodes.set(key, node = storage(builder.object!.pdeLayout![key], type).toReadOnly()
        .onObjectUpdate(({ object }) => object.pdeLayout[key]));
    return node as ReturnType<typeof storage>;
}

const rowStride = uniform(0, 'uint').onObjectUpdate(({ object }) => object.pdeLayout?.rowStride ?? 0);
const rowOffsets = new Map<string, ReturnType<typeof uniform>>();
const rowOffset = (name: string) => {
    let node = rowOffsets.get(name);
    if (!node) rowOffsets.set(name, node = uniform(0, 'uint').onObjectUpdate(({ object }) => object.pdeLayout?.offsets.get(name) ?? 0));
    return node;
};

/** The pool slot a pooled draw shows: `visibleIds[instance_index]`, where instance_index includes firstInstance. */
const drawSlot = Fn((builder) => layoutStorage(builder, 'visibleIds', 'uint').element(instanceIndex)).once()();
const rowBase = Fn(() => drawSlot.mul(rowStride)).once()();

const typeSizes = { float: 1, vec2: 2, vec3: 3, vec4: 4 } as const;

function readRow(builder: Builder, offset, size: number) {
    const rows = layoutStorage(builder, 'rows', 'float');
    const parts = Array.from({ length: size }, (_, component) => rows.element(rowBase.add(offset).add(component)));
    return size === 1 ? parts[0] : size === 2 ? vec2(...parts) : size === 3 ? vec3(...parts) : vec4(...parts);
}

/** Per-instance attribute read that follows pooled draws; plain `attribute()` everywhere else. Vertex stage only. */
export const instanceAttribute = (name: string, type: keyof typeof typeSizes) => Fn((builder) => isPooledBuild(builder)
    ? readRow(builder, rowOffset(name), typeSizes[type])
    : attribute(name, type))();

let pooledInstancingInstalled = false;

export function installPooledInstancing(): void {
    if (pooledInstancingInstalled) return;
    pooledInstancingInstalled = true;
    const setupPosition = NodeMaterial.prototype.setupPosition;
    NodeMaterial.prototype.setupPosition = function (builder) {
        if (!isPooledBuild(builder)) return setupPosition.call(this, builder);
        // Mirrors three's instancing (Instance.js) with the pooled row and the member's world matrix.
        const rows = layoutStorage(builder, 'rows', 'float');
        const column = (index: number) => vec4(...[0, 1, 2, 3].map(row => rows.element(rowBase.add(index * 4 + row))));
        const member = layoutStorage(builder, 'slotMember', 'uint').element(drawSlot);
        const matrix = layoutStorage(builder, 'memberWorld', 'mat4').element(member)
            .mul(mat4(column(0), column(1), column(2), column(3))).toVar();
        positionLocal.assign(matrix.mul(positionLocal).xyz);
        if (builder.hasGeometryAttribute('normal')) normalLocal.assign(transformNormal(normalLocal, matrix));
        // Rows always hold a color (white when the mesh has none); proxies set `instanceColor` so three applies it.
        instanceColor.assign(readRow(builder, 16, 3));
        if (this.positionNode !== null) positionLocal.assign(subBuild(this.positionNode, 'POSITION', 'vec3'));
        return positionLocal;
    };
}
