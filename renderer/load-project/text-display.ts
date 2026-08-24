import * as THREE from 'three/webgpu';
import { attribute, mix, positionGeometry, positionLocal, texture, uv, vec2, vec3 } from 'three/tsl';
import { strFromU8 } from 'fflate';
import { getAssetBytes } from '../asset-manager';
import { entityVisiblePosition, setEntityStateAttributes } from '../entity-material';

export type TextDisplayOptions = {
    color?: string;
    shadowColor?: string;
    shadowAlpha?: number;
    pageColors?: string[];
    pageAlphas?: number[];
    pageEffects?: TextDisplayEffects[];
    pageAligns?: Array<'left' | 'center' | 'right'>;
    pageTypes?: TextDisplayContentType[];
    pageAtlases?: string[];
    pageHats?: boolean[];
    pageTypeValues?: Array<Partial<Record<TextDisplayContentType, string>>>;
    pageExtraValues?: Array<{
        fallback?: string;
        scoreboard?: string;
        separator?: string;
        nbtSource?: 'entity' | 'block' | 'storage';
        entity?: string;
        block?: string;
        storage?: string;
        preview?: string;
        interpret?: boolean;
    }>;
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

export type TextDisplayContentType = 'text' | 'sprite' | 'player' | 'translate' | 'keybind' | 'score' | 'selector' | 'nbt';
export type TextDisplayEffects = Pick<TextDisplayOptions, 'bold' | 'italic' | 'underline' | 'strikeThrough' | 'obfuscated'>;

export type TextDisplayItem = {
    name?: string;
    options?: TextDisplayOptions;
    atlasKey?: string;
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
    shadowOffset: number;
};

type BitmapProvider = {
    file: string;
    height?: number;
    ascent: number;
    chars: string[];
};

type AtlasSprite = { image: ImageBitmap; x: number; y: number; width: number; height: number };
type AtlasSpriteSource = { image: ImageBitmap; sprites: Map<string, Omit<AtlasSprite, 'image'>> };
type AtlasSpriteReference = { characterIndex: number; atlas: string; sprite: string };
type PlayerSpriteReference = { characterIndex: number; username: string; hat: boolean };
type SpriteColorSegment = { x: number; y: number; color: string; alpha: number };
type UnihexFontSource = Map<number, string>;
type UnihexSizeOverride = [from: number, to: number, left: number, right: number];

const textPixelSize = 0.025;
const textBackgroundOffset = -0.01 * textPixelSize;
const lineHeight = 10;
const textureScale = 2;
const fontSize = 8;
const horizontalGlyphOverflow = 1;
const topGlyphOverflow = 2;
const textDisplayAtlasSize = 2048;
const maxTextCharacters = 16384;
const objectReplacementCharacter = '\ufffc';
export const textDisplayLayoutAttributeName = 'textDisplayLayout';
export const textDisplayUvBoundsAttributeName = 'textDisplayUvBounds';
export const textDisplayBackgroundUvAttributeName = 'textDisplayBackgroundUv';
const textDisplayBackgroundAttributeName = 'textDisplayBackground';
export const textDisplayInstanceAttributeNames = [
    textDisplayLayoutAttributeName,
    textDisplayUvBoundsAttributeName,
    textDisplayBackgroundUvAttributeName
] as const;
let bitmapFontPromise: Promise<Map<string, BitmapGlyph>> | undefined;
let unihexFontPromise: Promise<UnihexFontSource> | undefined;
const atlasSpriteSources = new Map<string, Promise<AtlasSpriteSource | null>>();
const playerSkinImages = new Map<string, Promise<ImageBitmap | null>>();
const cssColorChannels = new Map<string, Uint8ClampedArray>();
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

async function loadImage(assetPath: string, reportError = true): Promise<ImageBitmap> {
    const bytes = await getAssetBytes(assetPath, reportError);
    return createImageBitmap(new Blob([new Uint8Array(bytes)], { type: 'image/png' }));
}

function loadAtlasSpriteSource(atlas: string): Promise<AtlasSpriteSource | null> {
    const name = /^(?:minecraft:)?([a-z0-9_]+)$/u.exec(atlas)?.[1];
    if (!name) return Promise.resolve(null);
    const cached = atlasSpriteSources.get(name);
    if (cached) return cached;
    const promise = (async () => {
        const [image, bytes] = await Promise.all([
            loadImage(`sprite-atlases/${name}.png`, false),
            getAssetBytes(`sprite-atlases/${name}.json`, false)
        ]);
        const manifest = JSON.parse(new TextDecoder().decode(bytes)) as {
            sprites?: Array<{ id?: unknown; x?: unknown; y?: unknown; width?: unknown; height?: unknown }>;
        };
        if (!Array.isArray(manifest.sprites)) {
            image.close();
            return null;
        }
        const sprites = new Map<string, Omit<AtlasSprite, 'image'>>();
        for (const sprite of manifest.sprites) {
            if (typeof sprite.id !== 'string' || ![sprite.x, sprite.y, sprite.width, sprite.height].every(Number.isFinite)) continue;
            const { x, y, width, height } = sprite as { x: number; y: number; width: number; height: number };
            if (width > 0 && height > 0) sprites.set(sprite.id, { x, y, width, height });
        }
        return { image, sprites };
    })().catch(error => {
        console.warn(`Failed to load sprite atlas: ${atlas}`, error);
        return null;
    });
    atlasSpriteSources.set(name, promise);
    return promise;
}

function loadPlayerSkin(username: string): Promise<ImageBitmap | null> {
    const normalized = username.trim();
    if (!/^[A-Za-z0-9_]{3,16}$/u.test(normalized)) return Promise.resolve(null);
    const key = normalized.toLowerCase();
    const cached = playerSkinImages.get(key);
    if (cached) return cached;
    const promise = window.ipcApi.getMinecraftSkin(normalized).then(async result => {
        if (!result.success || !result.png) throw new Error(result.error ?? 'Minecraft skin lookup failed.');
        if (result.usedFallback) return null;
        const png = new Uint8Array(result.png.byteLength);
        png.set(result.png);
        return createImageBitmap(new Blob([png], { type: 'image/png' }));
    }).catch(error => {
        playerSkinImages.delete(key);
        console.warn(`Failed to load player skin: ${normalized}`, error);
        return null;
    });
    playerSkinImages.set(key, promise);
    return promise;
}

function prepareTextContent(sourceText: string, options: TextDisplayOptions): {
    text: string;
    pageEnds: number[];
    spriteReferences: AtlasSpriteReference[];
    playerReferences: PlayerSpriteReference[];
} {
    const pages = options.pages?.length ? options.pages : [sourceText];
    const characters: string[] = [];
    const pageEnds: number[] = [];
    const spriteReferences: AtlasSpriteReference[] = [];
    const playerReferences: PlayerSpriteReference[] = [];
    pages.forEach((page, pageIndex) => {
        const pageType = options.pageTypes?.[pageIndex];
        if (pageType === 'translate') page = options.pageExtraValues?.[pageIndex]?.fallback ?? page;
        else if (pageType === 'nbt') page = options.pageExtraValues?.[pageIndex]?.preview ?? '';
        if (characters.length < maxTextCharacters && (pageType === 'sprite' || pageType === 'player')) {
            if (pageType === 'sprite') spriteReferences.push({
                characterIndex: characters.length,
                atlas: options.pageAtlases?.[pageIndex] ?? 'minecraft:blocks',
                sprite: page.includes(':') ? page : `minecraft:${page}`
            });
            else playerReferences.push({ characterIndex: characters.length, username: page, hat: options.pageHats?.[pageIndex] ?? true });
            characters.push(objectReplacementCharacter);
        } else {
            characters.push(...Array.from(page).slice(0, maxTextCharacters - characters.length));
        }
        pageEnds.push(characters.length);
    });
    return { text: characters.join(''), pageEnds, spriteReferences, playerReferences };
}

function spriteTextureScale(sprites: Iterable<Pick<AtlasSprite, 'width' | 'height'>>): number {
    let scale = textureScale;
    for (const sprite of sprites) scale = Math.max(scale, Math.ceil(Math.max(sprite.width, sprite.height) / fontSize));
    return scale;
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
                    boldOffset: 1,
                    shadowOffset: 1
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
            boldOffset: 0.5,
            shadowOffset: 0.5
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

function colorChannels(color: string): Uint8ClampedArray {
    const cached = cssColorChannels.get(color);
    if (cached) return cached;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d')!;
    context.fillStyle = color;
    context.fillRect(0, 0, 1, 1);
    const channels = context.getImageData(0, 0, 1, 1).data;
    cssColorChannels.set(color, channels);
    return channels;
}

function tintSpriteSegments(data: Uint8ClampedArray, canvasWidth: number, scale: number, segments: SpriteColorSegment[]): void {
    for (const segment of segments) {
        const color = colorChannels(segment.color);
        const left = Math.round(segment.x * scale);
        const top = Math.round(segment.y * scale);
        for (let y = top; y < top + fontSize * scale; y++) for (let x = left; x < left + fontSize * scale; x++) {
            const offset = (y * canvasWidth + x) * 4;
            data[offset] = Math.round(data[offset] * color[0] / 255);
            data[offset + 1] = Math.round(data[offset + 1] * color[1] / 255);
            data[offset + 2] = Math.round(data[offset + 2] * color[2] / 255);
            data[offset + 3] = Math.round(data[offset + 3] * segment.alpha);
        }
    }
}

function glyphAdvance(
    character: string,
    _context: CanvasRenderingContext2D,
    bitmapFont: Map<string, BitmapGlyph>,
    bold: boolean,
    atlasSprite = false
): number {
    if (atlasSprite) return fontSize + (bold ? 1 : 0);
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
    spriteCharacterIndices: Set<number>,
    shadow?: {
        context: CanvasRenderingContext2D;
        alpha: (index: number) => number;
        offsets: Map<number, number>;
    },
    obfuscatedGlyphs?: Map<number, string[]>
): void {
    Array.from(text).forEach((sourceCharacter, offset) => {
        const characterIndex = start + offset;
        const bold = effect(characterIndex, 'bold');
        if (spriteCharacterIndices.has(characterIndex)) {
            shadow?.offsets.set(characterIndex, 1);
            x += glyphAdvance(sourceCharacter, context, bitmapFont, bold, true);
            return;
        }
        const italic = effect(characterIndex, 'italic');
        const glyphs = effect(characterIndex, 'obfuscated') && sourceCharacter !== ' '
            ? obfuscatedGlyphs?.get(glyphAdvance(sourceCharacter, context, bitmapFont, false))
            : undefined;
        const character = glyphs?.[Math.floor(Math.random() * glyphs.length)] ?? sourceCharacter;
        const glyph = bitmapFont.get(character);
        const drawGlyph = (target: CanvasRenderingContext2D, targetX: number, targetBaseline: number) => {
            target.save();
            if (italic) {
                target.translate(targetX, targetBaseline);
                target.transform(1, 0, -0.25, 1, 0, 0);
            }
            const drawX = italic ? 0 : targetX;
            const drawBaseline = italic ? 0 : targetBaseline;
            if (glyph) {
                const draw = (offset: number) => target.drawImage(
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
                target.fillText(character, drawX, drawBaseline);
                if (bold) target.fillText(character, drawX + 1, drawBaseline);
            }
            target.restore();
        };
        drawGlyph(context, x, baseline);
        if (shadow) {
            const shadowOffset = glyph?.shadowOffset ?? 1;
            shadow.offsets.set(characterIndex, shadowOffset);
            shadow.context.globalAlpha = shadow.alpha(characterIndex);
            drawGlyph(shadow.context, x + shadowOffset, baseline + shadowOffset);
        }
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

function compositeTextShadow(canvas: HTMLCanvasElement, shadowCanvas: HTMLCanvasElement, color: string): void {
    const shadowContext = shadowCanvas.getContext('2d')!;
    shadowContext.save();
    shadowContext.resetTransform();
    shadowContext.globalCompositeOperation = 'source-in';
    shadowContext.globalAlpha = 1;
    shadowContext.fillStyle = color;
    shadowContext.fillRect(0, 0, canvas.width, canvas.height);
    shadowContext.restore();

    const context = canvas.getContext('2d')!;
    context.save();
    context.resetTransform();
    context.globalCompositeOperation = 'destination-over';
    context.drawImage(shadowCanvas, 0, 0);
    context.restore();
}

if (import.meta.env.DEV) {
    const alphaCheck = new Uint8ClampedArray([0, 0, 0, 255, 0, 0, 0, 255]);
    applyTextAlphaSegments(alphaCheck, 2, 1, [{ x: 0, y: 0, width: 1, alpha: 0.5 }]);
    console.assert(alphaCheck[3] === 128 && alphaCheck[7] === 255, 'Page alpha must not erase adjacent text.');
}

class TextDisplayMaterial extends THREE.MeshBasicNodeMaterial {
    declare positionNode: ReturnType<typeof entityVisiblePosition>;
    declare colorNode: ReturnType<typeof texture>;

    constructor(parameters: Record<string, unknown>) {
        super(parameters);
    }

    setupPosition(builder: unknown) {
        const layout = attribute(textDisplayLayoutAttributeName, 'vec4');
        const background = attribute(textDisplayBackgroundAttributeName, 'float');
        const centerX = layout.x.add(layout.y).mul(0.5);
        const backgroundHalfWidth = layout.w.mul(0.5);
        const textX = mix(layout.x, layout.y, positionGeometry.x);
        const backgroundX = mix(centerX.sub(backgroundHalfWidth), centerX.add(backgroundHalfWidth), positionGeometry.x);
        positionLocal.assign(vec3(
            mix(textX, backgroundX, background),
            positionGeometry.y.mul(layout.z),
            background.mul(textBackgroundOffset)
        ));
        return super.setupPosition(builder);
    }
}

function createTextDisplayMaterial(textTexture: THREE.Texture, opaqueBackground: boolean): THREE.MeshBasicNodeMaterial {
    const material = new TextDisplayMaterial({
        map: textTexture,
        transparent: true,
        depthWrite: opaqueBackground,
        alphaTest: 0.1,
        side: THREE.FrontSide,
        toneMapped: false,
        fog: false
    });
    const background = attribute(textDisplayBackgroundAttributeName, 'float');
    material.positionNode = entityVisiblePosition();
    const uvBounds = attribute(textDisplayUvBoundsAttributeName, 'vec4');
    const textUv = vec2(
        mix(uvBounds.x, uvBounds.y, uv().x),
        mix(uvBounds.z, uvBounds.w, uv().y)
    );
    material.colorNode = texture(
        textTexture,
        mix(textUv, attribute(textDisplayBackgroundUvAttributeName, 'vec2'), background)
    );
    return material;
}

export async function createTextDisplayMesh(item: TextDisplayItem): Promise<THREE.InstancedMesh> {
    const options = item.options ?? {};
    const { text, pageEnds, spriteReferences, playerReferences } = prepareTextContent(item.name ?? '', options);
    const spriteCharacterIndices = new Set([...spriteReferences, ...playerReferences].map(sprite => sprite.characterIndex));
    const pageIndexForCharacter = (characterIndex: number) => Math.max(0, pageEnds.findIndex(end => characterIndex < end));
    const pageEffect = (characterIndex: number, key: keyof TextDisplayEffects) => options.pageEffects?.[pageIndexForCharacter(characterIndex)]?.[key] ?? options[key] ?? false;
    const [bitmapFont, unihexSource, loadedSprites, loadedPlayers] = await Promise.all([
        loadBitmapFont(),
        loadUnihexFont(),
        Promise.all(spriteReferences.map(async reference => {
            const source = await loadAtlasSpriteSource(reference.atlas);
            const sprite = source?.sprites.get(reference.sprite);
            return sprite && source ? [reference.characterIndex, { image: source.image, ...sprite }] as const : null;
        })),
        Promise.all(playerReferences.map(async reference => {
            const image = await loadPlayerSkin(reference.username);
            return image ? [reference.characterIndex, { image, hat: reference.hat }] as const : null;
        }))
    ]);
    const atlasSprites = new Map(loadedSprites.filter(sprite => sprite !== null));
    const playerSprites = new Map(loadedPlayers.filter(player => player !== null));
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
        width + glyphAdvance(
            character,
            measureContext,
            activeBitmapFont,
            pageEffect(start + offset, 'bold'),
            spriteCharacterIndices.has(start + offset)
        ), 0);

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
    const renderScale = spriteTextureScale(atlasSprites.values());
    const canvas = document.createElement('canvas');
    canvas.width = renderWidth * renderScale;
    canvas.height = renderHeight * renderScale;

    const context = canvas.getContext('2d', { willReadFrequently: true })!;
    context.imageSmoothingEnabled = false;
    context.scale(renderScale, renderScale);
    context.font = fontStyle;
    context.textBaseline = 'alphabetic';
    context.fillStyle = '#ffffff';
    const textAlpha = Math.round(clampAlpha(options.alpha, 1) * 255);
    context.globalAlpha = 1;
    const spriteCanvas = document.createElement('canvas');
    spriteCanvas.width = canvas.width;
    spriteCanvas.height = canvas.height;
    const spriteContext = spriteCanvas.getContext('2d')!;
    spriteContext.imageSmoothingEnabled = false;
    spriteContext.scale(renderScale, renderScale);
    const spriteColorSegments: SpriteColorSegment[] = [];
    const pageColor = (characterIndex: number) => validColor(options.pageColors?.[pageIndexForCharacter(characterIndex)] ?? options.color, '#ffffff');
    const pageAlpha = (characterIndex: number) => clampAlpha(options.pageAlphas?.[pageIndexForCharacter(characterIndex)] ?? options.alpha, 1);
    const shadowAlpha = clampAlpha(options.shadowAlpha, 0);
    const shadowCanvas = shadowAlpha > 0 ? document.createElement('canvas') : null;
    if (shadowCanvas) {
        shadowCanvas.width = canvas.width;
        shadowCanvas.height = canvas.height;
    }
    const shadowContext = shadowCanvas?.getContext('2d') ?? null;
    if (shadowContext) {
        shadowContext.imageSmoothingEnabled = false;
        shadowContext.scale(renderScale, renderScale);
        shadowContext.font = fontStyle;
        shadowContext.textBaseline = 'alphabetic';
        shadowContext.fillStyle = '#ffffff';
    }
    const shadowOffsets = new Map<number, number>();
    const shadow = shadowContext ? {
        context: shadowContext,
        alpha: (characterIndex: number) => pageAlpha(characterIndex) * shadowAlpha,
        offsets: shadowOffsets
    } : undefined;

    lines.forEach((line, index) => {
        const align = options.pageAligns?.[pageIndexForCharacter(line.start)] ?? options.align ?? 'center';
        const width = widths[index];
        const x = Math.round((horizontalGlyphOverflow + 1 + (align === 'left' ? 0 : align === 'right' ? contentWidth - width : (contentWidth - width) / 2)) * renderScale) / renderScale;
        const baseline = topGlyphOverflow + index * lineHeight + 8;
        drawText(context, line.text, x, baseline, activeBitmapFont, line.start, pageEffect, spriteCharacterIndices, shadow, obfuscatedGlyphs);
        Array.from(line.text).forEach((character, offset) => {
            const characterIndex = line.start + offset;
            const characterX = x + measureRange(Array.from(line.text).slice(0, offset).join(''), line.start);
            const isSprite = spriteCharacterIndices.has(characterIndex);
            const characterWidth = glyphAdvance(character, measureContext, activeBitmapFont, pageEffect(characterIndex, 'bold'), isSprite);
            const shadowOffset = shadowOffsets.get(characterIndex) ?? 1;
            if (shadowContext) shadowContext.globalAlpha = pageAlpha(characterIndex) * shadowAlpha;
            const sprite = atlasSprites.get(characterIndex);
            if (sprite) {
                spriteContext.drawImage(sprite.image, sprite.x, sprite.y, sprite.width, sprite.height, characterX, baseline - fontSize, fontSize, fontSize);
                shadowContext?.drawImage(sprite.image, sprite.x, sprite.y, sprite.width, sprite.height, characterX + shadowOffset, baseline - fontSize + shadowOffset, fontSize, fontSize);
                spriteColorSegments.push({ x: characterX, y: baseline - fontSize, color: pageColor(characterIndex), alpha: pageAlpha(characterIndex) });
            }
            const player = playerSprites.get(characterIndex);
            if (player) {
                spriteContext.drawImage(player.image, 8, 8, 8, 8, characterX, baseline - fontSize, fontSize, fontSize);
                if (player.hat) spriteContext.drawImage(player.image, 40, 8, 8, 8, characterX, baseline - fontSize, fontSize, fontSize);
                shadowContext?.drawImage(player.image, 8, 8, 8, 8, characterX + shadowOffset, baseline - fontSize + shadowOffset, fontSize, fontSize);
                if (player.hat) shadowContext?.drawImage(player.image, 40, 8, 8, 8, characterX + shadowOffset, baseline - fontSize + shadowOffset, fontSize, fontSize);
                spriteColorSegments.push({ x: characterX, y: baseline - fontSize, color: pageColor(characterIndex), alpha: pageAlpha(characterIndex) });
            }
            if (pageEffect(characterIndex, 'underline')) {
                context.fillRect(characterX, baseline + 1, characterWidth, 1);
                shadowContext?.fillRect(characterX + shadowOffset, baseline + 1 + shadowOffset, characterWidth, 1);
            }
            if (pageEffect(characterIndex, 'strikeThrough')) {
                context.fillRect(characterX, baseline - 3.5, characterWidth, 1);
                shadowContext?.fillRect(characterX + shadowOffset, baseline - 3.5 + shadowOffset, characterWidth, 1);
            }
        });
    });
    if (spriteColorSegments.length) {
        const spriteImageData = spriteContext.getImageData(0, 0, spriteCanvas.width, spriteCanvas.height);
        tintSpriteSegments(spriteImageData.data, spriteCanvas.width, renderScale, spriteColorSegments);
        spriteContext.putImageData(spriteImageData, 0, 0);
    }
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
    if (spriteColorSegments.length) context.drawImage(spriteCanvas, 0, 0, renderWidth, renderHeight);
    if (shadowCanvas) compositeTextShadow(canvas, shadowCanvas, validColor(options.shadowColor, '#3f3f3f'));
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
    const addQuad = (): void => {
        const offset = positions.length / 3;
        positions.push(0, 1, 0, 0, 0, 0, 1, 1, 0, 1, 0, 0);
        uvs.push(0, 1, 0, 0, 1, 1, 1, 0);
        indices.push(offset, offset + 1, offset + 2, offset + 1, offset + 3, offset + 2);
    };
    const left = (0.5 - renderWidth / 2) * textPixelSize;
    const right = left + renderWidth * textPixelSize;
    const swatchV = 1 - 0.5 / canvas.height;
    const backgroundSwatchU = 1.5 / canvas.width;

    addQuad();
    addQuad();

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geometry.setAttribute(textDisplayBackgroundAttributeName, new THREE.Float32BufferAttribute([
        1, 1, 1, 1,
        0, 0, 0, 0
    ], 1));
    geometry.setAttribute(textDisplayLayoutAttributeName, new THREE.InstancedBufferAttribute(new Float32Array([
        left,
        right,
        logicalHeight * textPixelSize,
        logicalWidth * textPixelSize
    ]), 4));
    geometry.setAttribute(textDisplayUvBoundsAttributeName, new THREE.InstancedBufferAttribute(new Float32Array([
        0,
        1,
        0,
        1 - topGlyphOverflow / renderHeight
    ]), 4));
    geometry.setAttribute(textDisplayBackgroundUvAttributeName, new THREE.InstancedBufferAttribute(new Float32Array([
        backgroundSwatchU,
        swatchV
    ]), 2));
    geometry.setIndex(indices);
    geometry.boundingBox = new THREE.Box3(
        new THREE.Vector3((0.5 - logicalWidth / 2) * textPixelSize, 0, textBackgroundOffset),
        new THREE.Vector3((0.5 + logicalWidth / 2) * textPixelSize, logicalHeight * textPixelSize, 0)
    );
    geometry.boundingSphere = geometry.boundingBox.getBoundingSphere(new THREE.Sphere());
    if (import.meta.env.DEV) {
        console.assert(geometry.getAttribute(textDisplayBackgroundAttributeName).getX(0) === 1 && geometry.getAttribute(textDisplayBackgroundAttributeName).getX(4) === 0, 'Text display layers must stay separated.');
    }
    setEntityStateAttributes(geometry, 1);

    const material = createTextDisplayMaterial(texture, backgroundAlpha === 1);
    material.visible = text.length > 0;

    // ponytail: live edits stay standalone; static project text is packed by createTextDisplayTemplates.
    return new THREE.InstancedMesh(geometry, material, 1);
}

type TextDisplayAtlasPage = {
    canvas: HTMLCanvasElement;
    context: CanvasRenderingContext2D;
    texture: THREE.CanvasTexture;
    materials: Map<string, THREE.MeshBasicNodeMaterial>;
    nextX: number;
    nextY: number;
    rowHeight: number;
};

type TextDisplayAtlasRegion = {
    page: TextDisplayAtlasPage;
    x: number;
    y: number;
    width: number;
    height: number;
};

const textDisplayAtlasPages: TextDisplayAtlasPage[] = [];
const textDisplayAtlasRegions = new Map<string, TextDisplayAtlasRegion>();

export function resetTextDisplayAtlases(): void {
    textDisplayAtlasPages.length = 0;
    textDisplayAtlasRegions.clear();
}

function createTextDisplayAtlasPage(): TextDisplayAtlasPage {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = textDisplayAtlasSize;
    const context = canvas.getContext('2d', { willReadFrequently: true })!;
    context.imageSmoothingEnabled = false;
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.magFilter = THREE.NearestFilter;
    texture.minFilter = THREE.NearestFilter;
    texture.generateMipmaps = false;
    const page = { canvas, context, texture, materials: new Map(), nextX: 0, nextY: 0, rowHeight: 0 };
    textDisplayAtlasPages.push(page);
    return page;
}

function placeTextDisplayAtlasRegion(key: string, source: HTMLCanvasElement, replace: boolean): TextDisplayAtlasRegion | null {
    const cached = textDisplayAtlasRegions.get(key);
    if (cached && source.width <= cached.width && source.height <= cached.height) {
        if (replace) {
            cached.page.context.clearRect(cached.x, cached.y, cached.width, cached.height);
            cached.page.context.drawImage(source, cached.x, cached.y);
            cached.page.texture.needsUpdate = true;
        }
        return cached;
    }
    if (source.width > textDisplayAtlasSize || source.height > textDisplayAtlasSize) return null;
    const width = replace ? 2 ** Math.ceil(Math.log2(source.width)) : source.width;
    const height = replace ? 2 ** Math.ceil(Math.log2(source.height)) : source.height;

    let page: TextDisplayAtlasPage | undefined;
    let x = 0;
    let y = 0;
    for (const candidate of textDisplayAtlasPages) {
        x = candidate.nextX;
        y = candidate.nextY;
        if (x + width > textDisplayAtlasSize) {
            x = 0;
            y += candidate.rowHeight;
        }
        if (y + height <= textDisplayAtlasSize) {
            page = candidate;
            break;
        }
    }
    if (!page) {
        page = createTextDisplayAtlasPage();
        x = y = 0;
    }
    if (x === 0 && y !== page.nextY) page.rowHeight = 0;
    page.context.drawImage(source, x, y);
    page.texture.needsUpdate = true;
    page.nextX = x + width;
    page.nextY = y;
    page.rowHeight = Math.max(page.rowHeight, height);
    const region = { page, x, y, width, height };
    textDisplayAtlasRegions.set(key, region);
    if (import.meta.env.DEV) console.assert(x + width <= textDisplayAtlasSize && y + height <= textDisplayAtlasSize, 'Text display atlas region overflowed.');
    return region;
}

function getTextDisplayAtlasMaterial(region: TextDisplayAtlasRegion, source: THREE.MeshBasicNodeMaterial): THREE.MeshBasicNodeMaterial {
    const materialKey = `${source.depthWrite}:${source.visible}`;
    let material = region.page.materials.get(materialKey);
    if (!material) {
        material = createTextDisplayMaterial(region.page.texture, source.depthWrite);
        material.visible = source.visible;
        material.userData.textDisplayAtlas = true;
        region.page.materials.set(materialKey, material);
    }
    return material;
}

export async function createTextDisplayTemplates(items: TextDisplayItem[]): Promise<Map<string, THREE.InstancedMesh>> {
    const uniqueItems = new Map(items.map(item => [getTextDisplayTemplateKey(item), item]));
    const templates = new Map(await Promise.all(Array.from(uniqueItems, async ([key, item]) => [
        key,
        await createTextDisplayMesh(item)
    ] as const)));
    for (const [key, mesh] of templates) {
        const material = mesh.material as THREE.MeshBasicNodeMaterial;
        const canvas = material.map?.image as HTMLCanvasElement | undefined;
        if (!canvas) continue;
        const atlasKey = uniqueItems.get(key)?.atlasKey;
        const region = placeTextDisplayAtlasRegion(atlasKey ?? key, canvas, !!atlasKey);
        if (!region) continue;
        const scaleX = canvas.width / region.page.canvas.width;
        const scaleY = canvas.height / region.page.canvas.height;
        const offsetX = region.x / region.page.canvas.width;
        const offsetY = (region.page.canvas.height - region.y - canvas.height) / region.page.canvas.height;
        const uvBounds = mesh.geometry.getAttribute(textDisplayUvBoundsAttributeName);
        uvBounds.setXYZW(
            0,
            uvBounds.getX(0) * scaleX + offsetX,
            uvBounds.getY(0) * scaleX + offsetX,
            uvBounds.getZ(0) * scaleY + offsetY,
            uvBounds.getW(0) * scaleY + offsetY
        );
        const backgroundUv = mesh.geometry.getAttribute(textDisplayBackgroundUvAttributeName);
        backgroundUv.setXY(
            0,
            backgroundUv.getX(0) * scaleX + offsetX,
            backgroundUv.getY(0) * scaleY + offsetY
        );
        mesh.material = getTextDisplayAtlasMaterial(region, material);
        material.map?.dispose();
        material.dispose();
    }
    return templates;
}

if (import.meta.env.DEV) {
    console.assert(spriteTextureScale([{ width: 32, height: 32 }]) === 4, 'Sprite textures must retain their source resolution.');
    const spriteContent = prepareTextContent('', {
        pages: ['A', 'block/stone', 'B'],
        pageTypes: ['text', 'sprite', 'text'],
        pageAtlases: ['', 'minecraft:blocks', '']
    });
    console.assert(
        spriteContent.text === `A${objectReplacementCharacter}B`
        && spriteContent.pageEnds.join(',') === '1,2,3'
        && spriteContent.spriteReferences[0]?.characterIndex === 1
        && spriteContent.spriteReferences[0]?.sprite === 'minecraft:block/stone',
        'Minecraft atlas sprites must occupy one text glyph.'
    );
    const playerContent = prepareTextContent('', { pages: ['Pangch'], pageTypes: ['player'] });
    console.assert(
        playerContent.text === objectReplacementCharacter && playerContent.playerReferences[0]?.hat,
        'Minecraft player heads must occupy one text glyph with the second layer enabled by default.'
    );
    console.assert(
        prepareTextContent('', { pages: ['translation.key'], pageTypes: ['translate'], pageExtraValues: [{ fallback: '대체 문자' }] }).text === '대체 문자',
        'Translated text must render its fallback.'
    );
    console.assert(
        prepareTextContent('', {
            pages: ['A', 'Inventory[0].tag', 'B'],
            pageTypes: ['text', 'nbt', 'text'],
            pageExtraValues: [{}, { preview: '미리보기' }, {}]
        }).text === 'A미리보기B',
        'NBT content must render its preview instead of its source path.'
    );
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
    const shadowCheck = document.createElement('canvas');
    const shadowLayer = document.createElement('canvas');
    shadowCheck.width = shadowCheck.height = shadowLayer.width = shadowLayer.height = 2;
    shadowLayer.getContext('2d')!.fillRect(1, 1, 1, 1);
    compositeTextShadow(shadowCheck, shadowLayer, '#123456');
    console.assert(shadowCheck.getContext('2d')!.getImageData(1, 1, 1, 1).data.slice(0, 3).join(',') === '18,52,86', 'Minecraft text shadow changed.');
}
