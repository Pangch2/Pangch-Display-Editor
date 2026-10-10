import { AutoSaveController } from './auto-save-controller';
import { readAutoSaveSettings } from './auto-save-settings';
import { flushProjectEdits } from '../pending-edits';

export let autoSaveError = '';
export const autoSave = new AutoSaveController(flushProjectEdits,
    (id, snapshot, maximum) => window.ipcApi.autoSaveProject(id, snapshot.name, snapshot.data, maximum),
    error => {
        autoSaveError = error;
        window.dispatchEvent(new CustomEvent('pde:auto-save-error', { detail: error }));
    });

autoSave.configure(readAutoSaveSettings(localStorage));
window.addEventListener('pde:auto-save-settings-changed', () => autoSave.configure(readAutoSaveSettings(localStorage)));
window.addEventListener('beforeunload', () => autoSave.stop(), { once: true });
