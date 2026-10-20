import { getActiveProjectId, replaceProject } from '../../load-project/pbde/upload-pbde';
import { saveProject } from '../../save/save-project';
import { openWithAnimation, closeWithAnimation } from '../common/ui-open-close.js';

export function openNewProjectDialog(): void {
    if (document.getElementById('new-project-dialog')) return;
    const projectId = getActiveProjectId();
    const dialog = document.createElement('dialog');
    dialog.id = 'new-project-dialog';
    dialog.className = 'settings-window new-project-window';
    dialog.setAttribute('aria-labelledby', 'new-project-title');
    dialog.innerHTML = `
        <h2 id="new-project-title">정말 새 프로젝트를 생성하시겠습니까?</h2>
        <footer>
            <button type="button" class="project-ui-button" data-save autofocus>저장</button>
            <button type="button" class="project-ui-button" data-discard>저장하지 않기</button>
        </footer>`;
    const buttons = [...dialog.querySelectorAll<HTMLButtonElement>('button')];
    let busy = false;
    const close = async () => {
        busy = true;
        await closeWithAnimation(dialog);
        dialog.close();
        dialog.remove();
    };
    const finish = async (save: boolean) => {
        if (busy) return;
        busy = true;
        buttons.forEach(button => { button.disabled = true; });
        if (save && !await saveProject()) {
            busy = false;
            buttons.forEach(button => { button.disabled = false; });
            buttons[0].focus();
            return;
        }
        if (getActiveProjectId() === projectId) replaceProject();
        await close();
    };
    buttons[0].onclick = () => { void finish(true); };
    buttons[1].onclick = () => { void finish(false); };
    const cancel = (event: Event) => {
        event.preventDefault();
        if (!busy) void close();
    };
    dialog.addEventListener('cancel', cancel);
    dialog.addEventListener('keydown', event => {
        if (event.key === 'Escape') cancel(event);
        event.stopPropagation();
    });
    document.body.append(dialog);
    dialog.showModal();
    openWithAnimation(dialog);
}
