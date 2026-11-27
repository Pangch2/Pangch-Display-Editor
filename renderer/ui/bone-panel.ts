import { loadedObjectGroup as root } from '../load-project/display/display-instancing';
import type { GroupData } from '../controls/grouping/group';
import { currentSelection } from '../controls/selection/select';
import { animationSession } from '../animation/animation-state';
import { matchesPointerShortcut, matchesShortcut } from '../controls/input/shortcuts';
import { evaluateMathExpression } from '../math-expression';
import { handleExpandCollapseShortcut } from './common/expand-collapse';
import { addRigArmature, addRigBone, addRigNull, bindRigObjects, findRigNode, removeRigNode, reparentRigNode, rigData, rigDescendants, setRigWeight, unbindRigObjects,
    type RigArmature, type RigBone, type RigNull, type Vec3 } from '../rig/rig-data';
import { beginRigEdit, editRig, type RigEdit } from '../rig/rig-edit';
import { isBoneMode, selectRigNode, selectedRigNode, selectedRigNodes, setBoneMode } from '../rig/rig-view';

// lucide glyphs: person-standing (armature), bone, locate (null), chevron-down/right (as the scene panel's toggles).
const icons = { armature: String.fromCodePoint(0xE21E), bone: String.fromCodePoint(0xE358), null: String.fromCodePoint(0xE1DA),
    expanded: String.fromCodePoint(0xE06D), collapsed: String.fromCodePoint(0xE06F) };
const animationLock = '애니메이션 모드에서는 본 구조와 바인딩을 바꿀 수 없습니다. 기즈모로 본을 움직이면 현재 틱에 키가 들어갑니다.';
/** Tree rows (armatures and bones) whose children are hidden. */
const collapsed = new Set<string>();
let dragged: string | undefined;
const button = document.getElementById('bone-button') as HTMLButtonElement;
const panel = document.getElementById('bone-panel')!;
const header = document.getElementById('bone-panel-header')!;
panel.insertAdjacentHTML('beforeend', `<div class="bone-panel-body">
    <div class="animation-actions">
        <button type="button" data-rig-add="armature" title="새 아마추어(본 1개 포함)">아마추어</button>
        <button type="button" data-rig-add="bone" title="선택한 본의 끝에 자식 본, 아마추어를 고르면 루트 본">본</button>
        <button type="button" data-rig-add="null" title="IK 타깃 등에 쓰는 Null 오브젝트 (내보내지 않음)">Null</button>
        <button type="button" data-rig-remove title="선택한 항목과 그 아래를 삭제">삭제</button>
    </div>
    <div class="bone-tree" role="tree" aria-label="본 계층"></div>
    <fieldset class="bone-properties"></fieldset>
    <section class="bone-binding" aria-label="바인딩"><strong>바인딩</strong>
        <div class="animation-actions">
            <button type="button" data-rig-bind title="선택한 디스플레이(그룹 안 포함)를 선택한 아마추어에 연결하고 가장 가까운 본에 자동 가중치">선택 디스플레이 연결</button>
            <button type="button" data-rig-unbind>연결 해제</button>
        </div>
        <label>가중치 <input class="pde-input" data-rig-weight type="number" min="0" max="1" step="0.05" value="1"></label>
        <button type="button" data-rig-weight-apply title="선택한 디스플레이에 선택한 본의 가중치를 줍니다. 여러 본의 가중치는 합이 1이 되게 나눠 섞습니다.">선택 본에 적용</button>
        <output class="bone-binding-info"></output>
    </section>
    <p class="bone-panel-hint"></p></div>`);
const tree = panel.querySelector<HTMLElement>('.bone-tree')!, properties = panel.querySelector<HTMLFieldSetElement>('.bone-properties')!;
const info = panel.querySelector<HTMLOutputElement>('.bone-binding-info')!, hint = panel.querySelector<HTMLElement>('.bone-panel-hint')!;
const report = (error: unknown) => window.alert(error instanceof Error ? error.message : String(error));
const animating = () => animationSession(root).enabled;

