import './head-atlas-panel';

type DockSide = 'left' | 'right';
type PanelId = 'player-head-atlas' | 'scene-objects' | 'project-details' | 'head-painter';
type DropPlacement = { side: DockSide; index: number };

const panelIds: PanelId[] = ['player-head-atlas', 'scene-objects', 'project-details', 'head-painter'];
const panels = Object.fromEntries(panelIds.map(id => [id, document.getElementById(id)!])) as Record<PanelId, HTMLElement>;
const mainContent = document.getElementById('main-content')!;
const docks: Record<DockSide, HTMLElement> = {
    left: document.getElementById('left-panel-dock')!,
    right: document.getElementById('right-panel-dock')!
};
let dropPreview: HTMLElement | null = null;
let dropMeasureDock: HTMLElement | null = null;
let dropMeasurePanels: Record<PanelId, HTMLElement> | null = null;
let dropPreviewPlacement: DropPlacement | null = null;
let draggedPanelId: PanelId | null = null;
let dropPreviewPlacementKey = '';
let resizeFrame = 0;
let dragClientX = 0;
let dragClientY = 0;
let suppressPanelHeaderClickUntil = 0;

const oldSide: DockSide = localStorage.getItem('scene-panel-dock') === 'left' ? 'left' : 'right';
const headPainterAfterDetails = localStorage.getItem('pdeHeadPainterPanelOrder') === '["details","painter"]';
const oldOrder: PanelId[] = localStorage.getItem('project-details-first') === 'true'
    ? ['project-details', 'scene-objects']
    : ['scene-objects', 'project-details'];
oldOrder.splice(oldOrder.indexOf('project-details') + Number(headPainterAfterDetails), 0, 'head-painter');
let layout: Record<DockSide, PanelId[]> = oldSide === 'left'
    ? { left: ['player-head-atlas', ...oldOrder], right: [] }
    : { left: ['player-head-atlas'], right: oldOrder };
try {
    const saved = JSON.parse(localStorage.getItem('panel-layout') ?? 'null') as Partial<Record<DockSide, PanelId[]>> | null;
    const savedLayout: Record<DockSide, PanelId[]> = { left: saved?.left ?? [], right: saved?.right ?? [] };
    const ids = [...savedLayout.left, ...savedLayout.right];
    if (ids.length === panelIds.length && panelIds.every(id => ids.includes(id))) {
        layout = savedLayout;
    } else if (ids.length === panelIds.length - 1 && panelIds.filter(id => id !== 'head-painter').every(id => ids.includes(id))) {
        const side = savedLayout.left.includes('project-details') ? 'left' : 'right';
        savedLayout[side].splice(savedLayout[side].indexOf('project-details') + Number(headPainterAfterDetails), 0, 'head-painter');
        layout = savedLayout;
    }
} catch {
    // Ignore invalid saved layout and use the previous panel preference.
}
if (import.meta.env.DEV) {
    const ids = [...layout.left, ...layout.right];
    console.assert(ids.length === panelIds.length && panelIds.every(id => ids.includes(id)), 'Panel layout validation failed.');
}

function applyLayout(): void {
    mainContent.style.left = docks.left.classList.contains('empty') ? '0' : `${docks.left.offsetWidth}px`;
    mainContent.style.right = docks.right.classList.contains('empty') ? '0' : `${docks.right.offsetWidth}px`;
    Object.values(docks).forEach(syncDockResizer);
    if (!resizeFrame) resizeFrame = requestAnimationFrame(() => {
        resizeFrame = 0;
        window.dispatchEvent(new Event('resize'));
    });
}

function syncDockResizer(dock: HTMLElement): void {
    const resizer = dock.querySelector<HTMLElement>('.scene-resizer')!;
    const rect = dock.getBoundingClientRect();
    resizer.style.left = `${dock.classList.contains('dock-left') ? rect.right : rect.left - 7}px`;
}

function getPanelFlexBasis(id: PanelId, index: number, panelCount: number): string {
    return index < panelCount - 1
        ? localStorage.getItem(`panel-height-${id}`) ?? (id === 'scene-objects' ? localStorage.getItem('scene-objects-height') ?? '' : '')
        : '';
}

