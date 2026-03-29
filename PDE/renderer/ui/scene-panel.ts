import * as THREE from 'three/webgpu';
import { loadedObjectGroup } from '../load-project/upload-pbde';
import { currentSelection } from '../controls/select';

// ----- Interfaces -----

interface GroupChild {
    type: 'group' | 'object';
    id: string;
    mesh?: THREE.Object3D;
    instanceId?: number;
}

interface GroupData {
    id: string;
    isCollection?: boolean;
    children: GroupChild[];
    parent: string | null;
    name: string;
    position: THREE.Vector3 | { x: number; y: number; z: number };
    quaternion: THREE.Quaternion | { x: number; y: number; z: number; w: number };
    scale: THREE.Vector3 | { x: number; y: number; z: number };
    pivot?: [number, number, number];
}

interface SceneOrderEntry {
    type: 'group' | 'object';
    id: string;
}

interface SelectionState {
    groups: Set<string>;
    objects: Map<THREE.Object3D, Set<number>>;
    primary: { type: 'group'; id: string } | { type: 'object'; mesh: THREE.Object3D; instanceId: number } | null;
}

interface LoadedObjectUserData {
    objectUuidToInstance?: Map<string, { mesh: THREE.Object3D; instanceId: number }>;
    instanceKeyToObjectUuid?: Map<string, string>;
    objectNames?: Map<string, string>;
    objectIsItemDisplay?: Set<string>;
    objectDisplayTypes?: Map<string, string>;
    objectBlockProps?: Map<string, any>;
    groups?: Map<string, GroupData>;
    objectToGroup?: Map<string, string>;
    sceneOrder?: SceneOrderEntry[];
    replaceSelectionWithGroupsAndObjects?: (
        groupIds: Set<string>,
        meshToIds: Map<THREE.Object3D, Set<number>>,
        opts?: { anchorMode?: string; primaryIsRangeStart?: boolean }
    ) => void;
    addOrToggleInSelection?: (
        groupIds: Set<string> | null,
        meshToIds: Map<THREE.Object3D, Set<number>> | null
    ) => void;
    resetSelection?: () => void;
    // 신규 추가: 씬 조작 메서드
    deleteSelected?: () => void;
    duplicateSelected?: () => void;
    groupSelected?: () => void;
    ungroupSelected?: (groupId: string) => void;
}

// ----- Scene 패널 오브젝트 목록 갱신 -----
const scenePanelList = document.getElementById('scene-object-list') as HTMLElement | null;
let sceneExtraFitRaf = 0;
const extraTokenCache = new WeakMap<HTMLElement, string[]>();
const ELLIPSIS = '...';

let lastClickedItem: HTMLElement | null = null;
const expandedGroupIds = new Set<string>();

type SceneDragItemType = 'group' | 'object';
type SceneDropMode = 'before' | 'after' | 'inside' | 'root-end';

interface SceneDragSource {
    type: SceneDragItemType;
    id: string;
}

interface SceneDragBundle {
    lead: SceneDragSource;
    items: SceneDragSource[];
}

interface SceneDropHint {
    mode: SceneDropMode;
    targetType: 'group' | 'object' | 'root';
    targetId: string | null;
    targetEl: HTMLElement | null;
    parentGroupId: string | null;
}

interface SceneItemLocation {
    parentGroupId: string | null;
    containerKind: 'group' | 'scene';
    container: GroupChild[] | SceneOrderEntry[];
    index: number;
}

interface SceneInsertionPoint {
    parentGroupId: string | null;
    containerKind: 'group' | 'scene';
    container: GroupChild[] | SceneOrderEntry[];
    index: number;
}

interface SceneMoveEntry {
    item: SceneDragSource;
    location: SceneItemLocation;
}

let sceneDragBundle: SceneDragBundle | null = null;
let sceneDropHint: SceneDropHint | null = null;
let sceneDropMarkerEl: HTMLElement | null = null;
let sceneDropMarkerClass: 'scene-drop-before' | 'scene-drop-after' | 'scene-drop-inside' | null = null;
let sceneDragPreviewEl: HTMLElement | null = null;
let sceneAutoExpandTimer = 0;
let sceneAutoExpandGroupId: string | null = null;
let suppressSceneItemClickUntil = 0;

function handleSceneItemClick(e: MouseEvent, el: HTMLElement): void {
    if (Date.now() < suppressSceneItemClickUntil) {
        e.preventDefault();
        e.stopPropagation();
        return;
    }

    const ud = loadedObjectGroup.userData as LoadedObjectUserData;
    if (!ud) return;

    if (e.ctrlKey && e.shiftKey && lastClickedItem && lastClickedItem !== el && scenePanelList) {
        const visibleItems = Array.from(scenePanelList.querySelectorAll('.scene-object-item, .scene-tree-group'))
            .filter(node => (node as HTMLElement).offsetParent !== null) as HTMLElement[];
            
        const idx1 = visibleItems.indexOf(lastClickedItem);
        const idx2 = visibleItems.indexOf(el);
        
        if (idx1 !== -1 && idx2 !== -1) {
            const start = Math.min(idx1, idx2);
            const end = Math.max(idx1, idx2);
            
            const rangeGroups = new Set<string>();
            const rangeObjects = new Map<THREE.Object3D, Set<number>>();
            const uuidToInstance = ud.objectUuidToInstance;
            
            const selectedNodes = scenePanelList.querySelectorAll('.selected') as NodeListOf<HTMLElement>;
            selectedNodes.forEach(node => {
                if (node.dataset.displayType === 'group') {
                    const gId = node.dataset.groupId;
                    if (gId) rangeGroups.add(gId);
                } else if (node.dataset.uuid) {
                    const uuid = node.dataset.uuid;
                    if (uuid && uuidToInstance) {
                        const inst = uuidToInstance.get(uuid);
                        if (inst) {
                            if (!rangeObjects.has(inst.mesh)) {
                                rangeObjects.set(inst.mesh, new Set());
                            }
                            rangeObjects.get(inst.mesh)!.add(inst.instanceId);
                        }
                    }
                }
            });
            
            for (let i = start; i <= end; i++) {
                const node = visibleItems[i];
                if (node.dataset.displayType === 'group') {
                    const gId = node.dataset.groupId;
                    if (gId) {
                        rangeGroups.add(gId);
                    }
                } else {
                    const uuid = node.dataset.uuid;
                    if (uuid && uuidToInstance) {
                        const inst = uuidToInstance.get(uuid);
                        if (inst) {
                            if (!rangeObjects.has(inst.mesh)) {
                                rangeObjects.set(inst.mesh, new Set());
                            }
                            rangeObjects.get(inst.mesh)!.add(inst.instanceId);
                        }
                    }
                }
            }
            
            const sortedRangeGroups = new Set<string>();
            const sortedRangeObjects = new Map<THREE.Object3D, Set<number>>();
            
            if (lastClickedItem.dataset.displayType === 'group') {
                const gId = lastClickedItem.dataset.groupId;
                if (gId) sortedRangeGroups.add(gId);
            } else {
                const uuid = lastClickedItem.dataset.uuid;
                if (uuid && uuidToInstance) {
                    const inst = uuidToInstance.get(uuid);
                    if (inst) {
                        sortedRangeObjects.set(inst.mesh, new Set([inst.instanceId]));
                    }
                }
            }
            
            rangeGroups.forEach(g => sortedRangeGroups.add(g));
            rangeObjects.forEach((ids, mesh) => {
                if (!sortedRangeObjects.has(mesh)) {
                    sortedRangeObjects.set(mesh, new Set());
                }
                const set = sortedRangeObjects.get(mesh)!;
                ids.forEach(id => set.add(id));
            });

            ud.replaceSelectionWithGroupsAndObjects?.(sortedRangeGroups, sortedRangeObjects, { 
                anchorMode: 'default',
                primaryIsRangeStart: true
            });
            return;
        }
    }

    lastClickedItem = el;

    let groupIds: Set<string> | null = null;
    let meshToIds: Map<THREE.Object3D, Set<number>> | null = null;

    if (el.dataset.displayType === 'group') {
        const groupId = el.dataset.groupId;
        if (groupId) groupIds = new Set([groupId]);
    } else {
        const uuidToInstance = ud.objectUuidToInstance;
        const uuid = el.dataset.uuid;
        if (uuidToInstance && uuid) {
            const inst = uuidToInstance.get(uuid);
            if (inst) {
                meshToIds = new Map([[inst.mesh, new Set([inst.instanceId])]]);
            }
        }
    }

    if (e.shiftKey || e.ctrlKey || e.metaKey) {
        ud.addOrToggleInSelection?.(groupIds, meshToIds);
    } else {
        ud.replaceSelectionWithGroupsAndObjects?.(groupIds || new Set(), meshToIds || new Map(), { anchorMode: 'default' });
    }
}

