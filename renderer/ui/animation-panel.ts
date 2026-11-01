import { loadedObjectGroup as root } from '../load-project/display/display-instancing';
import { Matrix4 } from 'three/webgpu';
import { animationData, animationSession, captureAnimationSnapshot, previewAnimation, restoreAnimationSnapshot,
    recordAnimationTransform, setAnimationEnabled, syncAnimationTargets, selectAnimationClip, previewAnimationPlayback } from '../animation/animation-state';
import { animationEasings, animationChannels, animationEndTick, animationLayers, animationPlayback, channelKeys, keyHasChannel, keyCurve, setKeyCurve, keyChannelValues, animationExpression,
    copyKeyChannels, removeKeyChannels, mergeAnimationKey, keyTransform, animationTimelineEnd, ticksPerSecond, type AnimationChannel, type AnimationClip, type AnimationCurve, type AnimationKey, type AnimationTrack, type AnimationVector } from '../animation/animation-data';
import { animationGraphLayout, renderAnimationGraph, type GraphChannel, type GraphLayout } from './animation-graph';
import { initAnimationClipControls } from './animation-clips';
import { renderAnimationLayerRow } from './animation-layer-timeline';
import { recordStateChange, refreshHistory } from '../controls/undo-redo/scene-history';
import { flushProjectEdits, queueProjectEdit, startProjectEdit } from '../save/pending-edits';
import { getShortcuts, matchesPointerShortcut, matchesShortcut } from '../controls/input/shortcuts';
import { handleExpandCollapseShortcut } from './common/expand-collapse';
import { getSelectAllSceneSelection, type PrimarySelection } from '../controls/selection/select';
import { getObjectLabel } from './scene-panel/scene-panel-model';
import { isSceneItemEnabled, setSceneItemEnabled } from '../controls/scene-visibility';
import { record } from '../controls/undo-redo/undo-redo';

const button = document.getElementById('animation-button') as HTMLButtonElement;
const panel = document.createElement('section');
panel.id = 'animation-panel';
panel.hidden = true;
panel.tabIndex = 0;
panel.setAttribute('aria-label', '애니메이션 키프레임');
panel.innerHTML = `<div class="details-resizer animation-resizer" role="separator" tabindex="0" aria-label="애니메이션 패널 높이" aria-orientation="horizontal" aria-controls="animation-panel" aria-valuemin="120"></div>
    <div class="animation-controls"><div class="animation-actions"><strong>타임라인</strong>
        <button id="animation-graph-toggle" type="button" aria-pressed="false" title="키프레임 / 그래프 보기 전환">그래프</button>
        </div>
    <div class="animation-transport" role="group" aria-label="애니메이션 재생 제어">
        <button id="animation-start" type="button" title="처음으로 (Home)" aria-label="처음으로">|‹</button>
        <button id="animation-previous-key" class="lucide-icon" type="button" title="이전 키프레임" aria-label="이전 키프레임">&#xE15F;</button>
        <button id="animation-pause" class="lucide-icon" type="button" title="재생" aria-label="재생" aria-pressed="false">&#xE13C;</button>
        <button id="animation-next-key" class="lucide-icon" type="button" title="다음 키프레임" aria-label="다음 키프레임">&#xE160;</button>
        <button id="animation-end" type="button" title="재생 종료 틱으로 (End)" aria-label="재생 종료 틱으로">›|</button>
        <button id="animation-loop" type="button" title="0틱부터 재생 종료 틱까지 반복" aria-label="반복 재생" aria-pressed="false">↻</button>
    </div>
    <div class="animation-timing">
        <label>틱 <input id="animation-tick" class="pde-input" type="number" inputmode="numeric" min="0" step="1" value="0"></label>
        <label class="animation-rate"><input id="animation-rate" class="pde-input" aria-label="재생속도 (틱/초)" type="number" inputmode="decimal" min="1" max="10000" step="any" value="20"> 틱/초</label>
    </div></div>
    <div class="animation-tools" role="toolbar" aria-label="키프레임 편집">
        <div class="animation-actions">
        <button id="animation-add" type="button" title="선택한 파츠의 현재 포즈를 키프레임으로 추가" disabled>◇ 키 추가</button>
        <button id="animation-duplicate" type="button" disabled>복제</button>
        <button id="animation-delete" type="button" disabled>삭제</button>
        <label>보간 <select id="animation-interpolation" class="pde-input" aria-label="선택한 키프레임의 앞 구간 보간" disabled>
            <option value="" disabled>선택 없음</option><option value="linear">선형</option>
            <option value="step">단계</option><option value="smooth">부드럽게</option>
            ${animationEasings.map(value => `<option value="${value}">${value}</option>`).join('')}
            <option value="custom" disabled>사용자 지정 / 혼합</option>
        </select></label>
        <label id="animation-channel-label">채널 <select id="animation-channel" class="pde-input" aria-label="편집할 변형 채널과 축">
            ${(['translation', 'rotation', 'scale'] as const).flatMap((channel, index) => ['X', 'Y', 'Z'].map((axis, i) =>
                `<option value="${channel}:${i}">${['이동', '회전', '크기'][index]} ${axis}</option>`)).join('')}
            <option value="all:0" title="현재 오브젝트의 이동·회전·크기를 하나의 진행률 그래프로 조절">전체 변형</option>
        </select></label></div>
        <div class="animation-zoom" role="group" aria-label="타임라인 확대">
            <button id="animation-fit" type="button" title="모든 키프레임을 화면에 맞추기">전체 보기</button>
            <button id="animation-zoom-out" type="button" aria-label="타임라인 축소">−</button>
            <output id="animation-zoom-value" aria-label="확대 비율">100%</output>
            <button id="animation-zoom-in" type="button" aria-label="타임라인 확대">+</button>
        </div>
    </div>
    <div class="animation-key-values animation-tools" hidden><span>선택 키 값</span>
        ${['X', 'Y', 'Z'].map((axis, index) => `<label>${axis} <input class="pde-input" data-animation-axis="${index}" aria-label="키프레임 ${axis} 값 또는 수식" maxlength="1024"></label>`).join('')}
        <label><input id="animation-pre-enabled" type="checkbox">진입 값 분리</label>
        <span class="animation-pre-values" hidden>${['X', 'Y', 'Z'].map((axis, index) => `<label>${axis} 진입 <input class="pde-input" data-animation-pre="${index}" aria-label="키프레임 ${axis} 진입 값 또는 수식" maxlength="1024"></label>`).join('')}</span>
        <small>time: 초 · tick: 틱 · t: 구간 진행률 · value: 기본 값 · sin(2*pi*time)</small>
    </div>
    <div class="animation-scroll" tabindex="0" aria-label="애니메이션 타임라인"><div class="animation-ruler"><span>파츠 <small id="animation-selection-count">키 0개 선택</small></span><div role="slider" tabindex="0" aria-label="현재 시간" aria-valuemin="0"></div></div><div class="animation-rows"></div><p class="animation-empty" hidden>파츠를 선택한 뒤 키 추가로 시작하세요. 포즈를 바꾸면 현재 틱에 키가 기록됩니다.</p></div>`;
const header = document.createElement('div');
header.className = 'animation-header';
for (const child of [...panel.children]) if (!child.classList.contains('animation-scroll') && !child.classList.contains('animation-resizer')) header.append(child);
panel.insertBefore(header, panel.querySelector('.animation-scroll'));
document.body.append(panel);
const resizer = panel.querySelector<HTMLElement>('.animation-resizer')!;
const tickInput = panel.querySelector<HTMLInputElement>('#animation-tick')!;
const tickRateInput = panel.querySelector<HTMLInputElement>('#animation-rate')!;
const lastValidInputValues = new Map([[tickInput, tickInput.value], [tickRateInput, tickRateInput.value]]);
const ruler = panel.querySelector<HTMLElement>('[role=slider]')!;
const timelineScroll = panel.querySelector<HTMLElement>('.animation-scroll')!;
const rows = panel.querySelector<HTMLElement>('.animation-rows')!;
const deleteButton = panel.querySelector<HTMLButtonElement>('#animation-delete')!;
const addButton = panel.querySelector<HTMLButtonElement>('#animation-add')!;
const duplicateButton = panel.querySelector<HTMLButtonElement>('#animation-duplicate')!;
const interpolationSelect = panel.querySelector<HTMLSelectElement>('#animation-interpolation')!;
const startButton = panel.querySelector<HTMLButtonElement>('#animation-start')!;
const endButton = panel.querySelector<HTMLButtonElement>('#animation-end')!;
const loopButton = panel.querySelector<HTMLButtonElement>('#animation-loop')!;
const zoomValue = panel.querySelector<HTMLOutputElement>('#animation-zoom-value')!;
const selectionCount = panel.querySelector<HTMLElement>('#animation-selection-count')!;
const emptyMessage = panel.querySelector<HTMLElement>('.animation-empty')!;
const previousKeyButton = panel.querySelector<HTMLButtonElement>('#animation-previous-key')!;
const pauseButton = panel.querySelector<HTMLButtonElement>('#animation-pause')!;
const nextKeyButton = panel.querySelector<HTMLButtonElement>('#animation-next-key')!;
const graphButton = panel.querySelector<HTMLButtonElement>('#animation-graph-toggle')!;
const channelSelect = panel.querySelector<HTMLSelectElement>('#animation-channel')!;
channelSelect.value = 'all:0';
const channelLabel = panel.querySelector<HTMLElement>('#animation-channel-label')!;
let graphMode = false;
let selectedKeys = new Map<string, Set<number>>();
let copiedKeys: Array<{ id: string; key: AnimationKey }> = [];
let selectionIds = new Set<string>();
let selectionPrimary: PrimarySelection | null = null;
let pending = Promise.resolve();
let revision = 0;
let cancelScrub: (() => void) | undefined;
let playing = false;
let playbackFrame = 0;
let playbackStartedAt = 0;
let playbackStartTick = 0;
let playbackStartSeconds = 0;
let pixelsPerTick = 6;
let timelineEnd = 100;
let followPlayback = true;
let lastKeyTick = 0;
let zoomAnchor: { clientX: number; tick: number; scrollLeft: number } | undefined;
let timelineRows: Array<{ type: 'group' | 'object' | 'clip'; id: string; depth: number; clip?: AnimationClip; animated?: boolean; inheritedAnimation?: boolean }> = [];
let timelineTracks = new Map<string, AnimationTrack>();
const renderedRows = new Map<number, HTMLElement>();
const expandedGroupIds = new Set<string>();
let targetFilter: Set<string> | undefined;
let nameFilter = '';
const filterControls = document.createElement('details');
filterControls.className = 'animation-target-filter';
filterControls.innerHTML = `<summary>필터: 전체</summary><div class="animation-tools">
    <label>이름 <input type="search" class="pde-input" id="animation-name-filter" placeholder="그룹·오브젝트 이름" aria-label="그룹·오브젝트 이름 검색"></label>
    <label><input type="checkbox" id="animation-keyframes-only">키프레임이 있는 항목만</label>
    <button type="button" data-filter="replace">선택 항목만 표시</button>
    <button type="button" data-filter="add">선택 항목 추가</button>
    <button type="button" data-filter="reset">필터 해제</button>
    <span class="animation-filter-targets"></span></div>`;
