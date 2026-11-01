import { loadedObjectGroup as root } from '../load-project/display/display-instancing';
import { animationData, placeAnimationLayer } from '../animation/animation-state';
import type { AnimationClip } from '../animation/animation-data';

export function renderAnimationLayerRow(clip: AnimationClip, pixelsPerTick: number, edit: (action: () => void) => void, seek: (tick: number) => void): HTMLElement {
    const id = clip.id ?? 'default', primary = animationData(root)!;
    const timing = primary.layerTimings?.find(timing => timing.id === id);
    const row = document.createElement('div'); row.className = 'animation-row animation-layer-row'; row.dataset.clipId = id;
    const part = document.createElement('div'); part.className = 'animation-part-cell';
    const label = document.createElement('span'); label.className = 'animation-part';
    label.textContent = `동작 · ${clip.name ?? '기본'}`;
    label.title = timing?.interval ? `${timing.starts[0]}틱부터 ${timing.interval}틱 간격` : label.textContent;
    part.append(label);
    const lane = document.createElement('div'); lane.className = 'animation-lane';
    lane.title = '두 번 클릭하여 이 시점에 동작 배치';
    lane.onpointerdown = event => event.stopPropagation();
    lane.ondblclick = event => {
        if ((event.target as HTMLElement).closest('button')) return;
        const tick = Math.max(0, Math.round((event.clientX - lane.getBoundingClientRect().left - lane.clientLeft) / pixelsPerTick));
        edit(() => placeAnimationLayer(root, id, tick));
    };
    for (const tick of timing?.starts ?? []) {
        const marker = document.createElement('button'); marker.type = 'button'; marker.className = 'animation-key animation-layer-key';
        marker.dataset.tick = String(tick); marker.style.left = `${tick * pixelsPerTick}px`;
        marker.title = `${clip.name ?? '기본'} · ${tick}틱${timing?.interval ? `부터 ${timing.interval}틱 간격` : ''} · 클릭: 이동 · Delete: 배치 삭제`;
        marker.setAttribute('aria-label', marker.title);
        marker.onclick = () => seek(tick);
        marker.onkeydown = event => {
            if (event.key !== 'Delete' && event.key !== 'Backspace') return;
            event.preventDefault(); event.stopPropagation();
            edit(() => {
                const timing = animationData(root)!.layerTimings?.find(timing => timing.id === id);
                if (!timing) return;
                timing.starts = timing.starts.filter(start => start !== tick);
                if (!timing.starts.length) delete timing.interval;
            });
        };
        lane.append(marker);
    }
    const line = document.createElement('div'); line.className = 'animation-playhead'; lane.append(line);
    row.append(part, lane);
    return row;
}
