import { loadedObjectGroup } from '../load-project/display/display-instancing';
import { encodePdeProject } from './pde-format';
import { serializeProject } from './project-state';
import { commitFocusedProjectEdit, flushProjectEdits } from './pending-edits';

let activeProjectId: string | undefined;
let projectRevision = 0;
let saving = false;

window.addEventListener('pde:active-project-changed', (event: CustomEvent<string>) => {
    activeProjectId = event.detail;
    projectRevision++;
    window.ipcApi.setActiveProject?.(activeProjectId);
});

export async function saveProject(saveAs = false): Promise<boolean> {
    if (saving || !activeProjectId) return false;
    saving = true;
    const id = activeProjectId;
    const revision = projectRevision;
    try {
        commitFocusedProjectEdit();
        await flushProjectEdits();
        if (revision !== projectRevision) return false;
        const project = serializeProject(loadedObjectGroup);
        const result = await window.ipcApi.saveProject(id, project.name, encodePdeProject(project), saveAs);
        if (!result.success && !result.canceled) throw new Error(result.error ?? '파일을 저장할 수 없습니다.');
        return result.success && revision === projectRevision;
    } catch (error) {
        window.alert(`프로젝트 저장 실패: ${error instanceof Error ? error.message : String(error)}`);
        return false;
    } finally { saving = false; }
}

window.addEventListener('keydown', event => {
    if (document.querySelector('dialog[open], .settings-overlay:not([hidden])')) return;
    if (!(event.ctrlKey || event.metaKey) || event.altKey || event.key.toLowerCase() !== 's') return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!event.repeat && !event.isComposing) void saveProject(event.shiftKey);
}, true);
