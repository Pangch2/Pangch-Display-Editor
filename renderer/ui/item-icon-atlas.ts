const iconSize = 32;
const columns = 32;

type IconMap = Map<string, { x: number; y: number; size: number }>;
type ResolvedModel = { textures: Record<string, string>; elements: any[] | null };

export type ItemIconAtlas = {
    itemImage: HTMLCanvasElement;
    blockImage: HTMLCanvasElement;
    itemIcons: IconMap;
    blockIcons: IconMap;
};

let atlasPromise: Promise<ItemIconAtlas> | null = null;
const modelCache = new Map<string, Promise<ResolvedModel | null>>();
const imageCache = new Map<string, Promise<HTMLImageElement | null>>();

function decodeJson(content: unknown): any {
    return JSON.parse(new TextDecoder().decode(new Uint8Array(content as ArrayBufferLike)));
}

async function readJson(path: string): Promise<any | null> {
    const result = await window.ipcApi.getAssetContent(path);
    return result.success ? decodeJson(result.content) : null;
}

function resourcePath(id: string, folder: string, extension: string): string {
    const [namespace = 'minecraft', name = id] = id.includes(':') ? id.split(':', 2) : ['minecraft', id];
    return `assets/${namespace}/${folder}/${name}.${extension}`;
}

function findModel(value: unknown): string | null {
    if (!value || typeof value !== 'object') return null;
    const object = value as Record<string, unknown>;
    if (typeof object.model === 'string') return object.model;
    for (const child of Object.values(object)) {
        const values = Array.isArray(child) ? child : [child];
        for (const entry of values) {
            const model = findModel(entry);
            if (model) return model;
        }
    }
    return null;
}

function resolveTexture(value: unknown, textures: Record<string, string>): string | null {
    if (typeof value !== 'string') return null;
    let texture: string | undefined = value;
    for (let depth = 0; texture?.startsWith('#') && depth < 16; depth++) texture = textures[texture.slice(1)];
    return texture && !texture.startsWith('#') ? texture : null;
}

function resolveModel(modelId: string): Promise<ResolvedModel | null> {
    let promise = modelCache.get(modelId);
    if (promise) return promise;
    promise = (async () => {
        const model = await readJson(resourcePath(modelId, 'models', 'json'));
        if (!model) return null;
        const parent = typeof model.parent === 'string' ? await resolveModel(model.parent) : null;
        const textures = { ...(parent?.textures ?? {}) };
        for (const [name, value] of Object.entries(model.textures ?? {})) {
            if (typeof value === 'string') textures[name] = value;
        }
        return { textures, elements: model.elements ?? parent?.elements ?? null };
    })();
    modelCache.set(modelId, promise);
    return promise;
}

function loadImage(texture: string): Promise<HTMLImageElement | null> {
    let promise = imageCache.get(texture);
    if (promise) return promise;
    promise = (async () => {
        const result = await window.ipcApi.getAssetContent(resourcePath(texture, 'textures', 'png'));
        if (!result.success) return null;
        const url = URL.createObjectURL(new Blob([result.content as BlobPart], { type: 'image/png' }));
        try {
            const image = new Image();
            image.src = url;
            await image.decode();
            return image;
        } catch {
            return null;
        } finally {
            URL.revokeObjectURL(url);
        }
    })();
    imageCache.set(texture, promise);
    return promise;
}

function project([x, y, z]: readonly number[]): [number, number, number] {
    x -= 8;
    y -= 8;
    z -= 8;
    const rotatedX = (x - z) * Math.SQRT1_2;
    const rotatedZ = (x + z) * Math.SQRT1_2;
    return [16 + rotatedX * 1.18, 16 + (-y * 0.82 - rotatedZ * 0.48) * 1.18, rotatedZ * 0.82 + y * 0.48];
}

