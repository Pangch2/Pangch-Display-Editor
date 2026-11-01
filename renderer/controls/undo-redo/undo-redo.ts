export interface UndoRedoCommand {
    undo(): void | Promise<void>;
    redo(): void | Promise<void>;
    dispose?(): void;
}

const maxHistory = 100;
interface History {
    undoStack: UndoRedoCommand[];
    redoStack: UndoRedoCommand[];
}

const histories = new Map<string, History>();
let context = 'default';
let applying = false;

function getHistory(): History {
    let history = histories.get(context);
    if (!history) {
        history = { undoStack: [], redoStack: [] };
        histories.set(context, history);
    }
    return history;
}

export function record(command: UndoRedoCommand): void {
    const { undoStack, redoStack } = getHistory();
    undoStack.push(command);
    if (undoStack.length > maxHistory) undoStack.shift()?.dispose?.();
    redoStack.splice(0).forEach(entry => entry.dispose?.());
}

async function settleHistoryChange(type: string): Promise<void> {
    if (typeof window === 'undefined') return;
    const pending: Promise<unknown>[] = [];
    window.dispatchEvent(new CustomEvent(type, { detail: { waitUntil: (promise: Promise<unknown>) => pending.push(promise) } }));
    await Promise.all(pending);
}

export async function undo(): Promise<boolean> {
    if (applying) return false;
    const historyContext = context;
    applying = true;
    try {
        await settleHistoryChange('pde:before-history-change');
        if (context !== historyContext) return false;
        const { undoStack, redoStack } = getHistory();
        const command = undoStack[undoStack.length - 1];
        if (!command) return false;
        await command.undo();
        undoStack.pop();
        redoStack.push(command);
        await settleHistoryChange('pde:after-history-change');
        return true;
    } finally {
        applying = false;
    }
}

export async function redo(): Promise<boolean> {
    if (applying) return false;
    const historyContext = context;
    applying = true;
    try {
        await settleHistoryChange('pde:before-history-change');
        if (context !== historyContext) return false;
        const { undoStack, redoStack } = getHistory();
        const command = redoStack[redoStack.length - 1];
        if (!command) return false;
        await command.redo();
        redoStack.pop();
        undoStack.push(command);
        await settleHistoryChange('pde:after-history-change');
        return true;
    } finally {
        applying = false;
    }
}

export function canUndo(): boolean {
    return getHistory().undoStack.length > 0;
}

export function canRedo(): boolean {
    return getHistory().redoStack.length > 0;
}

export function clear(): void {
    const { undoStack, redoStack } = getHistory();
    undoStack.splice(0).forEach(command => command.dispose?.());
    redoStack.splice(0).forEach(command => command.dispose?.());
}

export function setHistoryContext(key: string): void {
    context = key;
}

export function deleteHistoryContext(key: string): void {
    const history = histories.get(key);
    history?.undoStack.forEach(command => command.dispose?.());
    history?.redoStack.forEach(command => command.dispose?.());
    histories.delete(key);
}

export function isApplying(): boolean {
    return applying;
}
