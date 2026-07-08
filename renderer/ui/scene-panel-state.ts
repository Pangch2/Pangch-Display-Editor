import type { ScenePanelState } from './scene-panel-types';

export const ELLIPSIS = '...';
const scenePanelList = document.getElementById('scene-object-list') as HTMLElement | null;
const scenePanelContentEl = document.createElement('div');
const scenePanelSpacerEl = document.createElement('div');

scenePanelContentEl.className = 'scene-virtual-content';
scenePanelSpacerEl.className = 'scene-virtual-spacer';

if (scenePanelList) {
    scenePanelList.appendChild(scenePanelSpacerEl);
    scenePanelList.appendChild(scenePanelContentEl);
}

export const scenePanelState: ScenePanelState = {
    scenePanelList,
    scenePanelContentEl,
    scenePanelSpacerEl,
    sceneExtraFitRaf: 0,
    scenePanelRenderRaf: 0,
    extraTokenCache: new WeakMap<HTMLElement, string[]>(),
    rowHeight: 28,
    rowOverscan: 8,
    visibleRows: [],
    renderedRowEls: new Map<number, HTMLElement>(),
    lastClickedItem: null,
    expandedGroupIds: new Set<string>(),
    sceneDragBundle: null,
    sceneDropHint: null,
    sceneDropMarkerEl: null,
    sceneDropMarkerClass: null,
    sceneDragPreviewEl: null,
    sceneAutoExpandTimer: 0,
    sceneAutoExpandGroupId: null,
    suppressSceneItemClickUntil: 0
};
