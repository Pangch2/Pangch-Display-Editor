import {
  Camera,
  InstancedMesh,
  Matrix3,
  Matrix4,
  Raycaster,
  RenderTarget,
  RGBAFormat,
  Scene,
  UnsignedByteType,
  Vector2,
  Vector3,
  WebGPURenderer
} from 'three/webgpu';
import {
  commitPlayerHeadPaint,
  getPlayerHeadPaintSurface,
  loadAndRenderPbde,
  loadedObjectGroup,
  mirrorPlayerHeadPaint,
  readPlayerHeadPaint,
  replaceDisplayObjects,
  setPlayerHeadLayerVisible,
  writePlayerHeadPaint,
  type PlayerHeadPaintSurface
} from '../load-project/mesh-builder';
import { currentSelection } from '../controls/selection/select';
import {
  getHeadPainterFaceAxes,
  invalidateHeadPainterGridOverlay,
  removeHeadPainterStampPreview,
  removeHeadPainterGridOverlay,
  updateHeadPainterStampPreview,
  updateHeadPainterGridOverlay
} from '../controls/selection/overlay';
import { record } from '../controls/undo-redo/undo-redo';
import { isShortcutPressed, matchesShortcut } from '../controls/input/shortcuts';
import { dragDeltaMatrix, dragSelectedAttributeName } from '../entity-material';
import { oklchToRgb, openColorPicker, rgbToOklch } from './color-picker';
import { closeWithAnimation, openWithAnimation } from './ui-open-close.js';
import { isSceneObjectVisible } from '../controls/scene-visibility';
import { intersectSceneInstances } from '../controls/selection/instance-raycast';
import { captureSceneState, recordSceneChange } from '../controls/undo-redo/scene-history';
import { getLinkedMirrorUuid, isMirrorModelingEnabled } from '../controls/transform/mirroring';
import { addImageHeadGrid, createHeadProject, createPlayerProject, isSlimSkin, type PlayerModel, type SkinModel } from './player-generator';
import playerHeadIcon from '../../resources/player_head.svg?raw';

const generatorPlayerHeadIcon = playerHeadIcon.replace(/stroke="[^"]+"/, 'stroke="currentColor"');

type Tool = 'brush' | 'bucket' | 'eraser' | 'picker' | 'stamp' | 'select';
type LayerMode = 'auto' | 'layer' | 'base';
type Rgba = [number, number, number, number];
type BrushAsset = { name: string; width: number; height: number; pixels: Array<Rgba | null>; strength?: number; spacing?: number };
type PaletteAsset = { colors: Array<Rgba | null> };
type PainterContext = {
  renderer: WebGPURenderer;
  scene: Scene;
  getCamera: () => Camera;
  isGizmoHovered: () => boolean;
  suspendCameraControls: () => () => void;
};
type PaintHit = {
  mesh: InstancedMesh;
  instanceId: number;
  surface: PlayerHeadPaintSurface;
  face: number;
  layer: 0 | 1;
  x: number;
  y: number;
  columns: number;
  rows: number;
  promote: boolean;
};
type WorkSurface = {
  surface: PlayerHeadPaintSurface;
  before: ImageData;
  beforeTexture?: string;
  image: ImageData;
  changed: boolean;
};
const atlasSize = 2048;
const blockWidth = 24;
const blockHeight = 32;
const partSize = 8;
const facePartIndexes = [1, 0, 2, 3, 4, 5] as const;
const faceGridAxes = [[2, 1], [2, 1], [0, 2], [0, 2], [0, 1], [0, 1]] as const;
const toolIcons: Record<Tool, string> = { brush: '\uE1D3', bucket: '\uE2E6', eraser: '\uE28F', picker: '\uE13B', stamp: '\uE3BB', select: '\uE121' };
const toolLabels: Record<Tool, string> = { brush: '브러시', bucket: '양동이', eraser: '지우개', picker: '색상선택', stamp: '스탬프', select: '선택' };
const brushOrderKey = 'pdeHeadPainterBrushOrder';
const paletteOrderKey = 'pdeHeadPainterPaletteOrder';
const sectionOrderKey = 'pdeHeadPainterSectionOrder';
const gridColorKey = 'pdeHeadPainterGridColor';
const sectionIds = ['grid', 'brush', 'palette', 'model-generator', 'texture-generator'] as const;
const gridOverrides = new Map<string, Partial<{ horizontal: number; vertical: number }>>();
const raycaster = new Raycaster();
const pointer = new Vector2();
const paintTextureUpdateIntervalMs = 1000 / 30;
const paintTextureUpdateTimes = new WeakMap<object, number>();

let painterContext: PainterContext | null = null;
let active = false;
let lastTool: Tool = 'brush';
let layerMode: LayerMode = 'auto';
let gridHorizontal = 8;
let gridVertical = 8;
let gridEnabled = true;
let smartGrid = true;
let gridColor: [number, number, number] = [112, 199, 255];
let brushWidth = 1;
let brushHeight = 1;
let brushStrength = 100;
let brushSpacing = 25;
let brushShape: 'square' | 'circle' | 'custom' = 'square';
let eraserSize = 1;
let eraserHardness = 100;
let eraserStrength = 100;
let overwrite = false;
let paintAdjacentHeads = true;
let colorMode: 'rgb' | 'oklch' = 'rgb';
let currentColor: Rgba = [0, 0, 0, 255];
let palette: Array<Rgba | null> = Array(64).fill(null);
let defaultPalette: Array<Rgba | null> = Array(64).fill(null);
let activePaletteSlot = 0;
let paletteAnchor: number | null = null;
let activePalettePreset: string | null = null;
let palettePresetNames: string[] = [];
let customBrushes: BrushAsset[] = [];
let selectedBrushName: string | null = null;
let stampWidth = 8;
let stampHeight = 8;
let stampPixels: Array<Rgba | null> = Array(64).fill(null);
let stroke: Map<string, WorkSurface> | null = null;
let lastStrokeHit: PaintHit | null = null;
let paintPointerId: number | null = null;
let paintHeadUuid: string | null = null;
let deferredPaint: { pointerId: number; x: number; y: number } | null = null;
let restoreCameraControls: (() => void) | null = null;
let altPicking = false;
let pickingColor = false;
let promotingImageHead = false;
let pickerCursorBefore: string | null = null;
let colorTarget: RenderTarget | null = null;
let root: HTMLElement | null = null;
let brushEditor: HTMLElement | null = null;
let editingBrush: BrushAsset | null = null;
let editorColor: Rgba = [0, 0, 0, 255];
let selectedBrushPixels = new Set<string>();
let brushSelectionAnchor: { x: number; y: number } | null = null;
let brushSelectionActive = false;
let brushUndo: BrushAsset[] = [];
let brushRedo: BrushAsset[] = [];
let pointerMoveFrame = 0;
let pendingPointerMove: PointerEvent | null = null;

