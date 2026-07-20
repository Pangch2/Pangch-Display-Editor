import type { Matrix4, Object3D, Quaternion, Vector3 } from 'three/webgpu';

export interface GroupChild {
    type: 'group' | 'object';
    id: string;
    mesh?: Object3D;
    instanceId?: number;
}

export interface GroupData {
    id: string;
    isCollection?: boolean;
    children: GroupChild[];
    parent: string | null;
    name: string;
    position: Vector3 | { x: number; y: number; z: number };
    quaternion: Quaternion | { x: number; y: number; z: number; w: number };
    scale: Vector3 | { x: number; y: number; z: number };
    pivot?: [number, number, number];
    nbt?: string;
    matrix?: Matrix4;
}

export interface SceneOrderEntry {
    type: 'group' | 'object';
    id: string;
}

export type SceneDragItemType = 'group' | 'object';
export type SceneDropMode = 'before' | 'after' | 'inside' | 'root-end';

export interface SceneDragSource {
    type: SceneDragItemType;
    id: string;
}

export interface SceneDragBundle {
    lead: SceneDragSource;
    items: SceneDragSource[];
}

export interface SceneDropHint {
    mode: SceneDropMode;
    targetType: 'group' | 'object' | 'root';
    targetId: string | null;
    targetEl: HTMLElement | null;
    parentGroupId: string | null;
}

export interface SceneItemLocation {
    parentGroupId: string | null;
    containerKind: 'group' | 'scene';
    container: GroupChild[] | SceneOrderEntry[];
    index: number;
}

export interface SceneInsertionPoint {
    parentGroupId: string | null;
    containerKind: 'group' | 'scene';
    container: GroupChild[] | SceneOrderEntry[];
    index: number;
}

export interface SceneMoveEntry {
    item: SceneDragSource;
    location: SceneItemLocation;
}

export interface ScenePanelSelectionState {
    groups: Set<string>;
    objects: Map<Object3D, Set<number>>;
    primary: { type: 'group'; id: string } | { type: 'object'; mesh: Object3D; instanceId: number } | null;
}

export interface ScenePanelRow {
    type: SceneDragItemType;
    id: string;
    depth: number;
    parentGroupId: string | null;
    visibleIndex: number;
}

export interface LoadedObjectUserData {
    objectUuidToInstance?: Map<string, { mesh: Object3D; instanceId: number }>;
    instanceKeyToObjectUuid?: Map<string, string>;
    objectNames?: Map<string, string>;
    objectLabels?: Map<string, string>;
    objectIsItemDisplay?: Set<string>;
    objectDisplayTypes?: Map<string, string>;
    objectBlockProps?: Map<string, any>;
    groups?: Map<string, GroupData>;
    objectToGroup?: Map<string, string>;
    sceneOrder?: SceneOrderEntry[];
    replaceSelectionWithGroupsAndObjects?: (
        groupIds: Set<string>,
        meshToIds: Map<Object3D, Set<number>>,
        opts?: { anchorMode?: string; primaryIsRangeStart?: boolean }
    ) => void;
    addOrToggleInSelection?: (
        groupIds: Set<string> | null,
        meshToIds: Map<Object3D, Set<number>> | null
    ) => void;
    resetSelection?: () => void;
    deleteSelected?: () => void;
    duplicateSelected?: () => void;
    groupSelected?: () => void;
    ungroupSelected?: (groupId: string) => void;
}

export interface ScenePanelState {
    scenePanelList: HTMLElement | null;
    scenePanelContentEl: HTMLElement | null;
    scenePanelSpacerEl: HTMLElement | null;
    sceneExtraFitRaf: number;
    scenePanelRenderRaf: number;
    extraTokenCache: WeakMap<HTMLElement, string[]>;
    rowHeight: number;
    rowOverscan: number;
    visibleRows: ScenePanelRow[];
    renderedRowEls: Map<number, HTMLElement>;
    lastClickedItem: ScenePanelRow | null;
    expandedGroupIds: Set<string>;
    sceneDragBundle: SceneDragBundle | null;
    sceneDropHint: SceneDropHint | null;
    sceneDropMarkerEl: HTMLElement | null;
    sceneDropMarkerClass: 'scene-drop-before' | 'scene-drop-after' | 'scene-drop-inside' | null;
    sceneDragPreviewEl: HTMLElement | null;
    sceneAutoExpandTimer: number;
    sceneAutoExpandGroupId: string | null;
    suppressSceneItemClickUntil: number;
}
