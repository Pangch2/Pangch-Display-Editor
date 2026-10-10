import { clipboard, ClipboardItem, ipcMain, type WebContents } from 'electron';
import { compressPdeProject } from './project-file-store.js';

export const projectClipboardFormat = 'web application/x-pde';

export function registerProjectClipboard(sender: WebContents): void {
    ipcMain.handle('read-clipboard-text', async event => {
        if (event.sender !== sender) throw new Error('Invalid clipboard sender');
        return clipboard.readText();
    });
    ipcMain.handle('write-project-clipboard', async (event, data: Uint8Array) => {
        if (event.sender !== sender) throw new Error('Invalid clipboard sender');
        if (!(data instanceof Uint8Array) || data.length < 4 || Buffer.from(data.subarray(0, 4)).toString() !== 'PRJ2') {
            throw new Error('Invalid project clipboard data');
        }
        await clipboard.write([new ClipboardItem({ [projectClipboardFormat]: new Blob([compressPdeProject(data)]) })]);
    });
    ipcMain.handle('read-project-clipboard', async event => {
        if (event.sender !== sender) throw new Error('Invalid clipboard sender');
        const item = (await clipboard.read()).find(item => item.types.includes(projectClipboardFormat));
        if (!item) return undefined;
        const data = new Uint8Array(await (await item.getType(projectClipboardFormat)).arrayBuffer());
        if (data.length < 5 || data[0] !== 0x28 || data[1] !== 0xb5 || data[2] !== 0x2f || data[3] !== 0xfd) {
            throw new Error('Invalid project clipboard: expected Zstd data');
        }
        return data;
    });
}
