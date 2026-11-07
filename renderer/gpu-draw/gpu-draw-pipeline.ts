import { StandardDrawingPipeline } from 'three/webgpu';
import type { Camera, WebGPURenderer } from 'three/webgpu';
import { DrawPool } from './draw-pool';
import { installPooledInstancing } from './pool-instance';
import { installInstanceRowAccessors } from '../scene-store/object-access';

/**
 * Draws content InstancedMeshes from shared pools instead of one render object per mesh: one proxy draw
 * per (layout, material), with compute-culled indirect args (frustum, facing, hidden). Other objects
 * (overlays, gizmos, previews) take the regular path.
 */
export class PdeDrawingPipeline extends StandardDrawingPipeline {
    declare renderer: WebGPURenderer;
    readonly pool: DrawPool;
    private camera: Camera | null = null;

    constructor(maxStorageBindingSize: number) {
        super();
        this.pool = new DrawPool(maxStorageBindingSize);
    }

    begin(camera: Camera, renderContext: unknown): void {
        super.begin(camera, renderContext);
        this.camera = camera;
        this.pool.beginCall();
    }

    pushRenderItem(renderList, object, geometry, material, groupOrder: number, z: number, group, clippingContext): void {
        if (this.pool.push(object, geometry, material, groupOrder, clippingContext)) return;
        super.pushRenderItem(renderList, object, geometry, material, groupOrder, z, group, clippingContext);
    }

    finishRenderList(renderList): void {
        for (const batch of this.pool.finish(this.renderer, this.camera!)) {
            batch.proxy.renderOrder = batch.renderOrder;
            renderList.push(batch.proxy, batch.proxy.geometry, batch.material, batch.groupOrder, 0, null, batch.clippingContext);
        }
        super.finishRenderList(renderList);
    }

    dispose(): void {
        this.pool.dispose();
        super.dispose();
    }
}

/** Switches the renderer to pooled drawing. False (regular draws, no culling) without `indirect-first-instance`. */
export function installGpuDraw(renderer: WebGPURenderer): boolean {
    const backend = renderer.backend as unknown as { isWebGPUBackend?: boolean; device?: GPUDevice };
    if (!backend.isWebGPUBackend || !backend.device?.features.has('indirect-first-instance')) return false;
    installPooledInstancing();
    // Adopted batches keep matrices and colors in pool rows.
    installInstanceRowAccessors();
    renderer.drawingPipeline = new PdeDrawingPipeline(backend.device.limits.maxStorageBufferBindingSize);
    return true;
}
