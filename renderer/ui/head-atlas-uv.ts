import { DataTexture, FloatType, RGBAFormat } from 'three/webgpu';

export type HeadUvRect = { x: number; y: number; width: number; height: number };
export type HeadUvEntry = { x: number; y: number; rect: HeadUvRect };
const atlasUvs = new WeakMap<HTMLCanvasElement, { texture: DataTexture; entries: Map<number, HeadUvEntry> }>();
const tileSize = 8;
let headAtlasReadCanvas: HTMLCanvasElement | null = null;

export function createHeadAtlasUvTexture(canvas: HTMLCanvasElement): DataTexture {
    const texture = new DataTexture(new Float32Array(canvas.width * canvas.height / 16), canvas.width / tileSize, canvas.height / tileSize, RGBAFormat, FloatType);
    texture.needsUpdate = true;
    atlasUvs.set(canvas, { texture, entries: new Map() });
    return texture;
}

export function getHeadAtlasUvRect(canvas: HTMLCanvasElement, x: number, y: number): HeadUvRect {
    return { ...(atlasUvs.get(canvas)?.entries.get(y / tileSize * (canvas.width / tileSize) + x / tileSize)?.rect
        ?? { x, y, width: tileSize, height: tileSize }) };
}

export function setHeadAtlasUvRect(canvas: HTMLCanvasElement, x: number, y: number, rect: HeadUvRect): void {
    const state = atlasUvs.get(canvas);
    if (!state) return;
    const key = y / tileSize * (canvas.width / tileSize) + x / tileSize;
    const index = ((canvas.height / tileSize - 1 - y / tileSize) * (canvas.width / tileSize) + x / tileSize) * 4;
    const identity = rect.x === x && rect.y === y && rect.width === tileSize && rect.height === tileSize;
    if (identity) state.entries.delete(key);
    else state.entries.set(key, { x, y, rect: { ...rect } });
    state.texture.image.data.set([
        rect.width / tileSize - 1, rect.height / tileSize - 1,
        (rect.x - x) / canvas.width, (y + tileSize - rect.y - rect.height) / canvas.height
    ], index);
    state.texture.needsUpdate = true;
}

export function captureHeadAtlasUvs(canvas: HTMLCanvasElement, region: HeadUvRect): HeadUvEntry[] {
    const entries = atlasUvs.get(canvas)?.entries;
    if (!entries?.size) return [];
    const result: HeadUvEntry[] = [];
    for (let y = Math.ceil(region.y / tileSize) * tileSize; y < region.y + region.height; y += tileSize) {
        for (let x = Math.ceil(region.x / tileSize) * tileSize; x < region.x + region.width; x += tileSize) {
            const entry = entries.get(y / tileSize * (canvas.width / tileSize) + x / tileSize);
            if (entry) result.push({ ...entry, rect: { ...entry.rect } });
        }
    }
    return result;
}

export function resetHeadAtlasUvs(canvas: HTMLCanvasElement, region: HeadUvRect): void {
    for (const { x, y } of captureHeadAtlasUvs(canvas, region)) setHeadAtlasUvRect(canvas, x, y, { x, y, width: tileSize, height: tileSize });
}

export function readHeadAtlasRegion(context: CanvasRenderingContext2D, region: HeadUvRect): ImageData {
    const entries = captureHeadAtlasUvs(context.canvas, region);
    if (!entries.length) return context.getImageData(region.x, region.y, region.width, region.height);
    const canvas = headAtlasReadCanvas ??= document.createElement('canvas');
    if (canvas.width !== region.width) canvas.width = region.width;
    if (canvas.height !== region.height) canvas.height = region.height;
    const output = canvas.getContext('2d', { willReadFrequently: true })!;
    output.imageSmoothingEnabled = false;
    output.clearRect(0, 0, canvas.width, canvas.height);
    output.drawImage(context.canvas, region.x, region.y, region.width, region.height, 0, 0, region.width, region.height);
    for (const { x, y, rect } of entries) {
        output.clearRect(x - region.x, y - region.y, tileSize, tileSize);
        output.drawImage(context.canvas, rect.x, rect.y, rect.width, rect.height, x - region.x, y - region.y, tileSize, tileSize);
    }
    return output.getImageData(0, 0, region.width, region.height);
}

export function transformHeadUvRect(rect: HeadUvRect, handle: string, dx: number, dy: number, size: number): HeadUvRect {
    const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, Math.round(value)));
    if (!handle) return { ...rect, x: clamp(rect.x + dx, 0, size - rect.width), y: clamp(rect.y + dy, 0, size - rect.height) };
    let { x, y } = rect;
    let right = x + rect.width;
    let bottom = y + rect.height;
    if (handle.includes('w')) x = clamp(x + dx, 0, right - 1);
    if (handle.includes('e')) right = clamp(right + dx, x + 1, size);
    if (handle.includes('n')) y = clamp(y + dy, 0, bottom - 1);
    if (handle.includes('s')) bottom = clamp(bottom + dy, y + 1, size);
    return { x, y, width: right - x, height: bottom - y };
}
