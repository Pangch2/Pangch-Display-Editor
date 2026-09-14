import { app, ipcMain, nativeImage, type BrowserWindow } from 'electron';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { MinecraftAccount, MinecraftError, readAccountFile, writeAccountFile, type MinecraftProfile } from './minecraft-account.js';
import { HeadTextureQueue, type TextureJob } from './head-texture-queue.js';
import type { HeadTextureResult, HeadTextureState, HeadAccountState } from './head-texture-types.js';

const backupFile = 'pde-minecraft-skin-backup.json';
type SkinBackup = { uuid: string; png?: string; url?: string; variant: 'classic' | 'slim'; dirty: boolean };
const account = new MinecraftAccount();
let backup: SkinBackup | undefined;
let cache: Record<string, string> = {};
let initializing: Promise<void> | undefined;
let starting = false;
let loggingIn = false;
let loggingOut = false;
const textureUrl = (value: string): string => {
  if (!/^https?:\/\/textures\.minecraft\.net\/texture\/[a-f\d]+$/i.test(value)) throw new Error('Minecraft 텍스처 URL 응답이 올바르지 않습니다.');
  return value.replace(/^http:/, 'https:');
};

function decodePng(bytes: Uint8Array): { key: string; png: Uint8Array } {
  const buffer = Buffer.from(bytes);
  if (buffer.length > 1024 * 1024 || buffer.length < 24 || buffer.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') {
    throw new MinecraftError('1MB 이하의 PNG 스킨만 사용할 수 있습니다.', 400);
  }
  const width = buffer.readUInt32BE(16), height = buffer.readUInt32BE(20);
  if (width !== 64 || (height !== 64 && height !== 32)) throw new MinecraftError('스킨은 64×64 또는 64×32 PNG여야 합니다.', 400);
  const image = nativeImage.createFromBuffer(buffer);
  if (image.isEmpty() || image.getSize().width !== width || image.getSize().height !== height) throw new MinecraftError('PNG 스킨을 읽을 수 없습니다.', 400);
  return { key: createHash('sha256').update(`${width}x${height}:`).update(image.toBitmap()).digest('hex'), png: image.toPNG() };
}

