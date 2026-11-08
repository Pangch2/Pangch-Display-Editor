import { matchesShortcut } from '../../controls/input/shortcuts';
import { addProject, openProjects } from '../../load-project/pbde/upload-pbde';
import { saveProject } from '../../save/save-project';
import { openNewProjectDialog } from '../dialogs/new-project';
import { openSummonCommand } from '../dialogs/summon-command';
import { openUserGuide } from '../dialogs/user-guide';

const menuBar = document.querySelector<HTMLElement>('.menu-bar-items')!;
const dropdowns = [...menuBar.querySelectorAll<HTMLElement>('.menu-bar-dropdown')];
let menuHoverTimer: ReturnType<typeof setTimeout>;
const closeMenus = () => {
    clearTimeout(menuHoverTimer);
    for (const dropdown of dropdowns) {
        dropdown.querySelector<HTMLElement>('.menu-bar-popup')!.hidden = true;
        dropdown.querySelector('button')!.setAttribute('aria-expanded', 'false');
    }
};
const scheduleMenu = (action: () => void) => {
    clearTimeout(menuHoverTimer);
    // Allow diagonal movement past another trigger into the open popup.
    menuHoverTimer = setTimeout(action, 150);
};

for (const dropdown of dropdowns) {
    const trigger = dropdown.querySelector<HTMLButtonElement>('.menu-bar-button')!;
    const popup = dropdown.querySelector<HTMLElement>('.menu-bar-popup')!;
    const openMenu = () => {
        closeMenus();
        popup.hidden = false;
        trigger.setAttribute('aria-expanded', 'true');
    };
    dropdown.addEventListener('pointerenter', () => clearTimeout(menuHoverTimer));
    dropdown.addEventListener('pointerleave', () => scheduleMenu(closeMenus));
    trigger.addEventListener('pointerenter', () => scheduleMenu(openMenu));
    trigger.addEventListener('click', openMenu);
    dropdown.addEventListener('focusout', event => {
        // A hidden menu may still own focus after another menu opens on hover.
        if (!popup.hidden && !dropdown.contains(event.relatedTarget as Node | null)) closeMenus();
    });
    popup.addEventListener('click', event => {
        if (!(event.target as HTMLElement).closest('button:enabled')) return;
        closeMenus();
        trigger.focus();
    }, true);
    dropdown.addEventListener('keydown', event => {
        event.stopPropagation();
        if (event.key === 'Escape') {
            event.preventDefault();
            closeMenus();
            trigger.focus();
        } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
            event.preventDefault();
            openMenu();
            const items = [...popup.querySelectorAll<HTMLButtonElement>('button:enabled')];
            const index = items.indexOf(document.activeElement as HTMLButtonElement);
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
                : event.key === 'ArrowDown' ? (index + 1) % items.length : (index < 0 ? items.length - 1 : (index - 1 + items.length) % items.length);
            items[next]?.focus();
        }
    });
}

document.addEventListener('pointerdown', event => {
    if (!menuBar.contains(event.target as Node)) closeMenus();
});
window.addEventListener('blur', closeMenus);

const fileInput = document.createElement('input');
fileInput.type = 'file';
fileInput.accept = '.pde,.bdengine,.mcfunction';
fileInput.multiple = true;
fileInput.addEventListener('change', () => {
    const files = [...fileInput.files ?? []];
    fileInput.value = '';
    if (files.length) void openProjects(files);
});
const fileActions = {
    new: openNewProjectDialog, newTab: addProject, open: () => fileInput.click(), save: saveProject,
    saveAs: () => saveProject(true), export: openSummonCommand
};
for (const button of menuBar.querySelectorAll<HTMLButtonElement>('[data-file-action]')) {
    button.addEventListener('click', () => { void fileActions[button.dataset.fileAction as keyof typeof fileActions](); });
}
window.addEventListener('keydown', event => {
    if (document.querySelector('dialog[open], .settings-overlay:not([hidden])')) return;
    const action = matchesShortcut(event, 'openProject') ? fileActions.open
        : matchesShortcut(event, 'newProject') ? addProject
        : matchesShortcut(event, 'replaceProject') ? openNewProjectDialog : undefined;
    if (!action) return;
    const target = event.target;
    if (!event.ctrlKey && !event.metaKey && !event.altKey && target instanceof HTMLElement
        && (target.matches('input, textarea, select') || target.isContentEditable)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.repeat || event.isComposing) return;
    closeMenus();
    action();
}, true);
const summonButton = document.getElementById('summon-menu-button')!;
summonButton.addEventListener('pointerenter', () => scheduleMenu(closeMenus));
summonButton.addEventListener('click', () => { closeMenus(); openSummonCommand(); });
document.getElementById('user-guide-button')!.addEventListener('click', openUserGuide);
