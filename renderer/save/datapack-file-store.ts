import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { unzipSync } from 'fflate';
import type { ProjectSaveResult } from './project-file-store.js';

const safeName = (name: string) => name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim() || 'project';
// A zip starts with a local file header.
const isZip = (data: unknown): data is Uint8Array => data instanceof Uint8Array && data[0] === 0x50 && data[1] === 0x4b && data[2] === 3 && data[3] === 4;

/** `folder`: `choosePath` picks the parent directory and the pack is unpacked into `<parent>/<name>`; otherwise it picks the zip file. */
export async function saveDatapackFile(name: string, data: Uint8Array, folder: boolean, choosePath: (name: string) => Promise<string | undefined>): Promise<ProjectSaveResult> {
    if (typeof name !== 'string' || !isZip(data)) return { success: false, error: 'Invalid datapack save data' };
    let temporaryPath: string | undefined;
    try {
        const files = folder ? unzipSync(data) : undefined;
        if (files && Object.keys(files).some(file => path.isAbsolute(file) || file.split('/').some(part => part === '..' || part === ''))) {
            return { success: false, error: 'Invalid datapack file path' };
        }
        const selected = await choosePath(safeName(name));
        if (!selected) return { success: false, canceled: true };
        const target = files ? path.join(selected, safeName(name))
            : path.extname(selected).toLowerCase() === '.zip' ? selected : selected + '.zip';
        temporaryPath = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`);
        if (files) {
            for (const [file, content] of Object.entries(files)) {
                const output = path.join(temporaryPath, ...file.split('/'));
                await fs.mkdir(path.dirname(output), { recursive: true });
                await fs.writeFile(output, content);
            }
            // Only a pack this exporter wrote is replaced; stale functions from an older export must not linger.
            const existing = await fs.readFile(path.join(target, 'pack.mcmeta'), 'utf8').catch(() => undefined);
            if (existing === undefined && await fs.stat(target).then(() => true, () => false)) throw new Error(`같은 이름의 폴더가 이미 있습니다: ${target}`);
            if (existing !== undefined) {
                if (!String(JSON.parse(existing)?.pack?.description ?? '').endsWith('(PDE)')) throw new Error(`PDE가 만든 데이터팩이 아닌 같은 이름의 폴더가 있습니다: ${target}`);
                await fs.rm(target, { recursive: true });
            }
        } else await fs.writeFile(temporaryPath, data, { flag: 'wx' });
        await fs.rename(temporaryPath, target);
        temporaryPath = undefined;
        return { success: true, path: target };
    } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
    } finally {
        if (temporaryPath) await fs.rm(temporaryPath, { recursive: true, force: true }).catch(() => {});
    }
}
