import { blockbenchScaleMode, toggleBlockbenchScaleMode } from '../controls/gizmo/blockbench-scale';
import { closeWithAnimation, openWithAnimation } from './ui-open-close.js';
import { loadedObjectGroup } from '../load-project/upload-pbde';
import { cleanLabel } from './scene-panel/scene-panel-model';
import { getShortcutConflicts, getShortcutMapping, getShortcuts, matchesShortcut, normalizeShortcutKey, resetShortcutMapping, resetShortcuts, setShortcutMapping, setShortcuts, shortcutDefinitions, shortcutFromKeys } from '../controls/input/shortcuts';

const settingsButton = document.getElementById('settings-button')!;
const toolbar = document.getElementById('scene-toolbar')!;
const overlay = document.createElement('div');
overlay.className = 'settings-overlay';
overlay.hidden = true;
overlay.innerHTML = `
  <section class="settings-window" role="dialog" aria-modal="true" aria-labelledby="settings-title">
    <header><h2 id="settings-title">설정</h2><button class="settings-close" type="button" aria-label="닫기">×</button></header>
    <div class="settings-body">
      <nav class="settings-nav" aria-label="설정 메뉴">
        <button class="active" type="button" data-settings-page="general"><span class="lucide-icon">&#xE30B;</span>일반 설정</button>
        <button type="button" data-settings-page="shortcuts"><span class="lucide-icon">&#xE284;</span>단축키</button>
        <button type="button" data-settings-page="scene"><span class="lucide-icon">&#xE06A;</span>씬 현황</button>
        <button class="settings-reset" type="button" data-settings-page="reset"><span class="lucide-icon">&#xE666;</span>PDE 초기화</button>
      </nav>
      <main class="settings-content">
        <section class="settings-page" data-settings-content="general">
          <h3>일반 설정</h3>
          <fieldset>
            <legend>인터페이스</legend>
            <label class="settings-row"><span>도구 패널</span><span class="settings-select"><select id="toolbar-position"><option value="top">위</option><option value="bottom">아래</option></select><span class="lucide-icon">&#xE06D;</span></span></label>
            <label class="settings-row"><span>카메라</span><span class="settings-select"><select id="camera-type"><option value="perspective">원근</option><option value="orthographic">직교</option></select><span class="lucide-icon">&#xE06D;</span></span></label>
            <label class="settings-row"><span>카메라 FOV</span><span class="settings-range"><input id="camera-fov" type="range" min="20" max="120" value="80"><output>80°</output></span></label>
          </fieldset>
          <fieldset>
            <legend>조작</legend>
            <label class="settings-row"><span>스케일 조작 모드</span><span class="settings-select"><select id="scale-mode"><option value="default">기본</option><option value="blockbench">블록벤치 스케일 모드</option></select><span class="lucide-icon">&#xE06D;</span></span></label>
            <label class="settings-row"><span>오브젝트 교체 모드</span><span class="settings-select"><select id="object-replace-mode"><option value="default">기본</option><option value="preserve-visible-size">보이는 크기 유지</option></select><span class="lucide-icon">&#xE06D;</span></span></label>
            <label class="settings-row"><span>위치 드래그값</span><span class="settings-drag-value" data-values="0,1,0.5,0.25,0.125,0.625,0.0001"><input type="text" inputmode="decimal" value="0.0001" data-storage-key="pdePositionDragValue"><button type="button" aria-label="위치 드래그값 메뉴" aria-expanded="false"><span class="lucide-icon">&#xE06D;</span></button><span class="settings-drag-menu" hidden></span></span></label>
            <label class="settings-row"><span>각도 드래그값</span><span class="settings-drag-value" data-values="0,180,90,45,30,15,10,5,2,1,0.0001"><input type="text" inputmode="decimal" value="0.0001" data-storage-key="pdeRotationDragValue"><button type="button" aria-label="각도 드래그값 메뉴" aria-expanded="false"><span class="lucide-icon">&#xE06D;</span></button><span class="settings-drag-menu" hidden></span></span></label>
            <label class="settings-row"><span>스케일 드래그값</span><span class="settings-drag-value" data-values="0,1,0.5,0.25,0.125,0.625,0.0001"><input type="text" inputmode="decimal" value="0.0001" data-storage-key="pdeScaleDragValue"><button type="button" aria-label="스케일 드래그값 메뉴" aria-expanded="false"><span class="lucide-icon">&#xE06D;</span></button><span class="settings-drag-menu" hidden></span></span></label>
          </fieldset>
          <fieldset>
            <legend>헤드 페인트 계정</legend>
            <button class="settings-login" type="button">로그인하기</button>
          </fieldset>
        </section>
        <section class="settings-page" data-settings-content="shortcuts" hidden>
          <h3>단축키</h3>
          <div class="settings-shortcut-header"><span>동작</span><span>현재 키</span></div>
          <div id="settings-shortcut-list"></div>
          <div class="settings-shortcut-presets">
            <button id="shortcut-preset-toggle" type="button" aria-expanded="false">프리셋 <span class="lucide-icon">&#xE06D;</span></button>
            <div id="shortcut-preset-menu" hidden></div>
          </div>
        </section>
        <section class="settings-page" data-settings-content="scene" hidden>
          <h3>씬 현황</h3>
          <fieldset>
            <legend>PDE</legend>
            <div class="settings-row"><span>RAM 사용량</span><output id="scene-memory">-</output></div>
          </fieldset>
          <fieldset>
            <legend>현재 프로젝트</legend>
            <div class="settings-row"><span>프로젝트 이름</span><output id="scene-project-name">-</output></div>
            <div class="settings-row"><span>메쉬</span><output id="scene-mesh-count">0</output></div>
            <div class="settings-row"><span>그룹</span><output id="scene-group-count">0</output></div>
            <div class="settings-row"><span>블록</span><output id="scene-block-count">0</output></div>
            <div class="settings-row"><span>아이템</span><output id="scene-item-count">0</output></div>
            <div class="settings-row"><span>오브젝트 종류</span><output id="scene-object-type-count">0</output></div>
            <ul id="scene-object-types"></ul>
          </fieldset>
        </section>
        <section class="settings-page settings-danger-page" data-settings-content="reset" hidden>
          <h3>PDE 초기화</h3>
          <fieldset>
            <legend>캐시 초기화</legend>
            <p>PDE의 네트워크 캐시, UI 배치·설정, 단축키 프리셋을 삭제하고 재시작합니다.</p>
            <p class="settings-danger-text">설정이나 UI 배치가 손상됐거나 캐시 오류가 의심될 때만 사용하세요. 저장하지 않은 작업은 먼저 저장해야 합니다.</p>
            <button type="button" data-reset-scope="cache">캐시 초기화</button>
          </fieldset>
          <fieldset>
            <legend>에셋 초기화</legend>
            <p>pde-asset-cache-v1 폴더를 삭제하고 PDE를 재시작합니다. 에셋은 다시 다운로드됩니다.</p>
            <p class="settings-danger-text">텍스처가 깨졌거나 에셋 다운로드·캐시 오류가 반복될 때만 사용하세요.</p>
            <button type="button" data-reset-scope="assets">에셋 초기화</button>
          </fieldset>
          <fieldset>
            <legend>GC</legend>
            <p>사용하지 않는 JavaScript 메모리를 즉시 정리합니다.</p>
            <p class="settings-danger-text">작업이 잠시 멈출 수 있습니다. 메모리 사용량이 비정상적으로 높을 때 진단용으로만 사용하세요.</p>
            <button type="button" id="force-gc">GC 강제 실행</button>
          </fieldset>
        </section>
      </main>
    </div>
  </section>
`;
document.body.appendChild(overlay);