function cleanLabel(rawName: string): string {
    return (rawName || '')
        .replace(/^[^:]+:/, '')  // 네임스페이스 제거
        .replace(/\[.*\]$/, '')  // 블록스테이트 프로퍼티 제거
        .trim();                 // 앞뒤 공백 제거
}

function makeObjectRow(uuid: string, depth: number): HTMLElement {
    const ud = loadedObjectGroup.userData as LoadedObjectUserData;
    const objectNames = ud.objectNames;
    const rawName = objectNames?.get(uuid) || uuid.slice(0, 8);
    const itemDisplaySet = ud.objectIsItemDisplay;
    const isItemDisplay = itemDisplaySet?.has(uuid) ?? false;
    
    const displayTypes = ud.objectDisplayTypes;
    const blockPropsMap = ud.objectBlockProps;
    
    let extraInfo = '';
    if (isItemDisplay) {
        const dType = displayTypes?.get(uuid);
        if (dType) extraInfo = `display=${dType}`;
    } else {
        const props = blockPropsMap?.get(uuid);
        if (props) {
            const propStrings = Object.entries(props).map(([k, v]) => `${k}=${v}`);
            if (propStrings.length > 0) {
                extraInfo = propStrings.join(' ');
            }
        }
    }

    const iconCode = isItemDisplay ? '&#xE5C6;' : '&#xE061;';
    const iconClass = isItemDisplay ? 'icon-item' : 'icon-box';
    const el = document.createElement('div');
    el.className = 'scene-object-item';
    el.style.paddingLeft = `${12 + depth * 16}px`;
    el.dataset.uuid = uuid;
    el.dataset.displayType = isItemDisplay ? 'item_display' : 'block_display';
    el.draggable = true;

    const leftIcon = document.createElement('span');
    leftIcon.className = `scene-icon ${iconClass}`;
    leftIcon.innerHTML = iconCode;

    const nameEl = document.createElement('span');
    nameEl.className = 'scene-name';
    const cleanName = cleanLabel(rawName);
    nameEl.dataset.fullText = cleanName;

    const nameTextEl = document.createElement('span');
    nameTextEl.className = 'scene-name-text';
    nameTextEl.textContent = cleanName;

    const nameDotsEl = document.createElement('span');
    nameDotsEl.className = 'scene-name-dots';
    nameDotsEl.textContent = ELLIPSIS;

    nameEl.appendChild(nameTextEl);
    nameEl.appendChild(nameDotsEl);

    el.appendChild(leftIcon);
    el.appendChild(nameEl);

    if (extraInfo) {
        const extraEl = document.createElement('span');
        extraEl.className = 'scene-extra';
        extraEl.dataset.fullText = extraInfo;
        extraEl.textContent = extraInfo;
        el.classList.add('scene-extra-active');
        extraTokenCache.set(extraEl, extraInfo.split(/\s+/).filter(Boolean));
        el.appendChild(extraEl);
    }

    const rightIcon = document.createElement('span');
    rightIcon.className = 'scene-icon-right';
    rightIcon.innerHTML = '&#xE0BA;';
    el.appendChild(rightIcon);

    el.addEventListener('click', (e) => {
        handleSceneItemClick(e, el);
    });
    el.addEventListener('dragstart', (e) => {
        handleSceneItemDragStart(e, { type: 'object', id: uuid }, el);
    });
    el.addEventListener('dragend', handleSceneItemDragEnd);

    return el;
}

