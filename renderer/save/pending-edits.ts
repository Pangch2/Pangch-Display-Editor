const pendingEdits = new Set<Promise<unknown>>();
const inputEdits = new Set<Promise<unknown>>();
const editFlushers = new Set<() => Promise<void>>();

export function trackProjectEdit<T>(promise: Promise<T>): Promise<T> {
    pendingEdits.add(promise);
    void promise.then(() => pendingEdits.delete(promise), () => pendingEdits.delete(promise));
    return promise;
}

export function trackProjectInputEdit<T>(promise: Promise<T>): Promise<T> {
    inputEdits.add(promise);
    void promise.then(() => inputEdits.delete(promise), () => inputEdits.delete(promise));
    return trackProjectEdit(promise);
}

export function queueProjectEdit(flush: () => Promise<void>): void {
    editFlushers.add(flush);
}

export function startProjectEdit(flush: () => Promise<void>): void {
    editFlushers.delete(flush);
}

export async function flushProjectEdits(skipFlusher?: () => Promise<void>): Promise<void> {
    do {
        for (const flush of [...editFlushers]) if (flush !== skipFlusher) await flush();
        await Promise.all([...pendingEdits]);
    } while (pendingEdits.size || [...editFlushers].some(flush => flush !== skipFlusher));
}

if (typeof window !== 'undefined') for (const type of ['pde:before-history-change', 'pde:after-history-change']) {
    window.addEventListener(type, event => {
        (event as CustomEvent<{ waitUntil: (promise: Promise<void>) => void }>).detail?.waitUntil(flushProjectEdits());
    });
}

export function commitFocusedProjectEdit(): void {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    window.dispatchEvent(new Event('pde:finish-transform'));
}

export async function settleCurrentProjectEdits(): Promise<void> {
    for (const flush of [...editFlushers]) await flush();
    await Promise.all([...inputEdits]);
}

export function deferProjectChange(change: () => void): boolean {
    commitFocusedProjectEdit();
    if (!inputEdits.size && !editFlushers.size) return false;
    void settleCurrentProjectEdits().then(change).catch(error => window.alert(error instanceof Error ? error.message : String(error)));
    return true;
}
