import { channelKeys, curveAmount, isDisplayReplacement, keyChannelValues, keyCurve, sampleChannelValues, type AnimationChannel, type AnimationKey, type AnimationTrack } from '../animation/animation-data';

export const graphHeight = 160;
export type GraphChannel = AnimationChannel | 'all';
export type GraphLayout = ReturnType<typeof animationGraphLayout>;

export function animationGraphLayout(track: AnimationTrack | undefined, channel: GraphChannel, axis: number, rate = 20) {
    const firstTick = track?.keys[0]?.tick ?? 0;
    const duration = (track?.keys[track.keys.length - 1]?.tick ?? firstTick) - firstTick || 1;
    const value = (key: AnimationKey) => channel === 'all' ? (key.tick - firstTick) / duration * 100 : keyChannelValues(key, channel, key.tick, rate)[axis];
    const entries = channelKeys(track?.keys ?? [], channel);
    const values = entries.flatMap((key, index) => {
        if (index === 0) return [value(key)];
        const previous = entries[index - 1];
        return Array.from({ length: 25 }, (_, sample) => channel === 'all'
            ? value(previous) + (value(key) - value(previous)) * curveAmount(keyCurve(key, channel), sample / 24)
            : sampleChannelValues(track!.keys, channel, previous.tick + (key.tick - previous.tick) * sample / 24, rate)[axis]);
    });
    const minimum = values.reduce((min, value) => Math.min(min, value), 0);
    const maximum = values.reduce((max, value) => Math.max(max, value), channel === 'all' ? 100 : 1);
    const unitsPerPixel = (maximum - minimum) / (graphHeight - 40);
    return { channel, axis, rate, minimum, maximum, unitsPerPixel, value, y: (value: number) => graphHeight - 20 - (value - minimum) / unitsPerPixel };
}

export function renderAnimationGraph(lane: HTMLElement, track: AnimationTrack, pixelsPerTick: number, layout: GraphLayout,
    selected: Set<number> | undefined, beginHandleDrag: (event: PointerEvent, key: AnimationKey, handle: 0 | 2) => void,
    editHandle: (key: AnimationKey, handle: 0 | 2, dx: number, dy: number) => void): void {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.classList.add('animation-graph'); svg.setAttribute('aria-hidden', 'true');
    const path = (d: string, className: string) => {
        const element = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        element.setAttribute('d', d); element.setAttribute('class', className); svg.append(element);
        return element;
    };
    svg.setAttribute('width', '100%'); svg.setAttribute('height', String(graphHeight));
    const y = (key: AnimationKey) => layout.y(layout.value(key));
    for (let i = 0; i <= 4; i++) {
        const top = 20 + i * (graphHeight - 40) / 4;
        const line = document.createElementNS(svg.namespaceURI, 'line');
        line.setAttribute('x2', '100%'); line.setAttribute('y1', String(top)); line.setAttribute('y2', String(top));
        line.setAttribute('class', 'animation-graph-grid'); svg.append(line);
    }
    const entries = channelKeys(track.keys, layout.channel);
    for (let index = 1; index < entries.length; index++) {
        const previous = entries[index - 1], key = entries[index];
        const x1 = previous.tick * pixelsPerTick, x2 = key.tick * pixelsPerTick;
        const y1 = y(previous), y2 = y(key);
        const interpolation = keyCurve(key, layout.channel);
        if (interpolation === 'step' || (layout.channel === 'rotation' || layout.channel === 'scale') && isDisplayReplacement(track.keys, track.keys.indexOf(key))) {
            path(`M${x1} ${y1} H${x2}`, 'animation-graph-hold');
            continue;
        }
        let d = `M${x1} ${y1}`;
        const samples = Math.min(48, Math.max(2, Math.ceil((x2 - x1) / 8)));
        for (let i = 1; i <= samples; i++) {
            const t = i / samples, amount = curveAmount(interpolation, t);
            const value = layout.channel === 'all' ? layout.value(previous) + (layout.value(key) - layout.value(previous)) * amount
                : sampleChannelValues(track.keys, layout.channel, previous.tick + (key.tick - previous.tick) * t, layout.rate)[layout.axis];
            d += ` L${x1 + (x2 - x1) * t} ${layout.y(value)}`;
        }
        path(d, 'animation-graph-curve');
        const hit = path(d, 'animation-graph-hit');
        hit.dataset.tick = String(key.tick);
        hit.onpointerdown = event => beginHandleDrag(event, key,
            event.clientX - svg.getBoundingClientRect().left < (x1 + x2) / 2 ? 0 : 2);
        if (!selected?.has(key.tick) && !selected?.has(previous.tick)) continue;
        const curve = Array.isArray(interpolation) ? interpolation : [1 / 3, 1 / 3, 2 / 3, 2 / 3];
        for (const handle of [0, 2] as const) {
            const x = x1 + (x2 - x1) * curve[handle], top = y1 + (y2 - y1) * curve[handle + 1];
            path(`M${handle === 0 ? x1 : x2} ${handle === 0 ? y1 : y2} L${x} ${top}`, 'animation-graph-tangent');
            const button = document.createElement('button'); button.type = 'button';
            button.className = 'animation-curve-handle'; button.dataset.tick = String(key.tick); button.dataset.handle = String(handle);
            button.style.left = `${x}px`; button.style.top = `${top}px`;
            button.setAttribute('aria-label', `${key.tick}틱 ${handle === 0 ? '시작' : '끝'} 곡선 핸들`);
            button.title = '드래그 또는 방향키로 선택 채널의 곡선 조절';
            button.onpointerdown = event => beginHandleDrag(event, key, handle);
            button.onkeydown = event => {
                if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
                event.preventDefault(); event.stopPropagation();
                editHandle(key, handle, event.key === 'ArrowLeft' ? -.05 : event.key === 'ArrowRight' ? .05 : 0,
                    (event.key === 'ArrowUp' ? .05 : event.key === 'ArrowDown' ? -.05 : 0) * (y2 > y1 ? -1 : 1));
            };
            lane.append(button);
        }
    }
    lane.prepend(svg);
    for (const value of [layout.minimum, layout.maximum]) {
        const label = document.createElement('span'); label.className = 'animation-graph-value';
        label.textContent = `${Number(value.toFixed(3))}${layout.channel === 'all' ? '%' : ''}`; label.style.top = `${layout.y(value)}px`; lane.append(label);
    }
}