const settingsWindow = overlay.querySelector<HTMLElement>('.settings-window')!;
const closeButton = overlay.querySelector<HTMLButtonElement>('.settings-close')!;
const toolbarPosition = overlay.querySelector<HTMLSelectElement>('#toolbar-position')!;
const cameraType = overlay.querySelector<HTMLSelectElement>('#camera-type')!;
const fovInput = overlay.querySelector<HTMLInputElement>('#camera-fov')!;
const fovOutput = fovInput.nextElementSibling as HTMLOutputElement;
const scaleMode = overlay.querySelector<HTMLSelectElement>('#scale-mode')!;
const objectReplaceMode = overlay.querySelector<HTMLSelectElement>('#object-replace-mode')!;
const shortcutList = overlay.querySelector<HTMLElement>('#settings-shortcut-list')!;
const presetToggle = overlay.querySelector<HTMLButtonElement>('#shortcut-preset-toggle')!;
const presetMenu = overlay.querySelector<HTMLElement>('#shortcut-preset-menu')!;
const activePresetStorageKey = 'pdeActiveShortcutPreset';
const customPresetPrefix = 'custom:';
const defaultShortcutMapping = Object.fromEntries(shortcutDefinitions.map(shortcut => [shortcut.id, [...shortcut.defaults]]));
let presetSaveQueue = Promise.resolve();