const clampByte = (value: number): number => Math.round(Math.min(255, Math.max(0, value)));
const clampGrid = (value: number): number => Math.round(Math.min(8, Math.max(0, Number.isFinite(value) ? value : 0)));
const cloneRgba = (color: Rgba): Rgba => [...color] as Rgba;
const formatHexColor = (color: readonly number[]): string => `#${color.slice(0, 3).map(channel => channel.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
const colorForLayer = (color: Rgba, layer: number): Rgba => layer ? color : [color[0], color[1], color[2], 255];
const cloneImage = (image: ImageData): ImageData => new ImageData(new Uint8ClampedArray(image.data), image.width, image.height);
const rgbaEqual = (a: Rgba | null, b: Rgba | null): boolean => !!a === !!b && (!a || !b || a.every((value, index) => value === b[index]));

function formatColor(color: Rgba): string {
  if (colorMode === 'rgb') return formatHexColor(color);
  const [lightness, chroma, hue] = rgbToOklch(color.slice(0, 3) as [number, number, number]);
  return `oklch(${lightness.toFixed(3)} ${chroma.toFixed(3)} ${hue.toFixed(1)})`;
}

function parseColor(value: string, alpha: number): Rgba | null {
  const hex = /^#?([\da-f]{6})$/i.exec(value.trim());
  if (hex) return [0, 2, 4].map(index => parseInt(hex[1].slice(index, index + 2), 16)).concat(clampByte(alpha)) as Rgba;
  const match = /^oklch\(\s*([\d.]+)(%)?\s+([\d.]+)\s+(-?[\d.]+)(?:deg)?\s*\)$/i.exec(value.trim());
  if (!match) return null;
  return [...oklchToRgb([Number(match[1]) / (match[2] ? 100 : 1), Number(match[3]), Number(match[4])]), clampByte(alpha)];
}

const cachedGridColor = parseColor(localStorage.getItem(gridColorKey) ?? '', 255);
if (cachedGridColor) gridColor = cachedGridColor.slice(0, 3) as [number, number, number];

function interpolateColor(a: Rgba, b: Rgba, amount: number): Rgba {
  const first = rgbToOklch(a.slice(0, 3) as [number, number, number]);
  const second = rgbToOklch(b.slice(0, 3) as [number, number, number]);
  const hueDelta = ((second[2] - first[2] + 540) % 360) - 180;
  return [...oklchToRgb([
    first[0] + (second[0] - first[0]) * amount,
    first[1] + (second[1] - first[1]) * amount,
    first[2] + hueDelta * amount
  ]), clampByte(a[3] + (b[3] - a[3]) * amount)];
}

function pixelOffset(part: number, x: number, y: number): number {
  return ((Math.floor(part / 3) * partSize + y) * blockWidth + (part % 3) * partSize + x) * 4;
}

const gridBoundary = (index: number, count: number): number => Math.round(index * partSize / count);
const gridCellCenter = (index: number, count: number): number => (gridBoundary(index, count) + gridBoundary(index + 1, count)) / (partSize * 2);

function forEachGridPixel(columns: number, rows: number, x: number, y: number, visit: (pixelX: number, pixelY: number) => void): void {
  for (let pixelY = gridBoundary(y, rows); pixelY < gridBoundary(y + 1, rows); pixelY++) {
    for (let pixelX = gridBoundary(x, columns); pixelX < gridBoundary(x + 1, columns); pixelX++) visit(pixelX, pixelY);
  }
}

function gridCellPixel(index: number, count: number): number {
  return Math.floor((gridBoundary(index, count) + gridBoundary(index + 1, count) - 1) / 2);
}

function readPixel(image: ImageData, part: number, x: number, y: number): Rgba {
  const offset = pixelOffset(part, x, y);
  return [image.data[offset], image.data[offset + 1], image.data[offset + 2], image.data[offset + 3]];
}

function writePixel(image: ImageData, part: number, x: number, y: number, color: Rgba): boolean {
  const offset = pixelOffset(part, x, y);
  if (color.every((value, index) => image.data[offset + index] === value)) return false;
  image.data.set(color, offset);
  return true;
}

function sourceOver(destination: Rgba, source: Rgba, coverage: number): Rgba {
  const sourceAlpha = source[3] / 255 * coverage;
  const destinationAlpha = destination[3] / 255;
  const alpha = sourceAlpha + destinationAlpha * (1 - sourceAlpha);
  if (alpha <= 0) return [0, 0, 0, 0];
  return [0, 1, 2].map(index => Math.round(
    (source[index] * sourceAlpha + destination[index] * destinationAlpha * (1 - sourceAlpha)) / alpha
  )).concat(Math.round(alpha * 255)) as Rgba;
}

function getRaycastHit(deselectOnMiss = false): PaintHit | null {
  if (!painterContext) return null;
  loadedObjectGroup.updateMatrixWorld(true);
  const intersection = intersectSceneInstances(raycaster, loadedObjectGroup, (mesh, instanceId) => {
    const uuid = (loadedObjectGroup.userData.instanceKeyToObjectUuid as Map<string, string> | undefined)
      ?.get(`${mesh.uuid}_${instanceId}`);
    return !uuid || isSceneObjectVisible(loadedObjectGroup, uuid);
  });
  if (!intersection) {
    if (deselectOnMiss) (loadedObjectGroup.userData.resetSelection as (() => void) | undefined)?.();
    return null;
  }
  if (!(intersection.object as InstancedMesh).isInstancedMesh || intersection.instanceId === undefined || !intersection.uv || intersection.faceIndex === undefined) return null;
  const mesh = intersection.object as InstancedMesh;
  const surface = getPlayerHeadPaintSurface(mesh, intersection.instanceId);
  if (!surface) return null;
  const imageLayer = mesh.userData.imageHeadLayer as 0 | 1 | undefined;
  const imageOverlay = imageLayer !== undefined && intersection.faceIndex >= 24;
  const triangle = intersection.faceIndex % 24;
  const actualLayer = imageOverlay ? imageLayer : triangle >= 12 ? 1 : 0;
  const face = imageOverlay ? 4 : Math.floor((triangle % 12) / 2);
  const actualPart = facePartIndexes[face] + actualLayer * 6;
  const partX = (actualPart % 3) * partSize;
  const partY = Math.floor(actualPart / 3) * partSize;
  const pixelX = Math.min(7, Math.max(0, Math.floor(intersection.uv.x * atlasSize - partX)));
  const pixelY = Math.min(7, Math.max(0, Math.floor(blockHeight - intersection.uv.y * atlasSize - partY)));
  const matrix = getInstanceWorldMatrix(mesh, intersection.instanceId, new Matrix4());
  const [horizontal, vertical] = getFaceGridCounts(surface.objectUuid, face, matrix);
  const columns = Math.max(1, horizontal);
  const rows = Math.max(1, vertical);
  const x = Math.min(columns - 1, Math.floor((pixelX + 0.5) * columns / partSize));
  const y = Math.min(rows - 1, Math.floor((pixelY + 0.5) * rows / partSize));
  const packed = readPlayerHeadPaint(surface);
  const layer = imageOverlay ? imageLayer : layerMode === 'layer' ? 1 : layerMode === 'base' ? 0
    : readPixel(packed, facePartIndexes[face] + 6, gridCellPixel(x, columns), gridCellPixel(y, rows))[3] > 0 ? 1 : 0;
  return { mesh, instanceId: intersection.instanceId, surface, face, layer, x, y, columns, rows, promote: imageLayer !== undefined && !imageOverlay };
}

function getHit(event: PointerEvent, deselectOnMiss = false): PaintHit | null {
  if (!painterContext) return null;
  const rect = painterContext.renderer.domElement.getBoundingClientRect();
  pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1);
  raycaster.layers.enable(2);
  raycaster.setFromCamera(pointer, painterContext.getCamera());
  return getRaycastHit(deselectOnMiss);
}

function getWork(hit: PaintHit): WorkSurface {
  if (!stroke) stroke = new Map();
  let work = stroke.get(hit.surface.objectUuid);
  if (!work) {
    const surface = getPlayerHeadPaintSurface(hit.mesh, hit.instanceId, true)!;
    const image = readPlayerHeadPaint(surface);
    const beforeTexture = (loadedObjectGroup.userData.objectTextures as Map<string, string> | undefined)?.get(surface.objectUuid);
    work = { surface, before: cloneImage(image), beforeTexture, image, changed: false };
    stroke.set(surface.objectUuid, work);
    if (isMirrorModelingEnabled()) {
      const partnerUuid = getLinkedMirrorUuid(loadedObjectGroup, surface.objectUuid);
      const partner = partnerUuid
        ? (loadedObjectGroup.userData.objectUuidToInstance as Map<string, { mesh: InstancedMesh; instanceId: number }> | undefined)?.get(partnerUuid)
        : undefined;
      const partnerSurface = partner ? getPlayerHeadPaintSurface(partner.mesh, partner.instanceId, true) : null;
      if (partnerSurface && !stroke.has(partnerSurface.objectUuid)) {
        const partnerImage = readPlayerHeadPaint(partnerSurface);
        const partnerTexture = (loadedObjectGroup.userData.objectTextures as Map<string, string> | undefined)?.get(partnerSurface.objectUuid);
        stroke.set(partnerSurface.objectUuid, {
          surface: partnerSurface,
          before: cloneImage(partnerImage),
          beforeTexture: partnerTexture,
          image: partnerImage,
          changed: false
        });
      }
    }
  }
  return work;
}

function flushWork(work: WorkSurface): void {
  const flushed = [work];
  const partnerUuid = isMirrorModelingEnabled() ? getLinkedMirrorUuid(loadedObjectGroup, work.surface.objectUuid) : undefined;
  const partner = partnerUuid ? stroke?.get(partnerUuid) : undefined;
  if (work.changed && partner) {
    partner.image = mirrorPlayerHeadPaint(work.image, 'x');
    partner.changed = true;
    flushed.push(partner);
  }
  flushed.forEach(target => writePlayerHeadPaint(target.surface, target.image, false));
  const now = performance.now();
  flushed.forEach(target => {
    const lastUpdate = paintTextureUpdateTimes.get(target.surface.texture) ?? -Infinity;
    if (now - lastUpdate < paintTextureUpdateIntervalMs) return;
    target.surface.texture.needsUpdate = true;
    paintTextureUpdateTimes.set(target.surface.texture, now);
  });
}

function finishStroke(): void {
  if (!stroke) return;
  const changes = [...stroke.values()].filter(work => work.changed).map(work => ({
    surface: work.surface,
    before: work.before,
    beforeTexture: work.beforeTexture,
    after: cloneImage(work.image)
  }));
  stroke = null;
  lastStrokeHit = null;
  if (!changes.length) return;
  changes.forEach(({ surface }) => commitPlayerHeadPaint(surface));
  window.dispatchEvent(new CustomEvent('pde:scene-updated'));
  const apply = (key: 'before' | 'after') => {
    changes.forEach(change => {
      writePlayerHeadPaint(change.surface, change[key]);
      commitPlayerHeadPaint(change.surface);
      if (key === 'before') {
        const textures = loadedObjectGroup.userData.objectTextures as Map<string, string> | undefined;
        if (change.beforeTexture === undefined) textures?.delete(change.surface.objectUuid);
        else textures?.set(change.surface.objectUuid, change.beforeTexture);
      }
    });
    window.dispatchEvent(new CustomEvent('pde:scene-updated'));
    invalidateHeadPainterGridOverlay();
  };
  record({ undo: () => apply('before'), redo: () => apply('after') });
  invalidateHeadPainterGridOverlay();
}

function endPaintPointer(): void {
  finishStroke();
  restoreCameraControls?.();
  restoreCameraControls = null;
  paintPointerId = null;
  paintHeadUuid = null;
  deferredPaint = null;
}

function brushCoverage(dx: number, dy: number, width: number, height: number, hardness: number, circle: boolean): number {
  const distance = circle
    ? Math.hypot(dx / Math.max(0.5, width / 2), dy / Math.max(0.5, height / 2))
    : Math.max(Math.abs(dx) / Math.max(0.5, width / 2), Math.abs(dy) / Math.max(0.5, height / 2));
  if (distance > 1) return 0;
  const inner = hardness / 100;
  return distance <= inner || inner >= 1 ? 1 : (1 - distance) / (1 - inner);
}

function canPaintHead(sourceUuid: string | null, targetUuid: string, allowAdjacent: boolean): boolean {
  return sourceUuid === null || sourceUuid === targetUuid || allowAdjacent;
}

const isSamePaintFace = (sourceFace: number, targetFace: number): boolean => sourceFace === targetFace;

function adjacentBrushHit(hit: PaintHit, x: number, y: number): PaintHit | null {
  if (x >= 0 && x < hit.columns && y >= 0 && y < hit.rows) return { ...hit, x, y };
  if (!paintAdjacentHeads || !painterContext) return null;

  const scale = hit.layer ? 1.0625 : 1;
  const [origin, horizontalAxis, verticalAxis] = getHeadPainterFaceAxes(hit.face, scale);
  const matrix = getInstanceWorldMatrix(hit.mesh, hit.instanceId, new Matrix4());
  const target = origin.clone()
    .addScaledVector(horizontalAxis, gridCellCenter(x, hit.columns))
    .addScaledVector(verticalAxis, 1 - gridCellCenter(y, hit.rows))
    .applyMatrix4(matrix);
  const normal = origin.clone()
    .addScaledVector(horizontalAxis, 0.5)
    .addScaledVector(verticalAxis, 0.5)
    .sub(new Vector3(0, -0.5, 0))
    .applyNormalMatrix(new Matrix3().getNormalMatrix(matrix));
  const rayLength = Math.max(matrix.getMaxScaleOnAxis() * 1e-4, Number.EPSILON);
  raycaster.ray.set(target.addScaledVector(normal, rayLength), normal.negate());
  const previousFar = raycaster.far;
  raycaster.far = rayLength * 2;
  const adjacentHit = getRaycastHit();
  raycaster.far = previousFar;
  if (!adjacentHit || adjacentHit.promote || adjacentHit.surface.objectUuid === hit.surface.objectUuid || !isSamePaintFace(hit.face, adjacentHit.face)) return null;
  return adjacentHit;
}

function centeredOffsets(width: number, height: number): Array<{ index: number; x: number; y: number }> {
  return Array.from({ length: width * height }, (_, index) => ({
    index,
    x: index % width - Math.floor(width / 2),
    y: Math.floor(index / width) - Math.floor(height / 2)
  }));
}

function getBrushPaints(hit: PaintHit): Array<{ hit: PaintHit; source: Rgba; coverage: number }> {
  const custom = brushShape === 'custom' ? customBrushes.find(brush => brush.name === selectedBrushName) : null;
  const width = custom?.width ?? brushWidth;
  const height = custom?.height ?? brushHeight;
  return centeredOffsets(width, height).flatMap(({ index, x, y }) => {
    const target = adjacentBrushHit(hit, hit.x + x, hit.y + y);
    const source = custom ? custom.pixels[index] : currentColor;
    const coverage = custom ? (custom.strength ?? 100) / 100 : brushCoverage(
      x + (width % 2 === 0 ? 0.5 : 0),
      y + (height % 2 === 0 ? 0.5 : 0),
      width,
      height,
      100,
      brushShape === 'circle'
    ) * brushStrength / 100;
    return target && source && coverage > 0 ? [{ hit: target, source, coverage }] : [];
  });
}

function stampBrush(hit: PaintHit): void {
  const touched = new Set<WorkSurface>();
  for (const { hit: target, source, coverage } of getBrushPaints(hit)) {
    const work = getWork(target);
    const part = facePartIndexes[target.face] + target.layer * 6;
    touched.add(work);
    forEachGridPixel(target.columns, target.rows, target.x, target.y, (pixelX, pixelY) => {
      const next = colorForLayer(overwrite && coverage === 1 ? source : sourceOver(readPixel(work.image, part, pixelX, pixelY), source, coverage), target.layer);
      work.changed = writePixel(work.image, part, pixelX, pixelY, next) || work.changed;
    });
  }
  touched.forEach(flushWork);
}

function eraseAt(hit: PaintHit): void {
  const work = getWork(hit);
  const part = facePartIndexes[hit.face] + hit.layer * 6;
  const start = -Math.floor(eraserSize / 2);
  for (let row = 0; row < eraserSize; row++) {
    for (let column = 0; column < eraserSize; column++) {
      const x = hit.x + start + column;
      const y = hit.y + start + row;
      if (x < 0 || x >= hit.columns || y < 0 || y >= hit.rows) continue;
      const coverage = brushCoverage(
        start + column + (eraserSize % 2 === 0 ? 0.5 : 0),
        start + row + (eraserSize % 2 === 0 ? 0.5 : 0),
        eraserSize,
        eraserSize,
        eraserHardness,
        false
      ) * eraserStrength / 100;
      if (coverage <= 0) continue;
      forEachGridPixel(hit.columns, hit.rows, x, y, (pixelX, pixelY) => {
        const old = readPixel(work.image, part, pixelX, pixelY);
        const next = hit.layer
          ? [old[0], old[1], old[2], Math.round(old[3] * (1 - coverage))] as Rgba
          : old.map((value, index) => Math.round(value + ((index === 3 ? 255 : 0) - value) * coverage)) as Rgba;
        work.changed = writePixel(work.image, part, pixelX, pixelY, next) || work.changed;
      });
    }
  }
  flushWork(work);
}

function continueStroke(hit: PaintHit): void {
  const draw = lastTool === 'eraser' ? eraseAt : lastTool === 'stamp' ? placeStamp : stampBrush;
  const previous = lastStrokeHit;
  let drew = false;
  if (!previous || previous.surface.objectUuid !== hit.surface.objectUuid || previous.face !== hit.face || previous.layer !== hit.layer) {
    draw(hit);
    drew = true;
  } else {
    const distance = Math.hypot(hit.x - previous.x, hit.y - previous.y);
    const size = lastTool === 'stamp' ? 1 : lastTool === 'eraser' ? eraserSize : brushShape === 'custom'
      ? Math.max(customBrushes.find(brush => brush.name === selectedBrushName)?.width ?? 1, customBrushes.find(brush => brush.name === selectedBrushName)?.height ?? 1)
      : Math.max(brushWidth, brushHeight);
    const spacing = lastTool === 'stamp' ? 100 : brushShape === 'custom' ? customBrushes.find(brush => brush.name === selectedBrushName)?.spacing ?? brushSpacing : brushSpacing;
    const step = Math.max(1, size * spacing / 100);
    for (let offset = step; offset < distance + step; offset += step) {
      const amount = Math.min(1, offset / Math.max(distance, 1));
      draw({ ...hit, x: Math.round(previous.x + (hit.x - previous.x) * amount), y: Math.round(previous.y + (hit.y - previous.y) * amount) });
      drew = true;
    }
  }
  if (drew) lastStrokeHit = hit;
}

function connectedCellIndexes(columns: number, rows: number, start: number, matches: (index: number) => boolean): number[] {
  const pending = [start];
  const connected: number[] = [];
  const visited = new Set<number>();
  for (let offset = 0; offset < pending.length; offset++) {
    const index = pending[offset];
    if (visited.has(index) || !matches(index)) continue;
    visited.add(index);
    connected.push(index);
    const x = index % columns;
    if (x > 0) pending.push(index - 1);
    if (x + 1 < columns) pending.push(index + 1);
    if (index >= columns) pending.push(index - columns);
    if (index + columns < columns * rows) pending.push(index + columns);
  }
  return connected;
}

function fillAt(hit: PaintHit): void {
  const work = getWork(hit);
  const part = facePartIndexes[hit.face] + hit.layer * 6;
  const target = readPixel(work.image, part, gridCellPixel(hit.x, hit.columns), gridCellPixel(hit.y, hit.rows));
  if (!isShortcutPressed('headPainterFillAllFaces')) {
    const matches = (index: number) => {
      const x = index % hit.columns;
      const y = Math.floor(index / hit.columns);
      return rgbaEqual(readPixel(work.image, part, gridCellPixel(x, hit.columns), gridCellPixel(y, hit.rows)), target);
    };
    const indexes = isShortcutPressed('headPainterConnectedFill')
      ? connectedCellIndexes(hit.columns, hit.rows, hit.y * hit.columns + hit.x, matches)
      : Array.from({ length: hit.columns * hit.rows }, (_, index) => index).filter(matches);
    for (const index of indexes) {
      const x = index % hit.columns;
      const y = Math.floor(index / hit.columns);
      forEachGridPixel(hit.columns, hit.rows, x, y, (pixelX, pixelY) => {
        work.changed = writePixel(work.image, part, pixelX, pixelY, colorForLayer(currentColor, hit.layer)) || work.changed;
      });
    }
    flushWork(work);
    return;
  }
  for (const currentPart of facePartIndexes.map(index => index + hit.layer * 6)) {
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        work.changed = writePixel(work.image, currentPart, x, y, colorForLayer(currentColor, hit.layer)) || work.changed;
      }
    }
  }
  flushWork(work);
}

function copyStamp(hit: PaintHit): void {
  const image = readPlayerHeadPaint(hit.surface);
  const part = facePartIndexes[hit.face] + hit.layer * 6;
  stampPixels = centeredOffsets(stampWidth, stampHeight).map(({ x: offsetX, y: offsetY }) => {
    const x = hit.x + offsetX;
    const y = hit.y + offsetY;
    return x < 0 || x >= hit.columns || y < 0 || y >= hit.rows
      ? null
      : readPixel(image, part, gridCellPixel(x, hit.columns), gridCellPixel(y, hit.rows));
  });
  syncStampInputs();
}

function getStampCells(hit: PaintHit, includeEmpty: boolean): Array<{ hit: PaintHit; index: number }> {
  return centeredOffsets(stampWidth, stampHeight).flatMap(({ index, x, y }) => {
    const target = { ...hit, x: hit.x + x, y: hit.y + y };
    return (includeEmpty || stampPixels[index])
      && target.x >= 0 && target.x < target.columns && target.y >= 0 && target.y < target.rows
      ? [{ hit: target, index }]
      : [];
  });
}

function placeStamp(hit: PaintHit): void {
  const work = getWork(hit);
  const part = facePartIndexes[hit.face] + hit.layer * 6;
  getStampCells(hit, false).forEach(({ hit: target, index }) => {
    const color = stampPixels[index]!;
    forEachGridPixel(target.columns, target.rows, target.x, target.y, (pixelX, pixelY) => {
      work.changed = writePixel(work.image, part, pixelX, pixelY, colorForLayer(color, hit.layer)) || work.changed;
    });
  });
  flushWork(work);
}

function transformStamp(kind: 'left' | 'right' | 'vertical' | 'horizontal'): void {
  const oldWidth = stampWidth;
  const oldHeight = stampHeight;
  const oldPixels = stampPixels;
  if (kind === 'left' || kind === 'right') {
    stampWidth = oldHeight;
    stampHeight = oldWidth;
    stampPixels = Array.from({ length: stampWidth * stampHeight }, (_, index) => {
      const x = index % stampWidth;
      const y = Math.floor(index / stampWidth);
      const oldX = kind === 'right' ? y : oldWidth - 1 - y;
      const oldY = kind === 'right' ? oldHeight - 1 - x : x;
      return oldPixels[oldY * oldWidth + oldX] ?? null;
    });
  } else {
    stampPixels = Array.from({ length: oldWidth * oldHeight }, (_, index) => {
      const x = index % oldWidth;
      const y = Math.floor(index / oldWidth);
      const oldX = kind === 'horizontal' ? oldWidth - 1 - x : x;
      const oldY = kind === 'vertical' ? oldHeight - 1 - y : y;
      return oldPixels[oldY * oldWidth + oldX] ?? null;
    });
  }
  syncStampInputs();
}

async function pickColor(event: PointerEvent): Promise<void> {
  if (!painterContext || pickingColor) return;
  pickingColor = true;
  const { renderer, scene } = painterContext;
  const size = renderer.getDrawingBufferSize(new Vector2());
  if (!colorTarget) {
    colorTarget = new RenderTarget(size.x, size.y, { format: RGBAFormat, type: UnsignedByteType, depthBuffer: true });
    colorTarget.texture.colorSpace = renderer.outputColorSpace;
  } else if (colorTarget.width !== size.x || colorTarget.height !== size.y) {
    colorTarget.setSize(size.x, size.y);
  }
  const rect = renderer.domElement.getBoundingClientRect();
  const x = Math.min(size.x - 1, Math.max(0, Math.floor((event.clientX - rect.left) / rect.width * size.x)));
  const y = Math.min(size.y - 1, Math.max(0, Math.floor((rect.bottom - event.clientY) / rect.height * size.y)));
  const previousTarget = renderer.getRenderTarget();
  try {
    renderer.setRenderTarget(colorTarget);
    renderer.render(scene, painterContext.getCamera());
    renderer.setRenderTarget(previousTarget);
    const pixels = await renderer.readRenderTargetPixelsAsync(colorTarget, x, y, 1, 1);
    const emptySlot = palette.findIndex(color => !color);
    if (emptySlot >= 0) activePaletteSlot = emptySlot;
    setCurrentColor([pixels[0], pixels[1], pixels[2], pixels[3]], emptySlot >= 0);
  } finally {
    renderer.setRenderTarget(previousTarget);
    pickingColor = false;
  }
}

function setAltPicking(enabled: boolean): void {
  altPicking = enabled;
  const canvas = painterContext?.renderer.domElement;
  if (!canvas) return;
  if (enabled && pickerCursorBefore === null) {
    pickerCursorBefore = canvas.style.cursor;
    canvas.style.cursor = 'crosshair';
  } else if (!enabled && pickerCursorBefore !== null) {
    canvas.style.cursor = pickerCursorBefore;
    pickerCursorBefore = null;
  }
}

function promoteImageHeadAndPaint(event: PointerEvent, hit: PaintHit): boolean {
  if (!hit.promote) return false;
  if (promotingImageHead) return true;
  promotingImageHead = true;
  event.preventDefault();
  event.stopImmediatePropagation();
  const name = (loadedObjectGroup.userData.objectNames as Map<string, string> | undefined)?.get(hit.surface.objectUuid)
    ?? 'player_head[display=none]';
  void replaceDisplayObjects([{ objectUuid: hit.surface.objectUuid, name }], false).then(() => {
    const promotedHit = getHit(event, true);
    if (promotedHit) {
      paintAt(promotedHit);
      finishStroke();
    }
  }).catch(error => console.error('Image head promotion failed:', error)).finally(() => {
    promotingImageHead = false;
  });
  return true;
}

function onPointerDown(event: PointerEvent): void {
  if (!active || !painterContext || event.button !== 0 || event.target !== painterContext.renderer.domElement) return;
  finishStroke();
  if (lastTool === 'select') return;
  if (event.ctrlKey || event.metaKey) {
    if (lastTool !== 'picker' && !painterContext.isGizmoHovered()) deferredPaint = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
    return;
  }
  if (lastTool === 'picker') {
    if (!altPicking) return;
    getHit(event, true);
    event.preventDefault();
    event.stopImmediatePropagation();
    void pickColor(event);
    return;
  }
  if (painterContext.isGizmoHovered()) return;
  const hit = getHit(event, true);
  if (!hit || promoteImageHeadAndPaint(event, hit)) return;
  paintPointerId = event.pointerId;
  paintHeadUuid = hit.surface.objectUuid;
  restoreCameraControls = painterContext.suspendCameraControls();
  paintAt(hit);
}

function onKeyDown(event: KeyboardEvent): void {
  if (!active || lastTool !== 'picker' || !matchesShortcut(event, 'headPainterPickColor') || event.repeat) return;
  setAltPicking(true);
  event.preventDefault();
  event.stopImmediatePropagation();
}

function onKeyUp(event: KeyboardEvent): void {
  if (matchesShortcut(event, 'headPainterPickColor')) setAltPicking(false);
  if (matchesShortcut(event, 'headPainterCopyStamp')) removeHeadPainterStampPreview();
}

function paintAt(hit: PaintHit): void {
  if (lastTool === 'stamp' && isShortcutPressed('headPainterCopyStamp')) {
    finishStroke();
    copyStamp(hit);
    return;
  }
  if (!stroke) {
    stroke = new Map();
    lastStrokeHit = null;
  }
  if (lastTool === 'bucket') fillAt(hit);
  else continueStroke(hit);
}

function processPointerMove(event: PointerEvent): void {
  if (!active || !painterContext) return;
  if (event.target !== painterContext.renderer.domElement || painterContext.isGizmoHovered()) {
    removeHeadPainterStampPreview();
    finishStroke();
    return;
  }
  const candidate = getHit(event);
  const hit = candidate && canPaintHead(paintHeadUuid, candidate.surface.objectUuid, paintAdjacentHeads) ? candidate : null;
  if (lastTool === 'stamp' && isShortcutPressed('headPainterCopyStamp') && hit) {
    updateHeadPainterStampPreview(painterContext.scene, getStampCells(hit, true).map(cell => cell.hit), gridBoundary);
  } else if (lastTool === 'stamp' && hit) {
    updateHeadPainterStampPreview(painterContext.scene, getStampCells(hit, false).map(cell => cell.hit), gridBoundary);
  } else if (lastTool === 'brush' && hit) {
    updateHeadPainterStampPreview(painterContext.scene, getBrushPaints(hit).map(paint => paint.hit), gridBoundary);
  } else {
    removeHeadPainterStampPreview();
  }
  if (!(event.buttons & 1) || event.pointerId !== paintPointerId || lastTool === 'select' || lastTool === 'picker' || !hit) {
    finishStroke();
    return;
  }
  paintAt(hit);
}

function flushPointerMove(): void {
  if (pointerMoveFrame) cancelAnimationFrame(pointerMoveFrame);
  pointerMoveFrame = 0;
  const event = pendingPointerMove;
  pendingPointerMove = null;
  if (event) processPointerMove(event);
}

function onPointerMove(event: PointerEvent): void {
  if (!active) return;
  pendingPointerMove = event;
  if (pointerMoveFrame) return;
  pointerMoveFrame = requestAnimationFrame(() => {
    pointerMoveFrame = 0;
    const next = pendingPointerMove;
    pendingPointerMove = null;
    if (next) processPointerMove(next);
  });
}

function onPointerUp(event: PointerEvent): void {
  flushPointerMove();
  if (event.pointerId === deferredPaint?.pointerId) {
    const click = event.type === 'pointerup' && Math.hypot(event.clientX - deferredPaint.x, event.clientY - deferredPaint.y) < 6;
    deferredPaint = null;
    if (click) {
      const hit = getHit(event, true);
      if (hit) {
        if (promoteImageHeadAndPaint(event, hit)) return;
        paintAt(hit);
        finishStroke();
      }
    }
    return;
  }
  if (event.pointerId !== paintPointerId) return;
  endPaintPointer();
}

function smartCounts(configuredHorizontal: number, configuredVertical: number, horizontalSize: number, verticalSize: number): [number, number] {
  const cellSize = Math.max(
    configuredHorizontal ? horizontalSize / configuredHorizontal : 0,
    configuredVertical ? verticalSize / configuredVertical : 0);
  const count = (configured: number, size: number) => configured === 0 || size === 0 ? 0 : Math.min(
    2 ** Math.floor(Math.log2(configured)),
    Math.max(1, 2 ** Math.round(Math.log2(size / cellSize))));
  return [count(configuredHorizontal, horizontalSize), count(configuredVertical, verticalSize)];
}

function getInstanceWorldMatrix(mesh: InstancedMesh, instanceId: number, target: Matrix4): Matrix4 {
  mesh.getMatrixAt(instanceId, target);
  target.premultiply(mesh.matrixWorld);
  if (mesh.geometry.getAttribute(dragSelectedAttributeName)?.getX(instanceId)) target.premultiply(dragDeltaMatrix);
  return target;
}

function getFaceGridCounts(objectUuid: string, face: number, worldMatrix: Matrix4): [number, number] {
  const override = gridOverrides.get(objectUuid);
  const configuredHorizontal = override?.horizontal ?? gridHorizontal;
  const configuredVertical = override?.vertical ?? gridVertical;
  if (!smartGrid || override) return [configuredHorizontal, configuredVertical];
  const [horizontalAxis, verticalAxis] = faceGridAxes[face];
  const axis = new Vector3();
  return smartCounts(
    configuredHorizontal,
    configuredVertical,
    axis.setFromMatrixColumn(worldMatrix, horizontalAxis).length(),
    axis.setFromMatrixColumn(worldMatrix, verticalAxis).length());
}

export function updateHeadPainter(): void {
  if (!active || !painterContext) return;
  updateHeadPainterGridOverlay(
    painterContext.scene,
    loadedObjectGroup,
    gridEnabled,
    layerMode,
    (gridColor[0] << 16) | (gridColor[1] << 8) | gridColor[2],
    getFaceGridCounts,
    gridBoundary
  );
}

export function getHeadGridValue(objectUuid: string, axis: 'horizontal' | 'vertical'): number {
  return gridOverrides.get(objectUuid)?.[axis] ?? (axis === 'horizontal' ? gridHorizontal : gridVertical);
}

export function setHeadGridOverride(objectUuid: string, axis: 'horizontal' | 'vertical', value: number): void {
  const override = gridOverrides.get(objectUuid) ?? {};
  override[axis] = clampGrid(value);
  gridOverrides.set(objectUuid, override);
  invalidateHeadPainterGridOverlay();
}

function saveActivePalette(): void {
  if (activePalettePreset) void window.ipcApi.savePainterAsset('palette', activePalettePreset, { colors: palette });
  else defaultPalette = palette.map(color => color && cloneRgba(color));
}

function setCurrentColor(color: Rgba, writePalette = false): void {
  currentColor = cloneRgba(color);
  if (writePalette) {
    palette[activePaletteSlot] = cloneRgba(color);
    saveActivePalette();
  }
  syncColorControls();
  renderPalette();
}

function renderPalette(): void {
  const grid = root?.querySelector<HTMLElement>('.head-painter-palette');
  if (!grid) return;
  grid.replaceChildren(...palette.map((color, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `head-painter-swatch${index === activePaletteSlot ? ' active' : ''}${index === paletteAnchor ? ' anchor' : ''}`;
    button.title = color ? `rgba(${color.join(', ')})` : '빈 색상';
    if (color) button.style.background = `rgba(${color[0]},${color[1]},${color[2]},${color[3] / 255})`;
    button.onclick = () => {
      if (isShortcutPressed('headPainterPaletteGradient') && color) {
        if (paletteAnchor === null || !palette[paletteAnchor]) paletteAnchor = index;
        else {
          const start = Math.min(paletteAnchor, index);
          const end = Math.max(paletteAnchor, index);
          const first = palette[start]!;
          const last = palette[end]!;
          for (let slot = start; slot <= end; slot++) palette[slot] = interpolateColor(first, last, end === start ? 0 : (slot - start) / (end - start));
          paletteAnchor = null;
          saveActivePalette();
        }
      } else {
        paletteAnchor = null;
        activePaletteSlot = index;
        if (color) currentColor = cloneRgba(color);
      }
      syncColorControls();
      renderPalette();
    };
    return button;
  }));
}

function syncColorControls(): void {
  if (!root) return;
  const input = root.querySelector<HTMLInputElement>('#head-painter-color')!;
  const alpha = root.querySelector<HTMLInputElement>('#head-painter-alpha')!;
  const alphaRange = root.querySelector<HTMLInputElement>('#head-painter-alpha-range')!;
  input.value = formatColor(currentColor);
  alpha.value = alphaRange.value = String(currentColor[3]);
  root.querySelector<HTMLElement>('#head-painter-palette-color-picker')!.style.background = `rgb(${currentColor[0]} ${currentColor[1]} ${currentColor[2]})`;
}

function bindRangePair(id: string, minimum: number, maximum: number, setValue: (value: number) => void): void {
  if (!root) return;
  const number = root.querySelector<HTMLInputElement>(`#${id}`)!;
  const range = root.querySelector<HTMLInputElement>(`#${id}-range`)!;
  const update = (input: HTMLInputElement) => {
    const value = Math.min(maximum, Math.max(minimum, Number(input.value)));
    number.value = range.value = String(Number.isFinite(value) ? value : minimum);
    setValue(Number(number.value));
  };
  number.oninput = () => update(number);
  range.oninput = () => update(range);
}