function fitSceneExtraBlocks(): void {
    if (!scenePanelList) return;

    const viewTop = scenePanelList.scrollTop;
    const viewBottom = viewTop + scenePanelList.clientHeight;
    const rows = scenePanelList.querySelectorAll('.scene-object-item, .scene-tree-group') as NodeListOf<HTMLElement>;
    
    for (const row of rows) {
        const rowTop = row.offsetTop;
        const rowBottom = rowTop + row.offsetHeight;
        if (rowBottom < viewTop - 40 || rowTop > viewBottom + 40) continue;

        const nameEl = row.querySelector('.scene-name') as HTMLElement | null;
        const nameTextEl = row.querySelector('.scene-name-text') as HTMLElement | null;
        const nameDotsEl = row.querySelector('.scene-name-dots') as HTMLElement | null;
        const extraEl = row.querySelector('.scene-extra') as HTMLElement | null;
        if (!nameEl || !nameTextEl || !nameDotsEl) continue;

        const fullName = nameEl.dataset.fullText || '';
        const setNameByCount = (count: number, showDots = true) => {
            const safeCount = Math.max(0, Math.min(count, fullName.length));
            if (safeCount >= fullName.length) {
                nameTextEl.textContent = fullName;
                nameDotsEl.style.display = 'none';
                return;
            }

            nameTextEl.textContent = fullName.slice(0, safeCount);
            nameDotsEl.style.display = showDots ? 'inline' : 'none';
        };

        const isOverflow = () => row.scrollWidth > row.clientWidth + 1;

        setNameByCount(fullName.length);

        if (!extraEl) {
            if (!isOverflow()) continue;

            let lowNameOnly = 0;
            let highNameOnly = fullName.length;
            let bestNameOnly = -1;

            while (lowNameOnly <= highNameOnly) {
                const mid = (lowNameOnly + highNameOnly) >> 1;
                setNameByCount(mid, true);
                if (isOverflow()) {
                    highNameOnly = mid - 1;
                } else {
                    bestNameOnly = mid;
                    lowNameOnly = mid + 1;
                }
            }

            if (bestNameOnly >= 0) setNameByCount(bestNameOnly, true);
            continue;
        }

        const fullText = (extraEl.dataset.fullText || '').trim();
        if (!fullText) {
            extraEl.textContent = '';
            row.classList.remove('scene-extra-active');
            row.classList.remove('scene-extra-ellipsis');

            if (!isOverflow()) continue;

            let lowNameNoExtra = 0;
            let highNameNoExtra = fullName.length;
            let bestNameNoExtra = -1;

            while (lowNameNoExtra <= highNameNoExtra) {
                const mid = (lowNameNoExtra + highNameNoExtra) >> 1;
                setNameByCount(mid, true);
                if (isOverflow()) {
                    highNameNoExtra = mid - 1;
                } else {
                    bestNameNoExtra = mid;
                    lowNameNoExtra = mid + 1;
                }
            }

            if (bestNameNoExtra >= 0) setNameByCount(bestNameNoExtra, true);
            continue;
        }

        let tokens = extraTokenCache.get(extraEl);
        if (!tokens) {
            tokens = fullText.split(/\s+/).filter(Boolean);
            extraTokenCache.set(extraEl, tokens);
        }

        const setExtraByCount = (count: number) => {
            if (!tokens) return;
            if (count <= 0) {
                extraEl.textContent = '';
                return;
            }
            if (count >= tokens.length) {
                extraEl.textContent = fullText;
                return;
            }
            extraEl.textContent = `${tokens.slice(0, count).join(' ')}${ELLIPSIS}`;
        };

        row.classList.add('scene-extra-active');
        row.classList.remove('scene-extra-ellipsis');
        extraEl.textContent = fullText;

        if (!isOverflow()) {
            continue;
        }

        let lowExtra = 1;
        let highExtra = tokens.length - 1;
        let bestExtraFit = 0;

        while (lowExtra <= highExtra) {
            const mid = (lowExtra + highExtra) >> 1;
            setExtraByCount(mid);
            if (isOverflow()) {
                highExtra = mid - 1;
            } else {
                bestExtraFit = mid;
                lowExtra = mid + 1;
            }
        }

        if (bestExtraFit > 0) {
            row.classList.add('scene-extra-active');
            row.classList.remove('scene-extra-ellipsis');
            setExtraByCount(bestExtraFit);
        } else {
            extraEl.textContent = ELLIPSIS;
            row.classList.remove('scene-extra-active');
            row.classList.add('scene-extra-ellipsis');
        }

        if (!isOverflow()) {
            setNameByCount(fullName.length, false);
            continue;
        }

        let lowNameAfterExtra = 0;
        let highNameAfterExtra = fullName.length;
        let bestNameAfterExtra = -1;

        while (lowNameAfterExtra <= highNameAfterExtra) {
            const mid = (lowNameAfterExtra + highNameAfterExtra) >> 1;
            setNameByCount(mid, false);
            if (isOverflow()) {
                highNameAfterExtra = mid - 1;
            } else {
                bestNameAfterExtra = mid;
                lowNameAfterExtra = mid + 1;
            }
        }

        if (bestNameAfterExtra >= 0) setNameByCount(bestNameAfterExtra, false);
    }
}

function scheduleSceneExtraFit(): void {
    if (sceneExtraFitRaf) return;
    sceneExtraFitRaf = requestAnimationFrame(() => {
        sceneExtraFitRaf = 0;
        fitSceneExtraBlocks();
    });
}

window.addEventListener('resize', scheduleSceneExtraFit);
scenePanelList?.addEventListener('scroll', scheduleSceneExtraFit, { passive: true });
scenePanelList?.addEventListener('dragover', handleScenePanelDragOver);
scenePanelList?.addEventListener('drop', handleScenePanelDrop);
scenePanelList?.addEventListener('dragleave', handleScenePanelDragLeave);

function resolveChildObjectUuid(child: GroupChild, ud: LoadedObjectUserData): string | null {
    if (child.type !== 'object') return null;
    if (child.id) return child.id;
    if (!child.mesh || typeof child.instanceId !== 'number') return null;
    return ud.instanceKeyToObjectUuid?.get(`${child.mesh.uuid}_${child.instanceId}`) ?? null;
}

function isObjectUuidGrouped(uuid: string, ud: LoadedObjectUserData): boolean {
    const inst = ud.objectUuidToInstance?.get(uuid);
    if (!inst) return false;
    const key = `${inst.mesh.uuid}_${inst.instanceId}`;
    return ud.objectToGroup?.has(key) ?? false;
}

function hasRenderableObject(uuid: string, ud: LoadedObjectUserData): boolean {
    return ud.objectUuidToInstance?.has(uuid) ?? false;
}

function ensureSceneOrderSeeded(ud: LoadedObjectUserData): SceneOrderEntry[] {
    if (!Array.isArray(ud.sceneOrder)) {
        ud.sceneOrder = [];
    }

    const sceneOrder = ud.sceneOrder;
    if (sceneOrder.length > 0 || !scenePanelList) return sceneOrder;

    const seen = new Set<string>();
    const pushRootEntry = (entry: SceneOrderEntry): void => {
        const key = `${entry.type}:${entry.id}`;
        if (seen.has(key)) return;
        seen.add(key);
        sceneOrder.push(entry);
    };

    const rootNodes = Array.from(scenePanelList.children) as HTMLElement[];
    for (const node of rootNodes) {
        if (node.classList.contains('scene-object-item')) {
            const uuid = node.dataset.uuid;
            if (uuid) pushRootEntry({ type: 'object', id: uuid });
            continue;
        }

        const maybeHeader = node.firstElementChild as HTMLElement | null;
        if (!maybeHeader || !maybeHeader.classList.contains('scene-tree-group')) continue;
        const groupId = maybeHeader.dataset.groupId;
        if (groupId) pushRootEntry({ type: 'group', id: groupId });
    }

    return sceneOrder;
}

function getParentGroupIdFromElement(el: HTMLElement): string | null {
    if (!scenePanelList) return null;

    let node = el.parentElement;
    while (node && node !== scenePanelList) {
        if (node.classList.contains('scene-tree-children')) {
            const header = node.previousElementSibling as HTMLElement | null;
            if (header?.classList.contains('scene-tree-group')) {
                return header.dataset.groupId || null;
            }
        }
        node = node.parentElement;
    }

    return null;
}

