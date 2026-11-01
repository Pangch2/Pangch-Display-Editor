import { closeColorPicker, hexToRgb, openColorPicker, oklchToRgb, rgbToHex, rgbToOklch, type RgbColor } from '../common/color-picker';
import { capturePlayerHeadAtlasState, commitPlayerHeadPaint, getPlayerHeadAtlasFaces, loadedObjectGroup, restorePlayerHeadAtlasState } from '../../load-project/display/mesh-builder';
import { recordStateChange } from '../../controls/undo-redo/scene-history';
import { getHeadAtlasUvRect, type HeadUvRect } from './head-atlas-uv';
import { openWithAnimation, closeWithAnimation } from '../common/ui-open-close.js';

export function replaceAtlasColors(image: ImageData, rects: readonly HeadUvRect[], source: RgbColor, target: RgbColor, tolerance: number): number[] {
    const changed: number[] = [];
    if (source.every((value, index) => value === target[index])) return changed;
    tolerance = Math.max(0, Math.min(100, Number.isFinite(tolerance) ? tolerance : 0)) / 100;
    const [sourceLightness, sourceChroma, sourceHue] = rgbToOklch(source);
    const sourceAngle = sourceHue * Math.PI / 180;
    const [targetLightness, chroma, hue] = rgbToOklch(target);
    for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
        if (!rects.some(rect => x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height)) continue;
        const pixel = y * image.width + x;
        const offset = pixel * 4;
        if (!image.data[offset + 3]) continue;
        const rgb: RgbColor = [image.data[offset], image.data[offset + 1], image.data[offset + 2]];
        const [lightness, pixelChroma, pixelHue] = rgbToOklch(rgb);
        const angle = pixelHue * Math.PI / 180;
        // Polar chroma distance keeps hue circular and ignores hue for achromatic colors.
        const difference = Math.hypot(lightness - sourceLightness,
            pixelChroma * Math.cos(angle) - sourceChroma * Math.cos(sourceAngle),
            pixelChroma * Math.sin(angle) - sourceChroma * Math.sin(sourceAngle));
        if (difference > tolerance) continue;
        const color = rgb.every((value, index) => value === source[index]) ? target : oklchToRgb([
            Math.max(0, Math.min(1, targetLightness + lightness - sourceLightness)), chroma, hue
        ]);
        if (color.every((value, index) => value === rgb[index])) continue;
        image.data.set(color, offset);
        changed.push(pixel);
    }
    return changed;
}

export function applyAtlasColorReplace(canvas: HTMLCanvasElement, rects: readonly HeadUvRect[], source: RgbColor, target: RgbColor, tolerance: number): boolean {
    const context = canvas.getContext('2d')!;
    const pixelsBefore = context.getImageData(0, 0, canvas.width, canvas.height);
    const pixelsAfter = new ImageData(pixelsBefore.data.slice(), canvas.width, canvas.height);
    const changed = replaceAtlasColors(pixelsAfter, rects, source, target, tolerance);
    if (!changed.length) return false;
    const changedPixels = new Set(changed);
    const faces = getPlayerHeadAtlasFaces(canvas);
    const surfaces = [...new Map(faces.filter(face => {
        const rect = getHeadAtlasUvRect(canvas, face.x, face.y);
        for (let y = rect.y; y < rect.y + rect.height; y++) for (let x = rect.x; x < rect.x + rect.width; x++) {
            if (changedPixels.has(y * canvas.width + x)) return true;
        }
        return false;
    }).flatMap(face => face.surfaces.map(surface => [surface.objectUuid, surface] as const))).values()];
    const uuids = surfaces.map(surface => surface.objectUuid);
    const before = capturePlayerHeadAtlasState(uuids);
    const refresh = () => {
        new Set(faces.flatMap(face => face.surfaces.map(surface => surface.texture))).forEach(texture => { texture.needsUpdate = true; });
        window.dispatchEvent(new CustomEvent('pde:scene-updated', { detail: { texturesOnly: true } }));
    };
    try {
        context.putImageData(pixelsAfter, 0, 0);
        surfaces.forEach(surface => commitPlayerHeadPaint(surface));
        const after = capturePlayerHeadAtlasState(uuids);
        const readColors = (pixels: ImageData) => {
            const colors = new Uint8ClampedArray(changed.length * 3);
            changed.forEach((pixel, index) => colors.set(pixels.data.subarray(pixel * 4, pixel * 4 + 3), index * 3));
            return colors;
        };
        const colorsBefore = readColors(pixelsBefore), colorsAfter = readColors(pixelsAfter);
        const apply = (state: typeof before, colors: Uint8ClampedArray) => {
            restorePlayerHeadAtlasState(state);
            const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
            changed.forEach((pixel, index) => pixels.data.set(colors.subarray(index * 3, index * 3 + 3), pixel * 4));
            context.putImageData(pixels, 0, 0);
            refresh();
        };
        recordStateChange({
            before: false, after: true,
            apply: changed => changed ? apply(after, colorsAfter) : apply(before, colorsBefore),
            animation: { root: loadedObjectGroup, targets: [] }
        });
    } catch (error) {
        restorePlayerHeadAtlasState(before);
        context.putImageData(pixelsBefore, 0, 0);
        refresh();
        throw error;
    }
    refresh();
    return true;
}