function renderToolSettings(): void {
  if (!root) return;
  root.querySelectorAll<HTMLElement>('[data-tool-settings]').forEach(element => { element.hidden = element.dataset.toolSettings !== lastTool; });
  root.querySelectorAll<HTMLButtonElement>('.head-painter-tool').forEach(button => button.classList.toggle('active', button.dataset.tool === lastTool));
}

function setTool(tool: Tool): void {
  endPaintPointer();
  lastTool = tool;
  if (active && painterContext) painterContext.renderer.domElement.dataset.headPainterTool = tool;
  if (tool !== 'picker') setAltPicking(false);
  if (tool !== 'stamp') removeHeadPainterStampPreview();
  renderToolSettings();
}

function syncBrushControls(): void {
  if (!root) return;
  const brush = brushShape === 'custom' ? customBrushes.find(item => item.name === selectedBrushName) : null;
  root.querySelector<HTMLInputElement>('#head-painter-brush-width')!.value = String(brush?.width ?? brushWidth);
  root.querySelector<HTMLInputElement>('#head-painter-brush-height')!.value = String(brush?.height ?? brushHeight);
  const strength = String(brush?.strength ?? brushStrength);
  const spacing = String(brush?.spacing ?? brushSpacing);
  root.querySelector<HTMLInputElement>('#head-painter-brush-strength')!.value = root.querySelector<HTMLInputElement>('#head-painter-brush-strength-range')!.value = strength;
  root.querySelector<HTMLInputElement>('#head-painter-brush-spacing')!.value = root.querySelector<HTMLInputElement>('#head-painter-brush-spacing-range')!.value = spacing;
  root.querySelectorAll<HTMLButtonElement>('[data-basic-brush]').forEach(button => button.classList.toggle('active', brushShape !== 'custom'));
}

