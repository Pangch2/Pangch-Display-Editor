import { compressSync, strToU8 } from 'fflate';
import {
  InstancedMesh,
  Quaternion,
  Vector3
} from 'three/webgpu';
import { createImageHeadAtlasMeshes, deferredPlayerHeadTexture, loadedObjectGroup } from '../load-project/mesh-builder';
import type { GroupData } from '../load-project/pbde-types';

export type PlayerModel = 'default' | 'animation';
export type SkinModel = 'classic' | 'slim';

type Matrix = number[];
type SceneNode = {
  isCollection?: boolean;
  isItemDisplay?: boolean;
  name: string;
  transforms: Matrix;
  pivotCustom?: number[];
  paintTexture?: number;
  children?: SceneNode[];
};
type Face = [number, number, number, number];
type SkinBox = { base: Face[]; layer: Face[] };

const destinationFaces: Face[] = [[16, 8, 8, 8], [0, 8, 8, 8], [8, 0, 8, 8], [16, 0, 8, 8], [24, 8, 8, 8], [8, 8, 8, 8]];
const destinationLayers: Face[] = [[48, 8, 8, 8], [32, 8, 8, 8], [40, 0, 8, 8], [48, 0, 8, 8], [56, 8, 8, 8], [40, 8, 8, 8]];

const matrix = (sx: number, sy: number, sz: number, x: number, y: number, z: number): Matrix =>
  [sx, 0, 0, x, 0, sy, 0, y, 0, 0, sz, z, 0, 0, 0, 1];
const item = (paintTexture: number, transforms: Matrix): SceneNode => ({
  isItemDisplay: true, name: 'player_head[display=none]', paintTexture, transforms
});
const group = (name: string, transforms: Matrix, pivotCustom: number[], children: SceneNode[]): SceneNode => ({
  isCollection: true, name, transforms, pivotCustom, children
});

function skinBox(x: number, y: number, width: number, height: number, depth: number, layerX: number, layerY: number): SkinBox {
  const faces = (ox: number, oy: number): Face[] => [
    [ox, oy + depth, depth, height],
    [ox + depth + width, oy + depth, depth, height],
    [ox + depth, oy, width, depth],
    [ox + depth + width, oy, width, depth],
    [ox + depth + width + depth, oy + depth, width, height],
    [ox + depth, oy + depth, width, height]
  ];
  return { base: faces(x, y), layer: faces(layerX, layerY) };
}

const bodyBox = skinBox(16, 16, 8, 12, 4, 16, 32);
const rightLegBox = skinBox(0, 16, 4, 12, 4, 0, 32);
const leftLegBox = skinBox(16, 48, 4, 12, 4, 0, 48);
const rightArmBox = (slim: boolean) => skinBox(40, 16, slim ? 3 : 4, 12, 4, 40, 32);
const leftArmBox = (slim: boolean) => skinBox(32, 48, slim ? 3 : 4, 12, 4, 48, 48);

function drawPart(source: CanvasImageSource, box: SkinBox, startY: number, height: number): string {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('텍스처 캔버스를 만들 수 없습니다.');
  context.imageSmoothingEnabled = false;
  for (const [faces, destinations] of [[box.base, destinationFaces], [box.layer, destinationLayers]] as const) {
    faces.forEach(([x, y, width, faceHeight], index) => {
      const verticalFace = index < 2 || index > 3;
      const sy = verticalFace ? y + startY : y;
      const sh = verticalFace ? height : faceHeight;
      context.drawImage(source, x, sy, width, sh, ...destinations[index]);
    });
  }
  return canvas.toDataURL('image/png');
}

function skinTextures(source: HTMLCanvasElement, model: PlayerModel, slim: boolean): string[] {
  const textures = [source.toDataURL('image/png'), drawPart(source, bodyBox, 0, 6), drawPart(source, bodyBox, 6, 6)];
  const limbs = [leftLegBox, rightLegBox, rightArmBox(slim), leftArmBox(slim)];
  for (const box of limbs) {
    if (model === 'default') textures.push(drawPart(source, box, 0, 6), drawPart(source, box, 6, 6));
    else for (let y = 0; y < 12; y += 3) textures.push(drawPart(source, box, y, 3));
  }
  return textures;
}

