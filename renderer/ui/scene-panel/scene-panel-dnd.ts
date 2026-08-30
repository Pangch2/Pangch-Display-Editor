import { loadedObjectGroup } from '../../load-project/upload-pbde';
import { currentSelection } from '../../controls/selection/select';
import { getMirrorPairs, isMirrorModelingEnabled } from '../../controls/transform/mirroring';
import { captureGroupStructureState, recordGroupStructureChange, type GroupStructureHistoryState } from '../../controls/undo-redo/scene-history';
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
import { applySceneVisibility } from '../../controls/scene-visibility';

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

function computeSceneDropHint(clientX: number, clientY: number): SceneDropHint | null {
    const list = scenePanelState.scenePanelList;
    if (!list) return null;

    const listRect = list.getBoundingClientRect();
    if (clientX < listRect.left || clientX > listRect.right || clientY < listRect.top || clientY > listRect.bottom) return null;

    const target = (document.elementFromPoint(clientX, clientY) as HTMLElement | null)
        ?.closest('.scene-tree-group, .scene-object-item') as HTMLElement | null;
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
    const relativeY = rect.height > 0 ? (clientY - rect.top) / rect.height : 0.5;

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

function beginSceneItemDrag(source: SceneDragSource, el: HTMLElement): boolean {
    const ud = loadedObjectGroup.userData as LoadedObjectUserData;
    if (source.type === 'group') {
        if (!ud.groups?.has(source.id)) return false;
    } else if (!ud.objectUuidToInstance?.has(source.id)) {
        return false;
    }

    const bundle = buildSceneDragBundle(source, ud);
    if (!bundle.items || bundle.items.length === 0) return false;

    scenePanelState.sceneDragBundle = bundle;
    scenePanelState.sceneDropHint = null;
    clearSceneDropMarker();
    clearSceneAutoExpandTimer();

    for (const item of bundle.items) {
        getSceneDragItemElement(item)?.classList.add('scene-drag-source');
    }
    el.classList.add('scene-drag-source');
    createSceneDragPreview(bundle);
    return true;
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
        row.classList.remove('scene-virtual-row');
        row.style.removeProperty('top');
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

function handleSceneItemDragEnd(): void {
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

function updateScenePanelDragOver(clientX: number, clientY: number): void {
    if (!scenePanelState.sceneDragBundle) return;

    const ud = loadedObjectGroup.userData as LoadedObjectUserData;
    const hint = computeSceneDropHint(clientX, clientY);

    if (!hint || !isValidSceneDropHint(scenePanelState.sceneDragBundle, hint, ud)) {
        scenePanelState.sceneDropHint = null;
        clearSceneDropMarker();
        clearSceneAutoExpandTimer();
        return;
    }

    scenePanelState.sceneDropHint = hint;
    applySceneDropMarker(hint);
    scheduleSceneAutoExpand(hint);
}

function dropSceneItems(clientX: number, clientY: number): void {
    if (!scenePanelState.sceneDragBundle) return;

    const ud = loadedObjectGroup.userData as LoadedObjectUserData;
    const hint = scenePanelState.sceneDropHint ?? computeSceneDropHint(clientX, clientY);
    let before: GroupStructureHistoryState | null = null;

    let moved = false;
    if (hint && isValidSceneDropHint(scenePanelState.sceneDragBundle, hint, ud)) {
        const bundle = scenePanelState.sceneDragBundle;
        const objectPairs = getMirrorPairs(loadedObjectGroup, 'objectMirrorPairs');
        const groupPairs = getMirrorPairs(loadedObjectGroup, 'groupMirrorPairs');
        const mirrorId = (type: 'group' | 'object', id: string | null) => id && (type === 'group' ? groupPairs : objectPairs).get(id);
        const bundleKeys = new Set(bundle.items.map(getSceneDragItemKey));
        const mirrorItems = isMirrorModelingEnabled()
            ? bundle.items.flatMap(item => {
                const id = mirrorId(item.type, item.id);
                return id && !bundleKeys.has(`${item.type}:${id}`) ? [{ type: item.type, id }] : [];
            })
            : [];
        const mirrorTargetId = hint.targetType === 'root' ? null : mirrorId(hint.targetType, hint.targetId);
        const mirrorParentId = hint.parentGroupId ? groupPairs.get(hint.parentGroupId) : null;
        const affectedItems = [...bundle.items, ...mirrorItems];
        const groupIds = new Set(affectedItems.flatMap(item => item.type === 'group' ? [item.id] : []));
        for (const id of [hint.parentGroupId, hint.targetType === 'group' ? hint.targetId : null, mirrorParentId, mirrorTargetId]) {
            if (id) groupIds.add(id);
        }
        const objects = affectedItems.flatMap(item => {
            if (item.type !== 'object') return [];
            const ref = ud.objectUuidToInstance?.get(item.id);
            return ref ? [{ mesh: ref.mesh, instanceId: ref.instanceId }] : [];
        });
        before = captureGroupStructureState(loadedObjectGroup, groupIds, objects);

        moved = moveSceneItemsByDropHint(scenePanelState.sceneDragBundle, hint, ud);
        if (mirrorItems.length && (hint.targetType === 'root' || mirrorTargetId)) {
            moved = moveSceneItemsByDropHint({ lead: mirrorItems[0], items: mirrorItems }, {
                ...hint,
                targetId: mirrorTargetId ?? null,
                targetEl: null,
                parentGroupId: mirrorParentId ?? null
            }, ud) || moved;
        }
    }

    handleSceneItemDragEnd();

    if (moved) {
        scenePanelState.suppressSceneItemClickUntil = Date.now() + 180;
        applySceneVisibility(loadedObjectGroup);
        window.dispatchEvent(new CustomEvent('pde:scene-updated'));
        if (before) recordGroupStructureChange(loadedObjectGroup, before);
    }
}

export function handleSceneItemPointerDown(event: PointerEvent, source: SceneDragSource, el: HTMLElement): void {
    const list = scenePanelState.scenePanelList;
    if (!list || !event.isPrimary || event.button !== 0 || scenePanelState.sceneDragBundle
        || (event.target as HTMLElement).closest('.scene-toggle, input')) return;

    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startY = event.clientY;
    let clientX = startX;
    let clientY = startY;
    let dragging = false;
    let dropHintRaf = 0;
    let autoScrollRaf = 0;
    let autoScrollStep = 0;

    const updateDropHint = () => {
        dropHintRaf = 0;
        if (dragging) updateScenePanelDragOver(clientX, clientY);
    };
    const handleScroll = () => {
        if (!dropHintRaf) dropHintRaf = requestAnimationFrame(updateDropHint);
    };
    const stopAutoScroll = () => {
        if (autoScrollRaf) cancelAnimationFrame(autoScrollRaf);
        autoScrollRaf = 0;
        autoScrollStep = 0;
    };
    const updateAutoScroll = () => {
        const rect = list.getBoundingClientRect();
        const edge = Math.min(48, rect.height / 3);
        autoScrollStep = clientX < rect.left || clientX > rect.right
            ? 0
            : clientY < rect.top + edge
                ? -Math.min(12, Math.ceil((rect.top + edge - clientY) / 4))
                : clientY > rect.bottom - edge
                    ? Math.min(12, Math.ceil((clientY - rect.bottom + edge) / 4))
                    : 0;
        if (!autoScrollStep) {
            stopAutoScroll();
            return;
        }
        if (autoScrollRaf) return;

        const scroll = () => {
            autoScrollRaf = 0;
            const previousScrollTop = list.scrollTop;
            list.scrollTop += autoScrollStep;
            if (list.scrollTop !== previousScrollTop && autoScrollStep) autoScrollRaf = requestAnimationFrame(scroll);
        };
        autoScrollRaf = requestAnimationFrame(scroll);
    };
    const cleanup = () => {
        window.removeEventListener('pointermove', handlePointerMove);
        window.removeEventListener('pointerup', handlePointerUp);
        window.removeEventListener('pointercancel', handlePointerCancel);
        window.removeEventListener('keydown', handleKeyDown);
        window.removeEventListener('pde:scene-updated', handleScroll);
        list.removeEventListener('scroll', handleScroll);
        if (dropHintRaf) cancelAnimationFrame(dropHintRaf);
        stopAutoScroll();
        if (list.hasPointerCapture(pointerId)) list.releasePointerCapture(pointerId);
    };
    const cancelDrag = () => {
        cleanup();
        if (!dragging) return;
        scenePanelState.suppressSceneItemClickUntil = Date.now() + 180;
        handleSceneItemDragEnd();
    };
    const handlePointerMove = (moveEvent: PointerEvent) => {
        if (moveEvent.pointerId !== pointerId) return;
        clientX = moveEvent.clientX;
        clientY = moveEvent.clientY;

        if (!dragging) {
            if (Math.hypot(clientX - startX, clientY - startY) < 4) return;
            if (!beginSceneItemDrag(source, el)) {
                cleanup();
                return;
            }
            dragging = true;
            list.setPointerCapture(pointerId);
            list.addEventListener('scroll', handleScroll, { passive: true });
            window.addEventListener('pde:scene-updated', handleScroll);
        }

        moveEvent.preventDefault();
        const preview = scenePanelState.sceneDragPreviewEl;
        if (preview) {
            preview.style.left = `${clientX + 12}px`;
            preview.style.top = `${clientY + 12}px`;
        }
        updateScenePanelDragOver(clientX, clientY);
        updateAutoScroll();
    };
    const handlePointerUp = (upEvent: PointerEvent) => {
        if (upEvent.pointerId !== pointerId) return;
        clientX = upEvent.clientX;
        clientY = upEvent.clientY;
        cleanup();
        if (!dragging) return;

        upEvent.preventDefault();
        upEvent.stopPropagation();
        scenePanelState.suppressSceneItemClickUntil = Date.now() + 180;
        updateScenePanelDragOver(clientX, clientY);
        dropSceneItems(clientX, clientY);
    };
    const handlePointerCancel = (cancelEvent: PointerEvent) => {
        if (cancelEvent.pointerId === pointerId) cancelDrag();
    };
    const handleKeyDown = (keyEvent: KeyboardEvent) => {
        if (keyEvent.key !== 'Escape') return;
        keyEvent.preventDefault();
        cancelDrag();
    };

    window.addEventListener('pointermove', handlePointerMove, { passive: false });
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', handlePointerCancel);
    window.addEventListener('keydown', handleKeyDown);
}
