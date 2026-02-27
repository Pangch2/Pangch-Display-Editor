import { loadedObjectGroup } from '../load-project/upload-pbde.ts';

// ----- Scene 패널 오브젝트 목록 갱신 -----
const scenePanelList = document.getElementById('scene-object-list');

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
        if (dType) extraInfo = `<span class="scene-extra">display=${dType}</span>`;
    } else {
        const props = blockPropsMap?.get(uuid);
        if (props) {
            const propStrings = Object.entries(props).map(([k, v]) => `${k}=${v}`);
            if (propStrings.length > 0) {
                extraInfo = `<span class="scene-extra">${propStrings.join(' ')}</span>`;
            }
        }
    }

    const iconCode = isItemDisplay ? '&#xE5C6;' : '&#xE061;';
    const iconClass = isItemDisplay ? 'icon-item' : 'icon-box';
    const el = document.createElement('div');
    el.className = 'scene-object-item';
    el.style.paddingLeft = `${12 + depth * 16}px`;
    el.dataset.uuid = uuid;
    el.innerHTML = `
        <span class="scene-icon ${iconClass}">${iconCode}</span>
        <span class="scene-name">${cleanLabel(rawName)}</span>
        ${extraInfo}
        <span class="scene-icon-right">&#xE0BA;</span>
    `;
    return el;
}

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
    header.innerHTML = `
        <span class="scene-toggle">&#xE06F;</span>
        <span class="scene-name">${group.name}</span>
        <span class="scene-icon-right">&#xE0BA;</span>
    `;

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

    // 토글
    header.addEventListener('click', () => {
        const isCollapsed = childContainer.classList.toggle('collapsed');
        header.querySelector('.scene-toggle').innerHTML = isCollapsed ? '&#xE06F;' : '&#xE06D;';
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
}

window.addEventListener('pde:scene-updated', refreshScenePanel);
