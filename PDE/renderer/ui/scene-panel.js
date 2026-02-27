import { loadedObjectGroup } from '../load-project/upload-pbde.ts';

// ----- Scene 패널 오브젝트 목록 갱신 -----
const scenePanelList = document.getElementById('scene-object-list');
let sceneExtraFitRaf = 0;
const extraTokenCache = new WeakMap();
const ELLIPSIS = '...';

function cleanLabel(rawName) {
    return (rawName || '')
        .replace(/^[^:]+:/, '')  // 네임스페이스 제거
        .replace(/\[.*\]$/, '')  // 블록스테이트 프로퍼티 제거
        .trim();                 // 앞뒤 공백 제거
}

function makeObjectRow(uuid, depth) {
    const objectNames  = loadedObjectGroup.userData.objectNames;
    const rawName = objectNames?.get(uuid) || uuid.slice(0, 8);
    const itemDisplaySet = loadedObjectGroup.userData.objectIsItemDisplay;
    const isItemDisplay = itemDisplaySet?.has(uuid) ?? false;
    
    const displayTypes = loadedObjectGroup.userData.objectDisplayTypes;
    const blockPropsMap = loadedObjectGroup.userData.objectBlockProps;
    
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
        const ud = loadedObjectGroup?.userData;
        if (!ud) return;
        const uuidToInstance = ud.objectUuidToInstance;
        if (!uuidToInstance) return;
        const inst = uuidToInstance.get(uuid);
        if (!inst) return;
        const meshToIds = new Map([[inst.mesh, new Set([inst.instanceId])]]);
        if (e.shiftKey) {
            ud.addOrToggleInSelection?.(null, meshToIds);
        } else {
            ud.replaceSelectionWithObjectsMap?.(meshToIds, { anchorMode: 'default' });
        }
    });

    return el;
}

