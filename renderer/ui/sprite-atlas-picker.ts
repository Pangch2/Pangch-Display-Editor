import { getAssetBytes, getAssetUrl } from '../asset-manager';
import { closeWithAnimation, openWithAnimation } from './ui-open-close.js';

type SpriteAtlasEntry = { name: string; id: string; url: string };
type SpriteEntry = { id: string; x: number; y: number; width: number; height: number };
type SpriteAtlasSource = { image: HTMLImageElement; sprites: SpriteEntry[] };

const overlay = document.createElement('div');
overlay.className = 'block-item-search';
overlay.hidden = true;
overlay.innerHTML = `
  <section class="block-item-search-window">
    <header>
      <span></span>
      <input type="search" aria-label="검색" placeholder="검색">
      <button type="button" aria-label="닫기">×</button>
    </header>
    <div class="block-item-search-content"><div class="sprite-atlas-search-grid"></div></div>
  </section>
`;
document.body.appendChild(overlay);

const title = overlay.querySelector<HTMLElement>('header span')!;
const searchInput = overlay.querySelector<HTMLInputElement>('input')!;
const grid = overlay.querySelector<HTMLElement>('.sprite-atlas-search-grid')!;
const searchWindow = overlay.querySelector<HTMLElement>('.block-item-search-window')!;
const canvas = document.createElement('canvas');
const context = canvas.getContext('2d')!;
const tileSize = 72;
const gap = 3;
const columns = 9;
const spriteSources = new Map<string, Promise<SpriteAtlasSource>>();
let entriesPromise: Promise<SpriteAtlasEntry[]> | null = null;
let mode: 'atlas' | 'sprite' = 'atlas';
const searchValues = { atlas: '', sprite: '' };
let selectedAtlas = '';
let selectedSprite = '';
let visibleSprites: SpriteEntry[] = [];
let activeSpriteSource: SpriteAtlasSource | null = null;
let onSelectAtlas: (atlas: string) => void | Promise<void> = () => {};
let onSelectSprite: (sprite: string) => void | Promise<void> = () => {};
let loadId = 0;
let applying = false;

function filterEntries<T extends { id: string }>(entries: T[], query: string): T[] {
  const normalized = query.trim().toLowerCase().replace(/ /g, '_');
  return normalized ? entries.filter(entry => entry.id.toLowerCase().includes(normalized)) : entries;
}

function loadAtlases(): Promise<SpriteAtlasEntry[]> {
  return entriesPromise ??= window.ipcApi.listSpriteAtlases().then(async result => {
    if (!result.success) throw new Error(result.error ?? '스프라이트 아틀라스를 불러오지 못했습니다.');
    return Promise.all(result.atlases.map(async name => ({
      name,
      id: `minecraft:${name}`,
      url: await getAssetUrl(`sprite-atlases/${name}.png`)
    })));
  }).catch(error => {
    entriesPromise = null;
    throw error;
  });
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('스프라이트 아틀라스 이미지를 불러오지 못했습니다.'));
    image.src = url;
  });
}

function loadSpriteSource(atlas: string): Promise<SpriteAtlasSource> {
  const cached = spriteSources.get(atlas);
  if (cached) return cached;
  const promise = loadAtlases().then(async atlases => {
    const entry = atlases.find(candidate => candidate.id === atlas);
    if (!entry) throw new Error(`아틀라스를 찾을 수 없습니다: ${atlas}`);
    const [bytes, image] = await Promise.all([
      getAssetBytes(`sprite-atlases/${entry.name}.json`),
      loadImage(entry.url)
    ]);
    const manifest = JSON.parse(new TextDecoder().decode(bytes)) as { sprites?: SpriteEntry[] };
    if (!Array.isArray(manifest.sprites)) throw new Error(`잘못된 아틀라스 정보입니다: ${atlas}`);
    const sprites = manifest.sprites.filter(sprite =>
      typeof sprite.id === 'string'
      && [sprite.x, sprite.y, sprite.width, sprite.height].every(Number.isFinite)
      && sprite.width > 0 && sprite.height > 0
    ).sort((left, right) => left.id.localeCompare(right.id));
    return { image, sprites };
  }).catch(error => {
    spriteSources.delete(atlas);
    throw error;
  });
  spriteSources.set(atlas, promise);
  return promise;
}

const minecraftId = (value: string): string => value.includes(':') ? value : `minecraft:${value}`;

export async function isValidSpriteReference(atlas: string, sprite: string): Promise<boolean> {
  try {
    return (await loadSpriteSource(minecraftId(atlas))).sprites.some(entry => entry.id === minecraftId(sprite));
  } catch {
    return false;
  }
}

export async function resolveSpriteReference(atlas: string, sprite: string): Promise<string | null> {
  try {
    const sprites = (await loadSpriteSource(minecraftId(atlas))).sprites;
    return sprites.find(entry => entry.id === minecraftId(sprite))?.id ?? sprites[0]?.id ?? null;
  } catch {
    return null;
  }
}

function renderAtlases(entries: SpriteAtlasEntry[]): void {
  const visible = filterEntries(entries, searchInput.value);
  grid.className = 'sprite-atlas-search-grid';
  if (!visible.length) {
    grid.textContent = '검색 결과 없음';
    return;
  }
  grid.replaceChildren(...visible.map(entry => {
    const button = document.createElement('button');
    button.type = 'button';
    button.title = entry.id;
    button.ariaPressed = String(entry.id === selectedAtlas);
    const image = document.createElement('img');
    image.src = entry.url;
    image.alt = '';
    const label = document.createElement('span');
    label.textContent = entry.name;
    button.append(image, label);
    button.onclick = () => applySelection(() => onSelectAtlas(entry.id), '아틀라스 선택에 실패했습니다.');
    return button;
  }));
}

