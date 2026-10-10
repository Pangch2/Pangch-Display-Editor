import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { compressPdeProject, type ProjectSaveResult } from '../project-file-store.js';

type AutoSaveFolder = { name: string; folder: string; revision: number };
const autoSaveFilePattern = /^auto-save-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}\.pde$/;

export function autoSaveFolderName(name: string): string {
    let safe = Array.from(name.normalize('NFC').replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, '_').trim()).slice(0, 80).join('').replace(/[. ]+$/, '');
    if (!safe) safe = '새 프로젝트';
    if (/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(safe)) safe = '_' + safe;
    return safe;
}

export class AutoSaveFileStore {
    private folders = new Map<string, AutoSaveFolder>();
    private saving = new Set<string>();

    constructor(private directory: string) {}

    setProjects(projects: { id: string; name: string; revision: number }[]): void {
        if (!Array.isArray(projects) || projects.some(project => !project || typeof project.id !== 'string' || !project.id || project.id.length > 128
            || typeof project.name !== 'string' || project.name.length > 4096 || !Number.isSafeInteger(project.revision) || project.revision < 0)
            || new Set(projects.map(project => project.id)).size !== projects.length) {
            throw new Error('Invalid auto-save projects');
        }
        const ids = new Set(projects.map(project => project.id));
        for (const id of this.folders.keys()) if (!ids.has(id)) this.folders.delete(id);
        for (const { id, name, revision } of projects) {
            const previous = this.folders.get(id);
            if (previous?.name === name) {
                if (previous.revision !== revision) this.folders.set(id, { ...previous, revision });
                continue;
            }
            const used = new Set([...this.folders.values()].map(value => value.folder.toLowerCase()));
            const base = autoSaveFolderName(name);
            let folder = base;
            for (let suffix = 1; used.has(folder.toLowerCase()); suffix++) folder = `${base} (${suffix})`;
            this.folders.set(id, { name, folder, revision });
        }
    }

    async save(id: string, name: string, data: Uint8Array, maximum: number): Promise<ProjectSaveResult> {
        if (typeof id !== 'string' || typeof name !== 'string' || !(data instanceof Uint8Array) || data.length < 4
            || data[0] !== 80 || data[1] !== 82 || data[2] !== 74 || data[3] !== 50 || !Number.isSafeInteger(maximum) || maximum < 1) {
            return { success: false, error: 'Invalid auto-save data' };
        }
        const assignment = this.folders.get(id);
        if (!assignment || assignment.name !== name || this.saving.has(id)) return { success: false, canceled: true };
        const current = () => this.folders.get(id) === assignment;
        this.saving.add(id);
        let temporaryPath: string | undefined;
        try {
            const folder = path.join(this.directory, assignment.folder);
            await fs.mkdir(folder, { recursive: true });
            const info = await fs.lstat(folder);
            if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Invalid auto-save directory');
            const filename = `auto-save-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.pde`;
            const target = path.join(folder, filename);
            const temporary = target + '.tmp';
            const compressed = compressPdeProject(data);
            const file = await fs.open(temporary, 'wx');
            temporaryPath = temporary;
            try { await file.writeFile(compressed); await file.sync(); } finally { await file.close(); }
            if (!current()) return { success: false, canceled: true };
            await fs.rename(temporaryPath, target);
            temporaryPath = undefined;
            const files = (await fs.readdir(folder, { withFileTypes: true }))
                .filter(file => file.isFile() && file.name !== filename && autoSaveFilePattern.test(file.name))
                .map(file => file.name).sort();
            for (const old of files.slice(0, Math.max(0, files.length + 1 - maximum))) {
                if (!current()) return { success: false, canceled: true };
                await fs.unlink(path.join(folder, old));
            }
            return current() ? { success: true, path: target } : { success: false, canceled: true };
        } catch (error) {
            return { success: false, error: error instanceof Error ? error.message : String(error) };
        } finally {
            if (temporaryPath) await fs.unlink(temporaryPath).catch(() => {});
            this.saving.delete(id);
        }
    }
}
