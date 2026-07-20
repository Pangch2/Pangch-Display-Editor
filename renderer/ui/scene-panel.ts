import { currentSelection } from '../controls/selection/select';
import { scenePanelState } from './scene-panel-state';
import type { ScenePanelSelectionState } from './scene-panel-types';
import {
    handleScenePanelDragLeave,
    handleScenePanelDragOver,
    handleScenePanelDrop
} from './scene-panel-dnd';
import { beginScenePanelRename, refreshScenePanel, scheduleSceneExtraFit, scheduleScenePanelRender } from './scene-panel-render';
import { syncScenePanelSelection } from './scene-panel-selection';

if (scenePanelState.scenePanelList) {
    scenePanelState.scenePanelList.addEventListener('scroll', scheduleScenePanelRender, { passive: true });
    scenePanelState.scenePanelList.addEventListener('dragover', handleScenePanelDragOver);
    scenePanelState.scenePanelList.addEventListener('drop', handleScenePanelDrop);
    scenePanelState.scenePanelList.addEventListener('dragleave', handleScenePanelDragLeave);
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
    if (event.key !== 'F2' || target.matches('input, textarea') || target.isContentEditable) return;
    event.preventDefault();
    beginScenePanelRename();
});
window.addEventListener('pde:selection-changed', (e: Event) => {
    if (!scenePanelState.scenePanelList?.offsetParent) return;
    const customEvent = e as CustomEvent<ScenePanelSelectionState>;
    syncScenePanelSelection(customEvent.detail ?? (currentSelection as unknown as ScenePanelSelectionState));
});

export { refreshScenePanel };
