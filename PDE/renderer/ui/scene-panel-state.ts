import type { ScenePanelState } from './scene-panel-types';

export const ELLIPSIS = '...';

export const scenePanelState: ScenePanelState = {
    scenePanelList: document.getElementById('scene-object-list') as HTMLElement | null,
    sceneExtraFitRaf: 0,
    extraTokenCache: new WeakMap<HTMLElement, string[]>(),
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
