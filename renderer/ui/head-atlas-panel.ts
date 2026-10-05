import { capturePlayerHeadAtlasState, commitPlayerHeadPaint, getPlayerHeadAtlasFaces, restorePlayerHeadAtlasState, type PlayerHeadAtlasFace } from '../load-project/display/mesh-builder';
import { isApplying, record, redo, undo } from '../controls/undo-redo/undo-redo';
import { getShortcuts, matchesShortcut } from '../controls/input/shortcuts';
import { getHeadAtlasUvRect, setHeadAtlasUvRect, transformHeadUvRect, type HeadUvRect } from './head-atlas-uv';

export type HeadAtlasPaintTarget = {
    canvas: HTMLCanvasElement;
    faces: PlayerHeadAtlasFace[];
    face: PlayerHeadAtlasFace | null;
    rect: HeadUvRect | null;
    x: number;
    y: number;
};
type HeadAtlasPainterGrid = {
    enabled: boolean;
    color: string;
    getFaceGridCounts: (face: PlayerHeadAtlasFace) => [number, number];
};
type AtlasRegion = { faceX: number; faceY: number; rect: HeadUvRect };

const playerHeadAtlasScroll = document.getElementById('player-head-atlas-scroll')!;
const playerHeadAtlasList = document.getElementById('player-head-atlas-list')!;
const clampPlayerHeadAtlasZoom = (zoom: number): number => Math.min(256, Math.max(1, zoom));
const clampPlayerHeadAtlasIndex = (index: number, count: number): number => Math.min(index, Math.max(0, count - 1));
let playerHeadAtlasZoom = 1;
let activePlayerHeadAtlas = 0;
let playerHeadAtlasCanvases: HTMLCanvasElement[] = [];
let selectedFace: PlayerHeadAtlasFace | null = null;
let selectedCanvas: HTMLCanvasElement | null = null;
let moveMode: 'uv' | 'texture' | 'both' = 'uv';
const selectedRegions = new Map<string, AtlasRegion>();
let cancelUvDrag: (() => void) | null = null;
let cancelPaintSelection: (() => void) | null = null;
let cancelAtlasPan: (() => void) | null = null;
const paintSelections = new WeakMap<HTMLCanvasElement, HeadUvRect>();
const textureRegions = new WeakMap<HTMLCanvasElement, Map<string, AtlasRegion>>();
let nextTextureRegionId = 0;
let refreshPaintSelection = () => {};
let refreshUvEditor = () => {};
type AtlasAction = 'duplicate' | 'deleteSelection' | 'selectAll' | 'flipX' | 'flipY';
let runAtlasAction: (action: AtlasAction) => void = () => {};
let selectAtlasRegion: (canvas: HTMLCanvasElement, rect: HeadUvRect, append: boolean, toggle: boolean) => void = () => {};
let readPaintTarget: (event: PointerEvent) => HeadAtlasPaintTarget | null = () => null;
let painterGrid: HeadAtlasPainterGrid | null = null;
let refreshPainterGrid = () => {};
let refreshPainterPreview: (canvas: HTMLCanvasElement | null, pixels: readonly { x: number; y: number }[]) => void = () => {};
const isAtlasPainting = (): boolean => !!playerHeadAtlasScroll.dataset.headPainterTool && playerHeadAtlasScroll.dataset.headPainterTool !== 'select';
const moveTools = playerHeadAtlasScroll.querySelector<HTMLElement>('.player-head-atlas-tools')!;
const moveLabels = { uv: 'UV만 이동', texture: '텍스처만 이동', both: 'UV와 텍스처 함께 이동' };
for (const button of moveTools.querySelectorAll<HTMLButtonElement>('[data-atlas-move-mode]')) {
    const mode = button.dataset.atlasMoveMode as typeof moveMode;
    button.addEventListener('click', () => {
        cancelUvDrag?.();
        button.focus({ preventScroll: true });
        if (mode !== moveMode) {
            cancelPaintSelection?.();
            selectedFace = null;
            selectedRegions.clear();
            if (selectedCanvas) paintSelections.delete(selectedCanvas);
            refreshPaintSelection();
            updateHeadAtlasPaintPreview();
        }
        moveMode = mode;
        moveTools.querySelectorAll('[data-atlas-move-mode]').forEach(option => option.ariaPressed = String(option === button));
        refreshUvEditor();
    });
}
playerHeadAtlasScroll.tabIndex = 0;
const actionButtons = moveTools.querySelectorAll<HTMLButtonElement>('[data-atlas-action]');
for (const button of actionButtons) button.addEventListener('click', () => runAtlasAction(button.dataset.atlasAction as AtlasAction));
const updateActionButtons = () => {
    for (const button of actionButtons) {
        const action = button.dataset.atlasAction as Exclude<AtlasAction, 'selectAll'>;
        const label = { duplicate: '선택 영역 복제', deleteSelection: '선택 영역 텍스처 삭제', flipX: 'X축 반전 (좌우)', flipY: 'Y축 반전 (상하)' }[action];
        const shortcut = action === 'duplicate' || action === 'deleteSelection' ? ` (${getShortcuts(action).join(' / ') || '단축키 미설정'})` : '';
        button.title = label + shortcut;
        button.ariaLabel = button.title;
        button.disabled = !selectedRegions.size || isAtlasPainting() || !!cancelUvDrag;
    }
};
window.addEventListener('pde:shortcuts-changed', () => { updateActionButtons(); refreshUvEditor(); });

