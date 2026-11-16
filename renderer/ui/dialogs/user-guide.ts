import { userGuidePages, userGuideSections } from './user-guide-content';

let dialog: HTMLDialogElement | undefined;

let pageText: Map<string, string> | undefined;
const searchInput = () => dialog?.querySelector<HTMLInputElement>('.user-guide-search');

function guideText(id: string): string {
    if (!pageText) {
        pageText = new Map();
        const holder = document.createElement('div');
        for (const page of userGuidePages) {
            holder.innerHTML = `${page.title} ${page.content}`;
            pageText.set(page.id, holder.textContent!.toLowerCase());
        }
    }
    return pageText.get(id)!;
}

function countMatches(text: string, query: string): number {
    return query ? text.split(query).length - 1 : 0;
}

function filterUserGuide(): void {
    if (!dialog) return;
    const query = searchInput()!.value.trim().toLowerCase();
    let found = 0;
    for (const item of dialog.querySelectorAll<HTMLElement>('.user-guide-toc li')) {
        const button = item.querySelector<HTMLButtonElement>('[data-guide-page]')!;
        const count = countMatches(guideText(button.dataset.guidePage!), query);
        item.hidden = !!query && !count;
        item.querySelector('.user-guide-count')!.textContent = query && count ? `${count}` : '';
        if (!item.hidden) found++;
    }
    for (const section of dialog.querySelectorAll<HTMLElement>('.user-guide-toc section')) {
        section.hidden = [...section.querySelectorAll('li')].every(item => item.hidden);
    }
    dialog.querySelector<HTMLElement>('.user-guide-empty')!.hidden = !query || found > 0;
}

// Wraps every match in <mark> and returns the first one.
function highlight(root: HTMLElement, query: string): HTMLElement | undefined {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text);
    let first: HTMLElement | undefined;
    for (const node of nodes) {
        const text = node.data, lower = text.toLowerCase();
        if (!lower.includes(query)) continue;
        const fragment = document.createDocumentFragment();
        for (let from = 0; ;) {
            const at = lower.indexOf(query, from);
            if (at < 0) { fragment.append(text.slice(from)); break; }
            fragment.append(text.slice(from, at));
            const mark = document.createElement('mark');
            mark.textContent = text.slice(at, at + query.length);
            first ??= mark;
            fragment.append(mark);
            from = at + query.length;
        }
        node.replaceWith(fragment);
    }
    return first;
}

function selectUserGuidePage(id: string): void {
    const page = userGuidePages.find(page => page.id === id);
    if (!dialog || !page) return;
    for (const button of dialog.querySelectorAll<HTMLButtonElement>('[data-guide-page]')) {
        button.setAttribute('aria-current', button.dataset.guidePage === id ? 'page' : 'false');
    }
    const content = dialog.querySelector<HTMLElement>('.user-guide-page')!;
    content.innerHTML = `<h2 id="user-guide-page-title">${page.title}</h2>${page.content}`;
    content.scrollTop = 0;
    const query = searchInput()!.value.trim().toLowerCase();
    const first = query ? highlight(content, query) : undefined;
    first?.scrollIntoView({ block: 'center' });
}

// Register before editor handlers so window capture listeners cannot act behind the guide.
for (const name of ['keydown', 'keyup', 'pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'mousedown', 'mousemove', 'mouseup', 'click', 'dblclick', 'auxclick', 'contextmenu', 'wheel', 'touchstart', 'touchmove', 'touchend', 'dragstart', 'dragenter', 'dragleave', 'dragover', 'drop', 'paste', 'copy', 'cut', 'beforeinput']) {
    window.addEventListener(name, (event: Event) => {
        if (!dialog?.open) return;
        event.stopImmediatePropagation();
        const closeButton = dialog.querySelector('.settings-close')!;
        const fileDrop = event instanceof DragEvent && event.dataTransfer?.types.includes('Files');
        const typing = event.target === searchInput();
        if (!dialog.contains(event.target as Node) || fileDrop
            || (event instanceof KeyboardEvent && !typing && !['Tab', 'Enter', ' ', 'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'].includes(event.key))) event.preventDefault();
        if (event instanceof KeyboardEvent && event.type === 'keydown') {
            if (event.key === 'Escape') dialog.close();
            else if (typing && event.key === 'Enter' && !event.isComposing) {
                const first = dialog.querySelector<HTMLButtonElement>('.user-guide-toc li:not([hidden]) [data-guide-page]');
                if (first) selectUserGuidePage(first.dataset.guidePage!);
            } else if (['Enter', ' '].includes(event.key) && event.target instanceof HTMLButtonElement && dialog.contains(event.target)) {
                event.preventDefault();
                event.target.click();
            }
        }
        if (event.type === 'click' && event.target instanceof Element && dialog.contains(event.target)) {
            const button = event.target.closest<HTMLButtonElement>('button');
            if (button === closeButton) dialog.close();
            else if (button?.dataset.guidePage) selectUserGuidePage(button.dataset.guidePage);
        }
    }, { capture: true, passive: false });
}

export function openUserGuide(): void {
    if (dialog?.open) return;
    window.dispatchEvent(new Event('blur'));
    dialog = document.createElement('dialog');
    dialog.className = 'settings-window user-guide-window';
    dialog.setAttribute('aria-labelledby', 'user-guide-title');
    dialog.innerHTML = `
        <header><h2 id="user-guide-title"><span class="menu-bar-logo" aria-hidden="true"></span><span class="menu-bar-title">PDE</span><span>사용설명서</span></h2><button class="settings-close" type="button" aria-label="닫기" autofocus>×</button></header>
        <div class="user-guide-content">
            <h1>Pangch Display Editor의 사용법!</h1>
            <div class="user-guide-layout">
                <nav class="user-guide-toc" aria-label="사용설명서 목차">
                    <h2>목차</h2>
                    <input class="user-guide-search" type="search" placeholder="내용 검색 (예: 양동이, 단축키)" aria-label="사용설명서 검색" autocomplete="off" spellcheck="false">
                    <p class="user-guide-empty" hidden>검색 결과가 없습니다.</p>
                    ${userGuideSections.map(section => `
                        <section aria-labelledby="user-guide-section-${section.id}">
                            <h3 id="user-guide-section-${section.id}">${section.title}</h3>
                            <ol>${section.pages.map((page, index) => `<li><button type="button" data-guide-page="${page.id}" aria-controls="user-guide-page"><span class="user-guide-number">${index + 1}</span><span>${page.title}</span><span class="user-guide-count"></span></button></li>`).join('')}</ol>
                        </section>`).join('')}
                    <p>단축키는 기본 설정 기준입니다.</p>
                </nav>
                <article id="user-guide-page" class="user-guide-page" tabindex="0" aria-labelledby="user-guide-page-title"></article>
            </div>
        </div>`;
    selectUserGuidePage(userGuidePages[0].id);
    searchInput()!.addEventListener('input', filterUserGuide);
    dialog.addEventListener('close', () => {
        dialog!.remove();
        dialog = undefined;
        window.dispatchEvent(new Event('blur'));
    });
    document.body.append(dialog);
    dialog.showModal();
}
