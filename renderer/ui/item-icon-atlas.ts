import * as THREE from 'three/webgpu';
import { createEntityMaterial, dragSelectedAttributeName } from '../entity-material';
import { mainThreadAssetProvider } from '../load-project/pbde-assets';
import { buildBlockIconTemplate, buildItemIconModels, type ModelData } from '../load-project/scene-parser';
import { buildTextureAtlasForRenderList, type TexturePixelData } from '../load-project/texture-atlas-builder';

const iconSize = 64;
const defaultBlockGuiTransform = {
    rotation: [30, 225, 0],
    translation: [0, 0, 0],
    scale: [0.625, 0.625, 0.625]
};

type IconMap = Map<string, { x: number; y: number; size: number }>;
type GuiTransform = { rotation?: number[]; translation?: number[]; scale?: number[] };
type PreparedIcon = {
    name: string;
    models: ModelData[];
    image?: ImageBitmap;
    applyGuiTransform: boolean;
    guiTransform?: GuiTransform | null;
    blockProps?: Record<string, string>;
};

function atlasGrid(count: number): { columns: number; width: number; height: number } {
    const columns = Math.max(1, Math.min(9, count));
    return {
        columns,
        width: columns * iconSize,
        height: Math.max(1, Math.ceil(count / columns)) * iconSize
    };
}

function cloneModels(models: ModelData[]): ModelData[] {
    return models.map(model => ({
        ...model,
        geometries: model.geometries.map(part => ({ ...part, uvs: [...part.uvs] }))
    }));
}

const blockPropertyDefaults: Record<string, string[]> = {
    attachment: ['floor'],
    axis: ['y'],
    distance: ['7'],
    enabled: ['true'],
    face: ['wall'],
    facing: ['north'],
    half: ['bottom', 'lower'],
    hinge: ['left'],
    layers: ['1'],
    part: ['foot'],
    shape: ['straight', 'north_south'],
    thickness: ['tip'],
    type: ['single', 'bottom'],
    vertical_direction: ['up']
};

function preferredBlockProperty(key: string, values: string[]): string | undefined {
    return [...(blockPropertyDefaults[key] ?? []), 'false', '0', 'none', '1']
        .find(value => values.includes(value));
}

function defaultBlockProperties(blockstate: any): Record<string, string> {
    const candidates: Record<string, string>[] = Object.keys(blockstate?.variants ?? {}).map(key =>
        Object.fromEntries(key.split(',').filter(Boolean).map(part => part.split('=', 2))) as Record<string, string>
    );
    if (candidates.length) {
        const values = new Map<string, Set<string>>();
        candidates.forEach(candidate => Object.entries(candidate).forEach(([key, value]) =>
            (values.get(key) ?? values.set(key, new Set()).get(key)!).add(value)
        ));
        const preferred = new Map([...values].map(([key, options]) =>
            [key, preferredBlockProperty(key, [...options])]
        ));
        return candidates.reduce((best, candidate) => {
            const score = (value: Record<string, string>) =>
                Object.entries(value).filter(([key, option]) => preferred.get(key) === option).length;
            return score(candidate) > score(best) ? candidate : best;
        }, candidates[0]);
    }

    const values = new Map<string, Set<string>>();
    const collect = (condition: any): void => {
        if (!condition || typeof condition !== 'object') return;
        for (const [key, value] of Object.entries(condition)) {
            if (key === 'OR' || key === 'AND') (Array.isArray(value) ? value : [value]).forEach(collect);
            else String(value).split('|').forEach(option =>
                (values.get(key) ?? values.set(key, new Set()).get(key)!).add(option)
            );
        }
    };
    blockstate?.multipart?.forEach((part: any) => collect(part.when));
    return Object.fromEntries([...values].flatMap(([key, options]) => {
        const value = preferredBlockProperty(key, [...options]);
        return value ? [[key, value]] : [];
    }));
}

const blockIconNamePromises = new Map<string, Promise<string>>();