function renderLayout(): void {
    const scrollPositions = new Map<HTMLElement, number>([...Object.values(docks), ...Object.values(panels)].flatMap(panel =>
        [panel, ...panel.querySelectorAll<HTMLElement>('#player-head-atlas-scroll, #scene-object-list, .head-painter-color-area')]
            .map(element => [element, element.scrollTop] as const)
    ));
    for (const side of ['left', 'right'] as DockSide[]) {
        const dock = docks[side];
        const resizer = dock.querySelector<HTMLElement>('.scene-resizer')!;
        const dockPanels = layout[side].map(id => panels[id]);
        const visiblePanels = dockPanels.filter(panel => !panel.hidden);
        const children = dockPanels.flatMap(panel => {
            if (panel.hidden) return [];
            const index = visiblePanels.indexOf(panel);
            const flexBasis = getPanelFlexBasis(panel.id as PanelId, index, visiblePanels.length);
            panel.style.flex = index === visiblePanels.length - 1 ? '1 1 0' : flexBasis ? `0 0 ${flexBasis}` : '';
            panel.style.minHeight = visiblePanels.length > 1 ? '0' : '';
            if (!index) return [panel];
            const divider = document.createElement('div');
            divider.className = 'details-resizer';
            return [divider, panel];
        });
        dock.replaceChildren(resizer, ...children, ...dockPanels.filter(panel => panel.hidden));
        dock.classList.toggle('empty', visiblePanels.length === 0);
        dock.classList.toggle('single-panel', visiblePanels.length === 1);
    }
    for (const [element, scrollTop] of scrollPositions) element.scrollTop = scrollTop;
    localStorage.setItem('panel-layout', JSON.stringify(layout));
    applyLayout();
}

for (const side of ['left', 'right'] as DockSide[]) {
    const dock = docks[side];
    dock.style.width = localStorage.getItem(`panel-width-${side}`) ?? localStorage.getItem('scene-panel-width') ?? '';
    dock.classList.toggle('minimized', dock.style.width === '0px');
    dock.querySelector<HTMLElement>('.scene-resizer')!.addEventListener('mousedown', (event) => {
        event.preventDefault();
        const startX = event.clientX;
        const startWidth = dock.offsetWidth;
        const direction = side === 'left' ? 1 : -1;
        const wasMinimized = dock.classList.contains('minimized');
        let minimize = wasMinimized;
        let restore = false;

        const move = (moveEvent: MouseEvent): void => {
            if (wasMinimized) {
                restore = direction * (moveEvent.clientX - startX) >= 140;
                dock.classList.toggle('restore-preview', restore);
                return;
            }
            const width = Math.max(280, Math.min(600, startWidth + direction * (moveEvent.clientX - startX)));
            minimize = side === 'left'
                ? moveEvent.clientX <= window.innerWidth * 0.1
                : moveEvent.clientX >= window.innerWidth * 0.9;
            dock.classList.remove('minimized');
            dock.classList.toggle('minimize-preview', minimize);
            dock.style.width = `${width}px`;
            applyLayout();
        };
        const stop = (): void => {
            dock.classList.remove('minimize-preview');
            dock.classList.remove('restore-preview');
            minimize = wasMinimized ? !restore : minimize;
            dock.classList.toggle('minimized', minimize);
            if (minimize) dock.style.width = '0px';
            else if (wasMinimized) dock.style.width = '280px';
            applyLayout();
            window.removeEventListener('mousemove', move);
            window.removeEventListener('mouseup', stop);
            localStorage.setItem(`panel-width-${side}`, dock.style.width);
        };
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', stop);
    });

    dock.addEventListener('mousedown', (event) => {
        const divider = (event.target as Element).closest<HTMLElement>('.details-resizer');
        if (!divider || divider.parentElement !== dock) return;
        event.preventDefault();
        const panel = divider.previousElementSibling as HTMLElement;
        for (const adjacentPanel of [panel, divider.nextElementSibling as HTMLElement]) {
            if (!adjacentPanel.classList.contains('collapsed')) continue;
            adjacentPanel.classList.remove('collapsed');
            adjacentPanel.firstElementChild?.setAttribute('aria-expanded', 'true');
            localStorage.setItem(`panel-collapsed-${adjacentPanel.id}`, 'false');
        }
        const visiblePanels = [...dock.querySelectorAll<HTMLElement>('.panel-section:not([hidden])')];
        const followingPanels = visiblePanels.slice(visiblePanels.indexOf(panel) + 1);
        const startY = event.clientY;
        const startHeight = panel.offsetHeight;
        const minHeight = 0;
        const maxHeight = Math.max(minHeight, startHeight + followingPanels.reduce(
            (height, item) => height + item.offsetHeight - (item.classList.contains('collapsed') ? item.offsetHeight : minHeight), 0
        ));
        document.body.classList.add('resizing-details');

        const move = (moveEvent: MouseEvent): void => {
            const height = Math.max(minHeight, Math.min(maxHeight, startHeight + moveEvent.clientY - startY));
            panel.style.flex = `0 0 ${height}px`;
        };
        const stop = (): void => {
            document.body.classList.remove('resizing-details');
            window.removeEventListener('mousemove', move);
            window.removeEventListener('mouseup', stop);
            localStorage.setItem(`panel-height-${panel.id}`, `${panel.offsetHeight}px`);
        };
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', stop);
    });
}

