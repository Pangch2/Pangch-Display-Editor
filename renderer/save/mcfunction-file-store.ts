import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ProjectSaveResult } from './project-file-store.js';

export async function saveMcfunctionFile(name: string, commands: string[], choosePath: (name: string) => Promise<string | undefined>): Promise<ProjectSaveResult> {
    if (typeof name !== 'string' || !Array.isArray(commands) || !commands.length
        || commands.some(command => typeof command !== 'string' || !command.startsWith('summon ') || /[\r\n]/.test(command) || command.length > 2_000_000)) {
        return { success: false, error: 'Invalid mcfunction save data' };
    }
    let temporaryPath: string | undefined;
    try {
        const selected = await choosePath(name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim() || 'project');
        if (!selected) return { success: false, canceled: true };
        const target = path.extname(selected).toLowerCase() === '.mcfunction' ? selected : selected + '.mcfunction';
        temporaryPath = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`);
        await fs.writeFile(temporaryPath, commands.join('\n') + '\n', { encoding: 'utf8', flag: 'wx' });
        await fs.rename(temporaryPath, target);
        temporaryPath = undefined;
        return { success: true, path: target };
    } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
    } finally {
        if (temporaryPath) await fs.unlink(temporaryPath).catch(() => {});
    }
}
