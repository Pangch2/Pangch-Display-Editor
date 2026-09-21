import { capturePlayerHeadAtlasState, commitPlayerHeadPaint, getPlayerHeadAtlasFaces, restorePlayerHeadAtlasState, type PlayerHeadAtlasFace } from '../load-project/display/mesh-builder';
import { record } from '../controls/undo-redo/undo-redo';
import { getHeadAtlasUvRect, setHeadAtlasUvRect, transformHeadUvRect } from './head-atlas-uv';

const playerHeadAtlasScroll = document.getElementById('player-head-atlas-scroll')!;
const playerHeadAtlasList = document.getElementById('player-head-atlas-list')!;
const clampPlayerHeadAtlasZoom = (zoom: number): number => Math.min(256, Math.max(1, zoom));
const clampPlayerHeadAtlasIndex = (index: number, count: number): number => Math.min(index, Math.max(0, count - 1));
let playerHeadAtlasZoom = 1;
let activePlayerHeadAtlas = 0;
let selectedFace: PlayerHeadAtlasFace | null = null;
let selectedCanvas: HTMLCanvasElement | null = null;
let cancelUvDrag: (() => void) | null = null;
let refreshUvEditor = () => {};

function attachUvEditor(canvas: HTMLCanvasElement, stage: HTMLElement): void {
    let faces = getPlayerHeadAtlasFaces(canvas);
    selectedFace = canvas === selectedCanvas ? faces.find(face => face.x === selectedFace?.x && face.y === selectedFace?.y) ?? null : null;
    selectedCanvas = canvas;
    const selection = document.createElement('div');
    selection.className = 'player-head-uv-selection';
    selection.tabIndex = 0;
    selection.setAttribute('role', 'group');
    selection.setAttribute('aria-label', '선택한 면 UV: 방향키로 이동, Shift+방향키로 크기 조절');
    const handleNames = { nw: '왼쪽 위', n: '위', ne: '오른쪽 위', e: '오른쪽', se: '오른쪽 아래', s: '아래', sw: '왼쪽 아래', w: '왼쪽' };
    for (const [handle, name] of Object.entries(handleNames)) {
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.uvHandle = handle;
        button.ariaLabel = `${name} UV 크기 조절`;
        selection.append(button);
    }
    stage.append(selection);
    const caption = document.createElement('div');
    caption.className = 'player-head-uv-caption';
    caption.setAttribute('aria-live', 'polite');
    stage.parentElement!.after(caption);
    const refresh = () => {
        selection.hidden = !selectedFace;
        caption.textContent = '면 클릭으로 UV 선택 · 내부 드래그로 이동 · 테두리 드래그로 크기 조절';
        if (!selectedFace) return;
        const rect = getHeadAtlasUvRect(canvas, selectedFace.x, selectedFace.y);
        selection.style.left = `${rect.x / canvas.width * 100}%`;
        selection.style.top = `${rect.y / canvas.height * 100}%`;
        selection.style.width = `${rect.width / canvas.width * 100}%`;
        selection.style.height = `${rect.height / canvas.height * 100}%`;
        caption.textContent = `${selectedFace.name} · X ${rect.x}, Y ${rect.y} · ${rect.width} × ${rect.height} px · ${selectedFace.surfaces.length}개 헤드 · 내부: 이동 / 테두리: 크기`;
    };
    const finishEdit = (face: PlayerHeadAtlasFace, before: ReturnType<typeof capturePlayerHeadAtlasState>) => {
        face.surfaces.forEach(commitPlayerHeadPaint);
        const after = capturePlayerHeadAtlasState(face.surfaces.map(surface => surface.objectUuid));
        const apply = (state: typeof before) => {
            restorePlayerHeadAtlasState(state);
            window.dispatchEvent(new Event('pde:scene-updated'));
        };
        record({ undo: () => apply(before), redo: () => apply(after) });
        window.dispatchEvent(new Event('pde:scene-updated'));
    };
    refreshUvEditor = () => {
        faces = getPlayerHeadAtlasFaces(canvas);
        selectedFace = faces.find(face => face.x === selectedFace?.x && face.y === selectedFace?.y) ?? null;
        refresh();
    };
    stage.addEventListener('pointerdown', event => {
        if (event.button !== 0 || cancelUvDrag) return;
        refreshUvEditor();
        const bounds = canvas.getBoundingClientRect();
        const x = (event.clientX - bounds.left) / bounds.width * canvas.width;
        const y = (event.clientY - bounds.top) / bounds.height * canvas.height;
        const target = event.target as HTMLElement;
        if (!selection.contains(target)) {
            selectedFace = faces.find(face => {
                const rect = getHeadAtlasUvRect(canvas, face.x, face.y);
                return x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
            }) ?? null;
            refresh();
        }
        if (!selectedFace) return;
        event.preventDefault();
        selection.focus({ preventScroll: true });
        const face = selectedFace;
        const original = getHeadAtlasUvRect(canvas, face.x, face.y);
        const before = capturePlayerHeadAtlasState(face.surfaces.map(surface => surface.objectUuid));
        const handle = target.dataset.uvHandle ?? '';
        const pointerId = event.pointerId;
        const startX = event.clientX;
        const startY = event.clientY;
        let changed = false;
        const move = (next: PointerEvent) => {
            if (next.pointerId !== pointerId) return;
            const rect = transformHeadUvRect(original, handle,
                (next.clientX - startX) / bounds.width * canvas.width,
                (next.clientY - startY) / bounds.height * canvas.height, canvas.width);
            changed = rect.x !== original.x || rect.y !== original.y || rect.width !== original.width || rect.height !== original.height;
            setHeadAtlasUvRect(canvas, face.x, face.y, rect);
            refresh();
        };
        const finish = (cancel: boolean) => {
            cancelUvDrag = null;
            stage.removeEventListener('pointermove', move);
            stage.removeEventListener('pointerup', up);
            stage.removeEventListener('pointercancel', cancelPointer);
            stage.removeEventListener('lostpointercapture', cancelPointer);
            window.removeEventListener('keydown', escape, true);
            if (stage.hasPointerCapture(pointerId)) stage.releasePointerCapture(pointerId);
            if (cancel) setHeadAtlasUvRect(canvas, face.x, face.y, original);
            else if (changed) finishEdit(face, before);
            refresh();
        };
        const up = (next: PointerEvent) => { if (next.pointerId === pointerId) { move(next); finish(false); } };
        const cancelPointer = (next: PointerEvent) => { if (next.pointerId === pointerId) finish(true); };
        const escape = (next: KeyboardEvent) => {
            if (next.key !== 'Escape') {
                if (next.ctrlKey || next.metaKey) { next.preventDefault(); next.stopImmediatePropagation(); }
                return;
            }
            next.preventDefault();
            next.stopImmediatePropagation();
            finish(true);
        };
        cancelUvDrag = () => finish(true);
        stage.setPointerCapture(pointerId);
        stage.addEventListener('pointermove', move);
        stage.addEventListener('pointerup', up);
        stage.addEventListener('pointercancel', cancelPointer);
        stage.addEventListener('lostpointercapture', cancelPointer);
        window.addEventListener('keydown', escape, true);
    });
    selection.addEventListener('keydown', event => {
        if (!selectedFace || cancelUvDrag || event.ctrlKey || event.metaKey || event.altKey) return;
        const delta = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
        if (!delta) return;
        event.preventDefault();
        event.stopPropagation();
        const original = getHeadAtlasUvRect(canvas, selectedFace.x, selectedFace.y);
        const handle = (event.target as HTMLElement).dataset.uvHandle ?? (event.shiftKey ? 'se' : '');
        const rect = transformHeadUvRect(original, handle, delta[0], delta[1], canvas.width);
        if (JSON.stringify(rect) === JSON.stringify(original)) return;
        const before = capturePlayerHeadAtlasState(selectedFace.surfaces.map(surface => surface.objectUuid));
        setHeadAtlasUvRect(canvas, selectedFace.x, selectedFace.y, rect);
        finishEdit(selectedFace, before);
        refresh();
    });
    refresh();
}