function renderSprites(source: SpriteAtlasSource): void {
  activeSpriteSource = source;
  visibleSprites = filterEntries(source.sprites, searchInput.value);
  grid.className = 'block-item-search-grid';
  if (!visibleSprites.length) {
    grid.textContent = '검색 결과 없음';
    return;
  }
  grid.replaceChildren(canvas);
  canvas.width = columns * (tileSize + gap) - gap;
  canvas.height = Math.ceil(visibleSprites.length / columns) * (tileSize + gap) - gap;
  context.imageSmoothingEnabled = false;
  visibleSprites.forEach((sprite, index) => {
    const x = index % columns * (tileSize + gap);
    const y = Math.floor(index / columns) * (tileSize + gap);
    context.beginPath();
    context.roundRect(x + 1.5, y + 1.5, tileSize - 3, tileSize - 3, 8);
    context.fillStyle = '#252528';
    context.fill();
    context.strokeStyle = sprite.id === selectedSprite ? '#ef3751' : '#45454a';
    context.lineWidth = 3;
    context.stroke();
    const scale = Math.min((tileSize - 14) / sprite.width, (tileSize - 14) / sprite.height);
    const width = sprite.width * scale;
    const height = sprite.height * scale;
    context.drawImage(source.image, sprite.x, sprite.y, sprite.width, sprite.height,
      x + (tileSize - width) / 2, y + (tileSize - height) / 2, width, height);
  });
}

function spriteAt(x: number, y: number): SpriteEntry | undefined {
  const cellSize = tileSize + gap;
  if (x % cellSize >= tileSize || y % cellSize >= tileSize) return undefined;
  return visibleSprites[Math.floor(y / cellSize) * columns + Math.floor(x / cellSize)];
}

function applySelection(select: () => void | Promise<void>, message: string): void {
  if (applying) return;
  applying = true;
  void Promise.resolve(select()).then(closePicker).catch(error => {
    console.error(error);
    window.alert(error instanceof Error ? error.message : message);
  }).finally(() => { applying = false; });
}

function closePicker(): void {
  if (overlay.hidden) return;
  const closeId = ++loadId;
  void closeWithAnimation(searchWindow).then(() => {
    if (closeId === loadId) overlay.hidden = true;
  });
}

function openPicker(nextMode: typeof mode, heading: string): number {
  const currentLoadId = ++loadId;
  mode = nextMode;
  title.textContent = heading;
  searchInput.value = searchValues[nextMode];
  grid.textContent = '불러오는 중…';
  overlay.hidden = false;
  openWithAnimation(searchWindow);
  searchInput.focus();
  return currentLoadId;
}

export function openSpriteAtlasPicker(selected: string, select: (atlas: string) => void | Promise<void>): void {
  const currentLoadId = openPicker('atlas', '스프라이트 아틀라스');
  selectedAtlas = selected;
  onSelectAtlas = select;
  void loadAtlases().then(entries => {
    if (currentLoadId === loadId) renderAtlases(entries);
  }).catch(error => {
    if (currentLoadId === loadId) grid.textContent = error instanceof Error ? error.message : '불러오기 실패';
  });
}

export function openSpritePicker(atlas: string, selected: string, select: (sprite: string) => void | Promise<void>): void {
  const currentLoadId = openPicker('sprite', atlas);
  selectedSprite = selected;
  onSelectSprite = select;
  void loadSpriteSource(atlas).then(source => {
    if (currentLoadId === loadId) renderSprites(source);
  }).catch(error => {
    if (currentLoadId === loadId) grid.textContent = error instanceof Error ? error.message : '불러오기 실패';
  });
}

searchInput.addEventListener('input', () => {
  searchValues[mode] = searchInput.value;
  if (mode === 'sprite' && activeSpriteSource) renderSprites(activeSpriteSource);
  else if (mode === 'atlas') void loadAtlases().then(renderAtlases);
});
canvas.addEventListener('pointermove', event => {
  const bounds = canvas.getBoundingClientRect();
  canvas.title = spriteAt(
    (event.clientX - bounds.left) * canvas.width / bounds.width,
    (event.clientY - bounds.top) * canvas.height / bounds.height
  )?.id ?? '';
});
canvas.addEventListener('click', event => {
  const bounds = canvas.getBoundingClientRect();
  const sprite = spriteAt(
    (event.clientX - bounds.left) * canvas.width / bounds.width,
    (event.clientY - bounds.top) * canvas.height / bounds.height
  );
  if (sprite) applySelection(() => onSelectSprite(sprite.id), '스프라이트 선택에 실패했습니다.');
});
overlay.querySelector<HTMLButtonElement>('header button')!.addEventListener('click', closePicker);
overlay.addEventListener('click', event => { if (event.target === overlay) closePicker(); });
document.addEventListener('keydown', event => { if (event.key === 'Escape' && !overlay.hidden) closePicker(); });

if (import.meta.env.DEV) {
  const entries = [{ id: 'minecraft:blocks' }, { id: 'minecraft:items' }];
  console.assert(filterEntries(entries, 'Block')[0]?.id === 'minecraft:blocks', 'Sprite picker filtering failed.');
  visibleSprites = [{ id: 'first', x: 0, y: 0, width: 1, height: 1 }, { id: 'second', x: 1, y: 0, width: 1, height: 1 }];
  console.assert(spriteAt(0, 0)?.id === 'first' && spriteAt(tileSize + gap, 0)?.id === 'second', 'Sprite picker hit test failed.');
  visibleSprites = [];
  console.assert(minecraftId('blocks') === 'minecraft:blocks', 'Sprite identifiers must accept the default Minecraft namespace.');
}