header.append(filterControls);
const nameFilterInput = filterControls.querySelector<HTMLInputElement>('#animation-name-filter')!;
const keyframesOnlyInput = filterControls.querySelector<HTMLInputElement>('#animation-keyframes-only')!;
keyframesOnlyInput.addEventListener('change', () => {
    cancelScrub?.();
    timelineScroll.scrollTop = 0;
    syncAnimationPanel();
});
nameFilterInput.addEventListener('input', () => {
    cancelScrub?.();
    nameFilter = nameFilterInput.value.trim().toLocaleLowerCase();
    timelineScroll.scrollTop = 0;
    syncAnimationPanel();
});

function matchesTargetFilter(id: string): boolean {
    if (targetFilter && !targetFilter.has(id)) return false;
    const name = root.userData.groups?.get(id)?.name ?? getObjectLabel(root.userData, id) ?? root.userData.objectNames?.get(id) ?? id;
    return !nameFilter || name.toLocaleLowerCase().includes(nameFilter);
}

filterControls.addEventListener('click', event => {
    const action = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-filter]')?.dataset.filter;
    if (!action) return;
    cancelScrub?.();
    if (action === 'reset') { targetFilter = undefined; nameFilter = ''; nameFilterInput.value = ''; keyframesOnlyInput.checked = false; }
    else {
        if (action === 'replace' || !targetFilter) targetFilter = new Set();
        for (const id of selectionIds) if (root.userData.groups?.has(id) || root.userData.objectUuidToInstance?.has(id)) targetFilter.add(id);
    }
    timelineScroll.scrollTop = 0;
    syncAnimationPanel();
});

function syncTargetFilter(): void {
    const targets = filterControls.querySelector<HTMLElement>('.animation-filter-targets')!;
    targets.replaceChildren();
    for (const id of targetFilter ?? []) {
        if (!root.userData.groups?.has(id) && !root.userData.objectUuidToInstance?.has(id)) { targetFilter!.delete(id); continue; }
        const remove = document.createElement('button');
        remove.type = 'button';
        const name = root.userData.groups?.get(id)?.name ?? getObjectLabel(root.userData, id) ?? root.userData.objectNames?.get(id) ?? id;
        remove.textContent = `${name} ×`;
        remove.title = `${name}: 필터에서 제거`;
        remove.setAttribute('aria-label', remove.title);
        remove.onclick = () => { cancelScrub?.(); targetFilter?.delete(id); syncAnimationPanel(); };
        targets.append(remove);
    }
    filterControls.querySelector('summary')!.textContent = (targetFilter ? `필터: ${targetFilter.size}개` : '필터: 전체')
        + (nameFilter ? ` · 이름: ${nameFilterInput.value.trim()}` : '')
        + (keyframesOnlyInput.checked ? ' · 키프레임 있음' : '');
    for (const button of filterControls.querySelectorAll<HTMLButtonElement>('[data-filter]')) {
        button.disabled = button.dataset.filter === 'reset' ? !targetFilter && !nameFilter && !keyframesOnlyInput.checked : selectionIds.size === 0;
    }
}
const keyValues = panel.querySelector<HTMLElement>('.animation-key-values')!;
const clipControls = initAnimationClipControls(() => selectionIds, action => editAnimation(action), id => {
    const wasPlaying = playing;
    void enqueue(async () => {
        if (!await settle()) return;
        const project = root.userData.animation;
        const clip = [project, ...(project.clips ?? [])].find(entry => (entry.id ?? 'default') === id);
        selectAnimationClip(root, id, wasPlaying ? clip?.transitionTicks ?? 0 : 0);
        selectedKeys.clear();
        playbackStartTick = 0; playbackStartSeconds = 0; playbackStartedAt = performance.now();
        playing = wasPlaying; syncPlaybackButton(); changed();
        if (playing) playbackFrame = requestAnimationFrame(advancePlayback);
    });
});
header.insertBefore(clipControls.element, header.querySelector('.animation-tools'));

function editChannel(): GraphChannel { return channelSelect.value.split(':')[0] as GraphChannel; }
function visibleKeys(track: AnimationTrack): AnimationKey[] { return channelKeys(track.keys, editChannel()); }

function setPanelHeight(height: number): void {
    const maximum = Math.max(120, window.innerHeight - document.getElementById('menu-bar')!.offsetHeight - 120);
    const next = Math.max(120, Math.min(maximum, height));
    document.body.style.setProperty('--animation-panel-height', `${next}px`);
    resizer.setAttribute('aria-valuemax', String(maximum));
    resizer.setAttribute('aria-valuenow', String(next));
}
window.addEventListener('resize', () => {
    setPanelHeight(parseFloat(document.body.style.getPropertyValue('--animation-panel-height')) || 360);
    syncAnimationPanel();
});
setPanelHeight(360);
resizer.addEventListener('pointerdown', event => {
    if (event.button !== 0 || !event.isPrimary) return;
    event.preventDefault(); resizer.focus();
    const startY = event.clientY, startHeight = panel.offsetHeight;
    resizer.setPointerCapture(event.pointerId);
    document.body.classList.add('resizing-details');
    const move = (moveEvent: PointerEvent) => {
        if (moveEvent.pointerId !== event.pointerId) return;
        setPanelHeight(startHeight + startY - moveEvent.clientY);
        window.dispatchEvent(new Event('resize'));
    };
    const stop = () => {
        document.body.classList.remove('resizing-details');
        resizer.removeEventListener('pointermove', move);
        resizer.removeEventListener('lostpointercapture', stop);
    };
    resizer.addEventListener('pointermove', move);
    resizer.addEventListener('lostpointercapture', stop);
});
resizer.addEventListener('keydown', event => {
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    setPanelHeight(event.key === 'Home' ? 120 : event.key === 'End' ? window.innerHeight
        : panel.offsetHeight + (event.key === 'ArrowUp' ? 10 : -10));
    window.dispatchEvent(new Event('resize'));
});

function syncPlaybackButton(): void {
    pauseButton.textContent = playing ? '\uE12E' : '\uE13C';
    pauseButton.title = playing ? '일시정지' : '재생';
    pauseButton.setAttribute('aria-label', pauseButton.title);
    pauseButton.setAttribute('aria-pressed', String(playing));
}

function pausePlayback(): void {
    playing = false;
    cancelAnimationFrame(playbackFrame);
    playbackFrame = 0;
    syncPlaybackButton();
}

function advancePlayback(now: number): void {
    playbackFrame = 0;
    const session = animationSession(root);
    if (!playing || !session.enabled) { pausePlayback(); return; }
    // A frame timestamp can precede a playback restart within that same frame.
    now = Math.max(now, playbackStartedAt);
    const rate = animationData(root)!.tickRate ?? ticksPerSecond;
    const tick = playbackTick(now, rate);
    try {
        const previousTick = session.tick;
        const finished = previewAnimationPlayback(root, tick, playbackStartSeconds + (now - playbackStartedAt) / 1000);
        if (session.tick !== previousTick) animationTimeChanged();
        else notifyAnimationPreview(false);
        if (finished) { pausePlayback(); return; }
    } catch (error) { pausePlayback(); report(error); return; }
    playbackFrame = requestAnimationFrame(advancePlayback);
}

function playbackTick(now: number, rate: number): number {
    const tick = playbackStartTick + (now - playbackStartedAt) * rate / 1000;
    return tick;
}

async function settle(): Promise<boolean> {
    pausePlayback();
    const current = revision;
    const activeElement = document.activeElement;
    if (activeElement instanceof HTMLElement && (activeElement.matches('input, textarea, select') || activeElement.isContentEditable)) activeElement.blur();
    window.dispatchEvent(new Event('pde:finish-transform'));
    await flushProjectEdits(flushAnimationEdits);
    return current === revision;
}
function report(error: unknown): void { window.alert(error instanceof Error ? error.message : String(error)); }
async function flushAnimationEdits(): Promise<void> {
    let current: Promise<void>;
    do { current = pending; await current; } while (current !== pending);
    startProjectEdit(flushAnimationEdits);
}
function enqueue(action: () => void | Promise<void>): Promise<void> {
    const current = revision;
    pending = pending.then(() => { if (current === revision) return action(); }).catch(report);
    queueProjectEdit(flushAnimationEdits);
    const operation = pending;
    void operation.then(() => { if (operation === pending) startProjectEdit(flushAnimationEdits); });
    return pending;
}

function adjacentKeyTick(direction: -1 | 1): number | undefined {
    const tick = animationSession(root).tick;
    let target: number | undefined;
    const visit = (keyTick: number) => {
        if ((keyTick - tick) * direction <= 0) return;
        if (target === undefined || Math.abs(keyTick - tick) < Math.abs(target - tick)) target = keyTick;
    };
    const primary = animationData(root);
    for (const track of primary?.tracks ?? []) for (const key of visibleKeys(track)) visit(key.tick);
    if (primary && !graphMode) for (const clip of animationLayers(root.userData.animation)) {
        for (const start of primary.layerTimings?.find(timing => timing.id === (clip.id ?? 'default'))?.starts ?? []) visit(start);
    }
    return target;
}

function renderTimelineRuler(): void {
    ruler.replaceChildren();
    const magnitude = 10 ** Math.floor(Math.log10(60 / pixelsPerTick));
    const step = Math.max(1, [1, 2, 5, 10].find(value => value * magnitude * pixelsPerTick >= 60)! * magnitude);
    timelineScroll.style.setProperty('--animation-grid-step', `${step * pixelsPerTick}px`);
    const first = Math.max(0, Math.floor(timelineScroll.scrollLeft / pixelsPerTick / step) * step);
    const last = Math.min(timelineEnd, (timelineScroll.scrollLeft + timelineScroll.clientWidth) / pixelsPerTick + step);
    for (let tick = first; tick <= last; tick += step) {
        const label = document.createElement('span');
        label.textContent = String(tick); label.style.left = `${tick * pixelsPerTick}px`;
        ruler.append(label);
    }
    const playhead = document.createElement('div');
    playhead.className = 'animation-playhead';
    ruler.append(playhead);
    if (lastKeyTick > 0) {
        const end = document.createElement('div');
        end.className = 'animation-end-marker';
        end.style.left = `${lastKeyTick * pixelsPerTick}px`;
        end.title = `재생 종료 · ${lastKeyTick}틱`;
        ruler.append(end);
    }
}