window.addEventListener('resize', () => Object.values(docks).forEach(syncDockResizer));

document.querySelectorAll<HTMLElement>('#player-head-atlas-header, #scene-panel-header, #project-details-header, #head-painter-header').forEach(header => {
    const panel = header.parentElement!;
    const toggleCollapsed = (): void => {
        const collapsed = panel.classList.toggle('collapsed');
        header.setAttribute('aria-expanded', String(!collapsed));
        localStorage.setItem(`panel-collapsed-${panel.id}`, String(collapsed));
        renderLayout();
    };
    panel.classList.toggle('collapsed', localStorage.getItem(`panel-collapsed-${panel.id}`) === 'true');
    header.setAttribute('aria-expanded', String(!panel.classList.contains('collapsed')));
    header.draggable = false;
    header.addEventListener('click', event => {
        if (Date.now() >= suppressPanelHeaderClickUntil && !(event.target as Element).closest('button, input, select, a')) toggleCollapsed();
    });
    header.addEventListener('pointerdown', event => {
        if (!event.isPrimary || event.button !== 0 || (event.target as Element).closest('button, input, select, a')) return;
        const pointerId = event.pointerId;
        const startX = event.clientX;
        const startY = event.clientY;
        let preview: HTMLElement | null = null;
        let offsetX = 0;
        let offsetY = 0;

        const startDrag = (): void => {
            draggedPanelId = panel.id as PanelId;
            const rect = panel.getBoundingClientRect();
            offsetX = startX - rect.left;
            offsetY = startY - rect.top;
            preview = panel.cloneNode(true) as HTMLElement;
            dropPreview = document.createElement('div');
            dropPreview.className = 'panel-drop-preview';
            dropMeasureDock = document.createElement('div');
            dropMeasureDock.className = 'panel-dock';
            dropMeasureDock.style.visibility = 'hidden';
            dropMeasureDock.style.pointerEvents = 'none';
            dropMeasurePanels = Object.fromEntries(panelIds.map(id => {
                const measurePanel = panels[id].cloneNode(false) as HTMLElement;
                measurePanel.append(panels[id].firstElementChild!.cloneNode(true));
                return [id, measurePanel];
            })) as Record<PanelId, HTMLElement>;
            dropPreviewPlacement = null;
            dropPreviewPlacementKey = '';
            preview.className += ' panel-drag-preview';
            preview.style.width = `${rect.width}px`;
            preview.style.height = `${rect.height}px`;
            document.body.append(preview, dropPreview, dropMeasureDock);
        };
        const move = (moveEvent: PointerEvent): void => {
            if (moveEvent.pointerId !== pointerId) return;
            dragClientX = moveEvent.clientX;
            dragClientY = moveEvent.clientY;
            if (!preview && Math.hypot(dragClientX - startX, dragClientY - startY) < 4) return;
            if (!preview) startDrag();
            preview!.style.transform = `translate(${dragClientX - offsetX}px, ${dragClientY - offsetY}px)`;
            updateDropPreview(dragClientX, dragClientY);
            moveEvent.preventDefault();
        };
        const cleanup = (): void => {
            header.removeEventListener('pointermove', move);
            header.removeEventListener('pointerup', finish);
            header.removeEventListener('pointercancel', cancel);
            if (header.hasPointerCapture(pointerId)) header.releasePointerCapture(pointerId);
            preview?.remove();
            dropPreview?.remove();
            dropMeasureDock?.remove();
            dropPreview = null;
            dropMeasureDock = null;
            dropMeasurePanels = null;
            dropPreviewPlacement = null;
            draggedPanelId = null;
            dropPreviewPlacementKey = '';
        };
        const finish = (upEvent: PointerEvent): void => {
            if (upEvent.pointerId !== pointerId) return;
            if (preview) {
                upEvent.preventDefault();
                movePanel(panel.id as PanelId);
                suppressPanelHeaderClickUntil = Date.now() + 100;
            }
            cleanup();
        };
        const cancel = (cancelEvent: PointerEvent): void => {
            if (cancelEvent.pointerId === pointerId) cleanup();
        };

        dragClientX = startX;
        dragClientY = startY;
        header.setPointerCapture(pointerId);
        header.addEventListener('pointermove', move);
        header.addEventListener('pointerup', finish);
        header.addEventListener('pointercancel', cancel);
    });
});