function parseIconName(name: string): { namespace: string; path: string; properties: Record<string, string> } {
    const stateStart = name.indexOf('[');
    const baseName = stateStart < 0 ? name : name.slice(0, stateStart);
    const [namespace, path] = baseName.includes(':') ? baseName.split(':', 2) : ['minecraft', baseName];
    const properties = Object.fromEntries(
        (stateStart < 0 ? '' : name.slice(stateStart + 1, name.lastIndexOf(']')))
            .split(',').filter(Boolean).map(part => part.split('=', 2))
    );
    return { namespace, path, properties };
}

function getBlockIconName(name: string): Promise<string> {
    let promise = blockIconNamePromises.get(name);
    if (!promise) {
        promise = (async () => {
            const { namespace, path, properties: explicitProperties } = parseIconName(name);
            const baseName = namespace === 'minecraft' ? path : `${namespace}:${path}`;
            const blockstate = await readJson(`assets/${namespace}/blockstates/${path}.json`)
                ?? await readJson(`hardcoded/blockstates/${path}.json`);
            const properties = { ...defaultBlockProperties(blockstate), ...explicitProperties };
            if (path.endsWith('shulker_box')) properties.facing = 'up';
            const suffix = Object.entries(properties).map(([key, value]) => `${key}=${value}`).join(',');
            return suffix ? `${baseName}[${suffix}]` : baseName;
        })();
        blockIconNamePromises.set(name, promise);
    }
    return promise;
}

function findDisplayModelId(value: any, properties: Record<string, string> = {}): string | null {
    if (typeof value === 'string') return value;
    if (!value || typeof value !== 'object') return null;
    if (value.block_state_property && Array.isArray(value.cases)) {
        const property = String(value.block_state_property).split(':').pop()!;
        const selected = value.cases.find((entry: any) => String(entry.when) === properties[property]);
        return findDisplayModelId(selected?.model ?? value.fallback, properties);
    }
    if (typeof value.base === 'string') return value.base;
    if (typeof value.model === 'string') return value.model;
    for (const key of ['model', 'fallback', 'on_true', 'on_false']) {
        const found = findDisplayModelId(value[key], properties);
        if (found) return found;
    }
    for (const key of ['models', 'cases', 'entries']) {
        for (const entry of Array.isArray(value[key]) ? value[key] : []) {
            const found = findDisplayModelId(entry, properties);
            if (found) return found;
        }
    }
    return null;
}

function needsHardcodedItemGeometry(definition: any): boolean {
    const type = definition?.model?.type;
    return typeof type === 'string' && type !== 'minecraft:model';
}

const iconModelOverrides = {
    '2D': ['*_sign', '*_door', '*_stairs', '*_bars', '*_chain', 'light', 'tripwire'],
    '3D': ['*_bed', '*_banner', '*_shulker_box', '*_chest']
};

function matchesIconModelOverride(name: string, overrides: string[]): boolean {
    return overrides.some(override => override.startsWith('*') ? name.endsWith(override.slice(1)) : name === override);
}

function usesBlockIconModel(name: string): boolean {
    if (name.startsWith('test_block[mode=')) return true;
    if (matchesIconModelOverride(name, iconModelOverrides['2D'])) return false;
    if (matchesIconModelOverride(name, iconModelOverrides['3D'])) return true;
    return false;
}

