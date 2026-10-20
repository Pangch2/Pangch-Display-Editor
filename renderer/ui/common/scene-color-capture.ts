import { Color, DataUtils, FloatType, HalfFloatType, NearestFilter, RenderTarget, Vector2, type Camera, type Scene, type WebGPURenderer } from 'three/webgpu';
import { suspendShading } from '../../entity-material';
import type { RgbColor } from './color-picker';

let source: { renderer: WebGPURenderer; scene: Scene; getCamera: () => Camera } | null = null;

export function initSceneColorCapture(renderer: WebGPURenderer, scene: Scene, getCamera: () => Camera): void {
  source = { renderer, scene, getCamera };
}

export async function captureSceneColors(): Promise<((clientX: number, clientY: number) => RgbColor | null) | null> {
  if (!source) return null;
  const { renderer, scene, getCamera } = source;
  const bounds = renderer.domElement.getBoundingClientRect();
  const size = renderer.getDrawingBufferSize(new Vector2());
  const float32 = renderer.hasFeature('float32-blendable');
  const target = new RenderTarget(size.x, size.y, { type: float32 ? FloatType : HalfFloatType, minFilter: NearestFilter, magFilter: NearestFilter });
  const previousTarget = renderer.getRenderTarget();
  const restoreShading = suspendShading();
  try {
    // Keep the unlit pass offscreen and restore renderer state before yielding to a visible frame.
    try {
      renderer.setRenderTarget(target);
      renderer.render(scene, getCamera());
    } finally {
      renderer.setRenderTarget(previousTarget);
      restoreShading();
    }
    const pixels = await renderer.readRenderTargetPixelsAsync(target, 0, 0, size.x, size.y);
    // WebGPU readback rows are padded to 256 bytes.
    const stride = Math.ceil(size.x * 4 * pixels.BYTES_PER_ELEMENT / 256) * 256 / pixels.BYTES_PER_ELEMENT;
    const channel = (index: number) => float32 ? pixels[index] : DataUtils.fromHalfFloat(pixels[index]);
    const color = new Color();
    return (clientX, clientY) => {
      if (clientX < bounds.left || clientX >= bounds.right || clientY < bounds.top || clientY >= bounds.bottom) return null;
      const x = Math.floor((clientX - bounds.left) * size.x / bounds.width);
      const y = Math.floor((clientY - bounds.top) * size.y / bounds.height);
      const offset = y * stride + x * 4;
      color.setRGB(channel(offset), channel(offset + 1), channel(offset + 2)).convertLinearToSRGB();
      return [color.r, color.g, color.b].map(value => Math.round(Math.min(1, Math.max(0, value)) * 255)) as RgbColor;
    };
  } finally { target.dispose(); }
}