function fitSceneExtraBlocks() {
    if (!scenePanelList) return;

    const viewTop = scenePanelList.scrollTop;
    const viewBottom = viewTop + scenePanelList.clientHeight;
    const rows = scenePanelList.querySelectorAll('.scene-object-item, .scene-tree-group');
    for (const row of rows) {
        const rowTop = row.offsetTop;
        const rowBottom = rowTop + row.offsetHeight;
        if (rowBottom < viewTop - 40 || rowTop > viewBottom + 40) continue;

        const nameEl = row.querySelector('.scene-name');
        const nameTextEl = row.querySelector('.scene-name-text');
        const nameDotsEl = row.querySelector('.scene-name-dots');
        const extraEl = row.querySelector('.scene-extra');
        if (!nameEl || !nameTextEl || !nameDotsEl) continue;

        const fullName = nameEl.dataset.fullText || '';
        const setNameByCount = (count, showDots = true) => {
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

        const setExtraByCount = (count) => {
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

function scheduleSceneExtraFit() {
    if (sceneExtraFitRaf) return;
    sceneExtraFitRaf = requestAnimationFrame(() => {
        sceneExtraFitRaf = 0;
        fitSceneExtraBlocks();
    });
}

window.addEventListener('resize', scheduleSceneExtraFit);
scenePanelList?.addEventListener('scroll', scheduleSceneExtraFit, { passive: true });

function renderGroup(groupId, depth) {
    const groups = loadedObjectGroup.userData.groups;
    const group = groups?.get(groupId);
    if (!group) return null;

    const wrapper = document.createElement('div');

    // 그룹 헤더
    const header = document.createElement('div');
    header.className = 'scene-tree-group';
    header.style.paddingLeft = `${12 + depth * 16}px`;
    header.dataset.groupId = groupId;
    header.dataset.displayType = 'group';

    const toggleEl = document.createElement('span');
    toggleEl.className = 'scene-toggle';
    toggleEl.innerHTML = '&#xE06F;';

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

    // 자식 컨테이너 — 기본 접힘
    const childContainer = document.createElement('div');
    childContainer.className = 'scene-tree-children collapsed';

    // 자식: worker가 넣은 children 순서 그대로 표시
    for (const child of (group.children || [])) {
        if (child.type === 'group') {
            const subEl = renderGroup(child.id, depth + 1);
            if (subEl) childContainer.appendChild(subEl);
        } else {
            childContainer.appendChild(makeObjectRow(child.id, depth + 1));
        }
    }

    // 토글 아이콘 클릭 → 접기/펼치
    header.querySelector('.scene-toggle').addEventListener('click', (e) => {
        e.stopPropagation();
        const isCollapsed = childContainer.classList.toggle('collapsed');
        header.querySelector('.scene-toggle').innerHTML = isCollapsed ? '&#xE06F;' : '&#xE06D;';
        scheduleSceneExtraFit();
    });

    // 헤더 클릭 → 그룹 선택
    header.addEventListener('click', (e) => {
        const ud = loadedObjectGroup?.userData;
        if (!ud) return;
        const groupIds = new Set([groupId]);
        if (e.shiftKey) {
            ud.addOrToggleInSelection?.(groupIds, null);
        } else {
            ud.replaceSelectionWithGroupsAndObjects?.(groupIds, new Map(), { anchorMode: 'default' });
        }
    });

    wrapper.appendChild(header);
    wrapper.appendChild(childContainer);
    return wrapper;
}

export function refreshScenePanel() {
    if (!scenePanelList) return;
    scenePanelList.innerHTML = '';

    const objectNames   = loadedObjectGroup.userData.objectNames;   // Map<uuid, rawName>
    const groups        = loadedObjectGroup.userData.groups;         // Map<groupId, GroupData>
    const objectToGroup = loadedObjectGroup.userData.objectToGroup;  // Map<uuid, groupId>
    const sceneOrder    = loadedObjectGroup.userData.sceneOrder;

    const fragment = document.createDocumentFragment();

    if (sceneOrder && sceneOrder.length > 0) {
        for (const entry of sceneOrder) {
            if (entry.type === 'group') {
                const el = renderGroup(entry.id, 0);
                if (el) fragment.appendChild(el);
            } else {
                fragment.appendChild(makeObjectRow(entry.id, 0));
            }
        }
    } else {
        // fallback: sceneOrder 없는 레거시 로드
        if (groups) for (const group of groups.values()) {
            if (group.parent === null) {
                const el = renderGroup(group.id, 0);
                if (el) fragment.appendChild(el);
            }
        }
        if (objectNames) for (const [uuid] of objectNames) {
            if (!objectToGroup || !objectToGroup.has(uuid))
                fragment.appendChild(makeObjectRow(uuid, 0));
        }
    }

    scenePanelList.appendChild(fragment);
    scheduleSceneExtraFit();
}

window.addEventListener('pde:scene-updated', refreshScenePanel);

function _expandAncestors(el) {
    let node = el.parentElement;
    while (node && node !== scenePanelList) {
        if (node.classList.contains('scene-tree-children') && node.classList.contains('collapsed')) {
            node.classList.remove('collapsed');
            const header = node.previousElementSibling;
            if (header?.classList.contains('scene-tree-group')) {
                const toggle = header.querySelector('.scene-toggle');
                if (toggle) toggle.innerHTML = '&#xE06D;';
            }
        }
        node = node.parentElement;
    }
}

function syncScenePanelSelection(sel) {
    if (!scenePanelList) return;

    scenePanelList.querySelectorAll('.selected').forEach(el => el.classList.remove('selected'));

    if (!sel) return;

    if (sel.groups && sel.groups.size > 0) {
        for (const groupId of sel.groups) {
            const el = scenePanelList.querySelector(`.scene-tree-group[data-group-id="${groupId}"]`);
            if (el) {
                el.classList.add('selected');
                _expandAncestors(el);
            }
        }
    }

    if (sel.objects && sel.objects.size > 0) {
        const keyToUuid = loadedObjectGroup?.userData?.instanceKeyToObjectUuid;
        if (keyToUuid) {
            for (const [mesh, ids] of sel.objects) {
                for (const instanceId of ids) {
                    const uuid = keyToUuid.get(`${mesh.uuid}_${instanceId}`);
                    if (!uuid) continue;
                    const el = scenePanelList.querySelector(`.scene-object-item[data-uuid="${uuid}"]`);
                    if (el) {
                        el.classList.add('selected');
                        _expandAncestors(el);
                    }
                }
            }
        }
    }
}

window.addEventListener('pde:selection-changed', (e) => syncScenePanelSelection(e.detail));
