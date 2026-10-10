const pendingEdits = new Set<Promise<unknown>>();
const editFlushers = new Set<() => Promise<void>>();

export function trackProjectEdit<T>(promise: Promise<T>): Promise<T> {
    pendingEdits.add(promise);
    void promise.then(() => pendingEdits.delete(promise), () => pendingEdits.delete(promise));
    return promise;
}

export function queueProjectEdit(flush: () => Promise<void>): void {
    editFlushers.add(flush);
}

export function startProjectEdit(flush: () => Promise<void>): void {
    editFlushers.delete(flush);
}

export async function flushProjectEdits(): Promise<void> {
    do {
        for (const flush of [...editFlushers]) await flush();
        await Promise.all([...pendingEdits]);
    } while (pendingEdits.size || editFlushers.size);
}