const renderPlayerHeadAtlases = (canvases: HTMLCanvasElement[]): void => {
    cancelUvDrag?.();
    const previousBox = playerHeadAtlasScroll.querySelector<HTMLElement>('.player-head-atlas-box');
    const scrollLeft = previousBox?.scrollLeft ?? 0;
    const scrollTop = previousBox?.scrollTop ?? 0;
    activePlayerHeadAtlas = clampPlayerHeadAtlasIndex(activePlayerHeadAtlas, canvases.length);
    const box = document.createElement('div');
    box.className = 'player-head-atlas-box';
    const canvas = canvases[activePlayerHeadAtlas];
    const stage = document.createElement('div');
    stage.className = 'player-head-atlas-stage';
    if (canvas) {
        stage.append(canvas);
        box.append(stage);
    }
    playerHeadAtlasScroll.replaceChildren(box, playerHeadAtlasList);
    if (canvas) attachUvEditor(canvas, stage);
    else {
        selectedFace = selectedCanvas = null;
        refreshUvEditor = () => {};
    }
    box.scrollLeft = scrollLeft;
    box.scrollTop = scrollTop;

    playerHeadAtlasList.hidden = canvases.length === 0;
    playerHeadAtlasList.replaceChildren(...canvases.map((canvas, index) => {
        const option = document.createElement('button');
        option.type = 'button';
        option.className = 'player-head-atlas-option';
        option.ariaPressed = String(index === activePlayerHeadAtlas);
        option.ariaLabel = `아틀라스 ${index + 1}, ${canvas.width} × ${canvas.height} 픽셀`;

        const thumbnail = document.createElement('canvas');
        thumbnail.width = thumbnail.height = 48;
        thumbnail.getContext('2d')?.drawImage(canvas, 0, 0, 48, 48);

        const description = document.createElement('span');
        description.className = 'player-head-atlas-description';
        const name = document.createElement('span');
        name.textContent = `아틀라스 ${index + 1}`;
        const resolution = document.createElement('span');
        resolution.textContent = `${canvas.width} × ${canvas.height} px`;
        description.append(name, resolution);
        option.append(thumbnail, description);
        option.addEventListener('click', () => {
            activePlayerHeadAtlas = index;
            renderPlayerHeadAtlases(canvases);
        });
        return option;
    }));
};

