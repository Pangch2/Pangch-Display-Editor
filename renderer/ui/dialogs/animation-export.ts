import { loadedObjectGroup as root } from '../../load-project/display/display-instancing';
import { animationClips } from '../../animation/animation-data';
import { animationProjectData } from '../../animation/animation-state';
import { exportAnimationDatapack } from '../../animation/export/animation-export';
import { bakeQualities, type BakeQuality } from '../../animation/export/animation-bake';
import { animationNamespace, clipFunctionNames } from '../../animation/export/animation-datapack';
import { openWithAnimation, closeWithAnimation } from '../common/ui-open-close.js';

// Slider stops; custom keeps whatever the three options below are set to.
const presets: (BakeQuality | undefined)[] = [undefined, bakeQualities.performance, bakeQualities.balanced, bakeQualities.quality];

const dialog = document.createElement('dialog');
dialog.id = 'animation-export-dialog';
dialog.className = 'settings-window summon-command-window';
dialog.setAttribute('aria-labelledby', 'animation-export-title');
dialog.innerHTML = `
  <header><h2 id="animation-export-title">애니메이션 내보내기</h2><button class="settings-close" type="button" aria-label="닫기">×</button></header>
  <div class="summon-command-body">
    <div class="animation-export-options">
      <label class="settings-row"><span>데이터팩 이름</span><input id="animation-export-name" type="text" maxlength="64" spellcheck="false"></label>
      <div class="settings-row"><span id="animation-export-format-label">저장 형식</span>
        <div class="summon-command-modes" role="group" aria-labelledby="animation-export-format-label">
          <button type="button" data-folder="false" aria-pressed="true">zip</button><button type="button" data-folder="true" aria-pressed="false">폴더</button>
        </div>
      </div>
      <label class="settings-row"><span>저장 폴더 경로</span><input id="animation-export-directory" type="text" placeholder="비워 두면 저장할 때 선택" spellcheck="false"></label>
      <div class="settings-row"><span id="animation-export-quality-label">애니메이션 품질</span>
        <div class="animation-export-quality">
          <input id="animation-export-quality" type="range" min="0" max="3" step="1" value="2" aria-labelledby="animation-export-quality-label">
          <div class="animation-export-stops">
            <button type="button" data-stop="0">커스텀</button>
            <button type="button" data-stop="1" title="같은 움직임을 합치고, 2틱 단위로 자세를 보내 그 사이는 보간으로 잇습니다">성능 우선</button>
            <button type="button" data-stop="2" title="같은 움직임은 합치고, 멈춰 있던 파츠가 움직이기 1틱 전에 자세를 다시 보냅니다">균형</button>
            <button type="button" data-stop="3" title="움직이는 모든 틱을 내보냅니다">품질 우선</button>
          </div>
        </div>
      </div>
      <div class="settings-row" title="이전 프레임과 같은 움직임(같은 직선 경로)이 이어지는 프레임은 내보내지 않습니다"><span id="animation-export-merge-label">같은 움직임 합치기</span><input id="animation-export-merge" type="checkbox" aria-labelledby="animation-export-merge-label"></div>
      <label class="settings-row" title="이 틱 간격으로만 자세를 보내고, 보간 시간을 그 간격에 맞춰 사이를 잇습니다. 1이면 매 틱입니다. 모델·엔티티 교체는 정확한 틱에 유지됩니다."><span>양자화 (틱)</span><input id="animation-export-quantize" type="number" min="1" step="1" value="1"></label>
      <label class="settings-row" title="모든 파츠의 갱신 틱을 함께 골라 NBT 쓰기를 줄이고, 파츠 모서리가 원래 자세에서 이 거리(블록)까지만 벗어나게 합니다. 0이면 끕니다. 옆의 픽셀은 1080p 화면, 시야 70 기준이며 거리가 두 배면 절반이 됩니다. (같은 움직임 합치기가 켜져 있을 때만)"><span>공유 틱 오차 (블록)</span><span class="animation-export-error"><input id="animation-export-pose-error" type="number" min="0" step="0.001" value="0"><output id="animation-export-pose-pixels"></output></span></label>
      <div class="settings-row" title="멈춰 있던 파츠가 움직이기 1틱 전에 자세를 다시 보냅니다 (같은 움직임 합치기가 켜져 있을 때만)"><span id="animation-export-preroll-label">이동 1틱 전 보정</span><input id="animation-export-preroll" type="checkbox" aria-labelledby="animation-export-preroll-label"></div>
      <div class="settings-row" title="부모 하나에 디스플레이가 많으면 MSPT가 급증하므로, 디스플레이를 여러 보조 부모(item_display)에 나눠 태우고 그 부모들을 루트에 태웁니다. play/stop/remove는 루트·보조 부모·파츠 어디서 실행해도 루트로 전달됩니다."><span id="animation-export-expand-label">루트 확장</span><input id="animation-export-expand" type="checkbox" aria-labelledby="animation-export-expand-label"></div>
    </div>
    <div class="summon-command-toolbar"><output></output><button type="button" id="animation-export-save">데이터팩 저장</button></div>
    <textarea id="animation-export-text" class="pde-input" aria-label="데이터팩 함수" wrap="off" readonly spellcheck="false"></textarea>
    <p role="status" aria-live="polite"></p>
  </div>`;
