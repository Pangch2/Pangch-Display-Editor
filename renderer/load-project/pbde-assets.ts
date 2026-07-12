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

async function getBlockPropertyOptions(name: string, current: Record<string, string>): Promise<Record<string, string[]>> {
    const baseName = name.replace(/\[[^\]]*\]$/, '');
    const [namespace, ...pathParts] = baseName.includes(':') ? baseName.split(':') : ['minecraft', baseName];
    const path = pathParts.join(':');
    let blockstate: any;
    try {
        blockstate = JSON.parse(String(await mainThreadAssetProvider.getAsset(`assets/${namespace}/blockstates/${path}.json`)));
    } catch {
        blockstate = JSON.parse(String(await mainThreadAssetProvider.getAsset(`hardcoded/blockstates/${path}.json`)));
    }

    const options = Object.fromEntries(Object.entries(current).map(([key, value]) => [
        key,
        new Set(value === 'true' || value === 'false' ? ['true', 'false'] : [String(value)])
    ])) as Record<string, Set<string>>;
    if (blockstate.variants) {
        for (const variantKey of Object.keys(blockstate.variants)) {
            const variant = Object.fromEntries(variantKey.split(',').filter(Boolean).map((part: string) => part.split('=', 2)));
            for (const key of Object.keys(current)) {
                if (!(key in variant)) continue;
                const matchesOtherProperties = Object.entries(variant).every(([otherKey, value]) => otherKey === key || current[otherKey] === value);
                if (matchesOtherProperties) options[key].add(String(variant[key]));
            }
        }
    } else if (blockstate.multipart) {
        const collect = (condition: unknown): void => {
            if (!condition || typeof condition !== 'object') return;
            for (const [key, value] of Object.entries(condition)) {
                if (key === 'OR' || key === 'AND') {
                    (Array.isArray(value) ? value : [value]).forEach(collect);
                } else if (options[key]) {
                    String(value).split('|').forEach(candidate => options[key].add(candidate));
                }
            }
        };
        blockstate.multipart.forEach((part: any) => collect(part?.when));
    }
    return Object.fromEntries(Object.entries(options).map(([key, values]) => [key, [...values]]));
}




export { getBlockPropertyOptions, mainThreadAssetProvider, isNodeBufferLike, toUint8Array };
