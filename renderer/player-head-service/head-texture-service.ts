import { app, ipcMain, type BrowserWindow } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { MinecraftAccount, MinecraftError, accountUuid, accountFilePath, skinGeneratorDirectory, readAccountFile, writeAccountFile, type MinecraftProfile } from './minecraft-account.js';
import { decodePng, downloadSkin, textureUrl } from './minecraft-skin.js';
import { HeadTextureQueue, type TextureJob, type TextureProvider } from './head-texture-queue.js';
import type { HeadTextureResult, HeadTextureState, HeadAccountState } from './head-texture-types.js';
import { MineSkinKeyStore } from './mineskin-key-store.js';
import { mineSkinProvider } from './mineskin-provider.js';
import { MinecraftRequestSchedule } from './minecraft-request-schedule.js';

type SkinBackup = { uuid: string; png?: string; url?: string; variant: 'classic' | 'slim'; dirty: boolean };
const backupFile = (uuid: string) => `pde-minecraft-skin-backup-${uuid}.json`;
const activeSkin = (profile: MinecraftProfile) => profile.skins.find(skin => skin.state === 'ACTIVE');

export function initHeadTextureService(win: BrowserWindow): () => Promise<() => void> {
  const account = new MinecraftAccount();
  const backups = new Map<string, SkinBackup>();
  const providers = new Map<string, TextureProvider>();
  const schedule = new MinecraftRequestSchedule(() => Date.now());
  const keys = new MineSkinKeyStore();
  let queue: HeadTextureQueue | undefined;
  const usernames = new Map<string, string>();
  let cache: Record<string, string> = {};
  let cacheChanged = false;
  let initializing: Promise<void> | undefined;
  let starting = false;
  let changingAccount = false;
  let inputLocked = false;
  let resetting = false;
  let activeRequests = 0;
  let state: HeadTextureState = { running: false, phase: 'idle', total: 0, completed: 0, failed: 0 };
  const emit = (event: { state?: HeadTextureState; result?: HeadTextureResult; account?: HeadAccountState; log?: string }) => {
    if (!win.isDestroyed()) win.webContents.send('head-texture-event', event);
  };
  const accountState = async (): Promise<HeadAccountState> => {
    const result = await account.state();
    for (const entry of result.accounts) usernames.set(entry.uuid, entry.username);
    return result;
  };
  const createQueue = (selected: TextureProvider[]) => new HeadTextureQueue({
    providers: selected,
    log: message => emit({ log: message }),
    status: entry => { state = entry; emit({ state: { ...entry } }); },
    result: async (job, url) => {
      cache[job.key] = textureUrl(url);
      await writeAccountFile('pde-head-texture-cache.json', cache, 1);
      cacheChanged = true;
      for (const source of job.sources) emit({ result: { source, url: cache[job.key] } });
    },
    finish: async () => {
      if (!cacheChanged) return;
      await writeAccountFile('pde-head-texture-cache.json', cache);
      cacheChanged = false;
    }
  });
  const initialize = () => initializing ??= (async () => {
    await accountState();
    await keys.list();
    const directory = skinGeneratorDirectory();
    const legacyFile = 'pde-minecraft-skin-backup.json';
    const legacy = await readAccountFile<SkinBackup>(legacyFile);
    if (legacy) {
      const uuid = accountUuid(legacy.uuid);
      const existing = await readAccountFile<SkinBackup>(backupFile(uuid));
      await writeAccountFile(backupFile(uuid), existing ?? { ...legacy, uuid });
      await fs.rm(path.join(directory, legacyFile), { force: true });
    }
    for (const name of new Set([...(await fs.readdir(directory)), ...(await fs.readdir(app.getPath('userData')))])) {
      const match = /^pde-minecraft-skin-backup-([a-f\d]{32})\.json$/.exec(name);
      if (!match) continue;
      const backup = await readAccountFile<SkinBackup>(name);
      if (!backup || accountUuid(backup.uuid) !== match[1] || typeof backup.dirty !== 'boolean' ||
          !['classic', 'slim'].includes(backup.variant) || (backup.png && !backup.url)) throw new Error(`스킨 백업이 올바르지 않습니다: ${name}`);
      if (backup.dirty) backups.set(match[1], backup);
      else await fs.rm(path.join(directory, name), { force: true });
    }
    cache = await readAccountFile<Record<string, string>>('pde-head-texture-cache.json') ?? {};
  })().catch(error => { initializing = undefined; throw error; });
  const providerFor = (uuid: string): TextureProvider => {
    const existing = providers.get(uuid);
    if (existing) return existing;
    let confirmedProfile: MinecraftProfile | undefined;
    const verifiedSkins = new Map<string, string>();
    const request = async <T>(route: string, init: RequestInit = {}): Promise<T> => {
      const retryAt = schedule.readyAt(uuid);
      if (retryAt > Date.now()) throw Object.assign(new MinecraftError('API 요청 예산을 기다립니다.', 429, retryAt), { polling: true });
      const reservation = schedule.begin(uuid);
      try {
        const result = await account.request<T>(uuid, route, init);
        schedule.finish(reservation);
        return result;
      } catch (error) { schedule.finish(reservation, error); throw error; }
    };
    const skinKey = async (url: string) => {
      const normalized = textureUrl(url);
      const existing = verifiedSkins.get(normalized);
      if (existing) return existing;
      const key = decodePng(await downloadSkin(normalized)).key;
      verifiedSkins.set(normalized, key);
      return key;
    };
    const profile = async (body?: FormData) => {
      const previous = confirmedProfile;
      if (body) confirmedProfile = undefined;
      try {
        const result = body ? await request<MinecraftProfile>('/minecraft/profile/skins', { method: 'POST', body })
          : await request<MinecraftProfile>('/minecraft/profile');
        if (accountUuid(result.id) !== uuid) throw new MinecraftError('스킨 응답과 로그인 계정이 다릅니다.', 401);
        confirmedProfile = result;
        return result;
      } catch (error) {
        // A rejected mutation leaves the previously confirmed skin intact.
        if (body && (error as { status?: number })?.status === 429) confirmedProfile = previous;
        throw error;
      }
    };
    const provider: TextureProvider = {
      name: usernames.get(uuid) ?? uuid,
      nextJobAt: () => schedule.readyAt(uuid),
      needsRestore: () => {
        const original = backups.get(uuid);
        if (!original?.dirty) return false;
        if (!confirmedProfile) return true;
        const skin = activeSkin(confirmedProfile);
        if (!original.png) return !!skin;
        return !skin || skin.variant.toLowerCase() !== original.variant ||
          (textureUrl(skin.url) !== original.url && verifiedSkins.get(textureUrl(skin.url)) !== decodePng(Buffer.from(original.png, 'base64')).key);
      },
      backup: async () => {
        if (backups.has(uuid)) return;
        // Public profiles are only used before mutation; reconciliation needs the authenticated state.
        const skin = activeSkin(confirmedProfile ??= await account.publicProfile(uuid));
        schedule.observeBackup(uuid, !!skin);
        const original: SkinBackup = { uuid, variant: skin?.variant.toLowerCase() === 'slim' ? 'slim' : 'classic', dirty: false };
        if (skin) {
          original.url = textureUrl(skin.url);
          const png = await downloadSkin(original.url);
          verifiedSkins.set(original.url, decodePng(png).key);
          original.png = Buffer.from(png).toString('base64');
        }
        await writeAccountFile(backupFile(uuid), original);
        backups.set(uuid, original);
      },
      upload: async job => {
        const original = backups.get(uuid);
        if (!original) throw new MinecraftError('원래 스킨 백업이 없습니다.', 400);
        if (!original.dirty) {
          const dirty = { ...original, dirty: true };
          await writeAccountFile(backupFile(uuid), dirty);
          backups.set(uuid, dirty);
        }
        const body = new FormData();
        body.set('variant', 'classic');
        body.set('file', new Blob([new Uint8Array(job.png)], { type: 'image/png' }), 'skin.png');
        const startedAt = Date.now();
        const result = await profile(body);
        const skin = activeSkin(result);
        if (!skin) throw new Error('업로드된 스킨을 아직 확인하지 못했습니다.');
        schedule.observeJob(uuid, Date.now() - startedAt);
        return textureUrl(skin.url);
      },
      verify: async (job, url) => {
        if (await skinKey(url) !== job.key) throw new MinecraftError('업로드된 스킨의 픽셀이 요청한 텍스처와 다릅니다.', 400);
      },
      reconcile: async job => {
        const skin = activeSkin(confirmedProfile ?? await profile());
        if (skin && await skinKey(skin.url) === job.key) return textureUrl(skin.url);
        return undefined;
      },
      restore: async () => {
        const original = backups.get(uuid);
        if (!original?.dirty) return;
        let skin = activeSkin(confirmedProfile ?? await profile());
        if (original.png) {
          const png = Buffer.from(original.png, 'base64');
          const decoded = decodePng(png);
          const matchesOriginal = async () => !!skin && skin.variant.toLowerCase() === original.variant &&
            (textureUrl(skin.url) === original.url || await skinKey(skin.url) === decoded.key);
          if (!await matchesOriginal()) {
            const body = new FormData();
            body.set('variant', original.variant);
            body.set('file', new Blob([new Uint8Array(png)], { type: 'image/png' }), 'original-skin.png');
            skin = activeSkin(await profile(body));
          }
          if (!await matchesOriginal()) {
            throw new Error('원래 스킨 복원을 아직 확인하지 못했습니다.');
          }
        } else {
          if (skin) {
            confirmedProfile = undefined;
            await request('/minecraft/profile/skins/active', { method: 'DELETE' });
          }
          if (activeSkin(confirmedProfile ?? await profile())) throw new Error('기본 스킨 복원을 아직 확인하지 못했습니다.');
        }
        const restored = { ...original, dirty: false };
        await writeAccountFile(backupFile(uuid), restored);
        backups.set(uuid, restored);
      },
      finish: async () => {
        if (backups.get(uuid)?.dirty) throw new Error('스킨 복원이 남아 있습니다.');
        await fs.rm(accountFilePath(backupFile(uuid)), { force: true });
        backups.delete(uuid);
        confirmedProfile = undefined;
        verifiedSkins.clear();
      }
    };
    providers.set(uuid, provider);
    return provider;
  };
  const recover = async () => {
    await initialize();
    if (starting || resetting || win.isDestroyed()) return;
    if (state.running) return;
    const pending = [...backups].filter(([, backup]) => backup.dirty);
    if (!pending.length) return;
    queue = createQueue(pending.map(([uuid]) => providerFor(uuid)));
    queue.start([]);
  };
  const cancel = () => queue?.cancel();
  const settled = () => queue?.settled() ?? Promise.resolve();
  const handle = (name: string, callback: (...args: any[]) => unknown) => {
    ipcMain.handle(name, async (event, ...args: unknown[]) => {
      if (event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) throw new Error('Invalid IPC sender.');
      if (resetting) throw new Error('PDE 캐시 초기화가 진행 중입니다.');
      activeRequests++;
      try { return await callback(...args); }
      finally { activeRequests--; }
    });
  };
  win.webContents.prependListener('before-input-event', (event, input) => {
    if (inputLocked && (input.control || input.meta || input.alt || !['Tab', 'Enter', ' ', 'Space'].includes(input.key))) event.preventDefault();
  });
  win.webContents.on('did-start-loading', () => { inputLocked = false; account.cancelLogin(); });
  handle('head-texture-input-lock', locked => {
    if (typeof locked !== 'boolean') throw new Error('입력 잠금 상태는 boolean이어야 합니다.');
    inputLocked = locked;
  });
  handle('head-account-state', async () => {
    try { return await accountState(); } catch (error) { return { configured: false, accounts: [], error: String(error) }; }
  });
  handle('head-account-login-cancel', () => account.cancelLogin());
  handle('head-account-login', async () => {
    try {
      const result = await account.login();
      for (const entry of result.accounts) usernames.set(entry.uuid, entry.username);
      emit({ account: result });
      if (account.lastLoginUuid) queue?.resume();
      await recover();
      return result;
    } catch (error) {
      const result = await accountState().catch(() => ({ configured: false, accounts: [] }));
      return { ...result, error: error instanceof Error ? error.message : String(error) };
    }
  });
  const changeAccount = async (value: unknown, enabled?: unknown): Promise<HeadAccountState> => {
    const uuid = accountUuid(value);
    if (enabled !== undefined && typeof enabled !== 'boolean') throw new Error('계정 참여 여부는 boolean이어야 합니다.');
    if (starting || state.running || changingAccount) throw new Error('생성 또는 스킨 복원 중에는 계정 참여 변경과 삭제를 할 수 없습니다.');
    changingAccount = true;
    try {
      await initialize();
      if (!(await accountState()).accounts.some(entry => entry.uuid === uuid)) throw new Error('Minecraft 계정이 없습니다.');
      if (state.running) throw new Error('생성 또는 스킨 복원 중에는 계정 참여 변경과 삭제를 할 수 없습니다.');
      if (enabled === undefined && backups.get(uuid)?.dirty) throw new Error('원래 스킨 복원이 남은 계정은 삭제할 수 없습니다. 다시 로그인해 주세요.');
      const result = enabled === undefined ? await account.logout(uuid) : await account.setEnabled(uuid, enabled as boolean);
      emit({ account: result });
      return result;
    } finally { changingAccount = false; }
  };
  handle('head-account-logout', value => changeAccount(value));
  handle('head-account-enabled', (value, enabled) => {
    if (typeof enabled !== 'boolean') throw new Error('계정 참여 여부는 boolean이어야 합니다.');
    return changeAccount(value, enabled);
  });
  handle('head-mineskin-keys', () => keys.list());
  const changeKey = async (action: 'add' | 'update' | 'remove', id?: unknown, value?: unknown) => {
    if (starting || state.running || changingAccount) throw new Error('생성 또는 스킨 복원 중에는 MineSkin 키를 변경할 수 없습니다.');
    changingAccount = true;
    try {
      await initialize();
      if (state.running || [...backups.values()].some(backup => backup.dirty)) throw new Error('스킨 복원 중에는 MineSkin 키를 변경할 수 없습니다.');
      return await keys.change(action, id, value);
    }
    finally { changingAccount = false; }
  };
  handle('head-mineskin-add', () => changeKey('add'));
  handle('head-mineskin-update', (id, value) => changeKey('update', id, value));
  handle('head-mineskin-remove', id => changeKey('remove', id));
  handle('head-texture-state', () => ({ ...state }));
  handle('head-texture-cancel', cancel);
  handle('head-texture-restore-retry', async () => {
    queue?.resume();
    await recover();
  });
  handle('head-texture-start', async (sources: unknown) => {
    if (starting || changingAccount || state.running) return { success: false, error: '이미 생성 또는 계정 작업이 진행 중입니다.' };
    const startedAt = Date.now();
    starting = true;
    try {
      await initialize();
      if (!Array.isArray(sources) || sources.length > 100000) throw new Error('텍스처 목록이 올바르지 않습니다.');
      const selected = (await accountState()).accounts.filter(entry => entry.enabled);
      const mineSkinKeys = [...new Set((await keys.list()).map(entry => entry.key).filter(Boolean))];
      if (!selected.length && !mineSkinKeys.length) throw new Error('일반 설정에서 Minecraft 계정을 선택하거나 MineSkin API 키를 입력해 주세요.');
      if ([...backups.values()].some(backup => backup.dirty)) throw new Error('원래 스킨 복원을 완료한 후 생성을 시작해 주세요.');
      const jobs = new Map<string, TextureJob>();
      const cachedResults: HeadTextureResult[] = [];
      const cachedKeys = new Set<string>();
      let invalid = 0;
      let totalBytes = 0;
      for (const source of new Set(sources)) {
        if (typeof source !== 'string') throw new Error('PNG data URL만 생성할 수 있습니다.');
        totalBytes += source.length;
        if (totalBytes > 128 * 1024 * 1024) throw new Error('한 번에 생성할 PNG 데이터는 128MB 이하여야 합니다.');
        let decoded: ReturnType<typeof decodePng>;
        try {
          if (source.length > 1400000 || !/^data:image\/png;base64,[A-Za-z\d+/]+={0,2}$/.test(source)) throw new Error('Invalid PNG.');
          decoded = decodePng(Buffer.from(source.slice('data:image/png;base64,'.length), 'base64'));
        } catch { invalid++; continue; }
        const cached = cache[decoded.key];
        if (cached) { cachedResults.push({ source, url: textureUrl(cached) }); cachedKeys.add(decoded.key); continue; }
        const existing = jobs.get(decoded.key);
        if (existing) existing.sources.push(source);
        else jobs.set(decoded.key, { ...decoded, sources: [source] });
      }
      if (win.isDestroyed()) throw new Error('PDE 창이 닫혔습니다.');
      const allocation = schedule.plan(selected.map(entry => ({ uuid: entry.uuid, retryAt: providers.get(entry.uuid)?.retryAt })), jobs.size);
      const selectedProviders = [
        ...selected.sort((a, b) => Number(allocation.has(b.uuid)) - Number(allocation.has(a.uuid))).map(entry => {
          const provider = providerFor(entry.uuid);
          provider.maxJobs = allocation.get(entry.uuid) ?? 0;
          return provider;
        }),
        ...mineSkinKeys.map((key, index) => mineSkinProvider(key, `MineSkin ${index + 1}`, app.getVersion()))
      ];
      queue = createQueue(jobs.size ? selectedProviders : []);
      queue.start([...jobs.values()], cachedKeys.size, invalid);
      for (const result of cachedResults) emit({ result });
      const startedQueue = queue;
      void startedQueue.settled().then(() => emit({ log: `총 생성 시간 | ${((Date.now() - startedAt) / 1000).toFixed(3)}초 | ${startedQueue.timingSummary} | ${startedQueue.completionSummary}` }));
      return { success: true };
    } catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) }; }
    finally { starting = false; void recover().catch(error => { state.error = String(error); emit({ state: { ...state } }); }); }
  });
  void recover().catch(error => { state = { ...state, phase: 'failed', error: String(error) }; emit({ state }); });
  let closing = false;
  win.on('close', event => {
    account.cancelLogin();
    if (closing || !state.running) return;
    event.preventDefault(); closing = true; cancel();
    // Persisted backups allow recovery after an offline or forced shutdown.
    const timeout = setTimeout(() => { if (!win.isDestroyed()) win.destroy(); }, 15000);
    void settled().finally(() => { clearTimeout(timeout); if (!win.isDestroyed()) win.destroy(); });
  });
  return async () => {
    if (starting || changingAccount || state.running || activeRequests || resetting) throw new Error('계정 작업, 텍스처 생성 또는 스킨 복원을 완료한 후 캐시를 초기화해 주세요.');
    resetting = true;
    try {
      await initializing?.catch(() => {});
      if (state.running || [...backups.values()].some(backup => backup.dirty)) throw new Error('원래 스킨 복원을 완료한 후 캐시를 초기화해 주세요.');
      for (const name of new Set([...(await fs.readdir(skinGeneratorDirectory())), ...(await fs.readdir(app.getPath('userData')))])) {
        if (/^pde-minecraft-skin-backup(?:-[a-f\d]{32})?\.json$/.test(name) && (await readAccountFile<SkinBackup>(name))?.dirty) {
          throw new Error('원래 스킨 복원을 완료한 후 캐시를 초기화해 주세요.');
        }
      }
      await fs.rm(skinGeneratorDirectory(), { recursive: true, force: true });
      for (const name of await fs.readdir(app.getPath('userData'))) {
        if (/^pde-(?:minecraft-(?:config|accounts?|skin-backup(?:-[a-f\d]{32})?)|mineskin-keys|head-texture-cache)\.json$/.test(name)) {
          await fs.rm(path.join(app.getPath('userData'), name), { force: true });
        }
      }
      return () => { resetting = false; };
    } catch (error) { resetting = false; throw error; }
  };
}
