import { objectSlots } from '../../scene-store/object-access';
import { loadedObjectGroup, currentLoadGen } from '../../load-project/display/display-instancing';
import { loadAndRenderPbde, type CreatedProjectIds } from '../../load-project/display/project-renderer';
import { encodePdeProject } from '../../save/pde-format';
import { serializeProject } from '../../save/project-state';
import { trackProjectEdit } from '../../save/pending-edits';
import { deleteSelectedItems } from '../grouping/delete';
import { getGroups, getObjectToGroup, type SceneOrderEntry } from '../grouping/group';
import type { SelectionState } from '../selection/select';
import { captureHistoryUiState, restoreHistoryUiState, recordCreationChange, refreshHistory } from '../undo-redo/scene-history';
import { prepareMcfunctionFiles, type PreparedSceneFile } from '../../load-project/mcfunction/mcfunction-import';
import { assertAnimationParentsInvertible, captureAnimationSnapshot, rebaseAnimationStructure } from '../../animation/animation-state';

let projectRevision = 0;
let commands = Promise.resolve();
let pendingPastes = 0;
window.addEventListener('pde:active-project-changed', () => projectRevision++);
window.addEventListener('pde:before-project-load', () => projectRevision++);

function enqueue(command: () => Promise<void>): Promise<void> {
    const pending = trackProjectEdit(commands.then(command));
    commands = pending.catch(() => {});
    return pending;
}

export function isSelectionPastePending(): boolean { return pendingPastes > 0; }

export async function copySelection(selection: SelectionState): Promise<void> {
    const project = serializeProject(loadedObjectGroup, { groups: selection.groups, objectUuids: [...selection.objects] });
    if (!project.children.length) return Promise.resolve();
    const bytes = encodePdeProject(project);
    const revision = projectRevision;
    return enqueue(async () => {
        if (revision === projectRevision) await window.ipcApi.writeProjectClipboard(bytes);
    });
}

export function pasteSelection(selection: SelectionState): Promise<void> {
    return mergeSelectionFiles([...selection.groups], async () => {
        const bytes = await window.ipcApi.readProjectClipboard();
        if (bytes) return [{ file: new File([bytes], 'selection.pde') }];
        const text = await window.ipcApi.readClipboardText();
        return text ? prepareMcfunctionFiles([new File([text], 'mcfunction.mcfunction')]) : [];
    });
}

export function importMcfunctionFiles(files: File[]): Promise<void> {
    return mergeSelectionFiles([], () => prepareMcfunctionFiles(files));
}

export function openMcfunctionFile(file: PreparedSceneFile): Promise<void> {
    return mergeSelectionFiles([], async () => [file], false);
}