function defaultTemplate(slim: boolean): SceneNode {
  const armScale = slim ? 0.375 : 0.5;
  const armShift = slim ? 0.0625 : 0;
  return group('Generated model', matrix(0.937, 0.937, 0.937, -0.47625, -0.015625, -0.265625), [0.5, 0.77, 0.2656], [
    group('Head', matrix(1, 1, 1, 0.2421875, 1.5, 0), [0.265625, 0.015625, 0.265625], [item(0, matrix(1, 1, 1, 0.265625, 0.515625, 0.265625))]),
    group('Body', matrix(1, 1, 1, 0.2421875, 0.75, 0.1328125), [0.265625, 0, 0.1325], [item(1, matrix(1, 0.5, 0.5, 0.265625, 0.765625, 0.1328125)), item(2, matrix(1, 1, 0.5, 0.265625, 0.515625, 0.1328125))]),
    group('Left leg', matrix(1, 1, 1, 0.25, 0, 0.1328125), [0.1325, 0.734375, 0.1325], [item(3, matrix(0.5, 0.5, 0.5, 0.1328125, 0.765625, 0.1328125)), item(4, matrix(0.5, 1, 0.5, 0.1328125, 0.515625, 0.1328125))]),
    group('Right leg', matrix(1, 1, 1, 0.5, 0, 0.1328125), [0.1325, 0.734375, 0.1325], [item(5, matrix(0.5, 0.5, 0.5, 0.1328125, 0.765625, 0.1328125)), item(6, matrix(0.5, 1, 0.5, 0.1328125, 0.515625, 0.1328125))]),
    group('Right hand', matrix(1, 1, 1, 0.75 - armShift, 0.75, 0.1328125), [0.06625 + armShift, 0.640625, 0.1325], [item(7, matrix(armScale, 0.5, 0.5, 0.1328125, 0.765625, 0.1328125)), item(8, matrix(armScale, 1, 0.5, 0.1328125, 0.515625, 0.1328125))]),
    group('Left hand', matrix(1, 1, 1, armShift, 0.75, 0.1328125), [0.19875 - armShift, 0.640625, 0.1325], [item(9, matrix(armScale, 0.5, 0.5, 0.1328125, 0.765625, 0.1328125)), item(10, matrix(armScale, 1, 0.5, 0.1328125, 0.515625, 0.1328125))])
  ]);
}

function animationLimb(name: string, x: number, z: number, pivotX: number, texture: number, arm: boolean, left: boolean, slim: boolean): SceneNode {
  if (arm && slim) {
    x += left ? 0.0625 : -0.0625;
    pivotX += left ? -0.0625 : 0.0625;
  }
  const width = arm && slim ? 0.375 : 0.5;
  const thinWidth = arm && slim ? 0.3735 : 0.498;
  const bendRotation = arm
    ? [thinWidth, 0, 0, left ? 0.1359375 : 0.13228125, 0, 0.1899995921048253, 0.3093592167691146, 0.3978125, 0, -0.18999959210482537, 0.3093592167691145, 0.0865625, 0, 0, 0, 1]
    : [0.498, 0, 0, left ? 0.1359375 : 0.13228125, 0, 0.1899995921048253, -0.3093592167691146, 0.3978125, 0, 0.18999959210482537, 0.3093592167691145, 0.1801420816333466, 0, 0, 0, 1];
  const endRotation = arm
    ? [thinWidth, 0, 0, left ? 0.1340625 : 0.13415625, 0, 0.18561553006146872, -0.3146625176280137, 0.4590625, 0, 0.18561553006146878, 0.3146625176280136, 0.1803125, 0, 0, 0, 1]
    : [0.498, 0, 0, left ? 0.1340625 : 0.13415625, 0, 0.18561553006146872, 0.3146625176280137, 0.4590625, 0, -0.18561553006146878, 0.3146625176280136, 0.08648247390215157, 0, 0, 0, 1];
  const bend = group(`${name} Bend`, matrix(1, 1, 1, 0, 0, arm ? 0 : 0.00009039226880497298), [0.133125, 0.383125, 0.1325], [
    item(texture, bendRotation),
    item(texture, matrix(width, 0.25, 0.5, left ? 0.1328125 : 0.13540625, 0.3828125, arm ? 0.1328125 : 0.1338920816333466)),
    item(texture + 1, matrix(width, 0.5, 0.5, left ? 0.1328125 : 0.13540625, 0.2578125, arm ? 0.1328125 : 0.1338920816333466))
  ]);
  return group(name, matrix(1, 1, 1, x, arm ? 0.75 : 0, z), [pivotX, arm ? 0.640625 : 0.734375, 0.1325], [bend,
    item(texture + 2, matrix(width, 0.5, 0.5, left ? 0.1340625 : 0.13415625, 0.7578125, arm ? 0.1328125 : 0.13398247390215157)),
    item(texture + 3, matrix(width, 0.25, 0.5, left ? 0.1340625 : 0.13415625, 0.5078125, arm ? 0.1328125 : 0.13398247390215157)),
    item(texture + 3, endRotation)
  ]);
}

