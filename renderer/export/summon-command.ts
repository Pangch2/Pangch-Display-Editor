import { Matrix4, type Group, type InstancedMesh, type Mesh } from 'three/webgpu';
import type { GroupData } from '../controls/grouping/group';
import { getInstanceModelTransform } from '../load-project/batching/instance-model-transform';
import { getPlayerHeadRenderMatrix } from '../load-project/display/player-head-atlas';
import type { TextDisplayOptions } from '../load-project/display/text-display';
import { getBedItemDisplayModelMatrix, getSkullBlockModelMatrix } from '../load-project/scene/scene-parser';
import { parseSnbt, snbtNumber, SnbtLiteral, stringifySnbt, type SnbtValue } from './snbt';
import { decomposeDisplayTransformation, preserveDisplayTransformation } from './display-transformation';

type Compound = { [key: string]: SnbtValue };
export type SummonExportMode = 'command' | 'datapack';
// 26.3: AbstractCommandBlockEditScreen.setMaxLength / CommandFunction.checkCommandLineLength.
export const summonCommandLimits = { command: 32_500, datapack: 2_000_000 } as const;
function getSummonPrefix(project: Group): string {
  const entity = project.userData.projectDetails?.parentEntity?.trim() || 'item_display';
  const position = project.userData.projectDetails?.summonPosition?.trim() || '~ ~ ~';
  if (!/^(?:[a-z0-9_.-]+:)?[a-z0-9_./-]+$/.test(entity)) throw new Error('부모 엔티티 ID가 올바르지 않습니다.');
  const coordinates = position.split(/\s+/);
  if (coordinates.length !== 3 || coordinates.some(value => !/^(?:[~^](?:[+-]?(?:\d+(?:\.\d*)?|\.\d+))?|[+-]?(?:\d+(?:\.\d*)?|\.\d+))$/.test(value))
      || (coordinates.some(value => value.startsWith('^')) && !coordinates.every(value => value.startsWith('^')))) {
    throw new Error('소환좌표는 유효한 X Y Z 좌표여야 합니다.');
  }
  return `summon ${entity} ${coordinates.join(' ')} `;
}
const resourceId = (value: string) => value.replace(/^minecraft:/, '');
const byte = (value: number) => new SnbtLiteral(value + 'b');
const alphaByte = (value: number) => Math.round(Math.max(0, Math.min(1, value)) * 255);
const argb = (color: string, alpha: number) => (alphaByte(alpha) << 24) | Number.parseInt(color.replace('#', ''), 16);
const isCompound = (value: SnbtValue | undefined): value is Compound => !!value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof SnbtLiteral);
const coloredBlockPattern = /^(white|orange|magenta|light_blue|yellow|lime|pink|gray|light_gray|cyan|purple|blue|brown|green|red|black)_(bed|banner)$/;
// Minecraft 26.3: Entity.load and Display.readAdditionalSaveData in resources/client.
const numericDefaults = Object.entries({ interpolation_duration: 0, start_interpolation: 0, teleport_duration: 0,
  view_range: 1, shadow_radius: 0, shadow_strength: 1, width: 0, height: 0, glow_color_override: -1,
  Fire: 0, Air: 300, OnGround: 0, Invulnerable: 0, invulnerable_time: 0, PortalCooldown: 0,
  CustomNameVisible: 0, Silent: 0, NoGravity: 0, Glowing: 0, TicksFrozen: 0, HasVisualFire: 0, fall_distance: 0 });
const textDefaults = Object.entries({ line_width: 200, text_opacity: -1, background: 0x40000000,
  shadow: 0, see_through: 0, default_background: 0 });
const numberListEquals = (value: SnbtValue | undefined, expected: readonly number[]) => Array.isArray(value)
  && value.length === expected.length && value.every((entry, index) => snbtNumber(entry) === expected[index]);
const identityMatrix = new Matrix4().elements;
const zeroVector = [0, 0, 0];
const zeroAngles = [0, 0];
const unitScale = [1, 1, 1];
const identityRotation = [0, 0, 0, 1];

