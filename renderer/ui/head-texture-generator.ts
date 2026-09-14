import { getPlayerHeadTexture, replacePlayerHeadTextureReference, notifyPlayerHeadAtlasesChanged } from '../load-project/mesh-builder';
import { getActiveProjectId, hasProject, loadedObjectGroup } from '../load-project/upload-pbde';
import { record, isApplying } from '../controls/undo-redo/undo-redo';
import type { HeadTextureState } from '../player-head-service/head-texture-types';

type Target = { uuid: string; source: string };
let batch: { projectId: string; targets: Target[]; results: Map<string, string> } | undefined;
let applyingResults = false;

function applyResults(): void {
  if (!batch || applyingResults || isApplying()) return;
  if (!hasProject(batch.projectId)) { batch = undefined; return; }
  if (getActiveProjectId() !== batch.projectId) return;
  applyingResults = true;
  try {
    const changes: Array<Target & { url: string }> = [];
    batch.targets = batch.targets.filter(target => {
      const url = batch!.results.get(target.source);
      if (!url) return true;
      if (replacePlayerHeadTextureReference(target.uuid, target.source, url)) changes.push({ ...target, url });
      return false;
    });
    if (!changes.length) return;
    const refresh = () => {
      notifyPlayerHeadAtlasesChanged();
      window.dispatchEvent(new CustomEvent('pde:scene-updated'));
    };
    record({
      undo: () => { for (const item of changes) replacePlayerHeadTextureReference(item.uuid, item.url, item.source); refresh(); },
      redo: () => { for (const item of changes) replacePlayerHeadTextureReference(item.uuid, item.source, item.url); refresh(); }
    });
    refresh();
  } finally { applyingResults = false; }
}

export function initHeadTextureGenerator(section: HTMLElement, finishStroke: () => void): void {
  section.innerHTML = '<fieldset><legend>텍스쳐 생성</legend><button type="button" data-generate>텍스쳐 생성</button> <button type="button" data-cancel hidden>취소</button><p role="status" aria-live="polite"></p></fieldset>';
  const generate = section.querySelector<HTMLButtonElement>('[data-generate]')!;
  const cancel = section.querySelector<HTMLButtonElement>('[data-cancel]')!;
  const status = section.querySelector<HTMLParagraphElement>('[role="status"]')!;
  const api = window.ipcApi?.headTextures;
  if (!api) {
    generate.disabled = true;
    status.textContent = '새 계정 기능을 연결하려면 PDE 데스크톱 앱을 다시 시작해 주세요.';
    return;
  }
  const labels: Record<HeadTextureState['phase'], string> = {
    idle: '', uploading: '텍스처 생성 중', waiting: '자동 재시도 대기', restoring: '원래 스킨 복원 중',
    complete: '텍스처 생성 및 스킨 복원 완료', cancelled: '취소됨 · 스킨 복원 완료', failed: '완료 · 실패 항목은 원본 유지'
  };
  let running = false;
  let preparing = false;
  const render = (state: HeadTextureState) => {
    running = state.running;
    generate.disabled = running || preparing;
    cancel.hidden = !running;
    status.textContent = `${labels[state.phase]} ${state.total ? `${state.completed}/${state.total}` : ''}${state.failed ? ` · 실패 ${state.failed}` : ''}${state.retryAt ? ` · ${new Date(state.retryAt).toLocaleTimeString()} 재시도` : ''}${state.error ? ` · ${state.error}` : ''}`;
  };
  const unsubscribe = api.subscribe(event => {
    if (event.result && batch) { batch.results.set(event.result.source, event.result.url); applyResults(); }
    if (event.state) render(event.state);
  });
  window.addEventListener('beforeunload', unsubscribe, { once: true });
  window.addEventListener('pde:scene-updated', applyResults);
  window.addEventListener('pde:history-restored', () => queueMicrotask(applyResults));
  void api.state().then(render).catch(error => { status.textContent = String(error); });
  cancel.onclick = () => {
    cancel.disabled = true;
    void api.cancel().catch(error => { status.textContent = String(error); }).finally(() => { cancel.disabled = false; });
  };
  generate.onclick = async () => {
    if (running || preparing) return;
    preparing = true; generate.disabled = true;
    try {
      finishStroke();
      applyResults();
      if (batch?.targets.some(target => batch!.results.has(target.source)) && batch.projectId !== getActiveProjectId() && hasProject(batch.projectId)) {
        throw new Error('이전 프로젝트로 돌아가 생성 결과를 반영한 후 새 작업을 시작해 주세요.');
      }
      const projectId = getActiveProjectId();
      if (!projectId) throw new Error('프로젝트를 먼저 열어 주세요.');
      const refs = loadedObjectGroup.userData.objectTextures as Map<string, string> | undefined;
      const names = loadedObjectGroup.userData.objectNames as Map<string, string> | undefined;
      const targets: Target[] = [];
      for (const uuid of refs?.keys() ?? []) {
        if (!names?.get(uuid)?.startsWith('player_head')) continue;
        const source = getPlayerHeadTexture(uuid);
        if (source?.startsWith('data:image/png;base64,')) targets.push({ uuid, source });
      }
      if (!targets.length) { status.textContent = '변환할 PNG 헤드 텍스처가 없습니다.'; return; }
      batch = { projectId, targets, results: new Map() };
      status.textContent = '텍스처 확인 중…';
      const result = await api.start([...new Set(targets.map(target => target.source))]);
      if (!result.success) throw new Error(result.error);
    } catch (error) { status.textContent = error instanceof Error ? error.message : String(error); }
    finally { preparing = false; generate.disabled = running; }
  };
}