function revealCurrentTick(): void {
    const position = animationSession(root).tick * pixelsPerTick;
    const width = Math.max(1, timelineScroll.clientWidth - 238);
    if (position < timelineScroll.scrollLeft || position > timelineScroll.scrollLeft + width) {
        timelineScroll.scrollLeft = Math.max(0, position - width / 4);
    }
}

function setSelectedKeys(keys: Iterable<{ id: string; tick: number }>): boolean {
    const next = new Map<string, Set<number>>();
    for (const { id, tick } of keys) {
        if (!next.has(id)) next.set(id, new Set());
        next.get(id)!.add(tick);
    }
    if (next.size === selectedKeys.size && [...next].every(([id, ticks]) => ticks.size === selectedKeys.get(id)?.size
        && [...ticks].every(tick => selectedKeys.get(id)!.has(tick)))) return false;
    selectedKeys = next;
    return true;
}

function selectedKeyEntries() {
    return (animationData(root)?.tracks ?? []).flatMap(track => track.keys
        .filter(key => selectedKeys.get(track.id)?.has(key.tick) && (editChannel() === 'all' || keyHasChannel(key, editChannel() as AnimationChannel))).map(key => ({ track, key, tick: key.tick })));
}

function selectKeyParts(anchorMode: 'default' | 'center' = 'default'): void {
    const groups = new Set<string>(), objects = new Map();
    const parts = new Set<string>();
    for (const track of animationData(root)?.tracks ?? []) {
        if (!selectedKeys.has(track.id)) continue;
        if (track.type === 'group') groups.add(track.id);
        else {
            const ref = root.userData.objectUuidToInstance?.get(track.id);
            if (!ref) continue;
            if (!objects.has(ref.mesh)) objects.set(ref.mesh, new Set());
            objects.get(ref.mesh).add(ref.instanceId);
        }
        parts.add(track.id);
    }
    if (anchorMode === 'default' && parts.size === selectionIds.size && [...parts].every(id => selectionIds.has(id))) return;
    const primary = selectionPrimary;
    const keepPrimary = primary?.type === 'group' ? groups.has(primary.id)
        : primary?.type === 'object' && objects.get(primary.mesh)?.has(primary.instanceId);
    const firstId = selectedKeys.keys().next().value;
    const ref = root.userData.objectUuidToInstance?.get(firstId);
    const explicitPrimary: PrimarySelection | null = anchorMode === 'center' ? null : keepPrimary ? primary
        : groups.has(firstId) ? { type: 'group', id: firstId }
            : ref ? { type: 'object', mesh: ref.mesh, instanceId: ref.instanceId } : null;
    root.userData.replaceSelectionWithGroupsAndObjects?.(groups, objects, { anchorMode, explicitPrimary });
}

function selectKey(id: string, tick: number, additive: boolean, preserve = false): void {
    const selected = selectedKeys.get(id)?.has(tick);
    if (preserve && !additive && selected) return;
    if (!additive && (!preserve || !selected)) selectedKeys.clear();
    if (!selectedKeys.has(id)) selectedKeys.set(id, new Set());
    if (additive && selected) selectedKeys.get(id)!.delete(tick);
    else selectedKeys.get(id)!.add(tick);
    if (!selectedKeys.get(id)!.size) selectedKeys.delete(id);
    selectKeyParts();
}

function captureTimelineDrag(event: PointerEvent) {
    event.preventDefault();
    cancelScrub?.();
    const drag = { clientX: event.clientX, clientY: event.clientY, released: false, canceled: false,
        rollback: undefined as (() => void) | undefined };
    let cleaned = false;
    const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        drag.released = true;
        window.removeEventListener('pointermove', move, true);
        window.removeEventListener('pointerup', up, true);
        window.removeEventListener('pointercancel', cancelPointer, true);
        window.removeEventListener('keydown', escape, true);
        timelineScroll.removeEventListener('lostpointercapture', cancelPointer);
        if (timelineScroll.hasPointerCapture(event.pointerId)) timelineScroll.releasePointerCapture(event.pointerId);
        if (cancelScrub === cancel) cancelScrub = undefined;
    };
    const cancel = () => { drag.canceled = true; cleanup(); drag.rollback?.(); };
    const cancelPointer = (next: PointerEvent) => { if (next.pointerId === event.pointerId) cancel(); };
    const move = (next: PointerEvent) => {
        if (next.pointerId !== event.pointerId) return;
        drag.clientX = next.clientX; drag.clientY = next.clientY;
    };
    const up = (next: PointerEvent) => {
        if (next.pointerId !== event.pointerId) return;
        move(next); cleanup();
    };
    const escape = (next: KeyboardEvent) => {
        if (next.key !== 'Escape') return;
        next.preventDefault(); next.stopPropagation(); cancel();
    };
    cancelScrub = cancel;
    // Capture on the scroll container because selecting or moving a key replaces the rows.
    timelineScroll.setPointerCapture(event.pointerId);
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', cancelPointer, true);
    window.addEventListener('keydown', escape, true);
    timelineScroll.addEventListener('lostpointercapture', cancelPointer);
    return Object.assign(drag, { cleanup });
}

function beginKeyDrag(event: PointerEvent, id: string, tick: number): void {
    if (event.button !== 0 || !event.isPrimary || matchesPointerShortcut(event, 'boxSelect')) return;
    const startX = event.clientX, startScroll = timelineScroll.scrollLeft;
    const additive = matchesPointerShortcut(event, 'multiSelect');
    const drag = captureTimelineDrag(event);
    void enqueue(async () => {
        try {
            if (drag.canceled || !await settle() || drag.canceled) return;
            const data = animationData(root);
            if (!data?.tracks.some(track => track.id === id && track.keys.some(key => key.tick === tick)) || !animationSession(root).enabled) return;
            selectKey(id, tick, additive, true);
            if (!selectedKeys.get(id)?.has(tick)) { syncAnimationPanel(); panel.focus(); return; }
            previewAnimation(root, tick); changed(false); panel.focus();
            const entries = selectedKeyEntries();
            const tracks = new Set(entries.map(entry => entry.track));
            const originals = new Map([...tracks].map(track => [track, structuredClone(track.keys)]));
            const minimum = entries.reduce((minimum, entry) => Math.min(minimum, entry.tick), tick);
            const selectionBefore = structuredClone(selectedKeys);
            const before = captureAnimationSnapshot(root)!;
            drag.rollback = () => {
                if (animationData(root) !== data) return;
                restoreAnimationSnapshot(root, before);
                selectedKeys = selectionBefore; previewAnimation(root, tick); changed(false);
            };
            let delta = 0;
            while (!drag.canceled && animationData(root) === data && animationSession(root).enabled) {
                const next = Math.max(-minimum, Math.round((drag.clientX - startX + timelineScroll.scrollLeft - startScroll) / pixelsPerTick));
                if (next !== delta && entries.every(entry => Number.isSafeInteger(entry.tick + next)
                    && !originals.get(entry.track)!.some(other => other.tick === entry.tick + next
                        && !entries.some(moving => moving.track === entry.track && moving.tick === other.tick)
                        && (editChannel() === 'all' || keyHasChannel(other, editChannel() as AnimationChannel))))) {
                    delta = next;
                    if (editChannel() === 'all') {
                        for (const entry of entries) entry.key.tick = entry.tick + delta;
                        for (const track of tracks) track.keys.sort((a, b) => a.tick - b.tick);
                    } else {
                        for (const track of tracks) {
                            track.keys = structuredClone(originals.get(track)!);
                            removeKeyChannels(track, new Set(entries.filter(entry => entry.track === track).map(entry => entry.tick)), editChannel());
                        }
                        for (const entry of entries) mergeAnimationKey(entry.track, { ...copyKeyChannels(entry.key, editChannel()), tick: entry.tick + delta });
                    }
                    setSelectedKeys(entries.map(entry => ({ id: entry.track.id, tick: entry.tick + delta })));
                    previewAnimation(root, tick + delta); changed(false);
                }
                if (drag.released) break;
                await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
            }
            if (!drag.canceled && animationData(root) === data && delta !== 0) {
                const after = captureAnimationSnapshot(root)!;
                recordStateChange({ before, after, apply: state => restoreAnimationSnapshot(root, state), refresh: () => { refreshHistory(root); changed(); } });
            }
        } catch (error) { drag.rollback?.(); throw error; }
        finally { drag.cleanup(); }
    });
}

function recordKeyEdit(before: NonNullable<ReturnType<typeof captureAnimationSnapshot>>): void {
    previewAnimation(root);
    const after = captureAnimationSnapshot(root)!;
    recordStateChange({ before, after, apply: state => restoreAnimationSnapshot(root, state), refresh: () => { refreshHistory(root); changed(); } });
    changed(false);
}

function editAnimation(action: () => void): void {
    cancelScrub?.();
    void enqueue(async () => {
        if (!await settle() || !animationSession(root).enabled) return;
        const before = captureAnimationSnapshot(root)!;
        try { action(); recordKeyEdit(before); }
        catch (error) { restoreAnimationSnapshot(root, before); changed(); throw error; }
    });
}

function syncKeyValues(): void {
    const channel = editChannel(), entries = selectedKeyEntries();
    keyValues.hidden = channel === 'all' || !entries.length;
    if (channel === 'all' || !entries.length) return;
    const preEnabled = keyValues.querySelector<HTMLInputElement>('#animation-pre-enabled')!;
    preEnabled.checked = entries.every(({ key }) => !!key.pre?.[channel]);
    keyValues.querySelector<HTMLElement>('.animation-pre-values')!.hidden = !preEnabled.checked;
    for (const input of keyValues.querySelectorAll<HTMLInputElement>('[data-animation-axis], [data-animation-pre]')) {
        if (document.activeElement === input) continue;
        const pre = input.dataset.animationPre !== undefined, axis = Number(input.dataset.animationPre ?? input.dataset.animationAxis);
        const values = entries.map(({ key }) => String((pre ? key.pre?.[channel] : key.values?.[channel])?.[axis]
            ?? key.values?.[channel]?.[axis] ?? keyChannelValues(key, channel, key.tick, animationData(root)?.tickRate)[axis]));
        input.value = values.every(value => value === values[0]) ? values[0] : '';
        input.placeholder = input.value ? '' : '여러 값';
        input.title = channel === 'rotation' ? '회전 각도(도). 360·720 등 회전수 또는 시간 기반 수식을 입력합니다.' : '숫자 또는 시간 기반 수식';
    }
}

