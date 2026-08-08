import { currentSelection } from '../controls/selection/select';
import { matchesShortcut } from '../controls/input/shortcuts';
import { scenePanelState } from './scene-panel/scene-panel-state';
import type { ScenePanelSelectionState } from './scene-panel/scene-panel-types';
import { beginScenePanelRename, refreshScenePanel, scheduleSceneExtraFit, scheduleScenePanelRender } from './scene-panel/scene-panel-render';
import { syncScenePanelSelection } from './scene-panel/scene-panel-selection';

if (scenePanelState.scenePanelList) {
    const list = scenePanelState.scenePanelList;
    const scrollbar = document.getElementById('scene-scrollbar')!;
    const thumb = document.getElementById('scene-scrollbar-thumb')!;
    let draggingScrollbar = false;
    let grabOffset = 0;

    const updateScrollbar = () => {
        const viewportHeight = list.clientHeight;
        const maxScroll = list.scrollHeight - viewportHeight;
        const thumbHeight = Math.max(24, viewportHeight * viewportHeight / list.scrollHeight);
        scrollbar.hidden = maxScroll <= 0;
        thumb.style.height = `${thumbHeight}px`;
        thumb.style.transform = `translateY(${maxScroll > 0 ? list.scrollTop / maxScroll * (viewportHeight - thumbHeight) : 0}px)`;
    };
    const moveScrollbar = (clientY: number) => {
        const maxThumbTop = list.clientHeight - thumb.offsetHeight;
        const thumbTop = Math.max(0, Math.min(clientY - scrollbar.getBoundingClientRect().top - grabOffset, maxThumbTop));
        list.scrollTop = maxThumbTop > 0 ? thumbTop / maxThumbTop * (list.scrollHeight - list.clientHeight) : 0;
        updateScrollbar();
    };

    scrollbar.addEventListener('pointerdown', event => {
        if (event.button !== 0) return;
        draggingScrollbar = true;
        grabOffset = event.target === thumb ? event.clientY - thumb.getBoundingClientRect().top : thumb.offsetHeight / 2;
        thumb.classList.add('dragging');
        scrollbar.setPointerCapture(event.pointerId);
        moveScrollbar(event.clientY);
        event.preventDefault();
    });
    scrollbar.addEventListener('pointermove', event => {
        if (draggingScrollbar) moveScrollbar(event.clientY);
    });
    scrollbar.addEventListener('pointerup', event => {
        if (!draggingScrollbar) return;
        draggingScrollbar = false;
        thumb.classList.remove('dragging');
        scrollbar.releasePointerCapture(event.pointerId);
        scheduleScenePanelRender();
        scheduleSceneExtraFit();
    });
    list.addEventListener('scroll', () => {
        updateScrollbar();
        if (!draggingScrollbar) scheduleScenePanelRender();
    }, { passive: true });
    list.addEventListener('scrollend', () => {
        if (draggingScrollbar) return;
        scheduleScenePanelRender();
        scheduleSceneExtraFit();
    }, { passive: true });
    window.addEventListener('resize', updateScrollbar);
    new ResizeObserver(updateScrollbar).observe(list);
    new MutationObserver(updateScrollbar).observe(scenePanelState.scenePanelSpacerEl, { attributes: true, attributeFilter: ['style'] });
    updateScrollbar();
}

let scenePanelVisible = Boolean(scenePanelState.scenePanelList?.offsetParent);
window.addEventListener('resize', () => {
    const visible = Boolean(scenePanelState.scenePanelList?.offsetParent);
    if (visible && !scenePanelVisible) refreshScenePanel();
    else if (visible) {
        scheduleScenePanelRender();
        scheduleSceneExtraFit();
    }
    scenePanelVisible = visible;
});
window.addEventListener('pde:scene-updated', refreshScenePanel);
window.addEventListener('pde:object-renamed', () => {
    if (!(document.activeElement as HTMLElement | null)?.classList.contains('scene-name-input')) refreshScenePanel();
});
window.addEventListener('keydown', event => {
    const target = event.target as HTMLElement;
    if (!matchesShortcut(event, 'renameSceneItem') || target.matches('input, textarea') || target.isContentEditable) return;
    event.preventDefault();
    beginScenePanelRename();
});
window.addEventListener('pde:selection-changed', (e: Event) => {
    if (!scenePanelState.scenePanelList?.offsetParent) return;
    const customEvent = e as CustomEvent<ScenePanelSelectionState>;
    syncScenePanelSelection(customEvent.detail ?? (currentSelection as unknown as ScenePanelSelectionState));
});

export { refreshScenePanel };