async function download(url: string): Promise<Uint8Array> {
  const response = await fetch(textureUrl(url), { signal: AbortSignal.timeout(30000), redirect: 'error' });
  if (!response.ok) throw new MinecraftError(`스킨 다운로드 실패 (HTTP ${response.status})`, response.status);
  const chunks: Uint8Array[] = [];
  let length = 0;
  if (!response.body) throw new Error('스킨 응답이 비어 있습니다.');
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    length += chunk.length;
    if (length > 1024 * 1024) { throw new MinecraftError('스킨 크기가 너무 큽니다.', 400); }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

const activeSkin = (profile: MinecraftProfile) => profile.skins.find(skin => skin.state === 'ACTIVE');

async function upload(png: Uint8Array, variant: 'classic' | 'slim'): Promise<string> {
  const body = new FormData();
  body.set('variant', variant);
  body.set('file', new Blob([new Uint8Array(png)], { type: 'image/png' }), 'skin.png');
  const profile = await account.request<MinecraftProfile>('/minecraft/profile/skins', { method: 'POST', body });
  const skin = activeSkin(profile);
  if (!skin) throw new Error('업로드된 스킨 URL을 확인하지 못했습니다.');
  return textureUrl(skin.url);
}

export function initHeadTextureService(win: BrowserWindow): void {
  const emit = (event: { state?: HeadTextureState; result?: HeadTextureResult; account?: HeadAccountState }) => {
    if (!win.isDestroyed()) win.webContents.send('head-texture-event', event);
  };
  const initialize = () => initializing ??= (async () => {
    backup = await readAccountFile<SkinBackup>(backupFile);
    if (backup && !backup.dirty) {
      await fs.rm(path.join(app.getPath('userData'), backupFile), { force: true });
      backup = undefined;
    }
    cache = await readAccountFile<Record<string, string>>('pde-head-texture-cache.json') ?? {};
  })();
  const queue = new HeadTextureQueue({
    status: state => emit({ state }),
    backup: async () => {
      if (backup) return;
      const profile = await account.request<MinecraftProfile>('/minecraft/profile');
      const skin = activeSkin(profile);
      const original: SkinBackup = { uuid: profile.id, variant: skin?.variant.toLowerCase() === 'slim' ? 'slim' : 'classic', dirty: false };
      if (skin) { original.url = textureUrl(skin.url); original.png = Buffer.from((decodePng(await download(original.url))).png).toString('base64'); }
      await writeAccountFile(backupFile, original);
      backup = original;
    },
    upload: async job => {
      if (!backup) throw new MinecraftError('원래 스킨 백업이 없습니다.', 400);
      const profile = await account.request<MinecraftProfile>('/minecraft/profile');
      if (profile.id !== backup.uuid) throw new MinecraftError('스킨 백업과 로그인 계정이 다릅니다.', 401);
      backup.dirty = true;
      await writeAccountFile(backupFile, backup);
      return upload(job.png, 'classic');
    },
    reconcile: async job => {
      const skin = activeSkin(await account.request<MinecraftProfile>('/minecraft/profile'));
      if (skin && decodePng(await download(skin.url)).key === job.key) return textureUrl(skin.url);
      return undefined;
    },
    result: async (job, url) => {
      cache[job.key] = textureUrl(url);
      await writeAccountFile('pde-head-texture-cache.json', cache);
      for (const source of job.sources) emit({ result: { source, url: cache[job.key] } });
    },
    restore: async () => {
      if (!backup?.dirty) return;
      const profile = await account.request<MinecraftProfile>('/minecraft/profile');
      if (profile.id !== backup.uuid) throw new MinecraftError('원래 스킨 복원을 위해 이전 계정으로 로그인해 주세요.', 401);
      let skin = activeSkin(profile);
      if (backup.png) {
        const original = decodePng(Buffer.from(backup.png, 'base64'));
        if (!skin || textureUrl(skin.url) !== backup.url || skin.variant.toLowerCase() !== backup.variant) {
          // Use the original hosted URL to preserve Mojang's exact skin bytes and model.
          await account.request('/minecraft/profile/skins', { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ variant: backup.variant, url: textureUrl(backup.url!) }) });
        }
        skin = activeSkin(await account.request<MinecraftProfile>('/minecraft/profile'));
        if (!skin || skin.variant.toLowerCase() !== backup.variant ||
          (textureUrl(skin.url) !== backup.url && decodePng(await download(skin.url)).key !== original.key)) {
          throw new Error('원래 스킨 복원을 아직 확인하지 못했습니다.');
        }
      } else {
        if (skin) await account.request('/minecraft/profile/skins/active', { method: 'DELETE' });
        if (activeSkin(await account.request<MinecraftProfile>('/minecraft/profile'))) throw new Error('기본 스킨 복원을 아직 확인하지 못했습니다.');
      }
      backup.dirty = false;
      await writeAccountFile(backupFile, backup);
    },
    finish: async () => {
      if (backup?.dirty) throw new Error('스킨 복원이 남아 있습니다.');
      await fs.rm(path.join(app.getPath('userData'), backupFile), { force: true });
      backup = undefined;
    }
  });
  const recover = async () => {
    await initialize();
    if (backup?.dirty && !queue.state.running && !win.isDestroyed()) queue.start([]);
  };
  const handle = (name: string, callback: (...args: any[]) => unknown) => {
    ipcMain.handle(name, async (event, ...args: unknown[]) => {
      if (event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) throw new Error('Invalid IPC sender.');
      return callback(...args);
    });
  };
  handle('head-account-state', async () => {
    try { return await account.state(); } catch (error) { return { configured: false, error: String(error) }; }
  });
  handle('head-account-login', async () => {
    if (loggingIn || starting) return { ...await account.state(), error: '계정 작업이 진행 중입니다.' };
    loggingIn = true;
    try {
      const state = await account.login();
      emit({ account: state }); queue.resume(); await recover(); return state;
    } catch (error) { return { ...await account.state(), error: error instanceof Error ? error.message : String(error) }; }
    finally { loggingIn = false; }
  });
  handle('head-account-logout', async () => {
    if (loggingIn || loggingOut || starting) return { ...await account.state(), error: '계정 작업이 진행 중입니다.' };
    loggingOut = true;
    try {
      await initialize();
      queue.cancel(); await queue.settled();
      if (backup?.dirty) { queue.start([]); await queue.settled(); }
      const state = await account.logout(); emit({ account: state }); return state;
    } finally { loggingOut = false; }
  });
  handle('head-texture-state', () => ({ ...queue.state }));
  handle('head-texture-cancel', () => { queue.cancel(); });
  handle('head-texture-start', async (sources: unknown) => {
    if (starting || loggingIn || loggingOut || queue.state.running) return { success: false, error: '이미 생성 또는 계정 작업이 진행 중입니다.' };
    starting = true;
    try {
      await initialize();
      if (!Array.isArray(sources) || sources.length > 100000) throw new Error('텍스처 목록이 올바르지 않습니다.');
      if (!(await account.state()).uuid) throw new Error('설정에서 헤드 페인트 계정에 먼저 로그인해 주세요.');
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
      for (const result of cachedResults) emit({ result });
      queue.start([...jobs.values()], cachedKeys.size, invalid);
      return { success: true };
    } catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) }; }
    finally { starting = false; }
  });
  void recover().catch(error => emit({ state: { ...queue.state, phase: 'failed', error: String(error) } }));
  let closing = false;
  win.on('close', event => {
    if (closing || !queue.state.running) return;
    event.preventDefault(); closing = true; queue.cancel();
    // Offline/forced shutdown recovery is persisted; do not trap the user in the app.
    const timeout = setTimeout(() => { if (!win.isDestroyed()) win.destroy(); }, 15000);
    void queue.settled().finally(() => { clearTimeout(timeout); if (!win.isDestroyed()) win.destroy(); });
  });
}