/** Rig edits belong to edit mode, as in Blockbench; in animation mode the gizmo records keys instead. */
function edit(action: () => void): void {
    if (animating()) { report(animationLock); return; }
    try { editRig(root, action); } catch (error) { report(error); }
}

/** Selected displays, including those inside selected groups. */
function selectedDisplays(): string[] {
    const groups = root.userData.groups as Map<string, GroupData> | undefined, objectToGroup = root.userData.objectToGroup as Map<string, string> | undefined;
    const result = new Set(currentSelection.objects);
    if (currentSelection.groups.size) for (const id of (root.userData.objectUuidToInstance as Map<string, unknown> | undefined)?.keys() ?? []) {
        for (let group = objectToGroup?.get(id); group; group = groups?.get(group)?.parent ?? undefined) {
            if (currentSelection.groups.has(group)) { result.add(id); break; }
        }
    }
    return [...result];
}

const activeArmature = (): RigArmature | undefined => {
    const id = selectedRigNode();
    return id ? findRigNode(root, id)?.armature : rigData(root).armatures[0];
};

panel.querySelectorAll<HTMLButtonElement>('[data-rig-add]').forEach(control => control.onclick = () => edit(() => {
    const kind = control.dataset.rigAdd, found = selectedRigNode() ? findRigNode(root, selectedRigNode()!) : undefined;
    if (kind === 'armature') { selectRigNode(addRigArmature(root).bones[0].id); return; }
    const armature = found?.armature ?? rigData(root).armatures[0];
    if (!armature) throw new Error('먼저 아마추어를 추가해 주세요.');
    const parent = found?.bone?.id ?? found?.null?.parent ?? null;
    selectRigNode((kind === 'bone' ? addRigBone(root, armature.id, parent) : addRigNull(root, armature.id, parent)).id);
}));
panel.querySelector<HTMLButtonElement>('[data-rig-remove]')!.onclick = () => edit(() => {
    const id = selectedRigNode();
    if (!id) throw new Error('삭제할 항목을 선택해 주세요.');
    removeRigNode(root, id);
    selectRigNode(null);
});
panel.querySelector<HTMLButtonElement>('[data-rig-bind]')!.onclick = () => edit(() => {
    const armature = activeArmature(), ids = selectedDisplays();
    if (!armature) throw new Error('먼저 아마추어를 추가해 주세요.');
    if (!ids.length) throw new Error('연결할 디스플레이를 선택해 주세요.');
    bindRigObjects(root, armature.id, ids);
});
panel.querySelector<HTMLButtonElement>('[data-rig-unbind]')!.onclick = () => edit(() => {
    const ids = selectedDisplays();
    if (!ids.length) throw new Error('연결을 해제할 디스플레이를 선택해 주세요.');
    unbindRigObjects(root, ids);
});
panel.querySelector<HTMLButtonElement>('[data-rig-weight-apply]')!.onclick = () => edit(() => {
    const id = selectedRigNode(), ids = selectedDisplays();
    if (!id || !findRigNode(root, id)?.bone) throw new Error('가중치를 줄 본을 본 패널에서 선택해 주세요.');
    if (!setRigWeight(root, id, ids, panel.querySelector<HTMLInputElement>('[data-rig-weight]')!.valueAsNumber)) {
        throw new Error('그 본의 아마추어에 연결된 디스플레이를 선택해 주세요.');
    }
});

/** A bone or null may move under a bone of its armature, or to the armature's top, but never under itself. */
function canDrop(source: string | undefined, target: string): boolean {
    const from = source ? findRigNode(root, source) : undefined, to = findRigNode(root, target);
    if (!source || !from || !(from.bone || from.null) || !to || to.armature !== from.armature || to.null || source === target) return false;
    return !rigDescendants(from.armature, source).some(child => child.id === target);
}