for (const input of keyValues.querySelectorAll<HTMLInputElement>('[data-animation-axis], [data-animation-pre]')) {
    input.onchange = () => {
        const source = input.value.trim(), pre = input.dataset.animationPre !== undefined;
        const axis = Number(input.dataset.animationPre ?? input.dataset.animationAxis);
        editAnimation(() => {
            const channel = editChannel();
            if (channel === 'all' || !source) throw new Error('키 값을 입력해 주세요.');
            const value = Number.isFinite(Number(source)) ? Number(source) : source;
            for (const { key } of selectedKeyEntries()) {
                const fallback = keyChannelValues(key, channel, key.tick, animationData(root)?.tickRate);
                if (typeof value === 'string') animationExpression(value, key.tick, animationData(root)?.tickRate, 0, fallback[axis]);
                if (typeof value === 'number' && !Number.isFinite(Math.fround(value))) throw new Error('키 값이 너무 큽니다.');
                const field = pre ? 'pre' : 'values';
                const vector = key[field]?.[channel] ?? [...(key.values?.[channel] ?? fallback)] as AnimationVector;
                vector[axis] = value;
                (key[field] ??= {})[channel] = vector;
            }
        });
    };
    input.onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); input.blur(); } };
}
keyValues.querySelector<HTMLInputElement>('#animation-pre-enabled')!.onchange = event => {
    const enabled = (event.target as HTMLInputElement).checked;
    editAnimation(() => {
        const channel = editChannel();
        if (channel === 'all') return;
        for (const { key } of selectedKeyEntries()) {
            if (enabled) (key.pre ??= {})[channel] = [...(key.values?.[channel] ?? keyChannelValues(key, channel, key.tick, animationData(root)?.tickRate))] as AnimationVector;
            else if (key.pre) delete key.pre[channel];
        }
    });
};

async function connectSelectedKeys(connected: boolean): Promise<void> {
    if (!await settle()) return;
    const entries = selectedKeyEntries().map(entry => ({ ...entry,
        key: graphMode && visibleKeys(entry.track).indexOf(entry.key) === 0 ? visibleKeys(entry.track)[1] : entry.key }))
        .filter(({ track, key }) => key && visibleKeys(track).indexOf(key) > 0
        && (connected ? keyCurve(key, editChannel()) === 'step' : keyCurve(key, editChannel()) !== 'step'));
    if (!entries.length) return;
    const before = captureAnimationSnapshot(root)!;
    for (const { key } of entries) {
        setKeyCurve(key, editChannel(), connected ? undefined : 'step');
    }
    recordKeyEdit(before); panel.focus();
}

function handleCurve(key: AnimationKey, handle: 0 | 2, x: number, y: number): AnimationCurve {
    const original = keyCurve(key, editChannel());
    const curve: [number, number, number, number] = Array.isArray(original) ? [...original] : [1 / 3, 1 / 3, 2 / 3, 2 / 3];
    curve[handle] = Math.max(handle === 0 ? 0 : curve[0], Math.min(handle === 0 ? curve[2] : 1, x));
    curve[handle + 1] = y;
    return curve;
}

function beginCurveDrag(event: PointerEvent, id: string, tick: number, handle: 0 | 2, layout: GraphLayout, diamondTick?: number): void {
    if (event.button !== 0 || !event.isPrimary || matchesPointerShortcut(event, 'boxSelect')) return;
    event.stopPropagation();
    const startX = event.clientX, startY = event.clientY, startScroll = timelineScroll.scrollLeft;
    const drag = captureTimelineDrag(event);
    void enqueue(async () => {
        try {
            if (drag.canceled || !await settle() || drag.canceled) return;
            const data = animationData(root), track = data?.tracks.find(track => track.id === id);
            const keys = track && visibleKeys(track);
            const index = keys?.findIndex(key => key.tick === tick) ?? -1;
            if (!track || index < 0 || !animationSession(root).enabled) return;
            const selectedTick = diamondTick ?? tick;
            selectKey(id, selectedTick, diamondTick !== undefined && matchesPointerShortcut(event, 'multiSelect'), true);
            if (diamondTick !== undefined) previewAnimation(root, diamondTick);
            changed(false); panel.focus();
            if (index < 1 || !selectedKeys.get(id)?.has(selectedTick)) return;
            const key = keys[index], previous = keys[index - 1];
            const interpolation = keyCurve(key, editChannel());
            if (interpolation === 'step') return;
            const original = JSON.stringify(interpolation);
            const curve = Array.isArray(interpolation) ? interpolation : [1 / 3, 1 / 3, 2 / 3, 2 / 3];
            const before = captureAnimationSnapshot(root)!;
            const width = (key.tick - previous.tick) * pixelsPerTick;
            const height = layout.y(layout.value(key)) - layout.y(layout.value(previous));
            drag.rollback = () => { if (animationData(root) === data) { restoreAnimationSnapshot(root, before); previewAnimation(root); changed(false); } };
            let lastX = 0, lastY = 0, dragging = diamondTick === undefined;
            while (!drag.canceled && animationData(root) === data && animationSession(root).enabled) {
                const dx = drag.clientX - startX + timelineScroll.scrollLeft - startScroll, dy = drag.clientY - startY;
                if (Math.hypot(dx, dy) >= 3) dragging = true;
                if (dragging && (dx !== lastX || dy !== lastY)) {
                    lastX = dx; lastY = dy;
                    setKeyCurve(key, editChannel(), handleCurve(key, handle, curve[handle] + dx / width, curve[handle + 1] + dy / (Math.abs(height) > 1e-6 ? height : -120)));
                    if (dx === 0 && dy === 0 && original === undefined) setKeyCurve(key, editChannel(), undefined);
                    previewAnimation(root); changed(false);
                }
                if (drag.released) break;
                await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
            }
            if (!drag.canceled && animationData(root) === data && JSON.stringify(keyCurve(key, editChannel())) !== original) recordKeyEdit(before);
            panel.focus();
        } catch (error) { drag.rollback?.(); throw error; }
        finally { drag.cleanup(); }
    });
}

function editCurveHandle(id: string, tick: number, handle: 0 | 2, dx: number, dy: number, diamondTick?: number): void {
    void enqueue(async () => {
        if (!await settle()) return;
        const track = animationData(root)?.tracks.find(track => track.id === id);
        const keys = track && visibleKeys(track);
        const index = keys?.findIndex(key => key.tick === tick) ?? -1;
        if (!track || index < 1) return;
        const key = keys[index], interpolation = keyCurve(key, editChannel());
        if (interpolation === 'step') return;
        const curve = Array.isArray(interpolation) ? interpolation : [1 / 3, 1 / 3, 2 / 3, 2 / 3];
        const next = handleCurve(key, handle, curve[handle] + dx, curve[handle + 1] + dy);
        if (JSON.stringify(next) === JSON.stringify(interpolation)) return;
        selectKey(id, diamondTick ?? tick, false, true);
        const before = captureAnimationSnapshot(root)!;
        setKeyCurve(key, editChannel(), next);
        recordKeyEdit(before);
        const selector = diamondTick === undefined ? `.animation-curve-handle[data-tick="${tick}"][data-handle="${handle}"]`
            : `.animation-key[data-tick="${diamondTick}"]`;
        rows.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"] ${selector}`)?.focus();
    });
}

function beginKeyBoxSelection(event: PointerEvent): void {
    if (event.button !== 0 || !event.isPrimary || !matchesPointerShortcut(event, 'boxSelect')
        || (event.target as HTMLElement).closest('.animation-ruler, .animation-part')) return;
    const rect = timelineScroll.getBoundingClientRect();
    if (event.clientX < rect.left + 220 || event.clientX >= rect.left + timelineScroll.clientWidth
        || event.clientY >= rect.top + timelineScroll.clientHeight) return;
    const startX = event.clientX + timelineScroll.scrollLeft, startY = event.clientY + timelineScroll.scrollTop;
    const additive = matchesPointerShortcut(event, 'multiSelect');
    const drag = captureTimelineDrag(event);
    const box = document.createElement('div'); box.className = 'animation-selection-box';
    void enqueue(async () => {
        try {
            if (drag.canceled || !await settle() || drag.canceled) return;
            const data = animationData(root), before = structuredClone(selectedKeys);
            const previous = additive ? selectedKeyEntries().map(entry => ({ id: entry.track.id, tick: entry.tick })) : [];
            drag.rollback = () => {
                if (animationData(root) !== data) return;
                selectedKeys = before; selectKeyParts(); syncAnimationPanel();
            };
            panel.append(box); panel.focus();
            while (!drag.canceled && animationData(root) === data && animationSession(root).enabled) {
                const bounds = timelineScroll.getBoundingClientRect();
                const viewportTop = ruler.getBoundingClientRect().bottom;
                const viewportBottom = bounds.top + timelineScroll.clientHeight;
                const edge = Math.min(48, (viewportBottom - viewportTop) / 3);
                if (!drag.released && Math.hypot(drag.clientX - event.clientX, drag.clientY - event.clientY) >= 4
                    && drag.clientX >= bounds.left + 220 && drag.clientX < bounds.left + timelineScroll.clientWidth) {
                    timelineScroll.scrollTop += drag.clientY < viewportTop + edge
                        ? -Math.min(12, Math.ceil((viewportTop + edge - drag.clientY) / 4))
                        : drag.clientY > viewportBottom - edge ? Math.min(12, Math.ceil((drag.clientY - viewportBottom + edge) / 4)) : 0;
                }
                const left = Math.min(startX - timelineScroll.scrollLeft, drag.clientX);
                const right = Math.max(startX - timelineScroll.scrollLeft, drag.clientX);
                const top = Math.min(startY - timelineScroll.scrollTop, drag.clientY);
                const bottom = Math.max(startY - timelineScroll.scrollTop, drag.clientY);
                const visibleLeft = Math.max(bounds.left + 220, left), visibleTop = Math.max(viewportTop, top);
                Object.assign(box.style, { left: `${visibleLeft}px`, top: `${visibleTop}px`,
                    width: `${Math.max(0, Math.min(bounds.left + timelineScroll.clientWidth, right) - visibleLeft)}px`,
                    height: `${Math.max(0, Math.min(viewportBottom, bottom) - visibleTop)}px` });
                const keys = [...previous];
                const rowTop = rows.getBoundingClientRect().top, height = graphMode ? 160 : 28;
                const laneLeft = ruler.getBoundingClientRect().left + ruler.clientLeft;
                // Virtual rows outside the viewport still belong to the selection rectangle.
                const radius = 10 / Math.SQRT2;
                const first = Math.max(0, Math.floor((top - rowTop - radius) / height));
                const last = Math.min(timelineRows.length - 1, Math.floor((bottom - rowTop + radius) / height));
                const [channel, axis] = channelSelect.value.split(':');
                for (let index = first; index <= last; index++) {
                    const id = timelineRows[index].id, track = timelineTracks.get(id);
                    if (!track) continue;
                    const graph = graphMode ? animationGraphLayout(track, channel as GraphChannel, Number(axis), data?.tickRate) : undefined;
                    for (const key of visibleKeys(track)) {
                        const x = laneLeft + key.tick * pixelsPerTick;
                        const y = rowTop + index * height + (graph ? graph.y(graph.value(key)) : 14);
                        if (x - radius <= right && x + radius >= left && y - radius <= bottom && y + radius >= top) {
                            keys.push({ id, tick: key.tick });
                        }
                    }
                }
                if (setSelectedKeys(keys)) { selectKeyParts('center'); syncAnimationPanel(); }
                if (drag.released) break;
                await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
            }
        } catch (error) { drag.rollback?.(); throw error; }
        finally { box.remove(); drag.cleanup(); }
    });
}