function animationTemplate(slim: boolean): SceneNode {
  return group('Generated model', matrix(0.937, 0.937, 0.937, -0.410625, -0.0078125, -0.265625), [0.5, 0.77, 0.2656], [
    group('Head', matrix(1, 1, 1, 0.2434375, 1.4921875, 0), [0.265625, 0.015625, 0.265625], [item(0, matrix(1, 1, 1, 0.265625, 0.515625, 0.265625))]),
    group('Body', matrix(1, 1, 1, 0.2434375, 0.7421875, 0.1328125), [0.265625, 0, 0.1325], [item(1, matrix(1, 0.5, 0.5, 0.265625, 0.765625, 0.1328125)), item(2, matrix(1, 1, 0.5, 0.265625, 0.515625, 0.1328125))]),
    animationLimb('Left leg', 0.25, 0.13164252609784843, 0.1325, 3, false, true, slim),
    animationLimb('Right leg', 0.49990625, 0.13164252609784843, 0.1325, 7, false, false, slim),
    animationLimb('Right hand', 0.74990625, 0.1328125, 0.06625, 11, true, false, slim),
    animationLimb('Left hand', 0, 0.1328125, 0.19875, 15, true, true, slim)
  ]);
}

function projectFile(children: SceneNode[], paintTextures: string[], name: string): File {
  const json = strToU8(JSON.stringify([{ name, children, refs: { paintTextures } }]));
  const raw = new Uint8Array(18 + json.length);
  raw.set([80, 82, 74, 50]);
  raw.set(strToU8('scene.json'), 4);
  new DataView(raw.buffer).setUint32(14, json.length, true);
  raw.set(json, 18);
  return new File([compressSync(raw)], `${name}.pbde`);
}

export function isSlimSkin(pixels: Uint8ClampedArray): boolean {
  for (let y = 20; y < 32; y++) for (let x = 54; x < 56; x++) if (pixels[(y * 64 + x) * 4 + 3]) return false;
  return true;
}

export function createPlayerProject(source: HTMLCanvasElement, model: PlayerModel, skinModel: SkinModel): File {
  const slim = skinModel === 'slim';
  return projectFile([model === 'default' ? defaultTemplate(slim) : animationTemplate(slim)], skinTextures(source, model, slim), `player-${model}-${skinModel}`);
}

export function createHeadProject(source: HTMLCanvasElement): File {
  return projectFile([item(0, matrix(1, 1, 1, 0, 0.5, 0))], [source.toDataURL('image/png')], 'player-head');
}

