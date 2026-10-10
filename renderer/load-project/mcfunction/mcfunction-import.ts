import { MathUtils, Matrix4, Quaternion, Vector3 } from 'three/webgpu';
import { gzipSync, strToU8 } from 'fflate';
import { blockExportParts, itemExportCorrection } from '../../export/summon-command';
import { parseSnbt, snbtNumber, SnbtLiteral, stringifySnbt, type SnbtValue } from '../../export/snbt';
import { encodeProjectArchive, type PdeNode, type PdeProject } from '../../save/pde-format';
import { defaultTextDisplayOptions, type TextDisplayOptions, type TextDisplayContentType } from '../display/text-display';
import { mainThreadAssetProvider } from '../pbde/pbde-assets';
import { buildBlockIconTemplate, buildItemIconModels } from '../scene/scene-parser';
import { getAssetBytes } from '../../asset-manager';
import type { SpriteAtlasManifest } from '../scene/sprite-atlas';

type Compound = { [key: string]: SnbtValue };
export type McfunctionIssue = { line: number; message: string };
const compound = (value: SnbtValue | undefined): value is Compound => !!value && typeof value === 'object'
    && !Array.isArray(value) && !(value instanceof SnbtLiteral);
const resourceId = (value: SnbtValue | undefined): string | undefined => typeof value === 'string'
    && /^(?:[a-z0-9_.-]+:)?[a-z0-9_./-]+$/.test(value) ? value.replace(/^minecraft:/, '') : undefined;
const displayTypes = ['none', 'thirdperson_lefthand', 'thirdperson_righthand', 'firstperson_lefthand',
    'firstperson_righthand', 'head', 'gui', 'ground', 'fixed', 'on_shelf'];
const effects = { bold: 'bold', italic: 'italic', underlined: 'underline', strikethrough: 'strikeThrough', obfuscated: 'obfuscated' } as const;
const namedColors = Object.fromEntries(['black:000000', 'dark_blue:0000aa', 'dark_green:00aa00', 'dark_aqua:00aaaa',
    'dark_red:aa0000', 'dark_purple:aa00aa', 'gold:ffaa00', 'gray:aaaaaa', 'dark_gray:555555', 'blue:5555ff',
    'green:55ff55', 'aqua:55ffff', 'red:ff5555', 'light_purple:ff55ff', 'yellow:ffff55', 'white:ffffff'].map(value => value.split(':')));

function numbers(value: SnbtValue | undefined, size: number): number[] | undefined {
    if (!Array.isArray(value) || value.length !== size) return undefined;
    const result = value.map(snbtNumber);
    return result.every(value => value !== undefined && Number.isFinite(Math.fround(value))) ? result : undefined;
}

function prune(parent: Compound, key: string): void {
    if (compound(parent[key]) && !Object.keys(parent[key]).length) delete parent[key];
}

function rotation(value: SnbtValue | undefined): Quaternion | undefined {
    const vector = numbers(value, 4);
    if (vector) {
        const result = new Quaternion().fromArray(vector);
        return result.lengthSq() > 0 ? result.normalize() : undefined;
    }
    if (!compound(value) || Object.keys(value).some(key => key !== 'axis' && key !== 'angle')) return undefined;
    const axis = numbers(value.axis, 3), angle = snbtNumber(value.angle);
    return axis && angle !== undefined && Number.isFinite(angle) && new Vector3().fromArray(axis).lengthSq() > 0
        ? new Quaternion().setFromAxisAngle(new Vector3().fromArray(axis).normalize(), angle) : undefined;
}