const overlaps = (a: HeadUvRect, b: HeadUvRect) => a.x < b.x + b.width && a.x + a.width > b.x
    && a.y < b.y + b.height && a.y + a.height > b.y;
const selectionBounds = (rects: HeadUvRect[]): HeadUvRect => {
    let x = Infinity, y = Infinity, right = 0, bottom = 0;
    for (const rect of rects) {
        x = Math.min(x, rect.x); y = Math.min(y, rect.y);
        right = Math.max(right, rect.x + rect.width); bottom = Math.max(bottom, rect.y + rect.height);
    }
    return { x, y, width: right - x, height: bottom - y };
};

export function getHeadAtlasPaintTarget(event: PointerEvent): HeadAtlasPaintTarget | null {
    return readPaintTarget(event);
}

export function updateHeadAtlasPainterGrid(grid: HeadAtlasPainterGrid): void {
    painterGrid = grid;
    refreshPainterGrid();
}

export function updateHeadAtlasPaintPreview(canvas: HTMLCanvasElement | null = null, pixels: readonly { x: number; y: number }[] = []): void {
    refreshPainterPreview(canvas, pixels);
}

export function isHeadAtlasPaintPixelSelected(canvas: HTMLCanvasElement, x: number, y: number): boolean {
    const rect = paintSelections.get(canvas);
    return !rect || (x >= rect.x && y >= rect.y && x < rect.x + rect.width && y < rect.y + rect.height);
}

export function isHeadAtlasPaintSelecting(): boolean {
    return !!cancelPaintSelection;
}

export function clearHeadAtlasPaintSelectionOutside(event: PointerEvent): boolean {
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || !(event.target instanceof Element)) return false;
    const canvas = event.target.closest('.player-head-atlas-stage')?.querySelector<HTMLCanvasElement>('canvas');
    if (!canvas || !paintSelections.has(canvas)) return false;
    const bounds = canvas.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return false;
    const x = Math.floor((event.clientX - bounds.left) / bounds.width * canvas.width);
    const y = Math.floor((event.clientY - bounds.top) / bounds.height * canvas.height);
    if (isHeadAtlasPaintPixelSelected(canvas, x, y)) return false;
    paintSelections.delete(canvas);
    refreshPaintSelection();
    updateHeadAtlasPaintPreview();
    event.preventDefault();
    event.stopImmediatePropagation();
    return true;
}

export function startHeadAtlasPaintSelection(event: PointerEvent, onClick?: () => void): boolean {
    if (event.button !== 0 || (!event.ctrlKey && !event.metaKey) || !(event.target instanceof Element)) return false;
    const canvas = event.target.closest('.player-head-atlas-stage')?.querySelector<HTMLCanvasElement>('canvas');
    if (!canvas) return false;
    const bounds = canvas.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return false;
    cancelPaintSelection?.();
    cancelUvDrag?.();
    playerHeadAtlasScroll.focus({ preventScroll: true });
    const previous = paintSelections.get(canvas);
    const position = (next: PointerEvent) => ({
        x: Math.max(0, Math.min(canvas.width - 1, Math.floor((next.clientX - bounds.left) / bounds.width * canvas.width))),
        y: Math.max(0, Math.min(canvas.height - 1, Math.floor((next.clientY - bounds.top) / bounds.height * canvas.height)))
    });
    const start = position(event);
    let dragged = false;
    const move = (next: PointerEvent) => {
        if (next.pointerId !== event.pointerId) return;
        const end = position(next);
        dragged ||= end.x !== start.x || end.y !== start.y || Math.hypot(next.clientX - event.clientX, next.clientY - event.clientY) >= 4;
        if (!dragged) return;
        paintSelections.set(canvas, { x: Math.min(start.x, end.x), y: Math.min(start.y, end.y),
            width: Math.abs(end.x - start.x) + 1, height: Math.abs(end.y - start.y) + 1 });
        refreshPaintSelection();
        updateHeadAtlasPaintPreview();
        next.preventDefault();
    };
    const finish = (cancelled: boolean, next?: PointerEvent) => {
        if (next && !cancelled) move(next);
        cancelPaintSelection = null;
        window.removeEventListener('pointermove', move, true);
        window.removeEventListener('pointerup', up, true);
        window.removeEventListener('pointercancel', up, true);
        window.removeEventListener('blur', cancel);
        if (cancelled) {
            if (previous) paintSelections.set(canvas, previous);
            else paintSelections.delete(canvas);
        } else if (!isAtlasPainting()) {
            const rect = paintSelections.get(canvas) ?? { ...start, width: 1, height: 1 };
            selectAtlasRegion(canvas, rect, !dragged || event.shiftKey, !dragged);
            paintSelections.delete(canvas);
        }
        refreshPaintSelection();
        if (!cancelled && !dragged) onClick?.();
    };
    const up = (next: PointerEvent) => {
        if (next.pointerId !== event.pointerId) return;
        finish(next.type === 'pointercancel', next);
    };
    const cancel = () => finish(true);
    cancelPaintSelection = cancel;
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', up, true);
    window.addEventListener('blur', cancel);
    updateHeadAtlasPaintPreview();
    event.preventDefault();
    event.stopImmediatePropagation();
    return true;
}