function mergeSelectionFiles(targets: string[], readFiles: () => Promise<PreparedSceneFile[]>, isMerge = true): Promise<void> {
    const revision = projectRevision;
    pendingPastes++;
    return enqueue(async () => {
        if (revision !== projectRevision) return;
        const data = loadedObjectGroup.userData;
        const beforeUi = captureHistoryUiState();
        const created: CreatedProjectIds = { objects: new Set(), groups: new Set() };
        const groups = getGroups(loadedObjectGroup);
        const selectedGroups = new Set<string>();
        const selectedObjects = new Set<string>();
        const generation = currentLoadGen;
        let canceled = false;
        const objectSelection = () => objectSlots(loadedObjectGroup, created.objects);
        const rollback = () => {
            deleteSelectedItems(loadedObjectGroup, { groups: created.groups, objects: objectSelection() },
                { resetSelectionAndDeselect: () => {} })?.dispose();
            // The loader writes metadata before asynchronous mesh creation can fail.
            for (const uuid of created.objects) {
                for (const key of ['objectNames', 'objectLabels', 'objectIsItemDisplay', 'objectDisplayTypes', 'objectBlockProps',
                    'objectTextDisplayOptions', 'objectTextures', 'objectNbt', 'objectBrightness', 'objectPivots', 'objectIsCustomPivot', 'objectDisplayKinds', 'hiddenObjectUuids', 'objectMirrorPairs']) {
                    data[key]?.delete(uuid);
                }
            }
            for (const id of created.groups) {
                data.hiddenGroupIds?.delete(id);
                data.groupMirrorPairs?.delete(id);
            }
            data.sceneOrder = data.sceneOrder?.filter((entry: SceneOrderEntry) => !(entry.type === 'group' ? created.groups : created.objects).has(entry.id));
            if (isMerge) restoreHistoryUiState(beforeUi);
            else data.resetSelection?.();
            refreshHistory(loadedObjectGroup);
        };
        const cancel = () => {
            if (canceled) return;
            canceled = true;
            rollback();
        };
        window.addEventListener('pde:before-project-load', cancel);
        window.addEventListener('pde:active-project-changed', cancel);
        try {
            const files = await readFiles();
            if (canceled || !files.length) return;
            assertAnimationParentsInvertible(loadedObjectGroup, targets);
            for (const targetId of targets.length ? targets : [null]) {
              for (const { file, expectedObjects } of files) {
                if (targetId && !groups.has(targetId)) throw new Error('붙여넣을 그룹이 사라졌습니다.');
                const previousIds = new Set([...created.objects, ...created.groups]);
                await loadAndRenderPbde(file, isMerge, generation, created);
                if (canceled) return;
                if (generation !== currentLoadGen || revision !== projectRevision) { cancel(); return; }
                for (const uuid of created.objects) if (!data.objectUuidToInstance?.has(uuid)) throw new Error('붙여넣은 오브젝트를 불러오지 못했습니다.');
                if (expectedObjects !== undefined && [...created.objects].filter(id => !previousIds.has(id)).length !== expectedObjects) {
                    throw new Error('가져온 디스플레이 모델을 모두 불러오지 못했습니다.');
                }
                const entries = (data.sceneOrder as SceneOrderEntry[] ?? []).filter(entry =>
                    !previousIds.has(entry.id) && (entry.type === 'group' ? created.groups : created.objects).has(entry.id));
                const target = targetId ? groups.get(targetId) : undefined;
                if (targetId && !target) throw new Error('붙여넣을 그룹이 사라졌습니다.');
                const objectToGroup = getObjectToGroup(loadedObjectGroup);
                const animationBefore = target ? captureAnimationSnapshot(loadedObjectGroup) : undefined;
                for (const entry of entries) {
                    if (entry.type === 'group') {
                        if (target) {
                            groups.get(entry.id)!.parent = targetId;
                            target.children.push({ type: 'group', id: entry.id });
                        }
                        selectedGroups.add(entry.id);
                    } else {
                        if (target) {
                            target.children.push({ type: 'object', id: entry.id });
                            objectToGroup.set(entry.id, targetId);
                        }
                        selectedObjects.add(entry.id);
                    }
                }
                if (target) {
                    const attachedIds = new Set(entries.map(entry => entry.id));
                    data.sceneOrder = data.sceneOrder.filter((entry: SceneOrderEntry) => !attachedIds.has(entry.id));
                    rebaseAnimationStructure(loadedObjectGroup, animationBefore);
                }
              }
            }
            if (!created.objects.size && !created.groups.size) return;
            data.replaceSelectionWithGroupsAndObjects(selectedGroups, selectedObjects, { anchorMode: 'center', primaryIsRangeStart: true });
            if (isMerge) recordCreationChange(loadedObjectGroup, { groups: created.groups, objects: objectSelection() }, beforeUi);
            window.dispatchEvent(new CustomEvent('pde:scene-updated'));
        } catch (error) {
            if (!canceled) { rollback(); throw error; }
        } finally {
            window.removeEventListener('pde:before-project-load', cancel);
            window.removeEventListener('pde:active-project-changed', cancel);
        }
    }).finally(() => pendingPastes--);
}
