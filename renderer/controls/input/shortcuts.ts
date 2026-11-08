export const shortcutDefinitions = [
  { id: 'translate', category: '일반', label: '이동 도구', defaults: ['T'] },
  { id: 'rotate', category: '일반', label: '회전 도구', defaults: ['R'] },
  { id: 'shear', category: '일반', label: 'Shear 도구', defaults: ['W'] },
  { id: 'scale', category: '일반', label: '크기 도구', defaults: ['S'] },
  { id: 'toggleSpace', category: '일반', label: '로컬/월드 전환', defaults: ['X'] },
  { id: 'togglePivot', category: '일반', label: '피벗 중심/원점 전환', defaults: ['Z'] },
  { id: 'editPivot', category: '일반', label: '피벗 편집', defaults: ['Alt'] },
  { id: 'resetPivot', category: '일반', label: '피벗 초기화', defaults: ['Ctrl+Alt'] },
  { id: 'toggleVertex', category: '일반', label: '버텍스 모드 전환', defaults: ['V'] },
  { id: 'removeShear', category: '일반', label: 'Shear 제거', defaults: ['Q'] },
  { id: 'toggleScaleMode', category: '일반', label: '스케일 모드 전환', defaults: ['B'] },
  { id: 'toggleSmartScale', category: '일반', label: '스마트 스케일', defaults: ['J'] },
  { id: 'fineAdjust', category: '일반', label: '미세조정', defaults: ['Shift'] },
  { id: 'toggleFineAdjust', category: '일반', label: '미세조정 토글', defaults: [] },
  { id: 'headPainterCopyStamp', category: '헤드 페인터', label: '스탬프 복사', defaults: ['Shift'] },
  { id: 'headPainterConnectedFill', category: '헤드 페인터', label: '한 면 채우기', defaults: ['Shift'] },
  { id: 'headPainterFillAllFaces', category: '헤드 페인터', label: '6면 전체 채우기', defaults: ['Ctrl'] },
  { id: 'headPainterPaletteGradient', category: '헤드 페인터', label: '팔레트 그라데이션', defaults: ['Shift'] },
  { id: 'headPainterSelectBrushArea', category: '헤드 페인터', label: '브러시 픽셀 영역 선택', defaults: ['Ctrl'] },
  { id: 'headPainterClearBrushSelection', category: '헤드 페인터', label: '브러시 선택 해제', defaults: ['Ctrl+G'] },
  { id: 'undo', category: '기록', label: '실행 취소', defaults: ['Ctrl+Z'] },
  { id: 'redo', category: '기록', label: '다시 실행', defaults: ['Ctrl+Shift+Z', 'Ctrl+Y'] },
  { id: 'previousGizmo', category: '기록', label: '이전 조작 도구', defaults: ['Ctrl+T', 'Ctrl+R'] },
  { id: 'focusSelection', category: '선택', label: '선택 항목에 초점', defaults: ['F'] },
  { id: 'multiSelect', category: '선택', label: '추가 선택 (클릭)', defaults: ['Shift'] },
  { id: 'boxSelect', category: '선택', label: '영역 선택 (드래그)', defaults: ['Ctrl'] },
  { id: 'selectAll', category: '선택', label: '전체 선택', defaults: ['Ctrl+A'] },
  { id: 'selectAllObjects', category: '선택', label: '모든 오브젝트 선택', defaults: ['Ctrl+Shift+A'] },
  { id: 'renameSceneItem', category: '선택', label: '씬 항목 이름 변경', defaults: ['F2'] },
  { id: 'expand', category: '보기', label: '펼치기', defaults: ['ArrowDown'] },
  { id: 'collapse', category: '보기', label: '접기', defaults: ['ArrowUp'] },
  { id: 'deleteSelection', category: '오브젝트', label: '선택 삭제', defaults: ['Delete', 'Backspace'] },
  { id: 'duplicate', category: '오브젝트', label: '선택 복제', defaults: ['D'] },
  { id: 'copySelection', category: '오브젝트', label: '선택 복사', defaults: ['Ctrl+C'] },
  { id: 'pasteSelection', category: '오브젝트', label: '선택 붙여넣기', defaults: ['Ctrl+V'] },
  { id: 'knife', category: '오브젝트', label: '나이프', defaults: ['K'] },
  { id: 'group', category: '오브젝트', label: '그룹 생성/해제', defaults: ['G'] },
  { id: 'ungroup', category: '오브젝트', label: '그룹 해제', defaults: ['Ctrl+G'] },
  { id: 'replaceProject', category: '열기', label: '새 프로젝트', defaults: ['Ctrl+N'] },
  { id: 'newProject', category: '열기', label: '새 프로젝트 탭', defaults: ['N'] },
  { id: 'openProject', category: '열기', label: '프로젝트 열기', defaults: ['Ctrl+O'] },
  { id: 'openSettings', category: '열기', label: '설정 열기', defaults: ['Tab'] },
  { id: 'openSummonCommand', category: '열기', label: '소환 명령어 내보내기', defaults: ['E'] },
  { id: 'openBlockSearch', category: '열기', label: '블록 창 열기', defaults: [] },
  { id: 'openItemSearch', category: '열기', label: '아이템 창 열기', defaults: [] },
  { id: 'toggleShading', category: '보기', label: '셰이딩 전환', defaults: ['L'] },
  { id: 'animationPlay', category: '애니메이션', label: '애니메이션 재생/일시정지', defaults: ['Space'] },
  { id: 'animationPreviousTick', category: '애니메이션', label: '1틱 뒤로 이동', defaults: ['ArrowLeft'] },
  { id: 'animationNextTick', category: '애니메이션', label: '1틱 앞으로 이동', defaults: ['ArrowRight'] },
  { id: 'animationPreviousKey', category: '애니메이션', label: '이전 키프레임', defaults: ['Ctrl+ArrowLeft'] },
  { id: 'animationNextKey', category: '애니메이션', label: '다음 키프레임', defaults: ['Ctrl+ArrowRight'] },
  { id: 'animationCameraKey', category: '애니메이션', label: '현재 구도로 카메라 키 추가', defaults: ['Shift+C'] },
  { id: 'animationCameraEdit', category: '애니메이션', label: '미리보기 구도에서 카메라 편집', defaults: ['Shift+V'] },
] as const;

