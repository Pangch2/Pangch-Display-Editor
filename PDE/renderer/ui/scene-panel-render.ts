import { currentSelection } from '../controls/select';
import { isPbdeLogEnabled } from '../load-project/pbde-log';
import { loadedObjectGroup } from '../load-project/upload-pbde';
import { handleSceneItemClick, syncScenePanelSelection } from './scene-panel-selection';
import {
    handleSceneItemDragEnd,
    handleSceneItemDragStart
} from './scene-panel-dnd';
import { ELLIPSIS, scenePanelState } from './scene-panel-state';
import type {
    LoadedObjectUserData,
    ScenePanelRow,
    ScenePanelSelectionState
} from './scene-panel-types';
import {
    cleanLabel,
    hasRenderableObject,
    isObjectUuidGrouped,
    resolveChildObjectUuid
} from './scene-panel-model';

function getRowKey(row: ScenePanelRow): string {
    return `${row.type}:${row.id}`;
}

function setRowPosition(el: HTMLElement, row: ScenePanelRow): void {
    el.dataset.visibleIndex = String(row.visibleIndex);
    el.dataset.parentGroupId = row.parentGroupId ?? '';
    el.style.top = `${row.visibleIndex * scenePanelState.rowHeight}px`;
    el.style.height = `${scenePanelState.rowHeight}px`;
    el.style.paddingLeft = `${12 + row.depth * 16}px`;
}

function makeObjectRow(row: ScenePanelRow): HTMLElement {
    const uuid = row.id;
    const ud = loadedObjectGroup.userData as LoadedObjectUserData;
    const rawName = ud.objectNames?.get(uuid) || uuid.slice(0, 8);
    const isItemDisplay = ud.objectIsItemDisplay?.has(uuid) ?? false;

    let extraInfo = '';
    if (isItemDisplay) {
        const dType = ud.objectDisplayTypes?.get(uuid);
        if (dType) extraInfo = `display=${dType}`;
    } else {
        const props = ud.objectBlockProps?.get(uuid);
        if (props) {
            const propStrings = Object.entries(props).map(([k, v]) => `${k}=${v}`);
            if (propStrings.length > 0) extraInfo = propStrings.join(' ');
        }
    }

    const el = document.createElement('div');
    el.className = 'scene-object-item scene-virtual-row';
    el.dataset.uuid = uuid;
    el.dataset.displayType = isItemDisplay ? 'item_display' : 'block_display';
    el.draggable = true;
    setRowPosition(el, row);

    const leftIcon = document.createElement('span');
    leftIcon.className = `scene-icon ${isItemDisplay ? 'icon-item' : 'icon-box'}`;
    leftIcon.innerHTML = isItemDisplay ? '&#xE5C6;' : '&#xE061;';

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

    el.addEventListener('click', (e) => handleSceneItemClick(e, el));
    el.addEventListener('dragstart', (e) => handleSceneItemDragStart(e, { type: 'object', id: uuid }, el));
    el.addEventListener('dragend', handleSceneItemDragEnd);

    return el;
}

function makeGroupRow(row: ScenePanelRow): HTMLElement {
    const ud = loadedObjectGroup.userData as LoadedObjectUserData;
    const group = ud.groups?.get(row.id);
    const isExpanded = scenePanelState.expandedGroupIds.has(row.id);

    const header = document.createElement('div');
    header.className = 'scene-tree-group scene-virtual-row';
    header.dataset.groupId = row.id;
    header.dataset.displayType = 'group';
    header.draggable = true;
    setRowPosition(header, row);

    const toggleEl = document.createElement('span');
    toggleEl.className = 'scene-toggle';
    toggleEl.innerHTML = isExpanded ? '&#xE06D;' : '&#xE06F;';
    toggleEl.draggable = false;

    const nameEl = document.createElement('span');
    nameEl.className = 'scene-name';
    const cleanGroupName = group?.name || '';
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

    toggleEl.addEventListener('click', (e) => {
        e.stopPropagation();
        if (scenePanelState.expandedGroupIds.has(row.id)) {
            scenePanelState.expandedGroupIds.delete(row.id);
        } else {
            scenePanelState.expandedGroupIds.add(row.id);
        }
        rebuildSceneRows();
        syncScenePanelSpacerHeight();
        renderVisibleSceneRows();
        syncScenePanelSelection(currentSelection as unknown as ScenePanelSelectionState);
        scheduleSceneExtraFit();
    });

    header.addEventListener('click', (e) => handleSceneItemClick(e, header));
    header.addEventListener('dragstart', (e) => handleSceneItemDragStart(e, { type: 'group', id: row.id }, header));
    header.addEventListener('dragend', handleSceneItemDragEnd);

    return header;
}

