import { getPlayerHeadTexture, replacePlayerHeadTextureReference } from '../../load-project/display/mesh-builder';
import { getActiveProjectId, hasProject, loadedObjectGroup } from '../../load-project/pbde/upload-pbde';
import { record, isApplying } from '../../controls/undo-redo/undo-redo';
import type { HeadTextureState } from '../../player-head-service/head-texture-types';
import { createHeadTextureLoading } from './head-texture-loading';
import { animationClips, type AnimationData } from '../../animation/animation-data';

type Target = { uuid: string; source: string };
let batch: { projectId: string; targets: Target[]; results: Map<string, string> } | undefined;
let applyingResults = false;
let isPainting = () => false;

function applyResults(): void {
  if (!batch || applyingResults || isApplying() || isPainting()) return;
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
      window.dispatchEvent(new CustomEvent('pde:scene-updated', { detail: { texturesOnly: true, skipGizmoRefresh: true } }));
    };
    record({
      undo: () => { for (const item of changes) replacePlayerHeadTextureReference(item.uuid, item.url, item.source); refresh(); },
      redo: () => { for (const item of changes) replacePlayerHeadTextureReference(item.uuid, item.source, item.url); refresh(); }
    });
    refresh();
  } finally { applyingResults = false; }
}

export function initHeadTextureGenerator(section: HTMLElement, finishStroke: () => void, hasStroke: () => boolean): void {
  isPainting = hasStroke;
  section.innerHTML = '<fieldset><legend>텍스쳐 생성</legend><button type="button" data-generate>텍스쳐 생성</button> <button type="button" data-cancel hidden>취소</button> <button type="button" data-retry-restore hidden>복원 재시도</button><p role="status" aria-live="polite"></p></fieldset>';
  const generate = section.querySelector<HTMLButtonElement>('[data-generate]')!;
  const cancel = section.querySelector<HTMLButtonElement>('[data-cancel]')!;
  const retryRestore = section.querySelector<HTMLButtonElement>('[data-retry-restore]')!;
  const status = section.querySelector<HTMLParagraphElement>('[role="status"]')!;
  const api = window.ipcApi?.headTextures;
  if (!api?.setInputLocked) {
    generate.disabled = true;
    status.textContent = '텍스처 생성 기능을 연결하려면 PDE 데스크톱 앱을 다시 시작해 주세요.';
    return;
  }
  const labels: Record<HeadTextureState['phase'], string> = {
    idle: '', uploading: '텍스처 생성 중', applying: '텍스처 적용 중', waiting: '자동 재시도 대기', restoring: '원래 스킨 복원 중',
    complete: '텍스처 생성 및 스킨 복원 완료', cancelled: '취소됨 · 스킨 복원 완료', failed: '완료 · 실패 항목은 원본 유지'
  };
  let running = false;
  let preparing = false;
  let applying = false;
  let applyFrame = 0;
  let cancelRequested = false;
  let failure = false;
  let lastState: HeadTextureState = { running: false, phase: 'idle', total: 0, completed: 0, failed: 0 };
  const loading = createHeadTextureLoading(() => { void requestCancel(); });
  const updateLoading = () => {
    generate.disabled = running || preparing || applying;
    const failed = failure || lastState.restoreBlocked || lastState.phase === 'failed';
    if (preparing || applying || (running && !(cancelRequested && lastState.restoreBlocked)) || (failed && !cancelRequested)) {
      loading.show(failure || lastState.restoreBlocked ? '팽치가 실패했습니다...'
        : applying || lastState.phase === 'applying' ? '팽치가 붓칠하는중...'
        : lastState.phase === 'waiting' || lastState.retryAt ? '팽치가 모장에게 비는중...'
        : lastState.phase === 'failed' || lastState.error ? '팽치가 실패했습니다...'
        : '팽치가 모장에게 뛰어가는중...');
    } else loading.hide();
  };
  const render = (state: HeadTextureState) => {
    lastState = state;
    running = state.running;
    cancel.hidden = !running;
    retryRestore.hidden = !state.restoreBlocked;
    status.textContent = `${state.restoreBlocked ? '원래 스킨 복원 확인 필요' : labels[state.phase]} ${state.total ? `${state.completed}/${state.total}` : ''}${state.failed ? ` · 실패 ${state.failed}` : ''}${state.retryAt ? ` · ${new Date(state.retryAt).toLocaleTimeString()} 재시도` : ''}${state.error ? ` · ${state.error}` : ''}`;
    updateLoading();
  };
  const scheduleResults = () => {
    if (applyFrame || !batch) return;
    applying = true;
    updateLoading();
    // Leave one painted frame for the application message before updating the scene.
    applyFrame = requestAnimationFrame(() => {
      applyFrame = requestAnimationFrame(() => {
        applyFrame = 0;
        try { applyResults(); }
        catch (error) { failure = true; status.textContent = String(error); }
        finally { applying = false; updateLoading(); }
      });
    });
  };
  const unsubscribe = api.subscribe(event => {
    if (event.log) console.info('[헤드 텍스처 API]', event.log);
    if (event.result && batch) { batch.results.set(event.result.source, event.result.url); scheduleResults(); }
    if (event.state) render(event.state);
  });
  window.addEventListener('beforeunload', () => { unsubscribe(); cancelAnimationFrame(applyFrame); }, { once: true });
  window.addEventListener('pde:scene-updated', applyResults);
  window.addEventListener('pde:history-restored', () => queueMicrotask(applyResults));
  void api.state().then(render).catch(error => { failure = true; status.textContent = String(error); updateLoading(); });
  const requestCancel = async () => {
    if (cancelRequested) return;
    cancelRequested = true;
    failure = false;
    cancel.disabled = true;
    loading.cancel.disabled = true;
    try { if (running && !preparing) await api.cancel(); }
    catch (error) { cancelRequested = false; failure = true; status.textContent = String(error); }
    finally {
      cancel.disabled = loading.cancel.disabled = cancelRequested && (running || preparing);
      updateLoading();
    }
  };
  cancel.onclick = () => { void requestCancel(); };
  retryRestore.onclick = () => {
    retryRestore.disabled = true;
    void api.retryRestore().catch(error => { status.textContent = String(error); }).finally(() => { retryRestore.disabled = false; });
  };
  generate.onclick = async () => {
    if (running || preparing || applying) return;
    preparing = true; generate.disabled = true;
    cancelRequested = false; failure = false;
    lastState = { running: false, phase: 'idle', total: 0, completed: 0, failed: 0 };
    cancel.disabled = loading.cancel.disabled = false;
    updateLoading();
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
      const addTarget = (uuid: string, source?: string) => {
        if (names?.get(uuid)?.split('[')[0].replace(/^minecraft:/, '') === 'player_head'
            && source?.startsWith('data:image/png;base64,')) targets.push({ uuid, source });
      };
      for (const uuid of refs?.keys() ?? []) {
        addTarget(uuid, getPlayerHeadTexture(uuid));
      }
      const data = loadedObjectGroup.userData;
      if (data.animation) {
        for (const clip of data.animation ? animationClips(data.animation as AnimationData) : []) for (const track of clip.tracks) {
          for (const key of track.keys) addTarget(track.id, key.texture);
        }
        for (const [uuid, node] of data.animationSession?.base ?? []) addTarget(uuid, node.texture);
      }
      if (!targets.length) { status.textContent = '변환할 PNG 헤드 텍스처가 없습니다.'; return; }
      batch = { projectId, targets, results: new Map() };
      status.textContent = '텍스처 확인 중…';
      const result = await api.start([...new Set(targets.map(target => target.source))]);
      if (!result.success) throw new Error(result.error);
      if (cancelRequested) await api.cancel();
    } catch (error) { cancelRequested = false; failure = true; status.textContent = error instanceof Error ? error.message : String(error); }
    finally {
      preparing = false; generate.disabled = running || applying;
      cancel.disabled = loading.cancel.disabled = cancelRequested && running;
      updateLoading();
    }
  };
}