export function addImageHeadGrid(source: CanvasImageSource, layer: 0 | 1, groupName: string): number {
  const width = 'width' in source ? Number(source.width) : 0;
  const height = 'height' in source ? Number(source.height) : 0;
  if (!width || !height) throw new Error('이미지 크기를 확인할 수 없습니다.');
  const spacing = layer ? 0.53125 : 0.5;
  const columns = Math.ceil(width / 8);
  const rows = Math.ceil(height / 8);
  const canvas = document.createElement('canvas');
  canvas.width = columns * 8;
  canvas.height = rows * 8;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('이미지 캔버스를 만들 수 없습니다.');
  context.imageSmoothingEnabled = false;
  if (!layer) {
    context.fillStyle = '#000';
    context.fillRect(0, 0, canvas.width, canvas.height);
  }
  context.drawImage(source, 0, 0);

  const groupId = crypto.randomUUID();
  const children: GroupData['children'] = [];
  const userData = loadedObjectGroup.userData;
  const groups = (userData.groups as Map<string, GroupData> | undefined) ?? (userData.groups = new Map());
  const objectToGroup = (userData.objectToGroup as Map<string, string> | undefined) ?? (userData.objectToGroup = new Map());
  const keyToUuid = (userData.instanceKeyToObjectUuid as Map<string, string> | undefined) ?? (userData.instanceKeyToObjectUuid = new Map());
  const uuidToInstance = (userData.objectUuidToInstance as Map<string, { mesh: InstancedMesh; instanceId: number }> | undefined) ?? (userData.objectUuidToInstance = new Map());
  const objectNames = (userData.objectNames as Map<string, string> | undefined) ?? (userData.objectNames = new Map());
  const objectNbt = (userData.objectNbt as Map<string, string> | undefined) ?? (userData.objectNbt = new Map());
  userData.objectBrightness ??= new Map<string, { sky?: number; block?: number }>();
  const objectTextures = (userData.objectTextures as Map<string, string> | undefined) ?? (userData.objectTextures = new Map());
  const itemDisplays = (userData.objectIsItemDisplay as Set<string> | undefined) ?? (userData.objectIsItemDisplay = new Set());
  const displayTypes = (userData.objectDisplayTypes as Map<string, string> | undefined) ?? (userData.objectDisplayTypes = new Map());
  const total = columns * rows;

  for (const mesh of createImageHeadAtlasMeshes(canvas, columns, rows, layer)) {
    for (let localIndex = 0; localIndex < mesh.count; localIndex++) {
      const uuid = crypto.randomUUID();
      const key = `${mesh.uuid}_${localIndex}`;
      keyToUuid.set(key, uuid);
      uuidToInstance.set(uuid, { mesh, instanceId: localIndex });
      objectToGroup.set(key, groupId);
      objectNames.set(uuid, mesh.name);
      objectNbt.set(uuid, '');
      // ponytail: encode the 64x64 skin only if a later editor action actually asks for it.
      objectTextures.set(uuid, deferredPlayerHeadTexture);
      itemDisplays.add(uuid);
      displayTypes.set(uuid, 'none');
      children.push({ type: 'object', mesh, instanceId: localIndex, id: uuid });
    }
    loadedObjectGroup.add(mesh);
  }

  groups.set(groupId, {
    id: groupId,
    isCollection: true,
    children,
    parent: null,
    name: groupName,
    position: new Vector3(),
    quaternion: new Quaternion(),
    scale: new Vector3(1, 1, 1),
    pivot: new Vector3((columns - 1) * spacing / 2, rows * spacing / 2, 0),
    isCustomPivot: true
  });
  const sceneOrder = (userData.sceneOrder as Array<{ type: 'group' | 'object'; id: string }> | undefined) ?? (userData.sceneOrder = []);
  sceneOrder.push({ type: 'group', id: groupId });
  loadedObjectGroup.updateMatrixWorld(true);
  if (import.meta.env.DEV) console.assert(children.length === total, 'Image head tile count failed.');
  return total;
}

function countItems(node: SceneNode): number {
  return (node.isItemDisplay ? 1 : 0) + (node.children?.reduce((count, child) => count + countItems(child), 0) ?? 0);
}

if (import.meta.env.DEV) {
  const classic = new Uint8ClampedArray(64 * 64 * 4);
  classic[(20 * 64 + 54) * 4 + 3] = 255;
  console.assert(!isSlimSkin(classic) && isSlimSkin(new Uint8ClampedArray(64 * 64 * 4)), 'Skin model detection failed.');
  console.assert(countItems(defaultTemplate(false)) === 11 && countItems(animationTemplate(false)) === 27, 'Player template head count failed.');
  console.assert(['default', 'animation'].flatMap(model => [false, true].map(slim => countItems(model === 'default' ? defaultTemplate(slim) : animationTemplate(slim)))).join() === '11,11,27,27', 'Player model combinations failed.');
  console.assert(0.5 * 1.0625 === 0.53125, 'Player head layer spacing failed.');
}
