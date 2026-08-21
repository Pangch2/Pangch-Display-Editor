import './head-atlas-panel';

type DockSide = 'left' | 'right';
type PanelId = 'player-head-atlas' | 'scene-objects' | 'project-details' | 'head-painter';

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
let draggedPanelId: PanelId | null = null;
let dropPreviewPlacementKey = '';
let resizeFrame = 0;

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
    if (!resizeFrame) resizeFrame = requestAnimationFrame(() => {
        resizeFrame = 0;
        window.dispatchEvent(new Event('resize'));
    });
}

function getPanelFlexBasis(id: PanelId, index: number, panelCount: number): string {
    return index < panelCount - 1
        ? localStorage.getItem(`panel-height-${id}`) ?? (id === 'scene-objects' ? localStorage.getItem('scene-objects-height') ?? '' : '')
        : '';
}

function renderLayout(): void {
    const scrollPositions = new Map<HTMLElement, number>(Object.values(panels).flatMap(panel =>
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
            panel.style.flex = index === visiblePanels.length - 1 ? '1 1 0' : flexBasis ? `0 1 ${flexBasis}` : '';
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
    header.addEventListener('click', event => {
        if (!(event.target as Element).closest('button, input, select, a')) toggleCollapsed();
    });
    header.addEventListener('dragstart', event => {
        draggedPanelId = panel.id as PanelId;
        event.dataTransfer?.setData('text/pde-panel', panel.id);
        if (event.dataTransfer) {
            const rect = panel.getBoundingClientRect();
            const offsetX = event.clientX - rect.left;
            const offsetY = event.clientY - rect.top;
            const preview = panel.cloneNode(true) as HTMLElement;
            const emptyDragImage = document.createElement('div');
            dropPreview = document.createElement('div');
            dropPreview.className = 'panel-drop-preview';
            dropMeasureDock = document.createElement('div');
            dropMeasureDock.className = 'panel-dock';
            dropMeasureDock.style.visibility = 'hidden';
            dropMeasureDock.style.pointerEvents = 'none';
            dropMeasurePanels = Object.fromEntries(panelIds.map(id => {
                const measurePanel = panels[id].cloneNode(false) as HTMLElement;
                if (panels[id].firstElementChild) measurePanel.append(panels[id].firstElementChild!.cloneNode(true));
                return [id, measurePanel];
            })) as Record<PanelId, HTMLElement>;
            dropPreviewPlacementKey = '';
            preview.className += ' panel-drag-preview';
            preview.style.width = `${rect.width}px`;
            preview.style.height = `${rect.height}px`;
            document.body.append(preview, emptyDragImage, dropPreview, dropMeasureDock);
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setDragImage(emptyDragImage, 0, 0);

            const movePreview = (dragEvent: DragEvent): void => {
                if (dragEvent.clientX || dragEvent.clientY) preview.style.transform = `translate(${dragEvent.clientX - offsetX}px, ${dragEvent.clientY - offsetY}px)`;
            };
            const removePreview = (): void => {
                preview.remove();
                emptyDragImage.remove();
                dropPreview?.remove();
                dropMeasureDock?.remove();
                dropPreview = null;
                dropMeasureDock = null;
                dropMeasurePanels = null;
                draggedPanelId = null;
                dropPreviewPlacementKey = '';
                header.removeEventListener('drag', movePreview);
            };
            header.addEventListener('drag', movePreview);
            header.addEventListener('dragend', removePreview, { once: true });
            movePreview(event);
        }
    });
});

function getDropPlacement(x: number, y: number): { side: DockSide; index: number } | null {
    const edgeWidth = window.innerWidth * 0.05;
    let side: DockSide | undefined = x <= edgeWidth ? 'left' : x >= window.innerWidth - edgeWidth ? 'right' : undefined;
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

function getDropIndex(panelId: PanelId, placement: { side: DockSide; index: number }): number {
    const oldIndex = layout[placement.side].indexOf(panelId);
    return Math.min(
        oldIndex >= 0 && oldIndex < placement.index ? placement.index - 1 : placement.index,
        layout[placement.side].length - (oldIndex >= 0 ? 1 : 0)
    );
}

function measureDropRect(side: DockSide, panelOrder: PanelId[], panelId: PanelId): DOMRect | null {
    if (!dropMeasureDock || !dropMeasurePanels) return null;
    const dock = docks[side];
    const dockRect = dock.getBoundingClientRect();
    const dockWidth = dockRect.width || parseFloat(getComputedStyle(dock).width);
    const dockHeight = dock.clientHeight || window.innerHeight;
    const children = panelOrder.flatMap((id, index) => {
        const panel = dropMeasurePanels![id];
        panel.hidden = false;
        const flexBasis = getPanelFlexBasis(id, index, panelOrder.length);
        panel.style.flex = index === panelOrder.length - 1 ? '1 1 0' : flexBasis ? `0 1 ${flexBasis}` : '';
        panel.style.minHeight = panelOrder.length > 1 ? '0' : '';
        if (!index) return [panel];
        const divider = document.createElement('div');
        divider.className = 'details-resizer';
        return [divider, panel];
    });
    dropMeasureDock.classList.toggle('single-panel', panelOrder.length === 1);
    Object.assign(dropMeasureDock.style, {
        position: 'fixed',
        top: '0',
        right: 'auto',
        bottom: 'auto',
        left: `${side === 'left' ? 0 : window.innerWidth - dockWidth}px`,
        width: `${dockWidth}px`,
        height: `${dockHeight}px`,
        visibility: 'hidden',
        pointerEvents: 'none'
    });
    dropMeasureDock.replaceChildren(...children);
    return dropMeasurePanels[panelId].getBoundingClientRect();
}

window.addEventListener('dragover', event => {
    if (!event.dataTransfer?.types.includes('text/pde-panel')) return;
    const placement = getDropPlacement(event.clientX, event.clientY);
    if (!placement) {
        if (dropPreview) dropPreview.hidden = true;
        dropPreviewPlacementKey = '';
        return;
    }
    event.preventDefault();
    if (!dropPreview || !draggedPanelId) return;

    const dropIndex = getDropIndex(draggedPanelId, placement);
    const placementKey = `${placement.side}:${dropIndex}`;
    if (placementKey === dropPreviewPlacementKey) return;
    dropPreviewPlacementKey = placementKey;

    const dock = docks[placement.side];
    const dockWidth = parseFloat(getComputedStyle(dock).width);
    const previewLayout = layout[placement.side].filter(id => id !== draggedPanelId);
    previewLayout.splice(dropIndex, 0, draggedPanelId);
    const visibleLayout = previewLayout.filter(id => !panels[id].hidden);
    const previewRect = measureDropRect(placement.side, visibleLayout, draggedPanelId);
    if (!previewRect) return;
    dropPreview.hidden = false;
    dropPreview.style.left = `${placement.side === 'left' ? 0 : window.innerWidth - dockWidth}px`;
    dropPreview.style.width = `${dockWidth}px`;
    dropPreview.style.top = `${previewRect.top}px`;
    dropPreview.style.height = `${previewRect.height}px`;
});

window.addEventListener('drop', event => {
    const panelId = event.dataTransfer?.getData('text/pde-panel') as PanelId | undefined;
    if (!panelId || !panelIds.includes(panelId)) return;
    const placement = getDropPlacement(event.clientX, event.clientY);
    if (!placement) return;
    event.preventDefault();
    const index = getDropIndex(panelId, placement);
    layout.left = layout.left.filter(id => id !== panelId);
    layout.right = layout.right.filter(id => id !== panelId);
    layout[placement.side].splice(Math.min(index, layout[placement.side].length), 0, panelId);
    renderLayout();
});

window.addEventListener('pde:panel-visibility-changed', renderLayout);
renderLayout();
