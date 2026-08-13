import * as THREE from 'three/webgpu';
import { strFromU8 } from 'fflate';
import { getAssetBytes } from '../asset-manager';
import { entityVisiblePositionNode, setEntityStateAttributes } from '../entity-material';

export type TextDisplayOptions = {
    color?: string;
    pageColors?: string[];
    pageAlphas?: number[];
    pageEffects?: TextDisplayEffects[];
    pageAligns?: Array<'left' | 'center' | 'right'>;
    pages?: string[];
    pageIndex?: number;
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

export type TextDisplayEffects = Pick<TextDisplayOptions, 'bold' | 'italic' | 'underline' | 'strikeThrough' | 'obfuscated'>;

export type TextDisplayItem = {
    name?: string;
    options?: TextDisplayOptions;
};

export function getTextDisplayTemplateKey(item: TextDisplayItem): string {
    return JSON.stringify([item.name ?? '', item.options ?? {}]);
}

type BitmapGlyph = {
    image: CanvasImageSource;
    sourceX: number;
    sourceY: number;
    sourceWidth: number;
    sourceHeight: number;
    scale: number;
    advance: number;
    ascent: number;
    boldOffset: number;
};

type BitmapProvider = {
    file: string;
    height?: number;
    ascent: number;
    chars: string[];
};

type UnihexFontSource = Map<number, string>;
type UnihexSizeOverride = [from: number, to: number, left: number, right: number];

const textPixelSize = 0.025;
const textBackgroundOffset = -0.01 * textPixelSize;
const lineHeight = 10;
const textureScale = 2;
const fontSize = 8;
const horizontalGlyphOverflow = 1;
const topGlyphOverflow = 2;
const maxTextAtlasSize = 4096;
let bitmapFontPromise: Promise<Map<string, BitmapGlyph>> | undefined;
let unihexFontPromise: Promise<UnihexFontSource> | undefined;
const minecraftItalicOffset = (canvasY: number): number => 1.25 - canvasY * 0.25;
const unihexSizeOverrides: UnihexSizeOverride[] = [
    [0x3001, 0x30ff, 0, 15],
    [0x3200, 0x9fff, 0, 15],
    [0x1100, 0x11ff, 0, 15],
    [0x3130, 0x318f, 0, 15],
    [0xa960, 0xa97f, 0, 15],
    [0xd7b0, 0xd7ff, 0, 15],
    [0xac00, 0xd7af, 1, 15],
    [0xf900, 0xfaff, 0, 15],
    [0xff01, 0xff5e, 0, 15]
];

async function loadImage(assetPath: string): Promise<ImageBitmap> {
    const bytes = await getAssetBytes(assetPath);
    return createImageBitmap(new Blob([new Uint8Array(bytes)], { type: 'image/png' }));
}

function loadBitmapFont(): Promise<Map<string, BitmapGlyph>> {
    return bitmapFontPromise ??= (async () => {
        const glyphs = new Map<string, BitmapGlyph>();
        const definition = JSON.parse(strFromU8(
            await getAssetBytes('assets/minecraft/font/include/default.json')
        )) as { providers: BitmapProvider[] };
        for (const provider of definition.providers) {
            const image = await loadImage(`assets/${provider.file.replace(':', '/textures/')}`);
            const rows = provider.chars.map(row => Array.from(row));
            const sourceWidth = image.width / rows[0].length;
            const sourceHeight = image.height / rows.length;
            const scale = (provider.height ?? 8) / sourceHeight;
            const canvas = document.createElement('canvas');
            canvas.width = image.width;
            canvas.height = image.height;
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
                    ascent: provider.ascent,
                    boldOffset: 1
                });
            }));
        }
        if (import.meta.env.DEV) {
            console.assert(glyphs.has('A') && glyphs.has('0'), 'Minecraft bitmap font failed to load.');
        }
        return glyphs;
    })();
}

