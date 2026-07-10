type DockSide = 'left' | 'right';
type PanelId = 'scene-objects' | 'project-details';

const panelIds: PanelId[] = ['scene-objects', 'project-details'];
const panels = Object.fromEntries(panelIds.map(id => [id, document.getElementById(id)!])) as Record<PanelId, HTMLElement>;
const mainContent = document.getElementById('main-content')!;
const sceneObjects = panels['scene-objects'];
const docks: Record<DockSide, HTMLElement> = {
    left: document.getElementById('left-panel-dock')!,
    right: document.getElementById('right-panel-dock')!
};

const oldSide: DockSide = localStorage.getItem('scene-panel-dock') === 'left' ? 'left' : 'right';
const oldOrder: PanelId[] = localStorage.getItem('project-details-first') === 'true'
    ? ['project-details', 'scene-objects']
    : [...panelIds];
let layout: Record<DockSide, PanelId[]> = oldSide === 'left'
    ? { left: oldOrder, right: [] }
    : { left: [], right: oldOrder };
let sceneHeight = localStorage.getItem('scene-objects-height') ?? '';

try {
    const saved = JSON.parse(localStorage.getItem('panel-layout') ?? 'null') as Partial<Record<DockSide, PanelId[]>> | null;
    const ids = [...(saved?.left ?? []), ...(saved?.right ?? [])];
    if (ids.length === 2 && panelIds.every(id => ids.includes(id))) {
        layout = { left: saved!.left ?? [], right: saved!.right ?? [] };
    }
} catch {
    // Ignore invalid saved layout and use the previous panel preference.
}

function applyLayout(): void {
    mainContent.style.left = docks.left.classList.contains('empty') ? '0' : `${docks.left.offsetWidth}px`;
    mainContent.style.right = docks.right.classList.contains('empty') ? '0' : `${docks.right.offsetWidth}px`;
    window.dispatchEvent(new Event('resize'));
}

function renderLayout(): void {
    for (const side of ['left', 'right'] as DockSide[]) {
        const dock = docks[side];
        const resizer = dock.querySelector<HTMLElement>('.scene-resizer')!;
        const divider = dock.querySelector<HTMLElement>('.details-resizer')!;
        const dockPanels = layout[side].map(id => panels[id]);
        divider.hidden = dockPanels.length < 2;
        dock.replaceChildren(resizer, ...(dockPanels.length > 1 ? [dockPanels[0], divider, ...dockPanels.slice(1)] : [...dockPanels, divider]));
        dock.classList.toggle('empty', dockPanels.length === 0);
        dock.classList.toggle('single-panel', dockPanels.length === 1);
    }

    const together = layout.left.length === 2 || layout.right.length === 2;
    sceneObjects.style.flexBasis = together ? sceneHeight : '';
    localStorage.setItem('panel-layout', JSON.stringify(layout));
    applyLayout();
}

for (const side of ['left', 'right'] as DockSide[]) {
    const dock = docks[side];
    dock.style.width = localStorage.getItem(`panel-width-${side}`) ?? localStorage.getItem('scene-panel-width') ?? '';
    dock.querySelector<HTMLElement>('.scene-resizer')!.addEventListener('mousedown', (event) => {
        event.preventDefault();
        const startX = event.clientX;
        const startWidth = dock.offsetWidth;
        const direction = side === 'left' ? 1 : -1;

        const move = (moveEvent: MouseEvent): void => {
            const width = startWidth + direction * (moveEvent.clientX - startX);
            if (width < 160 || width > 600) return;
            dock.style.width = `${width}px`;
            applyLayout();
        };
        const stop = (): void => {
            window.removeEventListener('mousemove', move);
            window.removeEventListener('mouseup', stop);
            localStorage.setItem(`panel-width-${side}`, dock.style.width);
        };
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', stop);
    });

    dock.querySelector<HTMLElement>('.details-resizer')!.addEventListener('mousedown', (event) => {
        if (layout[side].length < 2) return;
        event.preventDefault();
        const divider = event.currentTarget as HTMLElement;
        const startY = event.clientY;
        const startHeight = sceneObjects.offsetHeight;
        const direction = sceneObjects.offsetTop < divider.offsetTop ? 1 : -1;
        document.body.classList.add('resizing-details');

        const move = (moveEvent: MouseEvent): void => {
            const availableHeight = dock.clientHeight - divider.offsetHeight;
            const minHeight = availableHeight * 0.1;
            const height = Math.max(minHeight, Math.min(availableHeight - minHeight, startHeight + direction * (moveEvent.clientY - startY)));
            sceneObjects.style.flexBasis = `${height}px`;
        };
        const stop = (): void => {
            document.body.classList.remove('resizing-details');
            window.removeEventListener('mousemove', move);
            window.removeEventListener('mouseup', stop);
            sceneHeight = sceneObjects.style.flexBasis;
            localStorage.setItem('scene-objects-height', sceneHeight);
        };
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', stop);
    });
}

document.querySelectorAll<HTMLElement>('#scene-panel-header, #project-details-header').forEach(header => {
    header.addEventListener('dragstart', event => {
        const panel = header.parentElement!;
        event.dataTransfer?.setData('text/pde-panel', panel.id);
        if (event.dataTransfer) {
            const rect = panel.getBoundingClientRect();
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setDragImage(panel, event.clientX - rect.left, event.clientY - rect.top);
        }
    });
});

function getDropPlacement(x: number, y: number): { side: DockSide; index: number } | null {
    const edgeWidth = window.innerWidth * 0.05;
    let side: DockSide | undefined = x <= edgeWidth ? 'left' : x >= window.innerWidth - edgeWidth ? 'right' : undefined;
    const targetId = panelIds.find(id => {
        const rect = panels[id].getBoundingClientRect();
        return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
    });

    if (!side && targetId) side = layout.left.includes(targetId) ? 'left' : 'right';
    if (!side) return null;

    const sidePanels = layout[side];
    if (!targetId || !sidePanels.includes(targetId)) {
        const index = sidePanels.findIndex(id => y < panels[id].getBoundingClientRect().top + panels[id].offsetHeight / 2);
        return { side, index: index < 0 ? sidePanels.length : index };
    }

    const target = panels[targetId];
    const targetRect = target.getBoundingClientRect();
    const index = sidePanels.indexOf(targetId) + (y >= targetRect.top + targetRect.height / 2 ? 1 : 0);
    return { side, index };
}

window.addEventListener('dragover', event => {
    if (event.dataTransfer?.types.includes('text/pde-panel') && getDropPlacement(event.clientX, event.clientY)) event.preventDefault();
});

window.addEventListener('drop', event => {
    const panelId = event.dataTransfer?.getData('text/pde-panel') as PanelId | undefined;
    if (!panelId || !panelIds.includes(panelId)) return;
    const placement = getDropPlacement(event.clientX, event.clientY);
    if (!placement) return;
    event.preventDefault();
    const oldIndex = layout[placement.side].indexOf(panelId);
    layout.left = layout.left.filter(id => id !== panelId);
    layout.right = layout.right.filter(id => id !== panelId);
    const index = oldIndex >= 0 && oldIndex < placement.index ? placement.index - 1 : placement.index;
    layout[placement.side].splice(Math.min(index, layout[placement.side].length), 0, panelId);
    renderLayout();
});

renderLayout();