function isCurrentShortcutMapping(mapping: Record<string, readonly string[]>): boolean {
  const current = getShortcutMapping();
  return shortcutDefinitions.every(({ id }) => JSON.stringify([...current[id]].sort()) === JSON.stringify([...(mapping[id] ?? [])].sort()));
}

function activePresetId(): string {
  return localStorage.getItem(activePresetStorageKey) ?? (isCurrentShortcutMapping(defaultShortcutMapping) ? 'default' : 'none');
}

function clearPresetDropMarkers(): void {
  presetMenu.querySelectorAll('.settings-preset-drop-before, .settings-preset-drop-after')
    .forEach(element => element.classList.remove('settings-preset-drop-before', 'settings-preset-drop-after'));
}

function clearPresetDragState(): void {
  clearPresetDropMarkers();
  presetMenu.querySelector('.settings-preset-dragging')?.classList.remove('settings-preset-dragging');
}

window.addEventListener('pde:shortcuts-changed', () => {
  const activePreset = activePresetId();
  if (!activePreset.startsWith(customPresetPrefix)) return;
  const name = activePreset.slice(customPresetPrefix.length);
  const mapping = getShortcutMapping();
  presetSaveQueue = presetSaveQueue.then(async () => {
    const saved = await window.ipcApi.saveKeyMappingPreset(name, mapping).catch(error => ({ success: false, error: String(error) }));
    if (!saved.success) alert(`프리셋을 저장하지 못했습니다: ${saved.error ?? '알 수 없는 오류'}`);
  });
});

function renderShortcuts(): void {
  const rows: HTMLElement[] = [];
  let currentCategory = '';
  shortcutDefinitions.forEach(shortcut => {
    if (shortcut.category !== currentCategory) {
      currentCategory = shortcut.category;
      rows.push(Object.assign(document.createElement('h4'), { className: 'settings-shortcut-category', textContent: currentCategory }));
    }
    const row = document.createElement('div');
    const keyButton = document.createElement('button');
    const addButton = document.createElement('button');
    const clearButton = document.createElement('button');
    const resetButton = document.createElement('button');
    row.className = 'settings-shortcut-row';
    keyButton.type = addButton.type = clearButton.type = resetButton.type = 'button';
    keyButton.textContent = getShortcuts(shortcut.id).map(key => key.split('+').join(' + ')).join(', ') || '지정 안 함';
    if (getShortcutConflicts(shortcut.id).length) {
      keyButton.classList.add('settings-shortcut-conflict');
      keyButton.title = '키가 겹칩니다. 겹치는 상황에서는 양쪽의 조작이 비활성화됩니다.';
    }
    addButton.className = 'settings-shortcut-add';
    addButton.textContent = '+';
    addButton.ariaLabel = `${shortcut.label} 단축키 추가`;
    clearButton.className = 'settings-shortcut-clear';
    clearButton.textContent = '×';
    clearButton.ariaLabel = `${shortcut.label} 단축키 해제`;
    resetButton.className = 'settings-shortcut-reset lucide-icon';
    resetButton.textContent = '\uE145';
    resetButton.ariaLabel = `${shortcut.label} 단축키 기본값 복원`;

    const captureShortcut = (append: boolean): void => {
      keyButton.textContent = '키 입력…';
      const capturedKeys = new Set<string>();
      const activeKeys = new Set<string>();
      const finish = (value?: string): void => {
        window.removeEventListener('keydown', keydown, true);
        window.removeEventListener('keyup', keyup, true);
        if (value) setShortcuts(shortcut.id, [...new Set(append ? [...getShortcuts(shortcut.id), value] : [value])]);
        renderShortcuts();
      };
      const stop = (event: KeyboardEvent): void => {
        event.preventDefault();
        event.stopImmediatePropagation();
      };
      const keydown = (event: KeyboardEvent): void => {
        stop(event);
        if (event.key === 'Escape') return finish();
        const key = normalizeShortcutKey(event.key);
        capturedKeys.add(key);
        activeKeys.add(key);
      };
      const keyup = (event: KeyboardEvent): void => {
        stop(event);
        activeKeys.delete(normalizeShortcutKey(event.key));
        if (!activeKeys.size) finish(shortcutFromKeys(capturedKeys));
      };
      window.addEventListener('keydown', keydown, true);
      window.addEventListener('keyup', keyup, true);
    };
    keyButton.addEventListener('click', () => captureShortcut(false));
    addButton.addEventListener('click', () => captureShortcut(true));
    clearButton.addEventListener('click', () => {
      setShortcuts(shortcut.id, []);
      renderShortcuts();
    });
    resetButton.addEventListener('click', () => {
      resetShortcuts(shortcut.id);
      renderShortcuts();
    });
    row.append(Object.assign(document.createElement('span'), { textContent: shortcut.label }), keyButton, addButton, clearButton, resetButton);
    rows.push(row);
  });
  shortcutList.replaceChildren(...rows);
  if (!presetMenu.hidden) void refreshPresetMenu();
}

