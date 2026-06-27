import { currentSelection } from '../controls/select';
import { loadedObjectGroup } from '../load-project/upload-pbde';
import { handleSceneItemClick } from './scene-panel-selection';
import {
    handleSceneItemDragEnd,
    handleSceneItemDragStart
} from './scene-panel-dnd';
import { ELLIPSIS, scenePanelState } from './scene-panel-state';
import type {
    LoadedObjectUserData,
    ScenePanelSelectionState
} from './scene-panel-types';
import {
    cleanLabel,
    hasRenderableObject,
    isObjectUuidGrouped,
    resolveChildObjectUuid
} from './scene-panel-model';
import { syncScenePanelSelection } from './scene-panel-selection';

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
        scenePanelState.extraTokenCache.set(extraEl, extraInfo.split(/\s+/).filter(Boolean));
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
    if (!scenePanelState.scenePanelList) return;

    const viewTop = scenePanelState.scenePanelList.scrollTop;
    const viewBottom = viewTop + scenePanelState.scenePanelList.clientHeight;
    const rows = scenePanelState.scenePanelList.querySelectorAll('.scene-object-item, .scene-tree-group') as NodeListOf<HTMLElement>;

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

        let tokens = scenePanelState.extraTokenCache.get(extraEl);
        if (!tokens) {
            tokens = fullText.split(/\s+/).filter(Boolean);
            scenePanelState.extraTokenCache.set(extraEl, tokens);
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

export function scheduleSceneExtraFit(): void {
    if (scenePanelState.sceneExtraFitRaf) return;
    scenePanelState.sceneExtraFitRaf = requestAnimationFrame(() => {
        scenePanelState.sceneExtraFitRaf = 0;
        fitSceneExtraBlocks();
    });
}

function renderGroup(groupId: string, depth: number): HTMLElement | null {
    const ud = loadedObjectGroup.userData as LoadedObjectUserData;
    const groups = ud.groups;
    const group = groups?.get(groupId);
    if (!group) return null;

    const isExpanded = scenePanelState.expandedGroupIds.has(groupId);
    const wrapper = document.createElement('div');

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

    const childContainer = document.createElement('div');
    childContainer.className = 'scene-tree-children' + (isExpanded ? '' : ' collapsed');

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

    toggleEl.addEventListener('click', (e) => {
        e.stopPropagation();
        const isCollapsed = childContainer.classList.toggle('collapsed');
        if (isCollapsed) {
            scenePanelState.expandedGroupIds.delete(groupId);
        } else {
            scenePanelState.expandedGroupIds.add(groupId);
        }
        toggleEl.innerHTML = isCollapsed ? '&#xE06F;' : '&#xE06D;';
        scheduleSceneExtraFit();
    });

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
    if (!scenePanelState.scenePanelList) return;
    scenePanelState.scenePanelList.innerHTML = '';

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

    scenePanelState.scenePanelList.appendChild(fragment);
    scheduleSceneExtraFit();
    syncScenePanelSelection(currentSelection as unknown as ScenePanelSelectionState);
}
