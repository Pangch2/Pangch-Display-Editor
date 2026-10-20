import { userGuidePages, userGuideSections } from './user-guide-content';

let dialog: HTMLDialogElement | undefined;

function selectUserGuidePage(id: string): void {
    const page = userGuidePages.find(page => page.id === id);
    if (!dialog || !page) return;
    for (const button of dialog.querySelectorAll<HTMLButtonElement>('[data-guide-page]')) {
        button.setAttribute('aria-current', button.dataset.guidePage === id ? 'page' : 'false');
    }
    const content = dialog.querySelector<HTMLElement>('.user-guide-page')!;
    content.innerHTML = `<h2 id="user-guide-page-title">${page.title}</h2>${page.content}`;
    content.scrollTop = 0;
}

// Register before editor handlers so window capture listeners cannot act behind the guide.
for (const name of ['keydown', 'keyup', 'pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'mousedown', 'mousemove', 'mouseup', 'click', 'dblclick', 'auxclick', 'contextmenu', 'wheel', 'touchstart', 'touchmove', 'touchend', 'dragstart', 'dragenter', 'dragleave', 'dragover', 'drop', 'paste', 'copy', 'cut', 'beforeinput']) {
    window.addEventListener(name, (event: Event) => {
        if (!dialog?.open) return;
        event.stopImmediatePropagation();
        const closeButton = dialog.querySelector('.settings-close')!;
        const fileDrop = event instanceof DragEvent && event.dataTransfer?.types.includes('Files');
        if (!dialog.contains(event.target as Node) || fileDrop
            || (event instanceof KeyboardEvent && !['Tab', 'Enter', ' ', 'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'].includes(event.key))) event.preventDefault();
        if (event instanceof KeyboardEvent && event.type === 'keydown') {
            if (event.key === 'Escape') dialog.close();
            else if (['Enter', ' '].includes(event.key) && event.target instanceof HTMLButtonElement && dialog.contains(event.target)) {
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
                    ${userGuideSections.map(section => `
                        <section aria-labelledby="user-guide-section-${section.id}">
                            <h3 id="user-guide-section-${section.id}">${section.title}</h3>
                            <ol>${section.pages.map((page, index) => `<li><button type="button" data-guide-page="${page.id}" aria-controls="user-guide-page"><span class="user-guide-number">${index + 1}</span><span>${page.title}</span></button></li>`).join('')}</ol>
                        </section>`).join('')}
                    <p>단축키는 기본 설정 기준입니다.</p>
                </nav>
                <article id="user-guide-page" class="user-guide-page" tabindex="0" aria-labelledby="user-guide-page-title"></article>
            </div>
        </div>`;
    selectUserGuidePage(userGuidePages[0].id);
    dialog.addEventListener('close', () => {
        dialog!.remove();
        dialog = undefined;
        window.dispatchEvent(new Event('blur'));
    });
    document.body.append(dialog);
    dialog.showModal();
}
