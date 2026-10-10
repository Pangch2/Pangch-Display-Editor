import { Box3, BufferGeometry, Float32BufferAttribute, Group, Material, MathUtils, Mesh, NearestFilter, OrthographicCamera, Scene, SRGBColorSpace, Texture, Vector3, WebGPURenderer } from 'three/webgpu';
import { createEntityMaterial, dragSelectedAttributeName } from '../entity-material';
import { mainThreadAssetProvider } from '../load-project/pbde/pbde-assets';
import { buildBlockIconTemplate, buildItemIconModels, type ModelData } from '../load-project/scene/scene-parser';
import { resolveItemModelParts } from '../load-project/scene/item-model-definition';
import { buildTextureAtlasForRenderList, type TexturePixelData } from '../load-project/scene/texture-atlas-builder';

const iconSize = 64;
const iconAssetPromises = new Map<string, ReturnType<typeof mainThreadAssetProvider.getAsset>>();
const iconAssetProvider = {
    getAsset(path: string): ReturnType<typeof mainThreadAssetProvider.getAsset> {
        let promise = iconAssetPromises.get(path);
        if (!promise) {
            promise = mainThreadAssetProvider.getAsset(path);
            iconAssetPromises.set(path, promise);
        }
        return promise;
    }
};
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
        height: columns * iconSize
    };
}

function cloneModels(models: ModelData[]): ModelData[] {
    return models.map(model => ({
        ...model,
        geometries: model.geometries.map(part => ({ ...part, uvs: [...part.uvs] }))
    }));
}

