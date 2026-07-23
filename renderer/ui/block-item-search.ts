import { closeWithAnimation, openWithAnimation } from './ui-open-close.js';

type AtlasName = 'block-atlas.png' | 'item-atlas.png';

export {};

const ipcApi = (window as typeof window & {
  ipcApi: {
    getAssetContent(path: string): Promise<{ success: boolean; content: unknown }>;
  };
}).ipcApi;

const overlay = document.createElement('div');
overlay.className = 'block-item-search';
overlay.hidden = true;
overlay.innerHTML = `
  <section class="block-item-search-window">
    <header><span></span><button type="button" aria-label="닫기">×</button></header>
    <div class="block-item-search-content"><div class="block-item-search-grid"><img alt=""></div></div>
  </section>
`;
document.body.appendChild(overlay);

const title = overlay.querySelector('span')!;
const image = overlay.querySelector('img')!;
const grid = overlay.querySelector<HTMLElement>('.block-item-search-grid')!;
const searchWindow = overlay.querySelector<HTMLElement>('.block-item-search-window')!;
const atlasCache = new Map<AtlasName, HTMLCanvasElement>();
let activeUrl: string | null = null;
let loadId = 0;

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
  image.removeAttribute('src');
  image.alt = '불러오는 중...';

  const result = await ipcApi.getAssetContent(name);
  if (currentLoadId !== loadId || !result.success) return;
  if (activeUrl) URL.revokeObjectURL(activeUrl);
  activeUrl = URL.createObjectURL(new Blob([result.content as BlobPart], { type: 'image/png' }));
  image.src = activeUrl;
  image.alt = title.textContent;
  try {
    await image.decode();
  } catch {
    return;
  }
  if (currentLoadId !== loadId) return;

  const rows = Math.round(image.naturalHeight / image.naturalWidth * 9);
  const sourceTileSize = image.naturalWidth / 9;
  const tileSize = 72;
  const gap = 3;
  const canvas = document.createElement('canvas');
  canvas.width = 9 * (tileSize + gap) - gap;
  canvas.height = rows * (tileSize + gap) - gap;
  const context = canvas.getContext('2d')!;
  context.imageSmoothingEnabled = false;

  for (let index = 0; index < rows * 9; index++) {
    const column = index % 9;
    const row = Math.floor(index / 9);
    const x = column * (tileSize + gap);
    const y = row * (tileSize + gap);
    context.beginPath();
    context.roundRect(x + 1.5, y + 1.5, tileSize - 3, tileSize - 3, 8);
    context.fillStyle = '#252528';
    context.fill();
    context.strokeStyle = '#45454a';
    context.lineWidth = 3;
    context.stroke();
    context.drawImage(image, column * sourceTileSize, row * sourceTileSize, sourceTileSize, sourceTileSize, x + 7, y + 7, tileSize - 14, tileSize - 14);
  }

  atlasCache.set(name, canvas);
  grid.replaceChildren(canvas);
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