function getObjectInstanceByUuid(
    uuid: string,
    ud: LoadedObjectUserData
): { mesh: THREE.Object3D; instanceId: number } | null {
    return ud.objectUuidToInstance?.get(uuid) ?? null;
}

function getObjectGroupKeyByUuid(uuid: string, ud: LoadedObjectUserData): string | null {
    const inst = getObjectInstanceByUuid(uuid, ud);
    if (!inst) return null;
    return `${inst.mesh.uuid}_${inst.instanceId}`;
}

function findObjectChildIndexByUuid(children: GroupChild[], objectUuid: string, ud: LoadedObjectUserData): number {
    for (let i = 0; i < children.length; i++) {
        const child = children[i];
        if (!child || child.type !== 'object') continue;
        if (resolveChildObjectUuid(child, ud) === objectUuid) return i;
    }
    return -1;
}

function findGroupLocation(groupId: string, ud: LoadedObjectUserData): SceneItemLocation | null {
    const groups = ud.groups;
    if (!groups) return null;

    const group = groups.get(groupId);
    if (group?.parent) {
        const parent = groups.get(group.parent);
        if (parent) {
            if (!Array.isArray(parent.children)) parent.children = [];
            const idx = parent.children.findIndex((child) => child.type === 'group' && child.id === groupId);
            if (idx !== -1) {
                return {
                    parentGroupId: group.parent,
                    containerKind: 'group',
                    container: parent.children,
                    index: idx
                };
            }
        }
    }

    const sceneOrder = ensureSceneOrderSeeded(ud);
    const rootIdx = sceneOrder.findIndex((entry) => entry.type === 'group' && entry.id === groupId);
    if (rootIdx !== -1) {
        return {
            parentGroupId: null,
            containerKind: 'scene',
            container: sceneOrder,
            index: rootIdx
        };
    }

    if (group && group.parent === null) {
        sceneOrder.push({ type: 'group', id: groupId });
        return {
            parentGroupId: null,
            containerKind: 'scene',
            container: sceneOrder,
            index: sceneOrder.length - 1
        };
    }

    for (const [parentId, parent] of groups) {
        if (!Array.isArray(parent.children)) continue;
        const idx = parent.children.findIndex((child) => child.type === 'group' && child.id === groupId);
        if (idx !== -1) {
            return {
                parentGroupId: parentId,
                containerKind: 'group',
                container: parent.children,
                index: idx
            };
        }
    }

    return null;
}

function findObjectLocation(objectUuid: string, ud: LoadedObjectUserData): SceneItemLocation | null {
    const groups = ud.groups;
    const objectKey = getObjectGroupKeyByUuid(objectUuid, ud);
    const mappedParentId = objectKey ? (ud.objectToGroup?.get(objectKey) ?? null) : null;

    if (mappedParentId && groups) {
        const parent = groups.get(mappedParentId);
        if (parent) {
            if (!Array.isArray(parent.children)) parent.children = [];
            const idx = findObjectChildIndexByUuid(parent.children, objectUuid, ud);
            if (idx !== -1) {
                return {
                    parentGroupId: mappedParentId,
                    containerKind: 'group',
                    container: parent.children,
                    index: idx
                };
            }
        }
    }

    const sceneOrder = ensureSceneOrderSeeded(ud);
    const rootIdx = sceneOrder.findIndex((entry) => entry.type === 'object' && entry.id === objectUuid);
    if (rootIdx !== -1) {
        return {
            parentGroupId: null,
            containerKind: 'scene',
            container: sceneOrder,
            index: rootIdx
        };
    }

    if (groups) {
        for (const [parentId, parent] of groups) {
            if (!Array.isArray(parent.children)) continue;
            const idx = findObjectChildIndexByUuid(parent.children, objectUuid, ud);
            if (idx !== -1) {
                return {
                    parentGroupId: parentId,
                    containerKind: 'group',
                    container: parent.children,
                    index: idx
                };
            }
        }
    }

    if (hasRenderableObject(objectUuid, ud)) {
        sceneOrder.push({ type: 'object', id: objectUuid });
        return {
            parentGroupId: null,
            containerKind: 'scene',
            container: sceneOrder,
            index: sceneOrder.length - 1
        };
    }

    return null;
}

function getSceneDragItemKey(item: SceneDragSource): string {
    return `${item.type}:${item.id}`;
}

function getSceneDragItemElement(item: SceneDragSource): HTMLElement | null {
    if (!scenePanelList) return null;
    if (item.type === 'group') {
        return scenePanelList.querySelector(`.scene-tree-group[data-group-id="${item.id}"]`) as HTMLElement | null;
    }
    return scenePanelList.querySelector(`.scene-object-item[data-uuid="${item.id}"]`) as HTMLElement | null;
}

function clearSceneDragPreview(): void {
    if (sceneDragPreviewEl?.parentElement) {
        sceneDragPreviewEl.parentElement.removeChild(sceneDragPreviewEl);
    }
    sceneDragPreviewEl = null;
}

function createSceneDragPreview(bundle: SceneDragBundle): HTMLElement | null {
    if (!scenePanelList || !bundle.items || bundle.items.length === 0) return null;

    clearSceneDragPreview();

    const ud = loadedObjectGroup.userData as LoadedObjectUserData;
    const selectedObjectUuids = collectSelectedObjectUuids(ud);

    const preview = document.createElement('div');
    preview.className = 'scene-drag-preview';

    const maxRows = 8;
    const itemsToRender = bundle.items.slice(0, maxRows);

    for (const item of itemsToRender) {
        const sourceEl = getSceneDragItemElement(item);
        const row = sourceEl
            ? (sourceEl.cloneNode(true) as HTMLElement)
            : document.createElement('div');

        if (!sourceEl) {
            row.className = item.type === 'group' ? 'scene-tree-group' : 'scene-object-item';
            row.textContent = item.id;
            if (isSceneDragSourceSelected(item, ud, selectedObjectUuids)) {
                row.classList.add('selected');
            }
        }

        row.removeAttribute('draggable');
        row.classList.remove('scene-drag-source');
        row.classList.remove('scene-drop-before');
        row.classList.remove('scene-drop-after');
        row.classList.remove('scene-drop-inside');
        row.classList.add('scene-drag-preview-row');
        preview.appendChild(row);
    }

    const omittedCount = bundle.items.length - itemsToRender.length;
    if (omittedCount > 0) {
        const moreEl = document.createElement('div');
        moreEl.className = 'scene-drag-preview-more';
        moreEl.textContent = `+${omittedCount} more`;
        preview.appendChild(moreEl);
    }

    const previewWidth = Math.max(180, Math.min(scenePanelList.clientWidth - 6, 320));
    preview.style.width = `${previewWidth}px`;

    document.body.appendChild(preview);
    sceneDragPreviewEl = preview;
    return preview;
}

