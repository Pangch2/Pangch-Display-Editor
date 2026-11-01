export type BitmapGlyph = {
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

export type TextGlyphDraw = {
    glyph: BitmapGlyph;
    characterIndex: number;
    x: number;
    baseline: number;
    bold: boolean;
    italic: boolean;
};

export type TextGlyphQuad = TextGlyphDraw & {
    color: string;
    alpha: number;
    shadowColor: string;
    shadowAlpha: number;
};

export function appendTextGlyphQuads(
    source: HTMLCanvasElement,
    glyphs: TextGlyphQuad[],
    layout: { width: number; height: number; top: number; scale: number; pixelSize: number },
    positions: number[],
    uvs: number[],
    indices: number[]
): HTMLCanvasElement {
    const width = Math.max(source.width, ...glyphs.map(({ glyph }) => glyph.sourceWidth + 2));
    type Tile = { glyph: BitmapGlyph; color: string; alpha: number; x: number; y: number };
    const tiles = new Map<BitmapGlyph, Map<string, Tile>>();
    let nextX = 0;
    let nextY = source.height;
    let rowHeight = 0;
    const tileFor = (glyph: BitmapGlyph, color: string, alpha: number): Tile => {
        let styles = tiles.get(glyph);
        if (!styles) tiles.set(glyph, styles = new Map());
        const key = `${color}:${alpha}`;
        const cached = styles.get(key);
        if (cached) return cached;
        if (nextX + glyph.sourceWidth + 2 > width) {
            nextX = 0;
            nextY += rowHeight;
            rowHeight = 0;
        }
        const tile = { glyph, color, alpha, x: nextX + 1, y: nextY + 1 };
        styles.set(key, tile);
        nextX += glyph.sourceWidth + 2;
        rowHeight = Math.max(rowHeight, glyph.sourceHeight + 2);
        return tile;
    };

    // Keep the existing sprite/effect layer above the unmodified glyph tiles.
    for (let i = 0; i < uvs.length; i += 2) {
        uvs[i] *= source.width;
        uvs[i + 1] = source.height - uvs[i + 1] * (source.height - layout.top * layout.scale);
    }
    const addGlyph = (draw: TextGlyphQuad, tile: Tile, x: number, baseline: number, depth: number): void => {
        const { glyph, bold, italic } = draw;
        const top = 7 - glyph.ascent;
        const bottom = top + glyph.sourceHeight * glyph.scale;
        const thickness = bold ? 0.1 : 0;
        const shearTop = italic ? 1 - 0.25 * top : 0;
        const shearBottom = italic ? 1 - 0.25 * bottom : 0;
        const left = x - thickness;
        const right = x + glyph.sourceWidth * glyph.scale + thickness;
        const yTop = layout.height + layout.top - baseline + glyph.ascent + thickness;
        const yBottom = yTop - glyph.sourceHeight * glyph.scale - thickness * 2;
        const vertex = positions.length / 3;
        positions.push(
            (left + shearTop) / layout.width, yTop / layout.height, depth * layout.pixelSize,
            (left + shearBottom) / layout.width, yBottom / layout.height, depth * layout.pixelSize,
            (right + shearTop) / layout.width, yTop / layout.height, depth * layout.pixelSize,
            (right + shearBottom) / layout.width, yBottom / layout.height, depth * layout.pixelSize
        );
        uvs.push(tile.x, tile.y, tile.x, tile.y + glyph.sourceHeight,
            tile.x + glyph.sourceWidth, tile.y, tile.x + glyph.sourceWidth, tile.y + glyph.sourceHeight);
        indices.push(vertex, vertex + 1, vertex + 2, vertex + 1, vertex + 3, vertex + 2);
    };
    for (const draw of glyphs) {
        const { glyph, x, baseline, bold } = draw;
        if (draw.shadowAlpha > 0) {
            const shadow = tileFor(glyph, draw.shadowColor, draw.shadowAlpha);
            addGlyph(draw, shadow, x + glyph.shadowOffset, baseline + glyph.shadowOffset, 0);
            if (bold) addGlyph(draw, shadow, x + glyph.shadowOffset + glyph.boldOffset, baseline + glyph.shadowOffset, 0.001);
        }
        const tile = tileFor(glyph, draw.color, draw.alpha);
        const depth = draw.shadowAlpha > 0 ? 0.03 : 0;
        addGlyph(draw, tile, x, baseline, depth);
        if (bold) addGlyph(draw, tile, x + glyph.boldOffset, baseline, depth + 0.001);
    }
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = nextY + rowHeight;
    const context = canvas.getContext('2d')!;
    context.imageSmoothingEnabled = false;
    context.drawImage(source, 0, 0);
    for (const styles of tiles.values()) for (const tile of styles.values()) {
        const { glyph, x, y } = tile;
        context.save();
        context.beginPath();
        context.rect(x, y, glyph.sourceWidth, glyph.sourceHeight);
        context.clip();
        context.drawImage(glyph.image, glyph.sourceX, glyph.sourceY, glyph.sourceWidth, glyph.sourceHeight,
            x, y, glyph.sourceWidth, glyph.sourceHeight);
        context.globalCompositeOperation = 'source-in';
        context.globalAlpha = tile.alpha;
        context.fillStyle = tile.color;
        context.fillRect(x, y, glyph.sourceWidth, glyph.sourceHeight);
        context.restore();
    }
    for (let i = 0; i < uvs.length; i += 2) {
        uvs[i] /= canvas.width;
        uvs[i + 1] = 1 - uvs[i + 1] / canvas.height;
    }
    return canvas;
}