function setBrushValue(key: 'width' | 'height' | 'strength' | 'spacing', value: number): void {
  const brush = brushShape === 'custom' ? customBrushes.find(item => item.name === selectedBrushName) : null;
  if (brush) {
    if (key === 'width' || key === 'height') Object.assign(brush, resizeBrush(brush, key === 'width' ? value : brush.width, key === 'height' ? value : brush.height));
    else brush[key] = value;
    void window.ipcApi.savePainterAsset('brush', brush.name, brush);
    return;
  }
  if (key === 'width') brushWidth = value;
  else if (key === 'height') brushHeight = value;
  else if (key === 'strength') brushStrength = value;
  else brushSpacing = value;
}

function saveBrushOrder(): void {
  localStorage.setItem(brushOrderKey, JSON.stringify(customBrushes.map(brush => brush.name)));
}

function renderCustomBrushes(): void {
  const list = root?.querySelector<HTMLElement>('.head-painter-custom-brushes');
  if (!list) return;
  list.replaceChildren(...customBrushes.map((brush, index) => {
    const row = document.createElement('div');
    row.className = 'head-painter-custom-brush';
    row.draggable = true;
    const name = document.createElement('span');
    name.textContent = brush.name;
    const select = document.createElement('button');
    select.type = 'button';
    select.className = 'lucide-icon';
    select.textContent = toolIcons.brush;
    select.title = '브러시 선택';
    select.classList.toggle('active', brushShape === 'custom' && selectedBrushName === brush.name);
    select.onclick = () => {
      selectedBrushName = brush.name;
      brushShape = 'custom';
      syncBrushControls();
      renderCustomBrushes();
    };
    const settings = document.createElement('button');
    settings.type = 'button';
    settings.className = 'lucide-icon';
    settings.textContent = '\uE2F0';
    settings.title = '설정';
    settings.onclick = () => openBrushEditor(brush);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'lucide-icon';
    remove.textContent = '\uE18E';
    remove.title = '삭제';
    remove.onclick = async () => {
      const result = await window.ipcApi.deletePainterAsset('brush', brush.name);
      if (!result.success) return window.alert(result.error ?? '브러시 삭제에 실패했습니다.');
      customBrushes = customBrushes.filter(item => item !== brush);
      if (selectedBrushName === brush.name) selectedBrushName = customBrushes[0]?.name ?? null;
      saveBrushOrder();
      renderCustomBrushes();
    };
    row.ondragstart = event => {
      event.dataTransfer?.setData('text/brush-index', String(index));
      if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
    };
    row.ondragover = event => {
      if (!event.dataTransfer?.types.includes('text/brush-index')) return;
      const from = Number(event.dataTransfer?.getData('text/brush-index'));
      if (!Number.isInteger(from)) return;
      event.preventDefault();
      list.querySelectorAll('.brush-drop-before, .brush-drop-after').forEach(item => item.classList.remove('brush-drop-before', 'brush-drop-after'));
      const rect = row.getBoundingClientRect();
      row.classList.add(event.clientY < rect.top + rect.height / 2 ? 'brush-drop-before' : 'brush-drop-after');
    };
    row.ondrop = event => {
      if (!event.dataTransfer?.types.includes('text/brush-index')) return;
      const from = Number(event.dataTransfer?.getData('text/brush-index'));
      if (!Number.isInteger(from)) return;
      event.preventDefault();
      const rect = row.getBoundingClientRect();
      let to = index + (event.clientY < rect.top + rect.height / 2 ? 0 : 1);
      const [moved] = customBrushes.splice(from, 1);
      if (from < to) to--;
      customBrushes.splice(to, 0, moved);
      saveBrushOrder();
      renderCustomBrushes();
    };
    row.ondragend = () => renderCustomBrushes();
    row.append(name, select, settings, remove);
    return row;
  }));
}

async function addCustomBrush(): Promise<void> {
  let index = 1;
  while (customBrushes.some(brush => brush.name === `커스텀${index}`)) index++;
  const brush: BrushAsset = { name: `커스텀${index}`, width: 8, height: 8, pixels: Array(64).fill(null) };
  const result = await window.ipcApi.savePainterAsset('brush', brush.name, brush);
  if (!result.success) return window.alert(result.error ?? '브러시 저장에 실패했습니다.');
  customBrushes.push(brush);
  saveBrushOrder();
  selectedBrushName = brush.name;
  brushShape = 'custom';
  renderCustomBrushes();
  syncBrushControls();
  openBrushEditor(brush);
}

function renderBrushEditorGrid(): void {
  if (!brushEditor || !editingBrush) return;
  const grid = brushEditor.querySelector<HTMLElement>('.head-painter-brush-grid')!;
  grid.replaceChildren(...Array.from({ length: 64 }, (_, index) => {
    const x = index % 8;
    const y = Math.floor(index / 8);
    const button = document.createElement('button');
    button.type = 'button';
    const enabled = x < editingBrush!.width && y < editingBrush!.height;
    const color = enabled ? editingBrush!.pixels[y * editingBrush!.width + x] : null;
    button.disabled = !enabled;
    button.classList.toggle('active', !!color);
    button.classList.toggle('selected', selectedBrushPixels.has(`${x},${y}`));
    if (color) button.style.backgroundColor = `rgba(${color[0]},${color[1]},${color[2]},${color[3] / 255})`;
    button.dataset.x = String(x);
    button.dataset.y = String(y);
    return button;
  }));
}

function resizeBrush(old: BrushAsset, width: number, height: number): BrushAsset {
  const pixels = Array<Rgba | null>(width * height).fill(null);
  for (let y = 0; y < Math.min(old.height, height); y++) {
    for (let x = 0; x < Math.min(old.width, width); x++) pixels[y * width + x] = old.pixels[y * old.width + x];
  }
  return { ...old, width, height, pixels };
}

function resizeEditingBrush(width: number, height: number): void {
  if (!editingBrush) return;
  editingBrush = resizeBrush(editingBrush, width, height);
  renderBrushEditorGrid();
}

function paintBrushEditorCell(target: EventTarget | null, erase: boolean): void {
  if (!editingBrush || !(target instanceof HTMLButtonElement) || target.disabled) return;
  const x = Number(target.dataset.x);
  const y = Number(target.dataset.y);
  if (brushSelectionActive && !selectedBrushPixels.has(`${x},${y}`)) return;
  const index = y * editingBrush.width + x;
  const color = erase ? null : cloneRgba(editorColor);
  if (!brushSelectionActive) selectedBrushPixels = new Set([`${x},${y}`]);
  if (rgbaEqual(editingBrush.pixels[index], color)) return renderBrushEditorGrid();
  brushUndo.push({ ...editingBrush, pixels: editingBrush.pixels.map(pixel => pixel && cloneRgba(pixel)) });
  brushRedo = [];
  editingBrush.pixels[index] = color;
  renderBrushEditorGrid();
}

function selectBrushPixel(target: EventTarget | null): void {
  if (brushSelectionActive || !(target instanceof HTMLButtonElement) || target.disabled) return;
  selectedBrushPixels = new Set([`${target.dataset.x},${target.dataset.y}`]);
  renderBrushEditorGrid();
}

function selectBrushArea(target: EventTarget | null): void {
  if (!editingBrush || !(target instanceof HTMLButtonElement) || target.disabled) return;
  const end = { x: Number(target.dataset.x), y: Number(target.dataset.y) };
  brushSelectionAnchor ??= end;
  brushSelectionActive = true;
  selectedBrushPixels = new Set<string>();
  for (let y = Math.min(brushSelectionAnchor.y, end.y); y <= Math.max(brushSelectionAnchor.y, end.y); y++) {
    for (let x = Math.min(brushSelectionAnchor.x, end.x); x <= Math.max(brushSelectionAnchor.x, end.x); x++) selectedBrushPixels.add(`${x},${y}`);
  }
  renderBrushEditorGrid();
}

