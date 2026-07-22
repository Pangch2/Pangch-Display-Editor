import * as THREE from 'three/webgpu';
import { createEntityMaterial, dragSelectedAttributeName } from '../entity-material';
import { mainThreadAssetProvider } from '../load-project/pbde-assets';
import { buildBlockIconTemplate, buildItemIconModels, type ModelData } from '../load-project/scene-parser';
import { buildTextureAtlasForRenderList, type TexturePixelData } from '../load-project/texture-atlas-builder';

const iconSize = 32;
const atlasVersion = '4';
const minecraftGuiRotation = new THREE.Euler(
    THREE.MathUtils.degToRad(30),
    THREE.MathUtils.degToRad(225),
    0,
    'XYZ'
);

type IconMap = Map<string, { x: number; y: number; size: number }>;
type PreparedIcon = { name: string; models: ModelData[]; rotateAsBlock: boolean };

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

if (import.meta.env.DEV) {
    const grid = atlasGrid(1201);
    console.assert(grid.columns === 35 && grid.width * grid.height / iconSize ** 2 >= 1201, 'Atlas grid is too small.');
    console.assert(Math.round(THREE.MathUtils.radToDeg(minecraftGuiRotation.y)) === 225, 'Minecraft GUI rotation changed.');
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

async function prepareIcons(names: string[], blocks: boolean): Promise<PreparedIcon[]> {
    const icons: PreparedIcon[] = [];
    for (let start = 0; start < names.length; start += 32) {
        const chunk = await Promise.all(names.slice(start, start + 32).map(async name => {
            const models = blocks
                ? (await buildBlockIconTemplate(name, mainThreadAssetProvider))?.models
                : await buildItemIconModels(`${name}[display=gui]`, mainThreadAssetProvider);
            return models ? { name, models: cloneModels(models), rotateAsBlock: blocks } : null;
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
    if (icon.rotateAsBlock) {
        group.rotation.copy(minecraftGuiRotation);
        group.scale.setScalar(0.625);
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
    const viewSize = Math.max(size.x, size.y) / 0.88 || 1;
    camera.left = camera.bottom = -viewSize / 2;
    camera.right = camera.top = viewSize / 2;
    camera.position.set(center.x, center.y, center.z + Math.max(10, size.z * 2));
    camera.lookAt(center);
    camera.updateProjectionMatrix();

    await renderer.renderAsync(scene, camera);
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
            await renderIcon(renderer, scene, camera, icon, atlasTexture, materials);
            context.drawImage(renderer.domElement, x, y);
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
    const [itemEntries, blockEntries] = await Promise.all([
        prepareIcons(itemNames, false),
        prepareIcons(blockNames, true)
    ]);
    const entries = [...itemEntries, ...blockEntries];
    const textureAtlas = await buildTextureAtlasForRenderList(
        entries.map(entry => ({ type: 'itemDisplayModel', models: entry.models })),
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
