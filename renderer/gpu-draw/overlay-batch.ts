import { LineSegments, Mesh, Object3D, Sprite } from 'three/webgpu';
import type { BufferAttribute, BufferGeometry, Material } from 'three/webgpu';
import { Fn, instanceIndex, storage } from 'three/tsl';

export type OverlayTopology = 'triangles' | 'lines' | 'sprites';
type OverlayDraw = (Mesh | LineSegments | Sprite) & { overlayBatch: OverlayBatch };

// three/webgpu is untyped here, so the inherited Object3D members (visible, renderOrder, userData, ...) read as any.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface OverlayBatch { [member: string]: any }

/**
 * An editor overlay (selection boxes, vertex points, head painter grids). Not a Mesh: PdeDrawingPipeline submits its
 * private draw, `count` instances of its geometry in one call, like the draw pool's proxies.
 */
export class OverlayBatch extends Object3D {
    readonly isOverlayBatch = true;
    /** Instances drawn; 0 draws nothing. */
    count = 0;
    /** Per-instance values its material reads with overlayInstance(). */
    instances: BufferAttribute | null;
    readonly draw: OverlayDraw;

    constructor(topology: OverlayTopology, geometry: BufferGeometry | null, material: Material, instances: BufferAttribute | null = null) {
        super();
        this.instances = instances;
        const draw = (topology === 'sprites' ? new Sprite(material)
            : topology === 'lines' ? new LineSegments(geometry, material) : new Mesh(geometry, material)) as OverlayDraw;
        draw.overlayBatch = this;
        draw.frustumCulled = false;
        draw.matrixAutoUpdate = false;
        draw.matrixWorldAutoUpdate = false;
        this.draw = draw;
    }

    /** Frees its geometry and instances; the material belongs to the caller. */
    dispose(): void {
        this.removeFromParent();
        // Sprites share three's quad geometry.
        if (!(this.draw as Sprite).isSprite) this.draw.geometry.dispose();
        this.instances?.dispose();
    }
}

const buildStorage = new WeakMap<object, Map<string, ReturnType<typeof storage>>>();

/**
 * One instance value of the drawn overlay. The buffer is bound per draw (as in pool-instance.ts), so overlays sharing a
 * material keep their own instances and a grown buffer needs no new material. Vertex stage only.
 */
export const overlayInstance = (type: string, index = instanceIndex) => Fn((builder) => {
    let nodes = buildStorage.get(builder);
    if (!nodes) buildStorage.set(builder, nodes = new Map());
    let node = nodes.get(type);
    if (!node) nodes.set(type, node = storage(builder.object.overlayBatch.instances, type).toReadOnly()
        .onObjectUpdate(({ object }) => object.overlayBatch.instances));
    return node.element(index);
})();