renderShortcuts();

async function refreshPresetMenu(): Promise<void> {
  const defaultButton = Object.assign(document.createElement('button'), { type: 'button', textContent: '기본' });
  const addButton = Object.assign(document.createElement('button'), { type: 'button', textContent: '+' });
  defaultButton.classList.toggle('settings-preset-active', activePresetId() === 'default');
  defaultButton.addEventListener('click', () => {
    localStorage.setItem(activePresetStorageKey, 'default');
    resetShortcutMapping();
    renderShortcuts();
  });
  addButton.ariaLabel = '현재 단축키를 프리셋으로 저장';
  addButton.addEventListener('click', () => {
    const input = Object.assign(document.createElement('input'), { type: 'text', placeholder: '프리셋 이름', maxLength: 100 });
    input.ariaLabel = '프리셋 이름';
    input.addEventListener('blur', () => input.replaceWith(addButton));
    input.addEventListener('keydown', async event => {
      if (!['Escape', 'Enter'].includes(event.key)) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'Escape') return void refreshPresetMenu();
      const name = input.value.trim();
      if (!name) return;
      const saved = await window.ipcApi.saveKeyMappingPreset(name, getShortcutMapping());
      if (!saved.success) return alert(`프리셋을 저장하지 못했습니다: ${saved.error ?? '알 수 없는 오류'}`);
      localStorage.setItem(activePresetStorageKey, customPresetPrefix + name);
      await refreshPresetMenu();
    });
    addButton.replaceWith(input);
    input.focus();
  });

  const result = await window.ipcApi.listKeyMappingPresets();
  const presetButtons = result.presets.map((name, index) => {
    const row = document.createElement('div');
    const button = Object.assign(document.createElement('button'), { type: 'button', textContent: name });
    const remove = Object.assign(document.createElement('button'), { type: 'button', className: 'settings-preset-delete', title: `${name} 삭제` });
    button.draggable = true;
    button.classList.toggle('settings-preset-active', activePresetId() === customPresetPrefix + name);
    remove.innerHTML = '&#xE18E;';
    remove.ariaLabel = remove.title;
    button.addEventListener('click', async () => {
      const loaded = await window.ipcApi.loadKeyMappingPreset(name);
      if (!loaded.success || !loaded.mapping) return alert(`프리셋을 불러오지 못했습니다: ${loaded.error ?? '알 수 없는 오류'}`);
      localStorage.setItem(activePresetStorageKey, customPresetPrefix + name);
      setShortcutMapping(loaded.mapping);
      renderShortcuts();
    });
    button.addEventListener('dragstart', event => {
      event.dataTransfer?.setData('text/preset-index', String(index));
      if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
      row.classList.add('settings-preset-dragging');
    });
    button.addEventListener('dragend', clearPresetDragState);
    row.addEventListener('dragover', event => {
      const from = Number(event.dataTransfer?.getData('text/preset-index'));
      if (!Number.isInteger(from)) return;
      event.preventDefault();
      clearPresetDropMarkers();
      const rect = row.getBoundingClientRect();
      row.classList.add(event.clientY < rect.top + rect.height / 2 ? 'settings-preset-drop-before' : 'settings-preset-drop-after');
    });
    row.addEventListener('drop', async event => {
      event.preventDefault();
      const from = Number(event.dataTransfer?.getData('text/preset-index'));
      if (!Number.isInteger(from)) return;
      const rect = row.getBoundingClientRect();
      const after = event.clientY >= rect.top + rect.height / 2;
      clearPresetDragState();
      const order = [...result.presets];
      const [moved] = order.splice(from, 1);
      let insertAt = index + Number(after);
      if (from < insertAt) insertAt--;
      order.splice(insertAt, 0, moved);
      const reordered = await window.ipcApi.reorderKeyMappingPresets(order);
      if (!reordered.success) return alert(`프리셋 순서를 저장하지 못했습니다: ${reordered.error ?? '알 수 없는 오류'}`);
      await refreshPresetMenu();
    });
    remove.addEventListener('click', async () => {
      await presetSaveQueue;
      const deleted = await window.ipcApi.deleteKeyMappingPreset(name);
      if (!deleted.success) return alert(`프리셋을 제거하지 못했습니다: ${deleted.error ?? '알 수 없는 오류'}`);
      if (activePresetId() === customPresetPrefix + name) localStorage.setItem(activePresetStorageKey, 'none');
      await refreshPresetMenu();
    });
    row.append(button, remove);
    return row;
  });
  presetMenu.replaceChildren(defaultButton, ...presetButtons, addButton);
}

