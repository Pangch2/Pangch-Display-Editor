import { StandardDrawingPipeline } from 'three/webgpu';
import type { Camera, WebGPURenderer } from 'three/webgpu';
import { DrawPool } from './draw-pool';
import { installPooledInstancing } from './pool-instance';
import type { ObjectBatch } from '../scene-store/object-batch';
import type { OverlayBatch } from './overlay-batch';
import { setRowBindingLimit } from '../scene-store/row-store';

/**
 * Draws content batches (ObjectBatch, not Meshes: three skips them) from shared pools: one proxy draw per
 * (layout, material), with compute-culled indirect args (frustum, facing, hidden). Overlays (OverlayBatch) draw once
 * each; other objects (gizmos) take the regular path.
 */
export class PdeDrawingPipeline extends StandardDrawingPipeline {
    declare renderer: WebGPURenderer;
    readonly pool = new DrawPool();
    private camera: Camera | null = null;

    begin(camera: Camera, renderContext: unknown): void {
        super.begin(camera, renderContext);
        this.camera = camera;
        this.pool.beginCall();
    }

    project(object, camera: Camera, groupOrder: number, renderList, clippingContext): void {
        if ((object as OverlayBatch).isOverlayBatch === true) {
            const { draw } = object as OverlayBatch;
            if (!object.visible || object.count <= 0 || !object.layers.test(camera.layers) || !draw.material.visible) return;
            draw.count = object.count;
            draw.renderOrder = object.renderOrder;
            draw.matrixWorld.copy(object.matrixWorld);
            renderList.push(draw, draw.geometry, draw.material, groupOrder, 0, null, clippingContext);
            return;
        }
        if ((object as ObjectBatch).isObjectBatch !== true) return super.project(object, camera, groupOrder, renderList, clippingContext);
        if (object.visible && object.layers.test(camera.layers)) this.pool.push(object, groupOrder, clippingContext);
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

/** Switches the renderer to pooled drawing, the only way content batches are drawn. False without `indirect-first-instance`. */
export function installGpuDraw(renderer: WebGPURenderer): boolean {
    const backend = renderer.backend as unknown as { isWebGPUBackend?: boolean; device?: GPUDevice };
    if (!backend.isWebGPUBackend || !backend.device?.features.has('indirect-first-instance')) return false;
    installPooledInstancing();
    setRowBindingLimit(backend.device.limits.maxStorageBufferBindingSize);
    renderer.drawingPipeline = new PdeDrawingPipeline();
    return true;
}