function loadUnihexFont(): Promise<UnihexFontSource> {
    return unihexFontPromise ??= fetch(new URL('../../resources/unifont-17.0.01.hex', import.meta.url)).then(async response => {
        if (!response.ok) throw new Error(`Unifont HEX failed to load: ${response.status}`);
        const glyphs = new Map<number, string>();
        for (const line of (await response.text()).split(/\r?\n/u)) {
            const separator = line.indexOf(':');
            if (separator > 0) glyphs.set(Number.parseInt(line.slice(0, separator), 16), line.slice(separator + 1));
        }
        return glyphs;
    });
}

function unihexBounds(codepoint: number, hex: string): { left: number; right: number } {
    const override = unihexSizeOverrides.find(([from, to]) => codepoint >= from && codepoint <= to);
    if (override) return { left: override[2], right: override[3] };
    const digitsPerRow = hex.length / 16;
    const bitWidth = digitsPerRow * 4;
    let left = bitWidth;
    let right = -1;
    for (let row = 0; row < 16; row++) {
        for (let x = 0; x < bitWidth; x++) {
            const digit = Number.parseInt(hex[row * digitsPerRow + Math.floor(x / 4)], 16);
            if (digit & (8 >> (x % 4))) {
                left = Math.min(left, x);
                right = Math.max(right, x);
            }
        }
    }
    return right >= 0 ? { left, right } : { left: 0, right: bitWidth };
}

function createUnihexFont(text: string, source: UnihexFontSource): Map<string, BitmapGlyph> {
    const entries: Array<{ character: string; hex: string; left: number; right: number }> = [];
    for (const character of new Set(Array.from(text))) {
        const codepoint = character.codePointAt(0)!;
        const hex = source.get(codepoint);
        if (hex) entries.push({ character, hex, ...unihexBounds(codepoint, hex) });
    }
    const glyphs = new Map<string, BitmapGlyph>();
    if (!entries.length) return glyphs;

    const columns = Math.min(entries.length, 128);
    const atlas = document.createElement('canvas');
    atlas.width = columns * 32;
    atlas.height = Math.ceil(entries.length / columns) * 16;
    const context = atlas.getContext('2d')!;
    context.fillStyle = '#ffffff';

    entries.forEach((entry, index) => {
        const sourceX = (index % columns) * 32;
        const sourceY = Math.floor(index / columns) * 16;
        const digitsPerRow = entry.hex.length / 16;
        for (let row = 0; row < 16; row++) {
            for (let x = entry.left; x <= entry.right; x++) {
                const digit = Number.parseInt(entry.hex[row * digitsPerRow + Math.floor(x / 4)], 16);
                if (digit & (8 >> (x % 4))) context.fillRect(sourceX + x - entry.left, sourceY + row, 1, 1);
            }
        }
        const sourceWidth = entry.right - entry.left + 1;
        glyphs.set(entry.character, {
            image: atlas,
            sourceX,
            sourceY,
            sourceWidth,
            sourceHeight: 16,
            scale: 0.5,
            advance: Math.floor(sourceWidth / 2) + 1,
            ascent: 7,
            boldOffset: 0.5
        });
    });
    return glyphs;
}

function clampAlpha(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value)
        ? THREE.MathUtils.clamp(value, 0, 1)
        : fallback;
}

function wrapText(text: string, maxWidth: number, measure: (value: string, index: number) => number): Array<{ text: string; start: number }> {
    const lines: Array<{ text: string; start: number }> = [];
    const characters = Array.from(text);
    let start = 0;
    while (start < characters.length) {
        let width = 0;
        let lastSpace = -1;
        let hadNonZeroWidthCharacter = false;
        let end = start;
        for (; end < characters.length; end++) {
            const character = characters[end];
            if (character === '\n') break;
            if (character === ' ') lastSpace = end;
            const characterWidth = measure(character, end);
            width += characterWidth;
            if (hadNonZeroWidthCharacter && width > maxWidth) {
                end = lastSpace >= start ? lastSpace : end;
                break;
            }
            hadNonZeroWidthCharacter ||= characterWidth !== 0;
        }
        lines.push({ text: characters.slice(start, end).join(''), start });
        start = end + (characters[end] === ' ' || characters[end] === '\n' ? 1 : 0);
    }
    if (text.endsWith('\n')) lines.push({ text: '', start: characters.length });
    return lines.length ? lines : [{ text: '', start: 0 }];
}

