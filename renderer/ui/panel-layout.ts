import './head-atlas-panel';
import { dockSides, movePanelInLayout, panelIds, restorePanelLayout, selectVisiblePanel, singlePanelGroup } from './panel-layout-state';
import type { DockSide, DropPlacement, PanelGroup, PanelId, PanelLayout } from './panel-layout-state';
import { initPanelGroupScrollbar } from './panel-group-scrollbar';

const panels = Object.fromEntries(panelIds.map(id => [id, document.getElementById(id)!])) as Record<PanelId, HTMLElement>;
const headers = Object.fromEntries(panelIds.map(id => [id, panels[id].firstElementChild!])) as Record<PanelId, HTMLElement>;
const groupElements = new WeakMap<PanelGroup, HTMLElement>();
const groupScrollbars = new Map<HTMLElement, () => void>();
const scrollPositions = new Map<HTMLElement, readonly [number, number]>();
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
const fallbackLayout: PanelLayout = oldSide === 'left'
    ? { version: 2, left: [singlePanelGroup('player-head-atlas'), ...oldOrder.map(singlePanelGroup)], right: [] }
    : { version: 2, left: [singlePanelGroup('player-head-atlas')], right: oldOrder.map(singlePanelGroup) };
let layout = restorePanelLayout(localStorage.getItem('panel-layout'), fallbackLayout, headPainterAfterDetails);

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

function findPanelGroup(id: PanelId): PanelGroup {
    return dockSides.flatMap(side => layout[side]).find(group => group.panels.includes(id))!;
}

function renderGroup(group: PanelGroup, measure = false): HTMLElement {
    const groupPanels = measure ? dropMeasurePanels! : panels;
    const groupHeaders = measure
        ? Object.fromEntries(group.panels.map(id => [id, groupPanels[id].querySelector<HTMLElement>(`#${headers[id].id}`)!]))
        : headers;
    const activeId = selectVisiblePanel(group, id => !panels[id].hidden);
    if (!measure) group.activePanelId = activeId;
    const tabbed = group.panels.filter(id => !panels[id].hidden).length > 1;
    const collapsed = tabbed ? localStorage.getItem(`panel-group-collapsed-${group.panels[0]}`) === 'true'
        : groupPanels[activeId].classList.contains('collapsed');
    let root = measure ? undefined : groupElements.get(group);
    if (group.panels.length > 1 && !root) {
        root = document.createElement('section');
        root.className = 'panel-group';
        const row = document.createElement('div');
        row.className = 'panel-tabs';
        row.setAttribute('role', 'tablist');
        row.setAttribute('aria-label', '패널');
        root.append(row);
        if (!measure) groupElements.set(group, root);
    }
    const row = root?.firstElementChild as HTMLElement | undefined;
    if (row) row.hidden = !tabbed;
    for (const id of group.panels) {
        const panel = groupPanels[id];
        const header = groupHeaders[id];
        const active = id === activeId;
        panel.classList.toggle('panel-tabbed', tabbed);
        panel.classList.toggle('panel-tab-inactive', !active);
        panel.classList.toggle('panel-group-content', group.panels.length > 1);
        header.hidden = tabbed && Boolean(panel.hidden);
        if (tabbed) {
            header.setAttribute('role', 'tab');
            header.setAttribute('aria-controls', id);
            header.setAttribute('aria-selected', String(active));
            header.setAttribute('aria-expanded', String(!collapsed));
            header.tabIndex = active ? 0 : -1;
            panel.setAttribute('role', 'tabpanel');
            panel.setAttribute('aria-labelledby', header.id);
            row!.append(header);
        } else {
            header.removeAttribute('role');
            header.removeAttribute('aria-controls');
            header.removeAttribute('aria-selected');
            header.removeAttribute('tabindex');
            header.setAttribute('aria-expanded', String(!panel.classList.contains('collapsed')));
            panel.removeAttribute('role');
            panel.removeAttribute('aria-labelledby');
            panel.prepend(header);
        }
        if (root) {
            panel.style.flex = '';
            panel.style.minHeight = '';
            root.append(panel);
        }
    }
    if (!root) return groupPanels[activeId];
    root.hidden = group.panels.every(id => panels[id].hidden);
    root.classList.toggle('collapsed', collapsed);
    root.dataset.panelId = group.panels[0];
    if (!measure && !groupScrollbars.has(root)) groupScrollbars.set(root, initPanelGroupScrollbar(root));
    return root;
}

