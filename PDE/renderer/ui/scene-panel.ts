import { currentSelection } from '../controls/select';
import { scenePanelState } from './scene-panel-state';
import type { ScenePanelSelectionState } from './scene-panel-types';
import {
    handleScenePanelDragLeave,
    handleScenePanelDragOver,
    handleScenePanelDrop
} from './scene-panel-dnd';
import { refreshScenePanel, scheduleSceneExtraFit, scheduleScenePanelRender } from './scene-panel-render';
import { syncScenePanelSelection } from './scene-panel-selection';

if (scenePanelState.scenePanelList) {
    scenePanelState.scenePanelList.addEventListener('scroll', scheduleScenePanelRender, { passive: true });
    scenePanelState.scenePanelList.addEventListener('dragover', handleScenePanelDragOver);
    scenePanelState.scenePanelList.addEventListener('drop', handleScenePanelDrop);
    scenePanelState.scenePanelList.addEventListener('dragleave', handleScenePanelDragLeave);
}

window.addEventListener('resize', () => {
    scheduleScenePanelRender();
    scheduleSceneExtraFit();
});
window.addEventListener('pde:scene-updated', refreshScenePanel);
window.addEventListener('pde:selection-changed', (e: Event) => {
    const customEvent = e as CustomEvent<ScenePanelSelectionState>;
    syncScenePanelSelection(customEvent.detail ?? (currentSelection as unknown as ScenePanelSelectionState));
});

export { refreshScenePanel };
