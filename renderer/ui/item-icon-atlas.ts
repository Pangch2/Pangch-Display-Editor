import * as THREE from 'three/webgpu';
import { createEntityMaterial, dragSelectedAttributeName } from '../entity-material';
import { mainThreadAssetProvider } from '../load-project/pbde-assets';
import { buildBlockIconTemplate, buildItemIconModels, type ModelData } from '../load-project/scene-parser';
import { buildTextureAtlasForRenderList, type TexturePixelData } from '../load-project/texture-atlas-builder';

const iconSize = 32;
const atlasVersion = '3';
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
    const columns = Math.max(1, Math.ceil(Math.sqrt(count)));
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

function getBlockIconName(name: string): Promise<string> {
    let promise = blockIconNamePromises.get(name);
    if (!promise) {
        promise = (async () => {
            const [namespace, path] = name.includes(':') ? name.split(':', 2) : ['minecraft', name];
            const blockstate = await readJson(`assets/${namespace}/blockstates/${path}.json`)
                ?? await readJson(`hardcoded/blockstates/${path}.json`);
            const properties = defaultBlockProperties(blockstate);
            if (path.endsWith('shulker_box')) properties.facing = 'up';
            const suffix = Object.entries(properties).map(([key, value]) => `${key}=${value}`).join(',');
            return suffix ? `${name}[${suffix}]` : name;
        })();
        blockIconNamePromises.set(name, promise);
    }
    return promise;
}

function findDisplayModelId(value: any): string | null {
    if (typeof value === 'string') return value;
    if (!value || typeof value !== 'object') return null;
    if (typeof value.base === 'string') return value.base;
    if (typeof value.model === 'string') return value.model;
    for (const key of ['model', 'fallback', 'on_true', 'on_false']) {
        const found = findDisplayModelId(value[key]);
        if (found) return found;
    }
    for (const key of ['models', 'cases', 'entries']) {
        for (const entry of Array.isArray(value[key]) ? value[key] : []) {
            const found = findDisplayModelId(entry);
            if (found) return found;
        }
    }
    return null;
}

function needsHardcodedItemGeometry(definition: any): boolean {
    const type = definition?.model?.type;
    return typeof type === 'string' && type !== 'minecraft:model';
}

function usesFlatItemIcon(name: string): boolean {
    return name.endsWith('_sign') || name.endsWith('_amethyst_bud');
}

async function loadFlatItemIcon(name: string): Promise<ImageBitmap | null> {
    try {
        const [namespace, path] = name.includes(':') ? name.split(':', 2) : ['minecraft', name];
        const textureType = name.endsWith('_amethyst_bud') ? 'block' : 'item';
        const asset = await mainThreadAssetProvider.getAsset(`assets/${namespace}/textures/${textureType}/${path}.png`);
        return asset instanceof Uint8Array
            ? createImageBitmap(new Blob([asset as BlobPart], { type: 'image/png' }))
            : null;
    } catch {
        return null;
    }
}

async function usesHardcodedItemGeometry(name: string): Promise<boolean> {
    const [namespace, path] = name.includes(':') ? name.split(':', 2) : ['minecraft', name];
    return needsHardcodedItemGeometry(await readJson(`assets/${namespace}/items/${path}.json`));
}

async function getGuiTransform(name: string): Promise<GuiTransform | null> {
    const [namespace, path] = name.includes(':') ? name.split(':', 2) : ['minecraft', name];
    const definition = await readJson(`assets/${namespace}/items/${path}.json`);
    let modelId = findDisplayModelId(definition?.model) ?? `${namespace}:item/${path}`;
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
    console.assert(grid.columns === 35 && grid.width * grid.height / iconSize ** 2 >= 1201, 'Atlas grid is too small.');
    console.assert(
        defaultBlockProperties({ variants: {
            'facing=east,half=bottom,shape=inner_left': {},
            'facing=north,half=bottom,shape=straight': {}
        }}).shape === 'straight',
        'Default block icon properties changed.'
    );
    console.assert(
        findDisplayModelId({ type: 'minecraft:select', fallback: { type: 'minecraft:special', base: 'minecraft:item/chest' } })
            === 'minecraft:item/chest',
        'Special item display model lookup failed.'
    );
    console.assert(
        needsHardcodedItemGeometry({ model: { type: 'minecraft:special' } })
            && !needsHardcodedItemGeometry({ model: { type: 'minecraft:model' } }),
        'Hardcoded item geometry selection failed.'
    );
    console.assert(
        usesFlatItemIcon('oak_sign')
            && usesFlatItemIcon('oak_hanging_sign')
            && usesFlatItemIcon('small_amethyst_bud')
            && !usesFlatItemIcon('oak_planks'),
        'Flat item icon selection failed.'
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

async function prepareIcons(names: string[], blocks: boolean, blockNames = new Set<string>()): Promise<PreparedIcon[]> {
    const icons: PreparedIcon[] = [];
    for (let start = 0; start < names.length; start += 32) {
        const chunk = await Promise.all(names.slice(start, start + 32).map(async (name): Promise<PreparedIcon | null> => {
            const image = usesFlatItemIcon(name) ? await loadFlatItemIcon(name) : null;
            const itemModels = image ? null : await buildItemIconModels(`${name}[display=gui]`, mainThreadAssetProvider);
            const blockIcon = !image && (blocks || blockNames.has(name)) ? await getBlockIconName(name) : null;
            const blockTemplate = blockIcon
                ? await buildBlockIconTemplate(blockIcon, mainThreadAssetProvider)
                : null;
            const applyHardcodedGuiTransform = !usesFlatItemIcon(name)
                && !!itemModels?.some(model => model.fromHardcoded)
                && await usesHardcodedItemGeometry(name);
            const useBlock = !usesFlatItemIcon(name) && !!blockTemplate && (
                !itemModels || !!blockTemplate.fromHardcoded && applyHardcodedGuiTransform
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
                icon.image.close();
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
    const itemGrid = atlasGrid(itemNames.length);
    const blockGrid = atlasGrid(blockNames.length);
    if (
        itemImage?.width !== itemGrid.width || itemImage.height !== itemGrid.height
        || blockImage?.width !== blockGrid.width || blockImage.height !== blockGrid.height
    ) return null;
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
    const [itemEntries, blockEntries] = await Promise.all([
        prepareIcons(itemNames, false, new Set(blockNames)),
        prepareIcons(blockNames, true)
    ]);
    const entries = [...itemEntries, ...blockEntries];
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
        const items = await buildAtlas(itemNames, new Map(itemEntries.map(entry => [entry.name, entry])), renderer, scene, camera, atlasTexture, materials);
        const blocks = await buildAtlas(blockNames, new Map(blockEntries.map(entry => [entry.name, entry])), renderer, scene, camera, atlasTexture, materials);
        await Promise.all([saveAtlas('item-atlas.png', items.image), saveAtlas('block-atlas.png', blocks.image)]);
        localStorage.setItem('pde-icon-atlas-version', atlasVersion);
        window.ipcApi.send?.('log-atlas-generation-time', performance.now() - atlasStart);
        return { itemImage: items.image, blockImage: blocks.image, itemIcons: items.icons, blockIcons: blocks.icons };
    } finally {
        materials.forEach(material => material.dispose());
        atlasTexture.dispose();
        renderer.dispose();
    }
}

export function getItemIconAtlas(): Promise<ItemIconAtlas> {
    return atlasPromise ??= (localStorage.getItem('pde-icon-atlas-version') === atlasVersion ? loadAtlases() : Promise.resolve(null))
        .then(atlas => atlas ?? createAtlases());
}