function eraseSelectedBrushPixels(): void {
  if (!editingBrush) return;
  const indexes = [...selectedBrushPixels].map(key => {
    const [x, y] = key.split(',').map(Number);
    return y * editingBrush!.width + x;
  }).filter(index => editingBrush!.pixels[index]);
  if (!indexes.length) return;
  brushUndo.push({ ...editingBrush, pixels: editingBrush.pixels.map(pixel => pixel && cloneRgba(pixel)) });
  brushRedo = [];
  indexes.forEach(index => { editingBrush!.pixels[index] = null; });
  renderBrushEditorGrid();
}

function restoreBrushEdit(source: BrushAsset[], target: BrushAsset[]): void {
  if (!editingBrush || !source.length) return;
  target.push({ ...editingBrush, pixels: editingBrush.pixels.map(pixel => pixel && cloneRgba(pixel)) });
  editingBrush = source.pop()!;
  renderBrushEditorGrid();
}

function openBrushEditor(brush: BrushAsset): void {
  if (!brushEditor) return;
  editingBrush = { ...brush, pixels: brush.pixels.map(color => color && cloneRgba(color)) };
  selectedBrushPixels.clear();
  brushSelectionAnchor = null;
  brushSelectionActive = false;
  brushUndo = [];
  brushRedo = [];
  editorColor = cloneRgba(currentColor);
  brushEditor.hidden = false;
  brushEditor.querySelector<HTMLInputElement>('#head-brush-name')!.value = brush.name;
  brushEditor.querySelector<HTMLInputElement>('#head-brush-color')!.value = formatColor(editorColor).startsWith('#') ? formatColor(editorColor) : `#${editorColor.slice(0, 3).map(value => value.toString(16).padStart(2, '0')).join('')}`;
  brushEditor.querySelector<HTMLInputElement>('#head-brush-alpha')!.value = String(editorColor[3]);
  brushEditor.querySelector<HTMLInputElement>('#head-brush-width')!.value = String(brush.width);
  brushEditor.querySelector<HTMLInputElement>('#head-brush-height')!.value = String(brush.height);
  brushEditor.querySelector<HTMLInputElement>('#head-brush-strength')!.value = String(brush.strength ?? 100);
  brushEditor.querySelector<HTMLInputElement>('#head-brush-spacing')!.value = String(brush.spacing ?? 25);
  brushEditor.querySelector<HTMLElement>('[data-brush-color-picker]')!.style.background = `rgb(${editorColor[0]}, ${editorColor[1]}, ${editorColor[2]})`;
  renderBrushEditorGrid();
  openWithAnimation(brushEditor.querySelector<HTMLElement>('section')!);
}

function closeBrushEditor(): void {
  if (!brushEditor || brushEditor.hidden) return;
  editingBrush = null;
  void closeWithAnimation(brushEditor.querySelector<HTMLElement>('section')!).then(() => { brushEditor!.hidden = true; });
}

async function saveBrushEditor(): Promise<void> {
  if (!brushEditor || !editingBrush) return;
  const oldName = editingBrush.name;
  const name = brushEditor.querySelector<HTMLInputElement>('#head-brush-name')!.value.trim();
  if (customBrushes.some(brush => brush.name === name && brush.name !== oldName)) return window.alert('같은 이름의 브러시가 이미 있습니다.');
  const brush = { ...editingBrush, name };
  const result = await window.ipcApi.savePainterAsset('brush', name, brush);
  if (!result.success) return window.alert(result.error ?? '브러시 저장에 실패했습니다.');
  if (oldName !== name) await window.ipcApi.deletePainterAsset('brush', oldName);
  const index = customBrushes.findIndex(item => item.name === oldName);
  if (index >= 0) customBrushes[index] = brush;
  saveBrushOrder();
  selectedBrushName = name;
  renderCustomBrushes();
  syncBrushControls();
  closeBrushEditor();
}

function createBrushEditor(): void {
  brushEditor = document.createElement('div');
  brushEditor.className = 'head-painter-brush-editor';
  brushEditor.hidden = true;
  brushEditor.innerHTML = `
    <section role="dialog" aria-modal="true" aria-labelledby="head-brush-title">
      <h2 id="head-brush-title">커스텀 브러시</h2>
      <label>이름 <input id="head-brush-name" maxlength="100"></label>
      <div class="head-painter-inline"><label>색상 <span class="head-painter-brush-color"><button type="button" class="head-painter-color-preview" data-brush-color-picker aria-label="색상 선택"></button><input id="head-brush-color" value="#000000"></span></label><label>알파 <input id="head-brush-alpha" type="number" min="0" max="255" value="255"></label></div>
      <div class="head-painter-inline"><label>강도 <input id="head-brush-strength" type="number" min="0" max="100" value="100"></label><label>간격 % <input id="head-brush-spacing" type="number" min="1" max="100" value="25"></label></div>
      <div class="head-painter-inline"><label>가로 <input id="head-brush-width" type="number" min="1" max="8"></label><label>세로 <input id="head-brush-height" type="number" min="1" max="8"></label></div>
      <div class="head-painter-brush-grid"></div>
      <footer><button type="button" data-close>나가기</button><button type="button" data-save>저장</button></footer>
    </section>`;
  document.body.append(brushEditor);
  brushEditor.querySelector('[data-close]')!.addEventListener('click', closeBrushEditor);
  brushEditor.querySelector('[data-save]')!.addEventListener('click', () => void saveBrushEditor());
  brushEditor.addEventListener('click', event => {
    if (event.target === brushEditor) closeBrushEditor();
  });
  const color = brushEditor.querySelector<HTMLInputElement>('#head-brush-color')!;
  const alpha = brushEditor.querySelector<HTMLInputElement>('#head-brush-alpha')!;
  const updateColor = () => {
    const parsed = parseColor(color.value, Number(alpha.value));
    if (!parsed) {
      color.value = `#${editorColor.slice(0, 3).map(value => value.toString(16).padStart(2, '0')).join('')}`;
      return;
    }
    editorColor = parsed;
    brushEditor!.querySelector<HTMLElement>('[data-brush-color-picker]')!.style.background = `rgb(${parsed[0]}, ${parsed[1]}, ${parsed[2]})`;
  };
  color.oninput = updateColor;
  alpha.oninput = updateColor;
  brushEditor.querySelector<HTMLElement>('[data-brush-color-picker]')!.onclick = event => openColorPicker(
    event.currentTarget as HTMLElement,
    editorColor.slice(0, 3) as [number, number, number],
    rgb => {
      editorColor = [...rgb, editorColor[3]];
      color.value = `#${rgb.map(value => value.toString(16).padStart(2, '0')).join('')}`;
      updateColor();
    }
  );
  brushEditor.querySelector<HTMLInputElement>('#head-brush-strength')!.oninput = event => {
    if (editingBrush) editingBrush.strength = Math.min(100, Math.max(0, Number((event.target as HTMLInputElement).value) || 0));
  };
  brushEditor.querySelector<HTMLInputElement>('#head-brush-spacing')!.oninput = event => {
    if (editingBrush) editingBrush.spacing = Math.min(100, Math.max(1, Number((event.target as HTMLInputElement).value) || 1));
  };
  brushEditor.querySelector<HTMLInputElement>('#head-brush-width')!.oninput = event => resizeEditingBrush(Math.min(8, Math.max(1, Number((event.target as HTMLInputElement).value))), editingBrush?.height ?? 1);
  brushEditor.querySelector<HTMLInputElement>('#head-brush-height')!.oninput = event => resizeEditingBrush(editingBrush?.width ?? 1, Math.min(8, Math.max(1, Number((event.target as HTMLInputElement).value))));
  const grid = brushEditor.querySelector<HTMLElement>('.head-painter-brush-grid')!;
  grid.tabIndex = 0;
  grid.oncontextmenu = event => event.preventDefault();
  grid.onpointerdown = event => {
    if (event.button > 2) return;
    event.preventDefault();
    grid.focus();
    if (isShortcutPressed('headPainterSelectBrushArea') && event.button === 0) selectBrushArea(event.target);
    else selectBrushPixel(event.target);
  };
  grid.onpointermove = event => {
    if (!(event.buttons & 3)) return;
    if (isShortcutPressed('headPainterSelectBrushArea') && event.buttons & 1) selectBrushArea(event.target);
    else paintBrushEditorCell(event.target, !!(event.buttons & 2));
  };
  grid.onpointerup = () => { brushSelectionAnchor = null; };
  grid.onkeydown = event => {
    if (matchesShortcut(event, 'headPainterClearBrushSelection') && selectedBrushPixels.size) {
      selectedBrushPixels.clear();
      brushSelectionActive = false;
      renderBrushEditorGrid();
      event.preventDefault();
      event.stopPropagation();
    } else if (event.key === 'Delete' || event.key === 'Backspace') {
      eraseSelectedBrushPixels();
      event.preventDefault();
      event.stopPropagation();
    } else if (event.ctrlKey && !event.shiftKey && event.key.toLowerCase() === 'z') {
      restoreBrushEdit(brushUndo, brushRedo);
      event.preventDefault();
      event.stopPropagation();
    } else if (event.ctrlKey && (event.key.toLowerCase() === 'y' || event.shiftKey && event.key.toLowerCase() === 'z')) {
      restoreBrushEdit(brushRedo, brushUndo);
      event.preventDefault();
      event.stopPropagation();
    }
  };
}

function renderPalettePresetMenu(): void {
  if (!root) return;
  const button = root.querySelector<HTMLButtonElement>('.head-painter-preset-button')!;
  const menu = root.querySelector<HTMLElement>('.head-painter-preset-menu')!;
  button.textContent = '팔레트 목록';
  menu.querySelectorAll('.palette-drop-before, .palette-drop-after').forEach(row => row.classList.remove('palette-drop-before', 'palette-drop-after'));
  const defaultRow = document.createElement('div');
  defaultRow.className = `head-painter-preset-row${activePalettePreset === null ? ' active' : ''}`;
  const defaultName = Object.assign(document.createElement('input'), { value: '기본 팔레트', disabled: true });
  const defaultUse = document.createElement('button');
  defaultUse.type = 'button';
  defaultUse.className = 'lucide-icon';
  defaultUse.textContent = '\uE1DD';
  defaultUse.title = defaultUse.ariaLabel = '팔레트 사용';
  defaultUse.onclick = () => {
    palette = defaultPalette.map(color => color && cloneRgba(color));
    activePalettePreset = null;
    localStorage.removeItem('pdeHeadPainterPalettePreset');
    renderPalettePresetMenu();
    renderPalette();
  };
  const defaultRemove = document.createElement('button');
  defaultRemove.type = 'button';
  defaultRemove.className = 'lucide-icon';
  defaultRemove.textContent = '\uE18E';
  defaultRemove.title = defaultRemove.ariaLabel = '삭제';
  defaultRemove.disabled = true;
  defaultRow.append(defaultName, defaultUse, defaultRemove);
  const rows = palettePresetNames.map((name, index) => {
    const row = document.createElement('div');
    row.className = 'head-painter-preset-row';
    row.draggable = true;
    row.classList.toggle('active', name === activePalettePreset);
    const input = document.createElement('input');
    input.value = name;
    input.maxLength = 100;
    input.title = '팔레트 이름';
    const use = document.createElement('button');
    use.type = 'button';
    use.className = 'lucide-icon';
    use.textContent = '\uE1DD';
    use.title = use.ariaLabel = '팔레트 사용';
    use.onclick = async () => {
      const result = await window.ipcApi.loadPainterAsset('palette', name);
      if (!result.success) return window.alert(result.error ?? '팔레트를 불러오지 못했습니다.');
      palette = (result.data as PaletteAsset).colors.map(color => color && cloneRgba(color));
      activePalettePreset = name;
      localStorage.setItem('pdeHeadPainterPalettePreset', name);
      menu.querySelectorAll('.head-painter-preset-row').forEach(item => item.classList.toggle('active', item === row));
      renderPalette();
    };
    input.onchange = async () => {
      const nextName = input.value.trim();
      if (!nextName || nextName === name) return renderPalettePresetMenu();
      if (palettePresetNames.includes(nextName)) return window.alert('같은 이름의 팔레트가 이미 있습니다.');
      const loaded = await window.ipcApi.loadPainterAsset('palette', name);
      if (!loaded.success) return window.alert(loaded.error ?? '팔레트를 불러오지 못했습니다.');
      const saved = await window.ipcApi.savePainterAsset('palette', nextName, loaded.data);
      if (!saved.success) return window.alert(saved.error ?? '팔레트 이름을 바꾸지 못했습니다.');
      await window.ipcApi.deletePainterAsset('palette', name);
      palettePresetNames[index] = nextName;
      if (activePalettePreset === name) {
        activePalettePreset = nextName;
        localStorage.setItem('pdeHeadPainterPalettePreset', nextName);
      }
      localStorage.setItem(paletteOrderKey, JSON.stringify(palettePresetNames));
      renderPalettePresetMenu();
    };
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'lucide-icon';
    remove.textContent = '\uE18E';
    remove.title = '삭제';
    remove.onclick = async event => {
      event.stopPropagation();
      const result = await window.ipcApi.deletePainterAsset('palette', name);
      if (!result.success) return window.alert(result.error ?? '팔레트 삭제에 실패했습니다.');
      palettePresetNames = palettePresetNames.filter(item => item !== name);
      if (activePalettePreset === name) {
        activePalettePreset = null;
        localStorage.removeItem('pdeHeadPainterPalettePreset');
      }
      localStorage.setItem(paletteOrderKey, JSON.stringify(palettePresetNames));
      renderPalettePresetMenu();
    };
    row.ondragstart = event => {
      event.dataTransfer?.setData('text/palette-index', String(index));
      if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
    };
    row.ondragover = event => {
      if (!event.dataTransfer?.types.includes('text/palette-index')) return;
      const from = Number(event.dataTransfer?.getData('text/palette-index'));
      if (!Number.isInteger(from)) return;
      event.preventDefault();
      menu.querySelectorAll('.palette-drop-before, .palette-drop-after').forEach(item => item.classList.remove('palette-drop-before', 'palette-drop-after'));
      const rect = row.getBoundingClientRect();
      row.classList.add(event.clientY < rect.top + rect.height / 2 ? 'palette-drop-before' : 'palette-drop-after');
    };
    row.ondrop = event => {
      if (!event.dataTransfer?.types.includes('text/palette-index')) return;
      const from = Number(event.dataTransfer?.getData('text/palette-index'));
      if (!Number.isInteger(from)) return;
      event.preventDefault();
      const rect = row.getBoundingClientRect();
      let to = index + (event.clientY < rect.top + rect.height / 2 ? 0 : 1);
      const [moved] = palettePresetNames.splice(from, 1);
      if (from < to) to--;
      palettePresetNames.splice(to, 0, moved);
      localStorage.setItem(paletteOrderKey, JSON.stringify(palettePresetNames));
      renderPalettePresetMenu();
    };
    row.ondragend = () => renderPalettePresetMenu();
    row.append(input, use, remove);
    return row;
  });
  const add = document.createElement('button');
  add.type = 'button';
  add.textContent = '+ 커스텀 팔레트 추가';
  add.onclick = () => {
    const input = document.createElement('input');
    input.placeholder = '팔레트 이름';
    input.maxLength = 100;
    const save = async () => {
      const name = input.value.trim();
      if (!name || palettePresetNames.includes(name)) return renderPalettePresetMenu();
      const result = await window.ipcApi.savePainterAsset('palette', name, { colors: palette });
      if (!result.success) return window.alert(result.error ?? '팔레트 저장에 실패했습니다.');
      palettePresetNames.push(name);
      activePalettePreset = name;
      localStorage.setItem('pdeHeadPainterPalettePreset', activePalettePreset);
      localStorage.setItem(paletteOrderKey, JSON.stringify(palettePresetNames));
      renderPalettePresetMenu();
    };
    input.onkeydown = event => {
      if (event.key === 'Enter') void save();
      else if (event.key === 'Escape') renderPalettePresetMenu();
      event.stopPropagation();
    };
    input.onblur = () => { if (input.isConnected) renderPalettePresetMenu(); };
    add.replaceWith(input);
    input.focus();
  };
  menu.replaceChildren(defaultRow, ...rows, add);
}

