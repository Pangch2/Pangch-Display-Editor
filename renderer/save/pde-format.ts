import { strFromU8, strToU8 } from 'fflate';
import { MathUtils } from 'three/webgpu';
import { animationCameraItem, animationClips, transformMatrix, validateAnimation, type AnimationClip, type AnimationData } from '../animation/animation-data';
import { defaultTextDisplayOptions, type TextDisplayOptions } from '../load-project/display/text-display';

export type ObjectEditorState = {
    uuid: string;
    label?: string;
    pivot?: number[];
    customPivot?: number[];
    isCustomPivot?: boolean;
    uvFlip?: number[];
    knifeUvScale?: number[];
    knifeUvOffset?: number[];
    headLayerVisible?: number;
    hasHat?: boolean;
    imageHeadLayer?: 0 | 1;
};
export type GroupEditorState = {
    id: string;
    position: number[];
    quaternion: number[];
    scale: number[];
    matrix?: number[];
    pivot?: number[];
    isCustomPivot?: boolean;
};
export type PdeEditorState = {
    version: 1;
    objects: ObjectEditorState[];
    groups: GroupEditorState[];
    hiddenObjectUuids: string[];
    hiddenGroupIds: string[];
    objectMirrorPairs: [string, string][];
    groupMirrorPairs: [string, string][];
    /** Mirror planes that moved off world X=0, as [node id, column-major matrix]. */
    mirrorPlanes?: [string, number[]][];
    globalBrightness?: { enabled: boolean; sky: number; block: number };
    animation?: AnimationData;
};
export type PdeNode = {
    uuid: string;
    name: string;
    transforms: number[];
    nbt?: string;
    brightness?: { sky?: number; block?: number };
    isCollection?: boolean;
    isBlockDisplay?: boolean;
    isItemDisplay?: boolean;
    isTextDisplay?: boolean;
    options?: TextDisplayOptions;
    paintTexture?: string;
    children?: PdeNode[];
};
export type PdeProject = {
    pdeFormatVersion: 1;
    name: string;
    mainNBT: string;
    nbt: string;
    parentEntity?: string;
    summonPosition?: string;
    children: PdeNode[];
    editorState: PdeEditorState;
};

const record = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const vector = (value: unknown, size: number): value is number[] => Array.isArray(value) && value.length === size && value.every(finite);
const string = (value: unknown) => typeof value === 'string';
const boolean = (value: unknown) => typeof value === 'boolean';
const alpha = (value: unknown) => finite(value) && value >= 0 && value <= 1;
const color = (value: unknown) => string(value) && /^#[\da-f]{6}$/i.test(value as string);
const paintTexture = (value: unknown) => string(value) && /^(data:image\/png;base64,|https?:\/\/)/.test(value as string);
const align = (value: unknown) => ['left', 'center', 'right'].includes(value as string);
const contentTypes = ['text', 'sprite', 'player', 'translate', 'keybind', 'score', 'selector', 'nbt'];
const effectKeys = ['bold', 'italic', 'underline', 'strikeThrough', 'obfuscated'];
const effects = (value: unknown) => record(value) && Object.entries(value).every(([key, entry]) => effectKeys.includes(key) && boolean(entry));
const extraValues = (value: unknown) => record(value) && Object.entries(value).every(([key, entry]) =>
    key === 'interpret' ? boolean(entry) : key === 'nbtSource' ? ['entity', 'block', 'storage'].includes(entry)
        : ['fallback', 'scoreboard', 'separator', 'entity', 'block', 'storage', 'preview'].includes(key) && string(entry));
const optionChecks: Record<string, (value: unknown) => boolean> = {
    color, shadowColor: color, shadowAlpha: alpha, alpha, backgroundColor: color, backgroundAlpha: alpha,
    bold: boolean, italic: boolean, underline: boolean, strikeThrough: boolean, obfuscated: boolean,
    lineLength: value => finite(value) && value > 0, align, font: string,
    pageIndex: value => Number.isInteger(value) && (value as number) >= 0
};
const pageChecks: Record<string, (value: unknown) => boolean> = {
    pages: string, pageColors: color, pageAlphas: alpha, pageShadowColors: color, pageShadowAlphas: alpha,
    pageEffects: effects, pageAligns: align, pageTypes: value => contentTypes.includes(value as string),
    pageAtlases: string, pageHats: boolean, pageExtraValues: extraValues,
    pageTypeValues: value => record(value) && Object.entries(value).every(([key, entry]) => contentTypes.includes(key) && string(entry))
};

const identityMatrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const brightnessDefaults = { sky: 15, block: 0 };
const globalBrightnessDefaults = { enabled: false, ...brightnessDefaults };
const objectDefaults = { uvFlip: [0, 0], knifeUvScale: [1, 1, 1], knifeUvOffset: [0, 0, 0], headLayerVisible: 1 };
const groupDefaults = { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1], isCustomPivot: false };
const stateDefaults = { objects: [], groups: [], hiddenObjectIds: [], hiddenGroupIds: [], objectMirrorPairs: [], groupMirrorPairs: [], mirrorPlanes: [] };
const objectEditorKeys = ['label', 'pivot', 'customPivot', 'isCustomPivot', ...Object.keys(objectDefaults), 'hasHat', 'imageHeadLayer'];
const groupEditorKeys = [...Object.keys(groupDefaults), 'matrix', 'pivot'];
// Versions 3/4/5 share fixed defaults even if the editor's new-object defaults change.
const textDefaults: Required<TextDisplayOptions> = {
    color: '#FFFFFF', shadowColor: '#3F3F3F', shadowAlpha: 0, alpha: 1, backgroundColor: '#000000', backgroundAlpha: 0.25,
    bold: false, italic: false, underline: false, strikeThrough: false, obfuscated: false,
    lineLength: 50, align: 'center', font: 'minecraft:default', pageIndex: 0,
    pages: [], pageColors: [], pageAlphas: [], pageShadowColors: [], pageShadowAlphas: [], pageEffects: [], pageAligns: [],
    pageTypes: [], pageAtlases: [], pageHats: [], pageTypeValues: [], pageExtraValues: []
};
const omitDefaults = (value: object, defaults: Record<string, unknown>): Record<string, any> => {
    const result: Record<string, any> = {};
    for (const key of Object.keys(value)) {
        const entry = (value as Record<string, unknown>)[key], fallback = defaults[key];
        if (entry !== undefined && !(Array.isArray(fallback)
            ? Array.isArray(entry) && entry.length === fallback.length && entry.every((item, i) => item === fallback[i])
            : entry === fallback)) result[key] = entry;
    }
    return result;
};
const nonempty = (value: Record<string, any>) => Object.keys(value).length ? value : undefined;

export function validateTextDisplayOptions(value: unknown, name: string, defaults = defaultTextDisplayOptions): TextDisplayOptions {
    if (value === undefined) value = {};
    if (!record(value)) throw new Error('잘못된 PDE 텍스트 옵션입니다.');
    for (const [key, entry] of Object.entries(value)) {
        const check = optionChecks[key];
        if (check ? !check(entry) : !pageChecks[key] || !Array.isArray(entry) || !entry.every(pageChecks[key])) {
            throw new Error(`잘못된 PDE 텍스트 옵션: ${key}`);
        }
    }
    if ((value.pageIndex ?? 0) >= Math.max(1, value.pages?.length ?? 1)) throw new Error('잘못된 PDE 텍스트 페이지 번호입니다.');
    return { ...structuredClone(defaults), ...value, pages: value.pages ?? [name] };
}

/** Runs a stepwise job (a generator that yields between pieces of work) to the end in one go. */
export function runSteps<T>(steps: Iterator<unknown, T>): T {
    for (;;) {
        const step = steps.next();
        if (step.done) return step.value;
    }
}

// Stepwise jobs yield after this many nodes, so a caller can let the page run between pieces.
const stepSize = 1024;

export function validatePdeProject(project: any): asserts project is PdeProject {
    runSteps(validatePdeProjectSteps(project));
}