presetToggle.addEventListener('click', async () => {
  presetMenu.hidden = !presetMenu.hidden;
  presetToggle.setAttribute('aria-expanded', String(!presetMenu.hidden));
  if (!presetMenu.hidden) {
    await refreshPresetMenu();
    presetMenu.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }
});

async function refreshSceneStatus(): Promise<void> {
  const data = loadedObjectGroup.userData;
  const objects = data.objectUuidToInstance as Map<string, unknown> | undefined;
  const items = data.objectIsItemDisplay as Set<string> | undefined;
  const names = data.objectNames as Map<string, string> | undefined;
  const objectTypes = new Map<string, number>();
  for (const name of names?.values() ?? []) {
    const type = cleanLabel(name);
    if (type) objectTypes.set(type, (objectTypes.get(type) ?? 0) + 1);
  }
  const meshCount = loadedObjectGroup.children.filter(object => 'isMesh' in object && object.isMesh).length;

  overlay.querySelector<HTMLOutputElement>('#scene-project-name')!.value = data.projectDetails?.name || '새 프로젝트';
  overlay.querySelector<HTMLOutputElement>('#scene-mesh-count')!.value = String(meshCount);
  overlay.querySelector<HTMLOutputElement>('#scene-group-count')!.value = String(data.groups?.size ?? 0);
  overlay.querySelector<HTMLOutputElement>('#scene-item-count')!.value = String(items?.size ?? 0);
  overlay.querySelector<HTMLOutputElement>('#scene-block-count')!.value = String((objects?.size ?? 0) - (items?.size ?? 0));
  overlay.querySelector<HTMLOutputElement>('#scene-object-type-count')!.value = String(objectTypes.size);
  overlay.querySelector<HTMLUListElement>('#scene-object-types')!.replaceChildren(...[...objectTypes]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, count]) => Object.assign(document.createElement('li'), { textContent: `${name} (${count})` })));
  const bytes = await window.ipcApi.getPdeMemoryUsage().catch(() => 0);
  overlay.querySelector<HTMLOutputElement>('#scene-memory')!.value = bytes ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : '-';
}

