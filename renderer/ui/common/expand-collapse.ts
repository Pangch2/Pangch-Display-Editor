import { matchesShortcut } from '../../controls/input/shortcuts';

export function handleExpandCollapseShortcut(event: KeyboardEvent, setGroupsExpanded: (expanded: boolean) => boolean): boolean {
    const target = event.target instanceof HTMLElement ? event.target : document.activeElement as HTMLElement | null;
    if (event.defaultPrevented || event.isComposing || target?.closest('input, textarea, select, [contenteditable]')) return false;
    const expanded = matchesShortcut(event, 'expand') ? true : matchesShortcut(event, 'collapse') ? false : null;
    if (expanded === null) return false;

    const modal = document.querySelector<HTMLElement>('dialog[open], .settings-overlay:not([hidden])');
    if (modal && !modal.contains(target)) return false;
    const control = target?.closest<HTMLElement>('[aria-expanded], summary')
        ?? (modal ?? document).querySelector<HTMLElement>('[aria-expanded]:hover, summary:hover');
    if (control) {
        if (control.tagName === 'SUMMARY') {
            const details = control.parentElement;
            if (details instanceof HTMLDetailsElement) details.open = expanded;
        } else if (control.getAttribute('aria-expanded') !== String(expanded) && !control.matches(':disabled, [aria-disabled="true"]')) {
            control.click();
        }
    } else if (modal || !setGroupsExpanded(expanded)) return false;

    event.preventDefault();
    event.stopPropagation();
    return true;
}
