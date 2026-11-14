import { hexToRgb, type RgbColor } from './color-picker';
import { captureSceneColor } from './scene-color-capture';

// Display entities give their unlit color; anything else (UI, background, outside the PDE window) gives the visible screen pixel.
export async function pickScreenColor(): Promise<RgbColor | null> {
  // Let hidden panels paint before the native picker grabs the screen; the click's user activation outlives two frames.
  await new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done())));
  const picked = await new EyeDropper().open().catch(() => null);
  if (!picked) return null;
  try {
    const point = await window.ipcApi.getCursorClientPoint();
    return await captureSceneColor(point.x, point.y) ?? hexToRgb(picked.sRGBHex);
  } catch (error) {
    console.error('Scene color capture failed; using the screen pixel.', error);
    return hexToRgb(picked.sRGBHex);
  }
}