export type ShortcutId = typeof shortcutDefinitions[number]['id'];
export type ShortcutMapping = Record<ShortcutId, string[]>;
const storagePrefix = 'pdeShortcut:';
const pressedKeys = new Set<string>();
let fineAdjustToggled = false;

export function toggleFineAdjust(): void {
  fineAdjustToggled = !fineAdjustToggled;
  window.dispatchEvent(new Event('pde:fine-adjust-changed'));
}

export function normalizeShortcutKey(key: string): string {
  if (key === 'Control' || key === 'Meta') return 'Ctrl';
  if (key === ' ') return 'Space';
  return key.length === 1 ? key.toUpperCase() : key;
}

export function shortcutFromKeys(keys: Iterable<string>): string {
  const values = new Set(keys);
  const modifiers = ['Ctrl', 'Alt', 'Shift'].filter(key => values.delete(key));
  return [...modifiers, ...[...values].sort()].join('+');
}

window.addEventListener('keydown', event => {
  const target = event.target as HTMLElement;
  if (event.isComposing || target?.closest?.('input, textarea, select, [contenteditable]')) {
    pressedKeys.clear();
    return;
  }
  pressedKeys.add(normalizeShortcutKey(event.key));
}, true);
window.addEventListener('keydown', event => {
  const target = event.target as HTMLElement;
  if (event.defaultPrevented || event.isComposing || target?.closest?.('input, textarea, select, [contenteditable]')) return;
  if (!matchesShortcut(event, 'toggleFineAdjust')) return;
  event.preventDefault();
  if (!event.repeat) toggleFineAdjust();
});
window.addEventListener('keyup', event => pressedKeys.delete(normalizeShortcutKey(event.key)), true);
window.addEventListener('blur', () => pressedKeys.clear());
window.addEventListener('pde:shortcuts-changed', () => { fineAdjustToggled = false; });

export function getShortcuts(id: ShortcutId): string[] {
  const saved = localStorage.getItem(storagePrefix + id);
  return saved === null
    ? [...shortcutDefinitions.find(shortcut => shortcut.id === id)!.defaults]
    : saved.split('|').filter(Boolean);
}