export function syncAnimationPanel(): void {
    const session = animationSession(root), data = animationData(root);
    const visibilityChanged = panel.hidden === session.enabled;
    panel.hidden = !session.enabled;
    document.body.classList.toggle('animation-active', session.enabled);
    button?.setAttribute('aria-pressed', String(session.enabled));
    if (visibilityChanged) window.dispatchEvent(new Event('resize'));
    if (!session.enabled) return;
    graphButton.setAttribute('aria-pressed', String(graphMode));
    channelLabel.hidden = false;
    channelLabel.title = `다이아몬드·선·원형 핸들: 키프레임 좌표와 틱을 유지하며 중간 변화 조절 · ${getShortcuts('ungroup').join(' / ')}: 앞 구간 끊기 · ${getShortcuts('group').join(' / ')}: 앞 구간 연결`;
    graphButton.title = '키프레임 / 그래프 보기 전환';
    duplicateButton.title = `선택한 키 복제 (${getShortcuts('duplicate').join(' / ')})`;
    deleteButton.title = `선택한 키 삭제 (${getShortcuts('deleteSelection').join(' / ')})`;
    syncAnimationTime();
    const tracks = new Map(data!.tracks.map(track => [track.id, track]));
    syncTargetFilter();
    renderAnimationRows(tracks);
    clipControls.sync();
    syncKeyValues();
}

function syncAnimationTime(): void {
    const session = animationSession(root), data = animationData(root);
    lastKeyTick = data ? animationTimelineEnd(root.userData.animation, data) : 0;
    previousKeyButton.disabled = adjacentKeyTick(-1) === undefined;
    nextKeyButton.disabled = adjacentKeyTick(1) === undefined;
    startButton.disabled = session.tick === 0;
    endButton.disabled = session.tick === lastKeyTick;
    loopButton.disabled = lastKeyTick === 0;
    loopButton.setAttribute('aria-pressed', String(data?.loopMode === 'loop'));
    zoomValue.value = `${Math.round(pixelsPerTick / 6 * 100)}%`;
    timelineEnd = Math.max(timelineEnd, lastKeyTick, session.tick + Math.max(100, timelineScroll.clientWidth / pixelsPerTick));
    for (const track of data!.tracks) timelineEnd = Math.max(timelineEnd, track.keys[track.keys.length - 1]?.tick ?? 0);
    timelineEnd = Math.ceil(timelineEnd / 100) * 100;
    timelineScroll.style.setProperty('--animation-timeline-width', `${timelineEnd * pixelsPerTick + 18}px`);
    if (document.activeElement !== tickInput) {
        tickInput.value = String(session.tick);
        lastValidInputValues.set(tickInput, tickInput.value);
    }
    if (document.activeElement !== tickRateInput) {
        tickRateInput.value = String(data!.tickRate ?? ticksPerSecond);
        lastValidInputValues.set(tickRateInput, tickRateInput.value);
    }
    ruler.setAttribute('aria-valuemax', String(timelineEnd)); ruler.setAttribute('aria-valuenow', String(session.tick));
    ruler.setAttribute('aria-valuetext', `${session.tick}틱 · ${(session.tick / (data!.tickRate ?? ticksPerSecond)).toFixed(2)}초`);
    panel.style.setProperty('--animation-playhead-left', `${session.tick * pixelsPerTick}px`);
    renderTimelineRuler();
}

function renderAnimationRows(tracks: Map<string, AnimationTrack>): void {
    const refs = root.userData.objectUuidToInstance ?? new Map();
    const groups = root.userData.groups ?? new Map();
    const filtering = !!targetFilter || !!nameFilter || keyframesOnlyInput.checked;
    setSelectedKeys(selectedKeyEntries().filter(entry => matchesTargetFilter(entry.track.id))
        .map(entry => ({ id: entry.track.id, tick: entry.tick })));
    const visited = new Set<string>();
    const matchingRows = new Set<string>();
    timelineRows = [];
    if (!graphMode && !filtering) for (const clip of animationLayers(root.userData.animation)) {
        timelineRows.push({ type: 'clip', id: `clip:${clip.id ?? 'default'}`, depth: 0, clip });
    }
    const visit = (type: 'group' | 'object', id: string, depth: number, visible = true, inheritedAnimation = false): boolean => {
        if (!id || visited.has(id) || !(type === 'group' ? groups : refs).has(id)) return false;
        visited.add(id);
        const row = { type, id, depth, animated: !!tracks.get(id)?.keys.length, inheritedAnimation };
        if (filtering && matchesTargetFilter(id) && (!keyframesOnlyInput.checked || row.animated)) matchingRows.add(id);
        if (visible) timelineRows.push(row);
        let animated = row.animated;
        if (type === 'group') for (const child of groups.get(id).children ?? []) {
            const childId = child.id ?? root.userData.instanceKeyToObjectUuid?.get(`${child.mesh?.uuid}_${child.instanceId}`);
            const childAnimated = visit(child.type, childId, depth + 1,
                visible && expandedGroupIds.has(id), inheritedAnimation || row.animated);
            animated ||= childAnimated;
            if (matchingRows.has(childId)) matchingRows.add(id);
        }
        row.animated = animated;
        return animated;
    };
    for (const entry of root.userData.sceneOrder ?? []) visit(entry.type, entry.id, 0);
    for (const [id, group] of groups) if (!group.parent) visit('group', id, 0);
    for (const id of refs.keys()) visit('object', id, 0);
    timelineRows = timelineRows.filter(row => filtering ? matchingRows.has(row.id) : row.type === 'clip' || row.animated || row.inheritedAnimation);
    timelineTracks = filtering ? new Map([...tracks].filter(([id]) => matchesTargetFilter(id))) : tracks;
    renderedRows.clear(); rows.replaceChildren();
    rows.style.height = `${timelineRows.length * (graphMode ? 160 : 28)}px`;
    renderVisibleAnimationRows();
    deleteButton.disabled = !selectedKeys.size;
    duplicateButton.disabled = !selectedKeys.size;
    addButton.disabled = ![...selectionIds].some(id => refs.has(id) || groups.has(id));
    const entries = selectedKeyEntries();
    selectionCount.textContent = `키 ${entries.length}개 선택`;
    const curves = new Set(entries.filter(({ track, key }) => visibleKeys(track).indexOf(key) > 0).map(({ key }) => {
        const curve = keyCurve(key, editChannel());
        return curve === undefined ? 'linear' : typeof curve === 'string' ? curve
            : JSON.stringify(curve) === '[0.42,0,0.58,1]' ? 'smooth' : 'custom';
    }));
    interpolationSelect.disabled = curves.size === 0;
    interpolationSelect.value = curves.size === 0 ? '' : curves.size === 1 ? [...curves][0] : 'custom';
    emptyMessage.hidden = timelineRows.length > 0;
}