async function loadPainterAssets(): Promise<void> {
  const [brushList, paletteList] = await Promise.all([
    window.ipcApi.listPainterAssets('brush'),
    window.ipcApi.listPainterAssets('palette')
  ]);
  if (brushList.success) {
    const results = await Promise.all(brushList.items.map(name => window.ipcApi.loadPainterAsset('brush', name)));
    const brushes = results.filter(result => result.success).map(result => result.data as BrushAsset);
    const savedOrder = JSON.parse(localStorage.getItem(brushOrderKey) ?? '[]') as string[];
    customBrushes = [
      ...savedOrder.map(name => brushes.find(brush => brush.name === name)).filter((brush): brush is BrushAsset => !!brush),
      ...brushes.filter(brush => !savedOrder.includes(brush.name))
    ];
    selectedBrushName ??= customBrushes[0]?.name ?? null;
  }
  if (paletteList.success) {
    const savedOrder = JSON.parse(localStorage.getItem(paletteOrderKey) ?? '[]') as string[];
    palettePresetNames = [...savedOrder.filter(name => paletteList.items.includes(name)), ...paletteList.items.filter(name => !savedOrder.includes(name))];
    const saved = localStorage.getItem('pdeHeadPainterPalettePreset');
    if (saved && palettePresetNames.includes(saved)) {
      const result = await window.ipcApi.loadPainterAsset('palette', saved);
      if (result.success) {
        palette = (result.data as PaletteAsset).colors.map(color => color && cloneRgba(color));
        activePalettePreset = saved;
      }
    }
  }
  renderCustomBrushes();
  renderPalettePresetMenu();
  renderPalette();
}

function openPainterColorPicker(): void {
  if (!root) return;
  const target = root.querySelector<HTMLElement>('#head-painter-palette-color-picker')!;
  openColorPicker(target, currentColor.slice(0, 3) as [number, number, number], color => setCurrentColor([...color, currentColor[3]], true), {
    oklch: colorMode === 'oklch',
    onOklchChange: enabled => {
      colorMode = enabled ? 'oklch' : 'rgb';
      root!.querySelector<HTMLSelectElement>('#head-painter-color-mode')!.value = colorMode;
      syncColorControls();
    }
  });
}

function resizeStamp(width: number, height: number): void {
  const oldWidth = stampWidth;
  const oldHeight = stampHeight;
  const oldPixels = stampPixels;
  stampWidth = clampGrid(width);
  stampHeight = clampGrid(height);
  stampPixels = Array<Rgba | null>(stampWidth * stampHeight).fill(null);
  for (let y = 0; y < Math.min(oldHeight, stampHeight); y++) {
    for (let x = 0; x < Math.min(oldWidth, stampWidth); x++) stampPixels[y * stampWidth + x] = oldPixels[y * oldWidth + x] ?? null;
  }
  removeHeadPainterStampPreview();
  syncStampInputs();
}

function syncStampInputs(): void {
  if (!root) return;
  root.querySelector<HTMLInputElement>('#head-painter-stamp-width')!.value = String(stampWidth);
  root.querySelector<HTMLInputElement>('#head-painter-stamp-height')!.value = String(stampHeight);
  const preview = root.querySelector<HTMLElement>('.head-painter-stamp-preview');
  if (!preview) return;
  preview.style.gridTemplateColumns = `repeat(${Math.max(1, stampWidth)}, 1fr)`;
  preview.replaceChildren(...stampPixels.map(color => {
    const cell = document.createElement('span');
    if (color) cell.style.background = `rgba(${color[0]},${color[1]},${color[2]},${color[3] / 255})`;
    return cell;
  }));
}

function initSectionReordering(): void {
  if (!root) return;
  const sections = () => [...root!.querySelectorAll<HTMLElement>(':scope > [data-head-painter-section]')];
  const clearPreview = () => sections().forEach(section => section.classList.remove('head-painter-section-drop-before', 'head-painter-section-drop-after'));
  const completeOrder = (value: unknown): string[] | null => {
    if (!Array.isArray(value) || value.some(id => !sectionIds.includes(id))) return null;
    const known = value.filter((id): id is typeof sectionIds[number] => sectionIds.includes(id));
    return [...new Set([...known, ...sectionIds])];
  };
  try {
    const savedOrder: unknown = JSON.parse(localStorage.getItem(sectionOrderKey) ?? 'null');
    const order = completeOrder(savedOrder);
    if (order) sections()
      .sort((a, b) => order.indexOf(a.dataset.headPainterSection!) - order.indexOf(b.dataset.headPainterSection!))
      .forEach(section => root!.append(section));
  } catch {
    // Ignore invalid saved order.
  }
  sections().forEach(section => section.querySelectorAll<HTMLElement>(':scope > legend, :scope > fieldset > legend').forEach(legend => {
    legend.onpointerdown = event => {
      if (!event.isPrimary || event.button !== 0) return;
      const pointerId = event.pointerId;
      const startX = event.clientX;
      const startY = event.clientY;
      let clientX = startX;
      let clientY = startY;
      let dragging = false;
      let dropTarget: HTMLElement | null = null;
      let dropAfter = false;
      let dragPreview: HTMLElement | null = null;
      const scrollContainer = root!.parentElement!;
      const positionDragPreview = () => {
        if (!dragPreview) return;
        dragPreview.style.left = `${Math.min(clientX + 12, window.innerWidth - dragPreview.offsetWidth - 8)}px`;
        dragPreview.style.top = `${Math.min(clientY + 12, window.innerHeight - dragPreview.offsetHeight - 8)}px`;
      };
      const updatePreview = () => {
        clearPreview();
        dropTarget = document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>('[data-head-painter-section]') ?? null;
        if (!dropTarget || dropTarget === section || dropTarget.parentElement !== root) {
          dropTarget = null;
          return;
        }
        const rect = dropTarget.getBoundingClientRect();
        dropAfter = clientY >= rect.top + rect.height / 2;
        dropTarget.classList.add(dropAfter ? 'head-painter-section-drop-after' : 'head-painter-section-drop-before');
      };
      const cleanup = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', stop);
        window.removeEventListener('pointercancel', cancel);
        window.removeEventListener('keydown', cancelWithEscape);
        scrollContainer.removeEventListener('scroll', updatePreview);
        if (legend.hasPointerCapture(pointerId)) legend.releasePointerCapture(pointerId);
        dragPreview?.remove();
        dragPreview = null;
        document.body.classList.remove('head-painter-section-reordering');
        clearPreview();
      };
      const move = (moveEvent: PointerEvent) => {
        if (moveEvent.pointerId !== pointerId) return;
        clientX = moveEvent.clientX;
        clientY = moveEvent.clientY;
        if (!dragging) {
          if (Math.hypot(clientX - startX, clientY - startY) < 4) return;
          dragging = true;
          legend.setPointerCapture(pointerId);
          document.body.classList.add('head-painter-section-reordering');
          scrollContainer.addEventListener('scroll', updatePreview, { passive: true });
          dragPreview = document.createElement('div');
          dragPreview.className = 'head-painter-section-drag-preview';
          dragPreview.textContent = legend.textContent?.trim() ?? '';
          document.body.append(dragPreview);
        }
        moveEvent.preventDefault();
        positionDragPreview();
        updatePreview();
      };
      const stop = (upEvent: PointerEvent) => {
        if (upEvent.pointerId !== pointerId) return;
        if (dragging && dropTarget) {
          dropAfter ? dropTarget.after(section) : dropTarget.before(section);
          localStorage.setItem(sectionOrderKey, JSON.stringify(sections().map(item => item.dataset.headPainterSection)));
        }
        cleanup();
      };
      const cancel = (cancelEvent: PointerEvent) => {
        if (cancelEvent.pointerId === pointerId) cleanup();
      };
      const cancelWithEscape = (keyEvent: KeyboardEvent) => {
        if (keyEvent.key !== 'Escape') return;
        keyEvent.preventDefault();
        cleanup();
      };
      window.addEventListener('pointermove', move, { passive: false });
      window.addEventListener('pointerup', stop);
      window.addEventListener('pointercancel', cancel);
      window.addEventListener('keydown', cancelWithEscape);
    };
  }));
  if (import.meta.env.DEV) console.assert(completeOrder(['grid', 'brush', 'palette'])?.join() === sectionIds.join(), 'Head Painter section order migration failed.');
}