function attachUvEditor(canvas: HTMLCanvasElement, stage: HTMLElement): void {
    let faces = getPlayerHeadAtlasFaces(canvas);
    let facesDirty = false;
    let atlasTextureRegions = textureRegions.get(canvas);
    if (!atlasTextureRegions) textureRegions.set(canvas, atlasTextureRegions = new Map());
    const faceKey = (face: PlayerHeadAtlasFace) => `${face.x},${face.y}`;
    let facesByKey = new Map(faces.map(face => [faceKey(face), face]));
    const regionFor = (face: PlayerHeadAtlasFace, rect: HeadUvRect): AtlasRegion => ({ faceX: face.x, faceY: face.y, rect });
    const nativeTextureRect = (face: PlayerHeadAtlasFace): HeadUvRect => ({ x: face.x, y: face.y, width: 8, height: 8 });
    const getSelectionRect = (face: PlayerHeadAtlasFace) => getHeadAtlasUvRect(canvas, face.x, face.y);
    const getSelectedEntries = () => [...selectedRegions].flatMap(([key, region]) => {
        const face = facesByKey.get(`${region.faceX},${region.faceY}`);
        return face ? [{ key, face, rect: moveMode === 'texture' ? region.rect : getSelectionRect(face) }] : [];
    });
    const hasPixels = (rect: HeadUvRect) => canvas.getContext('2d')!.getImageData(rect.x, rect.y, rect.width, rect.height)
        .data.some((value, index) => index % 4 === 3 && value > 0);
    const getTextureEntries = (bounds?: HeadUvRect) => {
        const entries = [...atlasTextureRegions].flatMap(([key, region]) => {
            const face = facesByKey.get(`${region.faceX},${region.faceY}`);
            return face ? [{ key, face, rect: region.rect }] : [];
        });
        for (const face of faces) for (const rect of [nativeTextureRect(face), getSelectionRect(face)]) {
            if (!bounds || overlaps(rect, bounds)) entries.push({ key: `${faceKey(face)}@${JSON.stringify(rect)}`, face, rect });
        }
        const seen = new Set<string>();
        return entries.filter(({ rect }) => {
            if (bounds && !overlaps(rect, bounds)) return false;
            const key = JSON.stringify(rect);
            if (seen.has(key)) return false;
            seen.add(key);
            return hasPixels(rect);
        });
    };
    const registerTextureEntry = (entry: ReturnType<typeof getSelectedEntries>[number]) => {
        if (atlasTextureRegions.has(entry.key)) return entry;
        const key = `texture-${nextTextureRegionId++}`;
        atlasTextureRegions.set(key, regionFor(entry.face, entry.rect));
        return { ...entry, key };
    };
    selectedFace = canvas === selectedCanvas ? faces.find(face => face.x === selectedFace?.x && face.y === selectedFace?.y) ?? null : null;
    selectedCanvas = canvas;
    const paintSelection = document.createElement('div');
    paintSelection.className = 'player-head-paint-selection';
    paintSelection.setAttribute('aria-hidden', 'true');
    stage.append(paintSelection);
    refreshPaintSelection = () => {
        const rect = paintSelections.get(canvas);
        paintSelection.hidden = !rect;
        if (!rect) return;
        paintSelection.style.left = `${rect.x / canvas.width * 100}%`;
        paintSelection.style.top = `${rect.y / canvas.height * 100}%`;
        paintSelection.style.width = `${rect.width / canvas.width * 100}%`;
        paintSelection.style.height = `${rect.height / canvas.height * 100}%`;
    };
    refreshPaintSelection();
    const grid = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    grid.classList.add('player-head-paint-grid');
    grid.setAttribute('viewBox', `0 0 ${canvas.width} ${canvas.height}`);
    grid.setAttribute('aria-hidden', 'true');
    const gridLines = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    gridLines.setAttribute('vector-effect', 'non-scaling-stroke');
    grid.append(gridLines);
    stage.append(grid);
    const preview = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    preview.classList.add('player-head-paint-preview');
    preview.setAttribute('viewBox', `0 0 ${canvas.width} ${canvas.height}`);
    preview.setAttribute('aria-hidden', 'true');
    const previewCells = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    previewCells.setAttribute('vector-effect', 'non-scaling-stroke');
    preview.append(previewCells);
    stage.append(preview);
    refreshPainterPreview = (targetCanvas, pixels) => {
        const visible = targetCanvas === canvas && isAtlasPainting() && pixels.length > 0;
        preview.style.display = visible ? '' : 'none';
        previewCells.setAttribute('d', visible ? pixels.map(({ x, y }) => `M${x} ${y}h1v1h-1Z`).join('') : '');
    };
    updateHeadAtlasPaintPreview();
    const selection = document.createElement('div');
    selection.className = 'player-head-uv-selection';
    selection.tabIndex = 0;
    selection.setAttribute('role', 'group');
    const handleNames = { nw: '왼쪽 위', n: '위', ne: '오른쪽 위', e: '오른쪽', se: '오른쪽 아래', s: '아래', sw: '왼쪽 아래', w: '왼쪽' };
    for (const [handle, name] of Object.entries(handleNames)) {
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.uvHandle = handle;
        button.ariaLabel = `${name} UV 크기 조절`;
        selection.append(button);
    }
    stage.append(selection);
    const outlines = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    outlines.classList.add('player-head-uv-outlines');
    outlines.setAttribute('viewBox', `0 0 ${canvas.width} ${canvas.height}`);
    outlines.setAttribute('aria-hidden', 'true');
    const outlineRects = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    outlineRects.setAttribute('vector-effect', 'non-scaling-stroke');
    outlines.append(outlineRects);
    stage.append(outlines);
    const caption = document.createElement('div');
    caption.className = 'player-head-uv-caption';
    caption.setAttribute('aria-live', 'polite');
    moveTools.after(caption);
    const refresh = () => {
        refreshPainterGrid();
        updateActionButtons();
        const label = moveLabels[moveMode];
        const entries = getSelectedEntries();
        const canResize = moveMode === 'uv' && entries.length === 1;
        selection.dataset.selectedCount = String(entries.length);
        selection.ariaLabel = `${entries.length}개 영역 ${label}: 방향키로 이동${canResize ? ', Shift+방향키로 크기 조절' : ''}`;
        selection.querySelectorAll('button').forEach(button => button.hidden = !canResize);
        selection.hidden = !selectedFace || isAtlasPainting();
        outlines.style.display = entries.length > 1 && !isAtlasPainting() ? '' : 'none';
        outlineRects.setAttribute('d', entries.map(({ rect }) => `M${rect.x} ${rect.y}h${rect.width}v${rect.height}h-${rect.width}Z`).join(''));
        if (isAtlasPainting()) {
            caption.textContent = '우클릭 드래그: 화면 이동 · Ctrl+드래그: 영역 선택 · Esc / 영역 밖 클릭: 선택 해제 · 선택 도구: 아틀라스 이동';
            return;
        }
        const shortcuts = `${getShortcuts('selectAll').join(' / ')}: 전체 선택 · ${getShortcuts('duplicate').join(' / ')}: 복제 · ${getShortcuts('deleteSelection').join(' / ')}: 텍스처 삭제`;
        caption.textContent = `Shift+클릭 / Ctrl+드래그: 다중 선택 · ${shortcuts} · 우클릭 드래그: 화면 이동`;
        if (!selectedFace || !entries.length) return;
        const rect = selectionBounds(entries.map(entry => entry.rect));
        selection.style.left = `${rect.x / canvas.width * 100}%`;
        selection.style.top = `${rect.y / canvas.height * 100}%`;
        selection.style.width = `${rect.width / canvas.width * 100}%`;
        selection.style.height = `${rect.height / canvas.height * 100}%`;
        caption.textContent = `${entries.length === 1 ? selectedFace.name : `${entries.length}개 영역 선택`} · X ${rect.x}, Y ${rect.y} · ${rect.width} × ${rect.height} px · ${label} · ${shortcuts}${canResize ? ' · 테두리: 크기 조절' : ''}`;
    };
    const startEdit = (entries: ReturnType<typeof getSelectedEntries>, operation: 'move' | 'duplicate' | 'delete' | 'flipX' | 'flipY' = 'move') => {
        const mode = moveMode;
        const context = canvas.getContext('2d')!;
        const originals = entries.map(entry => entry.rect);
        const readPixels = (rects: HeadUvRect[]) => rects.map(rect => context.getImageData(rect.x, rect.y, rect.width, rect.height));
        const putPixels = (pixels: ImageData[], rects: HeadUvRect[]) => pixels.forEach((image, index) => context.putImageData(image, rects[index].x, rects[index].y));
        const sourcePixels = mode === 'uv' && operation === 'move' ? null : readPixels(originals);
        const flipping = operation === 'flipX' || operation === 'flipY';
        const editedPixels = sourcePixels?.map(image => {
            if (!flipping) return image;
            const flipped = new ImageData(image.width, image.height);
            for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
                const sourceX = operation === 'flipX' ? image.width - 1 - x : x;
                const sourceY = operation === 'flipY' ? image.height - 1 - y : y;
                const offset = (sourceY * image.width + sourceX) * 4;
                flipped.data.set(image.data.subarray(offset, offset + 4), (y * image.width + x) * 4);
            }
            return flipped;
        });
        const changesUv = mode !== 'texture' && operation !== 'delete' && !flipping;
        let current = originals;
        let destinationPixels: ImageData[] = [];
        const updateRects = (rects: HeadUvRect[]) => entries.forEach(({ key, face }, index) => {
            if (changesUv) setHeadAtlasUvRect(canvas, face.x, face.y, rects[index]);
            if (mode === 'texture') selectedRegions.set(key, regionFor(face, rects[index]));
        });
        const restore = () => {
            if (sourcePixels) {
                putPixels(destinationPixels, current);
                putPixels(sourcePixels, originals);
                entries[0].face.surfaces[0].texture.needsUpdate = true;
            }
            destinationPixels = [];
            updateRects(originals);
        };
        const move = (rects: HeadUvRect[]) => {
            restore();
            if (sourcePixels) {
                destinationPixels = readPixels(rects);
                if (operation !== 'duplicate') originals.forEach(rect => context.clearRect(rect.x, rect.y, rect.width, rect.height));
                if (operation !== 'delete') putPixels(editedPixels!, rects);
            }
            updateRects(rects);
            current = rects;
            refresh();
        };
        const finish = (cancelled: boolean) => {
            const destination = current;
            restore();
            if (cancelled || operation === 'move' && JSON.stringify(destination) === JSON.stringify(originals)) { refresh(); return; }
            const regions = operation === 'delete' || flipping ? originals : [...originals, ...destination];
            const selectedKeys = new Set(entries.map(({ face }) => faceKey(face)));
            const surfaces = [...new Map((sourcePixels ? faces.filter(other => {
                const rect = getHeadAtlasUvRect(canvas, other.x, other.y);
                return selectedKeys.has(faceKey(other)) || regions.some(region => overlaps(rect, region));
            }) : entries.map(entry => entry.face)).flatMap(other => other.surfaces.map(surface => [surface.objectUuid, surface] as const))).values()];
            const uuids = surfaces.map(surface => surface.objectUuid);
            const before = capturePlayerHeadAtlasState(uuids);
            const pixelsBefore = sourcePixels ? readPixels(regions) : [];
            move(destination);
            const registryBefore = new Map<string, AtlasRegion | undefined>();
            const registryAfter = new Map<string, AtlasRegion | undefined>();
            const nextKeys = entries.map(entry => entry.key);
            if (sourcePixels && operation !== 'delete' && !flipping) {
                const knownRegions = new Map([...atlasTextureRegions].map(([key, region]) => [JSON.stringify(region.rect), key]));
                entries.forEach(({ key, face, rect }, index) => {
                    const sourceKey = atlasTextureRegions.has(key) ? key : knownRegions.get(JSON.stringify(rect)) ?? `texture-${nextTextureRegionId++}`;
                    const targetKey = operation === 'duplicate' ? `texture-${nextTextureRegionId++}` : sourceKey;
                    for (const regionKey of [sourceKey, targetKey]) registryBefore.set(regionKey, atlasTextureRegions.get(regionKey));
                    if (operation === 'duplicate') registryAfter.set(sourceKey, regionFor(face, rect));
                    registryAfter.set(targetKey, regionFor(face, destination[index]));
                    if (mode === 'texture') nextKeys[index] = targetKey;
                });
            }
            const setRegions = (regions: Map<string, AtlasRegion | undefined>) => regions.forEach((region, key) => {
                if (region) atlasTextureRegions.set(key, region);
                else atlasTextureRegions.delete(key);
            });
            const updateSelection = (rects: HeadUvRect[], from: string[], to: string[]) => {
                if (selectedCanvas !== canvas || moveMode !== 'texture' || mode !== 'texture') return;
                entries.forEach(({ face }, index) => {
                    if (!selectedRegions.has(from[index])) return;
                    selectedRegions.delete(from[index]);
                    selectedRegions.set(to[index], regionFor(face, rects[index]));
                });
            };
            const originalKeys = entries.map(entry => entry.key);
            setRegions(registryAfter);
            updateSelection(destination, originalKeys, nextKeys);
            const pixelsAfter = sourcePixels ? readPixels(regions) : [];
            surfaces.forEach(surface => commitPlayerHeadPaint(surface));
            const after = capturePlayerHeadAtlasState(uuids);
            const apply = (state: typeof before, pixels: ImageData[], rects: HeadUvRect[], registry: Map<string, AtlasRegion | undefined>, from: string[], to: string[]) => {
                setRegions(registry);
                updateSelection(rects, from, to);
                restorePlayerHeadAtlasState(state);
                putPixels(pixels, regions);
                entries[0].face.surfaces[0].texture.needsUpdate = true;
                window.dispatchEvent(new Event('pde:scene-updated'));
            };
            record({ undo: () => apply(before, pixelsBefore, originals, registryBefore, nextKeys, originalKeys), redo: () => apply(after, pixelsAfter, destination, registryAfter, originalKeys, nextKeys) });
            window.dispatchEvent(new Event('pde:scene-updated'));
        };
        return { move, finish };
    };
    const refreshFaces = () => {
        if (!facesDirty) return;
        faces = getPlayerHeadAtlasFaces(canvas);
        facesByKey = new Map(faces.map(face => [faceKey(face), face]));
        for (const [key, region] of selectedRegions) {
            if (!facesByKey.has(`${region.faceX},${region.faceY}`) || key.startsWith('texture-') && !atlasTextureRegions.has(key)) selectedRegions.delete(key);
        }
        const selectedFaces = getSelectedEntries().map(entry => entry.face);
        selectedFace = selectedFaces.find(face => face.x === selectedFace?.x && face.y === selectedFace?.y) ?? selectedFaces[0] ?? null;
        facesDirty = false;
    };
    selectAtlasRegion = (targetCanvas, rect, append, toggle) => {
        if (targetCanvas !== canvas) return;
        refreshFaces();
        if (!append) selectedRegions.clear();
        const matches = moveMode === 'texture' ? getTextureEntries(rect)
            : faces.map(face => ({ key: faceKey(face), face, rect: getSelectionRect(face) })).filter(entry => overlaps(rect, entry.rect));
        for (const candidate of toggle ? matches.slice(0, 1) : matches) {
            const { key, face, rect } = moveMode === 'texture' ? registerTextureEntry(candidate) : candidate;
            if (toggle && selectedRegions.has(key)) selectedRegions.delete(key);
            else { selectedRegions.set(key, regionFor(face, rect)); selectedFace = face; }
        }
        facesDirty = true;
        refreshFaces();
        refresh();
        if (!selection.hidden) selection.focus({ preventScroll: true });
    };
    const transformSelection = (entries: ReturnType<typeof getSelectedEntries>, handle: string, dx: number, dy: number) => {
        const bounds = selectionBounds(entries.map(entry => entry.rect));
        const next = transformHeadUvRect(bounds, entries.length === 1 ? handle : '', dx, dy, canvas.width);
        return entries.length === 1 ? [next] : entries.map(({ rect }) => ({ ...rect, x: rect.x + next.x - bounds.x, y: rect.y + next.y - bounds.y }));
    };
    runAtlasAction = action => {
        if (cancelUvDrag || cancelPaintSelection || isAtlasPainting() || isApplying()) return;
        refreshFaces();
        if (action === 'selectAll') {
            const entries = moveMode === 'texture' ? getTextureEntries().map(registerTextureEntry)
                : faces.map(face => ({ key: faceKey(face), face, rect: getSelectionRect(face) }));
            selectedRegions.clear();
            entries.forEach(({ key, face, rect }) => selectedRegions.set(key, regionFor(face, rect)));
            selectedFace = entries[0]?.face ?? null;
            refresh();
            if (selectedFace) selection.focus({ preventScroll: true });
            return;
        }
        const entries = getSelectedEntries();
        if (!entries.length) return;
        const originals = entries.map(entry => entry.rect);
        let destination = originals;
        if (action === 'duplicate') {
            const context = canvas.getContext('2d')!;
            const bounds = selectionBounds(originals);
            const findDestination = (x: number, y: number) => {
                const next = { ...bounds, x, y };
                if (x < 0 || y < 0 || x + bounds.width > canvas.width || y + bounds.height > canvas.height || overlaps(bounds, next)) return null;
                const rects = originals.map(rect => ({ ...rect, x: rect.x + x - bounds.x, y: rect.y + y - bounds.y }));
                for (const rect of rects) {
                    const pixels = context.getImageData(rect.x, rect.y, rect.width, rect.height).data;
                    for (let alpha = 3; alpha < pixels.length; alpha += 4) if (pixels[alpha]) return null;
                }
                return rects;
            };
            let copy = findDestination(bounds.x + bounds.width, bounds.y)
                ?? findDestination(bounds.x, bounds.y + bounds.height)
                ?? findDestination(bounds.x - bounds.width, bounds.y)
                ?? findDestination(bounds.x, bounds.y - bounds.height);
            // ponytail: scan by group size; a packing search is only needed for crowded, irregular selections.
            for (let y = 0; !copy && y + bounds.height <= canvas.height; y += bounds.height) {
                for (let x = 0; !copy && x + bounds.width <= canvas.width; x += bounds.width) copy = findDestination(x, y);
            }
            if (!copy) { caption.textContent = '선택 영역을 복제할 빈 공간이 없습니다.'; return; }
            destination = copy;
        }
        const edit = startEdit(entries, action === 'deleteSelection' ? 'delete' : action);
        edit.move(destination);
        edit.finish(false);
        selection.focus({ preventScroll: true });
    };
    refreshPainterGrid = () => {
        const visible = isAtlasPainting() && !!painterGrid?.enabled;
        grid.style.display = visible ? '' : 'none';
        if (!visible) return;
        refreshFaces();
        grid.style.color = painterGrid!.color;
        const lines: string[] = [];
        for (const face of faces) {
            const rect = getHeadAtlasUvRect(canvas, face.x, face.y);
            const [columns, rows] = painterGrid!.getFaceGridCounts(face);
            if (columns) for (let column = 0; column <= columns; column++) {
                const x = rect.x + Math.round(column * rect.width / columns);
                lines.push(`M${x} ${rect.y}V${rect.y + rect.height}`);
            }
            if (rows) for (let row = 0; row <= rows; row++) {
                const y = rect.y + Math.round(row * rect.height / rows);
                lines.push(`M${rect.x} ${y}H${rect.x + rect.width}`);
            }
        }
        gridLines.setAttribute('d', lines.join(''));
    };
    readPaintTarget = event => {
        if (!(event.target instanceof Element) || !stage.contains(event.target)) return null;
        refreshFaces();
        const bounds = canvas.getBoundingClientRect();
        if (!bounds.width || !bounds.height) return null;
        const x = Math.floor((event.clientX - bounds.left) / bounds.width * canvas.width);
        const y = Math.floor((event.clientY - bounds.top) / bounds.height * canvas.height);
        if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) return null;
        const contains = (face: PlayerHeadAtlasFace) => {
            const rect = getHeadAtlasUvRect(canvas, face.x, face.y);
            return x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
        };
        const face = (selectedFace && contains(selectedFace) ? selectedFace : faces.find(contains)) ?? null;
        return { canvas, faces, face, rect: face ? getHeadAtlasUvRect(canvas, face.x, face.y) : null, x, y };
    };
    refreshUvEditor = () => {
        facesDirty = true;
        if (stage.offsetParent) refreshFaces();
        refresh();
    };
    stage.addEventListener('pointerdown', event => {
        refreshFaces();
        if (clearHeadAtlasPaintSelectionOutside(event)) return;
        if (startHeadAtlasPaintSelection(event)) return;
        if (event.button !== 0 || cancelUvDrag || isAtlasPainting()) return;
        refreshUvEditor();
        const bounds = canvas.getBoundingClientRect();
        const x = (event.clientX - bounds.left) / bounds.width * canvas.width;
        const y = (event.clientY - bounds.top) / bounds.height * canvas.height;
        const target = event.target as HTMLElement;
        if (!selection.contains(target) || event.shiftKey) {
            const contains = (rect: HeadUvRect) => x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
            let entry = getSelectedEntries().find(entry => contains(entry.rect) && (moveMode !== 'texture' || hasPixels(entry.rect)));
            if (moveMode === 'texture') {
                entry ??= getTextureEntries({ x: Math.floor(x), y: Math.floor(y), width: 1, height: 1 })[0];
                if (entry) entry = registerTextureEntry(entry);
            } else if (!entry) {
                const face = faces.find(face => contains(getSelectionRect(face)));
                if (face) entry = { key: faceKey(face), face, rect: getSelectionRect(face) };
            }
            if (event.shiftKey) {
                if (entry) {
                    if (selectedRegions.has(entry.key)) selectedRegions.delete(entry.key);
                    else selectedRegions.set(entry.key, regionFor(entry.face, entry.rect));
                }
            } else {
                if (!entry || !selectedRegions.has(entry.key)) selectedRegions.clear();
                if (entry) selectedRegions.set(entry.key, regionFor(entry.face, entry.rect));
            }
            selectedFace = entry && selectedRegions.has(entry.key) ? entry.face : getSelectedEntries()[0]?.face ?? null;
            refresh();
        }
        if (!selectedFace) { playerHeadAtlasScroll.focus({ preventScroll: true }); return; }
        event.preventDefault();
        selection.focus({ preventScroll: true });
        if (event.shiftKey) return;
        const entries = getSelectedEntries();
        const edit = startEdit(entries);
        const handle = moveMode === 'uv' && entries.length === 1 ? target.dataset.uvHandle ?? '' : '';
        const pointerId = event.pointerId;
        const startX = event.clientX;
        const startY = event.clientY;
        const move = (next: PointerEvent) => {
            if (next.pointerId !== pointerId) return;
            const rects = transformSelection(entries, handle,
                (next.clientX - startX) / bounds.width * canvas.width,
                (next.clientY - startY) / bounds.height * canvas.height);
            edit.move(rects);
        };
        const finish = (cancel: boolean) => {
            cancelUvDrag = null;
            stage.removeEventListener('pointermove', move);
            stage.removeEventListener('pointerup', up);
            stage.removeEventListener('pointercancel', cancelPointer);
            stage.removeEventListener('lostpointercapture', cancelPointer);
            window.removeEventListener('keydown', escape, true);
            if (stage.hasPointerCapture(pointerId)) stage.releasePointerCapture(pointerId);
            edit.finish(cancel);
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
        updateActionButtons();
        stage.setPointerCapture(pointerId);
        stage.addEventListener('pointermove', move);
        stage.addEventListener('pointerup', up);
        stage.addEventListener('pointercancel', cancelPointer);
        stage.addEventListener('lostpointercapture', cancelPointer);
        window.addEventListener('keydown', escape, true);
    });
    selection.addEventListener('keydown', event => {
        refreshFaces();
        if (!selectedFace || cancelUvDrag || isAtlasPainting() || event.ctrlKey || event.metaKey || event.altKey) return;
        const delta = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
        if (!delta) return;
        event.preventDefault();
        event.stopPropagation();
        const entries = getSelectedEntries();
        if ((moveMode !== 'uv' || entries.length > 1) && event.shiftKey) return;
        const handle = moveMode === 'uv' ? (event.target as HTMLElement).dataset.uvHandle ?? (event.shiftKey ? 'se' : '') : '';
        const rects = transformSelection(entries, handle, delta[0], delta[1]);
        if (JSON.stringify(rects) === JSON.stringify(entries.map(entry => entry.rect))) return;
        const edit = startEdit(entries);
        edit.move(rects);
        edit.finish(false);
    });
    refresh();
}