export function* validatePdeProjectSteps(project: any): Generator<void, void> {
    let work = 0;
    if (!record(project)) throw new Error('잘못된 프로젝트입니다.');
    if (project.pdeFormatVersion === undefined) return;
    if (project.pdeFormatVersion !== 1) throw new Error(`지원하지 않는 PDE 버전: ${project.pdeFormatVersion}`);
    if ([project.parentEntity, project.summonPosition].some(value => value !== undefined && !string(value))) {
        throw new Error('잘못된 PDE 소환 설정입니다.');
    }
    const textures = project.refs?.paintTextures;
    if (project.refs !== undefined && (!record(project.refs) || !Array.isArray(textures) || !textures.every(paintTexture))) {
        throw new Error('잘못된 PDE 헤드 텍스처 목록입니다.');
    }
    const objectIds = new Set<string>();
    const groupIds = new Set<string>();
    const state = project.editorState;
    const inline = state?.version === 4 || state?.version === 5;
    const compact = inline || state?.version === 3;
    const indexed = compact || project.editorState?.version === 2;
    if (inline) {
        if (!record(state) || [...Object.keys(stateDefaults), 'hiddenObjectUuids'].some(key => state[key] !== undefined)) throw new Error('잘못된 PDE 노드별 편집 상태입니다.');
        for (const key of Object.keys(stateDefaults)) state[key] = [];
    }
    if (compact) for (const key of ['name', 'mainNBT', 'nbt']) if (project[key] === undefined) project[key] = '';
    const nodeIds = new Map<number, string>();
    const visit = function* (nodes: unknown, depth = 0): Generator<void, void> {
        if (!Array.isArray(nodes) || depth > 128) throw new Error('잘못된 PDE 계층입니다.');
        for (const node of nodes) {
            if (!record(node)) throw new Error('잘못된 PDE 노드입니다.');
            if (compact) {
                if (node.transforms === undefined) node.transforms = [...identityMatrix];
                if (node.nbt === undefined) node.nbt = '';
            }
            if ((indexed ? node.uuid !== undefined : !string(node.uuid) || !node.uuid) || !string(node.name) || !vector(node.transforms, 16)
                || [node.isCollection, node.isBlockDisplay, node.isItemDisplay, node.isTextDisplay].filter(Boolean).length !== 1
                || (node.nbt !== undefined && !string(node.nbt))) throw new Error('잘못된 PDE 노드입니다.');
            if (indexed) nodeIds.set(nodeIds.size, node.uuid = MathUtils.generateUUID());
            const ids = node.isCollection ? groupIds : objectIds;
            if (objectIds.has(node.uuid) || groupIds.has(node.uuid)) throw new Error(`중복 PDE UUID: ${node.uuid}`);
            ids.add(node.uuid);
            if (node.brightness !== undefined && (!record(node.brightness) || Object.entries(node.brightness).some(([key, value]) =>
                !['sky', 'block'].includes(key) || !Number.isInteger(value) || (value as number) < 0 || (value as number) > 15))) throw new Error('잘못된 PDE 밝기입니다.');
            if (compact) node.brightness = { ...brightnessDefaults, ...node.brightness };
            if (typeof node.paintTexture === 'number') {
                if (!Number.isInteger(node.paintTexture) || node.paintTexture < 0 || textures?.[node.paintTexture] === undefined) throw new Error('잘못된 PDE 헤드 텍스처 참조입니다.');
                node.paintTexture = textures[node.paintTexture];
            }
            if (node.paintTexture !== undefined && !paintTexture(node.paintTexture)) throw new Error('잘못된 PDE 헤드 텍스처입니다.');
            if (node.isTextDisplay) node.options = validateTextDisplayOptions(node.options, node.name, compact ? textDefaults : defaultTextDisplayOptions);
            if (inline && node.editorState !== undefined) {
                const editor = node.editorState;
                const keys = node.isCollection ? groupEditorKeys : objectEditorKeys;
                if (!record(editor) || Object.keys(editor).some(key => !keys.includes(key) && !['hidden', 'mirrorId', 'mirrorPlane'].includes(key))
                    || (editor.hidden !== undefined && !boolean(editor.hidden))
                    || (editor.mirrorPlane !== undefined && !vector(editor.mirrorPlane, 16))) throw new Error('잘못된 PDE 노드 편집 값입니다.');
                const { hidden, mirrorId, mirrorPlane, ...values } = editor;
                const id = nodeIds.size - 1;
                if (Object.keys(values).length) state[node.isCollection ? 'groups' : 'objects'].push({ id, ...values });
                if (hidden) state[node.isCollection ? 'hiddenGroupIds' : 'hiddenObjectIds'].push(id);
                if (mirrorId !== undefined) state[node.isCollection ? 'groupMirrorPairs' : 'objectMirrorPairs'].push([id, mirrorId]);
                if (mirrorPlane !== undefined) state.mirrorPlanes.push([id, mirrorPlane]);
                delete node.editorState;
            }
            if (node.children !== undefined) yield* visit(node.children, depth + 1);
            if (++work % stepSize === 0) yield;
        }
    };
    yield* visit(project.children);
    if (compact) {
        for (const key of Object.keys(stateDefaults)) if (state[key] === undefined) state[key] = [];
        if (record(state.globalBrightness)) state.globalBrightness = { ...globalBrightnessDefaults, ...state.globalBrightness };
    }
    if (!record(state) || ![1, 2, 3, 4, 5].includes(state.version) || !Array.isArray(state.objects) || !Array.isArray(state.groups)) throw new Error('잘못된 PDE 편집 상태 버전입니다.');
    if (indexed) {
        const resolve = (id: unknown): string => {
            if (!Number.isSafeInteger(id) || !nodeIds.has(id as number)) throw new Error('잘못된 PDE 노드 참조입니다.');
            return nodeIds.get(id as number)!;
        };
        for (const object of state.objects) {
            if (!record(object) || object.uuid !== undefined) throw new Error('잘못된 PDE 오브젝트 참조입니다.');
            object.uuid = resolve(object.id);
            delete object.id;
            if (++work % stepSize === 0) yield;
        }
        for (const group of state.groups) {
            if (!record(group)) throw new Error('잘못된 PDE 그룹 참조입니다.');
            if (compact) for (const [key, value] of Object.entries(groupDefaults)) if (group[key] === undefined) group[key] = Array.isArray(value) ? [...value] : value;
            group.id = resolve(group.id);
        }
        for (const key of ['hiddenObjectIds', 'hiddenGroupIds']) {
            if (!Array.isArray(state[key])) throw new Error(`잘못된 PDE 참조: ${key}`);
            state[key] = state[key].map(resolve);
        }
        state.hiddenObjectUuids = state.hiddenObjectIds;
        delete state.hiddenObjectIds;
        for (const key of ['objectMirrorPairs', 'groupMirrorPairs']) {
            if (!Array.isArray(state[key]) || !state[key].every(pair => Array.isArray(pair) && pair.length === 2)) throw new Error(`잘못된 PDE 참조: ${key}`);
            state[key] = state[key].map(pair => pair.map(resolve));
        }
        if (state.mirrorPlanes !== undefined) {
            if (!Array.isArray(state.mirrorPlanes) || !state.mirrorPlanes.every(entry => Array.isArray(entry) && entry.length === 2)) throw new Error('잘못된 PDE 참조: mirrorPlanes');
            state.mirrorPlanes = state.mirrorPlanes.map(([id, plane]) => [resolve(id), plane]);
        }
        state.version = 1;
        if (state.animation !== undefined) {
            if (!record(state.animation) || !Array.isArray(state.animation.tracks)
                || state.animation.clips !== undefined && !Array.isArray(state.animation.clips)) throw new Error('잘못된 애니메이션 트랙입니다.');
            for (const clip of animationClips(state.animation as AnimationData)) {
                if (!record(clip) || !Array.isArray(clip.tracks)) throw new Error('잘못된 애니메이션 클립입니다.');
                for (const track of clip.tracks) {
                    if (!record(track)) throw new Error('잘못된 애니메이션 대상입니다.');
                    // Legacy camera tracks kept a literal id; migrateAnimationCamera replaces them.
                    if ((track.type as string) !== 'camera') track.id = resolve(track.id);
                }
                if (clip.excludedNodes !== undefined) {
                    if (!Array.isArray(clip.excludedNodes)) throw new Error('잘못된 애니메이션 제외 대상입니다.');
                    clip.excludedNodes = clip.excludedNodes.map(resolve);
                }
            }
            if (state.animation.camera !== undefined) state.animation.camera = resolve(state.animation.camera);
        }
    }
    const seenObjects = new Set<string>();
    if (state.animation !== undefined) {
        if (record(state.animation)) migrateAnimationCamera(project, objectIds);
        validateAnimation(state.animation, objectIds, groupIds);
        for (const clip of animationClips(state.animation)) for (const track of clip.tracks) for (const key of track.keys) {
            if (key.properties?.options !== undefined) validateTextDisplayOptions(key.properties.options, key.properties.name!);
        }
    }
    for (const object of state.objects) {
        if (!record(object) || !objectIds.has(object.uuid) || seenObjects.has(object.uuid)) throw new Error('잘못된 PDE 오브젝트 참조입니다.');
        seenObjects.add(object.uuid);
        for (const key of ['pivot', 'customPivot', 'knifeUvScale', 'knifeUvOffset']) {
            if (object[key] !== undefined && !vector(object[key], 3)) throw new Error(`잘못된 PDE 편집 값: ${key}`);
        }
        if ((object.label !== undefined && !string(object.label)) || (object.uvFlip !== undefined && !vector(object.uvFlip, 2))
            || (object.headLayerVisible !== undefined && !alpha(object.headLayerVisible))
            || (object.hasHat !== undefined && !boolean(object.hasHat)) || (object.isCustomPivot !== undefined && !boolean(object.isCustomPivot))
            || (object.imageHeadLayer !== undefined && ![0, 1].includes(object.imageHeadLayer))) throw new Error('잘못된 PDE 오브젝트 편집 값입니다.');
        if (++work % stepSize === 0) yield;
    }
    const seenGroups = new Set<string>();
    for (const group of state.groups) {
        if (!record(group) || !groupIds.has(group.id) || seenGroups.has(group.id) || !vector(group.position, 3) || !vector(group.quaternion, 4)
            || !vector(group.scale, 3) || (group.matrix !== undefined && !vector(group.matrix, 16))
            || (group.pivot !== undefined && !vector(group.pivot, 3)) || (group.isCustomPivot !== undefined && !boolean(group.isCustomPivot))) throw new Error('잘못된 PDE 그룹 편집 값입니다.');
        seenGroups.add(group.id);
    }
    for (const [key, ids] of [['hiddenObjectUuids', objectIds], ['hiddenGroupIds', groupIds]] as const) {
        if (!Array.isArray(state[key]) || !state[key].every(id => ids.has(id))) throw new Error(`잘못된 PDE 참조: ${key}`);
    }
    for (const [key, ids] of [['objectMirrorPairs', objectIds], ['groupMirrorPairs', groupIds]] as const) {
        if (!Array.isArray(state[key]) || !state[key].every(pair => Array.isArray(pair) && pair.length === 2 && pair.every(id => ids.has(id)))) throw new Error(`잘못된 PDE 참조: ${key}`);
    }
    if (state.mirrorPlanes !== undefined && (!Array.isArray(state.mirrorPlanes) || !state.mirrorPlanes.every(entry => Array.isArray(entry)
        && entry.length === 2 && (objectIds.has(entry[0]) || groupIds.has(entry[0])) && vector(entry[1], 16)))) throw new Error('잘못된 PDE 미러 기준면입니다.');
    if (state.globalBrightness !== undefined && (!record(state.globalBrightness) || !boolean(state.globalBrightness.enabled)
        || ![state.globalBrightness.sky, state.globalBrightness.block].every(value => Number.isInteger(value) && value >= 0 && value <= 15))) throw new Error('잘못된 PDE 전역 밝기입니다.');
}

