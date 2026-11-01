import { parsePbdeProject } from './scene-parser';
import type { DisplayParserRequest, DisplayParserResponse } from './display-project-parser';

const worker = self as unknown as DedicatedWorkerGlobalScope;
const assets = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
let nextId = 0;
let queue = Promise.resolve();

worker.onmessage = (event: MessageEvent<DisplayParserRequest>) => {
    const message = event.data;
    if (message.type === 'asset') {
        const request = assets.get(message.id);
        if (!request) return;
        assets.delete(message.id);
        if (message.error) request.reject(new Error(message.error));
        else request.resolve(message.value);
        return;
    }
    // The parser owns mutable caches, so jobs must never overlap in this worker.
    queue = queue.then(async () => {
        try {
            const project = await parsePbdeProject({ children: message.nodes }, {
                getAsset: path => new Promise((resolve, reject) => {
                    const id = ++nextId;
                    assets.set(id, { resolve, reject });
                    worker.postMessage({ type: 'asset', id, path } satisfies DisplayParserResponse);
                })
            });
            // Atlas pixels stay in the worker's cache; only the unique geometry buffer is transferred.
            worker.postMessage({ type: 'parsed', id: message.id, project } satisfies DisplayParserResponse, [project.geometryBuffer]);
        } catch (error) {
            worker.postMessage({ type: 'error', id: message.id, error: String(error) } satisfies DisplayParserResponse);
        }
    });
};
