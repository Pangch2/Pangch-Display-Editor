import type { AssetPayload } from './pbde-types';

// --- 메인 스레드용 에셋 공급자 ---

function isNodeBufferLike(content: unknown): content is { type: 'Buffer'; data: number[] } {
    return !!content && typeof content === 'object' && (content as Record<string, unknown>).type === 'Buffer' && Array.isArray((content as Record<string, unknown>).data);
}

function decodeIpcContentToString(content: unknown): string {
    try {
        if (!content) return '';
        // Node Buffer 형태
        if (isNodeBufferLike(content)) {
            return new TextDecoder('utf-8').decode(new Uint8Array(content.data));
        }
        // 브라우저 Uint8Array
        if (content instanceof Uint8Array) {
            return new TextDecoder('utf-8').decode(content);
        }
        // 그 외 객체는 toString을 시도한다.
        if (typeof (content as { toString?: (encoding?: string) => string }).toString === 'function') {
            const toStringFn = (content as { toString: (encoding?: string) => string }).toString;
            try {
                return toStringFn.call(content, 'utf-8');
            } catch {
                return toStringFn.call(content);
            }
        }
        return String(content);
    } catch {
        return String(content);
    }
}

function toUint8Array(input: ArrayBuffer | ArrayBufferView): Uint8Array {
    if (input instanceof ArrayBuffer) {
        return new Uint8Array(input);
    }
    const view = input as ArrayBufferView;
    const copy = new Uint8Array(view.byteLength);
    copy.set(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
    return copy;
}

const mainThreadAssetProvider: { getAsset(assetPath: string): Promise<AssetPayload> } = {
    async getAsset(assetPath: string): Promise<AssetPayload> {
        const isHardcoded = assetPath.startsWith('hardcoded/');
        const result = isHardcoded
            ? await window.ipcApi.getHardcodedContent(assetPath.replace(/^hardcoded\//, ''))
            : await window.ipcApi.getAssetContent(assetPath);
        if (!result.success) throw new Error(`Asset read failed: ${assetPath}: ${result.error}`);
        // PNG 텍스처라면 워커에서 ImageBitmap을 만들 수 있도록 원본 바이트를 반환한다.
        if (/\.png$/i.test(assetPath)) {
            const content = result.content;
            if (isNodeBufferLike(content)) {
                return new Uint8Array(content.data);
            }
            if (content instanceof Uint8Array) return content;
            if (ArrayBuffer.isView(content)) return toUint8Array(content);
            if (content instanceof ArrayBuffer) return toUint8Array(content);
            if (typeof content === 'string') {
                // 문자열로 내려온 경우 바이너리처럼 취급해 바이트 배열을 만든다.
                const bytes = new Uint8Array(content.length);
                for (let i = 0; i < content.length; i++) bytes[i] = content.charCodeAt(i) & 0xff;
                return bytes;
            }
            return content; // 형식이 불명확하면 그대로 전달한다.
        }
        // JSON 또는 텍스트 에셋은 문자열로 변환한다.
        return decodeIpcContentToString(result.content);
    }
};




export { mainThreadAssetProvider, isNodeBufferLike, toUint8Array };