document.body.append(dialog);
const summary = dialog.querySelector<HTMLOutputElement>('.summon-command-toolbar output')!;
const text = dialog.querySelector('textarea')!;
const status = dialog.querySelector<HTMLElement>('[role="status"]')!;
const save = dialog.querySelector<HTMLButtonElement>('#animation-export-save')!;
const nameInput = dialog.querySelector<HTMLInputElement>('#animation-export-name')!;
const directoryInput = dialog.querySelector<HTMLInputElement>('#animation-export-directory')!;
const formatButtons = [...dialog.querySelectorAll<HTMLButtonElement>('[data-folder]')];
const range = dialog.querySelector<HTMLInputElement>('#animation-export-quality')!;
const stops = [...dialog.querySelectorAll<HTMLButtonElement>('[data-stop]')];
const merge = dialog.querySelector<HTMLInputElement>('#animation-export-merge')!;
const quantize = dialog.querySelector<HTMLInputElement>('#animation-export-quantize')!;
const poseError = dialog.querySelector<HTMLInputElement>('#animation-export-pose-error')!;
const posePixels = dialog.querySelector<HTMLOutputElement>('#animation-export-pose-pixels')!;
const preroll = dialog.querySelector<HTMLInputElement>('#animation-export-preroll')!;
const expandRoot = dialog.querySelector<HTMLInputElement>('#animation-export-expand')!;
let running: AbortController | undefined;
let closing = false;

// Export options and the last saved path are saved with the project; localStorage holds the defaults for projects without them.
const storageKey = 'pdeAnimationExport';
type StoredOptions = { folder?: boolean; quality?: string; merge?: boolean; quantize?: string; poseError?: string; preroll?: boolean; expandRoot?: boolean; path?: string; directory?: string };
let stored: StoredOptions = {};
try { stored = JSON.parse(localStorage.getItem(storageKey) ?? '{}') ?? {}; } catch { /* unreadable: defaults */ }

const projectDetails = () => root.userData.projectDetails as { name?: string; datapackName?: string; animationExport?: StoredOptions } | undefined;
const projectName = () => projectDetails()?.name || 'project';
const exportName = () => nameInput.value.trim() || projectName();
const validTicks = (value: string) => Number.isSafeInteger(Number(value)) && Number(value) >= 1;
const validError = (value: string) => value.trim() !== '' && Number.isFinite(Number(value)) && Number(value) >= 0;
// Minecraft's default 70° vertical view on a 1080-pixel screen: a block 3 blocks away is 1080 / (6 tan 35°) ≈ 257 pixels tall.
const pixelsPerBlock = 1080 / (6 * Math.tan(35 * Math.PI / 180));
const pressed = (button: HTMLButtonElement) => button.getAttribute('aria-pressed') === 'true';
const press = (group: HTMLButtonElement[], button: HTMLButtonElement | undefined) => button && group.forEach(other => other.setAttribute('aria-pressed', String(other === button)));

function storeOptions(path = stored.path): void {
  stored = { folder: pressed(formatButtons[1]), directory: directoryInput.value.trim(), quality: range.value,
    merge: merge.checked, quantize: quantize.value, poseError: poseError.value, preroll: preroll.checked, expandRoot: expandRoot.checked, path };
  localStorage.setItem(storageKey, JSON.stringify(stored));
  const details = projectDetails();
  if (details) details.animationExport = { ...stored };
}

function showQuality(): void {
  const preset = presets[Number(range.value)];
  if (preset) {
    merge.checked = preset.merge;
    preroll.checked = preset.preroll;
    quantize.value = String(preset.quantize);
    poseError.value = String(preset.poseError ?? 0);
  }
  // Preroll and the shared ticks only apply to merged motion.
  if (!merge.checked) preroll.checked = false;
  preroll.disabled = poseError.disabled = !merge.checked;
  const blocks = Number(poseError.value);
  posePixels.value = !validError(poseError.value) ? '' : poseError.disabled || !blocks ? '꺼짐' : `3블록에서 최대 ${Number((blocks * pixelsPerBlock).toPrecision(2))}px`;
  stops.forEach((stop, index) => stop.setAttribute('aria-pressed', String(index === Number(range.value))));
}