export function getShortcutMapping(): ShortcutMapping {
  return Object.fromEntries(shortcutDefinitions.map(shortcut => [shortcut.id, getShortcuts(shortcut.id)])) as ShortcutMapping;
}

export function setShortcutMapping(mapping: Partial<ShortcutMapping>): void {
  shortcutDefinitions.forEach(shortcut => localStorage.setItem(storagePrefix + shortcut.id, (mapping[shortcut.id] ?? shortcut.defaults).join('|')));
  window.dispatchEvent(new Event('pde:shortcuts-changed'));
}

export function resetShortcutMapping(): void {
  shortcutDefinitions.forEach(shortcut => localStorage.removeItem(storagePrefix + shortcut.id));
  window.dispatchEvent(new Event('pde:shortcuts-changed'));
}

export function setShortcuts(id: ShortcutId, shortcuts: string[]): void {
  localStorage.setItem(storagePrefix + id, shortcuts.join('|'));
  window.dispatchEvent(new CustomEvent('pde:shortcuts-changed', { detail: id }));
}

export function getShortcutConflictDetails(id: ShortcutId): string[] {
  const shortcuts = new Set(getShortcuts(id));
  return shortcutDefinitions.flatMap(shortcut => shortcut.id === id ? [] : getShortcuts(shortcut.id)
    .filter(key => shortcuts.has(key))
    .map(key => `${key.split('+').join(' + ')}: ${shortcut.label}`));
}

export function resetShortcuts(id: ShortcutId): void {
  const defaults = shortcutDefinitions.find(shortcut => shortcut.id === id)!.defaults;
  setShortcuts(id, [...defaults]);
  localStorage.removeItem(storagePrefix + id);
}

export function shortcutFromEvent(event: KeyboardEvent): string {
  const keys = new Set([
    event.ctrlKey || event.metaKey ? 'Ctrl' : '',
    event.altKey ? 'Alt' : '',
    event.shiftKey ? 'Shift' : '',
    normalizeShortcutKey(event.key),
  ].filter(Boolean));
  return shortcutFromKeys(keys);
}

function matchesShortcutKeys(keys: Set<string>, id: ShortcutId): boolean {
  if (getShortcuts(id).includes(shortcutFromKeys(keys))) return true;
  const combinedId = id === 'editPivot' ? 'fineAdjust' : id === 'fineAdjust' ? 'editPivot' : null;
  return combinedId !== null && getShortcuts(id).some(shortcut => {
    const requiredKeys = shortcut.split('+');
    if (!requiredKeys.every(key => keys.has(key))) return false;
    return getShortcuts(combinedId).some(combined => {
      const allowedKeys = new Set([...requiredKeys, ...combined.split('+')]);
      return [...keys].every(key => allowedKeys.has(key));
    });
  });
}

export function matchesShortcut(event: KeyboardEvent, id: ShortcutId): boolean {
  const keys = new Set(pressedKeys);
  if (event.ctrlKey || event.metaKey) keys.add('Ctrl');
  if (event.altKey) keys.add('Alt');
  if (event.shiftKey) keys.add('Shift');
  keys.add(normalizeShortcutKey(event.key));
  return matchesShortcutKeys(keys, id);
}

export function matchesPointerShortcut(event: { ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; shiftKey?: boolean }, id: ShortcutId): boolean {
  const keys = new Set([...pressedKeys].filter(key => key !== 'Ctrl' && key !== 'Alt' && key !== 'Shift'));
  if (event.ctrlKey || event.metaKey) keys.add('Ctrl');
  if (event.altKey) keys.add('Alt');
  if (event.shiftKey) keys.add('Shift');
  return getShortcuts(id).some(shortcut => shortcut.split('+').every(key => keys.has(key)));
}

export function isShortcutPressed(id: ShortcutId): boolean {
  return (id === 'fineAdjust' && fineAdjustToggled) || matchesShortcutKeys(pressedKeys, id);
}

if (import.meta.env.DEV) {
  console.assert(
    shortcutFromEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, shiftKey: true })) === 'Ctrl+Shift+Z'
      && shortcutFromKeys(['G', 'A']) === 'A+G',
    'Shortcut normalization failed.'
  );
}