function renderVisibleAnimationRows(): void {
    if (panel.hidden) return;
    const height = graphMode ? 160 : 28;
    const first = Math.max(0, Math.floor((timelineScroll.scrollTop - 28) / height) - 8);
    const last = Math.min(timelineRows.length - 1, Math.ceil((timelineScroll.scrollTop + timelineScroll.clientHeight) / height) + 8);
    for (const [index, row] of renderedRows) {
        if (index >= first && index <= last || row.contains(document.activeElement)) continue;
        row.remove(); renderedRows.delete(index);
    }
    const groups = root.userData.groups ?? new Map();
    for (let index = first; index <= last; index++) {
        if (renderedRows.has(index)) continue;
        const { type, id, depth, clip, animated } = timelineRows[index];
        if (type === 'clip') {
            const row = renderAnimationLayerRow(clip!, pixelsPerTick, editAnimation, seekTick);
            row.dataset.id = id; row.style.top = `${index * height}px`;
            const next = [...renderedRows].filter(([other]) => other > index).sort(([a], [b]) => a - b)[0]?.[1];
            rows.insertBefore(row, next ?? null); renderedRows.set(index, row);
            continue;
        }
        const row = document.createElement('div');
        row.className = 'animation-row'; row.dataset.id = id;
        row.style.top = `${index * height}px`;
        row.classList.toggle('animation-graph-row', graphMode);
        row.classList.toggle('selected', selectionIds.has(id));
        const part = document.createElement('div'); part.className = 'animation-part-cell';
        part.style.paddingLeft = `${10 + depth * 16}px`;
        const label = document.createElement('button'); label.type = 'button';
        label.className = 'animation-part';
        label.textContent = type === 'group' ? groups.get(id).name : getObjectLabel(root.userData, id) ?? root.userData.objectNames?.get(id) ?? id;
        label.title = label.textContent;
        label.onclick = event => {
            selectedKeys.clear();
            selectPart(type, id, matchesPointerShortcut(event, 'multiSelect') || matchesPointerShortcut(event, 'boxSelect'));
            syncAnimationPanel(); panel.focus();
        };
        if (type === 'group') {
            const expanded = expandedGroupIds.has(id);
            const toggle = document.createElement('button'); toggle.type = 'button';
            toggle.className = 'animation-group-toggle scene-toggle';
            toggle.textContent = expanded ? '\uE06D' : '\uE06F';
            toggle.setAttribute('aria-expanded', String(expanded));
            toggle.title = `${label.textContent} ${expanded ? '접기' : '펼치기'}`;
            toggle.setAttribute('aria-label', toggle.title);
            toggle.onpointerdown = event => event.stopPropagation();
            toggle.onclick = event => {
                event.stopPropagation(); cancelScrub?.();
                if (expandedGroupIds.has(id)) expandedGroupIds.delete(id); else expandedGroupIds.add(id);
                syncAnimationPanel();
                rows.querySelector<HTMLButtonElement>(`[data-id="${CSS.escape(id)}"] .animation-group-toggle`)?.focus();
            };
            part.append(toggle);
        }
        part.append(label);
        const visibility = document.createElement('button');
        visibility.type = 'button';
        visibility.className = 'animation-visibility lucide-icon';
        const enabled = isSceneItemEnabled(root, type, id);
        visibility.textContent = enabled ? '\uE0BA' : '\uE0BB';
        visibility.title = `${label.textContent}: ${enabled ? '숨기기' : '보이기'}`;
        visibility.setAttribute('aria-label', visibility.title);
        visibility.setAttribute('aria-pressed', String(enabled));
        visibility.onpointerdown = event => event.stopPropagation();
        visibility.onclick = event => {
            event.stopPropagation();
            void enqueue(async () => {
                if (!await settle()) return;
                const next = !isSceneItemEnabled(root, type, id);
                const apply = (value: boolean) => setSceneItemEnabled(root, type, id, value);
                apply(next);
                record({ undo: () => apply(!next), redo: () => apply(next) });
                rows.querySelector<HTMLButtonElement>(`[data-id="${CSS.escape(id)}"] .animation-visibility`)?.focus();
            });
        };
        part.append(visibility);
        if (type === 'group' && animated) {
            part.classList.add('has-animation');
            const indicator = document.createElement('span');
            indicator.className = 'animation-group-indicator';
            indicator.title = '애니메이션 있음'; indicator.setAttribute('aria-label', indicator.title);
            indicator.textContent = '◆';
            part.append(indicator);
        }
        const lane = document.createElement('div'); lane.className = 'animation-lane';
        const track = timelineTracks.get(id);
        const [channel, axis] = channelSelect.value.split(':');
        const graph = graphMode ? animationGraphLayout(track, channel as GraphChannel, Number(axis), animationData(root)?.tickRate) : undefined;
        if (graph && track) renderAnimationGraph(lane, track, pixelsPerTick, graph, selectedKeys.get(id),
            (event, key, handle) => beginCurveDrag(event, id, key.tick, handle, graph),
            (key, handle, dx, dy) => editCurveHandle(id, key.tick, handle, dx, dy));
        const keys = track ? visibleKeys(track) : [];
        for (const [index, key] of keys.entries()) {
            const interpolation = keyCurve(key, editChannel());
            const marker = document.createElement('button'); marker.type = 'button'; marker.className = 'animation-key';
            marker.dataset.tick = String(key.tick); marker.style.left = `${key.tick * pixelsPerTick}px`;
            marker.classList.toggle('disconnected', interpolation === 'step');
            marker.classList.toggle('curved', Array.isArray(interpolation));
            marker.title = `${key.tick}틱 · ${(key.tick / (animationData(root)!.tickRate ?? ticksPerSecond)).toFixed(2)}초 · ${interpolation === 'step' ? '단계' : interpolation ? '곡선' : '선형'} 보간 · 드래그하여 이동`;
            if (graph) {
                const value = graph.value(key);
                marker.style.top = `${graph.y(value)}px`;
                const curveKey = keys[index === 0 ? 1 : index] ?? key;
                const handle = index === 0 ? 0 : 2;
                const previous = keys[Math.max(0, index - 1)];
                const direction = graph.y(graph.value(curveKey)) > graph.y(graph.value(previous)) ? -1 : 1;
                marker.title = `${key.tick}틱 · ${Number(value.toFixed(4))}${graph.channel === 'all' ? '%' : graph.channel === 'rotation' ? '°' : ''}${interpolation === 'step' ? ' · 앞 구간 끊김' : ''} · 드래그·위아래 방향키: 중간 변화 조절 (키프레임 좌표·틱 고정)`;
                marker.onpointerdown = event => beginCurveDrag(event, id, curveKey.tick, handle, graph, key.tick);
                marker.onkeydown = event => {
                    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
                    event.preventDefault(); event.stopPropagation();
                    editCurveHandle(id, curveKey.tick, handle, 0, (event.key === 'ArrowUp' ? .05 : -.05) * direction, key.tick);
                };
            }
            marker.setAttribute('aria-label', `${label.textContent} ${key.tick}틱 키프레임${graph ? ` · ${channelSelect.selectedOptions[0].textContent} ${Number(graph.value(key).toFixed(4))}${graph.channel === 'all' ? '%' : ''}` : ''}`);
            marker.classList.toggle('selected', selectedKeys.get(id)?.has(key.tick) ?? false);
            marker.setAttribute('aria-pressed', String(marker.classList.contains('selected')));
            if (!graph) marker.onpointerdown = event => beginKeyDrag(event, id, key.tick);
            marker.onclick = event => {
                if (event.detail !== 0) return;
                const additive = matchesPointerShortcut(event, 'multiSelect');
                void enqueue(async () => {
                    if (!await settle()) return;
                    selectKey(id, key.tick, additive);
                    previewAnimation(root, key.tick); changed(); panel.focus();
                });
            };
            lane.append(marker);
        }
        const line = document.createElement('div'); line.className = 'animation-playhead';
        lane.append(line);
        row.append(part, lane);
        const next = [...renderedRows].filter(([other]) => other > index).sort(([a], [b]) => a - b)[0]?.[1];
        rows.insertBefore(row, next ?? null);
        renderedRows.set(index, row);
    }
}
function selectPart(type: string, id: string, additive = false): void {
    const ref = root.userData.objectUuidToInstance?.get(id);
    const groups = new Set(type === 'group' ? [id] : []);
    const objects = new Map(type === 'object' && ref ? [[ref.mesh, new Set([ref.instanceId])]] : []);
    if (additive) root.userData.addOrToggleInSelection?.(groups, objects);
    else root.userData.replaceSelectionWithGroupsAndObjects?.(groups, objects, { anchorMode: 'default', primaryIsRangeStart: true });
}
function changed(reveal = true): void {
    syncAnimationPanel();
    notifyAnimationPreview(reveal);
}
function animationTimeChanged(reveal = true): void {
    syncAnimationTime();
    notifyAnimationPreview(reveal);
}
function notifyAnimationPreview(reveal: boolean): void {
    if (reveal && (!playing || followPlayback)) revealCurrentTick();
    window.dispatchEvent(new CustomEvent('pde:animation-preview'));
}
export async function toggleAnimation(): Promise<void> {
    if (!await settle()) return;
    const enabled = !animationSession(root).enabled;
    setAnimationEnabled(root, enabled); changed(); window.dispatchEvent(new Event('resize'));
}
button?.addEventListener('click', () => void enqueue(toggleAnimation));
graphButton.onclick = () => {
    cancelScrub?.(); graphMode = !graphMode;
    syncAnimationPanel(); panel.focus();
};
channelSelect.onchange = () => { cancelScrub?.(); syncAnimationPanel(); };
window.addEventListener('pde:shortcuts-changed', syncAnimationPanel);
function seekTick(tick: number): void {
    cancelScrub?.();
    void enqueue(async () => {
        if (!await settle()) return;
        previewAnimation(root, tick); changed(); panel.focus();
    });
}
startButton.onclick = () => seekTick(0);
endButton.onclick = () => seekTick(lastKeyTick);
loopButton.onclick = () => {
    const before = captureAnimationSnapshot(root)!;
    const clip = animationData(root)!;
    const elapsed = animationSession(root).playbackTick ?? animationSession(root).tick;
    const timed = animationLayers(root.userData.animation).some(layer => clip.layerTimings?.some(timing => timing.id === (layer.id ?? 'default')));
    const tick = timed ? elapsed : animationPlayback(clip, elapsed).tick;
    clip.loopMode = clip.loopMode === 'loop' ? 'hold' : 'loop';
    const after = captureAnimationSnapshot(root)!;
    recordStateChange({ before, after, apply: state => restoreAnimationSnapshot(root, state), refresh: () => { refreshHistory(root); changed(); } });
    playbackStartTick = tick;
    playbackStartSeconds = animationSession(root).playbackSeconds ?? playbackStartTick / (clip.tickRate ?? 20);
    animationSession(root).playbackTick = playbackStartTick;
    playbackStartedAt = performance.now();
    syncAnimationPanel();
};
addButton.onclick = () => {
    cancelScrub?.();
    void enqueue(async () => {
        if (!await settle() || !animationSession(root).enabled) return;
        const targets = [...selectionIds].filter(id => animationSession(root).local.has(id));
        if (!targets.length) return;
        const before = captureAnimationSnapshot(root)!;
        try {
            recordAnimationTransform(root, before, targets, editChannel() === 'all' ? animationChannels : [editChannel() as AnimationChannel]);
            setSelectedKeys(targets.map(id => ({ id, tick: animationSession(root).tick })));
            recordKeyEdit(before); panel.focus();
        } catch (error) { restoreAnimationSnapshot(root, before); changed(); throw error; }
    });
};
duplicateButton.onclick = () => { cancelScrub?.(); void enqueue(duplicateKeys); };
interpolationSelect.onchange = () => {
    const value = interpolationSelect.value;
    if (!['linear', 'step', 'smooth', ...animationEasings].includes(value)) return;
    cancelScrub?.();
    void enqueue(async () => {
        if (!await settle()) return;
        const entries = selectedKeyEntries().filter(({ track, key }) => visibleKeys(track).indexOf(key) > 0);
        if (!entries.length) return;
        const before = captureAnimationSnapshot(root)!;
        for (const { key } of entries) {
            setKeyCurve(key, editChannel(), value === 'linear' ? undefined : value === 'smooth' ? [.42, 0, .58, 1] : value as AnimationCurve);
        }
        recordKeyEdit(before); panel.focus();
    });
};
function clampTimelineZoom(value: number): number {
    const fit = Math.max(1, timelineScroll.clientWidth - 258) / Math.max(20, lastKeyTick);
    return Math.max(Math.min(.05, fit), Math.min(80, value));
}
function setTimelineZoom(value: number, tick = animationSession(root).tick): void {
    cancelScrub?.(); zoomAnchor = undefined; followPlayback = false;
    const offset = tick * pixelsPerTick - timelineScroll.scrollLeft;
    pixelsPerTick = clampTimelineZoom(value);
    syncAnimationPanel();
    timelineScroll.scrollLeft = Math.max(0, tick * pixelsPerTick - Math.max(0, Math.min(timelineScroll.clientWidth - 238, offset)));
    renderTimelineRuler();
}
panel.querySelector<HTMLButtonElement>('#animation-zoom-in')!.onclick = () => setTimelineZoom(pixelsPerTick * 1.25);
panel.querySelector<HTMLButtonElement>('#animation-zoom-out')!.onclick = () => setTimelineZoom(pixelsPerTick / 1.25);
panel.querySelector<HTMLButtonElement>('#animation-fit')!.onclick = () => {
    setTimelineZoom(Math.max(1, timelineScroll.clientWidth - 258) / Math.max(20, lastKeyTick), 0);
    timelineScroll.scrollLeft = 0;
};
for (const [skipButton, direction] of [[previousKeyButton, -1], [nextKeyButton, 1]] as const) {
    skipButton.onclick = () => {
        cancelScrub?.();
        void enqueue(async () => {
            if (!await settle()) return;
            const tick = adjacentKeyTick(direction);
            if (tick === undefined) return;
            selectedKeys.clear();
            previewAnimation(root, tick); changed(); panel.focus();
        });
    };
}
pauseButton.onclick = () => {
    cancelScrub?.();
    void enqueue(async () => {
        if (playing) { pausePlayback(); panel.focus(); return; }
        if (!await settle()) return;
        const session = animationSession(root);
        if (!session.enabled) return;
        const clip = animationData(root)!;
        const layered = animationLayers(root.userData.animation).length > 0;
        const restart = session.playbackFinished || !session.transition && !layered && clip.loopMode !== 'loop' && session.tick >= animationEndTick(clip);
        playbackStartTick = restart ? 0 : session.playbackTick ?? session.tick;
        playbackStartSeconds = restart ? 0 : session.playbackSeconds ?? session.tick / (clip.tickRate ?? 20);
        playbackStartedAt = performance.now();
        playing = true;
        followPlayback = true;
        revealCurrentTick();
        syncPlaybackButton();
        playbackFrame = requestAnimationFrame(advancePlayback);
        panel.focus();
    });
};
tickInput.onchange = () => { const value = tickInput.valueAsNumber; if (Number.isFinite(value)) void enqueue(async () => { if (!await settle()) return; previewAnimation(root, value); animationTimeChanged(); }); };
tickRateInput.onchange = () => {
    const value = tickRateInput.valueAsNumber;
    void enqueue(() => {
        const data = animationData(root)!;
        if (!data || !animationSession(root).enabled) return;
        if (!Number.isFinite(value) || value < 1 || value > 10000) {
            tickRateInput.value = String(data.tickRate ?? ticksPerSecond);
            report('틱 속도는 1~10000틱/초여야 합니다.'); return;
        }
        if ((data.tickRate ?? ticksPerSecond) === value) return;
        const before = captureAnimationSnapshot(root)!;
        if (playing) {
            const now = performance.now();
            playbackStartTick += (now - playbackStartedAt) * (data.tickRate ?? ticksPerSecond) / 1000;
            playbackStartSeconds += (now - playbackStartedAt) / 1000;
            playbackStartedAt = now;
            previewAnimationPlayback(root, playbackStartTick, playbackStartSeconds);
        }
        data.tickRate = value;
        const after = captureAnimationSnapshot(root)!;
        recordStateChange({ before, after, apply: state => restoreAnimationSnapshot(root, state), refresh: () => { refreshHistory(root); changed(); } });
        changed();
    });
};
for (const input of [tickInput, tickRateInput]) {
    const validate = (): boolean => {
        const value = input.valueAsNumber;
        if (/^\d+(?:\.\d*)?$/.test(input.value) && Number.isFinite(value) && value >= Number(input.min)
            && (input === tickInput ? Number.isSafeInteger(Math.round(value)) : value <= Number(input.max))) {
            lastValidInputValues.set(input, input.value);
            return true;
        }
        input.value = lastValidInputValues.get(input)!;
        return false;
    };
    input.addEventListener('beforeinput', event => {
        if (event.data && /[^0-9.]/.test(event.data)) event.preventDefault();
    });
    input.addEventListener('input', validate);
    input.addEventListener('blur', validate);
    input.addEventListener('change', event => {
        if (!validate()) event.stopImmediatePropagation();
    }, true);
}
deleteButton.onclick = () => void enqueue(async () => {
    if (!await settle()) return;
    if (!selectedKeys.size) return;
    const before = captureAnimationSnapshot(root)!;
    const data = animationData(root)!;
    for (const track of data.tracks) removeKeyChannels(track, selectedKeys.get(track.id) ?? new Set(), editChannel());
    data.tracks = data.tracks.filter(track => track.keys.length);
    selectedKeys.clear(); previewAnimation(root);
    const after = captureAnimationSnapshot(root)!;
    recordStateChange({ before, after, apply: state => restoreAnimationSnapshot(root, state), refresh: () => { refreshHistory(root); changed(); } });
    changed(); panel.focus();
});