const refreshPlayerHeadAtlasThumbnails = (): void => {
    playerHeadAtlasList.querySelectorAll<HTMLCanvasElement>('canvas').forEach((thumbnail, index) => {
        const context = thumbnail.getContext('2d');
        context?.clearRect(0, 0, thumbnail.width, thumbnail.height);
        context?.drawImage(playerHeadAtlasCanvases[index], 0, 0, thumbnail.width, thumbnail.height);
    });
};

const renderPlayerHeadAtlases = (canvases: HTMLCanvasElement[]): void => {
    const hadFocus = playerHeadAtlasScroll.contains(document.activeElement);
    cancelAtlasPan?.();
    cancelPaintSelection?.();
    cancelUvDrag?.();
    playerHeadAtlasCanvases = canvases;
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
    if (selectedCanvas !== canvas) selectedRegions.clear();
    playerHeadAtlasScroll.replaceChildren(box, moveTools, playerHeadAtlasList);
    if (canvas) attachUvEditor(canvas, stage);
    else {
        selectedFace = selectedCanvas = null;
        refreshUvEditor = () => {};
        readPaintTarget = () => null;
        refreshPainterGrid = () => {};
        refreshPainterPreview = () => {};
        refreshPaintSelection = () => {};
        runAtlasAction = () => {};
        selectAtlasRegion = () => {};
    }
    updateActionButtons();
    if (hadFocus) (stage.querySelector<HTMLElement>('.player-head-uv-selection:not([hidden])') ?? playerHeadAtlasScroll).focus({ preventScroll: true });
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
    refreshPlayerHeadAtlasThumbnails();
};