function rotateBlockY(angle: number): Matrix4 {
  return new Matrix4().makeTranslation(.5, 0, .5).multiply(new Matrix4().makeRotationY(angle))
    .multiply(new Matrix4().makeTranslation(-.5, 0, -.5));
}

export function blockExportParts(id: string, properties: Record<string, string>, editorModel: Matrix4): Array<{ properties: Record<string, string>; matrix: Matrix4 }> {
  const unchanged = [{ properties, matrix: new Matrix4() }];
  if (id.includes(':')) return unchanged;
  const skullModel = getSkullBlockModelMatrix(id, properties);
  if (skullModel) return [{ properties: { ...(/_wall_/.test(id) ? { facing: 'north' } : { rotation: '0' }), ...properties },
    matrix: editorModel.clone().multiply(skullModel.invert()) }];
  const colored = coloredBlockPattern.exec(id);
  if (colored?.[2] === 'bed') {
    // The editor's legacy bed contains both halves, turned around their block centers.
    const inverseFacing = rotateBlockY(({ north: 0, east: Math.PI / 2, south: Math.PI, west: -Math.PI / 2 })[properties.facing ?? 'north'] ?? 0);
    return ['head', 'foot'].map(part => ({
      properties: { ...properties, part },
      matrix: editorModel.clone().multiply(rotateBlockY(Math.PI))
        .multiply(new Matrix4().makeTranslation(0, 0, part === 'foot' ? 1 : 0)).multiply(inverseFacing)
    }));
  }
  if (id === 'chest' || id.endsWith('_chest')) {
    // Legacy chest geometry faces south; the game's default chest state faces north.
    const inverseFacing = rotateBlockY(({ south: 0, west: Math.PI / 2, north: Math.PI, east: -Math.PI / 2 })[properties.facing ?? 'north'] ?? Math.PI);
    return [{ properties, matrix: editorModel.clone().multiply(inverseFacing) }];
  }
  if (colored?.[2] === 'banner') {
    // Legacy geometry uses rotation 0; the game's omitted rotation defaults to 8.
    return [{ properties: { rotation: '0', ...properties }, matrix: editorModel.clone().multiply(rotateBlockY(Number(properties.rotation ?? 0) * Math.PI / 8)) }];
  }
  return unchanged;
}

export function itemExportCorrection(id: string, name: string, display: string, editorModel: Matrix4): Matrix4 {
  const rotation = new Matrix4().makeRotationY(Math.PI);
  if (coloredBlockPattern.exec(id)?.[2] === 'bed') {
    const gameModel = getBedItemDisplayModelMatrix(`${name.split('[')[0]}[display=${display}]`);
    if (!gameModel) throw new Error('침대 아이템 표시 모드의 모델 변환을 찾을 수 없습니다.');
    return editorModel.clone().multiply(rotateBlockY(Math.PI)).multiply(gameModel.invert()).multiply(rotation);
  }
  if (id === 'trident' && !['gui', 'ground', 'fixed', 'on_shelf'].includes(display)) {
    return editorModel.clone().multiply(new Matrix4().makeTranslation(1, 0, 1))
      .multiply(editorModel.clone().invert()).multiply(rotation);
  }
  return id === 'player_head' ? new Matrix4() : rotation;
}