function collectSelectedObjectUuids(ud: LoadedObjectUserData): Set<string> {
    const out = new Set<string>();
    const keyToUuid = ud.instanceKeyToObjectUuid;
    if (!keyToUuid) return out;

    for (const [mesh, ids] of currentSelection.objects) {
        for (const instanceId of ids) {
            const uuid = keyToUuid.get(`${mesh.uuid}_${instanceId}`);
            if (uuid) out.add(uuid);
        }
    }

    return out;
}

function isSceneDragSourceSelected(
    source: SceneDragSource,
    ud: LoadedObjectUserData,
    selectedObjectUuids?: Set<string>
): boolean {
    if (source.type === 'group') {
        return currentSelection.groups?.has(source.id) ?? false;
    }

    const objectSet = selectedObjectUuids ?? collectSelectedObjectUuids(ud);
    return objectSet.has(source.id);
}

function collectSceneDragBundleItems(
    ud: LoadedObjectUserData,
    selectedObjectUuids?: Set<string>
): SceneDragSource[] {
    const groups = ud.groups;

    const selectedGroupSet = new Set<string>();
    for (const groupId of currentSelection.groups) {
        if (groupId && groups?.has(groupId)) {
            selectedGroupSet.add(groupId);
        }
    }

    const topGroupSet = new Set<string>();
    for (const groupId of selectedGroupSet) {
        let parentId = groups?.get(groupId)?.parent ?? null;
        let hasSelectedAncestor = false;

        while (parentId) {
            if (selectedGroupSet.has(parentId)) {
                hasSelectedAncestor = true;
                break;
            }
            parentId = groups?.get(parentId)?.parent ?? null;
        }

        if (!hasSelectedAncestor) {
            topGroupSet.add(groupId);
        }
    }

    const objectSet = selectedObjectUuids ?? collectSelectedObjectUuids(ud);
    const dragItems: SceneDragSource[] = [];

    for (const groupId of topGroupSet) {
        dragItems.push({ type: 'group', id: groupId });
    }

    for (const uuid of objectSet) {
        if (!ud.objectUuidToInstance?.has(uuid)) continue;

        let coveredBySelectedGroup = false;
        const objectKey = getObjectGroupKeyByUuid(uuid, ud);
        let parentId = objectKey ? (ud.objectToGroup?.get(objectKey) ?? null) : null;

        while (parentId) {
            if (topGroupSet.has(parentId)) {
                coveredBySelectedGroup = true;
                break;
            }
            parentId = groups?.get(parentId)?.parent ?? null;
        }

        if (!coveredBySelectedGroup) {
            dragItems.push({ type: 'object', id: uuid });
        }
    }

    const dedupMap = new Map<string, SceneDragSource>();
    for (const item of dragItems) {
        dedupMap.set(getSceneDragItemKey(item), item);
    }

    const orderMap = new Map<string, number>();
    if (scenePanelList) {
        const nodes = scenePanelList.querySelectorAll('.scene-object-item, .scene-tree-group');
        nodes.forEach((node, index) => {
            const el = node as HTMLElement;
            if (el.classList.contains('scene-tree-group')) {
                const groupId = el.dataset.groupId;
                if (groupId) orderMap.set(`group:${groupId}`, index);
                return;
            }
            const uuid = el.dataset.uuid;
            if (uuid) orderMap.set(`object:${uuid}`, index);
        });
    }

    const dedupedItems = Array.from(dedupMap.values());
    dedupedItems.sort((a, b) => {
        const aKey = getSceneDragItemKey(a);
        const bKey = getSceneDragItemKey(b);
        const aOrder = orderMap.get(aKey) ?? Number.MAX_SAFE_INTEGER;
        const bOrder = orderMap.get(bKey) ?? Number.MAX_SAFE_INTEGER;
        if (aOrder !== bOrder) return aOrder - bOrder;
        if (aKey < bKey) return -1;
        if (aKey > bKey) return 1;
        return 0;
    });

    return dedupedItems;
}

function buildSceneDragBundle(source: SceneDragSource, ud: LoadedObjectUserData): SceneDragBundle {
    const single: SceneDragBundle = { lead: source, items: [source] };

    const selectedObjectUuids = collectSelectedObjectUuids(ud);
    const totalSelectedCount = currentSelection.groups.size + selectedObjectUuids.size;
    if (totalSelectedCount <= 1) return single;

    if (!isSceneDragSourceSelected(source, ud, selectedObjectUuids)) return single;

    const bundleItems = collectSceneDragBundleItems(ud, selectedObjectUuids);
    if (bundleItems.length === 0) return single;

    return {
        lead: source,
        items: bundleItems
    };
}

function isGroupAncestorOf(groups: Map<string, GroupData>, ancestorId: string, candidateGroupId: string): boolean {
    let current: string | null = candidateGroupId;
    while (current) {
        if (current === ancestorId) return true;
        current = groups.get(current)?.parent ?? null;
    }
    return false;
}

function isValidSceneDropHint(bundle: SceneDragBundle, hint: SceneDropHint, ud: LoadedObjectUserData): boolean {
    if (!bundle.items || bundle.items.length === 0) return false;
    if (hint.mode === 'inside' && hint.targetType !== 'group') return false;
    if (hint.targetType !== 'root' && !hint.targetId) return false;

    for (const item of bundle.items) {
        if (item.type === 'group') {
            if (!ud.groups?.has(item.id)) return false;
        } else if (!ud.objectUuidToInstance?.has(item.id)) {
            return false;
        }
    }

    const dragKeySet = new Set<string>();
    for (const item of bundle.items) {
        dragKeySet.add(getSceneDragItemKey(item));
    }

    if (hint.targetType !== 'root' && hint.targetId && hint.mode !== 'inside') {
        const targetKey = `${hint.targetType}:${hint.targetId}`;
        if (dragKeySet.has(targetKey)) return false;
    }

    if (hint.mode === 'inside' && hint.targetType === 'group' && hint.targetId) {
        if (dragKeySet.has(`group:${hint.targetId}`)) return false;
    }

    if (hint.targetType === 'group' && hint.targetId && !ud.groups?.has(hint.targetId)) return false;
    if (hint.targetType === 'object' && hint.targetId && !ud.objectUuidToInstance?.has(hint.targetId)) return false;

    if (ud.groups) {
        const newParentId = (hint.mode === 'inside' && hint.targetType === 'group') ? hint.targetId : hint.parentGroupId;
        if (newParentId) {
            for (const item of bundle.items) {
                if (item.type !== 'group') continue;
                if (isGroupAncestorOf(ud.groups, item.id, newParentId)) return false;
            }
        }
    }

    return true;
}

