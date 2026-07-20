import { closeWithAnimation, openWithAnimation } from './ui-open-close';
import type { FlipAxis } from '../controls/flip';

type CameraType = 'perspective' | 'orthographic';

interface ContextMenuOptions {
    element: HTMLElement;
    setCameraType: (type: CameraType) => void;
    hasSelection: () => boolean;
    flipSelected: (axis: FlipAxis) => Promise<void>;
    setMirrorModeling: (enabled: boolean) => void;
}

export function initContextMenu({ element, setCameraType, hasSelection, flipSelected, setMirrorModeling }: ContextMenuOptions): void {
    const menu = document.createElement('div');
    let pointerDownPosition = { x: 0, y: 0 };
    menu.className = 'camera-context-menu';
    menu.hidden = true;
    menu.innerHTML = `<div class="camera-menu-parent"><span class="lucide-icon">&#xE17C;</span>카메라<span class="camera-menu-arrow">›</span><div class="camera-submenu"><button data-camera="perspective"><span class="lucide-icon">&#xE064;</span>원근 카메라</button><button data-camera="orthographic"><span class="lucide-icon">&#xE064;</span>직교 카메라</button></div></div><div class="camera-menu-parent" data-selection-only><span class="lucide-icon">&#xE417;</span>좌우반전<span class="camera-menu-arrow">›</span><div class="camera-submenu"><button data-flip="x">X축 반전</button><button data-flip="y">Y축 반전</button><button data-flip="z">Z축 반전</button></div></div><label class="camera-menu-checkbox"><input type="checkbox" data-mirror><span class="lucide-icon">&#xE3B6;</span>미러링 모델링</label>`;
    document.body.appendChild(menu);

    const closeMenu = (): void => {
        if (menu.hidden) return;
        menu.style.pointerEvents = 'none';
        void closeWithAnimation(menu).then(() => {
            if (menu.style.animation.startsWith('uiClose')) menu.hidden = true;
        });
    };

    element.addEventListener('pointerdown', event => {
        if (event.button === 2) pointerDownPosition = { x: event.clientX, y: event.clientY };
    });
    element.addEventListener('contextmenu', event => {
        event.preventDefault();
        if (Math.hypot(event.clientX - pointerDownPosition.x, event.clientY - pointerDownPosition.y) > 5) return;
        menu.querySelector<HTMLElement>('[data-selection-only]')!.hidden = !hasSelection();
        menu.hidden = false;
        menu.style.pointerEvents = '';
        menu.style.left = `${Math.min(event.clientX, innerWidth - menu.offsetWidth)}px`;
        menu.style.top = `${Math.min(event.clientY, innerHeight - menu.offsetHeight)}px`;
        openWithAnimation(menu);
    });
    menu.addEventListener('click', event => {
        const button = (event.target as Element).closest<HTMLButtonElement>('[data-camera]');
        const flipButton = (event.target as Element).closest<HTMLButtonElement>('[data-flip]');
        if (!button && !flipButton) return;
        if (button) setCameraType(button.dataset.camera as CameraType);
        if (flipButton) void flipSelected(flipButton.dataset.flip as FlipAxis)
            .catch(error => console.error('오브젝트 반전에 실패했습니다.', error));
        closeMenu();
    });
    menu.querySelector<HTMLInputElement>('[data-mirror]')!.addEventListener('change', event => {
        setMirrorModeling((event.target as HTMLInputElement).checked);
    });
    window.addEventListener('pointerdown', event => {
        if (!menu.contains(event.target as Node)) closeMenu();
    });
}