const blockPropertyDefaults: Record<string, string[]> = {
    age: ['7'],
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
    const properties = Object.fromEntries([...values].flatMap(([key, options]) => {
        const value = preferredBlockProperty(key, [...options]);
        return value ? [[key, value]] : [];
    }));
    if ([...values.values()].some(options => options.has('low') && options.has('tall'))) properties.up = 'true';
    return properties;
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

export function getBlockIconName(name: string): Promise<string> {
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
    const model = resolveItemModelParts(value, 'gui', properties)[0]?.model;
    return model?.base ?? (typeof model?.model === 'string' ? model.model : null);
}

function needsHardcodedItemGeometry(definition: any): boolean {
    const type = definition?.model?.type;
    return typeof type === 'string' && type !== 'minecraft:model';
}

const iconModelOverrides = {
    '2D': ['sign', '*_sign', 'door', '*_door', 'stairs', '*_stairs', 'bars', '*_bars', 'chain', '*_chain', 'light', 'tripwire', 'trident'],
    '3D': ['bed', '*_bed', 'banner', '*_banner', 'shulker_box', '*_shulker_box', 'chest', '*_chest', 'end_portal', 'end_gateway', '*copper_golem_statue']
};

function matchesIconModelOverride(name: string, overrides: string[]): boolean {
    const { path } = parseIconName(name);
    return overrides.some(override => override.startsWith('*') ? path.endsWith(override.slice(1)) : path === override);
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
        const asset = await iconAssetProvider.getAsset(`assets/${textureNamespace}/textures/${texturePath}.png`);
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
    console.assert(
        grid.columns === 35 && grid.width === grid.height && grid.width * grid.height / iconSize ** 2 >= 1201,
        'Atlas grid must be square and large enough.'
    );
    console.assert(
        defaultBlockProperties({ variants: {
            'facing=east,half=bottom,shape=inner_left': {},
            'facing=north,half=bottom,shape=straight': {}
        }}).shape === 'straight',
        'Default block icon properties changed.'
    );
    console.assert(
        defaultBlockProperties({ variants: { 'age=0': {}, 'age=7': {} } }).age === '7',
        'Block icons must prefer the fully-grown age.'
    );
    console.assert(
        defaultBlockProperties({ multipart: [
            { when: { up: 'true' } },
            { when: { east: 'low' } },
            { when: { east: 'tall' } }
        ]}).up === 'true',
        'Wall block icons must include the default center post.'
    );
    console.assert(
        findDisplayModelId({ type: 'minecraft:select', fallback: { type: 'minecraft:special', base: 'minecraft:item/chest' } })
            === 'minecraft:item/chest'
            && findDisplayModelId({
                type: 'minecraft:condition',
                on_false: { model: 'minecraft:item/default' },
                on_true: { model: 'minecraft:item/alternate' }
            }) === 'minecraft:item/default'
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
            && usesBlockIconModel('chest')
            && usesBlockIconModel('minecraft:chest[type=single]')
            && usesBlockIconModel('white_bed')
            && usesBlockIconModel('white_banner')
            && usesBlockIconModel('white_shulker_box')
            && usesBlockIconModel('end_portal')
            && usesBlockIconModel('end_gateway')
            && usesBlockIconModel('test_block[mode=accept]'),
        'Hardcoded icon dimension rules failed.'
    );
}

export type ItemIconAtlas = {
    itemImage: ImageBitmap;
    blockImage: ImageBitmap;
    itemIcons: IconMap;
    blockIcons: IconMap;
};

let atlasPromise: Promise<ItemIconAtlas> | null = null;

async function readJson(path: string): Promise<any | null> {
    try {
        return JSON.parse(String(await iconAssetProvider.getAsset(path)));
    } catch {
        return null;
    }
}

async function loadTexturePixels(texPath: string): Promise<TexturePixelData | null> {
    try {
        const asset = await iconAssetProvider.getAsset(texPath);
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
    const icons = new Array<PreparedIcon | null>(names.length);
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(32, names.length) }, async () => {
        while (cursor < names.length) {
            const index = cursor++;
            const name = names[index];
            const useBlockModel = usesBlockIconModel(name);
            const image = useBlockModel ? null : await loadFlatItemIcon(name);
            const itemModels = image ? null : await buildItemIconModels(`${name}[display=gui]`, iconAssetProvider);
            const blockIcon = !image && (useBlockModel || !itemModels) ? await getBlockIconName(name) : null;
            const blockTemplate = blockIcon
                ? await buildBlockIconTemplate(blockIcon, iconAssetProvider)
                : null;
            const applyHardcodedGuiTransform = !!itemModels?.some(model => model.fromHardcoded)
                && await usesHardcodedItemGeometry(name);
            const useBlock = !!blockTemplate && (
                useBlockModel || !itemModels || !!blockTemplate.fromHardcoded && applyHardcodedGuiTransform
            );
            const models = useBlock ? blockTemplate?.models : itemModels;
            icons[index] = models || image ? {
                name,
                models: models ? cloneModels(models) : [],
                image: image ?? undefined,
                applyGuiTransform: useBlock,
                guiTransform: useBlock ? await getGuiTransform(name) : null,
                blockProps: useBlock ? blockTemplate?.blockProps : undefined
            } : null;
        }
    }));
    return icons.filter((icon): icon is PreparedIcon => icon !== null);
}

function createAtlasTexture(data: Uint8ClampedArray, width: number, height: number): Promise<Texture> {
    return createImageBitmap(new ImageData(new Uint8ClampedArray(data), width, height)).then(bitmap => {
        const texture = new Texture(bitmap);
        texture.magFilter = NearestFilter;
        texture.minFilter = NearestFilter;
        texture.generateMipmaps = false;
        texture.colorSpace = SRGBColorSpace;
        texture.needsUpdate = true;
        return texture;
    });
}

function createModelGroup(
    icon: PreparedIcon,
    atlasTexture: Texture,
    materials: Map<string, Material>
): Group {
    const group = new Group();
    if (icon.applyGuiTransform) {
        const { rotation, translation, scale } = icon.guiTransform ?? defaultBlockGuiTransform;
        group.position.set(translation?.[0] ?? 0, translation?.[1] ?? 0, translation?.[2] ?? 0).multiplyScalar(1 / 16);
        group.rotation.set(
            MathUtils.degToRad(rotation?.[0] ?? 0),
            MathUtils.degToRad(rotation?.[1] ?? 0),
            MathUtils.degToRad(rotation?.[2] ?? 0),
            'XYZ'
        );
        if (matchesIconModelOverride(icon.name, ['*_bed'])) group.rotation.y += Math.PI;
        group.scale.set(scale?.[0] ?? 1, scale?.[1] ?? 1, scale?.[2] ?? 1);
    }

    for (const model of icon.models) for (const part of model.geometries) {
        const geometry = new BufferGeometry();
        geometry.setAttribute('position', new Float32BufferAttribute(part.positions, 3));
        geometry.setAttribute('normal', new Float32BufferAttribute(part.normals, 3));
        geometry.setAttribute('uv', new Float32BufferAttribute(part.uvs, 2));
        geometry.setAttribute(dragSelectedAttributeName, new Float32BufferAttribute(new Float32Array(part.positions.length / 3), 1));
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

        const mesh = new Mesh(geometry, material);
        mesh.matrix.fromArray(model.modelMatrix);
        mesh.matrixAutoUpdate = false;
        group.add(mesh);
    }
    return group;
}