function getDockSideAtPoint(x: number, y: number): DockSide | undefined {
    return (['left', 'right'] as DockSide[]).find(side => {
        const rect = docks[side].getBoundingClientRect();
        return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
    });
}

function getDropPlacement(x: number, y: number): DropPlacement | null {
    const edgeWidth = window.innerWidth * 0.05;
    let side = getDockSideAtPoint(x, y) ?? (x <= edgeWidth ? 'left' : x >= window.innerWidth - edgeWidth ? 'right' : undefined);
    const targetId = panelIds.find(id => !panels[id].hidden && (() => {
        const rect = panels[id].getBoundingClientRect();
        return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
    })());

    if (!side && targetId) side = layout.left.includes(targetId) ? 'left' : 'right';
    if (!side) return null;

    const sidePanels = layout[side];
    if (!targetId || !sidePanels.includes(targetId)) {
        const index = sidePanels.findIndex(id => y < panels[id].getBoundingClientRect().top + panels[id].offsetHeight / 2);
        return { side, index: index < 0 ? sidePanels.length : index };
    }

    const target = panels[targetId];
    const targetRect = target.getBoundingClientRect();
    const draggedIndex = draggedPanelId ? sidePanels.indexOf(draggedPanelId) : -1;
    const targetIndex = sidePanels.indexOf(targetId);
    if (draggedIndex >= 0 && draggedPanelId !== targetId) {
        return { side, index: targetIndex + (draggedIndex < targetIndex ? 1 : 0) };
    }
    const index = targetIndex + (y >= targetRect.top + targetRect.height / 2 ? 1 : 0);
    return { side, index };
}

function getDropIndex(panelId: PanelId, placement: DropPlacement): number {
    const oldIndex = layout[placement.side].indexOf(panelId);
    return Math.min(
        oldIndex >= 0 && oldIndex < placement.index ? placement.index - 1 : placement.index,
        layout[placement.side].length - (oldIndex >= 0 ? 1 : 0)
    );
}