function validColor(value: unknown, fallback: string): string {
    return typeof value === 'string' && CSS.supports('color', value) ? value : fallback;
}

function glyphAdvance(
    character: string,
    _context: CanvasRenderingContext2D,
    bitmapFont: Map<string, BitmapGlyph>,
    bold: boolean
): number {
    if (character === '\u200c') return 0;
    if (character === ' ') return 4;
    const bitmapGlyph = bitmapFont.get(character);
    if (bitmapGlyph) return bitmapGlyph.advance + (bold ? bitmapGlyph.boldOffset : 0);
    return 6 + (bold ? 1 : 0);
}

function measureText(text: string, context: CanvasRenderingContext2D, bitmapFont: Map<string, BitmapGlyph>, bold: boolean): number {
    return Array.from(text).reduce((width, character) => width + glyphAdvance(character, context, bitmapFont, bold), 0);
}

function obfuscationGlyphs(context: CanvasRenderingContext2D, bitmapFont: Map<string, BitmapGlyph>): Map<number, string[]> {
    const byAdvance = new Map<number, string[]>();
    const candidates = bitmapFont.size ? bitmapFont.keys() : 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    for (const character of candidates) {
        if (/\s/u.test(character)) continue;
        const advance = glyphAdvance(character, context, bitmapFont, false);
        const glyphs = byAdvance.get(advance) ?? [];
        glyphs.push(character);
        byAdvance.set(advance, glyphs);
    }
    return byAdvance;
}

function drawText(
    context: CanvasRenderingContext2D,
    text: string,
    x: number,
    baseline: number,
    bitmapFont: Map<string, BitmapGlyph>,
    start: number,
    effect: (index: number, key: keyof TextDisplayEffects) => boolean,
    obfuscatedGlyphs?: Map<number, string[]>
): void {
    Array.from(text).forEach((sourceCharacter, offset) => {
        const bold = effect(start + offset, 'bold');
        const italic = effect(start + offset, 'italic');
        const glyphs = effect(start + offset, 'obfuscated') && sourceCharacter !== ' '
            ? obfuscatedGlyphs?.get(glyphAdvance(sourceCharacter, context, bitmapFont, false))
            : undefined;
        const character = glyphs?.[Math.floor(Math.random() * glyphs.length)] ?? sourceCharacter;
        const glyph = bitmapFont.get(character);
        context.save();
        if (italic) {
            context.translate(x, baseline);
            context.transform(1, 0, -0.25, 1, 0, 0);
        }
        const drawX = italic ? 0 : x;
        const drawBaseline = italic ? 0 : baseline;
        if (glyph) {
            const draw = (offset: number) => context.drawImage(
                glyph.image,
                glyph.sourceX,
                glyph.sourceY,
                glyph.sourceWidth,
                glyph.sourceHeight,
                drawX + offset,
                drawBaseline - glyph.ascent,
                glyph.sourceWidth * glyph.scale,
                glyph.sourceHeight * glyph.scale
            );
            draw(0);
            if (bold) draw(glyph.boldOffset);
        } else {
            context.fillText(character, drawX, drawBaseline);
            if (bold) context.fillText(character, drawX + 1, drawBaseline);
        }
        context.restore();
        x += glyphAdvance(character, context, bitmapFont, bold);
    });
}

function snapTextAlpha(data: Uint8ClampedArray, alpha: number): void {
    const threshold = alpha / 2;
    for (let index = 3; index < data.length; index += 4) {
        data[index] = data[index] >= threshold ? alpha : 0;
    }
}

type TextAlphaSegment = { x: number; y: number; width: number; alpha: number };

function applyTextAlphaSegments(data: Uint8ClampedArray, canvasWidth: number, scale: number, segments: TextAlphaSegment[]): void {
    const canvasHeight = data.length / 4 / canvasWidth;
    for (const segment of segments) {
        const left = Math.max(0, Math.floor(segment.x * scale));
        const right = Math.min(canvasWidth, Math.ceil((segment.x + segment.width) * scale));
        const top = Math.max(0, Math.floor(segment.y * scale));
        const bottom = Math.min(canvasHeight, Math.ceil((segment.y + lineHeight) * scale));
        const alpha = Math.round(segment.alpha * 255);
        for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) {
            const index = (y * canvasWidth + x) * 4 + 3;
            if (data[index]) data[index] = alpha;
        }
    }
}