function row(label: string, icon: string, id: string, depth: number, hasChildren: boolean): HTMLElement {
    const element = document.createElement('div'), name = document.createElement('button');
    element.className = 'bone-tree-row';
    element.setAttribute('role', 'treeitem');
    element.setAttribute('aria-level', String(depth + 1));
    element.setAttribute('aria-selected', String(selectedRigNodes().includes(id)));
    element.style.paddingLeft = `${2 + depth * 14}px`;
    const toggle = document.createElement(hasChildren ? 'button' : 'span');
    toggle.className = 'bone-tree-toggle';
    if (toggle instanceof HTMLButtonElement) {
        toggle.type = 'button';
        toggle.setAttribute('aria-expanded', String(!collapsed.has(id)));
        toggle.setAttribute('aria-label', collapsed.has(id) ? '펼치기' : '접기');
        toggle.append(Object.assign(document.createElement('span'), { className: 'lucide-icon', textContent: collapsed.has(id) ? icons.collapsed : icons.expanded }));
        toggle.onclick = () => { if (!collapsed.delete(id)) collapsed.add(id); renderTree(); };
    }
    name.type = 'button';
    name.className = 'bone-tree-name';
    const symbol = document.createElement('span');
    symbol.className = 'lucide-icon'; symbol.setAttribute('aria-hidden', 'true'); symbol.textContent = icon;
    name.append(symbol, document.createTextNode(label));
    name.onclick = event => selectRigNode(id, matchesPointerShortcut(event, 'multiSelect'));
    name.ondblclick = () => { selectRigNode(id); beginRename(); };
    element.append(toggle, name);
    // Dragging a bone or null onto a bone makes it that bone's child, onto its armature a top bone; it stays where it is.
    const node = findRigNode(root, id);
    element.draggable = !!(node?.bone || node?.null) && !animating();
    element.ondragstart = event => { dragged = id; event.dataTransfer?.setData('text/plain', id); };
    element.ondragend = () => { dragged = undefined; tree.querySelector('.bone-tree-drop')?.classList.remove('bone-tree-drop'); };
    element.ondragover = event => {
        if (!canDrop(dragged, id)) return;
        event.preventDefault();
        event.stopPropagation();
        element.classList.add('bone-tree-drop');
    };
    element.ondragleave = event => { if (!element.contains(event.relatedTarget as Node | null)) element.classList.remove('bone-tree-drop'); };
    element.ondrop = event => {
        event.preventDefault();
        event.stopPropagation();
        const source = dragged;
        element.classList.remove('bone-tree-drop');
        if (!source || !canDrop(source, id)) return;
        const target = findRigNode(root, id)!;
        edit(() => reparentRigNode(target.armature, source, target.bone ? id : null));
    };
    return element;
}

function renderTree(): void {
    const rows: HTMLElement[] = [];
    for (const armature of rigData(root).armatures) {
        const nodes = [...armature.bones, ...armature.nulls];
        rows.push(row(armature.name, icons.armature, armature.id, 0, nodes.length > 0));
        const visit = (parent: string | null, depth: number) => {
            for (const bone of armature.bones.filter(entry => entry.parent === parent)) {
                rows.push(row(bone.name, icons.bone, bone.id, depth, nodes.some(entry => entry.parent === bone.id)));
                if (!collapsed.has(bone.id)) visit(bone.id, depth + 1);
            }
            for (const point of armature.nulls.filter(entry => entry.parent === parent)) rows.push(row(point.name, icons.null, point.id, depth, false));
        };
        if (!collapsed.has(armature.id)) visit(null, 1);
    }
    tree.replaceChildren(...rows);
    if (!rows.length) tree.textContent = '아마추어가 없습니다.';
}

/** F2 or a double click: the selected node's name field. */
function beginRename(): void {
    const input = properties.querySelector<HTMLInputElement>('input');
    input?.focus();
    input?.select();
}

/**
 * A text field like the object properties: numbers take expressions and step by 1 with the arrow keys. One undo step per focus,
 * however many changes it gets; bound displays follow each change live.
 */
