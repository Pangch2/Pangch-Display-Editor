import * as THREE from 'three/webgpu';
import { loadedObjectGroup } from '../load-project/upload-pbde';

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

function handleSceneItemClick(e: MouseEvent, el: HTMLElement): void {
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

function renderGroup(groupId: string, depth: number): HTMLElement | null {
    const ud = loadedObjectGroup.userData as LoadedObjectUserData;
    const groups = ud.groups;
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
    toggleEl.addEventListener('click', (e) => {
        e.stopPropagation();
        const isCollapsed = childContainer.classList.toggle('collapsed');
        toggleEl.innerHTML = isCollapsed ? '&#xE06F;' : '&#xE06D;';
        scheduleSceneExtraFit();
    });

    // 헤더 클릭 → 그룹 선택
    header.addEventListener('click', (e) => {
        handleSceneItemClick(e, header);
    });

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
    const objectToGroup = ud.objectToGroup;
    const sceneOrder = ud.sceneOrder;

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
        if (groups) {
            for (const group of groups.values()) {
                if (group.parent === null) {
                    const el = renderGroup(group.id, 0);
                    if (el) fragment.appendChild(el);
                }
            }
        }
        if (objectNames) {
            for (const [uuid] of objectNames) {
                if (!objectToGroup || !objectToGroup.has(uuid)) {
                    fragment.appendChild(makeObjectRow(uuid, 0));
                }
            }
        }
    }

    scenePanelList.appendChild(fragment);
    scheduleSceneExtraFit();
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