function resolveInsertionPointFromDropHint(hint: SceneDropHint, ud: LoadedObjectUserData): SceneInsertionPoint | null {
    const groups = ud.groups;
    const sceneOrder = ensureSceneOrderSeeded(ud);

    if (hint.mode === 'root-end' || hint.targetType === 'root') {
        return {
            parentGroupId: null,
            containerKind: 'scene',
            container: sceneOrder,
            index: sceneOrder.length
        };
    }

    if (hint.mode === 'inside') {
        if (hint.targetType !== 'group' || !hint.targetId || !groups) return null;
        const targetGroup = groups.get(hint.targetId);
        if (!targetGroup) return null;
        if (!Array.isArray(targetGroup.children)) targetGroup.children = [];
        return {
            parentGroupId: targetGroup.id,
            containerKind: 'group',
            container: targetGroup.children,
            index: targetGroup.children.length
        };
    }

    const targetLocation = hint.targetType === 'group'
        ? findGroupLocation(hint.targetId || '', ud)
        : findObjectLocation(hint.targetId || '', ud);
    if (!targetLocation) return null;

    return {
        parentGroupId: targetLocation.parentGroupId,
        containerKind: targetLocation.containerKind,
        container: targetLocation.container,
        index: targetLocation.index + (hint.mode === 'after' ? 1 : 0)
    };
}

function moveSceneItemsByDropHint(bundle: SceneDragBundle, hint: SceneDropHint, ud: LoadedObjectUserData): boolean {
    const insertion = resolveInsertionPointFromDropHint(hint, ud);
    if (!insertion) return false;

    const moveEntries: SceneMoveEntry[] = [];
    const seen = new Set<string>();

    for (const item of bundle.items) {
        const itemKey = getSceneDragItemKey(item);
        if (seen.has(itemKey)) continue;
        seen.add(itemKey);

        const location = item.type === 'group'
            ? findGroupLocation(item.id, ud)
            : findObjectLocation(item.id, ud);
        if (!location) continue;

        if (item.type === 'group') {
            if (!ud.groups?.has(item.id)) continue;
        } else if (!getObjectInstanceByUuid(item.id, ud)) {
            continue;
        }

        moveEntries.push({ item, location });
    }

    if (moveEntries.length === 0) return false;

    let insertionIndex = insertion.index;
    for (const entry of moveEntries) {
        if (entry.location.container === insertion.container && entry.location.index < insertionIndex) {
            insertionIndex--;
        }
    }

    const sameContainerEntries = moveEntries.filter((entry) => entry.location.container === insertion.container);
    if (sameContainerEntries.length === moveEntries.length) {
        const sortedIndices = sameContainerEntries
            .map((entry) => entry.location.index)
            .sort((a, b) => a - b);

        let isContiguous = true;
        for (let i = 1; i < sortedIndices.length; i++) {
            if (sortedIndices[i] !== sortedIndices[i - 1] + 1) {
                isContiguous = false;
                break;
            }
        }

        if (isContiguous && insertionIndex === sortedIndices[0]) {
            return false;
        }
    }

    const removalOrder = moveEntries.slice().sort((a, b) => {
        if (a.location.container === b.location.container) {
            return b.location.index - a.location.index;
        }
        return 0;
    });

    for (const entry of removalOrder) {
        const { container, index } = entry.location;
        if (index >= 0 && index < container.length) {
            container.splice(index, 1);
        }
    }

    insertionIndex = Math.max(0, Math.min(insertionIndex, insertion.container.length));
    let insertedCount = 0;

    for (const entry of moveEntries) {
        const item = entry.item;

        if (item.type === 'group') {
            const group = ud.groups?.get(item.id);
            if (!group) continue;

            group.parent = insertion.parentGroupId;

            if (insertion.containerKind === 'group') {
                (insertion.container as GroupChild[]).splice(insertionIndex + insertedCount, 0, { type: 'group', id: item.id });
            } else {
                (insertion.container as SceneOrderEntry[]).splice(insertionIndex + insertedCount, 0, { type: 'group', id: item.id });
            }

            insertedCount++;
            continue;
        }

        const inst = getObjectInstanceByUuid(item.id, ud);
        if (!inst) continue;

        if (!ud.objectToGroup) ud.objectToGroup = new Map<string, string>();
        const objectKey = `${inst.mesh.uuid}_${inst.instanceId}`;
        if (insertion.parentGroupId) {
            ud.objectToGroup.set(objectKey, insertion.parentGroupId);
        } else {
            ud.objectToGroup.delete(objectKey);
        }

        if (insertion.containerKind === 'group') {
            (insertion.container as GroupChild[]).splice(insertionIndex + insertedCount, 0, {
                type: 'object',
                id: item.id,
                mesh: inst.mesh,
                instanceId: inst.instanceId
            });
        } else {
            (insertion.container as SceneOrderEntry[]).splice(insertionIndex + insertedCount, 0, {
                type: 'object',
                id: item.id
            });
        }

        insertedCount++;
    }

    return insertedCount > 0;
}

function clearSceneAutoExpandTimer(): void {
    if (sceneAutoExpandTimer) {
        window.clearTimeout(sceneAutoExpandTimer);
        sceneAutoExpandTimer = 0;
    }
    sceneAutoExpandGroupId = null;
}

function clearSceneDropMarker(): void {
    if (sceneDropMarkerEl && sceneDropMarkerClass) {
        sceneDropMarkerEl.classList.remove(sceneDropMarkerClass);
    }
    sceneDropMarkerEl = null;
    sceneDropMarkerClass = null;
    scenePanelList?.classList.remove('scene-drop-root-end');
}

function applySceneDropMarker(hint: SceneDropHint): void {
    clearSceneDropMarker();
    if (!scenePanelList) return;

    if (hint.mode === 'root-end' || hint.targetType === 'root' || !hint.targetEl) {
        scenePanelList.classList.add('scene-drop-root-end');
        return;
    }

    const markerClass = hint.mode === 'before'
        ? 'scene-drop-before'
        : (hint.mode === 'after' ? 'scene-drop-after' : 'scene-drop-inside');

    hint.targetEl.classList.add(markerClass);
    sceneDropMarkerEl = hint.targetEl;
    sceneDropMarkerClass = markerClass;
}

function scheduleSceneAutoExpand(hint: SceneDropHint): void {
    if (hint.mode !== 'inside' || hint.targetType !== 'group' || !hint.targetId || !hint.targetEl) {
        clearSceneAutoExpandTimer();
        return;
    }

    const childContainer = hint.targetEl.nextElementSibling as HTMLElement | null;
    if (!childContainer?.classList.contains('scene-tree-children') || !childContainer.classList.contains('collapsed')) {
        clearSceneAutoExpandTimer();
        return;
    }

    if (sceneAutoExpandTimer && sceneAutoExpandGroupId === hint.targetId) return;

    clearSceneAutoExpandTimer();
    sceneAutoExpandGroupId = hint.targetId;
    sceneAutoExpandTimer = window.setTimeout(() => {
        const groupId = sceneAutoExpandGroupId;
        sceneAutoExpandTimer = 0;
        sceneAutoExpandGroupId = null;
        if (!groupId || !scenePanelList) return;

        const header = scenePanelList.querySelector(`.scene-tree-group[data-group-id="${groupId}"]`) as HTMLElement | null;
        if (!header) return;
        const children = header.nextElementSibling as HTMLElement | null;
        if (!children?.classList.contains('scene-tree-children') || !children.classList.contains('collapsed')) return;

        children.classList.remove('collapsed');
        expandedGroupIds.add(groupId);
        const toggle = header.querySelector('.scene-toggle');
        if (toggle) toggle.innerHTML = '&#xE06D;';
        scheduleSceneExtraFit();
    }, 420);
}