function field(label: string, value: string | number, apply: (value: string) => void, type = 'number'): HTMLLabelElement {
    const element = document.createElement('label'), input = document.createElement('input');
    element.textContent = label;
    input.className = 'pde-input'; input.type = 'text'; input.value = String(value);
    if (type === 'number') input.title = '수식 입력 가능: +, -, *, /, 괄호, pi, sin/cos/tan(라디안) · ↑↓로 1씩 증감 (Enter로 적용)';
    let session: RigEdit | undefined, last = String(value);
    const run = (text: string) => {
        if (animating()) { report(animationLock); return; }
        session ??= beginRigEdit(root);
        // The apply functions check before they change anything, so a refused value leaves the rig as it was.
        try { apply(text); last = text; } catch (error) { input.value = last; report(error); return; }
        session.follow();
    };
    const read = () => { const next = evaluateMathExpression(input.value); return next !== null && Number.isFinite(next) ? next : null; };
    input.onchange = () => {
        if (type !== 'number') { run(input.value); return; }
        const next = read();
        if (next === null) { input.value = last; report('숫자나 수식을 입력해 주세요.'); return; }
        input.value = String(Number(next.toFixed(6)));
        run(input.value);
    };
    input.onkeydown = event => {
        if (event.key === 'Enter') { event.preventDefault(); input.blur(); return; }
        if (type !== 'number' || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
        event.preventDefault();
        const next = read();
        if (next === null) return;
        input.value = String(Number((next + (event.key === 'ArrowUp' ? 1 : -1)).toFixed(6)));
        run(input.value);
    };
    input.onblur = () => { const ended = session; session = undefined; ended?.commit(); };
    element.append(input);
    return element;
}

function vectorFields(label: string, value: Vec3, set: (next: Vec3) => void): HTMLElement {
    const element = document.createElement('div');
    element.className = 'bone-vector';
    element.append(Object.assign(document.createElement('span'), { textContent: label }),
        ...['X', 'Y', 'Z'].map((axis, index) => field(axis, Number(value[index].toFixed(6)), text => { const next = [...value] as Vec3; next[index] = Number(text); set(next); })));
    return element;
}

function choice(label: string, value: string | undefined, options: { id: string; name: string }[], apply: (id: string | undefined) => void): HTMLLabelElement {
    const element = document.createElement('label'), select = document.createElement('select');
    element.textContent = label;
    select.className = 'pde-input';
    select.append(new Option('없음', ''), ...options.map(option => new Option(option.name, option.id)));
    select.value = value ?? '';
    select.onchange = () => edit(() => apply(select.value || undefined));
    element.append(select);
    return element;
}

function renderProperties(): void {
    const id = selectedRigNode(), found = id ? findRigNode(root, id) : undefined;
    properties.disabled = animating();
    if (!found) { properties.replaceChildren(); return; }
    const node: RigArmature | RigBone | RigNull = found.bone ?? found.null ?? found.armature;
    const children: HTMLElement[] = [field('이름', node.name, text => {
        if (!text.trim() || text.length > 120) throw new Error('이름은 1~120자여야 합니다.');
        node.name = text.trim();
    }, 'text')];
    if (found.bone) {
        const bone = found.bone;
        children.push(vectorFields('원점', bone.origin, next => {
            const delta = next.map((value, axis) => value - bone.origin[axis]);
            bone.origin = next;
            // Children keep their offsets, as when the bone is moved with the gizmo.
            for (const child of [...found.armature.bones, ...found.armature.nulls]) {
                let parent = child.parent;
                while (parent && parent !== bone.id) parent = found.armature.bones.find(entry => entry.id === parent)?.parent ?? null;
                if (!parent) continue;
                const at = 'origin' in child ? child.origin : child.position;
                for (let axis = 0; axis < 3; axis++) at[axis] += delta[axis];
            }
        }), vectorFields('회전', bone.rotation, next => { bone.rotation = next; }),
        field('길이', Number(bone.length.toFixed(6)), text => { if (Number(text) < 0) throw new Error('길이는 0 이상이어야 합니다.'); bone.length = Number(text); }),
        field('폭', Number(bone.width.toFixed(6)), text => { if (Number(text) < 0) throw new Error('폭은 0 이상이어야 합니다.'); bone.width = Number(text); }));
    }
    if (found.null) {
        const point = found.null, bones = found.armature.bones;
        const set = (key: 'ikTarget' | 'ikSource' | 'ikPole', value: string | undefined) => { if (value) point[key] = value; else delete point[key]; };
        children.push(vectorFields('위치', point.position, next => { point.position = next; }),
            choice('IK 타깃 (체인 끝 본)', point.ikTarget, bones, value => set('ikTarget', value)),
            choice('IK 소스 (체인 시작 본)', point.ikSource, bones, value => set('ikSource', value)),
            choice('폴 (무릎·팔꿈치 방향)', point.ikPole, found.armature.nulls.filter(entry => entry !== point), value => set('ikPole', value)));
    }
    properties.replaceChildren(...children);
}

function renderBinding(): void {
    const armature = activeArmature(), ids = selectedDisplays();
    const bones = new Map(armature?.bones.map(bone => [bone.id, bone.name]));
    const bound = armature ? Object.keys(armature.weights).length : 0;
    const lines = [armature ? `${armature.name}: 디스플레이 ${bound}개 연결` : '아마추어 없음'];
    if (armature && ids.length === 1) {
        const weights = armature.weights[ids[0]];
        lines.push(weights ? `선택 디스플레이: ${Object.entries(weights).map(([bone, weight]) => `${bones.get(bone) ?? '?'} ${weight}`).join(', ') || '가중치 없음'}` : '선택 디스플레이: 연결 안 됨');
    } else if (ids.length > 1) lines.push(`선택 디스플레이 ${ids.length}개`);
    info.value = lines.join(' · ');
}

function sync(): void {
    button.setAttribute('aria-pressed', String(isBoneMode()));
    if (panel.hidden === isBoneMode()) {
        panel.hidden = !isBoneMode();
        window.dispatchEvent(new CustomEvent('pde:panel-visibility-changed', { detail: 'bone-panel' }));
    }
    if (panel.hidden) return;
    header.textContent = animating() ? '본 애니메이션' : '본 편집모드';
    hint.textContent = animating()
        ? '본·Null을 선택해 기즈모(이동·회전·스케일)로 움직이면 현재 틱에 키가 들어갑니다. 연결된 디스플레이는 가중치대로 따라갑니다.'
        : '뷰포트나 목록에서 본을 골라 기즈모로 원점·회전을, 크기 도구(S)로 길이·폭을 정합니다. 디스플레이를 선택하고 연결하면 가장 가까운 본에 묶입니다.';
    panel.querySelectorAll<HTMLButtonElement>('[data-rig-add], [data-rig-remove], [data-rig-bind], [data-rig-unbind], [data-rig-weight-apply]').forEach(control => { control.disabled = animating(); });
    renderTree(); renderBinding();
    // A focused field keeps its text (and undo session) until it blurs.
    if (!properties.contains(document.activeElement)) renderProperties();
}

button.onclick = () => setBoneMode(!isBoneMode());
const editingDisplays = () => currentSelection.objects.size > 0 || currentSelection.groups.size > 0;
// Before the scene panel's own F2, which renames the last clicked scene row.
window.addEventListener('keydown', event => {
    if (!isBoneMode() || !selectedRigNode() || editingDisplays() || !matchesShortcut(event, 'renameSceneItem')
        || (event.target as HTMLElement)?.closest?.('input, textarea, select, [contenteditable]')) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    beginRename();
}, true);
window.addEventListener('keydown', event => {
    if (!isBoneMode() || editingDisplays()) return;
    handleExpandCollapseShortcut(event, expanded => {
        const ids = selectedRigNodes().filter(id => { const found = findRigNode(root, id); return !found?.null; });
        for (const id of ids) { if (expanded) collapsed.delete(id); else collapsed.add(id); }
        if (ids.length) renderTree();
        return ids.length > 0;
    });
});
for (const name of ['pde:bone-mode-changed', 'pde:rig-changed', 'pde:rig-selection-changed', 'pde:animation-mode-changed', 'pde:history-restored', 'pde:selection-changed', 'pde:active-project-changed']) {
    window.addEventListener(name, sync);
}
sync();
