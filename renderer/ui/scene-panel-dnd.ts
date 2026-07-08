import { loadedObjectGroup } from '../load-project/upload-pbde';
import { currentSelection } from '../controls/selection/select';
import { scheduleSceneExtraFit } from './scene-panel-render';
import { scenePanelState } from './scene-panel-state';
import type {
    LoadedObjectUserData,
    SceneDragBundle,
    SceneDragSource,
    SceneDropHint
} from './scene-panel-types';
import {
    getObjectGroupKeyByUuid,
    getParentGroupIdFromElement,
    isGroupAncestorOf,
    moveSceneItemsByDropHint
} from './scene-panel-model';

function getSceneDragItemKey(item: SceneDragSource): string {
    return `${item.type}:${item.id}`;
}

function getSceneDragItemElement(item: SceneDragSource): HTMLElement | null {
    if (!scenePanelState.scenePanelList) return null;
    if (item.type === 'group') {
        return scenePanelState.scenePanelList.querySelector(`.scene-tree-group[data-group-id="${item.id}"]`) as HTMLElement | null;
    }
    return scenePanelState.scenePanelList.querySelector(`.scene-object-item[data-uuid="${item.id}"]`) as HTMLElement | null;
}

function clearSceneDragPreview(): void {
    if (scenePanelState.sceneDragPreviewEl?.parentElement) {
        scenePanelState.sceneDragPreviewEl.parentElement.removeChild(scenePanelState.sceneDragPreviewEl);
    }
    scenePanelState.sceneDragPreviewEl = null;
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
    if (scenePanelState.scenePanelList) {
        const nodes = scenePanelState.scenePanelList.querySelectorAll('.scene-object-item, .scene-tree-group');
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

function clearSceneAutoExpandTimer(): void {
    if (scenePanelState.sceneAutoExpandTimer) {
        window.clearTimeout(scenePanelState.sceneAutoExpandTimer);
        scenePanelState.sceneAutoExpandTimer = 0;
    }
    scenePanelState.sceneAutoExpandGroupId = null;
}

function clearSceneDropMarker(): void {
    if (scenePanelState.sceneDropMarkerEl && scenePanelState.sceneDropMarkerClass) {
        scenePanelState.sceneDropMarkerEl.classList.remove(scenePanelState.sceneDropMarkerClass);
    }
    scenePanelState.sceneDropMarkerEl = null;
    scenePanelState.sceneDropMarkerClass = null;
    scenePanelState.scenePanelList?.classList.remove('scene-drop-root-end');
}

function applySceneDropMarker(hint: SceneDropHint): void {
    clearSceneDropMarker();
    if (!scenePanelState.scenePanelList) return;

    if (hint.mode === 'root-end' || hint.targetType === 'root' || !hint.targetEl) {
        scenePanelState.scenePanelList.classList.add('scene-drop-root-end');
        return;
    }

    const markerClass = hint.mode === 'before'
        ? 'scene-drop-before'
        : (hint.mode === 'after' ? 'scene-drop-after' : 'scene-drop-inside');

    hint.targetEl.classList.add(markerClass);
    scenePanelState.sceneDropMarkerEl = hint.targetEl;
    scenePanelState.sceneDropMarkerClass = markerClass;
}

function scheduleSceneAutoExpand(hint: SceneDropHint): void {
    if (hint.mode !== 'inside' || hint.targetType !== 'group' || !hint.targetId || !hint.targetEl) {
        clearSceneAutoExpandTimer();
        return;
    }

    if (scenePanelState.expandedGroupIds.has(hint.targetId)) {
        clearSceneAutoExpandTimer();
        return;
    }

    if (scenePanelState.sceneAutoExpandTimer && scenePanelState.sceneAutoExpandGroupId === hint.targetId) return;

    clearSceneAutoExpandTimer();
    scenePanelState.sceneAutoExpandGroupId = hint.targetId;
    scenePanelState.sceneAutoExpandTimer = window.setTimeout(() => {
        const groupId = scenePanelState.sceneAutoExpandGroupId;
        scenePanelState.sceneAutoExpandTimer = 0;
        scenePanelState.sceneAutoExpandGroupId = null;
        if (!groupId) return;
        scenePanelState.expandedGroupIds.add(groupId);
        window.dispatchEvent(new CustomEvent('pde:scene-updated'));
        scheduleSceneExtraFit();
    }, 420);
}

function computeSceneDropHint(event: DragEvent): SceneDropHint | null {
    if (!scenePanelState.scenePanelList) return null;

    const target = (event.target as HTMLElement | null)?.closest('.scene-tree-group, .scene-object-item') as HTMLElement | null;
    if (!target || !scenePanelState.scenePanelList.contains(target)) {
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

        let mode: SceneDropHint['mode'] = 'inside';
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

export function handleSceneItemDragStart(event: DragEvent, source: SceneDragSource, el: HTMLElement): void {
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

    scenePanelState.sceneDragBundle = bundle;
    scenePanelState.sceneDropHint = null;
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

function createSceneDragPreview(bundle: SceneDragBundle): HTMLElement | null {
    if (!scenePanelState.scenePanelList || !bundle.items || bundle.items.length === 0) return null;

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

    const previewWidth = Math.max(180, Math.min(scenePanelState.scenePanelList.clientWidth - 6, 320));
    preview.style.width = `${previewWidth}px`;

    document.body.appendChild(preview);
    scenePanelState.sceneDragPreviewEl = preview;
    return preview;
}

export function handleSceneItemDragEnd(): void {
    if (scenePanelState.scenePanelList) {
        scenePanelState.scenePanelList.querySelectorAll('.scene-drag-source').forEach((node) => {
            node.classList.remove('scene-drag-source');
        });
    }
    clearSceneDragPreview();
    clearSceneDropMarker();
    clearSceneAutoExpandTimer();
    scenePanelState.sceneDropHint = null;
    scenePanelState.sceneDragBundle = null;
}

export function handleScenePanelDragOver(event: DragEvent): void {
    if (!scenePanelState.sceneDragBundle) return;

    const ud = loadedObjectGroup.userData as LoadedObjectUserData;
    const hint = computeSceneDropHint(event);

    if (!hint || !isValidSceneDropHint(scenePanelState.sceneDragBundle, hint, ud)) {
        scenePanelState.sceneDropHint = null;
        clearSceneDropMarker();
        clearSceneAutoExpandTimer();
        return;
    }

    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';

    scenePanelState.sceneDropHint = hint;
    applySceneDropMarker(hint);
    scheduleSceneAutoExpand(hint);
}

export function handleScenePanelDrop(event: DragEvent): void {
    if (!scenePanelState.sceneDragBundle) return;

    event.preventDefault();
    event.stopPropagation();

    const ud = loadedObjectGroup.userData as LoadedObjectUserData;
    const hint = scenePanelState.sceneDropHint ?? computeSceneDropHint(event);

    let moved = false;
    if (hint && isValidSceneDropHint(scenePanelState.sceneDragBundle, hint, ud)) {
        moved = moveSceneItemsByDropHint(scenePanelState.sceneDragBundle, hint, ud);
    }

    handleSceneItemDragEnd();

    if (moved) {
        scenePanelState.suppressSceneItemClickUntil = Date.now() + 180;
        window.dispatchEvent(new CustomEvent('pde:scene-updated'));
    }
}

export function handleScenePanelDragLeave(event: DragEvent): void {
    if (!scenePanelState.sceneDragBundle || !scenePanelState.scenePanelList) return;

    const next = event.relatedTarget as Node | null;
    if (next && scenePanelState.scenePanelList.contains(next)) return;

    scenePanelState.sceneDropHint = null;
    clearSceneDropMarker();
    clearSceneAutoExpandTimer();
}