function computeSceneDropHint(event: DragEvent): SceneDropHint | null {
    if (!scenePanelList) return null;

    const target = (event.target as HTMLElement | null)?.closest('.scene-tree-group, .scene-object-item') as HTMLElement | null;
    if (!target || !scenePanelList.contains(target)) {
        return {
            mode: 'root-end',
            targetType: 'root',
            targetId: null,
            targetEl: null,
            parentGroupId: null
        };
    }

    const parentGroupId = getParentGroupIdFromElement(target);
    const rect = target.getBoundingClientRect();
    const relativeY = rect.height > 0 ? (event.clientY - rect.top) / rect.height : 0.5;

    if (target.classList.contains('scene-tree-group')) {
        const groupId = target.dataset.groupId || null;
        if (!groupId) return null;

        let mode: SceneDropMode = 'inside';
        if (relativeY < 0.25) mode = 'before';
        else if (relativeY > 0.75) mode = 'after';

        return {
            mode,
            targetType: 'group',
            targetId: groupId,
            targetEl: target,
            parentGroupId
        };
    }

    const uuid = target.dataset.uuid || null;
    if (!uuid) return null;

    return {
        mode: relativeY < 0.5 ? 'before' : 'after',
        targetType: 'object',
        targetId: uuid,
        targetEl: target,
        parentGroupId
    };
}

function handleSceneItemDragStart(event: DragEvent, source: SceneDragSource, el: HTMLElement): void {
    const ud = loadedObjectGroup.userData as LoadedObjectUserData;
    if (source.type === 'group') {
        if (!ud.groups?.has(source.id)) {
            event.preventDefault();
            return;
        }
    } else if (!ud.objectUuidToInstance?.has(source.id)) {
        event.preventDefault();
        return;
    }

    const bundle = buildSceneDragBundle(source, ud);
    if (!bundle.items || bundle.items.length === 0) {
        event.preventDefault();
        return;
    }

    sceneDragBundle = bundle;
    sceneDropHint = null;
    clearSceneDropMarker();
    clearSceneAutoExpandTimer();

    for (const item of bundle.items) {
        getSceneDragItemElement(item)?.classList.add('scene-drag-source');
    }
    el.classList.add('scene-drag-source');

    if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', `${source.type}:${source.id}`);
        event.dataTransfer.setData('text/pde-scene-drag-count', String(bundle.items.length));

        const dragPreview = createSceneDragPreview(bundle);
        if (dragPreview) {
            const leadEl = getSceneDragItemElement(bundle.lead) ?? el;
            const rect = leadEl.getBoundingClientRect();
            const rawOffsetX = event.clientX - rect.left;
            const rawOffsetY = event.clientY - rect.top;
            const clampedOffsetX = Math.max(8, Math.min(rawOffsetX || 16, Math.max(8, rect.width - 8)));
            const clampedOffsetY = Math.max(8, Math.min(rawOffsetY || 12, Math.max(8, rect.height - 8)));
            event.dataTransfer.setDragImage(dragPreview, clampedOffsetX, clampedOffsetY);
        }
    }
}

function handleSceneItemDragEnd(): void {
    if (scenePanelList) {
        scenePanelList.querySelectorAll('.scene-drag-source').forEach((node) => {
            node.classList.remove('scene-drag-source');
        });
    }
    clearSceneDragPreview();
    clearSceneDropMarker();
    clearSceneAutoExpandTimer();
    sceneDropHint = null;
    sceneDragBundle = null;
}

function handleScenePanelDragOver(event: DragEvent): void {
    if (!sceneDragBundle) return;

    const ud = loadedObjectGroup.userData as LoadedObjectUserData;
    const hint = computeSceneDropHint(event);

    if (!hint || !isValidSceneDropHint(sceneDragBundle, hint, ud)) {
        sceneDropHint = null;
        clearSceneDropMarker();
        clearSceneAutoExpandTimer();
        return;
    }

    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';

    sceneDropHint = hint;
    applySceneDropMarker(hint);
    scheduleSceneAutoExpand(hint);
}

function handleScenePanelDrop(event: DragEvent): void {
    if (!sceneDragBundle) return;

    event.preventDefault();
    event.stopPropagation();

    const ud = loadedObjectGroup.userData as LoadedObjectUserData;
    const hint = sceneDropHint ?? computeSceneDropHint(event);

    let moved = false;
    if (hint && isValidSceneDropHint(sceneDragBundle, hint, ud)) {
        moved = moveSceneItemsByDropHint(sceneDragBundle, hint, ud);
    }

    handleSceneItemDragEnd();

    if (moved) {
        suppressSceneItemClickUntil = Date.now() + 180;
        window.dispatchEvent(new CustomEvent('pde:scene-updated'));
    }
}

function handleScenePanelDragLeave(event: DragEvent): void {
    if (!sceneDragBundle || !scenePanelList) return;

    const next = event.relatedTarget as Node | null;
    if (next && scenePanelList.contains(next)) return;

    sceneDropHint = null;
    clearSceneDropMarker();
    clearSceneAutoExpandTimer();
}

