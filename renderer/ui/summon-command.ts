import { generateSummonCommands, generateSummonCommandsAsync, summonCommandLimits, type SummonExportMode } from '../export/summon-command';
import { loadedObjectGroup } from '../load-project/display/display-instancing';
import { getPlayerHeadTexture } from '../load-project/display/player-head-atlas';
import { matchesShortcut } from '../controls/input/shortcuts';
import { openWithAnimation, closeWithAnimation } from './ui-open-close.js';

const dialog = document.createElement('dialog');
dialog.id = 'summon-command-dialog';
dialog.className = 'settings-window summon-command-window';
dialog.setAttribute('aria-labelledby', 'summon-command-title');
dialog.innerHTML = `
  <header><h2 id="summon-command-title">소환 명령어</h2><button class="settings-close" type="button" aria-label="닫기">×</button></header>
  <div class="summon-command-body">
    <div class="summon-command-toolbar">
    <div class="summon-command-modes" role="group" aria-label="내보내기 형식">
      <button type="button" data-mode="command" aria-pressed="true" title="커맨드 블록 · 최대 32,500자">Command</button>
      <button type="button" data-mode="datapack" aria-pressed="false" title="mcfunction 한 줄 · 최대 2,000,000자">DataPack</button>
      <button type="button" data-mode="separate" aria-pressed="false" title="오브젝트 하나당 summon 명령어 하나 · 최대 32,500자">Separate</button>
    </div>
    <button type="button" id="summon-command-save" aria-label="mcfunction 저장" title="mcfunction 저장" hidden disabled><span class="lucide-icon" aria-hidden="true">&#xE14D;</span></button>
    </div>
    <div id="summon-command-list">
      <section class="summon-command-entry">
        <textarea id="summon-command-text" class="pde-input" aria-label="Command 1" rows="1" wrap="off" readonly spellcheck="false"></textarea>
        <footer><output id="summon-command-count">0자</output><button type="button" id="summon-command-copy" data-copy>복사</button></footer>
      </section>
    </div>
    <p role="status" aria-live="polite"></p>
  </div>`;
document.body.append(dialog);
const text = dialog.querySelector<HTMLTextAreaElement>('textarea')!;
const list = dialog.querySelector<HTMLDivElement>('#summon-command-list')!;
const status = dialog.querySelector<HTMLElement>('[role="status"]')!;
const save = dialog.querySelector<HTMLButtonElement>('#summon-command-save')!;
let mode: SummonExportMode = 'command';
let saving = false;
let exportedCommands: string[] = [];
let closing = false;
let generation: AbortController | undefined;
let commandText = new WeakMap<HTMLTextAreaElement, string>();
const previewLimit = summonCommandLimits.command;
const hydrateText = (field: HTMLTextAreaElement) => {
  const command = commandText.get(field);
  if (command === undefined || field.value) return;
  field.value = command.slice(0, previewLimit);
};
const visibleCommands = new IntersectionObserver(entries => {
  for (const entry of entries) if (entry.isIntersecting) {
    hydrateText(entry.target as HTMLTextAreaElement);
    visibleCommands.unobserve(entry.target);
  }
}, { root: list, rootMargin: '200px' });
list.addEventListener('focusin', event => {
  if (event.target instanceof HTMLTextAreaElement) hydrateText(event.target);
});
list.addEventListener('copy', event => {
  const field = event.target;
  if (!(field instanceof HTMLTextAreaElement) || !event.clipboardData) return;
  const command = commandText.get(field);
  if (!command || command.length <= previewLimit || field.selectionStart !== 0 || field.selectionEnd !== field.value.length) return;
  event.clipboardData.setData('text/plain', command);
  event.preventDefault();
});
function closeSummonCommand(): void {
  if (!dialog.open || closing) return;
  closing = true;
  generation?.abort();
  exportedCommands = [];
  save.disabled = true;
  visibleCommands.disconnect();
  void closeWithAnimation(dialog).then(() => {
    dialog.close();
    list.replaceChildren(list.firstElementChild!);
    list.setAttribute('aria-busy', 'false');
    text.value = '';
    commandText = new WeakMap();
    closing = false;
  });
}
dialog.querySelector<HTMLButtonElement>('.settings-close')!.onclick = closeSummonCommand;
dialog.addEventListener('cancel', event => {
  event.preventDefault();
  closeSummonCommand();
});
dialog.addEventListener('click', event => {
  if (event.target !== dialog) return;
  const bounds = dialog.getBoundingClientRect();
  if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) closeSummonCommand();
});
dialog.addEventListener('keydown', event => {
  // Prevent native Esc closing before the animation, including noncancelable dialog cancel events.
  if (event.key === 'Escape') {
    event.preventDefault();
    closeSummonCommand();
  }
  event.stopPropagation();
});
list.addEventListener('click', async event => {
  const copy = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-copy]');
  if (!copy || copy.disabled) return;
  const field = copy.closest('section')!.querySelector('textarea')!;
  hydrateText(field);
  const currentGeneration = generation;
  copy.disabled = true;
  try {
    await navigator.clipboard.writeText(commandText.get(field) ?? field.value);
    if (generation === currentGeneration && !currentGeneration?.signal.aborted) status.textContent = '복사했습니다.';
  } catch (error) {
    if (generation !== currentGeneration || currentGeneration?.signal.aborted) return;
    field.focus();
    field.select();
    status.textContent = `복사 실패: ${error instanceof Error ? error.message : String(error)} · 명령어를 선택했습니다. Ctrl+C로 복사해 주세요.`;
  } finally { if (generation === currentGeneration && !currentGeneration?.signal.aborted) copy.disabled = !field.value; }
});