function makeRowElement(row: ScenePanelRow): HTMLElement {
    return row.type === 'group' ? makeGroupRow(row) : makeObjectRow(row);
}

function appendGroupRows(rows: ScenePanelRow[], groupId: string, depth: number, parentGroupId: string | null): void {
    const ud = loadedObjectGroup.userData as LoadedObjectUserData;
    const group = ud.groups?.get(groupId);
    if (!group) return;

    rows.push({ type: 'group', id: groupId, depth, parentGroupId, visibleIndex: rows.length });
    if (!scenePanelState.expandedGroupIds.has(groupId)) return;

    for (const child of (group.children || [])) {
        if (child.type === 'group') {
            appendGroupRows(rows, child.id, depth + 1, groupId);
            continue;
        }

        const objectUuid = resolveChildObjectUuid(child, ud);
        if (objectUuid && hasRenderableObject(objectUuid, ud)) {
            rows.push({ type: 'object', id: objectUuid, depth: depth + 1, parentGroupId: groupId, visibleIndex: rows.length });
        }
    }
}

function rebuildSceneRows(): void {
    const ud = loadedObjectGroup.userData as LoadedObjectUserData;
    const rows: ScenePanelRow[] = [];
    const renderedRootGroups = new Set<string>();
    const renderedRootObjects = new Set<string>();

    const appendRootGroup = (groupId: string): void => {
        if (!groupId || renderedRootGroups.has(groupId)) return;
        const group = ud.groups?.get(groupId);
        if (!group || group.parent !== null) return;
        renderedRootGroups.add(groupId);
        appendGroupRows(rows, groupId, 0, null);
    };

    const appendRootObject = (uuid: string): void => {
        if (!uuid || renderedRootObjects.has(uuid)) return;
        if (!hasRenderableObject(uuid, ud)) return;
        if (isObjectUuidGrouped(uuid, ud)) return;
        renderedRootObjects.add(uuid);
        rows.push({ type: 'object', id: uuid, depth: 0, parentGroupId: null, visibleIndex: rows.length });
    };

    if (ud.sceneOrder && ud.sceneOrder.length > 0) {
        for (const entry of ud.sceneOrder) {
            if (entry.type === 'group') appendRootGroup(entry.id);
            else appendRootObject(entry.id);
        }
    }

    if (ud.groups) {
        for (const group of ud.groups.values()) {
            if (group.parent === null) appendRootGroup(group.id);
        }
    }

    if (ud.objectNames) {
        for (const [uuid] of ud.objectNames) appendRootObject(uuid);
    }

    scenePanelState.visibleRows = rows;
}

function syncScenePanelSpacerHeight(): void {
    if (!scenePanelState.scenePanelSpacerEl) return;
    scenePanelState.scenePanelSpacerEl.style.height = `${scenePanelState.visibleRows.length * scenePanelState.rowHeight}px`;
}