function omitDisplayDefaults(entity: Compound): Compound {
  const type = entity.id ?? 'item_display';
  for (const [key, value] of numericDefaults) if (snbtNumber(entity[key]) === value) delete entity[key];
  if (type === 'text_display') {
    for (const [key, value] of textDefaults) if (snbtNumber(entity[key]) === value) delete entity[key];
    if (entity.alignment === 'center') delete entity.alignment;
    if (entity.text === '' || (isCompound(entity.text) && entity.text.text === '' && Object.keys(entity.text).length === 1)) delete entity.text;
  }
  if (entity.billboard === 'fixed') delete entity.billboard;
  if (type === 'item_display' && entity.item_display === 'none') delete entity.item_display;
  if (numberListEquals(entity.Motion, zeroVector)) delete entity.Motion;
  if (numberListEquals(entity.Pos, zeroVector)) delete entity.Pos;
  if (numberListEquals(entity.Rotation, zeroAngles)) delete entity.Rotation;
  if (Array.isArray(entity.Tags) && !entity.Tags.length) delete entity.Tags;
  if (isCompound(entity.data) && !Object.keys(entity.data).length) delete entity.data;
  const matrix = entity.transformation;
  if (numberListEquals(matrix, identityMatrix) || (isCompound(matrix) && Object.keys(matrix).length === 4
    && numberListEquals(matrix.translation, zeroVector) && numberListEquals(matrix.scale, unitScale)
    && numberListEquals(matrix.left_rotation, identityRotation) && numberListEquals(matrix.right_rotation, identityRotation))) delete entity.transformation;
  else if (matrix) entity.transformation = preserveDisplayTransformation(matrix);
  if (type === 'item_display' && isCompound(entity.item)) {
    if (snbtNumber(entity.item.count) === 1) delete entity.item.count;
    if (isCompound(entity.item.components) && !Object.keys(entity.item.components).length) delete entity.item.components;
  }
  if (type === 'block_display' && isCompound(entity.block_state)) {
    const state = entity.block_state;
    if (isCompound(state.properties) && !Object.keys(state.properties).length) delete state.properties;
    if ((state.id === 'air' || state.id === 'minecraft:air') && Object.keys(state).length === 1) delete entity.block_state;
  }
  return entity;
}

