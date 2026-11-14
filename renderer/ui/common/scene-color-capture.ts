import { Color, DataUtils, FloatType, HalfFloatType, NearestFilter, Raycaster, RenderTarget, Vector2, type Camera, type Scene, type WebGPURenderer } from 'three/webgpu';
import { suspendShading } from '../../entity-material';
import type { RgbColor } from './color-picker';

type HitsEntity = (raycaster: Raycaster) => boolean;

let source: { renderer: WebGPURenderer; scene: Scene; getCamera: () => Camera; hitsEntity: HitsEntity } | null = null;

export function initSceneColorCapture(renderer: WebGPURenderer, scene: Scene, getCamera: () => Camera, hitsEntity: HitsEntity): void {
  source = { renderer, scene, getCamera, hitsEntity };
}

/** Unlit color of the display entity at a client point, or null when no entity is there. */
export async function captureSceneColor(clientX: number, clientY: number): Promise<RgbColor | null> {
  if (!source) return null;
  const { renderer, scene, getCamera, hitsEntity } = source;
  const bounds = renderer.domElement.getBoundingClientRect();
  if (clientX < bounds.left || clientX >= bounds.right || clientY < bounds.top || clientY >= bounds.bottom) return null;
  const camera = getCamera();
  const raycaster = new Raycaster();
  raycaster.setFromCamera(new Vector2((clientX - bounds.left) / bounds.width * 2 - 1, -(clientY - bounds.top) / bounds.height * 2 + 1), camera);
  if (!hitsEntity(raycaster)) return null;
  const size = renderer.getDrawingBufferSize(new Vector2());
  const x = Math.floor((clientX - bounds.left) * size.x / bounds.width);
  const y = Math.floor((clientY - bounds.top) * size.y / bounds.height);
  const float32 = renderer.hasFeature('float32-blendable');
  const target = new RenderTarget(size.x, size.y, { type: float32 ? FloatType : HalfFloatType, minFilter: NearestFilter, magFilter: NearestFilter });
  const previousTarget = renderer.getRenderTarget();
  const restoreShading = suspendShading();
  try {
    // Keep the unlit pass offscreen and restore renderer state before yielding to a visible frame.
    try {
      renderer.setRenderTarget(target);
      renderer.render(scene, camera);
    } finally {
      renderer.setRenderTarget(previousTarget);
      restoreShading();
    }
    const pixel = await renderer.readRenderTargetPixelsAsync(target, x, y, 1, 1);
    const channel = (index: number) => float32 ? pixel[index] : DataUtils.fromHalfFloat(pixel[index]);
    const color = new Color().setRGB(channel(0), channel(1), channel(2)).convertLinearToSRGB();
    return [color.r, color.g, color.b].map(value => Math.round(Math.min(1, Math.max(0, value)) * 255)) as RgbColor;
  } finally { target.dispose(); }
}
