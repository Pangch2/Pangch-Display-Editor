import * as THREE from 'three/webgpu';
import { dragPreviewPositionNode, dragSelectedAttributeName } from '../entity-material';
import defaultFont from './client/assets/minecraft/font/include/default.json';

export type TextDisplayOptions = {
    color?: string;
    alpha?: number;
    backgroundColor?: string;
    backgroundAlpha?: number;
    bold?: boolean;
    italic?: boolean;
    underline?: boolean;
    strikeThrough?: boolean;
    obfuscated?: boolean;
    lineLength?: number;
    align?: 'left' | 'center' | 'right';
    font?: string;
};

export type TextDisplayItem = {
    name?: string;
    options?: TextDisplayOptions;
};

type BitmapGlyph = {
    image: HTMLImageElement;
    sourceX: number;
    sourceY: number;
    sourceWidth: number;
    sourceHeight: number;
    scale: number;
    advance: number;
    ascent: number;
};

type BitmapProvider = {
    file: string;
    height?: number;
    ascent: number;
    chars: string[];
};

const textPixelSize = 0.025;
const lineHeight = 10;
const textureScale = 2;
const fontSize = 8;
const unifontFamily = 'PDE Unifont';
const bitmapFontUrls: Record<string, string> = {
    'minecraft:font/nonlatin_european.png': new URL('./client/assets/minecraft/textures/font/nonlatin_european.png', import.meta.url).href,
    'minecraft:font/accented.png': new URL('./client/assets/minecraft/textures/font/accented.png', import.meta.url).href,
    'minecraft:font/ascii.png': new URL('./client/assets/minecraft/textures/font/ascii.png', import.meta.url).href
};
let unifontPromise: Promise<void> | undefined;
let bitmapFontPromise: Promise<Map<string, BitmapGlyph>> | undefined;

function loadUnifont(): Promise<void> {
    return unifontPromise ??= new FontFace(
        unifontFamily,
        `url(${new URL('../../resources/unifont-17.0.01.ttf', import.meta.url).href})`
    ).load().then(font => {
        document.fonts.add(font);
    });
}

function loadImage(url: string): Promise<HTMLImageElement> {
    const image = new Image();
    image.src = url;
    return image.decode().then(() => image);
}

function loadBitmapFont(): Promise<Map<string, BitmapGlyph>> {
    return bitmapFontPromise ??= (async () => {
        const glyphs = new Map<string, BitmapGlyph>();
        for (const provider of defaultFont.providers as BitmapProvider[]) {
            const image = await loadImage(bitmapFontUrls[provider.file]);
            const rows = provider.chars.map(row => Array.from(row));
            const sourceWidth = image.naturalWidth / rows[0].length;
            const sourceHeight = image.naturalHeight / rows.length;
            const scale = (provider.height ?? 8) / sourceHeight;
            const canvas = document.createElement('canvas');
            canvas.width = image.naturalWidth;
            canvas.height = image.naturalHeight;
            const context = canvas.getContext('2d', { willReadFrequently: true })!;
            context.drawImage(image, 0, 0);
            const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;

            rows.forEach((row, rowIndex) => row.forEach((character, columnIndex) => {
                if (character === '\0' || glyphs.has(character)) return;
                let actualWidth = 0;
                for (let x = sourceWidth - 1; x >= 0 && actualWidth === 0; x--) {
                    for (let y = 0; y < sourceHeight; y++) {
                        const pixel = ((rowIndex * sourceHeight + y) * canvas.width + columnIndex * sourceWidth + x) * 4;
                        if (pixels[pixel + 3] !== 0) {
                            actualWidth = x + 1;
                            break;
                        }
                    }
                }
                glyphs.set(character, {
                    image,
                    sourceX: columnIndex * sourceWidth,
                    sourceY: rowIndex * sourceHeight,
                    sourceWidth,
                    sourceHeight,
                    scale,
                    advance: Math.floor(actualWidth * scale + 0.5) + 1,
                    ascent: provider.ascent
                });
            }));
        }
        return glyphs;
    })();
}