async function loadFlatItemIcon(name: string): Promise<ImageBitmap | null> {
    try {
        const { namespace, path, properties } = parseIconName(name);
        const definition = await readJson(`assets/${namespace}/items/${path}.json`);
        if (definition?.model?.tints?.length) return null;
        let modelId = findDisplayModelId(definition?.model, properties) ?? `${namespace}:item/${path}`;
        const textures: Record<string, string> = {};
        const seen = new Set<string>();
        let generated = false;
        while (modelId && !seen.has(modelId)) {
            seen.add(modelId);
            const [modelNamespace, modelPath] = modelId.includes(':') ? modelId.split(':', 2) : ['minecraft', modelId];
            const model = await readJson(`assets/${modelNamespace}/models/${modelPath}.json`);
            if (!model) return null;
            for (const [key, value] of Object.entries(model.textures ?? {})) {
                if (!(key in textures) && typeof value === 'string') textures[key] = value;
            }
            if (model.parent === 'builtin/generated') {
                generated = true;
                break;
            }
            modelId = model.parent;
        }
        if (!generated) return null;
        let textureId = textures.layer0;
        for (let guard = 0; textureId?.startsWith('#') && guard < 10; guard++) {
            textureId = textures[textureId.slice(1)];
        }
        if (!textureId) return null;
        const [textureNamespace, texturePath] = textureId.includes(':') ? textureId.split(':', 2) : ['minecraft', textureId];
        const asset = await mainThreadAssetProvider.getAsset(`assets/${textureNamespace}/textures/${texturePath}.png`);
        if (!(asset instanceof Uint8Array)) return null;
        const bitmap = await createImageBitmap(new Blob([asset as BlobPart], { type: 'image/png' }));
        if (bitmap.height <= bitmap.width) return bitmap;
        bitmap.close();
        return null;
    } catch {
        return null;
    }
}

async function usesHardcodedItemGeometry(name: string): Promise<boolean> {
    const { namespace, path } = parseIconName(name);
    return needsHardcodedItemGeometry(await readJson(`assets/${namespace}/items/${path}.json`));
}

async function getGuiTransform(name: string): Promise<GuiTransform | null> {
    const { namespace, path, properties } = parseIconName(name);
    const definition = await readJson(`assets/${namespace}/items/${path}.json`);
    let modelId = findDisplayModelId(definition?.model, properties) ?? `${namespace}:item/${path}`;
    const seen = new Set<string>();
    while (modelId && !seen.has(modelId)) {
        seen.add(modelId);
        const [modelNamespace, modelPath] = modelId.includes(':') ? modelId.split(':', 2) : ['minecraft', modelId];
        const model = await readJson(`assets/${modelNamespace}/models/${modelPath}.json`);
        if (!model) return null;
        if (model.display?.gui) return model.display.gui;
        modelId = model.parent;
    }
    return null;
}

if (import.meta.env.DEV) {
    const grid = atlasGrid(1201);
    console.assert(grid.columns === 9 && grid.width * grid.height / iconSize ** 2 >= 1201, 'Atlas grid is too small.');
    console.assert(
        defaultBlockProperties({ variants: {
            'facing=east,half=bottom,shape=inner_left': {},
            'facing=north,half=bottom,shape=straight': {}
        }}).shape === 'straight',
        'Default block icon properties changed.'
    );
    console.assert(
        findDisplayModelId({ type: 'minecraft:select', fallback: { type: 'minecraft:special', base: 'minecraft:item/chest' } })
            === 'minecraft:item/chest'
            && findDisplayModelId({
                block_state_property: 'level',
                cases: [{ when: '3', model: { model: 'minecraft:item/light_03' } }],
                fallback: { model: 'minecraft:item/light_15' }
            }, parseIconName('light[level=3]').properties) === 'minecraft:item/light_03',
        'Special item display model lookup failed.'
    );
    console.assert(
        needsHardcodedItemGeometry({ model: { type: 'minecraft:special' } })
            && !needsHardcodedItemGeometry({ model: { type: 'minecraft:model' } }),
        'Hardcoded item geometry selection failed.'
    );
    console.assert(
        !usesBlockIconModel('oak_sign')
            && !usesBlockIconModel('oak_hanging_sign')
            && !usesBlockIconModel('cut_copper_stairs')
            && usesBlockIconModel('white_bed')
            && usesBlockIconModel('white_banner')
            && usesBlockIconModel('white_shulker_box')
            && usesBlockIconModel('test_block[mode=accept]'),
        'Hardcoded icon dimension rules failed.'
    );
}

export type ItemIconAtlas = {
    itemImage: HTMLCanvasElement;
    blockImage: HTMLCanvasElement;
    itemIcons: IconMap;
    blockIcons: IconMap;
};

let atlasPromise: Promise<ItemIconAtlas> | null = null;