async function drawBlock(context: CanvasRenderingContext2D, model: ResolvedModel, x: number, y: number): Promise<void> {
    const faces: Array<{ points: [number, number, number][]; texture: string; uv: number[]; shade: number; depth: number }> = [];
    for (const element of model.elements ?? []) {
        const [x1, y1, z1] = element.from ?? [0, 0, 0];
        const [x2, y2, z2] = element.to ?? [16, 16, 16];
        const definitions = [
            ['up', [[x1, y2, z1], [x2, y2, z1], [x2, y2, z2], [x1, y2, z2]], 0],
            ['south', [[x2, y2, z2], [x1, y2, z2], [x1, y1, z2], [x2, y1, z2]], 0.16],
            ['east', [[x2, y2, z1], [x2, y2, z2], [x2, y1, z2], [x2, y1, z1]], 0.3]
        ] as const;
        for (const [direction, vertices, shade] of definitions) {
            const face = element.faces?.[direction];
            const texture = resolveTexture(face?.texture, model.textures);
            if (!texture) continue;
            const points = vertices.map(point => project(point)) as [number, number, number][];
            faces.push({
                points,
                texture,
                uv: face.uv ?? [0, 0, 16, 16],
                shade,
                depth: points.reduce((sum, point) => sum + point[2], 0) / 4
            });
        }
    }

    faces.sort((a, b) => a.depth - b.depth);
    for (const face of faces) {
        const texture = await loadImage(face.texture);
        if (!texture) continue;
        const points = face.points.map(([px, py]) => [px + x, py + y]);
        const [u1, v1, u2, v2] = face.uv;
        const sourceX = u1 / 16 * texture.width;
        const sourceY = v1 / 16 * texture.width;
        const sourceWidth = (u2 - u1) / 16 * texture.width;
        const sourceHeight = (v2 - v1) / 16 * texture.width;
        context.save();
        context.beginPath();
        context.moveTo(points[0][0], points[0][1]);
        points.slice(1).forEach(point => context.lineTo(point[0], point[1]));
        context.closePath();
        context.clip();
        context.transform(
            (points[1][0] - points[0][0]) / sourceWidth,
            (points[1][1] - points[0][1]) / sourceWidth,
            (points[3][0] - points[0][0]) / sourceHeight,
            (points[3][1] - points[0][1]) / sourceHeight,
            points[0][0],
            points[0][1]
        );
        context.drawImage(texture, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, sourceWidth, sourceHeight);
        context.restore();
        if (face.shade) {
            context.fillStyle = `rgb(0 0 0 / ${face.shade})`;
            context.beginPath();
            context.moveTo(points[0][0], points[0][1]);
            points.slice(1).forEach(point => context.lineTo(point[0], point[1]));
            context.closePath();
            context.fill();
        }
    }
}

async function drawIcon(context: CanvasRenderingContext2D, name: string, x: number, y: number): Promise<void> {
    const definition = await readJson(resourcePath(name, 'items', 'json'));
    const modelId = findModel(definition?.model);
    const model = modelId && await resolveModel(modelId);
    if (!model) return;
    if (model.elements?.length) return drawBlock(context, model, x, y);
    const textureId = resolveTexture(model.textures.layer0 ?? model.textures.particle ?? Object.values(model.textures)[0], model.textures);
    const texture = textureId && await loadImage(textureId);
    if (texture) context.drawImage(texture, 0, 0, texture.width, texture.width, x, y, iconSize, iconSize);
}

async function buildAtlas(names: string[]): Promise<{ image: HTMLCanvasElement; icons: IconMap }> {
    const image = document.createElement('canvas');
    image.width = columns * iconSize;
    image.height = Math.max(1, Math.ceil(names.length / columns) * iconSize);
    const context = image.getContext('2d')!;
    context.imageSmoothingEnabled = false;
    const icons: IconMap = new Map();
    for (let start = 0; start < names.length; start += 32) {
        await Promise.all(names.slice(start, start + 32).map(async (name, offset) => {
            const index = start + offset;
            const x = index % columns * iconSize;
            const y = Math.floor(index / columns) * iconSize;
            await drawIcon(context, name, x, y);
            icons.set(name, { x, y, size: iconSize });
        }));
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

async function createAtlases(): Promise<ItemIconAtlas> {
    const list = await readJson('item-block-list.json');
    const itemNames = [...new Set<string>(list?.items ?? [])];
    const blockNames = [...new Set<string>(list?.blocks ?? [])];
    const [items, blocks] = await Promise.all([buildAtlas(itemNames), buildAtlas(blockNames)]);
    await Promise.all([saveAtlas('item-atlas.png', items.image), saveAtlas('block-atlas.png', blocks.image)]);
    return { itemImage: items.image, blockImage: blocks.image, itemIcons: items.icons, blockIcons: blocks.icons };
}

export function getItemIconAtlas(): Promise<ItemIconAtlas> {
    return atlasPromise ??= createAtlases();
}