function sizeGroup(root: HTMLElement, group: PanelGroup, index: number, count: number): void {
    const grouped = group.panels.length > 1 && count > 1;
    const basis = getPanelFlexBasis(group.panels[0], index, count) || (grouped ? '30%' : '');
    root.style.flex = index === count - 1 ? grouped ? `1 0 ${basis}` : '1 1 0' : basis ? `0 0 ${basis}` : '';
    root.style.minHeight = count > 1 ? '0' : '';
}

function syncGroupMinHeight(root: HTMLElement): void {
    if (!root.classList.contains('panel-group')) return;
    const row = root.firstElementChild as HTMLElement;
    const header = row.hidden ? root.querySelector<HTMLElement>('.panel-section:not(.panel-tab-inactive)')?.firstElementChild as HTMLElement : row;
    root.style.minHeight = `${header?.offsetHeight ?? 0}px`;
}

function renderLayout(): void {
    for (const panel of [...Object.values(docks), ...Object.values(panels)]) {
        for (const element of [panel, ...panel.querySelectorAll<HTMLElement>('#player-head-atlas-scroll, .player-head-atlas-box, #player-head-atlas-list, #scene-object-list, .head-painter-color-area')]) {
            if (element.getClientRects().length) scrollPositions.set(element, [element.scrollLeft, element.scrollTop]);
        }
    }
    for (const side of dockSides) {
        const dock = docks[side];
        const resizer = dock.querySelector<HTMLElement>('.scene-resizer')!;
        const dockPanels = layout[side].map(group => renderGroup(group));
        const visiblePanels = dockPanels.filter(panel => !panel.hidden);
        const children = dockPanels.flatMap((panel, groupIndex) => {
            if (panel.hidden) return [];
            const index = visiblePanels.indexOf(panel);
            sizeGroup(panel, layout[side][groupIndex], index, visiblePanels.length);
            if (!index) return [panel];
            const divider = document.createElement('div');
            divider.className = 'details-resizer';
            return [divider, panel];
        });
        dock.replaceChildren(resizer, ...children, ...dockPanels.filter(panel => panel.hidden));
        dock.classList.toggle('empty', visiblePanels.length === 0);
        dock.classList.toggle('single-panel', visiblePanels.length === 1);
        dockPanels.forEach(syncGroupMinHeight);
    }
    for (const [root, dispose] of groupScrollbars) {
        if (root.isConnected) continue;
        dispose();
        groupScrollbars.delete(root);
    }
    for (const [element, [scrollLeft, scrollTop]] of scrollPositions) {
        if (!element.getClientRects().length) continue;
        element.scrollLeft = scrollLeft;
        element.scrollTop = scrollTop;
    }
    localStorage.setItem('panel-layout', JSON.stringify(layout));
    applyLayout();
}

for (const side of dockSides) {
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
            const id = (adjacentPanel.dataset.panelId ?? adjacentPanel.id) as PanelId;
            const group = findPanelGroup(id);
            const activeId = group.activePanelId;
            localStorage.setItem(`panel-group-collapsed-${id}`, 'false');
            if (headers[activeId].getAttribute('role') === 'tab') {
                group.panels.forEach(id => headers[id].setAttribute('aria-expanded', 'true'));
            } else {
                panels[activeId].classList.remove('collapsed');
                headers[activeId].setAttribute('aria-expanded', 'true');
                localStorage.setItem(`panel-collapsed-${activeId}`, 'false');
            }
        }
        const visiblePanels = [...dock.children].filter((element): element is HTMLElement =>
            element instanceof HTMLElement && element.matches('.panel-section:not([hidden]), .panel-group:not([hidden])'));
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
            localStorage.setItem(`panel-height-${panel.dataset.panelId ?? panel.id}`, `${panel.offsetHeight}px`);
            applyLayout();
        };
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', stop);
    });
}

window.addEventListener('resize', () => Object.values(docks).forEach(syncDockResizer));

function activateTab(panelId: PanelId, toggleCollapsed = false): void {
    const group = findPanelGroup(panelId);
    const key = `panel-group-collapsed-${group.panels[0]}`;
    const collapsed = toggleCollapsed && group.activePanelId === panelId && localStorage.getItem(key) !== 'true';
    localStorage.setItem(key, String(collapsed));
    group.activePanelId = panelId;
    renderLayout();
    headers[panelId].focus({ preventScroll: true });
}

