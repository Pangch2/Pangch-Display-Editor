// Gizmo drag-step input (.settings-drag-value): text input + preset menu, stored in localStorage.
const unlimitedLabel = '제한없음';
const displayValue = (value: string): string => value === '0' ? unlimitedLabel : value;

function closeDragMenus(except?: HTMLElement): void {
    document.querySelectorAll<HTMLElement>('.settings-drag-value').forEach(control => {
        if (control === except) return;
        control.querySelector<HTMLElement>('.settings-drag-menu')!.hidden = true;
        control.querySelector<HTMLButtonElement>('button')!.setAttribute('aria-expanded', 'false');
    });
}

export function initDragValueInput(control: HTMLElement): void {
    const input = control.querySelector<HTMLInputElement>('input')!;
    const menuButton = control.querySelector<HTMLButtonElement>('button')!;
    const menu = control.querySelector<HTMLElement>('.settings-drag-menu')!;
    const storageKey = input.dataset.storageKey!;
    const sync = (): void => { input.value = displayValue(localStorage.getItem(storageKey) ?? input.defaultValue); };
    const commit = (rawValue: string): void => {
        const value = Number(rawValue);
        if (!Number.isFinite(value) || value < 0) return sync();
        localStorage.setItem(storageKey, String(value));
        input.value = displayValue(String(value));
        window.dispatchEvent(new Event('pde:gizmo-drag-values-changed'));
    };

    sync();
    // Same key can be edited from settings and the property panel.
    window.addEventListener('pde:gizmo-drag-values-changed', () => { if (document.activeElement !== input) sync(); });
    input.addEventListener('focus', () => { if (input.value === unlimitedLabel) input.value = '0'; });
    input.addEventListener('blur', () => commit(input.value));
    input.addEventListener('keydown', event => { if (event.key === 'Enter') input.blur(); });

    menu.replaceChildren(...control.dataset.values!.split(',').map(value => {
        const button = Object.assign(document.createElement('button'), { type: 'button', textContent: displayValue(value) });
        button.dataset.value = value;
        return button;
    }));
    menuButton.addEventListener('click', event => {
        event.stopPropagation();
        closeDragMenus(control);
        menu.hidden = !menu.hidden;
        menuButton.setAttribute('aria-expanded', String(!menu.hidden));
    });
    menu.addEventListener('click', event => {
        const button = (event.target as Element).closest<HTMLButtonElement>('[data-value]');
        if (!button) return;
        commit(button.dataset.value!);
        closeDragMenus();
    });
}

export function initDragAlignInput(input: HTMLInputElement): void {
    const sync = (): void => { input.checked = localStorage.getItem('pdeDragAlign') === 'true'; };
    sync();
    window.addEventListener('pde:gizmo-drag-values-changed', sync);
    input.addEventListener('change', () => {
        localStorage.setItem('pdeDragAlign', String(input.checked));
        window.dispatchEvent(new Event('pde:gizmo-drag-values-changed'));
    });
}

document.addEventListener('click', event => {
    if (!(event.target as Element).closest('.settings-drag-value')) closeDragMenus();
});
