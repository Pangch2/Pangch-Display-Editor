import { openWithAnimation, closeWithAnimation } from '../common/ui-open-close.js';

export type AtlasViewSize = { width: number; height: number };

const maxSize = 2048;
// One Blockbench-style head block (32×32) must fit.
const minSize = 32;
const parseSize = (value: unknown): number | null => {
    const size = Number(value);
    return Number.isInteger(size) && size >= minSize && size <= maxSize ? size : null;
};

export type AtlasSettings = AtlasViewSize & { name: string };

/** `onApply` returns an error message to keep the dialog open, or null once the settings are in use. */
export function openAtlasViewSettings(anchor: HTMLElement, label: string, current: AtlasSettings, onApply: (settings: AtlasSettings) => string | null): void {
    const root = document.createElement('div');
    root.className = 'settings-overlay atlas-color-replace atlas-view-settings';
    root.innerHTML = `<section class="settings-window" role="dialog" aria-modal="true" aria-labelledby="atlas-view-title">
        <header><h2 id="atlas-view-title"></h2><button type="button" class="settings-close" aria-label="닫기">×</button></header>
        <form><label>아틀라스 이름 <input data-name class="pde-input" type="text" maxlength="64"></label>
        <label>너비 (px) <input data-width class="pde-input" type="number" min="${minSize}" max="${maxSize}" step="1" required></label>
        <label>높이 (px) <input data-height class="pde-input" type="number" min="${minSize}" max="${maxSize}" step="1" required></label>
        <p role="status" aria-live="polite"></p>
        <div class="atlas-view-actions"><button class="project-ui-button atlas-view-reset" type="button" data-reset title="${maxSize} × ${maxSize}">크기 초기화</button><button class="project-ui-button" type="button" data-cancel>취소</button><button class="project-ui-button" type="submit">저장</button></div></form></section>`;
    root.querySelector('h2')!.textContent = `${label} 설정`;
    const panel = root.querySelector<HTMLElement>('section')!;
    const widthInput = root.querySelector<HTMLInputElement>('[data-width]')!;
    const heightInput = root.querySelector<HTMLInputElement>('[data-height]')!;
    const nameInput = root.querySelector<HTMLInputElement>('[data-name]')!;
    nameInput.value = current.name;
    nameInput.placeholder = label;
    widthInput.value = String(current.width);
    heightInput.value = String(current.height);
    let closing = false;
    const close = () => {
        if (closing) return;
        closing = true;
        root.style.pointerEvents = 'none';
        void closeWithAnimation(panel).then(() => root.remove());
        anchor.focus({ preventScroll: true });
    };
    const apply = (settings: AtlasSettings) => {
        const error = onApply(settings);
        root.querySelector('[role="status"]')!.textContent = error ?? '';
        if (error) return;
        close();
    };
    root.addEventListener('pointerdown', event => { if (event.target === root) close(); });
    root.addEventListener('keydown', event => {
        event.stopPropagation();
        if (event.key === 'Escape') { event.preventDefault(); close(); }
    });
    root.querySelector<HTMLButtonElement>('.settings-close')!.onclick = close;
    root.querySelector<HTMLButtonElement>('[data-cancel]')!.onclick = close;
    root.querySelector<HTMLButtonElement>('[data-reset]')!.onclick = () => { widthInput.value = heightInput.value = String(maxSize); };
    root.querySelector('form')!.onsubmit = event => {
        event.preventDefault();
        const width = parseSize(widthInput.value), height = parseSize(heightInput.value);
        if (width && height) apply({ name: nameInput.value, width, height });
    };
    document.body.append(root);
    openWithAnimation(panel);
    nameInput.focus();
    nameInput.select();
}

if (import.meta.env.DEV) {
    console.assert(parseSize('256') === 256 && parseSize('31') === null && parseSize('0') === null && parseSize('2049') === null && parseSize('1.5') === null,
        'Atlas view size validation failed.');
}