function renderGroup(groupId: string, depth: number): HTMLElement | null {
    const ud = loadedObjectGroup.userData as LoadedObjectUserData;
    const groups = ud.groups;
    const group = groups?.get(groupId);
    if (!group) return null;

    const isExpanded = expandedGroupIds.has(groupId);
    const wrapper = document.createElement('div');

    // 그룹 헤더
    const header = document.createElement('div');
    header.className = 'scene-tree-group';
    header.style.paddingLeft = `${12 + depth * 16}px`;
    header.dataset.groupId = groupId;
    header.dataset.displayType = 'group';
    header.draggable = true;

    const toggleEl = document.createElement('span');
    toggleEl.className = 'scene-toggle';
    toggleEl.innerHTML = isExpanded ? '&#xE06D;' : '&#xE06F;';
    toggleEl.draggable = false;

    const nameEl = document.createElement('span');
    nameEl.className = 'scene-name';
    const cleanGroupName = group.name || '';
    nameEl.dataset.fullText = cleanGroupName;

    const nameTextEl = document.createElement('span');
    nameTextEl.className = 'scene-name-text';
    nameTextEl.textContent = cleanGroupName;

    const nameDotsEl = document.createElement('span');
    nameDotsEl.className = 'scene-name-dots';
    nameDotsEl.textContent = ELLIPSIS;

    nameEl.appendChild(nameTextEl);
    nameEl.appendChild(nameDotsEl);

    const rightIconEl = document.createElement('span');
    rightIconEl.className = 'scene-icon-right';
    rightIconEl.innerHTML = '&#xE0BA;';

    header.appendChild(toggleEl);
    header.appendChild(nameEl);
    header.appendChild(rightIconEl);

    // 자식 컨테이너
    const childContainer = document.createElement('div');
    childContainer.className = 'scene-tree-children' + (isExpanded ? '' : ' collapsed');

    // 자식: worker가 넣은 children 순서 그대로 표시
    for (const child of (group.children || [])) {
        if (child.type === 'group') {
            const subEl = renderGroup(child.id, depth + 1);
            if (subEl) childContainer.appendChild(subEl);
        } else {
            const objectUuid = resolveChildObjectUuid(child, ud);
            if (objectUuid && hasRenderableObject(objectUuid, ud)) {
                childContainer.appendChild(makeObjectRow(objectUuid, depth + 1));
            }
        }
    }

    // 토글 아이콘 클릭 → 접기/펼치
    toggleEl.addEventListener('click', (e) => {
        e.stopPropagation();
        const isCollapsed = childContainer.classList.toggle('collapsed');
        if (isCollapsed) {
            expandedGroupIds.delete(groupId);
        } else {
            expandedGroupIds.add(groupId);
        }
        toggleEl.innerHTML = isCollapsed ? '&#xE06F;' : '&#xE06D;';
        scheduleSceneExtraFit();
    });

    // 헤더 클릭 → 그룹 선택
    header.addEventListener('click', (e) => {
        handleSceneItemClick(e, header);
    });
    header.addEventListener('dragstart', (e) => {
        handleSceneItemDragStart(e, { type: 'group', id: groupId }, header);
    });
    header.addEventListener('dragend', handleSceneItemDragEnd);

    wrapper.appendChild(header);
    wrapper.appendChild(childContainer);
    return wrapper;
}

export function refreshScenePanel(): void {
    if (!scenePanelList) return;
    scenePanelList.innerHTML = '';

    const ud = loadedObjectGroup.userData as LoadedObjectUserData;
    const objectNames = ud.objectNames;
    const groups = ud.groups;
    const sceneOrder = ud.sceneOrder;

    const fragment = document.createDocumentFragment();
    const renderedRootGroups = new Set<string>();
    const renderedRootObjects = new Set<string>();

    const appendRootGroup = (groupId: string): void => {
        if (!groupId || renderedRootGroups.has(groupId)) return;
        const group = groups?.get(groupId);
        if (!group || group.parent !== null) return;
        const el = renderGroup(groupId, 0);
        if (!el) return;
        renderedRootGroups.add(groupId);
        fragment.appendChild(el);
    };

    const appendRootObject = (uuid: string): void => {
        if (!uuid || renderedRootObjects.has(uuid)) return;
        if (!hasRenderableObject(uuid, ud)) return;
        if (isObjectUuidGrouped(uuid, ud)) return;
        renderedRootObjects.add(uuid);
        fragment.appendChild(makeObjectRow(uuid, 0));
    };

    if (sceneOrder && sceneOrder.length > 0) {
        for (const entry of sceneOrder) {
            if (entry.type === 'group') {
                appendRootGroup(entry.id);
            } else {
                appendRootObject(entry.id);
            }
        }
    }

    if (groups) {
        for (const group of groups.values()) {
            if (group.parent === null) {
                appendRootGroup(group.id);
            }
        }
    }

    if (objectNames) {
        for (const [uuid] of objectNames) {
            appendRootObject(uuid);
        }
    }

    scenePanelList.appendChild(fragment);
    scheduleSceneExtraFit();
    syncScenePanelSelection(currentSelection as any);
}

window.addEventListener('pde:scene-updated', refreshScenePanel);

function _expandAncestors(el: HTMLElement): void {
    if (!scenePanelList) return;
    let node = el.parentElement;
    while (node && node !== scenePanelList) {
        if (node.classList.contains('scene-tree-children') && node.classList.contains('collapsed')) {
            node.classList.remove('collapsed');
            const header = node.previousElementSibling as HTMLElement | null;
            if (header?.classList.contains('scene-tree-group')) {
                const gId = header.dataset.groupId;
                if (gId) expandedGroupIds.add(gId);
                const toggle = header.querySelector('.scene-toggle');
                if (toggle) toggle.innerHTML = '&#xE06D;';
            }
        }
        node = node.parentElement;
    }
}

function syncScenePanelSelection(sel: SelectionState): void {
    if (!scenePanelList) return;

    scenePanelList.querySelectorAll('.selected').forEach(el => el.classList.remove('selected'));

    if (!sel) return;

    let newPrimaryEl: HTMLElement | null = null;
    const ud = loadedObjectGroup.userData as LoadedObjectUserData;

    if (sel.groups && sel.groups.size > 0) {
        for (const groupId of sel.groups) {
            const el = scenePanelList.querySelector(`.scene-tree-group[data-group-id="${groupId}"]`) as HTMLElement | null;
            if (el) {
                el.classList.add('selected');
                _expandAncestors(el);
            }
        }
    }

    if (sel.objects && sel.objects.size > 0) {
        const keyToUuid = ud.instanceKeyToObjectUuid;
        if (keyToUuid) {
            for (const [mesh, ids] of sel.objects) {
                for (const instanceId of ids) {
                    const uuid = keyToUuid.get(`${mesh.uuid}_${instanceId}`);
                    if (!uuid) continue;
                    const el = scenePanelList.querySelector(`.scene-object-item[data-uuid="${uuid}"]`) as HTMLElement | null;
                    if (el) {
                        el.classList.add('selected');
                        _expandAncestors(el);
                    }
                }
            }
        }
    }
    
    if (sel.primary) {
        if (sel.primary.type === 'group') {
            newPrimaryEl = scenePanelList.querySelector(`.scene-tree-group[data-group-id="${sel.primary.id}"]`) as HTMLElement | null;
        } else if (sel.primary.type === 'object') {
            const uuid = ud.instanceKeyToObjectUuid?.get(`${sel.primary.mesh.uuid}_${sel.primary.instanceId}`);
            if (uuid) {
                newPrimaryEl = scenePanelList.querySelector(`.scene-object-item[data-uuid="${uuid}"]`) as HTMLElement | null;
            }
        }
    }

    if (newPrimaryEl) {
        lastClickedItem = newPrimaryEl;
    } else if (!sel.primary && sel.groups?.size === 0 && sel.objects?.size === 0) {
        // Selection was completely cleared
        lastClickedItem = null;
    }
}

window.addEventListener('pde:selection-changed', (e: Event) => {
    const customEvent = e as CustomEvent<SelectionState>;
    syncScenePanelSelection(customEvent.detail);
});