function transformation(nbt: Compound): Matrix4 {
    const value = nbt.transformation;
    const matrix = numbers(value, 16);
    if (matrix && matrix[12] === 0 && matrix[13] === 0 && matrix[14] === 0 && matrix[15] === 1) {
        delete nbt.transformation;
        return new Matrix4().fromArray(matrix).transpose();
    }
    if (!compound(value)) return new Matrix4();
    const translation = numbers(value.translation, 3), scale = numbers(value.scale, 3);
    const left = rotation(value.left_rotation), right = rotation(value.right_rotation);
    if (translation) delete value.translation;
    if (scale) delete value.scale;
    if (left) delete value.left_rotation;
    if (right) delete value.right_rotation;
    prune(nbt, 'transformation');
    return new Matrix4().compose(new Vector3().fromArray(translation ?? [0, 0, 0]), left ?? new Quaternion(),
        new Vector3().fromArray(scale ?? [1, 1, 1])).multiply(new Matrix4().makeRotationFromQuaternion(right ?? new Quaternion()));
}

const color = (value: SnbtValue | undefined): string | undefined => typeof value === 'string'
    ? /^#[\da-f]{6}$/i.test(value) ? value : typeof namedColors[value] === 'string' ? '#' + namedColors[value] : undefined : undefined;
const boolean = (value: SnbtValue | undefined): boolean | undefined => {
    const number = snbtNumber(value);
    return number === 0 ? false : number === 1 ? true : undefined;
};
const argb = (value: number) => ({ color: '#' + (value & 0xffffff).toString(16).padStart(6, '0'), alpha: (value >>> 24) / 255 });

