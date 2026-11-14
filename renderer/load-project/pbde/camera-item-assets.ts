import { animationCameraItem } from '../../animation/animation-data';

// The camera item is an ordinary generated item whose texture is the lucide camera glyph (resources/lucide.woff2).
const [namespace, path] = animationCameraItem.split(':');
const model = `${namespace}:item/${path}`;
const texturePath = `assets/${namespace}/textures/item/${path}.png`;
const jsonAssets = new Map([
    [`assets/${namespace}/items/${path}.json`, JSON.stringify({ model: { type: 'minecraft:model', model } })],
    [`assets/${namespace}/models/item/${path}.json`, JSON.stringify({
        // A nearly flat quad (half a block wide, 0.001 blocks thick) so the camera reads as a 2D icon, not an extruded item. It keeps a sliver of
        // depth so an object replacing it with "keep visible size" gets a thin, non-degenerate scale.
        textures: { layer0: model },
        elements: [
            { from: [4, 4, 7.992], to: [12, 12, 8.008], shade: false, faces: { north: { uv: [0, 0, 16, 16], texture: '#layer0' }, south: { uv: [16, 0, 0, 16], texture: '#layer0' } } }
        ]
    })]
]);
let texture: Promise<Uint8Array> | undefined;

/** The camera item's asset at `assetPath`, or undefined for any other asset. */
export function cameraItemAsset(assetPath: string): string | Promise<Uint8Array> | undefined {
    if (assetPath === texturePath) return texture ??= drawCameraTexture().catch(error => { texture = undefined; throw error; });
    return jsonAssets.get(assetPath);
}

async function drawCameraTexture(): Promise<Uint8Array> {
    const size = 32, glyph = '';
    await document.fonts.load(`${size}px lucide`, glyph);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const context = canvas.getContext('2d', { willReadFrequently: true })!;
    context.font = `${size}px lucide`;
    context.fillStyle = '#ffffff';
    const box = context.measureText(glyph);
    context.fillText(glyph, (size - box.actualBoundingBoxLeft - box.actualBoundingBoxRight) / 2 + box.actualBoundingBoxLeft,
        (size - box.actualBoundingBoxAscent - box.actualBoundingBoxDescent) / 2 + box.actualBoundingBoxAscent);
    // Item pixels are either cut out or solid, so the glyph's soft edge is made one or the other.
    const image = context.getImageData(0, 0, size, size);
    for (let index = 3; index < image.data.length; index += 4) image.data[index] = image.data[index] < 128 ? 0 : 255;
    context.putImageData(image, 0, 0);
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('카메라 아이콘을 만들 수 없습니다.');
    return new Uint8Array(await blob.arrayBuffer());
}