function initPlayerGenerator(): void {
  if (!root) return;
  const section = root.querySelector<HTMLElement>('[data-head-painter-section="model-generator"]')!;
  const skinInput = section.querySelector<HTMLInputElement>('[data-skin-file]')!;
  const imageInput = section.querySelector<HTMLInputElement>('[data-image-file]')!;
  const slimInput = section.querySelector<HTMLInputElement>('[data-slim]')!;
  const status = section.querySelector<HTMLElement>('[data-generator-status]')!;
  let target: 'player' | 'head' | 'image' = 'player';
  let playerModel: PlayerModel | null = null;
  let imageLayer: 0 | 1 = 0;
  let busy = false;

  const sync = () => {
    section.querySelectorAll<HTMLButtonElement>('[data-generator-target]').forEach(button => {
      const selected = button.dataset.generatorTarget === target;
      button.classList.toggle('active', selected);
      button.setAttribute('aria-pressed', String(selected));
    });
    section.querySelectorAll<HTMLButtonElement>('[data-player-model]').forEach(button => {
      const selected = button.dataset.playerModel === playerModel;
      button.classList.toggle('active', selected);
      button.setAttribute('aria-pressed', String(selected));
    });
    section.querySelector<HTMLElement>('[data-player-options]')!.hidden = target !== 'player';
    section.querySelector<HTMLElement>('[data-skin-controls]')!.hidden = target === 'image' || (target === 'player' && !playerModel);
    section.querySelector<HTMLElement>('[data-image-controls]')!.hidden = target !== 'image';
  };
  const setBusy = (value: boolean) => {
    busy = value;
    section.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button, input').forEach(control => { control.disabled = value; });
  };
  const decodePng = async (value: Blob): Promise<HTMLCanvasElement> => {
    const bitmap = await createImageBitmap(value);
    try {
      if (bitmap.width !== 64 || bitmap.height !== 64) throw new Error('64×64 PNG만 사용할 수 있습니다.');
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 64;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) throw new Error('스킨 캔버스를 만들 수 없습니다.');
      context.imageSmoothingEnabled = false;
      context.drawImage(bitmap, 0, 0);
      return canvas;
    } finally {
      bitmap.close();
    }
  };
  const merge = async (file: File, message: string) => {
    const before = captureSceneState(loadedObjectGroup);
    await loadAndRenderPbde(file, true);
    recordSceneChange(loadedObjectGroup, before);
    window.dispatchEvent(new CustomEvent('pde:scene-updated'));
    status.textContent = message;
  };
  const run = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    status.textContent = '생성 중…';
    try {
      await action();
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : String(error);
    } finally {
      setBusy(false);
    }
  };
  const generateFromSkin = async (canvas: HTMLCanvasElement, skinModel: SkinModel, suffix = '') => {
    slimInput.checked = skinModel === 'slim';
    const file = target === 'head' ? createHeadProject(canvas) : createPlayerProject(canvas, playerModel!, skinModel);
    await merge(file, `${target === 'head' ? 'Head' : 'Player'} 생성 완료${suffix}`);
  };

  section.querySelectorAll<HTMLButtonElement>('[data-generator-target]').forEach(button => button.onclick = () => {
    target = button.dataset.generatorTarget as typeof target;
    sync();
  });
  section.querySelectorAll<HTMLButtonElement>('[data-player-model]').forEach(button => button.onclick = () => {
    playerModel = button.dataset.playerModel as PlayerModel;
    sync();
  });
  section.querySelector<HTMLButtonElement>('[data-load-skin]')!.onclick = () => skinInput.click();
  skinInput.onchange = () => void run(async () => {
    const file = skinInput.files?.[0];
    skinInput.value = '';
    if (!file || file.type !== 'image/png') throw new Error('PNG 파일을 선택해 주세요.');
    const canvas = await decodePng(file);
    const pixels = canvas.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, 64, 64).data;
    await generateFromSkin(canvas, isSlimSkin(pixels) ? 'slim' : 'classic');
  });
  section.querySelector<HTMLButtonElement>('[data-load-username]')!.onclick = () => void run(async () => {
    const input = section.querySelector<HTMLInputElement>('[data-username]')!;
    if (!input.reportValidity()) throw new Error('닉네임은 영문, 숫자, 밑줄 3–16자로 입력해 주세요.');
    const result = await window.ipcApi.getMinecraftSkin(input.value);
    if (!result.success || !result.png || !result.model) throw new Error(result.error ?? '스킨을 불러오지 못했습니다.');
    input.value = result.username ?? input.value;
    const png = new Uint8Array(result.png.byteLength);
    png.set(result.png);
    await generateFromSkin(await decodePng(new Blob([png], { type: 'image/png' })), result.model, result.usedFallback ? ' · Pangch 대체' : '');
  });
  section.querySelectorAll<HTMLButtonElement>('[data-image-layer]').forEach(button => button.onclick = () => {
    imageLayer = Number(button.dataset.imageLayer) as 0 | 1;
    imageInput.click();
  });
  imageInput.onchange = () => void run(async () => {
    const file = imageInput.files?.[0];
    imageInput.value = '';
    if (!file || file.type !== 'image/png') throw new Error('PNG 파일을 선택해 주세요.');
    const bitmap = await createImageBitmap(file);
    try {
      const before = captureSceneState(loadedObjectGroup);
      const count = addImageHeadGrid(bitmap, imageLayer, file.name);
      recordSceneChange(loadedObjectGroup, before);
      window.dispatchEvent(new CustomEvent('pde:scene-updated'));
      status.textContent = `이미지 ${imageLayer + 1}번 레이어 · ${count.toLocaleString()}개 생성 완료`;
    } finally {
      bitmap.close();
    }
  });
  sync();
}

function createPanel(): void {
  root = document.createElement('section');
  root.className = 'head-painter-panel';
  root.hidden = true;
  root.innerHTML = `
    <div class="head-painter-tools" aria-label="Head Painter 도구">
      ${(['brush', 'bucket', 'eraser', 'picker', 'stamp', 'select'] as Tool[]).map(tool => `<button type="button" class="head-painter-tool lucide-icon" data-tool="${tool}" aria-label="${toolLabels[tool]}" title="${toolLabels[tool]}">${toolIcons[tool]}</button>`).join('')}
    </div>
    <div class="head-painter-section" data-head-painter-section="grid">
    <fieldset>
      <legend>레이어와 그리드</legend>
      <label>2번 레이어 <select id="head-painter-layer"><option value="auto">기본</option><option value="layer">켜기</option><option value="base">끄기</option></select></label>
      <div class="head-painter-inline"><label>가로 <input id="head-painter-grid-horizontal" type="number" min="0" max="8" value="8"></label><label>세로 <input id="head-painter-grid-vertical" type="number" min="0" max="8" value="8"></label></div>
      <label>그리드 색상 <span class="head-painter-brush-color"><button id="head-painter-grid-color-picker" class="head-painter-color-preview" type="button" aria-label="그리드 색상 선택"></button><input id="head-painter-grid-color" value="#70C7FF" aria-label="그리드 색상 코드"></span></label>
      <div class="head-painter-checks"><label><input id="head-painter-grid" type="checkbox" checked> 그리드</label><label><input id="head-painter-smart-grid" type="checkbox" checked> 스마트 그리드</label><label class="head-painter-overwrite"><input id="head-painter-overwrite" type="checkbox"> 픽셀 덮어쓰기</label><label><input id="head-painter-adjacent" type="checkbox" checked> 인접 헤드 페인트</label></div>
    </fieldset>
    </div>
    <div class="head-painter-tool-settings" data-head-painter-section="brush">
    <fieldset data-tool-settings="brush">
      <legend>브러시</legend>
      <label>모양 <select id="head-painter-brush-shape"><option value="square">사각형</option><option value="circle">원형</option></select></label>
      <div class="head-painter-inline"><label>가로 <input id="head-painter-brush-width" type="number" min="1" max="8" value="1"></label><label>세로 <input id="head-painter-brush-height" type="number" min="1" max="8" value="1"></label></div>
      <label>강도 <span class="head-painter-range"><input id="head-painter-brush-strength-range" type="range" min="0" max="100" value="100"><input id="head-painter-brush-strength" type="number" min="0" max="100" value="100"></span></label>
      <label>간격 % <span class="head-painter-range"><input id="head-painter-brush-spacing-range" type="range" min="1" max="100" value="25"><input id="head-painter-brush-spacing" type="number" min="1" max="100" value="25"></span></label>
      <div class="head-painter-custom-brush"><span>기본 브러시</span><button type="button" class="lucide-icon" data-basic-brush="square" aria-label="브러시 선택" title="브러시 선택">${toolIcons.brush}</button><button type="button" class="lucide-icon" aria-label="설정" title="설정" disabled>\uE2F0</button><button type="button" class="lucide-icon" aria-label="삭제" title="삭제" disabled>\uE18E</button></div>
      <div class="head-painter-custom-brushes"></div><button type="button" id="head-painter-add-brush">+ 커스텀 브러시</button>
    </fieldset>
    <fieldset data-tool-settings="bucket" hidden><legend>양동이</legend><small>클릭: 같은 RGBA · Shift: 인접한 같은 RGBA · Ctrl: 6면 전체</small></fieldset>
    <fieldset data-tool-settings="eraser" hidden>
      <legend>지우개</legend>
      <label>크기 <span class="head-painter-range"><input id="head-painter-eraser-size-range" type="range" min="1" max="8" value="1"><input id="head-painter-eraser-size" type="number" min="1" max="8" value="1"></span></label>
      <label>경도 <span class="head-painter-range"><input id="head-painter-eraser-hardness-range" type="range" min="0" max="100" value="100"><input id="head-painter-eraser-hardness" type="number" min="0" max="100" value="100"></span></label>
      <label>강도 <span class="head-painter-range"><input id="head-painter-eraser-strength-range" type="range" min="0" max="100" value="100"><input id="head-painter-eraser-strength" type="number" min="0" max="100" value="100"></span></label>
    </fieldset>
    <fieldset data-tool-settings="picker" hidden><legend>색상선택</legend><small>Alt로 화면색을 선택합니다.</small></fieldset>
    <fieldset data-tool-settings="stamp" hidden>
      <legend>스탬프</legend>
      <div class="head-painter-inline"><label>가로 <input id="head-painter-stamp-width" type="number" min="0" max="8" value="8"></label><label>세로 <input id="head-painter-stamp-height" type="number" min="0" max="8" value="8"></label></div>
      <div class="head-painter-stamp-actions"><button type="button" data-stamp="left" class="lucide-icon" aria-label="왼쪽 회전" title="왼쪽 회전">\uE148</button><button type="button" data-stamp="right" class="lucide-icon" aria-label="오른쪽 회전" title="오른쪽 회전">\uE149</button><button type="button" data-stamp="vertical" class="lucide-icon" aria-label="상하 반전" title="상하 반전">\uE35E</button><button type="button" data-stamp="horizontal" class="lucide-icon" aria-label="좌우 반전" title="좌우 반전">\uE35D</button></div>
      <div class="head-painter-stamp-preview"></div>
      <small>Shift+클릭으로 복사, 클릭으로 배치</small>
    </fieldset>
    </div>
    <div class="head-painter-section" data-head-painter-section="palette">
    <fieldset class="head-painter-color-area">
      <legend>팔레트</legend>
      <div class="head-painter-color-row"><button id="head-painter-palette-color-picker" class="head-painter-color-preview" type="button" aria-label="색상 선택"></button><select id="head-painter-color-mode"><option value="rgb">일반</option><option value="oklch">OKLCH</option></select><input id="head-painter-color" value="#000000"></div>
      <label>알파 <span class="head-painter-range"><input id="head-painter-alpha-range" type="range" min="0" max="255" value="255"><input id="head-painter-alpha" type="number" min="0" max="255" value="255"></span></label>
      <div class="head-painter-palette"></div>
      <div class="head-painter-palette-actions"><button type="button" data-sort>색 정렬</button><button type="button" data-clear>지우기</button></div>
      <div class="head-painter-preset"><button class="head-painter-preset-button" type="button">팔레트 목록</button><div class="head-painter-preset-menu" hidden></div></div>
    </fieldset>
    </div>
    <div class="head-painter-section" data-head-painter-section="model-generator">
      <fieldset class="head-painter-generator">
        <legend>모델 생성</legend>
        <div class="head-painter-generator-tabs">
          <button type="button" data-generator-target="player" aria-label="플레이어 모델" title="플레이어 모델"><span class="lucide-icon">\uE19F</span></button>
          <button type="button" data-generator-target="head" aria-label="플레이어 머리 모델" title="플레이어 머리 모델">${generatorPlayerHeadIcon}</button>
          <button type="button" data-generator-target="image" aria-label="이미지 모델" title="이미지 모델"><span class="lucide-icon">\uE0F6</span></button>
        </div>
        <div data-player-options>
          <div class="head-painter-generator-tabs"><button type="button" data-player-model="default"><span class="lucide-icon">\uE19F</span> 기본</button><button type="button" data-player-model="animation"><span class="lucide-icon">\uE1A2</span> 애니메이션</button></div>
          <label class="head-painter-generator-check"><input type="checkbox" data-slim> 슬림</label>
        </div>
        <div class="head-painter-generator-load" data-skin-controls hidden>
          <button type="button" data-load-skin><span class="lucide-icon">\uE091</span> 텍스쳐 기반 불러오기</button>
          <div><input data-username required pattern="[A-Za-z0-9_]{3,16}" minlength="3" maxlength="16" placeholder="닉네임" aria-label="Minecraft 닉네임"><button type="button" data-load-username><span class="lucide-icon">\uE19E</span> 닉네임으로 불러오기</button></div>
          <input data-skin-file type="file" accept="image/png" hidden>
        </div>
        <div class="head-painter-generator-tabs" data-image-controls hidden>
          <button type="button" data-image-layer="0"><span class="lucide-icon">\uE0F6</span> 1번 레이어</button><button type="button" data-image-layer="1"><span class="lucide-icon">\uE5C4</span> 2번 레이어</button>
          <input data-image-file type="file" accept="image/png" hidden>
        </div>
        <small data-generator-status role="status" aria-live="polite"></small>
      </fieldset>
    </div>
    <div class="head-painter-section" data-head-painter-section="texture-generator">
      <fieldset><legend>텍스쳐 생성</legend><button type="button"><span class="lucide-icon">\uE1D3</span> 텍스쳐 생성</button></fieldset>
    </div>`;
  document.getElementById('head-painter')!.append(root);
  initSectionReordering();
  initPlayerGenerator();
  createBrushEditor();

  root.querySelectorAll<HTMLButtonElement>('.head-painter-tool').forEach(button => button.onclick = () => setTool(button.dataset.tool as Tool));
  root.querySelector<HTMLButtonElement>('.head-painter-preset-button')!.onclick = () => {
    const menu = root!.querySelector<HTMLElement>('.head-painter-preset-menu')!;
    menu.hidden = !menu.hidden;
  };
  root.querySelector<HTMLSelectElement>('#head-painter-layer')!.onchange = event => {
    layerMode = (event.target as HTMLSelectElement).value as LayerMode;
    setPlayerHeadLayerVisible(layerMode !== 'base');
    invalidateHeadPainterGridOverlay();
  };
  root.querySelector<HTMLInputElement>('#head-painter-grid-horizontal')!.oninput = event => {
    gridHorizontal = clampGrid(Number((event.target as HTMLInputElement).value));
    (event.target as HTMLInputElement).value = String(gridHorizontal);
    invalidateHeadPainterGridOverlay();
  };
  root.querySelector<HTMLInputElement>('#head-painter-grid-vertical')!.oninput = event => {
    gridVertical = clampGrid(Number((event.target as HTMLInputElement).value));
    (event.target as HTMLInputElement).value = String(gridVertical);
    invalidateHeadPainterGridOverlay();
  };
  const gridColorPicker = root.querySelector<HTMLButtonElement>('#head-painter-grid-color-picker')!;
  const gridColorInput = root.querySelector<HTMLInputElement>('#head-painter-grid-color')!;
  const syncGridColor = () => {
    gridColorPicker.style.background = `rgb(${gridColor.join(' ')})`;
    gridColorInput.value = formatHexColor(gridColor);
    localStorage.setItem(gridColorKey, gridColorInput.value);
    invalidateHeadPainterGridOverlay();
  };
  syncGridColor();
  gridColorPicker.onclick = () => openColorPicker(gridColorPicker, gridColor, color => {
    gridColor = color;
    syncGridColor();
  });
  gridColorInput.onchange = () => {
    const color = parseColor(gridColorInput.value, 255);
    if (color) gridColor = color.slice(0, 3) as [number, number, number];
    syncGridColor();
  };
  root.querySelector<HTMLInputElement>('#head-painter-grid')!.onchange = event => { gridEnabled = (event.target as HTMLInputElement).checked; invalidateHeadPainterGridOverlay(); };
  root.querySelector<HTMLInputElement>('#head-painter-smart-grid')!.onchange = event => { smartGrid = (event.target as HTMLInputElement).checked; invalidateHeadPainterGridOverlay(); };
  root.querySelector<HTMLSelectElement>('#head-painter-brush-shape')!.onchange = event => {
    brushShape = (event.target as HTMLSelectElement).value as typeof brushShape;
    syncBrushControls();
    renderCustomBrushes();
  };
  root.querySelectorAll<HTMLButtonElement>('[data-basic-brush]').forEach(button => button.onclick = () => {
    brushShape = button.dataset.basicBrush as typeof brushShape;
    root!.querySelector<HTMLSelectElement>('#head-painter-brush-shape')!.value = brushShape;
    syncBrushControls();
    renderCustomBrushes();
  });
  root.querySelector<HTMLButtonElement>('#head-painter-add-brush')!.onclick = () => void addCustomBrush();
  root.querySelector<HTMLInputElement>('#head-painter-brush-width')!.oninput = event => setBrushValue('width', Math.min(8, Math.max(1, Number((event.target as HTMLInputElement).value) || 1)));
  root.querySelector<HTMLInputElement>('#head-painter-brush-height')!.oninput = event => setBrushValue('height', Math.min(8, Math.max(1, Number((event.target as HTMLInputElement).value) || 1)));
  bindRangePair('head-painter-brush-strength', 0, 100, value => setBrushValue('strength', value));
  bindRangePair('head-painter-brush-spacing', 1, 100, value => setBrushValue('spacing', value));
  bindRangePair('head-painter-eraser-size', 1, 8, value => { eraserSize = value; });
  bindRangePair('head-painter-eraser-hardness', 0, 100, value => { eraserHardness = value; });
  bindRangePair('head-painter-eraser-strength', 0, 100, value => { eraserStrength = value; });
  root.querySelector<HTMLInputElement>('#head-painter-overwrite')!.onchange = event => { overwrite = (event.target as HTMLInputElement).checked; };
  root.querySelector<HTMLInputElement>('#head-painter-adjacent')!.onchange = event => { paintAdjacentHeads = (event.target as HTMLInputElement).checked; };
  root.querySelector<HTMLInputElement>('#head-painter-stamp-width')!.oninput = event => resizeStamp(Number((event.target as HTMLInputElement).value), stampHeight);
  root.querySelector<HTMLInputElement>('#head-painter-stamp-height')!.oninput = event => resizeStamp(stampWidth, Number((event.target as HTMLInputElement).value));
  root.querySelectorAll<HTMLButtonElement>('[data-stamp]').forEach(button => button.onclick = () => transformStamp(button.dataset.stamp as 'left' | 'right' | 'vertical' | 'horizontal'));
  root.querySelector<HTMLSelectElement>('#head-painter-color-mode')!.onchange = event => {
    colorMode = (event.target as HTMLSelectElement).value as typeof colorMode;
    syncColorControls();
  };
  const colorInput = root.querySelector<HTMLInputElement>('#head-painter-color')!;
  const colorPicker = root.querySelector<HTMLElement>('#head-painter-palette-color-picker')!;
  const alphaInput = root.querySelector<HTMLInputElement>('#head-painter-alpha')!;
  const alphaRange = root.querySelector<HTMLInputElement>('#head-painter-alpha-range')!;
  const updateColor = (writePalette: boolean) => {
    const parsed = parseColor(colorInput.value, Number(alphaInput.value));
    if (!parsed) {
      colorInput.setCustomValidity('');
      syncColorControls();
      return;
    }
    colorInput.setCustomValidity('');
    setCurrentColor(parsed, writePalette);
  };
  colorInput.onchange = () => updateColor(true);
  colorPicker.onclick = openPainterColorPicker;
  const updateAlpha = (source: HTMLInputElement) => {
    const alpha = clampByte(Number(source.value));
    alphaInput.value = alphaRange.value = String(alpha);
    currentColor[3] = alpha;
    palette[activePaletteSlot] = cloneRgba(currentColor);
    saveActivePalette();
    syncColorControls();
    renderPalette();
  };
  alphaInput.oninput = () => updateAlpha(alphaInput);
  alphaRange.oninput = () => updateAlpha(alphaRange);
  root.querySelector<HTMLButtonElement>('[data-sort]')!.onclick = () => {
    const colors = palette.filter((color): color is Rgba => !!color).sort((a, b) =>
      (a[0] * 0x1000000 + a[1] * 0x10000 + a[2] * 0x100 + a[3]) - (b[0] * 0x1000000 + b[1] * 0x10000 + b[2] * 0x100 + b[3]));
    palette = [...colors, ...Array<Rgba | null>(64 - colors.length).fill(null)];
    activePaletteSlot = Math.min(activePaletteSlot, Math.max(0, colors.length - 1));
    saveActivePalette();
    renderPalette();
  };
  root.querySelector<HTMLButtonElement>('[data-clear]')!.onclick = () => {
    palette = Array(64).fill(null);
    activePaletteSlot = 0;
    paletteAnchor = null;
    saveActivePalette();
    renderPalette();
  };
  renderToolSettings();
  syncBrushControls();
  syncStampInputs();
  syncColorControls();
  renderPalette();
  void loadPainterAssets();
}