async function duplicateKeys(): Promise<void> {
    if (!await settle()) return;
    const entries = selectedKeyEntries();
    if (!entries.length) return;
    const first = entries.reduce((tick, entry) => Math.min(tick, entry.tick), Infinity);
    let offset = entries.reduce((tick, entry) => Math.max(tick, entry.tick), 0) - first + 1;
    while (entries.some(entry => entry.track.keys.some(key => key.tick === entry.tick + offset && (editChannel() === 'all' || keyHasChannel(key, editChannel() as AnimationChannel))))) offset++;
    if (entries.some(entry => !Number.isSafeInteger(entry.tick + offset))) throw new Error('키프레임을 복제할 수 있는 시간 범위를 초과했습니다.');
    const before = captureAnimationSnapshot(root)!;
    for (const entry of entries) mergeAnimationKey(entry.track, { ...copyKeyChannels(entry.key, editChannel()), tick: entry.tick + offset });
    setSelectedKeys(entries.map(entry => ({ id: entry.track.id, tick: entry.tick + offset })));
    previewAnimation(root, first + offset);
    const after = captureAnimationSnapshot(root)!;
    recordStateChange({ before, after, apply: state => restoreAnimationSnapshot(root, state), refresh: () => { refreshHistory(root); changed(); } });
    changed(); panel.focus();
}

async function copyKeys(): Promise<void> {
    if (!await settle()) return;
    copiedKeys = selectedKeyEntries().map(({ track, key }) => ({ id: track.id, key: copyKeyChannels(key, editChannel()) }));
}

async function pasteKeys(): Promise<void> {
    if (!await settle() || !copiedKeys.length || !animationSession(root).enabled) return;
    const data = animationData(root)!;
    const first = copiedKeys.reduce((tick, entry) => Math.min(tick, entry.key.tick), Infinity);
    const target = new Set(copiedKeys.map(entry => entry.id)).size === 1 && selectionIds.size === 1 ? [...selectionIds][0] : undefined;
    const entries = copiedKeys.map(entry => ({ ...entry, id: target ?? entry.id,
        key: { ...structuredClone(entry.key), tick: animationSession(root).tick + (entry.key.tick - first) } }))
        .filter(entry => (root.userData.groups?.has(entry.id) || root.userData.objectUuidToInstance?.has(entry.id)));
    if (!entries.length) return;
    if (entries.some(entry => !Number.isSafeInteger(entry.key.tick))) throw new Error('키프레임을 붙여넣을 수 있는 시간 범위를 초과했습니다.');
    const before = captureAnimationSnapshot(root)!;
    try {
        for (const entry of entries) {
            let track = data.tracks.find(track => track.id === entry.id);
            if (!track) data.tracks.push(track = { type: root.userData.groups?.has(entry.id) ? 'group' : 'object', id: entry.id, keys: [] });
            const missing = (entry.key.channels ?? animationChannels).filter(channel => !track.keys.some(key => keyHasChannel(key, channel)));
            const node = animationSession(root).local.get(entry.id);
            if (entry.key.tick > 0 && missing.length && node) {
                mergeAnimationKey(track, { tick: 0, transform: keyTransform(new Matrix4().fromArray(node.matrix)), channels: missing });
            }
            mergeAnimationKey(track, entry.key);
        }
        setSelectedKeys(entries.map(entry => ({ id: entry.id, tick: entry.key.tick })));
        selectKeyParts(); recordKeyEdit(before); panel.focus();
    } catch (error) { restoreAnimationSnapshot(root, before); changed(); throw error; }
}