if (import.meta.env.DEV) {
    const alphaCheck = new Uint8ClampedArray([0, 0, 0, 255, 0, 0, 0, 255]);
    applyTextAlphaSegments(alphaCheck, 2, 1, [{ x: 0, y: 0, width: 1, alpha: 0.5 }]);
    console.assert(alphaCheck[3] === 128 && alphaCheck[7] === 255, 'Page alpha must not erase adjacent text.');
}

function createTextDisplayMaterial(texture: THREE.Texture, opaqueBackground: boolean): THREE.MeshBasicNodeMaterial {
    const material = new THREE.MeshBasicNodeMaterial({
        map: texture,
        transparent: true,
        depthWrite: opaqueBackground,
        alphaTest: opaqueBackground ? 0.001 : 0,
        side: THREE.DoubleSide,
        toneMapped: false,
        fog: false
    });
    material.positionNode = entityVisiblePositionNode;
    return material;
}

export async function createTextDisplayMesh(item: TextDisplayItem): Promise<THREE.InstancedMesh> {
    const options = item.options ?? {};
    const text = (item.name ?? '').slice(0, 16384);
    const pageEnds = (options.pages?.length ? options.pages : [text]).reduce<number[]>((ends, page) => {
        ends.push((ends[ends.length - 1] ?? 0) + Array.from(page).length);
        return ends;
    }, []);
    const pageIndexForCharacter = (characterIndex: number) => Math.max(0, pageEnds.findIndex(end => characterIndex < end));
    const pageEffect = (characterIndex: number, key: keyof TextDisplayEffects) => options.pageEffects?.[pageIndexForCharacter(characterIndex)]?.[key] ?? options[key] ?? false;
    const [bitmapFont, unihexSource] = await Promise.all([loadBitmapFont(), loadUnihexFont()]);
    const unihexFont = createUnihexFont(text, unihexSource);
    const activeBitmapFont = !options.font || options.font === 'minecraft:default'
        ? new Map<string, BitmapGlyph>([...unihexFont, ...bitmapFont])
        : options.font === 'minecraft:uniform' ? unihexFont : new Map<string, BitmapGlyph>();
    const fontStyle = `${fontSize}px sans-serif`;
    const measureCanvas = document.createElement('canvas');
    const measureContext = measureCanvas.getContext('2d')!;
    measureContext.font = fontStyle;
    const obfuscatedGlyphs = options.obfuscated || options.pageEffects?.some(effect => effect.obfuscated) ? obfuscationGlyphs(measureContext, activeBitmapFont) : undefined;
    const measureRange = (value: string, start: number) => Array.from(value).reduce((width, character, offset) =>
        width + glyphAdvance(character, measureContext, activeBitmapFont, pageEffect(start + offset, 'bold')), 0);

    const maxWidth = Math.max(Math.trunc(Number(options.lineLength) || 50), 1) * 4;
    const lines = wrapText(
        text,
        maxWidth,
        (value, index) => measureRange(value, index)
    ).slice(0, 200);
    const widths = lines.map(line => Math.ceil(measureRange(line.text, line.start)));
    const contentWidth = Math.ceil(Math.max(...widths));
    const logicalWidth = contentWidth + 1;
    const logicalHeight = lines.length * lineHeight;
    const renderWidth = logicalWidth + horizontalGlyphOverflow * 2;
    const renderHeight = logicalHeight + topGlyphOverflow;
    const renderScale = textureScale;
    const canvas = document.createElement('canvas');
    canvas.width = renderWidth * renderScale;
    canvas.height = renderHeight * renderScale;

    const context = canvas.getContext('2d')!;
    context.imageSmoothingEnabled = false;
    context.scale(renderScale, renderScale);
    context.font = fontStyle;
    context.textBaseline = 'alphabetic';
    context.fillStyle = '#ffffff';
    const textAlpha = Math.round(clampAlpha(options.alpha, 1) * 255);
    context.globalAlpha = 1;

    lines.forEach((line, index) => {
        const align = options.pageAligns?.[pageIndexForCharacter(line.start)] ?? options.align ?? 'center';
        const width = widths[index];
        const x = Math.round((horizontalGlyphOverflow + 1 + (align === 'left' ? 0 : align === 'right' ? contentWidth - width : (contentWidth - width) / 2)) * renderScale) / renderScale;
        const baseline = topGlyphOverflow + index * lineHeight + 8;
        drawText(context, line.text, x, baseline, activeBitmapFont, line.start, pageEffect, obfuscatedGlyphs);
        Array.from(line.text).forEach((character, offset) => {
            const characterX = x + measureRange(Array.from(line.text).slice(0, offset).join(''), line.start);
            const characterWidth = glyphAdvance(character, measureContext, activeBitmapFont, pageEffect(line.start + offset, 'bold'));
            if (pageEffect(line.start + offset, 'underline')) context.fillRect(characterX, baseline + 1, characterWidth, 1);
            if (pageEffect(line.start + offset, 'strikeThrough')) context.fillRect(characterX, baseline - 3.5, characterWidth, 1);
        });
    });
    const pageColor = (characterIndex: number) => validColor(options.pageColors?.[pageIndexForCharacter(characterIndex)] ?? options.color, '#ffffff');
    const pageAlpha = (characterIndex: number) => clampAlpha(options.pageAlphas?.[pageIndexForCharacter(characterIndex)] ?? options.alpha, 1);
    const samePageStyle = (left: number, right: number) => pageColor(left) === pageColor(right) && pageAlpha(left) === pageAlpha(right);
    if (import.meta.env.DEV && pageEnds.length > 1) {
        console.assert(pageColor(pageEnds[0]) === validColor(options.pageColors?.[1] ?? options.color, '#ffffff'), 'Text page colors must remain independent.');
    }
    context.globalCompositeOperation = 'source-atop';
    context.globalAlpha = 1;
    const pageSegments: TextAlphaSegment[] = [];
    lines.forEach((line, index) => {
        const align = options.pageAligns?.[pageIndexForCharacter(line.start)] ?? options.align ?? 'center';
        const width = widths[index];
        const x = Math.round((horizontalGlyphOverflow + 1 + (align === 'left' ? 0 : align === 'right' ? contentWidth - width : (contentWidth - width) / 2)) * renderScale) / renderScale;
        const characters = Array.from(line.text);
        let offset = 0;
        while (offset < characters.length) {
            const color = pageColor(line.start + offset);
            const alpha = pageAlpha(line.start + offset);
            let end = offset + 1;
            while (end < characters.length && samePageStyle(line.start + offset, line.start + end)) end++;
            context.fillStyle = color;
            const segmentX = x + measureRange(characters.slice(0, offset).join(''), line.start);
            const segmentWidth = measureRange(characters.slice(offset, end).join(''), line.start + offset);
            context.fillRect(segmentX, topGlyphOverflow + index * lineHeight, segmentWidth, lineHeight);
            pageSegments.push({ x: segmentX, y: topGlyphOverflow + index * lineHeight, width: segmentWidth, alpha });
            offset = end;
        }
    });
    context.globalCompositeOperation = 'source-over';
    const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
    snapTextAlpha(imageData.data, 255);
    applyTextAlphaSegments(imageData.data, canvas.width, renderScale, pageSegments);
    context.putImageData(imageData, 0, 0);
    const backgroundAlpha = clampAlpha(options.backgroundAlpha, 0.25);
    context.globalAlpha = textAlpha / 255;
    context.fillStyle = validColor(options.color, '#ffffff');
    context.fillRect(0, 0, 1 / renderScale, 1 / renderScale);
    context.globalAlpha = backgroundAlpha;
    context.fillStyle = validColor(options.backgroundColor, '#000000');
    context.fillRect(1 / renderScale, 0, 1 / renderScale, 1 / renderScale);
    context.globalCompositeOperation = 'source-over';

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.magFilter = THREE.NearestFilter;
    texture.minFilter = THREE.NearestFilter;
    texture.generateMipmaps = false;

    const positions: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];
    const addQuad = (
        leftTop: number, rightTop: number, leftBottom: number, rightBottom: number,
        top: number, bottom: number, u0: number, u1: number, vTop: number, vBottom: number,
        z = 0
    ): void => {
        const offset = positions.length / 3;
        positions.push(leftTop, top, z, leftBottom, bottom, z, rightTop, top, z, rightBottom, bottom, z);
        uvs.push(u0, vTop, u0, vBottom, u1, vTop, u1, vBottom);
        indices.push(offset, offset + 1, offset + 2, offset + 1, offset + 3, offset + 2);
    };
    const left = (0.5 - renderWidth / 2) * textPixelSize;
    const right = left + renderWidth * textPixelSize;
    const swatchV = 1 - 0.5 / canvas.height;
    const backgroundSwatchU = 1.5 / canvas.width;

    addQuad(
        (0.5 - logicalWidth / 2) * textPixelSize, (0.5 + logicalWidth / 2) * textPixelSize,
        (0.5 - logicalWidth / 2) * textPixelSize, (0.5 + logicalWidth / 2) * textPixelSize,
        logicalHeight * textPixelSize, 0,
        backgroundSwatchU, backgroundSwatchU, swatchV, swatchV,
        textBackgroundOffset
    );

    addQuad(left, right, left, right, logicalHeight * textPixelSize, 0, 0, 1, 1 - topGlyphOverflow / renderHeight, 0);

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geometry.setIndex(indices);
    geometry.boundingBox = new THREE.Box3(
        new THREE.Vector3((0.5 - logicalWidth / 2) * textPixelSize, 0, textBackgroundOffset),
        new THREE.Vector3((0.5 + logicalWidth / 2) * textPixelSize, logicalHeight * textPixelSize, 0)
    );
    if (import.meta.env.DEV) {
        console.assert(positions[2] === textBackgroundOffset && positions.some((_, index) => index % 3 === 2 && positions[index] === 0), 'Text display layers must stay separated.');
    }
    setEntityStateAttributes(geometry, 1);

    const material = createTextDisplayMaterial(texture, backgroundAlpha === 1);
    material.visible = text.length > 0;

    // ponytail: live edits stay standalone; static project text is packed by createTextDisplayTemplates.
    return new THREE.InstancedMesh(geometry, material, 1);
}

