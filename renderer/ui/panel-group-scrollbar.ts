export function initPanelGroupScrollbar(root: HTMLElement): () => void {
    const scrollbar = document.createElement('div');
    scrollbar.className = 'panel-group-scrollbar';
    scrollbar.tabIndex = 0;
    scrollbar.setAttribute('role', 'scrollbar');
    scrollbar.setAttribute('aria-orientation', 'vertical');
    scrollbar.setAttribute('aria-valuemin', '0');
    scrollbar.setAttribute('aria-label', '패널 스크롤');
    const spacer = document.createElement('div');
    spacer.style.width = '1px';
    scrollbar.append(spacer);
    root.append(scrollbar);

    const getScroller = (): HTMLElement | null => {
        const panel = root.querySelector<HTMLElement>('.panel-group-content:not(.panel-tab-inactive):not([hidden])');
        return panel?.querySelector<HTMLElement>('#scene-object-list, #player-head-atlas-scroll') ?? panel;
    };
    const sync = (): void => {
        const scroller = getScroller();
        scrollbar.hidden = !scroller || root.classList.contains('collapsed') || scroller.scrollHeight <= scroller.clientHeight;
        if (scrollbar.hidden || !scroller) return;
        scrollbar.setAttribute('aria-controls', scroller.id);
        scrollbar.setAttribute('aria-valuemax', String(scroller.scrollHeight - scroller.clientHeight));
        scrollbar.setAttribute('aria-valuenow', String(scroller.scrollTop));
        scrollbar.style.top = `${scroller.getBoundingClientRect().top - root.getBoundingClientRect().top}px`;
        scrollbar.style.height = `${scroller.clientHeight}px`;
        spacer.style.height = `${scroller.scrollHeight}px`;
        scrollbar.scrollTop = scroller.scrollTop;
    };
    const scroll = (event: Event): void => {
        const scroller = getScroller();
        if (event.target === scrollbar && scroller) scroller.scrollTop = scrollbar.scrollTop;
        else if (event.target === scroller) sync();
    };
    root.addEventListener('scroll', scroll, true);
    const resizeObserver = new ResizeObserver(sync);
    resizeObserver.observe(root);
    for (const element of root.querySelectorAll<HTMLElement>('.panel-group-content, #scene-object-list, #player-head-atlas-scroll')) {
        resizeObserver.observe(element);
    }
    const mutationObserver = new MutationObserver(records => {
        if (records.some(record => !scrollbar.contains(record.target))) sync();
    });
    mutationObserver.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['style', 'class', 'hidden'] });
    return () => {
        resizeObserver.disconnect();
        mutationObserver.disconnect();
        root.removeEventListener('scroll', scroll, true);
        scrollbar.remove();
    };
}