let overlay: HTMLElement | null = null;
let cancelReplace: (() => void) | null = null;
let source: RgbColor = [0, 0, 0];
let target: RgbColor = [0, 0, 0];
let tolerance = '0';
window.addEventListener('keydown', event => {
    if (!overlay || overlay.hidden) return;
    event.stopImmediatePropagation();
    if (event.key === 'Escape') { event.preventDefault(); cancelReplace?.(); }
    if (event.key === 'Enter' && !event.isComposing && event.target instanceof HTMLElement
        && event.target.matches('input, [data-source], [data-target]')) {
        event.preventDefault();
        if (event.target instanceof HTMLInputElement) event.target.dispatchEvent(new Event('change', { bubbles: true }));
    }
    if (event.key === 'Tab') {
        const picker = document.querySelector<HTMLElement>('.color-picker:not([hidden])');
        const controls = [...overlay.querySelectorAll<HTMLElement>('button, input'), ...picker?.querySelectorAll<HTMLElement>('button, input') ?? []];
        const index = controls.indexOf(document.activeElement as HTMLElement);
        event.preventDefault();
        controls[(index + (event.shiftKey ? -1 : 1) + controls.length) % controls.length]?.focus();
    }
}, true);

export function openAtlasColorReplace(canvas: HTMLCanvasElement, selection: readonly HeadUvRect[], atlasIndex: number, anchor: HTMLElement): void {
    cancelReplace?.();
    const rects = (selection.length ? selection : [{ x: 0, y: 0, width: canvas.width, height: canvas.height }]).map(rect => ({ ...rect }));
    const root = document.createElement('div');
    root.className = 'settings-overlay atlas-color-replace';
    root.innerHTML = `<section class="settings-window" role="dialog" aria-modal="true" aria-labelledby="atlas-color-replace-title">
        <header><h2 id="atlas-color-replace-title">아틀라스 색상 교체</h2><button type="button" class="settings-close" aria-label="닫기">×</button></header>
        <form><p data-scope></p><div class="atlas-color-row"><label for="atlas-source-color">원본 색상</label><span class="atlas-color-input"><button type="button" data-source class="project-ui-button" aria-label="원본 색상 선택"></button><input id="atlas-source-color" data-source-color class="pde-input" aria-label="원본 색상 HEX" pattern="#?[0-9a-fA-F]{6}" maxlength="7" required></span></div>
        <div class="atlas-color-row"><label for="atlas-target-color">변경할 색상</label><span class="atlas-color-input"><button type="button" data-target class="project-ui-button" aria-label="변경할 색상 선택"></button><input id="atlas-target-color" data-target-color class="pde-input" aria-label="변경할 색상 HEX" pattern="#?[0-9a-fA-F]{6}" maxlength="7" required></span></div>
        <label>허용오차% <input data-tolerance class="pde-input" type="number" min="0" max="100" step="0.1" value="0" required></label>
        <p role="status" aria-live="polite"></p><button class="project-ui-button" type="submit">바꾸기</button></form></section>`;
    overlay = root;
    const panel = root.querySelector<HTMLElement>('section')!;
    let closing = false;
    const close = () => {
        if (closing) return;
        closing = true;
        closeColorPicker();
        overlay = null;
        cancelReplace = null;
        window.removeEventListener('pde:player-head-atlases-changed', close);
        root.style.pointerEvents = 'none';
        void closeWithAnimation(panel).then(() => root.remove());
        anchor.focus({ preventScroll: true });
    };
    root.addEventListener('pointerdown', event => { if (event.target === root) close(); });
    cancelReplace = close;
    window.addEventListener('pde:player-head-atlases-changed', close);
    const sourceButton = root.querySelector<HTMLButtonElement>('[data-source]')!;
    const targetButton = root.querySelector<HTMLButtonElement>('[data-target]')!;
    const sourceInput = root.querySelector<HTMLInputElement>('[data-source-color]')!;
    const targetInput = root.querySelector<HTMLInputElement>('[data-target-color]')!;
    const toleranceInput = root.querySelector<HTMLInputElement>('[data-tolerance]')!;
    toleranceInput.value = tolerance;
    toleranceInput.oninput = () => { if (toleranceInput.validity.valid) tolerance = toleranceInput.value; };
    const sync = () => {
        for (const [button, input, color] of [[sourceButton, sourceInput, source], [targetButton, targetInput, target]] as const) {
            input.value = rgbToHex(color);
            input.setCustomValidity('');
            button.style.background = rgbToHex(color);
        }
    };
    sync();
    for (const input of [sourceInput, targetInput]) {
        input.oninput = () => {
            const hex = input.value.trim();
            const valid = /^#?[0-9a-f]{6}$/i.test(hex);
            input.setCustomValidity(valid ? '' : '6자리 HEX 색상을 입력해 주세요.');
            if (!valid) return;
            const color = hexToRgb(hex.startsWith('#') ? hex : `#${hex}`);
            if (input === sourceInput) source = color;
            else target = color;
            sync();
        };
        input.onchange = input.onblur = sync;
    }
    const pickerOptions = { onEyeDropperChange: (active: boolean) => { root.hidden = active; } };
    sourceButton.onclick = () => openColorPicker(sourceButton, source, color => { source = color; sync(); }, pickerOptions);
    targetButton.onclick = () => openColorPicker(targetButton, target, color => { target = color; sync(); }, pickerOptions);
    root.querySelector('[data-scope]')!.textContent = `아틀라스 ${atlasIndex + 1}${selection.length ? ` · 선택 영역 ${rects.length}개 (합집합)` : ''}`;
    root.querySelector<HTMLButtonElement>('.settings-close')!.onclick = close;
    root.querySelector('form')!.onsubmit = event => {
        event.preventDefault();
        try { applyAtlasColorReplace(canvas, rects, source, target, Number(toleranceInput.value)); close(); }
        catch (error) { root.querySelector('[role="status"]')!.textContent = `색상 교체 실패: ${String(error)}`; }
    };
    document.body.append(root);
    openWithAnimation(panel);
    sourceButton.focus();
}
