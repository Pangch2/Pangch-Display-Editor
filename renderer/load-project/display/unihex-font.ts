export function findUnihexGlyph(source: string, codepoint: number): string | undefined {
    // The bundled HEX file is sorted by code point, so no per-glyph index is needed.
    let start = 0;
    let end = source.length;
    while (start < end) {
        const middle = Math.floor((start + end) / 2);
        const lineStart = source.lastIndexOf('\n', middle - 1) + 1;
        const separator = source.indexOf(':', lineStart);
        const newline = source.indexOf('\n', separator);
        const lineEnd = newline < 0 ? source.length : newline;
        const value = Number.parseInt(source.slice(lineStart, separator), 16);
        if (value === codepoint) return source.slice(separator + 1, lineEnd).trimEnd();
        if (value < codepoint) start = lineEnd + 1;
        else end = lineStart;
    }
    return undefined;
}
