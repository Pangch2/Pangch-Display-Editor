import type { HeadAccountState } from '../../player-head-service/head-texture-types';

export function initHeadAccountSettings(root: HTMLElement): void {
  const api = window.ipcApi?.headTextures;
  const login = root.querySelector<HTMLButtonElement>('.settings-login')!;
  const list = root.querySelector<HTMLElement>('.settings-account-list')!;
  const status = root.querySelector<HTMLElement>('.settings-account-status')!;
  if (!api?.cancelLogin) {
    login.disabled = true;
    status.textContent = '새 계정 기능을 연결하려면 PDE 데스크톱 앱을 다시 시작해 주세요.';
    return;
  }
  let accounts: HeadAccountState = { configured: false, accounts: [] };
  let running = false;
  let changing = false;
  let loggingIn = false;
  let cancellingLogin = false;
  const lockControls = () => {
    list.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input, button').forEach(control => { control.disabled = running || changing; });
    login.disabled = cancellingLogin;
    login.textContent = loggingIn ? '로그인 취소' : '로그인하기';
    login.ariaLabel = loggingIn ? 'Minecraft 로그인 취소' : 'Minecraft 계정 로그인 및 추가';
  };
  const render = (state: HeadAccountState) => {
    accounts = state;
    list.replaceChildren(...state.accounts.map(account => {
      const row = document.createElement('div');
      row.className = 'settings-account-row';
      row.dataset.uuid = account.uuid;
      const enabled = document.createElement('input');
      enabled.type = 'checkbox';
      enabled.checked = account.enabled;
      enabled.ariaLabel = `${account.username} 텍스처 생성 참여`;
      const fallback = document.createElement('span');
      fallback.className = 'settings-account-face';
      fallback.textContent = '👤';
      fallback.ariaHidden = 'true';
      let face: HTMLElement = fallback;
      if (account.face) {
        const image = document.createElement('img');
        image.className = 'settings-account-face';
        image.alt = `${account.username} 스킨 얼굴`;
        image.width = image.height = 32;
        image.onerror = () => { image.replaceWith(fallback); };
        image.src = account.face;
        face = image;
      }
      const name = document.createElement('span');
      name.className = 'settings-account-name';
      name.textContent = account.username;
      name.ariaLabel = account.username;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'settings-account-remove lucide-icon';
      remove.textContent = '\uE18E';
      remove.ariaLabel = remove.title = `${account.username} 계정 삭제`;
      enabled.onchange = () => { void change(() => api.setEnabled(account.uuid, enabled.checked)); };
      remove.onclick = () => { void change(() => api.logout(account.uuid)); };
      row.append(enabled, face, name, remove);
      return row;
    }));
    status.textContent = state.error || (!state.configured ? 'PDE Microsoft 앱 등록 설정이 필요합니다.' : !state.accounts.length ? '로그인하지 않음' : '');
    lockControls();
  };
  const change = async (action: () => Promise<HeadAccountState>) => {
    if (running || changing) return;
    changing = true; lockControls();
    try { render(await action()); }
    catch (error) { render(accounts); status.textContent = error instanceof Error ? error.message : String(error); }
    finally { changing = false; lockControls(); }
  };
  login.onclick = async () => {
    if (loggingIn) {
      if (cancellingLogin) return;
      cancellingLogin = true; lockControls();
      try { await api.cancelLogin(); }
      catch (error) { status.textContent = error instanceof Error ? error.message : String(error); }
      finally { cancellingLogin = false; lockControls(); }
      return;
    }
    loggingIn = true; lockControls();
    status.textContent = '브라우저에서 Microsoft 로그인을 완료해 주세요. 3분이 지나면 자동으로 취소됩니다.';
    try { render(await api.login()); }
    catch (error) { status.textContent = error instanceof Error ? error.message : String(error); }
    finally { loggingIn = false; lockControls(); }
  };
  void api.account().then(render).catch(error => { status.textContent = String(error); });
  void api.state().then(state => { running = state.running; lockControls(); }).catch(error => { status.textContent = String(error); });
  const unsubscribe = api.subscribe(event => {
    if (event.account) render(event.account);
    if (event.state) { running = event.state.running; lockControls(); }
  });
  window.addEventListener('beforeunload', unsubscribe, { once: true });
}