async function readJson(path: string): Promise<any | null> {
    try {
        return JSON.parse(String(await mainThreadAssetProvider.getAsset(path)));
    } catch {
        return null;
    }
}

async function loadTexturePixels(texPath: string): Promise<TexturePixelData | null> {
    try {
        const asset = await mainThreadAssetProvider.getAsset(texPath);
        if (!(asset instanceof Uint8Array)) return null;
        const bitmap = await createImageBitmap(new Blob([asset as BlobPart], { type: 'image/png' }));
        try {
            const width = bitmap.width;
            const height = Math.min(bitmap.width, bitmap.height);
            if (!width || !height) return null;
            const canvas = new OffscreenCanvas(width, height);
            const context = canvas.getContext('2d', { willReadFrequently: true });
            if (!context) return null;
            context.drawImage(bitmap, 0, 0);
            return { w: width, h: height, data: context.getImageData(0, 0, width, height).data };
        } finally {
            bitmap.close();
        }
    } catch {
        return null;
    }
}

async function prepareIcons(names: string[]): Promise<PreparedIcon[]> {
    const icons: PreparedIcon[] = [];
    for (let start = 0; start < names.length; start += 32) {
        const chunk = await Promise.all(names.slice(start, start + 32).map(async (name): Promise<PreparedIcon | null> => {
            const useBlockModel = usesBlockIconModel(name);
            const image = useBlockModel ? null : await loadFlatItemIcon(name);
            const itemModels = image ? null : await buildItemIconModels(`${name}[display=gui]`, mainThreadAssetProvider);
            const blockIcon = !image && (useBlockModel || !itemModels) ? await getBlockIconName(name) : null;
            const blockTemplate = blockIcon
                ? await buildBlockIconTemplate(blockIcon, mainThreadAssetProvider)
                : null;
            const applyHardcodedGuiTransform = !!itemModels?.some(model => model.fromHardcoded)
                && await usesHardcodedItemGeometry(name);
            const useBlock = !!blockTemplate && (
                useBlockModel || !itemModels || !!blockTemplate.fromHardcoded && applyHardcodedGuiTransform
            );
            const models = useBlock ? blockTemplate?.models : itemModels;
            return models || image ? {
                name,
                models: models ? cloneModels(models) : [],
                image: image ?? undefined,
                applyGuiTransform: useBlock || applyHardcodedGuiTransform,
                guiTransform: useBlock || applyHardcodedGuiTransform ? await getGuiTransform(name) : null,
                blockProps: useBlock ? blockTemplate?.blockProps : undefined
            } : null;
        }));
        icons.push(...chunk.filter((icon): icon is PreparedIcon => icon !== null));
    }
    return icons;
}

function createAtlasTexture(data: Uint8ClampedArray, width: number, height: number): Promise<THREE.Texture> {
    return createImageBitmap(new ImageData(new Uint8ClampedArray(data), width, height)).then(bitmap => {
        const texture = new THREE.Texture(bitmap);
        texture.magFilter = THREE.NearestFilter;
        texture.minFilter = THREE.NearestFilter;
        texture.generateMipmaps = false;
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.needsUpdate = true;
        return texture;
    });
}

