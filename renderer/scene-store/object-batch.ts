import { Box3, BufferGeometry, InstancedBufferAttribute, Matrix4, MeshBasicMaterial, Object3D, Sphere, type Color, type Material } from 'three/webgpu';
import { entityVisibleAttributeName, setEntityStateAttributes } from '../entity-material';
import { releaseBatchRows, type RowRange } from './row-store';

type InstanceArray = { array: ArrayLike<number> & { [index: number]: number }; offset?: number; data?: { array: Float32Array; stride: number }; itemSize: number };

/** Where an object's values start in the array behind a per-instance attribute (plain or a pool row view). */
export function rowOf(attribute: InstanceArray, instanceId: number): number {
    return attribute.data ? instanceId * attribute.data.stride + attribute.offset! : instanceId * attribute.itemSize;
}

const identity = new Matrix4();
const localMatrix = new Matrix4();
const box = new Box3();
const sphere = new Sphere();

// three/webgpu is untyped here, so the inherited Object3D members (parent, matrixWorld, userData, ...) read as any.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface ObjectBatch { [member: string]: any }

/**
 * A project's content batch: objects sharing one shape (geometry) and material list. Not a Mesh: three never
 * draws it, the draw pool does (PdeDrawingPipeline.project). Once sealed (row-store.ts, on its first draw),
 * instanceMatrix, instanceColor and the instanced geometry attributes are views of its rows; the accessors read both.
 */
export class ObjectBatch extends Object3D {
    readonly isObjectBatch = true;
    geometry: BufferGeometry;
    material: Material | Material[];
    instanceMatrix: InstancedBufferAttribute;
    instanceColor: InstancedBufferAttribute | null = null;
    count: number;
    boundingBox: Box3 | null = null;
    boundingSphere: Sphere | null = null;
    /** Bumped by every matrix write; a row view shares its buffer version with every other value. */
    matrixWrites = 0;
    /** Its slots in the row store once sealed. */
    rowRange: RowRange | null = null;
    /** Set by dispose(): its values are gone, so it is never drawn again. */
    disposed = false;

    constructor(geometry: BufferGeometry = new BufferGeometry(), material: Material | Material[] = new MeshBasicMaterial(), count = 1) {
        super();
        this.type = 'ObjectBatch';
        this.geometry = geometry;
        this.material = material;
        this.instanceMatrix = new InstancedBufferAttribute(new Float32Array(count * 16), 16);
        this.count = count;
        for (let index = 0; index < count; index++) this.setMatrixAt(index, identity);
        // The pool culls hidden objects by this value, so every batch carries it.
        if (!geometry.getAttribute(entityVisibleAttributeName)) setEntityStateAttributes(geometry, count);
    }

    getMatrixAt(index: number, matrix: Matrix4): Matrix4 {
        return matrix.fromArray(this.instanceMatrix.array, rowOf(this.instanceMatrix as unknown as InstanceArray, index));
    }

    setMatrixAt(index: number, matrix: Matrix4): this {
        matrix.toArray(this.instanceMatrix.array, rowOf(this.instanceMatrix as unknown as InstanceArray, index));
        this.matrixWrites++;
        return this;
    }

    getColorAt(index: number, color: Color): Color {
        if (!this.instanceColor) return color.setRGB(1, 1, 1);
        return color.fromArray(this.instanceColor.array, rowOf(this.instanceColor as unknown as InstanceArray, index));
    }

    setColorAt(index: number, color: Color): this {
        this.instanceColor ??= new InstancedBufferAttribute(new Float32Array(this.instanceMatrix.count * 3).fill(1), 3);
        color.toArray(this.instanceColor.array, rowOf(this.instanceColor as unknown as InstanceArray, index));
        return this;
    }

    computeBoundingBox(): void {
        const { geometry } = this;
        this.boundingBox ??= new Box3();
        if (!geometry.boundingBox) geometry.computeBoundingBox();
        this.boundingBox.makeEmpty();
        for (let index = 0; index < this.count; index++) this.boundingBox.union(box.copy(geometry.boundingBox!).applyMatrix4(this.getMatrixAt(index, localMatrix)));
    }

    computeBoundingSphere(): void {
        const { geometry } = this;
        this.boundingSphere ??= new Sphere();
        if (!geometry.boundingSphere) geometry.computeBoundingSphere();
        this.boundingSphere.makeEmpty();
        for (let index = 0; index < this.count; index++) this.boundingSphere.union(sphere.copy(geometry.boundingSphere!).applyMatrix4(this.getMatrixAt(index, localMatrix)));
    }

    /** Frees the batch's rows (the geometry and materials belong to the caller). */
    dispose(): void {
        this.disposed = true;
        releaseBatchRows(this);
    }
}

if (import.meta.env.DEV) {
    const batch = new ObjectBatch(undefined, undefined, 2);
    batch.setMatrixAt(1, new Matrix4().makeTranslation(1, 2, 3));
    console.assert(batch.getMatrixAt(1, new Matrix4()).elements[13] === 2 && batch.matrixWrites === 3, 'ObjectBatch must read back its matrices and count writes.');
}