function placeIconGroup(group: Group, x: number, y: number): Group {
    group.updateMatrixWorld(true);
    const bounds = new Box3().setFromObject(group);
    const center = bounds.getCenter(new Vector3());
    const size = bounds.getSize(new Vector3());
    const scale = 0.88 / Math.max(1, size.x, size.y);
    const cell = new Group();
    cell.add(group);
    cell.scale.setScalar(scale);
    cell.position.set(x - center.x * scale, y - center.y * scale, -center.z * scale);
    return cell;
}

async function buildAtlases(
    itemNames: string[],
    blockNames: string[],
    prepared: Map<string, PreparedIcon>,
    renderer: WebGPURenderer,
    scene: Scene,
    camera: OrthographicCamera,
    atlasTexture: Texture,
    materials: Map<string, Material>
): Promise<{
    items: { image: OffscreenCanvas; icons: IconMap };
    blocks: { image: OffscreenCanvas; icons: IconMap };
}> {
    const targets = [itemNames, blockNames].map(names => {
        const grid = atlasGrid(names.length);
        const image = new OffscreenCanvas(grid.width, grid.height);
        const context = image.getContext('2d', { willReadFrequently: true })!;
        context.imageSmoothingEnabled = false;
        return { image, context, icons: createIconMap(names, grid.columns) };
    });

    const modelNames = [...prepared.values()].filter(icon => !icon.image).map(icon => icon.name);
    const grid = atlasGrid(modelNames.length);
    const modelPositions = createIconMap(modelNames, grid.columns);
    const rendered = document.createElement('canvas');
    rendered.width = grid.width;
    rendered.height = grid.height;
    if (modelNames.length) {
        renderer.setSize(grid.width, grid.height, false);
        camera.left = 0;
        camera.right = grid.columns;
        camera.top = 0;
        camera.bottom = -grid.columns;
        camera.position.set(0, 0, 10);
        camera.lookAt(0, 0, 0);
        camera.updateProjectionMatrix();
        for (const name of modelNames) {
            const position = modelPositions.get(name)!;
            scene.add(placeIconGroup(
                createModelGroup(prepared.get(name)!, atlasTexture, materials),
                position.x / iconSize + 0.5, -position.y / iconSize - 0.5
            ));
        }
        await renderer.compileAsync(scene, camera);
        renderer.render(scene, camera);
        // Copy the GPU canvas once; all per-icon crops then use this 2D canvas.
        rendered.getContext('2d')!.drawImage(renderer.domElement, 0, 0);
    }

    for (const name of new Set([...itemNames, ...blockNames])) {
        const icon = prepared.get(name);
        if (!icon) continue;
        for (const target of targets) {
            const position = target.icons.get(name);
            if (!position) continue;
            if (icon.image) {
                target.context.drawImage(icon.image, position.x, position.y, iconSize, iconSize);
            } else {
                const source = modelPositions.get(name)!;
                target.context.drawImage(rendered, source.x, source.y, iconSize, iconSize,
                    position.x, position.y, iconSize, iconSize);
            }
        }
    }
    rendered.width = rendered.height = 0;
    return {
        items: { image: targets[0].image, icons: targets[0].icons },
        blocks: { image: targets[1].image, icons: targets[1].icons }
    };
}