export function setHeadPainterEnabled(enabled: boolean): void {
  if (active === enabled) return;
  active = enabled;
  if (!root) createPanel();
  document.getElementById('head-painter')!.hidden = !enabled;
  const toolbarButton = document.querySelectorAll<HTMLElement>('#scene-toolbar i')[4];
  toolbarButton?.classList.toggle('head-painter-active', enabled);
  toolbarButton?.setAttribute('aria-pressed', String(enabled));
  root!.hidden = !enabled;
  window.dispatchEvent(new Event('pde:panel-visibility-changed'));
  if (painterContext) {
    if (enabled) painterContext.renderer.domElement.dataset.headPainterTool = lastTool;
    else delete painterContext.renderer.domElement.dataset.headPainterTool;
  }
  loadedObjectGroup.userData.headPainterActive = enabled;
  if (enabled) {
    (loadedObjectGroup.userData.resetSelection as (() => void) | undefined)?.();
    setPlayerHeadLayerVisible(layerMode !== 'base');
    invalidateHeadPainterGridOverlay();
    updateHeadPainter();
  } else {
    endPaintPointer();
    setAltPicking(false);
    setPlayerHeadLayerVisible(true);
    removeHeadPainterGridOverlay();
    removeHeadPainterStampPreview();
    if (brushEditor) brushEditor.hidden = true;
    window.dispatchEvent(new CustomEvent('pde:selection-changed', { detail: currentSelection }));
  }
}

export function toggleHeadPainter(): void {
  setHeadPainterEnabled(!active);
}

export function initHeadPainter(context: PainterContext): void {
  painterContext = context;
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('keyup', onKeyUp, true);
  window.addEventListener('pointerdown', onPointerDown, true);
  window.addEventListener('pointermove', onPointerMove, true);
  window.addEventListener('pointerup', onPointerUp, true);
  window.addEventListener('pointercancel', onPointerUp, true);
  if (active) {
    setPlayerHeadLayerVisible(layerMode !== 'base');
    invalidateHeadPainterGridOverlay();
  }
}

window.addEventListener('pde:scene-updated', () => {
  if (active) setPlayerHeadLayerVisible(layerMode !== 'base');
  invalidateHeadPainterGridOverlay();
});
window.addEventListener('pde:object-transform-changed', invalidateHeadPainterGridOverlay);
window.addEventListener('pde:history-restored', invalidateHeadPainterGridOverlay);
document.addEventListener('pointerdown', event => {
  const menu = root?.querySelector<HTMLElement>('.head-painter-preset-menu');
  const preset = root?.querySelector<HTMLElement>('.head-painter-preset');
  if (menu && preset && !preset.contains(event.target as Node)) menu.hidden = true;
});

if (import.meta.env.DEV) {
  const black = oklchToRgb(rgbToOklch([0, 0, 0]));
  const redBlueMiddle = interpolateColor([255, 0, 0, 0], [0, 0, 255, 255], 0.5);
  console.assert(pixelOffset(facePartIndexes[0], 0, 0) === 8 * 4 && pixelOffset(facePartIndexes[4] + 6, 7, 7) < blockWidth * blockHeight * 4, 'Head face to texture mapping failed.');
  console.assert(black[0] === 0 && black[1] === 0 && black[2] === 0 && redBlueMiddle[3] === 128, 'OKLCH conversion or alpha interpolation failed.');
  const [smartHorizontal, smartVertical] = smartCounts(8, 8, 1, 3);
  console.assert(smartHorizontal === 2 && smartVertical === 8 && partSize % smartHorizontal === 0 && partSize % smartVertical === 0 && smartCounts(0, 8, 1, 3)[0] === 0, 'Smart grid limits failed.');
  console.assert(gridBoundary(1, 4) === 2 && gridBoundary(2, 4) === 4, 'Grid paint boundaries failed.');
  console.assert(gridCellCenter(-1, 8) === -0.0625 && gridCellCenter(8, 8) === 1.0625, 'Adjacent head brush projection failed.');
  console.assert(canPaintHead('first', 'first', false) && !canPaintHead('first', 'second', false) && canPaintHead('first', 'second', true), 'Adjacent head paint restriction failed.');
  console.assert(isSamePaintFace(2, 2) && !isSamePaintFace(2, 0), 'Adjacent head brush changed faces.');
  console.assert(centeredOffsets(2, 1).map(offset => offset.x).join() === '-1,0' && centeredOffsets(3, 1).map(offset => offset.x).join() === '-1,0,1', 'Centered paint offsets failed.');
  const [sideOrigin, sideHorizontal] = getHeadPainterFaceAxes(0, 1);
  const [topOrigin, topHorizontal, topVertical] = getHeadPainterFaceAxes(2, 1);
  console.assert(sideOrigin.x === 0.5 && sideHorizontal.z === -1 && topOrigin.x === 0.5 && topHorizontal.x === -1 && topVertical.z === 1, 'Head painter face axes failed.');
  gridOverrides.set('__grid_override_check__', { horizontal: 3, vertical: 5 });
  const [manualHorizontal, manualVertical] = getFaceGridCounts('__grid_override_check__', 0, new Matrix4());
  gridOverrides.delete('__grid_override_check__');
  console.assert(manualHorizontal === 3 && manualVertical === 5, 'Per-head grid override was ignored.');
  console.assert(clampGrid(-1) === 0 && clampGrid(9) === 8 && clampByte(300) === 255, 'Head Painter input limits failed.');
  const savedStamp = { width: stampWidth, height: stampHeight, pixels: stampPixels };
  stampWidth = 2; stampHeight = 1; stampPixels = [[1, 0, 0, 255], [2, 0, 0, 255]];
  transformStamp('right');
  console.assert(stampWidth === 1 && stampHeight === 2 && stampPixels[0]?.[0] === 1 && stampPixels[1]?.[0] === 2, 'Stamp rotation failed.');
  transformStamp('vertical');
  console.assert(stampPixels[0]?.[0] === 2, 'Stamp flip failed.');
  stampWidth = savedStamp.width; stampHeight = savedStamp.height; stampPixels = savedStamp.pixels;
  console.assert(facePartIndexes.map(index => index + 6).length === 6, 'Bucket six-face scope failed.');
  console.assert(connectedCellIndexes(3, 2, 0, index => index % 3 !== 1).join() === '0,3', 'Bucket connected fill failed.');
}