panelIds.forEach(panelId => {
    const panel = panels[panelId];
    const header = headers[panelId];
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
        if (Date.now() < suppressPanelHeaderClickUntil || (event.target as Element).closest('button, input, select, a')) return;
        if (header.getAttribute('role') === 'tab') {
            activateTab(panelId, true);
        } else toggleCollapsed();
    });
    header.addEventListener('keydown', event => {
        if (header.getAttribute('role') !== 'tab' || event.target !== header) return;
        const group = findPanelGroup(panelId);
        const visibleIds = group.panels.filter(id => !panels[id].hidden);
        const index = visibleIds.indexOf(panelId);
        let nextId: PanelId;
        if (event.key === 'ArrowRight') nextId = visibleIds[(index + 1) % visibleIds.length];
        else if (event.key === 'ArrowLeft') nextId = visibleIds[(index + visibleIds.length - 1) % visibleIds.length];
        else if (event.key === 'Home') nextId = visibleIds[0];
        else if (event.key === 'End') nextId = visibleIds[visibleIds.length - 1];
        else if (event.key === 'Enter' || event.key === ' ') nextId = panelId;
        else return;
        event.preventDefault();
        event.stopPropagation();
        activateTab(nextId, event.key === 'Enter' || event.key === ' ');
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
            draggedPanelId = panelId;
            const group = findPanelGroup(panelId);
            const rect = (groupElements.get(group) ?? panel).getBoundingClientRect();
            offsetX = startX - rect.left;
            offsetY = startY - rect.top;
            preview = panel.cloneNode(true) as HTMLElement;
            if (!preview.querySelector(`#${header.id}`)) preview.prepend(header.cloneNode(true));
            preview.classList.remove('panel-tab-inactive', 'panel-tabbed', 'panel-group-content');
            if (group.panels.length > 1) preview.classList.remove('collapsed');
            dropPreview = document.createElement('div');
            dropPreview.className = 'panel-drop-preview';
            dropMeasureDock = document.createElement('div');
            dropMeasureDock.className = 'panel-dock';
            dropMeasureDock.style.visibility = 'hidden';
            dropMeasureDock.style.pointerEvents = 'none';
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
            window.removeEventListener('keydown', cancelKey);
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
                updateDropPreview(upEvent.clientX, upEvent.clientY);
                const placement = dropPreviewPlacement;
                suppressPanelHeaderClickUntil = Date.now() + 100;
                cleanup();
                if (placement) movePanel(panelId, placement);
                return;
            }
            cleanup();
        };
        const cancel = (cancelEvent: PointerEvent): void => {
            if (cancelEvent.pointerId !== pointerId) return;
            if (preview) suppressPanelHeaderClickUntil = Date.now() + 100;
            cleanup();
        };
        const cancelKey = (keyEvent: KeyboardEvent): void => {
            if (keyEvent.key !== 'Escape') return;
            if (preview) suppressPanelHeaderClickUntil = Date.now() + 100;
            cleanup();
        };

        dragClientX = startX;
        dragClientY = startY;
        header.setPointerCapture(pointerId);
        header.addEventListener('pointermove', move);
        header.addEventListener('pointerup', finish);
        header.addEventListener('pointercancel', cancel);
        window.addEventListener('keydown', cancelKey);
    });
});

function getDockSideAtPoint(x: number, y: number): DockSide | undefined {
    return dockSides.find(side => {
        const rect = docks[side].getBoundingClientRect();
        return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
    });
}

function getDropPlacement(x: number, y: number): DropPlacement | null {
    const edgeWidth = window.innerWidth * 0.05;
    const side = getDockSideAtPoint(x, y) ?? (x <= edgeWidth ? 'left' : x >= window.innerWidth - edgeWidth ? 'right' : undefined);
    if (!side) return null;
    const groups = layout[side];
    const targetIndex = groups.findIndex(group => {
        if (group.panels.every(id => panels[id].hidden)) return false;
        const rect = (groupElements.get(group) ?? panels[group.activePanelId]).getBoundingClientRect();
        return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
    });
    if (targetIndex < 0) {
        const index = groups.findIndex(group => {
            if (group.panels.every(id => panels[id].hidden)) return false;
            const rect = (groupElements.get(group) ?? panels[group.activePanelId]).getBoundingClientRect();
            return y < rect.top + rect.height / 2;
        });
        return { side, mode: 'split', index: index < 0 ? groups.length : index };
    }
    const targetGroup = groups[targetIndex];
    const target = groupElements.get(targetGroup) ?? panels[targetGroup.activePanelId];
    const targetHeader = headers[targetGroup.activePanelId].parentElement?.classList.contains('panel-tabs')
        ? headers[targetGroup.activePanelId].parentElement! : headers[targetGroup.activePanelId];
    const headerRect = targetHeader.getBoundingClientRect();
    if (y >= headerRect.top && y <= headerRect.bottom) {
        return { side, mode: 'merge', targetPanelId: targetGroup.panels[0] };
    }
    const targetRect = target.getBoundingClientRect();
    const draggedIndex = groups.findIndex(group => group.panels.includes(draggedPanelId!));
    if (draggedIndex >= 0 && groups[draggedIndex].panels.length === 1 && draggedIndex !== targetIndex) {
        return { side, mode: 'split', index: targetIndex + Number(draggedIndex < targetIndex) };
    }
    return { side, mode: 'split', index: targetIndex + Number(y >= targetRect.top + targetRect.height / 2) };
}

