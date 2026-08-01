import { blockbenchScaleMode, toggleBlockbenchScaleMode } from '../controls/gizmo/blockbench-scale';
import { closeWithAnimation, openWithAnimation } from './ui-open-close.js';
import { loadedObjectGroup } from '../load-project/upload-pbde';
import { cleanLabel } from './scene-panel/scene-panel-model';

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
        <button class="settings-reset" type="button"><span class="lucide-icon">&#xE666;</span>PDE 초기화</button>
      </nav>
      <main class="settings-content">
        <section class="settings-page" data-settings-content="general">
          <h3>일반 설정</h3>
          <fieldset>
            <legend>인터페이스</legend>
            <label class="settings-row"><span>도구 패널</span><span class="settings-select"><select id="toolbar-position"><option value="top">위</option><option value="bottom">아래</option></select><span class="lucide-icon">&#xE06F;</span></span></label>
            <label class="settings-row"><span>카메라</span><span class="settings-select"><select id="camera-type"><option value="perspective">원근</option><option value="orthographic">직교</option></select><span class="lucide-icon">&#xE06F;</span></span></label>
            <label class="settings-row"><span>카메라 FOV</span><span class="settings-range"><input id="camera-fov" type="range" min="20" max="120" value="80"><output>80°</output></span></label>
          </fieldset>
          <fieldset>
            <legend>조작</legend>
            <label class="settings-row"><span>스케일 조작 모드</span><span class="settings-select"><select id="scale-mode"><option value="default">기본</option><option value="blockbench">블록벤치 스케일 모드</option></select><span class="lucide-icon">&#xE06F;</span></span></label>
            <label class="settings-row"><span>오브젝트 교체 모드</span><span class="settings-select"><select id="object-replace-mode"><option value="default">기본</option><option value="preserve-visible-size">보이는 크기 유지</option></select><span class="lucide-icon">&#xE06F;</span></span></label>
            <label class="settings-row"><span>위치 드래그값</span><span class="settings-drag-value" data-values="0,1,0.5,0.25,0.125,0.625,0.0001"><input type="text" inputmode="decimal" value="0.0001" data-storage-key="pdePositionDragValue"><button type="button" aria-label="위치 드래그값 메뉴" aria-expanded="false"><span class="lucide-icon">&#xE06F;</span></button><span class="settings-drag-menu" hidden></span></span></label>
            <label class="settings-row"><span>각도 드래그값</span><span class="settings-drag-value" data-values="0,180,90,45,30,15,10,5,2,1,0.0001"><input type="text" inputmode="decimal" value="0.0001" data-storage-key="pdeRotationDragValue"><button type="button" aria-label="각도 드래그값 메뉴" aria-expanded="false"><span class="lucide-icon">&#xE06F;</span></button><span class="settings-drag-menu" hidden></span></span></label>
            <label class="settings-row"><span>스케일 드래그값</span><span class="settings-drag-value" data-values="0,1,0.5,0.25,0.125,0.625,0.0001"><input type="text" inputmode="decimal" value="0.0001" data-storage-key="pdeScaleDragValue"><button type="button" aria-label="스케일 드래그값 메뉴" aria-expanded="false"><span class="lucide-icon">&#xE06F;</span></button><span class="settings-drag-menu" hidden></span></span></label>
          </fieldset>
          <fieldset>
            <legend>헤드 페인트 계정</legend>
            <button class="settings-login" type="button">로그인하기</button>
          </fieldset>
        </section>
        <section class="settings-page" data-settings-content="shortcuts" hidden><h3>단축키</h3></section>
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
    control.querySelector('.lucide-icon')!.innerHTML = '&#xE06F;';
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
    menuButton.querySelector('.lucide-icon')!.innerHTML = open ? '&#xE06D;' : '&#xE06F;';
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

settingsButton.addEventListener('click', openSettings);
closeButton.addEventListener('click', closeSettings);
overlay.addEventListener('click', event => {
  if (event.target === overlay) closeSettings();
});
document.addEventListener('keydown', event => {
  if (event.key === 'Tab' && overlay.hidden) {
    event.preventDefault();
    openSettings();
  } else if (event.key === 'Escape') closeSettings();
});

if (import.meta.env.DEV) {
  console.assert(overlay.querySelectorAll('[data-settings-page]').length === 3 && overlay.querySelectorAll('[data-settings-content]').length === 3, 'Settings page navigation is incomplete.');
  console.assert(dragControls.map(control => control.querySelector('.settings-drag-menu')!.childElementCount).join() === '7,11,7', 'Drag value presets are incomplete.');
  void refreshSceneStatus().then(() => console.assert(overlay.querySelector('#scene-object-types')!.childElementCount === Number(overlay.querySelector<HTMLOutputElement>('#scene-object-type-count')!.value), 'Scene object types are incomplete.'));
}