export async function createTextDisplayTemplates(items: TextDisplayItem[]): Promise<Map<string, THREE.InstancedMesh>> {
    const uniqueItems = new Map(items.map(item => [getTextDisplayTemplateKey(item), item]));
    const templates = new Map(await Promise.all(Array.from(uniqueItems, async ([key, item]) => [
        key,
        await createTextDisplayMesh(item)
    ] as const)));
    const entries = Array.from(templates, ([key, mesh]) => {
        const material = mesh.material as THREE.MeshBasicNodeMaterial;
        const canvas = material.map?.image as HTMLCanvasElement | undefined;
        return canvas ? { key, mesh, material, canvas, x: 0, y: 0 } : null;
    }).filter(entry => entry !== null && entry.canvas.width <= maxTextAtlasSize && entry.canvas.height <= maxTextAtlasSize);
    if (entries.length < 2) return templates;

    const atlasWidth = Math.min(maxTextAtlasSize, Math.max(
        ...entries.map(entry => entry.canvas.width),
        Math.ceil(Math.sqrt(entries.reduce((area, entry) => area + entry.canvas.width * entry.canvas.height, 0)))
    ));
    const pages: Array<{ entries: typeof entries; x: number; y: number; rowHeight: number; width: number; height: number }> = [];
    for (const entry of entries.sort((a, b) => b.canvas.height - a.canvas.height)) {
        let page = pages[pages.length - 1];
        if (!page) pages.push(page = { entries: [], x: 0, y: 0, rowHeight: 0, width: 0, height: 0 });
        if (page.x + entry.canvas.width > atlasWidth) {
            page.x = 0;
            page.y += page.rowHeight;
            page.rowHeight = 0;
        }
        if (page.y + entry.canvas.height > maxTextAtlasSize) {
            pages.push(page = { entries: [], x: 0, y: 0, rowHeight: 0, width: 0, height: 0 });
        }
        entry.x = page.x;
        entry.y = page.y;
        page.entries.push(entry);
        page.x += entry.canvas.width;
        page.rowHeight = Math.max(page.rowHeight, entry.canvas.height);
        page.width = Math.max(page.width, page.x);
        page.height = Math.max(page.height, page.y + page.rowHeight);
    }

    for (const page of pages) {
        const canvas = document.createElement('canvas');
        canvas.width = page.width;
        canvas.height = page.height;
        const context = canvas.getContext('2d')!;
        context.imageSmoothingEnabled = false;
        for (const entry of page.entries) context.drawImage(entry.canvas, entry.x, entry.y);

        const texture = new THREE.CanvasTexture(canvas);
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.magFilter = THREE.NearestFilter;
        texture.minFilter = THREE.NearestFilter;
        texture.generateMipmaps = false;
        const materials = new Map<boolean, THREE.MeshBasicNodeMaterial>();
        for (const entry of page.entries) {
            const uv = entry.mesh.geometry.getAttribute('uv');
            const scaleX = entry.canvas.width / canvas.width;
            const scaleY = entry.canvas.height / canvas.height;
            const offsetX = entry.x / canvas.width;
            const offsetY = (canvas.height - entry.y - entry.canvas.height) / canvas.height;
            for (let index = 0; index < uv.count; index++) {
                uv.setXY(index, uv.getX(index) * scaleX + offsetX, uv.getY(index) * scaleY + offsetY);
            }
            uv.needsUpdate = true;
            const opaqueBackground = entry.material.depthWrite;
            let material = materials.get(opaqueBackground);
            if (!material) {
                material = createTextDisplayMaterial(texture, opaqueBackground);
                materials.set(opaqueBackground, material);
            }
            entry.mesh.material = material;
            entry.material.map?.dispose();
            entry.material.dispose();
        }
    }

    if (import.meta.env.DEV) console.assert(
        pages.every(page => page.width <= maxTextAtlasSize && page.height <= maxTextAtlasSize && page.entries.every((entry, index) => (
            entry.x + entry.canvas.width <= page.width
            && entry.y + entry.canvas.height <= page.height
            && page.entries.slice(index + 1).every(other => (
                entry.x + entry.canvas.width <= other.x
                || other.x + other.canvas.width <= entry.x
                || entry.y + entry.canvas.height <= other.y
                || other.y + other.canvas.height <= entry.y
            ))
        ))),
        'Text display atlas layout is invalid.'
    );
    return templates;
}

