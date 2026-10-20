import type { TransformToolbarAction, TransformToolbarControls } from '../../controls/input/handle-key';
import { getShortcuts } from '../../controls/input/shortcuts';

export const transformToolbarPositions = [['left', '왼쪽'], ['right', '오른쪽'], ['top', '위'], ['bottom', '아래']] as const;
export const transformToolbars = [
    { id: 'transform-toolbar', label: '변환 도구', position: 'left', edit: false },
    { id: 'edit-toolbar', label: '편집 도구', position: 'right', edit: true }
] as const;
export const transformToolbarTools: { action: TransformToolbarAction; label: string; icon?: string; mask?: string; edit?: boolean }[] = [
    { action: 'translate', label: '이동', icon: '\ue121' },
    { action: 'rotate', label: '회전', icon: '\ue149' },
    { action: 'scale', label: '크기', icon: '\ue2ec' },
    { action: 'toggleScaleMode', label: '블록벤치 스케일', mask: 'blockbench-scale' },
    { action: 'toggleSmartScale', label: '스마트 스케일', icon: '\ue357' },
    { action: 'shear', label: '기울이기 (shear)', mask: 'shear' },
    { action: 'toggleVertex', label: '버텍스 모드', icon: '\ue121' },
    { action: 'toggleSpace', label: '좌표계', icon: '\ue0e8' },
    { action: 'togglePivot', label: '피벗', icon: '\ue0ac' },
    { action: 'undo', label: '실행 취소', icon: '\ue19b', edit: true },
    { action: 'redo', label: '다시 실행', icon: '\ue143', edit: true },
    { action: 'group', label: '그룹 생성/해제', icon: '\ue464', edit: true },
    { action: 'duplicate', label: '선택 복제', icon: '\ue09e', edit: true },
    { action: 'deleteSelection', label: '선택 삭제', icon: '\ue18e', edit: true }
];

export function getTransformToolbarPosition(toolbar: typeof transformToolbars[number]): string {
    const savedPosition = localStorage.getItem(`pdeToolbarPosition-${toolbar.id}`);
    return transformToolbarPositions.find(([side]) => side === savedPosition)?.[0] ?? toolbar.position;
}

export function setSceneToolbarPosition(position: string): void {
    const side = position === 'bottom' ? 'bottom' : 'top';
    localStorage.setItem('pdeToolbarPosition', side);
    document.getElementById('scene-toolbar')!.classList.toggle('toolbar-bottom', side === 'bottom');
    window.dispatchEvent(new Event('pde:toolbar-settings-changed'));
}

