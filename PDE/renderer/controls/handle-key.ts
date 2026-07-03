import type { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';

type TransformMode = 'translate' | 'rotate' | 'scale';
type TransformSpace = 'world' | 'local';
type PivotMode = 'origin' | 'center';

export interface HandleKeyParams {
    getTransformControls(): TransformControls;
    onTransformControlsChanged?: () => void;
    togglePivotMode?: () => PivotMode;
    [key: string]: unknown;
}

const shortcutLogs = {
    pivotMode: 'Z: Pivot Mode 변경 (origin / center)',
    transformSpace: 'X: TransformControls Space 변경 (world / local)',
    removeShear: 'V: 객체 스케일의 Shear 제거',
    blockbenchScale: 'B: Blockbench 스케일 모드 토글',
    customPivotCreate: 'Alt + 드래그: 커스텀 피벗 생성',
    customPivotReset: 'Ctrl + Alt: 커스텀 피벗 초기화',
    groupToggle: 'G: 그룹 생성 / 그룹 해제',
    ungroupSelected: 'Ctrl + G: 선택한 그룹 해제',
    selectAll: 'Ctrl + A: 전체 선택',
    selectAllObjects: 'Ctrl + Shift + A: 그룹을 제외한 모든 오브젝트 선택',
    ctrlClick: 'Ctrl + 클릭',
    duplicate: 'D: 선택한 오브젝트 복사',
    deleteSelected: 'Delete: 선택한 오브젝트 삭제'
} as const;

function isEditableTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    const tagName = target.tagName;
    return tagName === 'INPUT' || tagName === 'TEXTAREA' || target.isContentEditable;
}

function setTransformMode(transformControls: TransformControls, mode: TransformMode): void {
    transformControls.setMode(mode);
    console.log(`TransformControls Mode: ${mode}`);
}

function toggleTransformSpace(transformControls: TransformControls): void {
    const nextSpace: TransformSpace = transformControls.space === 'local' ? 'world' : 'local';
    transformControls.setSpace(nextSpace);
    console.log(`TransformControls Space: ${nextSpace}`);
}

export function isAltTabShortcut(event: KeyboardEvent, isAltPressed = false): boolean {
    return event.key === 'Tab' && (event.altKey || isAltPressed);
}

export function initHandleKey(p: HandleKeyParams): void {
    let ctrlAltLogged = false;
    let altPressed = false;

    window.addEventListener('keydown', (event: KeyboardEvent) => {
        if (isEditableTarget(event.target)) return;

        if (event.key === 'Alt') {
            altPressed = true;
        }

        if (isAltTabShortcut(event, altPressed)) {
            ctrlAltLogged = false;
            return;
        }

        const key = event.key.toLowerCase();

        if (event.ctrlKey && event.altKey) {
            event.preventDefault();
            if (!ctrlAltLogged) {
                console.log(shortcutLogs.customPivotReset);
                ctrlAltLogged = true;
            }
            return;
        }

        if ((event.ctrlKey || event.metaKey) && event.shiftKey && key === 'a') {
            event.preventDefault();
            console.log(shortcutLogs.selectAllObjects);
            return;
        }

        if ((event.ctrlKey || event.metaKey) && key === 'a') {
            event.preventDefault();
            console.log(shortcutLogs.selectAll);
            return;
        }

        if ((event.ctrlKey || event.metaKey) && key === 'g') {
            event.preventDefault();
            console.log(shortcutLogs.ungroupSelected);
            return;
        }

        if (event.key === 'Delete') {
            event.preventDefault();
            console.log(shortcutLogs.deleteSelected);
            return;
        }

        switch (key) {
            case 't':
                event.preventDefault();
                setTransformMode(p.getTransformControls(), 'translate');
                p.onTransformControlsChanged?.();
                break;
            case 'r':
                event.preventDefault();
                setTransformMode(p.getTransformControls(), 'rotate');
                p.onTransformControlsChanged?.();
                break;
            case 's':
                event.preventDefault();
                setTransformMode(p.getTransformControls(), 'scale');
                p.onTransformControlsChanged?.();
                break;
            case 'z':
                event.preventDefault();
                if (p.togglePivotMode) {
                    console.log(`Pivot Mode: ${p.togglePivotMode()}`);
                } else {
                    console.log(shortcutLogs.pivotMode);
                }
                break;
            case 'x':
                event.preventDefault();
                toggleTransformSpace(p.getTransformControls());
                p.onTransformControlsChanged?.();
                break;
            case 'v':
                event.preventDefault();
                console.log(shortcutLogs.removeShear);
                break;
            case 'b':
                event.preventDefault();
                console.log(shortcutLogs.blockbenchScale);
                break;
            case 'g':
                event.preventDefault();
                console.log(shortcutLogs.groupToggle);
                break;
            case 'd':
                event.preventDefault();
                console.log(shortcutLogs.duplicate);
                break;
        }
    });

    window.addEventListener('keyup', (event: KeyboardEvent) => {
        if (event.key === 'Alt') {
            altPressed = false;
        }

        if (event.key === 'Alt' || event.key === 'Control') {
            ctrlAltLogged = false;
        }
    });

    window.addEventListener('blur', () => {
        altPressed = false;
        ctrlAltLogged = false;
    });

    window.addEventListener('click', (event: MouseEvent) => {
        if (isEditableTarget(event.target)) return;
        if (!event.ctrlKey && !event.metaKey) return;

        console.log(shortcutLogs.ctrlClick);
    });
}
