import * as THREE from 'three/webgpu';
import { dragPreviewPositionNode, dragSelectedAttributeName } from '../entity-material';

type TextDisplayOptions = {
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

const textPixelSize = 0.025;
const lineHeight = 10;
const textureScale = 2;
const fontSize = 8;
const unifontFamily = 'PDE Unifont';
let unifontPromise: Promise<void> | undefined;

function loadUnifont(): Promise<void> {
    return unifontPromise ??= new FontFace(
        unifontFamily,
        `url(${new URL('../../resources/unifont-16.0.03.ttf', import.meta.url).href})`
    ).load().then(font => {
        document.fonts.add(font);
    });
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

function glyphAdvance(character: string, context: CanvasRenderingContext2D): number {
    if (character === '\u200c') return 0;
    if (character === ' ') return 4;
    return Math.max(1, Math.round(context.measureText(character).width)) + 1;
}

function measureText(text: string, context: CanvasRenderingContext2D): number {
    return Array.from(text).reduce((width, character) => width + glyphAdvance(character, context), 0);
}

function drawText(context: CanvasRenderingContext2D, text: string, x: number, baseline: number): void {
    for (const character of text) {
        context.fillText(character, x, baseline);
        x += glyphAdvance(character, context);
    }
}

export async function createTextDisplayMesh(item: TextDisplayItem): Promise<THREE.InstancedMesh> {
    await loadUnifont();
    const options = item.options ?? {};
    const fontStyle = `${options.italic ? 'italic ' : ''}${options.bold ? 'bold ' : ''}${fontSize}px "${unifontFamily}"`;
    const measureCanvas = document.createElement('canvas');
    const measureContext = measureCanvas.getContext('2d')!;
    measureContext.font = fontStyle;

    const maxWidth = THREE.MathUtils.clamp(Number(options.lineLength) || 200, 1, 2045);
    const lines = wrapText((item.name ?? '').slice(0, 16384), maxWidth, value => measureText(value, measureContext)).slice(0, 200);
    const widths = lines.map(line => measureText(line, measureContext));
    const logicalWidth = Math.max(1, Math.ceil(Math.max(...widths))) + 2;
    const logicalHeight = lines.length * lineHeight + 1;
    const canvas = document.createElement('canvas');
    canvas.width = logicalWidth * textureScale;
    canvas.height = logicalHeight * textureScale;

    const context = canvas.getContext('2d')!;
    context.scale(textureScale, textureScale);
    context.fillStyle = validColor(options.backgroundColor, '#000000');
    context.globalAlpha = clampAlpha(options.backgroundAlpha, 0.25);
    context.fillRect(0, 0, logicalWidth, logicalHeight);
    context.font = fontStyle;
    context.textBaseline = 'alphabetic';
    context.fillStyle = validColor(options.color, '#ffffff');
    context.globalAlpha = clampAlpha(options.alpha, 1);

    const align = options.align ?? 'center';
    lines.forEach((line, index) => {
        const renderedLine = options.obfuscated ? obfuscate(line) : line;
        const width = widths[index];
        const x = align === 'left' ? 1 : align === 'right' ? logicalWidth - width - 1 : (logicalWidth - width) / 2;
        const baseline = index * lineHeight + 8;
        drawText(context, renderedLine, x, baseline);
        if (options.underline) context.fillRect(x, baseline + 1, width, 1);
        if (options.strikeThrough) context.fillRect(x, baseline - 3, width, 1);
    });

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
    console.assert(measureText(' \u200c ', context) === 8, 'Minecraft text advances changed.');
}