function fitSceneExtraBlocks(): void {
    if (!scenePanelState.scenePanelContentEl) return;

    const rows = scenePanelState.scenePanelContentEl.querySelectorAll('.scene-object-item, .scene-tree-group') as NodeListOf<HTMLElement>;

    for (const row of rows) {
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
                if (isOverflow()) highNameOnly = mid - 1;
                else {
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

        if (!isOverflow()) continue;

        let lowExtra = 1;
        let highExtra = tokens.length - 1;
        let bestExtraFit = 0;

        while (lowExtra <= highExtra) {
            const mid = (lowExtra + highExtra) >> 1;
            setExtraByCount(mid);
            if (isOverflow()) highExtra = mid - 1;
            else {
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
            if (isOverflow()) highNameAfterExtra = mid - 1;
            else {
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

export function renderVisibleSceneRows(): void {
    const list = scenePanelState.scenePanelList;
    const content = scenePanelState.scenePanelContentEl;
    const spacer = scenePanelState.scenePanelSpacerEl;
    if (!list || !content || !spacer) return;

    const renderStartMs = performance.now();
    const rowHeight = scenePanelState.rowHeight;
    const rows = scenePanelState.visibleRows;
    const scrollTop = list.scrollTop;
    const viewportHeight = list.clientHeight;
    const firstIndex = Math.max(0, Math.floor(scrollTop / rowHeight) - scenePanelState.rowOverscan);
    const lastIndex = Math.min(rows.length - 1, Math.ceil((scrollTop + viewportHeight) / rowHeight) + scenePanelState.rowOverscan);
    const wanted = new Set<number>();

    for (let i = firstIndex; i <= lastIndex; i++) wanted.add(i);

    for (const [index, el] of scenePanelState.renderedRowEls) {
        const row = rows[index];
        if (wanted.has(index) && row && el.dataset.rowKey === getRowKey(row)) continue;
        el.remove();
        scenePanelState.renderedRowEls.delete(index);
    }

    const fragment = document.createDocumentFragment();
    for (let i = firstIndex; i <= lastIndex; i++) {
        const row = rows[i];
        if (!row || scenePanelState.renderedRowEls.has(i)) continue;
        const el = makeRowElement(row);
        el.dataset.rowKey = getRowKey(row);
        scenePanelState.renderedRowEls.set(i, el);
        fragment.appendChild(el);
    }

    content.appendChild(fragment);
    syncScenePanelSelection(currentSelection as unknown as ScenePanelSelectionState);
    scheduleSceneExtraFit();

    const elapsed = performance.now() - renderStartMs;
    if (elapsed > 8 && isPbdeLogEnabled('Scene panel viewport render')) {
        console.log(`[PBDE] Scene panel viewport render=${elapsed.toFixed(2)}ms, rows=${scenePanelState.renderedRowEls.size}/${rows.length}.`);
    }
}

export function scheduleScenePanelRender(): void {
    if (scenePanelState.scenePanelRenderRaf) return;
    scenePanelState.scenePanelRenderRaf = requestAnimationFrame(() => {
        scenePanelState.scenePanelRenderRaf = 0;
        renderVisibleSceneRows();
    });
}

export function refreshScenePanel(): void {
    const list = scenePanelState.scenePanelList;
    const content = scenePanelState.scenePanelContentEl;
    const spacer = scenePanelState.scenePanelSpacerEl;
    if (!list || !content || !spacer) return;

    const totalStartMs = performance.now();
    const previousScrollTop = list.scrollTop;

    scenePanelState.renderedRowEls.clear();
    content.textContent = '';

    const modelStartMs = performance.now();
    rebuildSceneRows();
    const modelElapsedMs = performance.now() - modelStartMs;

    syncScenePanelSpacerHeight();
    list.scrollTop = Math.min(previousScrollTop, Math.max(0, spacer.offsetHeight - list.clientHeight));

    const domStartMs = performance.now();
    renderVisibleSceneRows();
    const domElapsedMs = performance.now() - domStartMs;
    const totalElapsedMs = performance.now() - totalStartMs;

    if (isPbdeLogEnabled('Scene panel timings')) {
        console.log(
            `[PBDE] Scene panel timings: rows=${scenePanelState.visibleRows.length}, model=${modelElapsedMs.toFixed(2)}ms, viewport=${domElapsedMs.toFixed(2)}ms, total=${totalElapsedMs.toFixed(2)}ms.`
        );
    }
}