function measureDropRect(side: DockSide, groups: PanelGroup[], panelId: PanelId, merge: boolean): DOMRect | null {
    if (!dropMeasureDock) return null;
    const dock = docks[side];
    const dockRect = dock.getBoundingClientRect();
    const dockWidth = dock.classList.contains('minimized') || dock.classList.contains('empty')
        ? 280 : dockRect.width || 280;
    const dockHeight = dock.clientHeight || window.innerHeight;
    dropMeasurePanels = Object.fromEntries(panelIds.map(id => {
        const panel = panels[id].cloneNode(true) as HTMLElement;
        if (!panel.querySelector(`#${headers[id].id}`)) panel.prepend(headers[id].cloneNode(true));
        return [id, panel];
    })) as Record<PanelId, HTMLElement>;
    const roots = groups.map(group => {
        const root = renderGroup(group, true);
        if (merge && group.panels.includes(panelId)) root.classList.remove('collapsed');
        return root;
    });
    const children = roots.flatMap((panel, index) => {
        sizeGroup(panel, groups[index], index, groups.length);
        if (!index) return [panel];
        const divider = document.createElement('div');
        divider.className = 'details-resizer';
        return [divider, panel];
    });
    dropMeasureDock.classList.toggle('single-panel', groups.length === 1);
    dropMeasureDock.classList.toggle('dock-left', side === 'left');
    dropMeasureDock.classList.toggle('dock-right', side === 'right');
    Object.assign(dropMeasureDock.style, {
        position: 'fixed',
        top: `${dockRect.height ? dockRect.top : 0}px`,
        right: 'auto',
        bottom: 'auto',
        left: `${side === 'left' ? 0 : window.innerWidth - dockWidth}px`,
        width: `${dockWidth}px`,
        height: `${dockHeight}px`
    });
    dropMeasureDock.replaceChildren(...children);
    roots.forEach(syncGroupMinHeight);
    dropMeasureDock.scrollTop = dock.scrollTop;
    const root = roots[groups.findIndex(group => group.panels.includes(panelId))];
    return (merge ? root.querySelector<HTMLElement>(`#${headers[panelId].id}`)! : root).getBoundingClientRect();
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

    const placementKey = `${placement.side}:${placement.mode}:${placement.mode === 'merge' ? placement.targetPanelId : placement.index}`;
    if (placementKey === dropPreviewPlacementKey) return;
    dropPreviewPlacement = null;
    dropPreviewPlacementKey = placementKey;

    dropPreview.classList.toggle('panel-merge-preview', placement.mode === 'merge');
    const previewLayout = movePanelInLayout(layout, draggedPanelId, placement);
    const visibleLayout = previewLayout[placement.side].filter(group => group.panels.some(id => !panels[id].hidden));
    const previewRect = measureDropRect(placement.side, visibleLayout, draggedPanelId, placement.mode === 'merge');
    if (!previewRect || previewRect.height <= 0) {
        dropPreview.hidden = true;
        dropPreviewPlacementKey = '';
        return;
    }
    dropPreviewPlacement = placement;
    dropPreview.hidden = false;
    dropPreview.style.left = `${previewRect.left}px`;
    dropPreview.style.width = `${previewRect.width}px`;
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

function movePanel(panelId: PanelId, placement: DropPlacement): void {
    const dock = docks[placement.side];
    if (dock.classList.contains('minimized')) {
        dock.classList.remove('minimized');
        dock.style.width = '280px';
        localStorage.setItem(`panel-width-${placement.side}`, dock.style.width);
    }
    layout = movePanelInLayout(layout, panelId, placement);
    if (placement.mode === 'merge') localStorage.setItem(`panel-group-collapsed-${findPanelGroup(panelId).panels[0]}`, 'false');
    renderLayout();
}

window.addEventListener('pde:panel-visibility-changed', renderLayout);
renderLayout();
