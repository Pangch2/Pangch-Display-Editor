import type { PdeNode } from '../../save/pde-format';
import type { ParsedPbdeProject } from './scene-parser';
import { mainThreadAssetProvider } from '../pbde/pbde-assets';

export type DisplayParserRequest = { type: 'parse'; id: number; nodes: PdeNode[] }
    | { type: 'asset'; id: number; value?: unknown; error?: string };
export type DisplayParserResponse = { type: 'asset'; id: number; path: string }
    | { type: 'parsed'; id: number; project: ParsedPbdeProject }
    | { type: 'error'; id: number; error: string };

let parser: Worker | undefined;
let nextId = 0;
const pending = new Map<number, { resolve: (project: ParsedPbdeProject) => void; reject: (error: Error) => void }>();

window.addEventListener('pde:before-project-load', () => {
    parser?.terminate(); parser = undefined;
    for (const job of pending.values()) job.reject(new DOMException('프로젝트가 변경되었습니다.', 'AbortError'));
    pending.clear();
});

export function parseDisplayProject(nodes: PdeNode[]): Promise<ParsedPbdeProject> {
    if (!parser) {
        const worker = new Worker(new URL('./display-project-worker.ts', import.meta.url), { type: 'module' });
        parser = worker;
        const fail = (error: Error) => {
            worker.terminate();
            if (parser !== worker) return;
            parser = undefined;
            for (const job of pending.values()) job.reject(error);
            pending.clear();
        };
        worker.onerror = event => { event.preventDefault(); fail(new Error(event.message || '모델 파싱 워커가 종료되었습니다.')); };
        worker.onmessageerror = () => fail(new Error('모델 파싱 결과를 읽을 수 없습니다.'));
        worker.onmessage = (event: MessageEvent<DisplayParserResponse>) => {
            const message = event.data;
            if (message.type === 'asset') {
                void mainThreadAssetProvider.getAsset(message.path).then(value => {
                    if (parser === worker) worker.postMessage({ type: 'asset', id: message.id, value } satisfies DisplayParserRequest);
                }).catch(error => {
                    if (parser === worker) worker.postMessage({ type: 'asset', id: message.id, error: String(error) } satisfies DisplayParserRequest);
                });
                return;
            }
            const job = pending.get(message.id);
            if (!job) return;
            pending.delete(message.id);
            if (message.type === 'parsed') job.resolve(message.project);
            else job.reject(new Error(message.error));
        };
    }
    return new Promise((resolve, reject) => {
        const id = ++nextId;
        pending.set(id, { resolve, reject });
        try { parser!.postMessage({ type: 'parse', id, nodes } satisfies DisplayParserRequest); }
        catch (error) { pending.delete(id); reject(error); }
    });
}