window.addEventListener('pde:player-head-atlases-changed', event => {
    renderPlayerHeadAtlases((event as CustomEvent<HTMLCanvasElement[]>).detail);
});

playerHeadAtlasScroll.addEventListener('pointerdown', event => {
    if (event.button !== 2 || !(event.target instanceof Element)) return;
    const box = event.target.closest<HTMLElement>('.player-head-atlas-box');
    if (!box?.querySelector('canvas')) return;
    cancelAtlasPan?.();
    cancelPaintSelection?.();
    cancelUvDrag?.();
    const scrollLeft = box.scrollLeft;
    const scrollTop = box.scrollTop;
    const move = (next: PointerEvent) => {
        if (next.pointerId !== event.pointerId) return;
        box.scrollLeft = scrollLeft - (next.clientX - event.clientX);
        box.scrollTop = scrollTop - (next.clientY - event.clientY);
        next.preventDefault();
        next.stopImmediatePropagation();
    };
    const finish = () => {
        cancelAtlasPan = null;
        box.classList.remove('panning');
        window.removeEventListener('pointermove', move, true);
        window.removeEventListener('pointerup', up, true);
        window.removeEventListener('pointercancel', up, true);
        window.removeEventListener('blur', finish);
    };
    const up = (next: PointerEvent) => {
        if (next.pointerId !== event.pointerId) return;
        if (next.type === 'pointerup') move(next);
        finish();
    };
    cancelAtlasPan = finish;
    box.classList.add('panning');
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', up, true);
    window.addEventListener('blur', finish);
    updateHeadAtlasPaintPreview();
    event.preventDefault();
    event.stopImmediatePropagation();
}, true);