function measureDropRect(side: DockSide, panelOrder: PanelId[], panelId: PanelId): { top: number; height: number } | null {
    if (!dropMeasureDock || !dropMeasurePanels || !panelOrder.includes(panelId)) return null;
    const dock = docks[side];
    const dockRect = dock.getBoundingClientRect();
    const dockWidth = dockRect.width || parseFloat(getComputedStyle(dock).width) || 280;
    const dockHeight = dock.clientHeight || window.innerHeight;
    const children = panelOrder.flatMap((id, index) => {
        const panel = dropMeasurePanels![id];
        const flexBasis = getPanelFlexBasis(id, index, panelOrder.length);
        panel.style.flex = index === panelOrder.length - 1 ? '1 1 0' : flexBasis ? `0 0 ${flexBasis}` : '';
        panel.style.minHeight = panelOrder.length > 1 ? '0' : '';
        if (!index) return [panel];
        const divider = document.createElement('div');
        divider.className = 'details-resizer';
        return [divider, panel];
    });
    dropMeasureDock.classList.toggle('single-panel', panelOrder.length === 1);
    Object.assign(dropMeasureDock.style, {
        position: 'fixed',
        top: `${dockRect.height ? dockRect.top : 0}px`,
        right: 'auto',
        bottom: 'auto',
        left: `${dockRect.width ? dockRect.left : side === 'left' ? 0 : window.innerWidth - dockWidth}px`,
        width: `${dockWidth}px`,
        height: `${dockHeight}px`
    });
    dropMeasureDock.replaceChildren(...children);
    dropMeasureDock.scrollTop = dock.scrollTop;
    const rect = dropMeasurePanels[panelId].getBoundingClientRect();
    return { top: rect.top, height: rect.height };
}

function updateDropPreview(x: number, y: number): void {
    const placement = getDropPlacement(x, y);
    if (!placement) {
        if (dropPreview) dropPreview.hidden = true;
        dropPreviewPlacement = null;
        dropPreviewPlacementKey = '';
        return;
    }
    if (!dropPreview || !draggedPanelId) return;

    const dropIndex = getDropIndex(draggedPanelId, placement);
    const placementKey = `${placement.side}:${dropIndex}`;
    if (placementKey === dropPreviewPlacementKey) return;
    dropPreviewPlacement = null;
    dropPreviewPlacementKey = placementKey;

    const dock = docks[placement.side];
    const dockWidth = dock.offsetWidth || parseFloat(getComputedStyle(dock).width) || 280;
    const previewLayout = layout[placement.side].filter(id => id !== draggedPanelId);
    previewLayout.splice(dropIndex, 0, draggedPanelId);
    const visibleLayout = previewLayout.filter(id => !panels[id].hidden);
    const previewRect = measureDropRect(placement.side, visibleLayout, draggedPanelId);
    if (!previewRect || previewRect.height <= 0) {
        dropPreview.hidden = true;
        dropPreviewPlacementKey = '';
        return;
    }
    dropPreviewPlacement = { side: placement.side, index: dropIndex };
    dropPreview.hidden = false;
    dropPreview.style.left = `${placement.side === 'left' ? 0 : window.innerWidth - dockWidth}px`;
    dropPreview.style.width = `${dockWidth}px`;
    dropPreview.style.top = `${previewRect.top}px`;
    dropPreview.style.height = `${previewRect.height}px`;
}

window.addEventListener('wheel', event => {
    if (!draggedPanelId) return;
    const side = getDockSideAtPoint(dragClientX, dragClientY);
    if (!side) return;
    const dock = docks[side];
    const delta = event.deltaY * (event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? dock.clientHeight : 1);
    const previousScrollTop = dock.scrollTop;
    dock.scrollTop += delta;
    if (dock.scrollTop === previousScrollTop) return;
    event.preventDefault();
    dropPreviewPlacementKey = '';
    updateDropPreview(dragClientX, dragClientY);
}, { passive: false });

function movePanel(panelId: PanelId): void {
    const placement = dropPreviewPlacement;
    if (!placement) return;
    const dock = docks[placement.side];
    if (dock.classList.contains('minimized')) {
        dock.classList.remove('minimized');
        dock.style.width = '280px';
        localStorage.setItem(`panel-width-${placement.side}`, dock.style.width);
    }
    layout.left = layout.left.filter(id => id !== panelId);
    layout.right = layout.right.filter(id => id !== panelId);
    layout[placement.side].splice(Math.min(placement.index, layout[placement.side].length), 0, panelId);
    renderLayout();
}

window.addEventListener('pde:panel-visibility-changed', renderLayout);
renderLayout();