function clampAlpha(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value)
        ? THREE.MathUtils.clamp(value, 0, 1)
        : fallback;
}

function wrapText(text: string, maxWidth: number, measure: (value: string) => number): string[] {
    const lines: string[] = [];
    for (const paragraph of text.split('\n')) {
        let line = '';
        for (const token of paragraph.match(/\s+|\S+/gu) ?? ['']) {
            if (line && measure(line + token) > maxWidth) {
                lines.push(line.trimEnd());
                line = token.trimStart();
            } else {
                line += token;
            }
            while (line && measure(line) > maxWidth) {
                const characters = Array.from(line);
                let end = 1;
                while (end < characters.length && measure(characters.slice(0, end + 1).join('')) <= maxWidth) end++;
                lines.push(characters.slice(0, end).join(''));
                line = characters.slice(end).join('');
            }
        }
        lines.push(line);
    }
    return lines.length ? lines : [''];
}

function validColor(value: unknown, fallback: string): string {
    return typeof value === 'string' && CSS.supports('color', value) ? value : fallback;
}

function obfuscate(text: string): string {
    const glyphs = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    return Array.from(text, character => /\s/u.test(character)
        ? character
        : glyphs[Math.floor(Math.random() * glyphs.length)]).join('');
}

function glyphAdvance(
    character: string,
    context: CanvasRenderingContext2D,
    bitmapFont: Map<string, BitmapGlyph>,
    bold: boolean
): number {
    if (character === '\u200c') return 0;
    if (character === ' ') return 4;
    const bitmapGlyph = bitmapFont.get(character);
    if (bitmapGlyph) return bitmapGlyph.advance + (bold ? 1 : 0);
    return Math.max(1, Math.round(context.measureText(character).width)) + 1;
}

function measureText(text: string, context: CanvasRenderingContext2D, bitmapFont: Map<string, BitmapGlyph>, bold: boolean): number {
    return Array.from(text).reduce((width, character) => width + glyphAdvance(character, context, bitmapFont, bold), 0);
}

function drawText(
    context: CanvasRenderingContext2D,
    text: string,
    x: number,
    baseline: number,
    bitmapFont: Map<string, BitmapGlyph>,
    options: TextDisplayOptions
): void {
    for (const character of text) {
        const glyph = bitmapFont.get(character);
        if (glyph) {
            context.save();
            if (options.italic) context.transform(1, 0, -0.25, 1, baseline * 0.25, 0);
            const draw = (offset: number) => context.drawImage(
                glyph.image,
                glyph.sourceX,
                glyph.sourceY,
                glyph.sourceWidth,
                glyph.sourceHeight,
                x + offset,
                baseline - glyph.ascent,
                glyph.sourceWidth * glyph.scale,
                glyph.sourceHeight * glyph.scale
            );
            draw(0);
            if (options.bold) draw(1);
            context.restore();
        } else {
            context.fillText(character, x, baseline);
        }
        x += glyphAdvance(character, context, bitmapFont, !!options.bold);
    }
}

function snapTextAlpha(data: Uint8ClampedArray, alpha: number): void {
    const threshold = alpha / 2;
    for (let index = 3; index < data.length; index += 4) {
        data[index] = data[index] >= threshold ? alpha : 0;
    }
}

