import { loadedObjectGroup as root } from '../load-project/display/display-instancing';
import { animationData, animationProjectData, animationSession, createAnimationClip, deleteAnimationClip, moveAnimationClip, placeAnimationLayer } from '../animation/animation-state';
import { animationClips, animationEndTick, animationLayers, layerRanges, setLayerRanges, type AnimationLayerRange, type AnimationLayerTiming } from '../animation/animation-data';

export function initAnimationClipControls(selection: () => Set<string>, edit: (action: () => void) => void, select: (id: string) => void) {
    const element = document.createElement('div');
    element.className = 'animation-clip-controls';
    element.innerHTML = `<label>동작 <select id="animation-clip" class="pde-input" aria-label="애니메이션 클립"></select></label>
        <details class="animation-settings"><summary title="동작 이름·추가·복제·삭제 및 재생 설정">설정</summary><div class="animation-settings-body" tabindex="-1">
            <section class="animation-settings-section" aria-label="동작 관리"><strong>동작</strong>
            <label>이름 <input id="animation-clip-name" class="pde-input" aria-label="애니메이션 이름" maxlength="120" placeholder="애니메이션 이름"></label>
            <div id="animation-clip-list"></div>
            <p>이름을 누르면 그 동작으로 전환합니다. 체크한 동작을 복제·삭제하며, 체크가 없으면 현재 동작에 적용합니다.</p>
            <div class="animation-actions">
                <button type="button" id="animation-clip-add">새 동작</button>
                <button type="button" id="animation-clip-copy">동작 복제</button>
                <button type="button" id="animation-clip-delete">동작 삭제</button>
            </div>
            </section>
            <section class="animation-settings-section" aria-label="재생 설정"><strong>재생</strong>
            <label>종료 방식 <select id="animation-loop-mode" class="pde-input"><option value="once">한 번 재생 후 처음으로</option><option value="hold">마지막 자세 유지</option><option value="loop">반복</option></select></label>
            <label>종료 틱 <input id="animation-end-tick" class="pde-input" type="number" min="0" step="1" placeholder="마지막 키"></label>
            <label>반복 대기 틱 <input id="animation-loop-delay" class="pde-input" type="number" min="0" step="1" value="0"></label>
            <label>동작 전환 틱 <input id="animation-transition" class="pde-input" type="number" min="0" step="1" value="0"></label>
            <p>재생 중 다른 동작을 선택하면 현재 자세에서 전환합니다.</p>
            </section>
            <section class="animation-settings-section" aria-label="동작 적용 파츠"><strong>적용 파츠</strong>
            <div class="animation-actions"><button type="button" id="animation-mask-only">선택 파츠만 적용</button><button type="button" id="animation-mask-exclude">선택 파츠 제외</button><button type="button" id="animation-mask-all">전체 적용</button></div>
            <output id="animation-mask-count"></output>
            </section>
            <section class="animation-settings-section" aria-label="함께 재생할 동작">
            <strong>이 동작과 함께 재생</strong><div id="animation-layers"></div>
            <p>시점은 재생 시작부터 센 현재 동작의 틱입니다. 지정 시점에서는 각 배치를 한 번씩, 일정 간격에서는 반복 구간(예 0-100,200) 안에서 간격마다 재생하며, 그 밖에서는 원래 동작을 따릅니다. 타임라인의 동작 행을 두 번 클릭해도 배치할 수 있습니다.</p>
            <p>각 동작의 속도·반복 규칙으로 함께 재생합니다. 파츠가 겹치면 목록 아래쪽 동작이 우선합니다.</p>
            </section>
        </div></details>`;
    const picker = element.querySelector<HTMLSelectElement>('#animation-clip')!;
    const name = element.querySelector<HTMLInputElement>('#animation-clip-name')!;
    const layers = element.querySelector<HTMLElement>('#animation-layers')!;
    const settings = element.querySelector<HTMLDetailsElement>('.animation-settings')!;
    const closeSettings = () => { settings.open = false; };
    window.addEventListener('pde:camera-changed', closeSettings);
    window.addEventListener('blur', closeSettings);
    window.addEventListener('pointerdown', event => {
        if (!settings.contains(event.target as Node)) closeSettings();
    });
    window.addEventListener('focusin', event => {
        if (!settings.contains(event.target as Node)) closeSettings();
    });
    settings.addEventListener('keydown', event => {
        if (event.key !== 'Escape' || !settings.open) return;
        event.preventDefault(); event.stopPropagation(); settings.open = false;
        settings.querySelector('summary')!.focus();
    });
    const click = (id: string, action: () => void) => { element.querySelector<HTMLButtonElement>(id)!.onclick = () => edit(action); };
    picker.onchange = () => select(picker.value);
    const newName = (duplicate = false) => {
        const current = animationData(root)!.name ?? '기본', clips = animationClips(animationProjectData(root)!);
        if (name.value.trim() && name.value.trim() !== current) return name.value;
        const base = duplicate ? `${current.slice(0, 110)} 복사` : '새 동작';
        let value = base, index = 2;
        while (clips.some(clip => (clip.name ?? '기본') === value)) value = `${base} ${index++}`;
        return value;
    };
    // UI-only: which clips the copy/delete buttons act on.
    const checkedClips = new Set<string>();
    const targetClips = () => {
        const project = animationProjectData(root)!, current = animationData(root)!;
        const checked = animationClips(project).filter(clip => checkedClips.has(clip.id ?? 'default'));
        return checked.length ? checked : [current];
    };
    click('#animation-clip-add', () => { createAnimationClip(root, newName()); });
    click('#animation-clip-copy', () => {
        const sources = targetClips();
        if (sources.length === 1 && sources[0] === animationData(root)) { createAnimationClip(root, newName(true), true); return; }
        for (const source of sources) {
            const base = `${(source.name ?? '기본').slice(0, 110)} 복사`, clips = animationClips(animationProjectData(root)!);
            let value = base, index = 2;
            while (clips.some(clip => (clip.name ?? '기본') === value)) value = `${base} ${index++}`;
            createAnimationClip(root, value, source);
        }
        checkedClips.clear();
    });
    click('#animation-clip-delete', () => {
        for (const clip of targetClips()) deleteAnimationClip(root, clip.id ?? 'default');
        checkedClips.clear();
    });
    name.onblur = () => {
        const value = name.value.trim();
        if (value === (animationData(root)?.name ?? '기본')) return;
        edit(() => {
            const project = animationProjectData(root)!, current = animationData(root)!;
            if (!value || value.length > 120 || animationClips(project).some(clip => clip !== current && (clip.name ?? '기본') === value)) throw new Error('다른 동작과 겹치지 않는 1~120자 이름을 입력해 주세요.');
            current.name = value;
        });
    };
    name.onkeydown = event => {
        if (event.key === 'Enter' && !event.isComposing) {
            event.preventDefault(); name.blur(); element.closest<HTMLElement>('#animation-panel')?.focus();
        }
    };
    for (const [id, field] of [['#animation-loop-delay', 'loopDelay'], ['#animation-end-tick', 'endTick'], ['#animation-transition', 'transitionTicks']] as const) {
        const input = element.querySelector<HTMLInputElement>(id)!;
        input.onchange = () => edit(() => {
            const clip = animationData(root)!;
            if (field === 'endTick' && !input.value) { delete clip.endTick; return; }
            if (!input.value.trim() || !Number.isSafeInteger(input.valueAsNumber) || input.valueAsNumber < 0) throw new Error('0 이상의 정수 틱을 입력해 주세요.');
            clip[field] = input.valueAsNumber;
        });
    }
    const mode = element.querySelector<HTMLSelectElement>('#animation-loop-mode')!;
    mode.onchange = () => edit(() => { animationData(root)!.loopMode = mode.value as 'once' | 'hold' | 'loop'; });
    const selectedNodes = () => {
        const chosen = selection(), nodes = animationSession(root).local;
        const result = new Set(chosen);
        for (const [id, node] of nodes) {
            let parent = node.parent;
            const visited = new Set<string>();
            while (parent && !visited.has(parent)) {
                if (chosen.has(parent)) { result.add(id); break; }
                visited.add(parent); parent = nodes.get(parent)?.parent;
            }
        }
        return result;
    };
    click('#animation-mask-only', () => {
        const chosen = selectedNodes();
        if (!chosen.size) throw new Error('적용할 파츠를 먼저 선택해 주세요.');
        animationData(root)!.excludedNodes = [...animationSession(root).local.keys()].filter(id => !chosen.has(id));
    });
    click('#animation-mask-exclude', () => {
        const chosen = selectedNodes();
        if (!chosen.size) throw new Error('제외할 파츠를 먼저 선택해 주세요.');
        animationData(root)!.excludedNodes = [...new Set([...(animationData(root)!.excludedNodes ?? []), ...chosen])];
    });
    click('#animation-mask-all', () => { delete animationData(root)!.excludedNodes; });
    let signature = '', layerSignature = '', listSignature = '';
    const clipList = element.querySelector<HTMLElement>('#animation-clip-list')!;
    function sync(): void {
        const project = animationProjectData(root), current = animationData(root);
        if (!project || !current) return;
        const clips = animationClips(project), next = JSON.stringify(clips.map(clip => [clip.id, clip.name]));
        if (signature !== next) {
            signature = next;
            picker.replaceChildren(...clips.map(clip => new Option(clip.name ?? '기본', clip.id ?? 'default')));
        }
        picker.value = current.id ?? 'default';
        if (document.activeElement !== name) name.value = current.name ?? '기본';
        mode.value = current.loopMode ?? 'hold';
        for (const [id, value] of [['#animation-loop-delay', current.loopDelay ?? 0], ['#animation-end-tick', current.endTick ?? ''], ['#animation-transition', current.transitionTicks ?? 0]] as const) {
            const input = element.querySelector<HTMLInputElement>(id)!;
            if (document.activeElement !== input) input.value = String(value);
        }
        element.querySelector<HTMLInputElement>('#animation-end-tick')!.placeholder = `${animationEndTick(current)} (마지막 키)`;
        element.querySelector<HTMLButtonElement>('#animation-clip-delete')!.disabled = clips.length < 2;
        element.querySelector<HTMLOutputElement>('#animation-mask-count')!.value = `${current.excludedNodes?.length ?? 0}개 파츠 제외`;
        const ids = new Set(clips.map(clip => clip.id ?? 'default'));
        for (const id of checkedClips) if (!ids.has(id)) checkedClips.delete(id);
        const nextList = JSON.stringify([next, current.id, [...checkedClips]]);
        if (nextList !== listSignature) {
            listSignature = nextList;
            const focused = clipList.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.focusKey : undefined;
            clipList.replaceChildren(...clips.map((clip, index) => {
                const id = clip.id ?? 'default', label = clip.name ?? '기본', isCurrent = clip === current;
                const row = document.createElement('div'); row.className = 'animation-clip-row';
                row.innerHTML = `<input type="checkbox" data-focus-key="check"><button type="button" data-clip-select data-focus-key="select"></button>
                    <button type="button" data-clip-move="-1" data-focus-key="up">↑</button><button type="button" data-clip-move="1" data-focus-key="down">↓</button>
                    <button type="button" data-clip-remove data-focus-key="remove">삭제</button>`;
                const check = row.querySelector<HTMLInputElement>('input')!;
                check.checked = checkedClips.has(id); check.setAttribute('aria-label', `${label} 선택`);
                check.onchange = () => { if (check.checked) checkedClips.add(id); else checkedClips.delete(id); sync(); };
                const selectButton = row.querySelector<HTMLButtonElement>('[data-clip-select]')!;
                selectButton.textContent = isCurrent ? `${label} (현재)` : label;
                if (isCurrent) selectButton.setAttribute('aria-current', 'true');
                selectButton.onclick = () => { if (!isCurrent) select(id); };
                for (const button of row.querySelectorAll<HTMLButtonElement>('[data-clip-move]')) {
                    const offset = Number(button.dataset.clipMove), target = index + offset;
                    button.disabled = target < 0 || target >= clips.length;
                    button.setAttribute('aria-label', `${label} ${offset < 0 ? '위로' : '아래로'} 이동`);
                    button.onclick = () => edit(() => moveAnimationClip(root, id, offset));
                }
                const removeButton = row.querySelector<HTMLButtonElement>('[data-clip-remove]')!;
                removeButton.disabled = clips.length < 2; removeButton.setAttribute('aria-label', `${label} 삭제`);
                removeButton.onclick = () => edit(() => { deleteAnimationClip(root, id); checkedClips.delete(id); });
                row.querySelectorAll<HTMLElement>('[data-focus-key]').forEach(control => control.dataset.focusKey += `:${id}`);
                return row;
            }));
            if (focused) clipList.querySelector<HTMLElement>(`[data-focus-key="${CSS.escape(focused)}"]`)?.focus();
        }
        const count = checkedClips.size;
        element.querySelector('#animation-clip-copy')!.textContent = count ? `동작 복제 (${count})` : '동작 복제';
        element.querySelector('#animation-clip-delete')!.textContent = count ? `동작 삭제 (${count})` : '동작 삭제';
        const playingLayers = new Set(animationLayers(project, current));
        const nextLayers = JSON.stringify([current.id, clips.map(clip => [clip.id, clip.name]), [...playingLayers].map(clip => clip.id), current.layerTimings]);
        // Rebuilding under a focused input would drop what the user is typing.
        if (nextLayers === layerSignature && layers.contains(document.activeElement)) return;
        layerSignature = nextLayers;
        layers.replaceChildren(...clips.filter(clip => clip !== current).map(clip => {
            const id = clip.id ?? 'default', timing = current.layerTimings?.find(timing => timing.id === id);
            const row = document.createElement('div'); row.className = 'animation-layer-control'; row.dataset.clipId = id;
            row.innerHTML = `<label><input type="checkbox"><span></span></label>
                <div class="animation-layer-timing">
                    <label>재생 방식 <select class="pde-input" data-layer-mode><option value="clip">동작 설정대로</option><option value="at">지정 시점</option><option value="repeat">일정 간격</option></select></label>
                    <label data-layer-at>시점 (틱) <input class="pde-input" data-layer-starts placeholder="20,65,110"></label>
                    <label data-layer-repeat title="쉼표로 구분한 시작-끝 틱. 끝을 비우면 다음 구간 전까지(마지막은 계속) 반복">반복 구간 (틱) <input class="pde-input" data-layer-ranges placeholder="0-100,200"></label>
                    <label data-layer-repeat>반복 간격 (틱) <input class="pde-input" type="number" min="1" step="1" data-layer-interval></label>
                    <button type="button" data-layer-place>현재 틱에 배치</button>
                </div>`;
            const input = row.querySelector<HTMLInputElement>('input[type=checkbox]')!;
            input.checked = playingLayers.has(clip); input.dataset.clipId = id;
            row.querySelector('span')!.textContent = clip.name ?? '기본';
            const controls = row.querySelector<HTMLElement>('.animation-layer-timing')!; controls.hidden = !input.checked;
            const mode = row.querySelector<HTMLSelectElement>('[data-layer-mode]')!;
            mode.value = timing ? timing.interval === undefined ? 'at' : 'repeat' : 'clip';
            row.querySelector<HTMLElement>('[data-layer-at]')!.hidden = mode.value !== 'at';
            row.querySelectorAll<HTMLElement>('[data-layer-repeat]').forEach(label => label.hidden = mode.value !== 'repeat');
            row.querySelector<HTMLInputElement>('[data-layer-starts]')!.value = timing?.starts.join(',') ?? '';
            row.querySelector<HTMLInputElement>('[data-layer-ranges]')!.value = timing?.interval === undefined ? String(animationSession(root).tick)
                : layerRanges(timing).map(([start, end]) => end === undefined ? start : `${start}-${end}`).join(',');
            row.querySelector<HTMLInputElement>('[data-layer-interval]')!.value = String(timing?.interval ?? 20);
            controls.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input,select').forEach(input => input.setAttribute('aria-label', `${clip.name ?? '기본'} ${input.parentElement!.firstChild!.textContent!.trim()}`));
            const updateTiming = (change: (timing?: AnimationLayerTiming) => AnimationLayerTiming | undefined) => edit(() => {
                const current = animationData(root)!, next = change(current.layerTimings?.find(timing => timing.id === id));
                current.layerTimings = [...(current.layerTimings ?? []).filter(timing => timing.id !== id), ...(next ? [next] : [])];
            });
            mode.onchange = () => {
                const value = mode.value, tick = animationSession(root).tick;
                updateTiming(previous => value === 'clip' ? undefined : { id,
                    starts: value === 'repeat' ? [previous?.starts[0] ?? tick] : previous?.starts ?? [tick],
                    interval: value === 'repeat' ? previous?.interval ?? Math.max(1, Math.ceil((animationEndTick(clip) + 1 + (clip.loopDelay ?? 0))
                        * (current.tickRate ?? 20) / (clip.tickRate ?? 20))) : undefined });
            };
            row.querySelector<HTMLInputElement>('[data-layer-starts]')!.onchange = event => {
                const value = (event.target as HTMLInputElement).value.trim();
                updateTiming(() => {
                    const entries = value ? value.split(',').map(value => value.trim()) : [];
                    if (entries.some(value => !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)))) throw new Error('시점은 쉼표로 구분한 0 이상의 정수 틱을 입력해 주세요.');
                    return { id, starts: [...new Set(entries.map(Number))].sort((a, b) => a - b) };
                });
            };
            row.querySelector<HTMLInputElement>('[data-layer-ranges]')!.onchange = event => {
                const value = (event.target as HTMLInputElement).value.trim();
                updateTiming(previous => {
                    const matches = value.split(',').map(entry => /^(\d+)\s*(?:-\s*(\d+)?)?$/.exec(entry.trim()));
                    const ranges = matches.map(match => match && [Number(match[1]), match[2] === undefined ? undefined : Number(match[2])] as AnimationLayerRange);
                    if (!value || ranges.some(range => !range || !Number.isSafeInteger(range[0]) || range[1] !== undefined && (!Number.isSafeInteger(range[1]) || range[1] < range[0]))) {
                        throw new Error('반복 구간은 쉼표로 구분한 "시작-끝" 또는 "시작" 형식의 0 이상 정수 틱으로 입력해 주세요.');
                    }
                    const timing: AnimationLayerTiming = { id, starts: [], interval: previous?.interval ?? 20 };
                    setLayerRanges(timing, ranges as AnimationLayerRange[]);
                    return timing;
                });
            };
            row.querySelector<HTMLInputElement>('[data-layer-interval]')!.onchange = event => {
                const input = event.target as HTMLInputElement, value = input.valueAsNumber;
                updateTiming(previous => {
                    if (!input.value.trim() || !Number.isSafeInteger(value) || value < 1) throw new Error('간격은 1 이상의 정수 틱을 입력해 주세요.');
                    return { ...previous, id, starts: previous?.starts ?? [0], interval: value };
                });
            };
            row.querySelector<HTMLButtonElement>('[data-layer-place]')!.onclick = () => {
                const tick = animationSession(root).tick;
                edit(() => placeAnimationLayer(root, id, tick));
            };
            input.onchange = () => {
                const checked = input.checked;
                edit(() => {
                    const data = animationProjectData(root)!, current = animationData(root)!;
                    const values = new Set(animationLayers(data, current).map(clip => clip.id ?? 'default'));
                    if (checked) values.add(clip.id ?? 'default'); else values.delete(clip.id ?? 'default');
                    current.layers = [...values];
                });
            };
            return row;
        }));
    }
    return { element, sync };
}
