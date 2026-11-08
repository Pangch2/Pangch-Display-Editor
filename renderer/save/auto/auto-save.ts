import { AutoSaveController } from './auto-save-controller';
import { readAutoSaveSettings } from './auto-save-settings';
import { flushProjectEdits } from '../pending-edits';
import { historyChangeCount } from '../../controls/undo-redo/undo-redo';

// Input that may edit without history (typing, panel clicks, drops); viewport presses only move the camera or select.
let userInputs = 0;
for (const type of ['keydown', 'input', 'change', 'paste', 'drop', 'pointerdown']) {
    window.addEventListener(type, event => {
        if (type !== 'pointerdown' || (event.target as Element | null)?.id !== 'renderCanvas') userInputs++;
    }, true);
}

export let autoSaveError = '';
export const autoSave = new AutoSaveController(flushProjectEdits,
    (id, snapshot, maximum) => window.ipcApi.autoSaveProject(id, snapshot.name, snapshot.data, maximum),
    error => {
        autoSaveError = error;
        window.dispatchEvent(new CustomEvent('pde:auto-save-error', { detail: error }));
    },
    () => historyChangeCount() + userInputs);

autoSave.configure(readAutoSaveSettings(localStorage));
window.addEventListener('pde:auto-save-settings-changed', () => autoSave.configure(readAutoSaveSettings(localStorage)));
window.addEventListener('beforeunload', () => autoSave.stop(), { once: true });