window.addEventListener('pde:player-head-atlases-changed', event => {
    renderPlayerHeadAtlases((event as CustomEvent<HTMLCanvasElement[]>).detail);
});

playerHeadAtlasScroll.addEventListener('wheel', event => {
    if (!(event.target instanceof Element)) return;
    const box = event.target.closest<HTMLElement>('.player-head-atlas-box');
    const canvas = box?.querySelector('canvas');
    if (!box || !canvas) return;
    event.preventDefault();
    if (cancelUvDrag) return;
    const before = canvas.getBoundingClientRect();
    const textureX = (event.clientX - before.left) / before.width;
    const textureY = (event.clientY - before.top) / before.height;
    playerHeadAtlasZoom = clampPlayerHeadAtlasZoom(playerHeadAtlasZoom * (event.deltaY < 0 ? 1.15 : 1 / 1.15));
    playerHeadAtlasScroll.style.setProperty('--player-head-atlas-zoom', String(playerHeadAtlasZoom));
    const after = canvas.getBoundingClientRect();
    box.scrollLeft += after.left + textureX * after.width - event.clientX;
    box.scrollTop += after.top + textureY * after.height - event.clientY;
}, { passive: false });

window.addEventListener('pde:scene-updated', () => {
    if (!cancelUvDrag) refreshUvEditor();
});

renderPlayerHeadAtlases([]);

if (import.meta.env.DEV) {
    console.assert(clampPlayerHeadAtlasZoom(0) === 1 && clampPlayerHeadAtlasZoom(Infinity) === 256, 'Player head atlas zoom limits are broken.');
    console.assert(clampPlayerHeadAtlasIndex(2, 2) === 1 && clampPlayerHeadAtlasIndex(1, 0) === 0, 'Player head atlas selection limits are broken.');
}