// The camera used to be its own track type (with an optional shake track); its keys now move a camera item.
function migrateAnimationCamera(project: any, objectIds: Set<string>): void {
    const state = project.editorState, clips: any[] = animationClips(state.animation);
    let uuid: string | undefined;
    for (const clip of clips) {
        if (!record(clip) || !Array.isArray(clip.tracks)) continue;
        delete clip.cameraShake;
        clip.tracks = clip.tracks.flatMap((track: any) => track?.type !== 'camera' ? [track]
            : track.id === 'pde:camera' ? [{ ...track, type: 'object', id: uuid ??= MathUtils.generateUUID() }] : []);
    }
    if (!uuid) return;
    const first = clips.flatMap(clip => Array.isArray(clip?.tracks) ? clip.tracks : []).find(track => track?.id === uuid)?.keys?.[0]?.transform;
    project.children.push({ uuid, name: animationCameraItem, nbt: '', isItemDisplay: true,
        transforms: first ? transformMatrix(first).transpose().toArray() : [...identityMatrix] });
    state.objects.push({ uuid, label: '카메라' });
    state.animation.camera = uuid;
    objectIds.add(uuid);
}

export function encodePdeProject(project: PdeProject): Uint8Array {
    return runSteps(encodePdeProjectSteps(project));
}

