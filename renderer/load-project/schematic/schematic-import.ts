import { MathUtils } from 'three/webgpu';
import { gunzipSync } from 'fflate';
import { displayNode } from '../mcfunction/mcfunction-import';
import type { PdeNode, PdeProject } from '../../save/pde-format';

type Nbt = number | bigint | string | Uint8Array | Int32Array | BigInt64Array | Nbt[] | { [key: string]: Nbt };
type Compound = { [key: string]: Nbt };

export const schematicFilePattern = /\.(schem|schematic)$/i;
const airBlocks = new Set(['air', 'cave_air', 'void_air']);
const decoder = new TextDecoder();

// shortcut: Java's modified UTF-8 is decoded as UTF-8; only NUL/supplementary characters in names differ.
export function readNbt(bytes: Uint8Array): Compound {
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = gunzipSync(bytes);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = 0;
    const take = (size: number) => {
        if (size < 0 || offset + size > bytes.length) throw new Error('NBT 데이터가 잘렸습니다.');
        const start = offset; offset += size; return start;
    };
    const string = () => { const size = view.getUint16(take(2)); return decoder.decode(bytes.subarray(take(size), offset)); };
    const count = () => view.getInt32(take(4));
    const value = (type: number): Nbt => {
        switch (type) {
            case 1: return view.getInt8(take(1));
            case 2: return view.getInt16(take(2));
            case 3: return view.getInt32(take(4));
            case 4: return view.getBigInt64(take(8));
            case 5: return view.getFloat32(take(4));
            case 6: return view.getFloat64(take(8));
            case 7: { const size = count(); return bytes.subarray(take(size), offset); }
            case 8: return string();
            case 9: {
                const itemType = view.getUint8(take(1)), size = count(), list: Nbt[] = [];
                for (let i = 0; i < size; i++) list.push(value(itemType));
                return list;
            }
            case 10: {
                const result: Compound = {};
                for (let tag = view.getUint8(take(1)); tag; tag = view.getUint8(take(1))) result[string()] = value(tag);
                return result;
            }
            case 11: { const size = count(), start = take(size * 4); return Int32Array.from({ length: size }, (_, i) => view.getInt32(start + i * 4)); }
            case 12: { const size = count(), start = take(size * 8); return BigInt64Array.from({ length: size }, (_, i) => view.getBigInt64(start + i * 8)); }
            default: throw new Error(`알 수 없는 NBT 태그 ${type}`);
        }
    };
    if (view.getUint8(take(1)) !== 10) throw new Error('NBT 루트가 컴파운드가 아닙니다.');
    string();
    return value(10) as Compound;
}

const isCompound = (value: Nbt | undefined): value is Compound => !!value && typeof value === 'object'
    && !Array.isArray(value) && !ArrayBuffer.isView(value);

function blockState(state: string): Compound | undefined {
    const match = /^([^[\]]+)(?:\[([^\]]*)\])?$/.exec(state);
    if (!match) return undefined;
    const Properties: Compound = {};
    for (const pair of match[2]?.split(',') ?? []) {
        const [key, value] = pair.split('=');
        if (key && value !== undefined) Properties[key.trim()] = value.trim();
    }
    return { Name: match[1].trim(), Properties };
}

/** Sponge schematic v1–v3 (WorldEdit .schem) → PDE project with every block inside a group named after the file. */
export async function parseSchematic(bytes: Uint8Array, name: string): Promise<PdeProject> {
    const root = readNbt(bytes);
    const schematic = isCompound(root.Schematic) ? root.Schematic : root;
    if (schematic.Blocks instanceof Uint8Array || schematic.Materials !== undefined) throw new Error(`${name}: 구형 MCEdit .schematic(숫자 ID) 형식은 지원하지 않습니다.`);
    const blocks = isCompound(schematic.Blocks) ? schematic.Blocks : schematic;
    const palette = blocks.Palette, data = blocks.Data ?? blocks.BlockData;
    const [width, height, length] = [schematic.Width, schematic.Height, schematic.Length].map(value => typeof value === 'number' ? value & 0xffff : -1);
    if (!isCompound(palette) || !(data instanceof Uint8Array) || width < 0 || height < 0 || length < 0) throw new Error(`${name}: Sponge 스키매틱 형식이 아닙니다.`);
    const templates: (PdeNode | undefined)[] = [], skipped: string[] = [];
    for (const [state, index] of Object.entries(palette)) {
        const nbt = blockState(state);
        if (typeof index !== 'number' || !nbt) { skipped.push(state); continue; }
        const id = (nbt.Name as string).replace(/^minecraft:/, '');
        if (airBlocks.has(id)) continue;
        // One unconvertible block state must not discard the rest of the build.
        try { templates[index] = await displayNode('block_display', { block_state: nbt } as Parameters<typeof displayNode>[1]); }
        catch (error) { skipped.push(`${state} · ${error instanceof Error ? error.message : String(error)}`); }
    }
    if (skipped.length) window.alert(`${name}: 가져오기에서 제외한 블록:\n` + skipped.join('\n'));
    const children: PdeNode[] = [], volume = width * height * length, area = width * length;
    let offset = 0;
    for (let index = 0; index < volume; index++) {
        let paletteIndex = 0, shift = 0, byte: number;
        do {
            if (offset >= data.length) throw new Error(`${name}: 블록 데이터가 잘렸습니다.`);
            byte = data[offset++]; paletteIndex |= (byte & 0x7f) << shift; shift += 7;
        } while (byte & 0x80);
        const template = templates[paletteIndex];
        if (!template) continue;
        const transforms = template.transforms.slice();
        transforms[3] += index % width; transforms[7] += Math.floor(index / area); transforms[11] += Math.floor(index / width) % length;
        children.push({ ...template, uuid: MathUtils.generateUUID(), transforms });
    }
    // shortcut: block entities (sign text, chest contents) and entities are not imported; display entities cannot show them.
    return { pdeFormatVersion: 1, name, mainNBT: '', nbt: '', children: [{ uuid: MathUtils.generateUUID(), name, isCollection: true,
        transforms: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], children }],
        editorState: { version: 1, objects: [], groups: [], hiddenObjectUuids: [], hiddenGroupIds: [], objectMirrorPairs: [], groupMirrorPairs: [] } };
}
