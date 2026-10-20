import type { RgbColor } from './color-picker';
import { captureSceneColors } from './scene-color-capture';

let cancelActivePick: (() => void) | null = null;

export function pickScreenColor(clientX = innerWidth / 2, clientY = innerHeight / 2): Promise<RgbColor | null> {
  cancelActivePick?.();
  const previousFocus = document.activeElement as HTMLElement | null;
  const dialog = document.createElement('dialog');
  dialog.className = 'screen-color-picker';
  dialog.tabIndex = -1;
  dialog.setAttribute('aria-label', '색상 스포이드. 클릭 또는 Enter로 선택, 방향키로 픽셀 이동, Escape로 취소');
  dialog.innerHTML = `<canvas class="screen-color-picker-snapshot" hidden></canvas>
    <div class="screen-color-picker-cursor" hidden><div class="screen-color-picker-lens"><canvas width="110" height="110"></canvas><span></span></div></div>`;
  const snapshot = dialog.querySelector<HTMLCanvasElement>('.screen-color-picker-snapshot')!;
  const context = snapshot.getContext('2d', { willReadFrequently: true, colorSpace: 'srgb' })!;
  const cursor = dialog.querySelector<HTMLElement>('.screen-color-picker-cursor')!;
  const lens = cursor.querySelector('canvas')!.getContext('2d', { colorSpace: 'srgb' })!;
  let color: RgbColor | null = null;
  let pixelX = 0;
  let pixelY = 0;
  let finished = false;
  let sceneColorAt: ((clientX: number, clientY: number) => RgbColor | null) | null = null;

  return new Promise(resolve => {
    const finish = (result: RgbColor | null = null) => {
      if (finished) return;
      finished = true;
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('resize', cancel);
      window.removeEventListener('blur', cancel);
      dialog.close();
      dialog.remove();
      cancelActivePick = null;
      previousFocus?.focus({ preventScroll: true });
      resolve(result);
    };
    const cancel = () => finish();
    const draw = () => {
      pixelX = Math.max(0, Math.min(snapshot.width - 1, pixelX));
      pixelY = Math.max(0, Math.min(snapshot.height - 1, pixelY));
      const pixel = context.getImageData(pixelX, pixelY, 1, 1).data;
      const bounds = snapshot.getBoundingClientRect();
      const x = bounds.left + (pixelX + 0.5) * bounds.width / snapshot.width;
      const y = bounds.top + (pixelY + 0.5) * bounds.height / snapshot.height;
      color = sceneColorAt?.(x, y) ?? [pixel[0], pixel[1], pixel[2]];
      lens.clearRect(0, 0, 110, 110);
      lens.imageSmoothingEnabled = false;
      lens.drawImage(snapshot, pixelX - 5, pixelY - 5, 11, 11, 0, 0, 110, 110);
      cursor.style.left = `${x}px`;
      cursor.style.top = `${y}px`;
      cursor.hidden = false;
    };
    const move = (event: { clientX: number; clientY: number }) => {
      clientX = event.clientX;
      clientY = event.clientY;
      if (snapshot.hidden) return;
      const bounds = snapshot.getBoundingClientRect();
      pixelX = Math.floor((clientX - bounds.left) * snapshot.width / bounds.width);
      pixelY = Math.floor((clientY - bounds.top) * snapshot.height / bounds.height);
      draw();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.key === 'Escape') return cancel();
      if (!color) return;
      if (event.key === 'Enter') return finish(color);
      if (event.key === 'ArrowLeft') pixelX--;
      if (event.key === 'ArrowRight') pixelX++;
      if (event.key === 'ArrowUp') pixelY--;
      if (event.key === 'ArrowDown') pixelY++;
      draw();
    };
    dialog.addEventListener('pointermove', move);
    dialog.addEventListener('pointerdown', event => {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.button !== 0 || snapshot.hidden) return;
      move(event);
      finish(color);
    });
    dialog.addEventListener('contextmenu', event => { event.preventDefault(); cancel(); });
    dialog.addEventListener('cancel', event => { event.preventDefault(); cancel(); });
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('resize', cancel);
    window.addEventListener('blur', cancel);
    cancelActivePick = cancel;
    document.body.append(dialog);
    dialog.showModal();
    dialog.focus({ preventScroll: true });

    void (async () => {
      try {
        // Let hidden dialogs paint before capturing the lit viewport for the magnifier.
        await new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done())));
        if (finished) return;
        // shortcut: capture the PDE viewport only; add desktop capture if picking outside PDE is needed.
        const dataUrl = await window.ipcApi.captureColorPicker();
        if (finished) return;
        sceneColorAt = await captureSceneColors();
        if (finished) return;
        const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
        try {
          if (finished) return;
          snapshot.width = bitmap.width;
          snapshot.height = bitmap.height;
          context.drawImage(bitmap, 0, 0);
        } finally { bitmap.close(); }
        snapshot.hidden = false;
        move({ clientX, clientY });
      } catch (error) {
        if (!finished) console.error('Screen color picker failed.', error);
        cancel();
      }
    })();
  });
}