toolbarPosition.value = localStorage.getItem('pdeToolbarPosition') === 'bottom' ? 'bottom' : 'top';
cameraType.value = localStorage.getItem('pdeCameraType') === 'orthographic' ? 'orthographic' : 'perspective';
toolbar.classList.toggle('toolbar-bottom', toolbarPosition.value === 'bottom');
fovInput.value = localStorage.getItem('pdeCameraFov') ?? '80';
fovOutput.value = `${fovInput.value}°`;
const savedScaleMode = localStorage.getItem('pdeScaleMode') === 'blockbench';
if (savedScaleMode !== blockbenchScaleMode) toggleBlockbenchScaleMode();
scaleMode.value = blockbenchScaleMode ? 'blockbench' : 'default';
objectReplaceMode.value = localStorage.getItem('pdeObjectReplaceMode') === 'preserve-visible-size' ? 'preserve-visible-size' : 'default';

function openSettings(): void {
  overlay.hidden = false;
  void refreshSceneStatus();
  openWithAnimation(settingsWindow);
  closeButton.focus();
}

function closeSettings(): void {
  if (overlay.hidden) return;
  void closeWithAnimation(settingsWindow).then(() => {
    overlay.hidden = true;
    settingsButton.focus();
  });
}

overlay.querySelectorAll<HTMLButtonElement>('[data-settings-page]').forEach(button => {
  button.addEventListener('click', () => {
    overlay.querySelector('.settings-nav .active')?.classList.remove('active');
    button.classList.add('active');
    overlay.querySelectorAll<HTMLElement>('[data-settings-content]').forEach(page => {
      page.hidden = page.dataset.settingsContent !== button.dataset.settingsPage;
    });
    if (button.dataset.settingsPage === 'scene') void refreshSceneStatus();
  });
});

window.addEventListener('pde:scene-updated', () => { if (!overlay.hidden) void refreshSceneStatus(); });
window.addEventListener('pde:project-name-changed', event => {
  overlay.querySelector<HTMLOutputElement>('#scene-project-name')!.value = (event as CustomEvent<string>).detail || '새 프로젝트';
});
setInterval(() => {
  if (!overlay.hidden && !overlay.querySelector<HTMLElement>('[data-settings-content="scene"]')!.hidden) void refreshSceneStatus();
}, 1000);

toolbarPosition.addEventListener('change', () => {
  toolbar.classList.toggle('toolbar-bottom', toolbarPosition.value === 'bottom');
  localStorage.setItem('pdeToolbarPosition', toolbarPosition.value);
});
cameraType.addEventListener('change', () => {
  localStorage.setItem('pdeCameraType', cameraType.value);
  window.dispatchEvent(new CustomEvent('pde:camera-type-changed', { detail: cameraType.value }));
});
window.addEventListener('pde:camera-type-applied', (event: Event) => {
  cameraType.value = (event as CustomEvent<string>).detail === 'orthographic' ? 'orthographic' : 'perspective';
});
fovInput.addEventListener('input', () => {
  fovOutput.value = `${fovInput.value}°`;
  localStorage.setItem('pdeCameraFov', fovInput.value);
  window.dispatchEvent(new CustomEvent('pde:camera-fov-changed', { detail: fovInput.valueAsNumber }));
});
scaleMode.addEventListener('change', () => {
  if ((scaleMode.value === 'blockbench') !== blockbenchScaleMode) toggleBlockbenchScaleMode();
  localStorage.setItem('pdeScaleMode', scaleMode.value);
});
objectReplaceMode.addEventListener('change', () => localStorage.setItem('pdeObjectReplaceMode', objectReplaceMode.value));
window.addEventListener('pde:blockbench-scale-mode-changed', () => {
  scaleMode.value = blockbenchScaleMode ? 'blockbench' : 'default';
});
const dragControls = [...overlay.querySelectorAll<HTMLElement>('.settings-drag-value')];
function closeDragMenus(): void {
  dragControls.forEach(control => {
    control.querySelector<HTMLElement>('.settings-drag-menu')!.hidden = true;
    control.querySelector<HTMLButtonElement>('button')!.setAttribute('aria-expanded', 'false');
  });
}
dragControls.forEach(control => {
  const input = control.querySelector<HTMLInputElement>('input')!;
  const menuButton = control.querySelector<HTMLButtonElement>('button')!;
  const menu = control.querySelector<HTMLElement>('.settings-drag-menu')!;
  const storageKey = input.dataset.storageKey!;
  const commit = (rawValue: string): void => {
    const value = Number(rawValue);
    if (!Number.isFinite(value) || value < 0) {
      input.value = localStorage.getItem(storageKey) === '0' ? '제한없음' : localStorage.getItem(storageKey) ?? '0.0001';
      return;
    }
    localStorage.setItem(storageKey, String(value));
    input.value = value === 0 ? '제한없음' : String(value);
    window.dispatchEvent(new Event('pde:gizmo-drag-values-changed'));
  };

  input.value = localStorage.getItem(storageKey) === '0' ? '제한없음' : localStorage.getItem(storageKey) ?? '0.0001';
  input.addEventListener('focus', () => {
    if (input.value === '제한없음') input.value = '0';
  });
  input.addEventListener('blur', () => commit(input.value));
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter') input.blur();
  });

  menu.replaceChildren(...control.dataset.values!.split(',').map(value => {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.value = value;
    button.textContent = value === '0' ? '제한없음' : value;
    return button;
  }));
  menuButton.addEventListener('click', event => {
    event.stopPropagation();
    const open = menu.hidden;
    closeDragMenus();
    menu.hidden = !open;
    menuButton.setAttribute('aria-expanded', String(open));
  });
  menu.addEventListener('click', event => {
    const button = (event.target as Element).closest<HTMLButtonElement>('[data-value]');
    if (!button) return;
    commit(button.dataset.value!);
    closeDragMenus();
  });
});
document.addEventListener('click', event => {
  if (!(event.target as Element).closest('.settings-drag-value')) closeDragMenus();
});