export function* encodePdeProjectSteps(project: PdeProject): Generator<void, Uint8Array> {
    let work = 0;
    const counts = new Map<string, number>();
    const nodeIds = new Map<string, number>();
    const indexed = project.pdeFormatVersion === 1;
    const editors = new Map<string, Record<string, any>>();
    const hidden = new Set<string>();
    const mirrors = new Map<string, string>();
    const mirrorPlanes = new Map<string, number[]>();
    if (indexed) {
        for (const { uuid, ...editor } of project.editorState.objects) {
            if (editors.has(uuid)) throw new Error(`중복 PDE 편집 참조: ${uuid}`);
            editors.set(uuid, editor);
            if (++work % stepSize === 0) yield;
        }
        for (const { id, ...editor } of project.editorState.groups) {
            if (editors.has(id)) throw new Error(`중복 PDE 편집 참조: ${id}`);
            editors.set(id, editor);
        }
        for (const id of [...project.editorState.hiddenObjectUuids, ...project.editorState.hiddenGroupIds]) hidden.add(id);
        for (const [id, partner] of [...project.editorState.objectMirrorPairs, ...project.editorState.groupMirrorPairs]) mirrors.set(id, partner);
        for (const [id, plane] of project.editorState.mirrorPlanes ?? []) mirrorPlanes.set(id, plane);
    }
    const collectNodes = function* (nodes: PdeNode[]): Generator<void, Record<string, any>[]> {
        const collected: Record<string, any>[] = [];
        for (const { uuid, ...node } of nodes) {
            if (nodeIds.has(uuid)) throw new Error(`중복 PDE UUID: ${uuid}`);
            nodeIds.set(uuid, nodeIds.size);
            if (typeof node.paintTexture === 'string') counts.set(node.paintTexture, (counts.get(node.paintTexture) ?? 0) + 1);
            const options = node.isTextDisplay && node.options ? omitDefaults(node.options, textDefaults) : node.options;
            // Empty pages are content, not an omitted option's fallback to the node name.
            if (node.isTextDisplay && node.options?.pages !== undefined && options) options.pages = node.options.pages;
            const children = node.children ? yield* collectNodes(node.children) : undefined;
            collected.push(omitDefaults({ ...node,
                brightness: node.brightness ? nonempty(omitDefaults(node.brightness, brightnessDefaults)) : undefined,
                options: options ? nonempty(options) : undefined,
                editorState: nonempty(omitDefaults({ ...editors.get(uuid), hidden: hidden.has(uuid) ? true : undefined, mirrorId: mirrors.get(uuid),
                    mirrorPlane: mirrorPlanes.get(uuid) },
                    node.isCollection ? groupDefaults : objectDefaults)),
                children
            }, { transforms: identityMatrix, nbt: '', children: [] }));
            if (++work % stepSize === 0) yield;
        }
        return collected;
    };
    const children = indexed ? yield* collectNodes(project.children) : project.children;
    const textures = [...counts].filter(([, count]) => count > 1).map(([texture]) => texture);
    const textureIds = new Map(textures.map((texture, index) => [texture, index]));
    const reference = (uuid: string): number => {
        const id = nodeIds.get(uuid);
        if (id === undefined) throw new Error(`잘못된 PDE 노드 참조: ${uuid}`);
        return id;
    };
    for (const id of editors.keys()) {
        reference(id);
        if (++work % stepSize === 0) yield;
    }
    for (const id of hidden) reference(id);
    for (const [id, partner] of mirrors) { reference(id); reference(partner); }
    const animation = project.editorState?.animation;
    const saveClip = (clip: AnimationClip) => ({ ...clip, tracks: clip.tracks.map(track => ({ ...track, id: reference(track.id) })),
        excludedNodes: clip.excludedNodes?.map(reference) });
    const savedAnimation = animation && indexed ? { ...animation, ...saveClip(animation), clips: animation.clips?.map(saveClip),
        camera: animation.camera === undefined ? undefined : reference(animation.camera) } : animation;
    // Editor links use preorder indices; UUIDs exist only while editing.
    const saved = indexed ? omitDefaults({ ...project, children, editorState: omitDefaults({
        version: animation ? 5 : 4,
        animation: savedAnimation,
        globalBrightness: project.editorState.globalBrightness ? nonempty(omitDefaults(project.editorState.globalBrightness, globalBrightnessDefaults)) : undefined
    }, {}), ...(textures.length ? { refs: { paintTextures: textures } } : {}) }, { name: '', mainNBT: '', nbt: '' }) : project;
    const replace = (key: string, value: unknown) =>
        indexed && key === 'uuid' ? undefined : indexed && key === 'mirrorId' && typeof value === 'string' ? reference(value)
            : key === 'paintTexture' && typeof value === 'string' ? textureIds.get(value) ?? value
                // Integers skip toFixed: same value, and big scenes are mostly integer block positions.
                : typeof value === 'number' ? Number.isInteger(value) ? value : Number(value.toFixed(8)) : value;
    // Applies replace like a JSON.stringify replacer would, without the replacer's slow path (seconds on large scenes).
    const prepare = (key: string, value: unknown): unknown => {
        value = replace(key, value);
        if (Array.isArray(value)) return value.map(item => prepare('', item));
        if (!value || typeof value !== 'object') return value;
        const result: Record<string, unknown> = {};
        for (const entryKey of Object.keys(value)) result[entryKey] = prepare(entryKey, (value as Record<string, unknown>)[entryKey]);
        return result;
    };
    // Same text as JSON.stringify([prepare('', saved)]), written node by node so the work can pause.
    const pieces: string[] = [];
    const writeObject = function* (value: Record<string, unknown>): Generator<void, void> {
        let first = true;
        pieces.push('{');
        for (const key of Object.keys(value)) {
            const entry = key === 'children' && Array.isArray(value[key]) ? value[key] : prepare(key, value[key]);
            if (entry === undefined || typeof entry === 'function' || typeof entry === 'symbol') continue;
            pieces.push(`${first ? '' : ','}${JSON.stringify(key)}:`);
            first = false;
            if (key === 'children' && Array.isArray(entry)) yield* writeNodes(entry);
            else pieces.push(JSON.stringify(entry));
        }
        pieces.push('}');
    };
    const writeNodes = function* (nodes: unknown[]): Generator<void, void> {
        pieces.push('[');
        for (let index = 0; index < nodes.length; index++) {
            if (index) pieces.push(',');
            const node = nodes[index] as Record<string, unknown> | undefined;
            if (node !== null && typeof node === 'object' && Array.isArray(node.children)) yield* writeObject(node);
            else pieces.push(JSON.stringify(prepare('', node)) ?? 'null');
            if (++work % stepSize === 0) yield;
        }
        pieces.push(']');
    };
    yield* writeNodes([saved]);
    // Pieces are whole JSON tokens, so encoding them in batches gives the same bytes as one string.
    const parts: Uint8Array[] = [];
    let batch = 0, length = 0;
    for (let index = 0; index <= pieces.length; index++) {
        if (index < pieces.length && (length += pieces[index].length) < 1 << 20) continue;
        parts.push(strToU8(pieces.slice(batch, index + 1).join('')));
        batch = index + 1;
        length = 0;
        yield;
    }
    const json = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let offset = 0;
    for (const part of parts) {
        json.set(part, offset);
        offset += part.length;
        if (++work % 16 === 0) yield;
    }
    yield;
    return encodeProjectArchive(json);
}

export function encodeProjectArchive(json: Uint8Array): Uint8Array {
    const raw = new Uint8Array(18 + json.length);
    raw.set(strToU8('PRJ2scene.json'));
    new DataView(raw.buffer).setUint32(14, json.length, true);
    raw.set(json, 18);
    return raw;
}

export function decodeProject(file: ArrayBuffer | Uint8Array): any {
    const raw = file instanceof Uint8Array ? file : new Uint8Array(file);
    if (strFromU8(raw.subarray(0, 4)) !== 'PRJ2') throw new Error('Invalid magic bytes. Expected PRJ2.');
    const target = strToU8('scene.json');
    const index = raw.findIndex((_, offset) => offset >= 4 && target.every((byte, i) => raw[offset + i] === byte));
    if (index < 0) throw new Error('scene.json not found in PRJ2 archive');
    const start = index + target.length + 4;
    if (start > raw.length) throw new Error('Truncated PRJ2 archive');
    const size = new DataView(raw.buffer, raw.byteOffset + start - 4, 4).getUint32(0, true);
    if (size > raw.length - start) throw new Error('Truncated scene.json');
    const project = JSON.parse(strFromU8(raw.subarray(start, start + size)))[0] ?? {};
    validatePdeProject(project);
    return project;
}