if (import.meta.env.DEV) {
    console.assert(wrapText('ab cd', 3, value => value.length).map(line => line.text).join('|') === 'ab|cd', 'Text display wrapping changed.');
    console.assert(wrapText('ab  cd', 3, value => value.length).map(line => line.text).join('|') === 'ab |cd', 'Text display spaces changed.');
    console.assert(wrapText('ab\n', 3, value => value.length).map(line => line.text).join('|') === 'ab|', 'Text display trailing newline changed.');
    console.assert(wrapText('텍스트', 5 * 4, () => 9).map(line => line.text).join('|') === '텍스|트', 'PDE line length conversion changed.');
    const context = document.createElement('canvas').getContext('2d')!;
    console.assert(measureText(' \u200c ', context, new Map(), false) === 8, 'Minecraft text advances changed.');
    console.assert(measureText('?', context, new Map(), false) === 6, 'Minecraft missing glyph advance changed.');
    console.assert(unihexBounds('텍'.codePointAt(0)!, '').right - unihexBounds('텍'.codePointAt(0)!, '').left + 1 === 15, 'Minecraft Hangul width override changed.');
    console.assert(minecraftItalicOffset(1) === 1 && minecraftItalicOffset(9) === -1, 'Minecraft italic offsets changed.');
    const alpha = new Uint8ClampedArray([0, 0, 0, 63, 0, 0, 0, 64]);
    snapTextAlpha(alpha, 128);
    console.assert(alpha[3] === 0 && alpha[7] === 128, 'Minecraft text alpha changed.');
}