async function textOptions(nbt: Compound): Promise<{ name: string; options: TextDisplayOptions }> {
    const options: TextDisplayOptions = { ...defaultTextDisplayOptions, pages: [], pageColors: [], pageEffects: [],
        pageTypes: [], pageExtraValues: [], pageAtlases: [], pageHats: [], pageShadowColors: [], pageShadowAlphas: [] };
    let value = nbt.text ?? '';
    if (typeof value === 'string' && /^[\s]*[\[{"]/.test(value)) {
        try { value = parseSnbt(value); } catch { /* Plain text may start with punctuation. */ }
    }
    let converted = true;
    const fonts = new Set<string>();
    const visit = (value: SnbtValue, inherited: Compound = {}): void => {
        if (Array.isArray(value)) {
            const first = compound(value[0]) ? { ...inherited, ...value[0] } : inherited;
            for (let index = 0; index < value.length; index++) visit(value[index], index ? first : inherited);
            return;
        }
        const own: Compound = typeof value === 'string' ? { text: value } : compound(value) ? value : {};
        const entry = { ...inherited, ...own };
        const types = ['text', 'sprite', 'player', 'translate', 'keybind', 'score', 'selector', 'nbt'] as TextDisplayContentType[];
        const present = types.filter(type => own[type] !== undefined);
        const type = present[0] ?? 'text';
        const content = own[type];
        let page = typeof content === 'string' ? content : '';
        const extra: NonNullable<TextDisplayOptions['pageExtraValues']>[number] = {};
        const known = new Set<string>([type, 'extra', 'color', 'font', 'shadow_color', ...Object.keys(effects)]);
        if (type === 'score' && compound(content) && typeof content.name === 'string' && typeof content.objective === 'string') {
            page = content.name; extra.scoreboard = content.objective;
            if (Object.keys(content).some(key => key !== 'name' && key !== 'objective')) converted = false;
        } else if (typeof content !== 'string') converted = false;
        if (present.length !== 1) converted = false;
        if (type === 'translate' && typeof own.fallback === 'string') { extra.fallback = own.fallback; known.add('fallback'); }
        if ((type === 'selector' || type === 'nbt') && typeof own.separator === 'string') { extra.separator = own.separator; known.add('separator'); }
        if (type === 'nbt') {
            const sources = ['entity', 'block', 'storage'] as const;
            const source = sources.find(key => typeof own[key] === 'string');
            if (source) { extra.nbtSource = source; extra[source] = own[source] as string; known.add(source); }
            else converted = false;
            if (boolean(own.interpret) !== undefined) { extra.interpret = boolean(own.interpret); known.add('interpret'); }
        }
        if (type === 'sprite') {
            known.add('atlas');
            if (own.atlas !== undefined && !resourceId(own.atlas)) converted = false;
        }
        if (type === 'player') {
            known.add('hat');
            if (own.hat !== undefined && boolean(own.hat) === undefined) converted = false;
        }
        if (Object.keys(own).some(key => !known.has(key))) converted = false;
        const pageColor = color(entry.color);
        if (entry.color !== undefined && !pageColor) converted = false;
        const pageEffects: NonNullable<TextDisplayOptions['pageEffects']>[number] = {};
        for (const [nbtKey, editorKey] of Object.entries(effects)) {
            const enabled = boolean(entry[nbtKey]);
            if (entry[nbtKey] !== undefined && enabled === undefined) converted = false;
            pageEffects[editorKey] = enabled ?? false;
        }
        const font = resourceId(entry.font);
        if (entry.font !== undefined && !font) converted = false;
        fonts.add(font ?? 'default');
        const shadow = snbtNumber(entry.shadow_color);
        if (entry.shadow_color !== undefined && (shadow === undefined || !Number.isInteger(shadow) || shadow < -2147483648 || shadow > 2147483647)) converted = false;
        const shadowStyle = shadow === undefined ? undefined : argb(shadow);
        options.pages.push(page);
        options.pageColors.push(pageColor ?? '#ffffff');
        options.pageEffects.push(pageEffects);
        options.pageTypes.push(type);
        options.pageExtraValues.push(extra);
        options.pageAtlases.push(resourceId(own.atlas) ?? 'blocks');
        options.pageHats.push(boolean(own.hat) ?? true);
        options.pageShadowColors.push(shadowStyle?.color ?? '#3f3f3f');
        options.pageShadowAlphas.push(shadowStyle?.alpha ?? 0);
        if (own.extra !== undefined) {
            if (Array.isArray(own.extra)) for (const child of own.extra) visit(child, entry);
            else converted = false;
        }
    };
    visit(value);
    for (const [index, page] of options.pages.entries()) {
        if (options.pageTypes[index] !== 'sprite' || page !== '') continue;
        const atlas = options.pageAtlases[index];
        const name = /^(?:minecraft:)?([a-z0-9_]+)$/u.exec(atlas)?.[1];
        if (!name) continue;
        try {
            const manifest = JSON.parse(new TextDecoder().decode(await getAssetBytes(`sprite-atlases/${name}.json`, false))) as SpriteAtlasManifest;
            options.pages[index] = manifest.sprites.filter(sprite => typeof sprite.id === 'string'
                && [sprite.x, sprite.y, sprite.width, sprite.height].every(Number.isFinite)
                && sprite.width > 0 && sprite.height > 0).sort((left, right) => left.id.localeCompare(right.id))[0]?.id ?? '';
        } catch (error) {
            console.warn(`Failed to resolve empty sprite in atlas: ${atlas}`, error);
        }
    }
    if (fonts.size === 1) {
        const font = [...fonts][0]; options.font = font.includes(':') ? font : 'minecraft:' + font;
    }
    else converted = false;
    if (converted) delete nbt.text;
    // shortcut: unsupported component trees retain their complete text NBT; add richer editor fields when previews need them.
    const width = snbtNumber(nbt.line_width);
    if (width !== undefined && Number.isInteger(width) && width > 0 && width % 4 === 0) { options.lineLength = width / 4; delete nbt.line_width; }
    const opacity = snbtNumber(nbt.text_opacity);
    if (opacity !== undefined && Number.isInteger(opacity) && opacity >= -128 && opacity <= 255) { options.alpha = (opacity & 255) / 255; delete nbt.text_opacity; }
    const background = snbtNumber(nbt.background);
    if (background !== undefined && Number.isInteger(background) && background >= -2147483648 && background <= 2147483647) {
        const style = argb(background); options.backgroundColor = style.color; options.backgroundAlpha = style.alpha; delete nbt.background;
    }
    if (['left', 'center', 'right'].includes(nbt.alignment as string)) { options.align = nbt.alignment as TextDisplayOptions['align']; delete nbt.alignment; }
    if (boolean(nbt.shadow) === true && !options.pageShadowAlphas.some(value => value > 0)) {
        options.shadowAlpha = 1; options.pageShadowAlphas = options.pages.map(() => 1);
    }
    if (boolean(nbt.shadow) === true || (boolean(nbt.shadow) === false && !options.pageShadowAlphas.some(value => value > 0))) delete nbt.shadow;
    return { name: options.pages.join(''), options };
}

function headTexture(item: Compound): string | undefined {
    if (!compound(item.components)) return undefined;
    const components = item.components;
    const key = components.profile !== undefined ? 'profile' : 'minecraft:profile';
    const profile = components[key];
    if (!compound(profile) || !Array.isArray(profile.properties)) return undefined;
    const property = profile.properties.find(value => compound(value) && value.name === 'textures' && typeof value.value === 'string') as Compound | undefined;
    if (!property) return undefined;
    let payload: Compound;
    try { payload = JSON.parse(atob(property.value as string)); } catch { return undefined; }
    const textures = compound(payload) && compound(payload.textures) ? payload.textures : undefined;
    const skin = textures && compound(textures.SKIN) ? textures.SKIN : undefined;
    const url = skin?.url;
    if (typeof url !== 'string' || !/^https?:\/\/textures\.minecraft\.net\/texture\/[\da-f]+$/i.test(url)) return undefined;
    // Keep signatures, profile identity and other texture payload details unless the whole profile is represented.
    if (Object.keys(profile).length === 1 && profile.properties.length === 1 && Object.keys(property).every(key => key === 'name' || key === 'value')
        && Object.keys(payload).length === 1 && Object.keys(textures!).length === 1 && Object.keys(skin!).length === 1) delete components[key];
    prune(item, 'components');
    return url.replace(/^http:/, 'https:');
}

export type PreparedSceneFile = { file: File; expectedObjects?: number };

export async function prepareMcfunctionFiles(files: File[]): Promise<PreparedSceneFile[]> {
    const imports: PreparedSceneFile[] = [], issues: string[] = [];
    for (const file of files) {
        if (!/\.mcfunction$/i.test(file.name)) { imports.push({ file }); continue; }
        const result = await parseMcfunction(await file.text(), file.name.replace(/\.mcfunction$/i, ''));
        issues.push(...result.issues.map(issue => `${file.name}:${issue.line} · ${issue.message}`));
        if (result.project.children.length) imports.push({
            // Import transport keeps precision; save-time rounding applies only when the user saves.
            file: new File([gzipSync(encodeProjectArchive(strToU8(JSON.stringify([result.project]))))], 'mcfunction.pbde'),
            expectedObjects: result.project.children[0].children.length
        });
    }
    if (issues.length) window.alert('가져오기에서 제외한 summon:\n' + issues.join('\n'));
    return imports;
}

async function displayNode(type: string, nbt: Compound): Promise<PdeNode | undefined> {
    const node: PdeNode = { uuid: MathUtils.generateUUID(), name: '', transforms: [] };
    let correction = new Matrix4();
    if (type === 'block_display') {
        const state = nbt.block_state;
        if (state === undefined) return undefined;
        if (!compound(state)) throw new Error('block_state 컴파운드가 필요합니다.');
        const idKey = state.id !== undefined ? 'id' : 'Name';
        const id = resourceId(state[idKey]);
        if (!id) throw new Error('블록 ID가 올바르지 않습니다.');
        if (id === 'air') return undefined;
        delete state[idKey];
        const propsKey = state.properties !== undefined ? 'properties' : 'Properties';
        const props: Record<string, string> = Object.create(null);
        const bed = /^(white|orange|magenta|light_blue|yellow|lime|pink|gray|light_gray|cyan|purple|blue|brown|green|red|black)_bed$/.test(id);
        const rawProps = state[propsKey];
        if (compound(rawProps)) {
            for (const [key, value] of Object.entries(rawProps)) if (/^[a-z0-9_]+$/.test(key) && typeof value === 'string' && /^[a-z0-9_]+$/.test(value)) {
                props[key] = value;
                if (!bed || key !== 'part') delete rawProps[key];
            }
            prune(state, propsKey);
        }
        // A Minecraft bed display is one half; the editor's ordinary bed is a whole model.
        if (bed && props.part === undefined && (!compound(rawProps) || rawProps.part === undefined)) {
            props.part = 'foot';
            state[propsKey] = { ...(compound(state[propsKey]) ? state[propsKey] : {}), part: 'foot' };
        }
        if (bed && propsKey === 'Properties' && (props.part === 'head' || props.part === 'foot')) {
            if (compound(state.Properties)) { delete state.Properties.part; prune(state, 'Properties'); }
            state.properties = { ...(compound(state.properties) ? state.properties : {}), part: props.part };
        }
        node.name = id + (Object.keys(props).length ? '[' + Object.entries(props).map(([key, value]) => `${key}=${value}`).join(',') + ']' : '');
        node.isBlockDisplay = true;
        if (/^(?:(?:skeleton|wither_skeleton)_(?:wall_)?skull|(?:zombie|creeper|dragon|piglin)_(?:wall_)?head|(?:white|orange|magenta|light_blue|yellow|lime|pink|gray|light_gray|cyan|purple|blue|brown|green|red|black)_(?:bed|banner)|(?:.*_)?chest)$/.test(id)) {
            const template = await buildBlockIconTemplate(node.name, mainThreadAssetProvider);
            if (!template?.models.length) throw new Error('블록 모델 보정을 불러오지 못했습니다.');
            const parts = blockExportParts(id, props, new Matrix4().fromArray(template.models[0].modelMatrix));
            correction = (parts.find(part => part.properties.part === props.part) ?? parts[0]).matrix;
        }
        prune(nbt, 'block_state');
    } else if (type === 'item_display') {
        const item = nbt.item;
        if (item === undefined) return undefined;
        if (!compound(item)) throw new Error('item 컴파운드가 필요합니다.');
        const id = resourceId(item.id);
        if (!id) throw new Error('아이템 ID가 올바르지 않습니다.');
        if (id === 'air') return undefined;
        delete item.id;
        const display = displayTypes.includes(nbt.item_display as string) ? nbt.item_display as string : 'none';
        if (displayTypes.includes(nbt.item_display as string)) delete nbt.item_display;
        node.name = `${id}[display=${display}]`;
        node.isItemDisplay = true;
        if (id === 'player_head') node.paintTexture = headTexture(item);
        let editorModel = new Matrix4();
        if (/_bed$/.test(id) || (id === 'trident' && !['gui', 'ground', 'fixed', 'on_shelf'].includes(display))) {
            const models = await buildItemIconModels(node.name, mainThreadAssetProvider);
            if (!models?.length) throw new Error('아이템 모델 보정을 불러오지 못했습니다.');
            editorModel.fromArray(models[0].modelMatrix);
        }
        correction = itemExportCorrection(id, node.name, display, editorModel);
        prune(nbt, 'item');
    } else {
        Object.assign(node, await textOptions(nbt));
        node.isTextDisplay = true;
    }
    const matrix = transformation(nbt).multiply(correction.invert());
    if (!matrix.elements.every(value => Number.isFinite(Math.fround(value)))) throw new Error('변환이 float32 범위를 벗어났습니다.');
    node.transforms = matrix.transpose().toArray();
    if (compound(nbt.brightness)) {
        node.brightness = {};
        for (const key of ['sky', 'block'] as const) {
            const value = snbtNumber(nbt.brightness[key]);
            if (value !== undefined && Number.isInteger(value) && value >= 0 && value <= 15) node.brightness[key] = value;
        }
        // The editor's 15/0 preset exports as world lighting; explicit Minecraft lighting must remain in NBT.
        if ((node.brightness.sky ?? 15) !== 15 || (node.brightness.block ?? 0) !== 0) {
            for (const key of Object.keys(node.brightness)) delete nbt.brightness[key];
            prune(nbt, 'brightness');
        }
    }
    node.nbt = Object.keys(nbt).length ? stringifySnbt(nbt) : '';
    return node;
}

export async function parseMcfunction(source: string, name = 'mcfunction'): Promise<{ project: PdeProject; issues: McfunctionIssue[] }> {
    const children: PdeNode[] = [], issues: McfunctionIssue[] = [];
    const lines = source.replace(/^\uFEFF/, '').split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
        const line = index + 1;
        let command = lines[index].trim();
        if (!command || command.startsWith('#')) continue;
        let unfinished = false;
        while (command.endsWith('\\')) {
            command = command.slice(0, -1);
            if (++index === lines.length) { unfinished = true; break; }
            command += lines[index].trim();
        }
        if (!/^\/?summon(?:\s|$)/.test(command)) continue;
        try {
            if (unfinished) throw new Error('줄 연결 뒤의 명령이 없습니다.');
            const match = /^\/?summon\s+(\S+)(?:\s+(\S+)\s+(\S+)\s+(\S+))?(?:\s+(\{[\s\S]*))?$/.exec(command);
            if (!match || !resourceId(match[1])) throw new Error('summon 엔티티·좌표·NBT 형식이 올바르지 않습니다.');
            const coords = match.slice(2, 5);
            if (match[5] && coords[0] === undefined) throw new Error('NBT 앞에 소환 좌표가 필요합니다.');
            if (coords[0] !== undefined && (coords.some(value => !/^(?:[~^](?:[+-]?(?:\d+(?:\.\d*)?|\.\d+))?|[+-]?(?:\d+(?:\.\d*)?|\.\d+))$/.test(value))
                || (coords.some(value => value.startsWith('^')) && !coords.every(value => value.startsWith('^'))))) throw new Error('소환 좌표가 올바르지 않습니다.');
            const root = parseSnbt(match[5] ?? '{}');
            if (!compound(root)) throw new Error('NBT 컴파운드가 필요합니다.');
            const extracted: PdeNode[] = [];
            const visit = async (id: string, entity: Compound): Promise<void> => {
                const passengers = entity.Passengers;
                delete entity.id; delete entity.Passengers;
                if (['block_display', 'item_display', 'text_display'].includes(id)) {
                    const node = await displayNode(id, entity);
                    if (node) extracted.push(node);
                }
                if (passengers !== undefined) {
                    if (!Array.isArray(passengers)) throw new Error('Passengers 목록이 필요합니다.');
                    for (const passenger of passengers) {
                        if (!compound(passenger) || !resourceId(passenger.id)) throw new Error('Passenger 엔티티 ID가 올바르지 않습니다.');
                        await visit(resourceId(passenger.id), passenger);
                    }
                }
            };
            await visit(resourceId(match[1]), root);
            children.push(...extracted);
        } catch (error) { issues.push({ line, message: error instanceof Error ? error.message : String(error) }); }
    }
    return { project: { pdeFormatVersion: 1, name, mainNBT: '', nbt: '', children: children.length ? [{
        uuid: MathUtils.generateUUID(), name, isCollection: true, transforms: new Matrix4().toArray(), children
    }] : [], editorState: { version: 1, objects: [], groups: [], hiddenObjectUuids: [], hiddenGroupIds: [], objectMirrorPairs: [], groupMirrorPairs: [] } }, issues };
}
