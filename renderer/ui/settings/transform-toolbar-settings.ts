import { getTransformToolbarPosition, transformToolbarPositions, transformToolbars, transformToolbarTools } from '../toolbar/transform-toolbar';

export function initTransformToolbarSettings(root: HTMLElement): void {
    for (const toolbar of transformToolbars) {
        const { id, label, edit } = toolbar;
        const row = document.createElement('div');
        row.className = 'settings-row settings-sidebar-row';
        row.innerHTML = `<span>${label} 사이드바</span><div class="settings-sidebar-controls">
            <span class="settings-select"><select data-toolbar-position="${id}" aria-label="${label} 사이드바 위치">
                ${transformToolbarPositions.map(([value, name]) => `<option value="${value}">${name}</option>`).join('')}
            </select><span class="lucide-icon">&#xE06D;</span></span>
            <div class="settings-sidebar-tools" role="group" aria-label="${label} 버튼 표시">
                ${transformToolbarTools.filter(tool => Boolean(tool.edit) === edit).map(tool => `
                    <label title="${tool.label}"><span class="${tool.mask ? `transform-icon ${tool.mask}` : 'lucide-icon'}${tool.action === 'toggleVertex' ? ' vertex-icon' : ''}" aria-hidden="true">${tool.icon ?? ''}</span>
                        <input type="checkbox" data-toolbar-action="${tool.action}" aria-label="${tool.label} 버튼 표시">
                    </label>`).join('')}
            </div></div>`;
        root.append(row);
        const select = row.querySelector<HTMLSelectElement>('select')!;
        select.value = getTransformToolbarPosition(toolbar);
        window.addEventListener('pde:toolbar-settings-changed', () => { select.value = getTransformToolbarPosition(toolbar); });
        select.addEventListener('change', () => {
            localStorage.setItem(`pdeToolbarPosition-${id}`, select.value);
            window.dispatchEvent(new Event('pde:toolbar-settings-changed'));
        });
        row.querySelectorAll<HTMLInputElement>('input').forEach(input => {
            const key = `pdeToolbarVisible-${input.dataset.toolbarAction}`;
            input.checked = localStorage.getItem(key) !== 'false';
            input.addEventListener('change', () => {
                localStorage.setItem(key, String(input.checked));
                window.dispatchEvent(new Event('pde:toolbar-settings-changed'));
            });
        });
    }
}
