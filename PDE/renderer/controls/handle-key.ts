import type { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';

type TransformMode = 'translate' | 'rotate' | 'scale';

export interface HandleKeyParams {
    getTransformControls(): TransformControls;
    [key: string]: unknown;
}

const shortcutLogs = {
    pivotMode: 'Z: Pivot Mode 변경 (origin / center)',
    transformSpace: 'X: TransformControls Space 변경 (world / local)',
    removeShear: 'V: 객체 스케일의 Shear 제거',
    blockbenchScale: 'B: Blockbench 스케일 모드 토글',
    customPivotCreate: 'Alt + 이동(Translate): 커스텀 피벗 생성',
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

export function initHandleKey(p: HandleKeyParams): void {
    let ctrlAltLogged = false;

    window.addEventListener('keydown', (event: KeyboardEvent) => {
        if (isEditableTarget(event.target)) return;

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

        if (event.altKey && key === 't') {
            event.preventDefault();
            console.log(shortcutLogs.customPivotCreate);
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
                break;
            case 'r':
                event.preventDefault();
                setTransformMode(p.getTransformControls(), 'rotate');
                break;
            case 's':
                event.preventDefault();
                setTransformMode(p.getTransformControls(), 'scale');
                break;
            case 'z':
                event.preventDefault();
                console.log(shortcutLogs.pivotMode);
                break;
            case 'x':
                event.preventDefault();
                console.log(shortcutLogs.transformSpace);
                break;
            case 'v':
                event.preventDefault();
                console.log(shortcutLogs.removeShear);
                break;
            case 'b':
                event.preventDefault();
                console.log(shortcutLogs.blockbenchScale);
                break;
            case 'alt':
                event.preventDefault();
                console.log(shortcutLogs.customPivotCreate);
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
        if (event.key === 'Alt' || event.key === 'Control') {
            ctrlAltLogged = false;
        }
    });

    window.addEventListener('click', (event: MouseEvent) => {
        if (isEditableTarget(event.target)) return;
        if (!event.ctrlKey && !event.metaKey) return;

        console.log(shortcutLogs.ctrlClick);
    });
}
