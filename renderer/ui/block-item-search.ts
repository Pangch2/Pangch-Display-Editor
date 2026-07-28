import { closeWithAnimation, openWithAnimation } from './ui-open-close.js';
import { getItemIconAtlas } from './item-icon-atlas';

type AtlasName = 'block-atlas.png' | 'item-atlas.png';

export {};

const overlay = document.createElement('div');
overlay.className = 'block-item-search';
overlay.hidden = true;
overlay.innerHTML = `
  <section class="block-item-search-window">
    <header><span></span><button type="button" aria-label="닫기">×</button></header>
    <div class="block-item-search-content"><div class="block-item-search-grid"></div></div>
  </section>
`;
document.body.appendChild(overlay);

const title = overlay.querySelector('span')!;
const grid = overlay.querySelector<HTMLElement>('.block-item-search-grid')!;
const searchWindow = overlay.querySelector<HTMLElement>('.block-item-search-window')!;
const atlasCache = new Map<AtlasName, HTMLCanvasElement>();
const tileSize = 72;
const gap = 3;
let loadId = 0;

function getHoveredName(names: string[], x: number, y: number): string {
  const cellSize = tileSize + gap;
  if (x % cellSize >= tileSize || y % cellSize >= tileSize) return '';
  return names[Math.floor(y / cellSize) * 9 + Math.floor(x / cellSize)] ?? '';
}

function closeSearch(): void {
  if (overlay.hidden) return;
  const currentCloseId = ++loadId;
  void closeWithAnimation(searchWindow).then(() => {
    if (currentCloseId === loadId) overlay.hidden = true;
  });
}

async function openSearch(name: AtlasName): Promise<void> {
  const currentLoadId = ++loadId;
  overlay.hidden = false;
  openWithAnimation(searchWindow);
  title.textContent = name === 'block-atlas.png' ? '블록' : '아이템';
  grid.replaceChildren();
  const cachedAtlas = atlasCache.get(name);
  if (cachedAtlas) {
    grid.replaceChildren(cachedAtlas);
    return;
  }
  const atlas = await getItemIconAtlas();
  if (currentLoadId !== loadId) return;
  const source = name === 'block-atlas.png' ? atlas.blockImage : atlas.itemImage;
  const icons = name === 'block-atlas.png' ? atlas.blockIcons : atlas.itemIcons;
  const names = [...icons.keys()];

  const rows = Math.ceil(names.length / 9);
  const canvas = document.createElement('canvas');
  canvas.width = 9 * (tileSize + gap) - gap;
  canvas.height = rows * (tileSize + gap) - gap;
  const context = canvas.getContext('2d')!;
  context.imageSmoothingEnabled = false;

  for (let index = 0; index < names.length; index++) {
    const column = index % 9;
    const row = Math.floor(index / 9);
    const x = column * (tileSize + gap);
    const y = row * (tileSize + gap);
    const icon = icons.get(names[index])!;
    context.beginPath();
    context.roundRect(x + 1.5, y + 1.5, tileSize - 3, tileSize - 3, 8);
    context.fillStyle = '#252528';
    context.fill();
    context.strokeStyle = '#45454a';
    context.lineWidth = 3;
    context.stroke();
    context.drawImage(source, icon.x, icon.y, icon.size, icon.size, x + 7, y + 7, tileSize - 14, tileSize - 14);
  }

  canvas.addEventListener('pointermove', event => {
    const bounds = canvas.getBoundingClientRect();
    canvas.title = getHoveredName(
      names,
      (event.clientX - bounds.left) * canvas.width / bounds.width,
      (event.clientY - bounds.top) * canvas.height / bounds.height
    );
  });
  atlasCache.set(name, canvas);
  grid.replaceChildren(canvas);
}

if (import.meta.env.DEV) {
  console.assert(
    getHoveredName(['stone', 'dirt'], 0, 0) === 'stone'
      && getHoveredName(['stone', 'dirt'], tileSize, 0) === ''
      && getHoveredName(['stone', 'dirt'], tileSize + gap, 0) === 'dirt',
    'Atlas hover name lookup failed.'
  );
}

const atlasButtons = document.querySelectorAll<HTMLElement>('#scene-toolbar i');
atlasButtons[0]?.addEventListener('click', () => openSearch('block-atlas.png'));
atlasButtons[1]?.addEventListener('click', () => openSearch('item-atlas.png'));
overlay.querySelector('button')!.addEventListener('click', closeSearch);
overlay.addEventListener('click', event => {
  if (event.target === overlay) closeSearch();
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !overlay.hidden) closeSearch();
});