overlay.querySelectorAll<HTMLButtonElement>('[data-reset-scope]').forEach(button => {
  button.addEventListener('click', async () => {
    const scope = button.dataset.resetScope as 'cache' | 'assets';
    const label = scope === 'cache' ? 'PDE 캐시' : '에셋 캐시';
    if (!confirm(`${label}를 삭제하고 PDE를 재시작할까요?`)) return;
    button.disabled = true;
    const result = await window.ipcApi.resetPdeData(scope).catch(error => ({ success: false, error: String(error) }));
    if (!result.success) {
      button.disabled = false;
      alert(`초기화하지 못했습니다: ${result.error ?? '알 수 없는 오류'}`);
    }
  });
});

overlay.querySelector<HTMLButtonElement>('#force-gc')!.addEventListener('click', async event => {
  const button = event.currentTarget as HTMLButtonElement;
  button.disabled = true;
  const result = await window.ipcApi.forceGarbageCollection().catch(error => ({ success: false, error: String(error) }));
  button.disabled = false;
  if (result.success) void refreshSceneStatus();
  else console.error('GC를 실행하지 못했습니다:', result.error ?? '알 수 없는 오류');
});

settingsButton.addEventListener('click', openSettings);
closeButton.addEventListener('click', closeSettings);
overlay.addEventListener('click', event => {
  if (event.target === overlay) closeSettings();
});
document.addEventListener('keydown', event => {
  const target = event.target;
  if (matchesShortcut(event, 'openSettings') && overlay.hidden && !(target instanceof HTMLElement && (target.matches('input, textarea') || target.isContentEditable))) {
    event.preventDefault();
    openSettings();
  } else if (event.key === 'Escape') closeSettings();
});

if (import.meta.env.DEV) {
  console.assert(overlay.querySelectorAll('[data-settings-page]').length === 4 && overlay.querySelectorAll('[data-settings-content]').length === 4, 'Settings page navigation is incomplete.');
  console.assert(overlay.querySelectorAll('[data-reset-scope]').length === 2 && overlay.querySelector('#force-gc'), 'PDE reset controls are incomplete.');
  console.assert(dragControls.map(control => control.querySelector('.settings-drag-menu')!.childElementCount).join() === '7,11,7', 'Drag value presets are incomplete.');
  void refreshSceneStatus().then(() => console.assert(overlay.querySelector('#scene-object-types')!.childElementCount === Number(overlay.querySelector<HTMLOutputElement>('#scene-object-type-count')!.value), 'Scene object types are incomplete.'));
}
