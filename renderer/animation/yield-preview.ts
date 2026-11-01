const pending: Array<() => void> = [];
const channel = new MessageChannel();
channel.port1.onmessage = () => pending.shift()?.();

export function yieldPreview(): Promise<void> {
    return new Promise(resolve => { pending.push(resolve); channel.port2.postMessage(0); });
}