function readNbt(source: string | undefined, target: string): Compound {
  try {
    const text = source?.trim() ?? '';
    if (!text) return {};
    const value = parseSnbt(text.startsWith('{') ? text : '{' + text + '}');
    if (!value || typeof value !== 'object' || Array.isArray(value) || value instanceof SnbtLiteral) throw new Error('NBT 컴파운드가 필요합니다.');
    for (const key of ['id', 'Passengers']) if (Object.prototype.hasOwnProperty.call(value, key)) throw new Error(`${key}는 내보내기 구조 필드와 충돌합니다.`);
    return value;
  } catch (error) {
    throw new Error(`${target}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// Coordinates, matrices and quaternions are single values, not extensible lists.
const fixedListKeys = new Set(['Pos', 'Motion', 'Rotation', 'transformation', 'translation', 'scale', 'left_rotation', 'right_rotation']);

function mergeNbt(parent: Compound, child: Compound): Compound {
  const result = { ...child, ...parent };
  for (const [key, value] of Object.entries(result)) {
    const parentValue = parent[key];
    const childValue = child[key];
    if (isCompound(value)) {
      // Clone compounds so default omission cannot alter NBT inherited by siblings.
      result[key] = mergeNbt(value, isCompound(parentValue) && isCompound(childValue) ? childValue : {});
    } else if (Array.isArray(parentValue) && Array.isArray(childValue) && !fixedListKeys.has(key)) {
      result[key] = [...new Map([...parentValue, ...childValue].map(entry => [stringifySnbt(entry), entry])).values()];
    }
  }
  return result;
}

function textNbt(name: string, options: TextDisplayOptions): Compound {
  const pages = options.pages?.length ? options.pages : [name];
  const hasShadow = (options.shadowAlpha ?? 0) > 0 || !!options.pageShadowAlphas?.some(value => value > 0);
  const components = pages.map((page, index): SnbtValue => {
    const type = options.pageTypes?.[index] ?? 'text';
    const extra = options.pageExtraValues?.[index] ?? {};
    const component: Compound = {};
    if (type === 'sprite') {
      component.sprite = resourceId(page);
      const atlas = resourceId(options.pageAtlases?.[index] ?? 'blocks');
      if (atlas !== 'blocks') component.atlas = atlas;
    } else if (type === 'player') {
      component.player = page;
      if (options.pageHats?.[index] === false) component.hat = byte(0);
    } else if (type === 'score') {
      component.score = { name: page, objective: extra.scoreboard ?? '' };
    } else {
      component[type] = page;
      if (type === 'translate' && extra.fallback) component.fallback = extra.fallback;
      if ((type === 'selector' || type === 'nbt') && extra.separator) component.separator = extra.separator;
      if (type === 'nbt') {
        const source = extra.nbtSource ?? 'entity';
        component[source] = extra[source] ?? '';
        if (extra.interpret) component.interpret = byte(1);
      }
    }
    const color = options.pageColors?.[index] ?? options.color ?? '#ffffff';
    if (color.toLowerCase() !== '#ffffff') component.color = color.toLowerCase();
    if (options.font && resourceId(options.font) !== 'default') component.font = resourceId(options.font);
    for (const [editorKey, nbtKey] of [['bold', 'bold'], ['italic', 'italic'], ['underline', 'underlined'], ['strikeThrough', 'strikethrough'], ['obfuscated', 'obfuscated']] as const) {
      if (options.pageEffects?.[index]?.[editorKey] ?? options[editorKey]) component[nbtKey] = byte(1);
    }
    const shadowAlpha = options.pageShadowAlphas?.[index] ?? options.shadowAlpha ?? 0;
    if (hasShadow) component.shadow_color = new SnbtLiteral(String(argb(options.pageShadowColors?.[index] ?? options.shadowColor ?? '#3f3f3f', shadowAlpha)));
    return type === 'text' && Object.keys(component).length === 1 ? page : component;
  });
  // A neutral first component avoids inheriting the first page's style in a component list.
  const result: Compound = { text: components.length === 1 ? components[0] : typeof components[0] === 'string' ? components : ['', ...components] };
  const width = Math.max(Math.trunc(Number(options.lineLength) || 50), 1) * 4;
  if (width !== 200) result.line_width = new SnbtLiteral(String(width));
  const opacity = alphaByte(options.alpha ?? 1);
  if (opacity !== 255) result.text_opacity = byte(opacity > 127 ? opacity - 256 : opacity);
  const background = argb(options.backgroundColor ?? '#000000', options.backgroundAlpha ?? 0.25);
  if (background !== 0x40000000) result.background = new SnbtLiteral(String(background));
  if (hasShadow) result.shadow = byte(1);
  if (options.align && options.align !== 'center') result.alignment = options.align;
  return result;
}

type NbtChunks = Generator<string | undefined>;

function* createSummonNbt(project: Group, limit: number): NbtChunks {
  const data = project.userData;
  const refs = data.objectUuidToInstance as Map<string, { mesh: Mesh | InstancedMesh; instanceId: number }> | undefined;
  const groups = data.groups as Map<string, GroupData> | undefined;
  const names = data.objectNames as Map<string, string> | undefined;
  const root = readNbt(data.projectDetails?.mainNBT, '프로젝트 mainNBT');
  const defaults = readNbt(data.projectDetails?.nbt, '프로젝트 nbt');
  const seenObjects = new Set<string>();
  const seenGroups = new Set<string>();
  const visitingGroups = new Set<string>();
  project.updateWorldMatrix(true, true);
  const projectInverse = project.matrixWorld.clone().invert();
  const floatCache = new Map<number, string>();
  const matrix = new Matrix4();
  const editorModel = new Matrix4();
  const transform = new Matrix4();
  const identity = new Matrix4();

  const exportObject = (uuid: string, inheritedNbt: Compound): Compound[] => {
    if (seenObjects.has(uuid)) return [];
    seenObjects.add(uuid);
    const ref = refs?.get(uuid);
    const name = names?.get(uuid) ?? '';
    const target = `오브젝트 ${data.objectLabels?.get(uuid) || name || uuid} (${uuid})`;
    if (!ref) throw new Error(`${target}: 씬 인스턴스를 찾을 수 없습니다.`);
    const ownNbt = readNbt(data.objectNbt?.get(uuid), target);
    const customNbt = mergeNbt(inheritedNbt, mergeNbt(ownNbt, defaults));
    const mesh = ref.mesh;
    const meshType = mesh.userData.displayTypes?.get(ref.instanceId) ?? mesh.userData.displayType;
    const type = data.objectTextDisplayOptions?.has(uuid) || meshType === 'text_display' ? 'text_display'
      : (data.objectIsItemDisplay ? data.objectIsItemDisplay.has(uuid) : meshType === 'item_display') ? 'item_display' : 'block_display';
    const entity: Compound = { id: type };
    const storedBrightness = data.objectBrightness?.get(uuid);
    const globalBrightness = data.globalBrightness;
    const editorDefaultBrightness = (storedBrightness?.sky ?? 15) === 15 && (storedBrightness?.block ?? 0) === 0;
    const useGlobalBrightness = !!globalBrightness?.enabled && editorDefaultBrightness;
    const brightness = useGlobalBrightness ? globalBrightness : storedBrightness;
    // Missing brightness uses world lighting; explicit NBT/global overrides require both light channels.
    if (brightness && (useGlobalBrightness || !editorDefaultBrightness)) entity.brightness = { sky: brightness.sky ?? 15, block: brightness.block ?? 0 };
    const itemId = resourceId(name.split('[')[0]);
    const display = data.objectDisplayTypes?.get(uuid) ?? name.match(/\bdisplay=([^,\]]+)/)?.[1] ?? 'none';
    let blockProperties: Record<string, string> = {};
    if (type === 'text_display') {
      Object.assign(entity, textNbt(name, data.objectTextDisplayOptions?.get(uuid) ?? {}));
      const text = customNbt.text;
      if (typeof text === 'string' || Array.isArray(text) || (isCompound(text)
        && ['text', 'sprite', 'player', 'translate', 'keybind', 'score', 'selector', 'nbt'].some(key => text[key] !== undefined))) delete entity.text;
    }
    else if (type === 'block_display') {
      const properties = data.objectBlockProps?.get(uuid) ?? Object.fromEntries((name.match(/\[([^\]]*)\]/)?.[1] ?? '').split(',').filter(Boolean).map(value => value.split('=').map(part => part.trim())));
      blockProperties = Object.fromEntries(Object.entries(properties).map(([key, value]) => [key, String(value)]));
      // StateHolder.CODEC in 26.3 uses lowercase id/properties.
      entity.block_state = { id: itemId, ...(Object.keys(blockProperties).length ? { properties: blockProperties } : {}) };
    } else {
      const item: Compound = { id: itemId };
      if (display !== 'none') entity.item_display = display;
      if (itemId === 'player_head') {
        const components = isCompound(customNbt.item) && isCompound(customNbt.item.components) ? customNbt.item.components : {};
        if (components.profile === undefined && components['minecraft:profile'] === undefined) {
          const texture = data.objectTextures?.get(uuid) as string | undefined;
          if (!texture || !/^https?:\/\/textures\.minecraft\.net\/texture\/[\da-f]+$/i.test(texture)) {
            throw new Error(`${target}: 헤드 페인터의 ‘텍스쳐 생성’을 먼저 사용해 주세요. PNG 또는 누락된 헤드 텍스처는 내보낼 수 없습니다.`);
          }
          const value = btoa(JSON.stringify({ textures: { SKIN: { url: texture } } }));
          item.components = { profile: { properties: [{ name: 'textures', value }] } };
        }
      }
      entity.item = item;
    }
    editorModel.identity();
    if ((mesh as InstancedMesh).isInstancedMesh) {
      (mesh as InstancedMesh).getMatrixAt(ref.instanceId, matrix);
      const instanceModel = getInstanceModelTransform(mesh as InstancedMesh, ref.instanceId);
      editorModel.copy(instanceModel);
      if (mesh.userData.pbdeModelMatrix) editorModel.multiply(transform.fromArray(mesh.userData.pbdeModelMatrix));
      matrix.multiply(instanceModel.invert());
      if (type === 'item_display' && itemId === 'player_head') matrix.multiply(getPlayerHeadRenderMatrix(display).invert());
    } else matrix.identity();
    // Minecraft adds a Y half-turn to item displays. Player heads already use that frame in the editor.
    if (type === 'item_display') {
      try { matrix.multiply(itemExportCorrection(itemId, name, display, editorModel)); }
      catch (error) { throw new Error(`${target}: ${error instanceof Error ? error.message : String(error)}`); }
    }
    matrix.premultiply(mesh.matrixWorld).premultiply(projectInverse);
    let parts = type === 'block_display' ? blockExportParts(itemId, blockProperties, editorModel) : [{ matrix: identity, properties: blockProperties }];
    const bedPart = isCompound(customNbt.block_state) && isCompound(customNbt.block_state.properties) ? customNbt.block_state.properties.part : undefined;
    if (type === 'block_display' && coloredBlockPattern.exec(itemId)?.[2] === 'bed' && (bedPart === 'head' || bedPart === 'foot')) {
      parts = parts.filter(part => part.properties.part === bedPart);
    }
    return parts.map(part => {
      const result: Compound = { ...entity };
      if (type === 'block_display') result.block_state = { id: itemId, ...(Object.keys(part.properties).length ? { properties: part.properties } : {}) };
      transform.copy(matrix).multiply(part.matrix);
      // Keep tiny basis entries; retain the existing translation/near-integer cleanup.
      const elements = transform.elements;
      const zeroTolerance = Math.min(1e-12, 1e-6 * Math.min(Math.hypot(elements[0], elements[1], elements[2]),
        Math.hypot(elements[4], elements[5], elements[6]), Math.hypot(elements[8], elements[9], elements[10])));
      let isIdentity = true;
      for (let index = 0; index < 16; index++) {
        const value = transform.elements[index];
        if (!Number.isFinite(Math.fround(value))) throw new Error(`${target}: 변환에 유한하지 않은 숫자가 있습니다.`);
        const rounded = Math.round(value);
        const snapped = Math.abs(value - rounded) < (rounded === 0 && index < 12 ? zeroTolerance : 1e-5) ? rounded : value;
        transform.elements[index] = snapped;
        if (Math.fround(snapped) !== (index % 5 === 0 ? 1 : 0)) isIdentity = false;
      }
      const customTransformation = customNbt.transformation;
      const partialTransformation = isCompound(customTransformation)
        && ['translation', 'scale', 'left_rotation', 'right_rotation'].some(key => customTransformation[key] === undefined);
      if (!isIdentity || partialTransformation) {
        const elements = transform.transpose().elements.slice();
        result.transformation = partialTransformation ? decomposeDisplayTransformation(elements) : elements;
      }
      return omitDisplayDefaults(mergeNbt(customNbt, result));
    });
  };
  const exportObjects = function* (uuid: string, available: number, inheritedNbt: Compound = {}): NbtChunks {
    for (const entity of exportObject(uuid, inheritedNbt)) {
      const nbt = stringifySnbt(entity, floatCache);
      if (nbt.length > available) throw oversizedEntity(String(entity.id));
      yield nbt;
    }
    // Checkpoints pass through grouping and packing without retaining the entity.
    yield undefined;
  };
  const exportGroup = function* (id: string, available: number, inheritedNbt: Compound = {}): NbtChunks {
    if (visitingGroups.has(id)) throw new Error(`그룹 ${id}: 순환 그룹 구조입니다.`);
    if (seenGroups.has(id)) return;
    const group = groups?.get(id);
    if (!group) throw new Error(`그룹 ${id}: 그룹을 찾을 수 없습니다.`);
    visitingGroups.add(id);
    const ownNbt = readNbt(group.nbt, `그룹 ${group.name} (${id})`);
    const groupNbt = mergeNbt(inheritedNbt, ownNbt);
    const passengers = function* (childLimit: number): NbtChunks {
      for (const child of group.children) {
        if (child.type === 'group') yield* exportGroup(child.id, childLimit, groupNbt);
        else yield* exportObjects(child.id ?? data.instanceKeyToObjectUuid?.get(`${child.mesh.uuid}_${child.instanceId}`), childLimit, groupNbt);
      }
    };
    // Display passengers share the summon origin; group transforms are already in the object matrices.
    if (Object.keys(ownNbt).length) yield* splitPassengers(omitDisplayDefaults(mergeNbt(groupNbt, { id: 'item_display', ...defaults })), passengers, available, `그룹 ${group.name} (${id})`, floatCache);
    else yield* passengers(available);
    visitingGroups.delete(id);
    seenGroups.add(id);
  };
  const passengers = function* (available: number): NbtChunks {
    for (const entry of data.sceneOrder ?? []) {
      if (entry.type === 'group') yield* exportGroup(entry.id, available);
      else yield* exportObjects(entry.id, available);
    }
    for (const [id, group] of groups ?? []) if (!group.parent) yield* exportGroup(id, available);
    for (const id of groups?.keys() ?? []) yield* exportGroup(id, available);
    for (const uuid of refs?.keys() ?? []) if (!seenObjects.has(uuid)) yield* exportObjects(uuid, available);
  };
  yield* splitPassengers(omitDisplayDefaults(root), passengers, limit, '프로젝트 mainNBT', floatCache);
}

export function generateSummonCommand(project: Group): string {
  const summonPrefix = getSummonPrefix(project);
  for (const nbt of createSummonNbt(project, Infinity)) if (nbt !== undefined) return summonPrefix + nbt;
  throw new Error('소환 명령을 생성할 수 없습니다.');
}

const oversizedEntity = (target: string) => new Error(`${target}: 단일 디스플레이 또는 NBT가 글자 수 제한을 초과해 나눌 수 없습니다.`);

function* splitPassengers(entity: Compound, passengers: (limit: number) => NbtChunks, limit: number, target: string, floatCache: Map<number, string>): NbtChunks {
  const nbt = stringifySnbt(entity, floatCache);
  const prefix = nbt.slice(0, -1) + (Object.keys(entity).length ? ',' : '') + 'Passengers:[';
  const suffix = ']}';
  const available = limit - prefix.length - suffix.length;
  let chunk: string[] = [];
  let length = 0;
  for (const part of passengers(available)) {
    if (part === undefined) { yield undefined; continue; }
    if (part.length > available) throw oversizedEntity(target);
    const added = part.length + (chunk.length ? 1 : 0);
    if (length + added > available) {
      if ('UUID' in entity) throw new Error(`${target}: UUID를 지정한 엔티티는 여러 summon으로 나눌 수 없습니다.`);
      yield prefix + chunk.join(',') + suffix;
      chunk = [];
      length = 0;
    }
    length += part.length + (chunk.length ? 1 : 0);
    chunk.push(part);
  }
  if (chunk.length) yield prefix + chunk.join(',') + suffix;
  else {
    if (nbt.length > limit) throw oversizedEntity(target);
    yield nbt;
  }
}

function* summonCommands(project: Group, mode: SummonExportMode): NbtChunks {
  const limit = summonCommandLimits[mode];
  try {
    const summonPrefix = getSummonPrefix(project);
    for (const nbt of createSummonNbt(project, limit - summonPrefix.length)) yield nbt === undefined ? undefined : summonPrefix + nbt;
  } catch (error) {
    throw new Error(`${mode === 'command' ? 'Command' : 'DataPack'} · 최대 ${limit.toLocaleString()}자: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function generateSummonCommands(project: Group, mode: SummonExportMode = 'command'): string[] {
  const commands: string[] = [];
  for (const command of summonCommands(project, mode)) if (command !== undefined) commands.push(command);
  return commands;
}

export async function generateSummonCommandsAsync(project: Group, mode: SummonExportMode = 'command', signal?: AbortSignal): Promise<string[]> {
  signal?.throwIfAborted();
  const commands: string[] = [];
  let deadline = performance.now() + 8;
  let steps = 0;
  for (const command of summonCommands(project, mode)) {
    signal?.throwIfAborted();
    if (command !== undefined) commands.push(command);
    if (++steps % 128 === 0 && performance.now() >= deadline) {
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      signal?.throwIfAborted();
      deadline = performance.now() + 8;
    }
  }
  return commands;
}