async function renderCommands(): Promise<void> {
  generation?.abort();
  const current = generation = new AbortController();
  const exportMode = mode;
  exportedCommands = [];
  save.hidden = exportMode === 'command';
  save.disabled = true;
  const large = (loadedObjectGroup.userData.objectUuidToInstance?.size ?? 0) >= 1000;
  visibleCommands.disconnect();
  commandText = new WeakMap();
  const first = list.firstElementChild!;
  while (list.children.length > 1) list.lastElementChild!.remove();
  text.value = '';
  first.querySelector('button')!.disabled = true;
  first.querySelector('output')!.value = '0자';
  const template = first.cloneNode(true) as HTMLElement;
  list.scrollTop = 0;
  list.setAttribute('aria-busy', 'true');
  status.textContent = large ? '소환 명령 생성 중…' : '';
  let commands = [''];
  try {
    if (large) await new Promise<void>(resolve => setTimeout(resolve, 0));
    current.signal.throwIfAborted();
    let deadline = performance.now() + 8;
    let scanned = 0;
    // Commit remapped/painted atlas pixels through the existing head export path.
    for (const [uuid, name] of (loadedObjectGroup.userData.objectNames as Map<string, string> | undefined) ?? []) {
      if (name.split('[')[0].replace(/^minecraft:/, '') === 'player_head') getPlayerHeadTexture(uuid);
      if (large && ++scanned % 128 === 0 && performance.now() >= deadline) {
        await new Promise<void>(resolve => setTimeout(resolve, 0));
        current.signal.throwIfAborted();
        deadline = performance.now() + 8;
      }
    }
    commands = large ? await generateSummonCommandsAsync(loadedObjectGroup, exportMode, current.signal)
      : generateSummonCommands(loadedObjectGroup, exportMode);
    if (current.signal.aborted) return;
    exportedCommands = commands;
    status.textContent = '';
  } catch (error) {
    if (current.signal.aborted) return;
    status.textContent = error instanceof Error ? error.message : String(error);
  }
  let deadline = performance.now() + 8;
  let fragment = document.createDocumentFragment();
  for (let index = 0; index < commands.length; index++) {
    const command = commands[index];
    const entry = index ? template.cloneNode(true) as HTMLElement : first;
    const field = entry.querySelector<HTMLTextAreaElement>('textarea')!;
    const count = entry.querySelector<HTMLOutputElement>('output')!;
    const copy = entry.querySelector<HTMLButtonElement>('button')!;
    const suffix = index ? `-${index + 1}` : '';
    field.id = 'summon-command-text' + suffix;
    count.id = 'summon-command-count' + suffix;
    copy.id = 'summon-command-copy' + suffix;
    field.setAttribute('aria-label', `${exportMode === 'command' ? 'Command' : exportMode === 'datapack' ? 'DataPack' : 'Separate'} ${index + 1}`);
    if (large) {
      commandText.set(field, command);
      if (index) visibleCommands.observe(field);
      else hydrateText(field);
    } else field.value = command;
    const preview = large && command.length > previewLimit;
    field.title = preview ? '앞 32,500자 미리보기 · 복사 버튼 또는 전체 선택 후 Ctrl+C로 전체 명령어를 복사합니다.' : '';
    count.value = `${index + 1}/${commands.length} · ${command.length.toLocaleString()} / ${summonCommandLimits[exportMode].toLocaleString()}자${preview ? ' · 미리보기' : ''}`;
    copy.disabled = !command;
    if (index) fragment.append(entry);
    if (large && index % 32 === 31 && performance.now() >= deadline) {
      list.append(fragment);
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      if (current.signal.aborted) return;
      fragment = document.createDocumentFragment();
      deadline = performance.now() + 8;
    }
  }
  list.append(fragment);
  list.setAttribute('aria-busy', 'false');
  save.disabled = saving || !exportedCommands.length;
}

save.onclick = async () => {
  if (save.disabled || mode === 'command') return;
  const current = generation;
  saving = true;
  save.disabled = true;
  try {
    const result = await window.ipcApi.saveMcfunction(loadedObjectGroup.userData.projectDetails?.name || 'project', exportedCommands);
    if (!result.success && !result.canceled) throw new Error(result.error ?? '파일을 저장할 수 없습니다.');
    if (generation === current && !current?.signal.aborted && result.success) status.textContent = '저장했습니다.';
  } catch (error) {
    if (generation === current && !current?.signal.aborted) status.textContent = `저장 실패: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    saving = false;
    save.disabled = !exportedCommands.length || list.getAttribute('aria-busy') === 'true';
  }
};

for (const button of dialog.querySelectorAll<HTMLButtonElement>('[data-mode]')) {
  button.onclick = () => {
    if (mode === button.dataset.mode) return;
    mode = button.dataset.mode as SummonExportMode;
    for (const option of dialog.querySelectorAll('[data-mode]')) option.setAttribute('aria-pressed', String(option === button));
    void renderCommands();
  };
}

export function openSummonCommand(): void {
  if (dialog.open) return;
  dialog.showModal();
  openWithAnimation(dialog);
  void renderCommands();
  text.focus();
}

document.addEventListener('keydown', event => {
  const target = event.target;
  if (event.defaultPrevented || event.repeat || event.isComposing || document.querySelector('dialog[open], .settings-overlay:not([hidden])')) return;
  if (target instanceof HTMLElement && (target.closest('input, textarea, select') || target.isContentEditable)) return;
  if (matchesShortcut(event, 'openSummonCommand')) {
    event.preventDefault();
    event.stopPropagation();
    openSummonCommand();
  }
});