function showFunctions(): void {
  const data = animationProjectData(root), ns = animationNamespace(exportName());
  const clips = data ? animationClips(data).map(clip => clip.name ?? '기본') : [];
  const names = clipFunctionNames(clips);
  summary.value = `네임스페이스 ${ns} · 동작 ${clips.length}개`;
  text.value = [`function ${ns}:summon`, ...names.map((name, index) => `execute as <부모 엔티티> run function ${ns}:play/${name}   # ${clips[index]}`),
    `execute as <부모 엔티티> run function ${ns}:stop`, `execute as <부모 엔티티> run function ${ns}:remove`].join('\n');
}

range.addEventListener('input', showQuality);
stops.forEach((stop, index) => stop.onclick = () => {
  range.value = String(index);
  showQuality();
});
// Changing an option by hand leaves the presets.
for (const input of [merge, quantize, poseError, preroll]) input.addEventListener('input', () => {
  range.value = '0';
  showQuality();
});
for (const button of formatButtons) button.onclick = () => press(formatButtons, button);
nameInput.addEventListener('input', () => {
  // Empty follows the project name.
  const details = projectDetails();
  if (details) details.datapackName = nameInput.value.trim();
  showFunctions();
});
function applyOptions(options: StoredOptions): void {
  stored = { ...options, path: typeof options.path === 'string' ? options.path : undefined };
  press(formatButtons, formatButtons.find(button => button.dataset.folder === String(options.folder === true)));
  directoryInput.value = typeof options.directory === 'string' ? options.directory : '';
  range.value = stops.some(stop => stop.dataset.stop === options.quality) ? options.quality! : '2';
  // Only the custom stop keeps these; a preset overwrites them in showQuality.
  merge.checked = options.merge === true;
  preroll.checked = options.preroll === true;
  // Older versions stored an error limit such as 0.01 here.
  quantize.value = typeof options.quantize === 'string' && validTicks(options.quantize) ? options.quantize : '1';
  poseError.value = typeof options.poseError === 'string' && validError(options.poseError) ? options.poseError : '0';
  expandRoot.checked = options.expandRoot === true;
  showQuality();
}
applyOptions(stored);

function closeAnimationExport(): void {
  if (!dialog.open || closing) return;
  closing = true;
  running?.abort();
  storeOptions();
  void closeWithAnimation(dialog).then(() => {
    dialog.close();
    closing = false;
  });
}
dialog.querySelector<HTMLButtonElement>('.settings-close')!.onclick = closeAnimationExport;
dialog.addEventListener('cancel', event => {
  event.preventDefault();
  closeAnimationExport();
});
dialog.addEventListener('click', event => {
  if (event.target !== dialog) return;
  const bounds = dialog.getBoundingClientRect();
  if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) closeAnimationExport();
});
dialog.addEventListener('keydown', event => {
  // Prevent native Esc closing before the animation, including noncancelable dialog cancel events.
  if (event.key === 'Escape') {
    event.preventDefault();
    closeAnimationExport();
  }
  event.stopPropagation();
});

save.onclick = async () => {
  if (!validTicks(quantize.value)) {
    status.textContent = '양자화 값은 1 이상의 정수(틱)여야 합니다.';
    quantize.focus();
    return;
  }
  if (!validError(poseError.value)) {
    status.textContent = '공유 틱 오차는 0 이상의 숫자(블록)여야 합니다.';
    poseError.focus();
    return;
  }
  const current = running = new AbortController();
  save.disabled = true;
  status.textContent = '애니메이션을 굽는 중…';
  try {
    const path = await exportAnimationDatapack(root, { name: exportName(), folder: pressed(formatButtons[1]), directory: directoryInput.value.trim(),
      quality: { merge: merge.checked, preroll: preroll.checked, quantize: Number(quantize.value), poseError: Number(poseError.value) }, expandRoot: expandRoot.checked, lastPath: stored.path }, current.signal);
    if (path) storeOptions(path);
    if (!current.signal.aborted) status.textContent = path ? `저장했습니다: ${path}` : '';
  } catch (error) {
    if (!current.signal.aborted) status.textContent = `내보내기 실패: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    if (running === current) running = undefined;
    save.disabled = false;
    // Baking scrubs through every clip and restores the tick it started on.
    window.dispatchEvent(new CustomEvent('pde:animation-preview'));
  }
};

export function openAnimationExport(): void {
  if (dialog.open) return;
  nameInput.value = projectDetails()?.datapackName || projectName();
  applyOptions(projectDetails()?.animationExport ?? stored);
  showFunctions();
  status.textContent = '';
  dialog.showModal();
  openWithAnimation(dialog);
  save.focus();
}