panel.addEventListener('keydown', event => {
    if (event.defaultPrevented || event.isComposing || (event.target as HTMLElement).closest('input, textarea, select, [contenteditable="true"]')
        || document.querySelector('dialog[open], .settings-overlay:not([hidden])')) return;
    if ((event.key === 'Home' || event.key === 'End') && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
        event.preventDefault(); event.stopPropagation();
        seekTick(event.key === 'Home' ? 0 : lastKeyTick);
    } else if (matchesShortcut(event, 'copySelection') || matchesShortcut(event, 'pasteSelection')) {
        event.preventDefault(); event.stopPropagation();
        cancelScrub?.();
        if (!event.repeat) void enqueue(matchesShortcut(event, 'copySelection') ? copyKeys : pasteKeys);
    } else if (matchesShortcut(event, 'selectAll')) {
        event.preventDefault(); event.stopPropagation();
        cancelScrub?.();
        if (!event.repeat) void enqueue(async () => {
            if (!await settle()) return;
            const keys = (animationData(root)?.tracks ?? []).filter(track => matchesTargetFilter(track.id))
                .flatMap(track => visibleKeys(track).map(key => ({ id: track.id, tick: key.tick })));
            const selection = getSelectAllSceneSelection(root);
            root.userData.replaceSelectionWithGroupsAndObjects?.(selection.groups, selection.objects, { anchorMode: selection.anchorMode });
            setSelectedKeys(keys);
            syncAnimationPanel(); panel.focus();
        });
    } else if (matchesShortcut(event, 'deleteSelection')) {
        event.preventDefault(); event.stopPropagation(); deleteButton.click();
    } else if (matchesShortcut(event, 'duplicate')) {
        event.preventDefault(); event.stopPropagation();
        if (!event.repeat) void enqueue(duplicateKeys);
    } else if (matchesShortcut(event, 'ungroup') || matchesShortcut(event, 'group')) {
        event.preventDefault(); event.stopPropagation();
        const connected = !matchesShortcut(event, 'ungroup');
        cancelScrub?.();
        if (!event.repeat) void enqueue(() => connectSelectedKeys(connected));
    }
});
ruler.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    const drag = captureTimelineDrag(event);
    void enqueue(async () => {
        try {
            if (!await settle()) return;
            do {
                if (drag.canceled) break;
                const bounds = timelineScroll.getBoundingClientRect();
                const left = bounds.left + 220, right = bounds.left + timelineScroll.clientWidth - 8;
                if (!drag.released && Math.abs(drag.clientX - event.clientX) >= 4) {
                    timelineScroll.scrollLeft += drag.clientX < left + 32 ? -Math.min(20, (left + 32 - drag.clientX) / 2)
                        : drag.clientX > right - 32 ? Math.min(20, (drag.clientX - right + 32) / 2) : 0;
                }
                const origin = ruler.getBoundingClientRect().left + ruler.clientLeft;
                const minimum = Math.max(0, Math.ceil((left - origin) / pixelsPerTick));
                const maximum = Math.max(minimum, Math.floor((right - origin) / pixelsPerTick));
                const tick = Math.max(minimum, Math.min(maximum, Math.round((drag.clientX - origin) / pixelsPerTick)));
                if (tick !== animationSession(root).tick) { previewAnimation(root, tick); animationTimeChanged(false); }
                if (!drag.released) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
            } while (!drag.released);
        } finally { drag.cleanup(); panel.focus(); }
    });
});
timelineScroll.addEventListener('scroll', () => { renderTimelineRuler(); renderVisibleAnimationRows(); });
timelineScroll.addEventListener('pointerdown', event => {
    followPlayback = false; zoomAnchor = undefined;
    if (event.button !== 0 || !event.isPrimary || matchesPointerShortcut(event, 'multiSelect') || matchesPointerShortcut(event, 'boxSelect')
        || (event.target as HTMLElement).closest('.animation-key, .animation-curve-handle, .animation-part-cell, .animation-ruler')) return;
    const bounds = timelineScroll.getBoundingClientRect();
    if (event.clientX >= bounds.left + timelineScroll.clientWidth || event.clientY >= bounds.top + timelineScroll.clientHeight) return;
    cancelScrub?.();
    void enqueue(() => { selectedKeys.clear(); selectKeyParts(); syncAnimationPanel(); panel.focus(); });
});
timelineScroll.addEventListener('pointerdown', beginKeyBoxSelection);
timelineScroll.addEventListener('wheel', event => {
    if (event.shiftKey && (event.deltaX || event.deltaY)) {
        event.preventDefault(); followPlayback = false; zoomAnchor = undefined;
        timelineScroll.scrollLeft += event.deltaX || event.deltaY;
        return;
    }
    if (!event.deltaY || event.clientX < timelineScroll.getBoundingClientRect().left + 220) return;
    event.preventDefault();
    cancelScrub?.();
    followPlayback = false;
    const scrollLeft = timelineScroll.scrollLeft;
    const offset = scrollLeft === 0 ? 0 : event.clientX - ruler.getBoundingClientRect().left - ruler.clientLeft;
    const anchor = offset - scrollLeft;
    // Pin tick zero at the start; elsewhere retain the anchor across native scroll rounding.
    if (scrollLeft === 0 || !zoomAnchor || zoomAnchor.clientX !== event.clientX || zoomAnchor.scrollLeft !== scrollLeft) {
        zoomAnchor = { clientX: event.clientX, tick: offset / pixelsPerTick, scrollLeft };
    }
    pixelsPerTick = clampTimelineZoom(pixelsPerTick * (event.deltaY < 0 ? 1.15 : 1 / 1.15));
    syncAnimationPanel();
    timelineScroll.scrollLeft = zoomAnchor.tick * pixelsPerTick - anchor;
    renderTimelineRuler();
    zoomAnchor.scrollLeft = timelineScroll.scrollLeft;
}, { passive: false });
window.addEventListener('pde:selection-changed', (event: CustomEvent) => {
    selectionIds = new Set(event.detail?.groups);
    selectionPrimary = event.detail?.primary ?? null;
    for (const [mesh, ids] of event.detail?.objects ?? []) for (const id of ids) {
        const uuid = root.userData.instanceKeyToObjectUuid?.get(`${mesh.uuid}_${id}`); if (uuid) selectionIds.add(uuid);
    }
    for (const id of selectedKeys.keys()) if (!selectionIds.has(id)) selectedKeys.delete(id);
    syncAnimationPanel();
});
window.addEventListener('keydown', event => {
    if (!animationSession(root).enabled || event.defaultPrevented) return;
    if (event.target === tickRateInput) return;
    const target = event.target as HTMLElement;
    if (target?.closest?.('#animation-panel button, #animation-panel summary') && (event.key === ' ' || event.key === 'Enter')) return;
    if (target?.closest?.('.animation-curve-handle') && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    if (!target?.closest?.('.animation-resizer') && handleExpandCollapseShortcut(event, expanded => {
        const groupIds = [...selectionIds].filter(id => root.userData.groups?.has(id));
        if (!groupIds.length) return false;
        cancelScrub?.();
        for (const id of groupIds) {
            if (expanded) expandedGroupIds.add(id);
            else expandedGroupIds.delete(id);
        }
        syncAnimationPanel();
        return true;
    })) return;
    if (event.isComposing || target?.closest?.('input, textarea, select') || target?.isContentEditable
        || document.querySelector('dialog[open], .settings-overlay:not([hidden])')) return;
    const tickDirection = matchesShortcut(event, 'animationPreviousTick') ? -1
        : matchesShortcut(event, 'animationNextTick') ? 1 : 0;
    const action = matchesShortcut(event, 'animationPlay') ? pauseButton
        : matchesShortcut(event, 'animationPreviousKey') ? previousKeyButton
        : matchesShortcut(event, 'animationNextKey') ? nextKeyButton : null;
    if (!action && !tickDirection) {
        if (!['Shift', 'Control', 'Alt', 'Meta'].includes(event.key) && !matchesShortcut(event, 'focusSelection')) pausePlayback();
        return;
    }
    event.preventDefault(); event.stopImmediatePropagation();
    if (tickDirection) {
        cancelScrub?.();
        void enqueue(async () => {
            if (!await settle()) return;
            selectedKeys.clear();
            previewAnimation(root, animationSession(root).tick + tickDirection); changed(); panel.focus();
        });
    } else if (!event.repeat || action !== pauseButton) action.click();
}, true);
window.addEventListener('pointerdown', event => {
    const target = event.target as HTMLElement;
    if (target?.closest?.('#main-content canvas') && !root.userData.headPainterActive) return;
    if (!target?.closest?.('.animation-transport, .animation-rate, #animation-clip')) pausePlayback();
}, true);
window.addEventListener('focusin', event => {
    const target = event.target as HTMLElement;
    if (target !== tickRateInput && target?.id !== 'animation-clip' && (target?.matches?.('input, textarea, select') || target?.isContentEditable)) pausePlayback();
});
window.addEventListener('blur', () => {
    pausePlayback();
    cancelScrub?.();
});
window.addEventListener('pde:transform-start', pausePlayback);
window.addEventListener('pde:before-history-change', () => { pausePlayback(); cancelScrub?.(); });
let resumeAnimationAfterLoad = false;
window.addEventListener('pde:scene-updated', event => {
    if ((event as CustomEvent<{ texturesOnly?: boolean }>).detail?.texturesOnly) return;
    if (resumeAnimationAfterLoad) {
        resumeAnimationAfterLoad = false;
        setAnimationEnabled(root, true);
    }
    pausePlayback(); syncAnimationTargets(root); syncAnimationPanel();
});
window.addEventListener('pde:animation-changed', syncAnimationPanel);
window.addEventListener('pde:scene-visibility-changed', syncAnimationPanel);
window.addEventListener('pde:animation-properties-updated', () => {
    if (panel.hidden) return;
    if (nameFilter) { syncAnimationPanel(); return; }
    for (const row of rows.children as HTMLCollectionOf<HTMLElement>) {
        const id = row.dataset.id!;
        const group = root.userData.groups?.get(id);
        const name = group ? group.name : getObjectLabel(root.userData, id) ?? root.userData.objectNames?.get(id) ?? id;
        const label = row.querySelector<HTMLElement>('.animation-part')!;
        if (label.textContent !== name) { label.textContent = name; label.title = name; }
    }
});
window.addEventListener('pde:history-restored', () => { if (animationSession(root).enabled) previewAnimation(root); changed(); });
window.addEventListener('pde:head-painter-enabling', () => {
    pausePlayback();
    revision++; cancelScrub?.();
});
window.addEventListener('pde:before-project-load', (event: CustomEvent<{ isMerge?: boolean }>) => {
    pausePlayback();
    revision++; cancelScrub?.();
    if (event.detail?.isMerge) return;
    targetFilter = undefined;
    nameFilter = ''; nameFilterInput.value = '';
    keyframesOnlyInput.checked = false;
    copiedKeys = [];
    expandedGroupIds.clear();
    timelineEnd = 100; pixelsPerTick = 6; timelineScroll.scrollLeft = 0; zoomAnchor = undefined;
    resumeAnimationAfterLoad ||= animationSession(root).enabled;
    if (animationSession(root).enabled) setAnimationEnabled(root, false);
    selectedKeys.clear(); selectionIds.clear(); selectionPrimary = null;
});
window.addEventListener('pde:active-project-changed', () => {
    targetFilter = undefined;
    nameFilter = ''; nameFilterInput.value = '';
    keyframesOnlyInput.checked = false;
    pausePlayback(); revision++; cancelScrub?.();
    copiedKeys = [];
    expandedGroupIds.clear();
    selectedKeys.clear(); selectionIds.clear(); selectionPrimary = null;
    timelineEnd = 100; pixelsPerTick = 6; timelineScroll.scrollLeft = 0; zoomAnchor = undefined;
    if (!resumeAnimationAfterLoad) syncAnimationPanel();
    queueMicrotask(() => {
        if (animationSession(root).enabled) { previewAnimation(root); changed(); }
    });
});