function createModelGroup(
    icon: PreparedIcon,
    atlasTexture: THREE.Texture,
    materials: Map<string, THREE.Material>
): THREE.Group {
    const group = new THREE.Group();
    if (icon.applyGuiTransform) {
        const { rotation, translation, scale } = icon.guiTransform ?? defaultBlockGuiTransform;
        group.position.set(translation?.[0] ?? 0, translation?.[1] ?? 0, translation?.[2] ?? 0).multiplyScalar(1 / 16);
        group.rotation.set(
            THREE.MathUtils.degToRad(rotation?.[0] ?? 0),
            THREE.MathUtils.degToRad(rotation?.[1] ?? 0),
            THREE.MathUtils.degToRad(rotation?.[2] ?? 0),
            'XYZ'
        );
        group.scale.set(scale?.[0] ?? 1, scale?.[1] ?? 1, scale?.[2] ?? 1);
    }

    for (const model of icon.models) for (const part of model.geometries) {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(part.positions, 3));
        geometry.setAttribute('normal', new THREE.Float32BufferAttribute(part.normals, 3));
        geometry.setAttribute('uv', new THREE.Float32BufferAttribute(part.uvs, 2));
        geometry.setAttribute(dragSelectedAttributeName, new THREE.Float32BufferAttribute(new Float32Array(part.positions.length / 3), 1));
        geometry.setIndex(part.indices);

        const translucent = part.texPath === '__ATLAS_TRANSLUCENT__';
        const materialKey = `${part.tintHex}|${translucent}`;
        let material = materials.get(materialKey);
        if (!material) {
            material = createEntityMaterial(atlasTexture, part.tintHex).material;
            material.toneMapped = false;
            material.fog = false;
            material.flatShading = true;
            material.vertexColors = true;
            material.transparent = translucent;
            material.depthWrite = true;
            material.alphaTest = translucent ? 0 : 0.1;
            materials.set(materialKey, material);
        }

        const mesh = new THREE.Mesh(geometry, material);
        mesh.matrix.fromArray(model.modelMatrix);
        mesh.matrixAutoUpdate = false;
        group.add(mesh);
    }
    return group;
}

async function renderIcon(
    renderer: THREE.WebGPURenderer,
    scene: THREE.Scene,
    camera: THREE.OrthographicCamera,
    icon: PreparedIcon,
    atlasTexture: THREE.Texture,
    materials: Map<string, THREE.Material>
): Promise<void> {
    const group = createModelGroup(icon, atlasTexture, materials);
    scene.add(group);
    group.updateMatrixWorld(true);

    const bounds = new THREE.Box3().setFromObject(group);
    const center = bounds.getCenter(new THREE.Vector3());
    const size = bounds.getSize(new THREE.Vector3());
    const viewSize = Math.max(1, size.x, size.y) / 0.88;
    camera.left = camera.bottom = -viewSize / 2;
    camera.right = camera.top = viewSize / 2;
    camera.position.set(center.x, center.y, center.z + Math.max(10, size.z * 2));
    camera.lookAt(center);
    camera.updateProjectionMatrix();

    renderer.render(scene, camera);
    scene.remove(group);
    group.traverse(object => {
        if ((object as THREE.Mesh).isMesh) (object as THREE.Mesh).geometry.dispose();
    });
}

async function buildAtlas(
    names: string[],
    prepared: Map<string, PreparedIcon>,
    renderer: THREE.WebGPURenderer,
    scene: THREE.Scene,
    camera: THREE.OrthographicCamera,
    atlasTexture: THREE.Texture,
    materials: Map<string, THREE.Material>
): Promise<{ image: HTMLCanvasElement; icons: IconMap }> {
    const grid = atlasGrid(names.length);
    const image = document.createElement('canvas');
    image.width = grid.width;
    image.height = grid.height;
    const context = image.getContext('2d')!;
    context.imageSmoothingEnabled = false;
    const icons: IconMap = new Map();

    for (const [index, name] of names.entries()) {
        const x = index % grid.columns * iconSize;
        const y = Math.floor(index / grid.columns) * iconSize;
        const icon = prepared.get(name);
        if (icon) {
            if (icon.image) {
                context.drawImage(icon.image, x, y, iconSize, iconSize);
            } else {
                await renderIcon(renderer, scene, camera, icon, atlasTexture, materials);
                context.drawImage(renderer.domElement, x, y);
            }
        }
        icons.set(name, { x, y, size: iconSize });
    }
    return { image, icons };
}

async function saveAtlas(name: 'block-atlas.png' | 'item-atlas.png', image: HTMLCanvasElement): Promise<void> {
    const png = await new Promise<Blob>((resolve, reject) => image.toBlob(
        blob => blob ? resolve(blob) : reject(new Error(`Failed to encode ${name}.`)), 'image/png'
    ));
    const saved = await window.ipcApi.saveIconAtlas(name, new Uint8Array(await png.arrayBuffer()));
    if (!saved.success) throw new Error(saved.error ?? `Failed to save ${name}.`);
}