playerHeadAtlasScroll.addEventListener('contextmenu', event => {
    if (!(event.target instanceof Element) || !event.target.closest('.player-head-atlas-box')) return;
    event.preventDefault();
    event.stopPropagation();
});

playerHeadAtlasScroll.addEventListener('wheel', event => {
    if (!(event.target instanceof Element)) return;
    const box = event.target.closest<HTMLElement>('.player-head-atlas-box');
    const canvas = box?.querySelector('canvas');
    if (!box || !canvas) return;
    event.preventDefault();
    if (cancelUvDrag || cancelPaintSelection || cancelAtlasPan) return;
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
    refreshPlayerHeadAtlasThumbnails();
});
window.addEventListener('pde:head-painter-tool-changed', () => {
    cancelAtlasPan?.();
    cancelPaintSelection?.();
    updateHeadAtlasPaintPreview();
    if (isAtlasPainting()) cancelUvDrag?.();
    refreshUvEditor();
});

window.addEventListener('keydown', event => {
    const target = event.target instanceof Element ? event.target : document.activeElement;
    if (!target?.closest('#player-head-atlas') || target.closest('input, textarea, select, [contenteditable="true"]')) return;
    const action = (['undo', 'redo', 'deleteSelection', 'selectAllObjects', 'selectAll', 'duplicate'] as const).find(id => matchesShortcut(event, id));
    if (!action) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (cancelUvDrag || cancelPaintSelection || cancelAtlasPan || isApplying()) return;
    if (action === 'undo' || action === 'redo') {
        void (action === 'undo' ? undo() : redo()).catch(error => console.error('Undo/Redo failed.', error));
    } else if (!event.repeat) runAtlasAction(action === 'selectAllObjects' ? 'selectAll' : action);
}, true);