async function saveAtlas(name: 'block-atlas.png' | 'item-atlas.png', image: OffscreenCanvas): Promise<void> {
    const png = await image.convertToBlob({ type: 'image/png' });
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

async function loadAtlas(name: 'block-atlas.png' | 'item-atlas.png'): Promise<ImageBitmap | null> {
    const result = await window.ipcApi.getAssetContent(name);
    if (!result.success) return null;
    try {
        return await createImageBitmap(new Blob([result.content as BlobPart], { type: 'image/png' }));
    } catch {
        return null;
    }
}

async function loadAtlases(): Promise<ItemIconAtlas | null> {
    const list = await readJson('item-block-list.json');
    const itemNames = [...new Set<string>(list?.items ?? [])];
    const blockNames = [...new Set<string>(list?.blocks ?? [])];
    const [itemImage, blockImage] = await Promise.all([loadAtlas('item-atlas.png'), loadAtlas('block-atlas.png')]);
    if (!itemImage || !blockImage) {
        itemImage?.close();
        blockImage?.close();
        return null;
    }
    return {
        itemImage,
        blockImage,
        itemIcons: createIconMap(itemNames, Math.max(1, Math.floor(itemImage.width / iconSize))),
        blockIcons: createIconMap(blockNames, Math.max(1, Math.floor(blockImage.width / iconSize)))
    };
}

async function createAtlases(): Promise<ItemIconAtlas> {
    window.dispatchEvent(new Event('pde:creating-icon-atlases'));
    const atlasStart = performance.now();
    let entries: PreparedIcon[] = [];
    let atlasTexture: Texture | undefined;
    let renderer: WebGPURenderer | undefined;
    let outputCanvases: OffscreenCanvas[] = [];
    const scene = new Scene();
    const camera = new OrthographicCamera(-0.5, 0.5, 0.5, -0.5, 0.01, 100);
    const materials = new Map<string, Material>();

    try {
        const list = await readJson('item-block-list.json');
        const itemNames = [...new Set<string>(list?.items ?? [])];
        const blockNames = [...new Set<string>(list?.blocks ?? [])];
        entries = await prepareIcons([...new Set([...itemNames, ...blockNames])]);
        const prepared = new Map(entries.map(entry => [entry.name, entry]));
        const textureAtlas = await buildTextureAtlasForRenderList(
            entries.map(entry => ({ type: 'itemDisplayModel', models: entry.models, blockProps: entry.blockProps })),
            loadTexturePixels
        );
        if (!textureAtlas) throw new Error('Failed to build the item icon texture atlas.');

        atlasTexture = await createAtlasTexture(textureAtlas.data, textureAtlas.width, textureAtlas.height);
        renderer = new WebGPURenderer({ antialias: false, alpha: true, logarithmicDepthBuffer: true });
        renderer.setClearColor(0x000000, 0);
        await renderer.init();
        const { items, blocks } = await buildAtlases(
            itemNames, blockNames, prepared, renderer, scene, camera, atlasTexture, materials
        );
        outputCanvases = [items.image, blocks.image];
        await Promise.all([saveAtlas('item-atlas.png', items.image), saveAtlas('block-atlas.png', blocks.image)]);
        window.ipcApi.send?.('log-atlas-generation-time', performance.now() - atlasStart);
        const itemImage = items.image.transferToImageBitmap();
        try {
            const blockImage = blocks.image.transferToImageBitmap();
            return { itemImage, blockImage, itemIcons: items.icons, blockIcons: blocks.icons };
        } catch (error) {
            itemImage.close();
            throw error;
        }
    } finally {
        iconAssetPromises.clear();
        entries.forEach(entry => entry.image?.close());
        scene.traverse(object => {
            if (object instanceof Mesh) object.geometry.dispose();
        });
        materials.forEach(material => material.dispose());
        (atlasTexture?.image as ImageBitmap | undefined)?.close();
        atlasTexture?.dispose();
        outputCanvases.forEach(canvas => { canvas.width = canvas.height = 0; });
        if (renderer) {
            await renderer.dispose();
            renderer.domElement.width = renderer.domElement.height = 0;
        }
    }
}

export function getItemIconAtlas(): Promise<ItemIconAtlas> {
    return atlasPromise ??= loadAtlases().then(atlas => atlas ?? createAtlases());
}
