import type { Camera, InstancedMesh, Scene, WebGPURenderer } from 'three/webgpu';
import { yieldPreview } from '../../animation/yield-preview';

export async function precompileDisplayModels(renderer: WebGPURenderer, scene: Scene, camera: Camera,
    meshes: InstancedMesh[], current: () => boolean): Promise<void> {
    const compileCamera = camera.clone();
    compileCamera.layers.set(31);
    let deadline = performance.now() + 8;
    for (const mesh of meshes) {
        if (!current()) return;
        const layers = mesh.layers.mask, visible = mesh.visible;
        // compileAsync yields; keep preparation off the active camera throughout that wait.
        mesh.layers.set(31); mesh.visible = true;
        try { await renderer.compileAsync(mesh, compileCamera, scene); }
        finally { mesh.layers.mask = layers; mesh.visible = visible; }
        if (performance.now() >= deadline) {
            await yieldPreview();
            deadline = performance.now() + 8;
        }
    }
}
