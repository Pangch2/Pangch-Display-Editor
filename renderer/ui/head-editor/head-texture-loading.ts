let dialog: HTMLDialogElement | undefined;
let cancelButton: HTMLButtonElement;
let cancelGeneration = () => {};
let playerHeadLoads = 0;
let playerHeadOverlay: HTMLDivElement | undefined;

// Register before editor shortcuts so a modal also blocks window-level handlers.
const blockInput = (event: Event) => {
  if (!dialog?.open && !playerHeadLoads) return;
  event.stopImmediatePropagation();
  event.preventDefault();
  if (playerHeadLoads) return;
  if (event instanceof KeyboardEvent && !event.ctrlKey && !event.metaKey && !event.altKey) {
    if (event.key === 'Tab') cancelButton.focus();
    if (event.type === 'keydown' && !event.repeat && event.target === cancelButton && ['Enter', ' '].includes(event.key) && !cancelButton.disabled) cancelGeneration();
  }
  if (event.type === 'click' && event.target === cancelButton && !cancelButton.disabled) cancelGeneration();
};
for (const name of ['keydown', 'keyup', 'pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'mousedown', 'mousemove', 'mouseup', 'click', 'dblclick', 'auxclick', 'contextmenu', 'wheel', 'touchstart', 'touchmove', 'touchend', 'dragstart', 'dragenter', 'dragleave', 'dragover', 'drop', 'paste', 'copy', 'cut', 'beforeinput']) {
  window.addEventListener(name, blockInput, { capture: true, passive: false });
}

export function beginPlayerHeadLoading(): () => void {
  const scene = document.getElementById('main-content')!;
  if (!playerHeadOverlay) {
    playerHeadOverlay = document.createElement('div');
    playerHeadOverlay.className = 'player-head-loading';
    const icon = document.getElementById('loading-icon')!.cloneNode() as HTMLImageElement;
    icon.removeAttribute('id');
    icon.className = 'head-texture-loading-icon';
    icon.alt = '';
    const text = document.createElement('p');
    text.className = 'head-texture-loading-text';
    text.setAttribute('role', 'status');
    text.setAttribute('aria-live', 'polite');
    text.textContent = '팽치가 머리를 옮기는중';
    playerHeadOverlay.append(icon, text);
    scene.append(playerHeadOverlay);
  }
  if (playerHeadLoads++ === 0) {
    playerHeadOverlay.hidden = false;
    scene.setAttribute('aria-busy', 'true');
    window.dispatchEvent(new Event('blur'));
  }
  return () => {
    if (--playerHeadLoads === 0) {
      playerHeadOverlay!.hidden = true;
      scene.removeAttribute('aria-busy');
    }
  };
}

export function createHeadTextureLoading(onCancel: () => void) {
  cancelGeneration = onCancel;
  dialog = document.createElement('dialog');
  dialog.className = 'head-texture-loading';
  dialog.setAttribute('aria-label', '텍스쳐 생성');
  const icon = document.getElementById('loading-icon')!.cloneNode() as HTMLImageElement;
  icon.removeAttribute('id');
  icon.className = 'head-texture-loading-icon';
  icon.alt = '';
  const text = document.createElement('p');
  text.className = 'head-texture-loading-text';
  text.setAttribute('role', 'status');
  text.setAttribute('aria-live', 'polite');
  cancelButton = document.createElement('button');
  cancelButton.type = 'button';
  cancelButton.className = 'project-ui-button';
  cancelButton.textContent = '취소';
  cancelButton.onclick = onCancel;
  dialog.append(icon, text, cancelButton);
  dialog.addEventListener('cancel', event => event.preventDefault());
  document.body.append(dialog);
  return {
    cancel: cancelButton,
    show(message: string) {
      text.textContent = message.replace(/\.\.\.$/, '');
      if (!dialog!.open) {
        void window.ipcApi.headTextures.setInputLocked(true).catch(console.error);
        window.dispatchEvent(new Event('blur'));
        dialog!.showModal();
        cancelButton.focus();
      }
    },
    hide() {
      if (dialog!.open) {
        dialog!.close();
        void window.ipcApi.headTextures.setInputLocked(false).catch(console.error);
      }
    }
  };
}