window.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    if (cancelUvDrag) return;
    if (cancelPaintSelection && !isAtlasPainting()) {
        cancelPaintSelection();
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
    }
    const target = event.target instanceof Element ? event.target : document.activeElement;
    const clearFaces = !!target?.closest('#player-head-atlas') && !isAtlasPainting();
    if (!cancelPaintSelection && (!selectedCanvas || !paintSelections.has(selectedCanvas)) && (!clearFaces || !selectedRegions.size)) return;
    cancelPaintSelection?.();
    if (selectedCanvas) {
        paintSelections.delete(selectedCanvas);
        refreshPaintSelection();
        updateHeadAtlasPaintPreview();
    }
    if (clearFaces) { selectedRegions.clear(); selectedFace = null; refreshUvEditor(); playerHeadAtlasScroll.focus({ preventScroll: true }); }
    event.preventDefault();
});

renderPlayerHeadAtlases([]);

if (import.meta.env.DEV) {
    console.assert(clampPlayerHeadAtlasZoom(0) === 1 && clampPlayerHeadAtlasZoom(Infinity) === 256, 'Player head atlas zoom limits are broken.');
    console.assert(clampPlayerHeadAtlasIndex(2, 2) === 1 && clampPlayerHeadAtlasIndex(1, 0) === 0, 'Player head atlas selection limits are broken.');
}