function createIconMap(names: string[], columns: number): IconMap {
    return new Map(names.map((name, index) => [name, {
        x: index % columns * iconSize,
        y: Math.floor(index / columns) * iconSize,
        size: iconSize
    }]));
}

async function loadAtlas(name: 'block-atlas.png' | 'item-atlas.png'): Promise<HTMLCanvasElement | null> {
    const result = await window.ipcApi.getAssetContent(name);
    if (!result.success) return null;
    const url = URL.createObjectURL(new Blob([result.content as BlobPart], { type: 'image/png' }));
    try {
        const source = new Image();
        source.src = url;
        await source.decode();
        const image = document.createElement('canvas');
        image.width = source.width;
        image.height = source.height;
        image.getContext('2d')!.drawImage(source, 0, 0);
        return image;
    } catch {
        return null;
    } finally {
        URL.revokeObjectURL(url);
    }
}

async function loadAtlases(): Promise<ItemIconAtlas | null> {
    const list = await readJson('item-block-list.json');
    const itemNames = [...new Set<string>(list?.items ?? [])];
    const blockNames = [...new Set<string>(list?.blocks ?? [])];
    const [itemImage, blockImage] = await Promise.all([loadAtlas('item-atlas.png'), loadAtlas('block-atlas.png')]);
    return itemImage && blockImage ? {
        itemImage,
        blockImage,
        itemIcons: createIconMap(itemNames, Math.max(1, Math.floor(itemImage.width / iconSize))),
        blockIcons: createIconMap(blockNames, Math.max(1, Math.floor(blockImage.width / iconSize)))
    } : null;
}

async function createAtlases(): Promise<ItemIconAtlas> {
    const list = await readJson('item-block-list.json');
    const itemNames = [...new Set<string>(list?.items ?? [])];
    const blockNames = [...new Set<string>(list?.blocks ?? [])];
    const atlasStart = performance.now();
    const entries = await prepareIcons([...new Set([...itemNames, ...blockNames])]);
    const prepared = new Map(entries.map(entry => [entry.name, entry]));
    const textureAtlas = await buildTextureAtlasForRenderList(
        entries.map(entry => ({ type: 'itemDisplayModel', models: entry.models, blockProps: entry.blockProps })),
        loadTexturePixels
    );
    if (!textureAtlas) throw new Error('Failed to build the item icon texture atlas.');

    const atlasTexture = await createAtlasTexture(textureAtlas.data, textureAtlas.width, textureAtlas.height);
    const renderer = new THREE.WebGPURenderer({ antialias: false, alpha: true, logarithmicDepthBuffer: true });
    renderer.setSize(iconSize, iconSize, false);
    renderer.setClearColor(0x000000, 0);
    await renderer.init();
    const scene = new THREE.Scene();
    const camera = new THREE.OrthographicCamera(-0.5, 0.5, 0.5, -0.5, 0.01, 100);
    const materials = new Map<string, THREE.Material>();

    try {
        const items = await buildAtlas(itemNames, prepared, renderer, scene, camera, atlasTexture, materials);
        const blocks = await buildAtlas(blockNames, prepared, renderer, scene, camera, atlasTexture, materials);
        await Promise.all([saveAtlas('item-atlas.png', items.image), saveAtlas('block-atlas.png', blocks.image)]);
        window.ipcApi.send?.('log-atlas-generation-time', performance.now() - atlasStart);
        return { itemImage: items.image, blockImage: blocks.image, itemIcons: items.icons, blockIcons: blocks.icons };
    } finally {
        entries.forEach(entry => entry.image?.close());
        materials.forEach(material => material.dispose());
        atlasTexture.dispose();
        renderer.dispose();
    }
}

export function getItemIconAtlas(): Promise<ItemIconAtlas> {
    return atlasPromise ??= loadAtlases().then(atlas => atlas ?? createAtlases());
}
