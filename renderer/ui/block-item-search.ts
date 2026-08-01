import { closeWithAnimation, openWithAnimation } from './ui-open-close.js';
import { getBlockIconName, getItemIconAtlas, type ItemIconAtlas } from './item-icon-atlas';
import { currentSelection } from '../controls/selection/select';
import { addDisplayObject, loadedObjectGroup, replaceDisplayObjects } from '../load-project/mesh-builder';
import { getCompatibleBlockProperties } from '../load-project/pbde-assets';
import { captureSceneState, recordSceneChange } from '../controls/undo-redo/scene-history.js';

type AtlasName = 'block-atlas.png' | 'item-atlas.png';

export {};

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
    <div class="block-item-search-content"><div class="block-item-search-grid"></div></div>
  </section>
`;
document.body.appendChild(overlay);

const title = overlay.querySelector('span')!;
const searchInput = overlay.querySelector('input')!;
const grid = overlay.querySelector<HTMLElement>('.block-item-search-grid')!;
const searchWindow = overlay.querySelector<HTMLElement>('.block-item-search-window')!;
const tileSize = 72;
const gap = 3;
const canvas = document.createElement('canvas');
const context = canvas.getContext('2d')!;
let source: HTMLCanvasElement;
let icons: ItemIconAtlas['itemIcons'];
let names: string[] = [];
let visibleNames: string[] = [];
let activeAtlasName: AtlasName = 'block-atlas.png';
let applying = false;
let loadId = 0;

function getHoveredName(names: string[], x: number, y: number): string {
  const cellSize = tileSize + gap;
  if (x % cellSize >= tileSize || y % cellSize >= tileSize) return '';
  return names[Math.floor(y / cellSize) * 9 + Math.floor(x / cellSize)] ?? '';
}

function filterNames(names: string[], query: string): string[] {
  const normalizedQuery = query.trim().toLowerCase().replace(/ /g, '_');
  return normalizedQuery ? names.filter(name => name.toLowerCase().includes(normalizedQuery)) : names;
}

function parseNameProperties(name: string): { baseName: string; properties: Record<string, string> } {
  const match = /^(.*?)\[([^\]]*)\]$/.exec(name);
  return {
    baseName: match?.[1] ?? name,
    properties: Object.fromEntries((match?.[2] ?? '').split(',').filter(Boolean).map(entry => entry.split('=', 2)))
  };
}

function nameWithProperties(name: string, properties: Record<string, string>): string {
  const entries = Object.entries(properties);
  return entries.length
    ? `${parseNameProperties(name).baseName}[${entries.map(([key, value]) => `${key}=${value}`).join(',')}]`
    : parseNameProperties(name).baseName;
}

async function applyIcon(name: string, isItemDisplay = activeAtlasName === 'item-atlas.png'): Promise<void> {
  if (applying) return;
  applying = true;
  try {
    const before = captureSceneState(loadedObjectGroup);
    const targetName = isItemDisplay ? name : await getBlockIconName(name);
    const userData = loadedObjectGroup.userData;
    const keyToUuid = userData.instanceKeyToObjectUuid as Map<string, string> | undefined;
    const selectedUuids = Array.from(currentSelection.objects, ([mesh, instanceIds]) =>
      [...instanceIds].map(instanceId => keyToUuid?.get(`${mesh.uuid}_${instanceId}`)))
      .flat()
      .filter((uuid): uuid is string => !!uuid);

    if (!selectedUuids.length) {
      await addDisplayObject(targetName, isItemDisplay);
    } else {
      const oldItemDisplays = userData.objectIsItemDisplay as Set<string> | undefined;
      const displayTypes = userData.objectDisplayTypes as Map<string, string> | undefined;
      const blockProperties = userData.objectBlockProps as Map<string, Record<string, string>> | undefined;
      await replaceDisplayObjects(await Promise.all(selectedUuids.map(async objectUuid => {
        let replacementName = targetName;
        if (isItemDisplay && oldItemDisplays?.has(objectUuid)) {
          const display = displayTypes?.get(objectUuid);
          if (display) replacementName = nameWithProperties(targetName, { ...parseNameProperties(targetName).properties, display });
        } else if (!isItemDisplay && !oldItemDisplays?.has(objectUuid)) {
          const properties = await getCompatibleBlockProperties(targetName, blockProperties?.get(objectUuid) ?? {});
          replacementName = nameWithProperties(targetName, { ...parseNameProperties(targetName).properties, ...properties });
        }
        return { objectUuid, name: replacementName, isItemDisplay };
      })));
    }
    recordSceneChange(loadedObjectGroup, before);
    closeSearch();
  } catch (error) {
    console.error(error);
    window.alert(error instanceof Error ? error.message : '오브젝트 추가 또는 교체에 실패했습니다.');
  } finally {
    applying = false;
  }
}

function renderIcons(): void {
  visibleNames = filterNames(names, searchInput.value);
  if (!visibleNames.length) {
    grid.textContent = '검색 결과 없음';
    return;
  }

  grid.replaceChildren(canvas);
  canvas.width = 9 * (tileSize + gap) - gap;
  canvas.height = Math.ceil(visibleNames.length / 9) * (tileSize + gap) - gap;
  context.imageSmoothingEnabled = false;

  for (let index = 0; index < visibleNames.length; index++) {
    const column = index % 9;
    const row = Math.floor(index / 9);
    const x = column * (tileSize + gap);
    const y = row * (tileSize + gap);
    const icon = icons.get(visibleNames[index])!;
    context.beginPath();
    context.roundRect(x + 1.5, y + 1.5, tileSize - 3, tileSize - 3, 8);
    context.fillStyle = '#252528';
    context.fill();
    context.strokeStyle = '#45454a';
    context.lineWidth = 3;
    context.stroke();
    context.drawImage(source, icon.x, icon.y, icon.size, icon.size, x + 7, y + 7, tileSize - 14, tileSize - 14);
  }
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
  activeAtlasName = name;
  overlay.hidden = false;
  openWithAnimation(searchWindow);
  title.textContent = name === 'block-atlas.png' ? '블록' : '아이템';
  searchInput.focus();
  grid.textContent = '불러오는 중…';
  const atlas = await getItemIconAtlas();
  if (currentLoadId !== loadId) return;
  source = name === 'block-atlas.png' ? atlas.blockImage : atlas.itemImage;
  icons = name === 'block-atlas.png' ? atlas.blockIcons : atlas.itemIcons;
  names = [...icons.keys()];
  renderIcons();
}

canvas.addEventListener('pointermove', event => {
  const bounds = canvas.getBoundingClientRect();
  canvas.title = getHoveredName(
    visibleNames,
    (event.clientX - bounds.left) * canvas.width / bounds.width,
    (event.clientY - bounds.top) * canvas.height / bounds.height
  );
});
canvas.addEventListener('click', event => {
  const bounds = canvas.getBoundingClientRect();
  const name = getHoveredName(
    visibleNames,
    (event.clientX - bounds.left) * canvas.width / bounds.width,
    (event.clientY - bounds.top) * canvas.height / bounds.height
  );
  if (name) void applyIcon(name);
});

if (import.meta.env.DEV) {
  console.assert(
    getHoveredName(['stone', 'dirt'], 0, 0) === 'stone'
      && getHoveredName(['stone', 'dirt'], tileSize, 0) === ''
      && getHoveredName(['stone', 'dirt'], tileSize + gap, 0) === 'dirt',
    'Atlas hover name lookup failed.'
  );
  console.assert(
    filterNames(['stone', 'oak_planks'], 'Oak Planks')[0] === 'oak_planks',
    'Atlas name filtering failed.'
  );
  console.assert(
    nameWithProperties('oak_log[axis=y]', { axis: 'x' }) === 'oak_log[axis=x]',
    'Atlas property name construction failed.'
  );
}

const atlasButtons = document.querySelectorAll<HTMLElement>('#scene-toolbar i');
atlasButtons[0]?.addEventListener('click', () => openSearch('block-atlas.png'));
atlasButtons[1]?.addEventListener('click', () => openSearch('item-atlas.png'));
atlasButtons[2]?.addEventListener('click', () => void applyIcon('player_head', true));
searchInput.addEventListener('input', renderIcons);
overlay.querySelector('button')!.addEventListener('click', closeSearch);
overlay.addEventListener('click', event => {
  if (event.target === overlay) closeSearch();
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !overlay.hidden) closeSearch();
});