export async function createTextDisplayMesh(item: TextDisplayItem): Promise<THREE.InstancedMesh> {
    const [, bitmapFont] = await Promise.all([loadUnifont(), loadBitmapFont()]);
    const options = item.options ?? {};
    const activeBitmapFont = !options.font || options.font === 'minecraft:default' ? bitmapFont : new Map<string, BitmapGlyph>();
    const fontStyle = `${options.italic ? 'italic ' : ''}${options.bold ? 'bold ' : ''}${fontSize}px "${unifontFamily}"`;
    const measureCanvas = document.createElement('canvas');
    const measureContext = measureCanvas.getContext('2d')!;
    measureContext.font = fontStyle;

    const maxWidth = THREE.MathUtils.clamp(Number(options.lineLength) || 200, 1, 2045);
    const lines = wrapText(
        (item.name ?? '').slice(0, 16384),
        maxWidth,
        value => measureText(value, measureContext, activeBitmapFont, !!options.bold)
    ).slice(0, 200);
    const widths = lines.map(line => measureText(line, measureContext, activeBitmapFont, !!options.bold));
    const logicalWidth = Math.max(1, Math.ceil(Math.max(...widths))) + 2;
    const logicalHeight = lines.length * lineHeight + 1;
    const canvas = document.createElement('canvas');
    canvas.width = logicalWidth * textureScale;
    canvas.height = logicalHeight * textureScale;

    const context = canvas.getContext('2d')!;
    context.scale(textureScale, textureScale);
    context.font = fontStyle;
    context.textBaseline = 'alphabetic';
    context.fillStyle = '#ffffff';
    const textAlpha = Math.round(clampAlpha(options.alpha, 1) * 255);
    context.globalAlpha = textAlpha / 255;

    const align = options.align ?? 'center';
    lines.forEach((line, index) => {
        const renderedLine = options.obfuscated ? obfuscate(line) : line;
        const width = widths[index];
        const x = align === 'left' ? 1 : align === 'right' ? logicalWidth - width - 1 : (logicalWidth - width) / 2;
        const baseline = index * lineHeight + 8;
        drawText(context, renderedLine, x, baseline, activeBitmapFont, options);
        if (options.underline) context.fillRect(x, baseline + 1, width, 1);
        if (options.strikeThrough) context.fillRect(x, baseline - 3, width, 1);
    });

    context.globalCompositeOperation = 'source-in';
    context.globalAlpha = 1;
    context.fillStyle = validColor(options.color, '#ffffff');
    context.fillRect(0, 0, logicalWidth, logicalHeight);
    context.globalCompositeOperation = 'source-over';
    const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
    snapTextAlpha(imageData.data, textAlpha);
    context.putImageData(imageData, 0, 0);
    context.globalCompositeOperation = 'destination-over';
    context.fillStyle = validColor(options.backgroundColor, '#000000');
    context.globalAlpha = clampAlpha(options.backgroundAlpha, 0.25);
    context.fillRect(0, 0, logicalWidth, logicalHeight);
    context.globalCompositeOperation = 'source-over';

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.magFilter = THREE.NearestFilter;
    texture.minFilter = THREE.NearestFilter;
    texture.generateMipmaps = false;

    const geometry = new THREE.PlaneGeometry(logicalWidth * textPixelSize, logicalHeight * textPixelSize);
    geometry.translate(0, logicalHeight * textPixelSize / 2, 0);
    geometry.setAttribute(dragSelectedAttributeName, new THREE.InstancedBufferAttribute(new Float32Array(1), 1));

    const material = new THREE.MeshBasicNodeMaterial({
        map: texture,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        toneMapped: false,
        fog: false
    });
    material.positionNode = dragPreviewPositionNode;

    // ponytail: one texture per display; switch to an atlas only if text-heavy scenes prove this is a bottleneck.
    return new THREE.InstancedMesh(geometry, material, 1);
}

if (import.meta.env.DEV) {
    console.assert(wrapText('ab cd', 3, value => value.length).join('|') === 'ab|cd', 'Text display wrapping changed.');
    const context = document.createElement('canvas').getContext('2d')!;
    console.assert(measureText(' \u200c ', context, new Map(), false) === 8, 'Minecraft text advances changed.');
    const alpha = new Uint8ClampedArray([0, 0, 0, 63, 0, 0, 0, 64]);
    snapTextAlpha(alpha, 128);
    console.assert(alpha[3] === 0 && alpha[7] === 128, 'Minecraft text alpha changed.');
    void loadBitmapFont().then(font => console.assert(font.has('A') && font.has('0'), 'Minecraft bitmap font failed to load.'));
}