export function initTransformToolbar(getControls: () => TransformToolbarControls | undefined): () => void {
    const mainContent = document.getElementById('main-content')!;
    const sceneToolbar = document.getElementById('scene-toolbar')!;
    const editMenu = document.getElementById('edit-menu');
    const editButtons = new Map<TransformToolbarAction, HTMLButtonElement>();
    const separateToolbar = document.createElement('div');
    separateToolbar.id = 'sidebar-toolbar';
    separateToolbar.className = 'horizontal-toolbar';
    mainContent.append(separateToolbar);
    const toolbars = transformToolbars.map(({ id, label }) => {
        const toolbar = document.createElement('div');
        toolbar.id = id;
        toolbar.className = 'vertical-toolbar';
        toolbar.setAttribute('role', 'toolbar');
        toolbar.setAttribute('aria-label', label);
        toolbar.setAttribute('aria-orientation', 'vertical');
        mainContent.append(toolbar);
        return toolbar;
    });
    const buttons = transformToolbarTools.map(tool => {
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.action = tool.action;
        button.disabled = true;
        const icon = document.createElement('span');
        icon.setAttribute('aria-hidden', 'true');
        icon.className = tool.mask ? `transform-icon ${tool.mask}` : 'lucide-icon';
        icon.classList.toggle('vertex-icon', tool.action === 'toggleVertex');
        icon.textContent = tool.icon ?? '';
        button.append(icon);
        const execute = () => {
            getControls()?.executeTransformAction(tool.action);
            update();
        };
        button.addEventListener('click', execute);
        if (tool.edit && editMenu) {
            const menuButton = document.createElement('button');
            menuButton.type = 'button';
            menuButton.dataset.editAction = tool.action;
            menuButton.setAttribute('role', 'menuitem');
            menuButton.disabled = true;
            menuButton.append(icon.cloneNode(true), document.createElement('span'));
            menuButton.addEventListener('click', execute);
            editMenu.append(menuButton);
            editButtons.set(tool.action, menuButton);
        }
        toolbars[tool.edit ? 1 : 0].append(button);
        return button;
    });
    const applyToolbarSettings = () => {
        transformToolbarTools.forEach((tool, index) => {
            buttons[index].hidden = localStorage.getItem(`pdeToolbarVisible-${tool.action}`) === 'false';
        });
        const scenePosition = localStorage.getItem('pdeToolbarPosition') === 'bottom' ? 'bottom' : 'top';
        sceneToolbar.classList.toggle('toolbar-bottom', scenePosition === 'bottom');
        separateToolbar.classList.toggle('toolbar-bottom', scenePosition === 'top');
        const counts = { left: 0, right: 0 };
        toolbars.forEach((toolbar, index) => {
            const position = getTransformToolbarPosition(transformToolbars[index]);
            const horizontal = position === 'top' || position === 'bottom';
            toolbar.dataset.position = position;
            toolbar.setAttribute('aria-orientation', horizontal ? 'horizontal' : 'vertical');
            toolbar.hidden = !toolbar.querySelector('button:not([hidden])');
            toolbar.style.setProperty('--sidebar-offset', `${toolbar.hidden || horizontal ? 0 : counts[position]++ * 52}px`);
            const parent = horizontal ? position === scenePosition ? sceneToolbar : separateToolbar : mainContent;
            parent.append(toolbar);
        });
        separateToolbar.hidden = !separateToolbar.querySelector('.vertical-toolbar:not([hidden])');
        for (const [position, count] of Object.entries(counts)) {
            mainContent.style.setProperty(`--sidebar-${position}-space`, `${count * 52}px`);
        }
    };
    window.addEventListener('pde:toolbar-settings-changed', applyToolbarSettings);
    applyToolbarSettings();
    const updateLabels = () => {
        const state = getControls()?.getTransformToolbarState();
        transformToolbarTools.forEach((tool, index) => {
            const value = tool.action === 'toggleSpace' ? `: ${state?.space === 'local' ? '로컬' : '월드'}`
                : tool.action === 'togglePivot' ? `: ${state?.pivot === 'center' ? '중심' : '원점'}` : '';
            const label = tool.label + value;
            const shortcut = getShortcuts(tool.action).join(' / ');
            const glyph = tool.action === 'toggleSpace' ? (state?.space === 'local' ? '\ue2fe' : tool.icon)
                : tool.action === 'togglePivot' ? (state?.pivot === 'center' ? '\ue29e' : tool.icon) : undefined;
            if (glyph) buttons[index].firstElementChild!.textContent = glyph;
            buttons[index].setAttribute('aria-label', label);
            buttons[index].title = label + (shortcut ? ` (${shortcut})` : '');
            const menuButton = editButtons.get(tool.action);
            if (menuButton) {
                menuButton.lastElementChild!.textContent = label;
                menuButton.title = buttons[index].title;
            }
        });
    };
    let previousSpace: string;
    let previousPivot: string;
    const update = () => {
        const state = getControls()?.getTransformToolbarState();
        transformToolbarTools.forEach((tool, index) => {
            const button = buttons[index];
            const disabled = !state || (state.disabled && tool.action !== 'undo' && tool.action !== 'redo') || (tool.action === 'undo' && !state.canUndo)
                || (tool.action === 'redo' && !state.canRedo)
                || (tool.edit === true && tool.action !== 'undo' && tool.action !== 'redo' && !state.hasSelection);
            if (button.disabled !== disabled) button.disabled = disabled;
            const menuButton = editButtons.get(tool.action);
            if (menuButton && menuButton.disabled !== disabled) menuButton.disabled = disabled;
            if (tool.edit || tool.action === 'toggleSpace' || tool.action === 'togglePivot') return;
            const pressed = !!state && (tool.action === 'toggleScaleMode' ? state.blockbenchScale
                : tool.action === 'toggleSmartScale' ? state.smartScale
                : tool.action === 'toggleVertex' ? state.vertexMode : state.mode === tool.action);
            if (button.getAttribute('aria-pressed') !== String(pressed)) button.setAttribute('aria-pressed', String(pressed));
            if (tool.action === 'toggleVertex') {
                const glyph = transformToolbarTools.find(tool => tool.action === (state?.mode === 'shear' ? 'rotate' : state?.mode))?.icon ?? tool.icon;
                if (button.firstElementChild!.textContent !== glyph) button.firstElementChild!.textContent = glyph;
            }
        });
        if (state?.space !== previousSpace || state?.pivot !== previousPivot) {
            previousSpace = state?.space;
            previousPivot = state?.pivot;
            updateLabels();
        }
    };
    window.addEventListener('pde:shortcuts-changed', updateLabels);
    updateLabels();
    update();
    return update;
}
