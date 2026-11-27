import { loadedObjectGroup as root } from '../load-project/display/display-instancing';
import type { GroupData } from '../controls/grouping/group';
import { animationProjectData } from '../animation/animation-state';
import { addAnimationIk, removeAnimationIk } from '../animation/animation-ik';

export function initAnimationIkControls(edit: (action: () => void) => void) {
    const element = document.createElement('section');
    element.className = 'animation-settings-section';
    element.setAttribute('aria-label', 'IK');
    element.innerHTML = `<strong>IK</strong><div id="animation-ik-list"></div>
        <label>끝 본 <select id="animation-ik-bone" class="pde-input" aria-label="IK 끝 본"></select></label>
        <label>타깃 <select id="animation-ik-target" class="pde-input" aria-label="IK 타깃"></select></label>
        <label>체인 길이 <input id="animation-ik-chain" class="pde-input" type="number" min="1" max="64" step="1" value="2"></label>
        <div class="animation-actions"><button type="button" id="animation-ik-add">IK 추가</button></div>
        <p>그룹이 본, 그룹의 커스텀 피벗(없으면 원점)이 관절입니다. 끝 본 위의 그룹들이 체인 길이만큼 돌아 끝 본 관절을 타깃 그룹 관절에 맞춥니다. 타깃 그룹을 움직여 키를 넣으면 미리보기와 데이터팩에 함께 반영됩니다.</p>`;
    const list = element.querySelector<HTMLElement>('#animation-ik-list')!;
    const bone = element.querySelector<HTMLSelectElement>('#animation-ik-bone')!;
    const target = element.querySelector<HTMLSelectElement>('#animation-ik-target')!;
    const chain = element.querySelector<HTMLInputElement>('#animation-ik-chain')!;
    const label = (groups: Map<string, GroupData>, id: string) => {
        const names: string[] = [];
        for (let group = groups.get(id); group; group = group.parent ? groups.get(group.parent) : undefined) names.unshift(group.name);
        return names.join('/') || '(삭제된 그룹)';
    };
    element.querySelector<HTMLButtonElement>('#animation-ik-add')!.onclick = () => {
        const entry = { bone: bone.value, target: target.value, chain: chain.valueAsNumber };
        edit(() => addAnimationIk(root, entry));
    };
    let signature = '';
    function sync(): void {
        const groups = (root.userData.groups ?? new Map()) as Map<string, GroupData>, ik = animationProjectData(root)?.ik ?? [];
        const options = [...groups.keys()].map(id => [id, label(groups, id)]);
        const next = JSON.stringify([options, ik]);
        if (next === signature) return;
        signature = next;
        for (const select of [bone, target]) {
            const value = select.value;
            select.replaceChildren(...options.map(([id, text]) => new Option(text, id)));
            if (groups.has(value)) select.value = value;
        }
        list.replaceChildren(...ik.map(entry => {
            const row = document.createElement('div'), text = document.createElement('span'), remove = document.createElement('button');
            row.className = 'animation-clip-row';
            text.textContent = `${label(groups, entry.bone)} → ${label(groups, entry.target)} (${entry.chain})`;
            remove.type = 'button'; remove.textContent = '삭제';
            remove.setAttribute('aria-label', `${label(groups, entry.bone)} IK 삭제`);
            remove.onclick = () => edit(() => removeAnimationIk(root, entry.bone));
            row.append(text, remove);
            return row;
        }));
    }
    return { element, sync };
}
