import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { constants, zstdCompressSync } from 'node:zlib';

export type ProjectSaveResult = { success: boolean; canceled?: boolean; path?: string; error?: string };

export function compressPdeProject(data: Uint8Array): Buffer<ArrayBuffer> {
    return zstdCompressSync(data, { params: {
        [constants.ZSTD_c_compressionLevel]: 3,
        [constants.ZSTD_c_checksumFlag]: 1
    } });
}

export class ProjectFileStore {
    private paths = new Map<string, string>();
    private activeProjectId: string | undefined;
    private revision = 0;
    private saving = false;

    setActiveProject(id: string): void {
        if (typeof id !== 'string' || !id || id.length > 128) throw new Error('Invalid project ID');
        this.activeProjectId = id;
        this.revision++;
    }

    forgetProject(id: string): void {
        this.paths.delete(id);
        if (id === this.activeProjectId) {
            this.activeProjectId = undefined;
            this.revision++;
        }
    }

    async save(id: string, name: string, data: Uint8Array, choosePath: (name: string) => Promise<string | undefined>): Promise<ProjectSaveResult> {
        if (this.saving || id !== this.activeProjectId) return { success: false, canceled: true };
        if (typeof name !== 'string' || !(data instanceof Uint8Array) || data.length === 0) return { success: false, error: 'Invalid project save data' };
        this.saving = true;
        const revision = this.revision;
        let temporaryPath: string | undefined;
        try {
            const selected = this.paths.get(id) ?? await choosePath(name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim() || 'project');
            if (!selected || revision !== this.revision) return { success: false, canceled: true };
            const target = path.extname(selected).toLowerCase() === '.pde' ? selected : selected + '.pde';
            const compressed = compressPdeProject(data);
            temporaryPath = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`);
            const file = await fs.open(temporaryPath, 'wx');
            try { await file.writeFile(compressed); await file.sync(); } finally { await file.close(); }
            if (revision !== this.revision) return { success: false, canceled: true };
            await fs.rename(temporaryPath, target);
            temporaryPath = undefined;
            this.paths.set(id, target);
            return { success: true, path: target };
        } catch (error) {
            return { success: false, error: error instanceof Error ? error.message : String(error) };
        } finally {
            if (temporaryPath) await fs.unlink(temporaryPath).catch(() => {});
            this.saving = false;
        }
    }
}
