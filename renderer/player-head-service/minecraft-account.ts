import { app, safeStorage, shell } from 'electron';
import { createServer } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { constants, zstdCompress, zstdDecompress } from 'node:zlib';
import type { HeadAccountState } from './head-texture-types.js';
import { downloadSkin, skinFaceImage, textureUrl } from './minecraft-skin.js';

const services = 'https://api.minecraftservices.com';
const authority = 'https://login.microsoftonline.com/consumers/oauth2/v2.0';
const scope = 'XboxLive.signin offline_access';
type Session = { refreshToken: string; uuid: string; username: string; enabled: boolean; face?: string;
  authentication?: { accessToken: string; expiresAt: number } };
const accountsFile = 'pde-minecraft-accounts.json';
export const accountUuid = (value: unknown): string => {
  if (typeof value !== 'string' || !/^(?:[a-f\d]{32}|[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12})$/i.test(value)) {
    throw new Error('Minecraft UUID가 올바르지 않습니다.');
  }
  return value.replace(/-/g, '').toLowerCase();
};
export type MinecraftProfile = {
  id: string;
  name: string;
  skins: Array<{ state: string; url: string; variant: string }>;
};

export class MinecraftError extends Error {
  constructor(message: string, public status = 0, public retryAt = 0, public request?: string, public retryAfterMs?: number) { super(message); }
}

const fileWrites = new Map<string, Promise<void>>();
const compress = promisify(zstdCompress);
const decompress = promisify(zstdDecompress);
const textureCacheFile = 'pde-head-texture-cache.json';
export const skinGeneratorDirectory = (): string => path.join(app.getPath('userData'), 'pde-asset-cache-v1', 'skin-generator');
export const accountFilePath = (name: string): string => path.join(skinGeneratorDirectory(), name);
export function writeAccountFile(name: string, value: unknown, compressionLevel = 18): Promise<void> {
  const target = accountFilePath(name);
  const contents = JSON.stringify(value);
  const task = (fileWrites.get(target) ?? Promise.resolve()).catch(() => {}).then(async () => {
    await fs.mkdir(path.dirname(target), { recursive: true });
    const bytes = name === textureCacheFile ? await compress(Buffer.from(contents), { params: {
      [constants.ZSTD_c_compressionLevel]: compressionLevel,
      [constants.ZSTD_c_checksumFlag]: 1
    } }) : contents;
    await fs.writeFile(`${target}.tmp`, bytes, { mode: 0o600 });
    await fs.rename(`${target}.tmp`, target);
  });
  fileWrites.set(target, task);
  void task.finally(() => { if (fileWrites.get(target) === task) fileWrites.delete(target); }).catch(() => {});
  return task;
}

export async function readAccountFile<T>(name: string): Promise<T | undefined> {
  await fs.mkdir(skinGeneratorDirectory(), { recursive: true });
  let bytes: Buffer;
  let legacy = false;
  try { bytes = await fs.readFile(accountFilePath(name)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    try { bytes = await fs.readFile(path.join(app.getPath('userData'), name)); legacy = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  }
  const compressed = name === textureCacheFile && bytes.length >= 4 && bytes.readUInt32LE(0) === 0xfd2fb528;
  const value = JSON.parse((compressed ? await decompress(bytes) : bytes).toString('utf8')) as T;
  if (legacy || (name === textureCacheFile && !compressed)) await writeAccountFile(name, value);
  if (legacy) await fs.rm(path.join(app.getPath('userData'), name), { force: true });
  return value;
}

async function responseJson<T>(response: Response, method = 'GET'): Promise<T> {
  if (!response.ok) {
    const retry = response.headers.get('retry-after');
    const now = Date.now();
    const parsedRetryAt = retry ? (/^\d+(?:\.\d+)?$/.test(retry) ? now + Number(retry) * 1000 : Date.parse(retry)) : 0;
    const retryAt = Number.isFinite(parsedRetryAt) ? parsedRetryAt : 0;
    const retryAfterMs = retry && Number.isFinite(parsedRetryAt) ? Math.max(0, parsedRetryAt - now) : undefined;
    // Do not forward identity-provider response bodies: they can contain credentials.
    throw new MinecraftError(response.status === 401 ? '다시 로그인해 주세요.'
      : response.status === 403 ? `접근이 거부되었습니다 (HTTP 403, ${new URL(response.url).origin}${new URL(response.url).pathname}). 계정 또는 PDE 앱의 해당 API 접근 권한을 확인해 주세요.`
      : `Minecraft 인증/스킨 요청 실패 (HTTP ${response.status})`, response.status, retryAt, `${method} ${new URL(response.url).pathname}`, retryAfterMs);
  }
  return response.status === 204 ? undefined as T : await response.json() as T;
}

async function postJson<T>(url: string, body: unknown, signal?: AbortSignal): Promise<T> {
  return responseJson<T>(await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000)
  }), 'POST');
}

export class MinecraftAccount {
  lastLoginUuid?: string;
  private sessions = new Map<string, Session>();
  private clientId = 'dd0f5c23-a76b-4600-9c75-774150a780dc';
  private ready?: Promise<void>;
  private loggingIn?: Promise<HeadAccountState>;
  private loginController?: AbortController;
  private refreshing = new Map<string, Promise<void>>();
  private saving = Promise.resolve();

  private initialize(): Promise<void> {
    return this.ready ??= (async () => {
      const config = await readAccountFile<{ clientId?: string }>('pde-minecraft-config.json');
      this.clientId = process.env.PDE_MICROSOFT_CLIENT_ID || config?.clientId || this.clientId;
      if (this.clientId && !/^[a-f\d-]{36}$/i.test(this.clientId)) throw new Error('PDE Microsoft Client ID 설정이 올바르지 않습니다.');
      const stored = await readAccountFile<{ encrypted: string }>(accountsFile);
      const legacy = await readAccountFile<{ encrypted: string }>('pde-minecraft-account.json');
      if (stored || legacy) {
        if (!safeStorage.isEncryptionAvailable()) throw new Error('운영체제의 안전한 계정 저장소를 사용할 수 없습니다.');
        const sessions: Session[] = stored ? JSON.parse(safeStorage.decryptString(Buffer.from(stored.encrypted, 'base64'))) : [];
        if (!Array.isArray(sessions)) throw new Error('저장된 Minecraft 계정 목록이 올바르지 않습니다.');
        if (legacy) {
          const previous = JSON.parse(safeStorage.decryptString(Buffer.from(legacy.encrypted, 'base64')));
          const uuid = accountUuid(previous.uuid);
          if (!sessions.some(session => accountUuid(session.uuid) === uuid)) sessions.push({ ...previous, uuid, enabled: true });
        }
        for (const session of sessions) {
          const uuid = accountUuid(session.uuid);
          if (typeof session.refreshToken !== 'string' || !session.refreshToken || typeof session.username !== 'string' ||
              typeof session.enabled !== 'boolean' || this.sessions.has(uuid)) throw new Error('저장된 Minecraft 계정이 올바르지 않습니다.');
          const authentication = session.authentication;
          if (!authentication || typeof authentication.accessToken !== 'string' || !authentication.accessToken ||
              !Number.isFinite(authentication.expiresAt) || authentication.expiresAt <= Date.now()) delete session.authentication;
          this.sessions.set(uuid, { ...session, uuid });
        }
        if (legacy) await this.saveSessions(this.sessions);
        await fs.rm(accountFilePath('pde-minecraft-account.json'), { force: true });
      }
    })().catch(error => { this.ready = undefined; this.sessions.clear(); throw error; });
  }

  async state(): Promise<HeadAccountState> {
    await this.initialize();
    return { configured: !!this.clientId, accounts: [...this.sessions.values()].map(({ uuid, username, face, enabled }) => ({ uuid, username, face, enabled })) };
  }

  async publicProfile(uuid: string): Promise<MinecraftProfile> {
    uuid = accountUuid(uuid);
    // shortcut: public profiles can lag server-side changes; use authenticated reads when immediate consistency is required.
    const profile = await responseJson<{ id: string; name: string; properties?: Array<{ name: string; value: string }> }>(await fetch(
      `https://sessionserver.mojang.com/session/minecraft/profile/${uuid}`,
      { cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(30000) }
    ));
    if (accountUuid(profile.id) !== uuid || typeof profile.name !== 'string') throw new Error('Minecraft 공개 프로필 응답이 올바르지 않습니다.');
    const encoded = profile.properties?.find(property => property.name === 'textures')?.value;
    if (typeof encoded !== 'string') throw new Error('Minecraft 스킨 정보를 찾을 수 없습니다.');
    const texture = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as {
      profileId: string; textures?: { SKIN?: { url: string; metadata?: { model?: string } } };
    };
    if (accountUuid(texture.profileId) !== uuid || !texture.textures || typeof texture.textures !== 'object' || Array.isArray(texture.textures)) {
      throw new Error('Minecraft 스킨 응답이 올바르지 않습니다.');
    }
    const skin = texture.textures.SKIN;
    if (skin !== undefined && (!skin || (skin.metadata?.model !== undefined && !['slim', 'default'].includes(skin.metadata.model)))) {
      throw new Error('Minecraft 스킨 모델 응답이 올바르지 않습니다.');
    }
    return { id: uuid, name: profile.name, skins: skin ? [{ state: 'ACTIVE', url: textureUrl(skin.url),
      variant: skin.metadata?.model === 'slim' ? 'SLIM' : 'CLASSIC' }] : [] };
  }

  private async saveSessions(sessions: Map<string, Session>): Promise<void> {
    if (!safeStorage.isEncryptionAvailable() || (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')) {
      throw new Error('운영체제의 안전한 계정 저장소를 사용할 수 없습니다.');
    }
    await writeAccountFile(accountsFile, {
      encrypted: safeStorage.encryptString(JSON.stringify([...sessions.values()])).toString('base64')
    });
  }

  private updateSessions(update: (sessions: Map<string, Session>) => void): Promise<void> {
    const task = this.saving.catch(() => {}).then(async () => {
      const next = new Map(this.sessions);
      update(next);
      await this.saveSessions(next);
      this.sessions = next;
    });
    this.saving = task;
    return task;
  }

  private session(uuid: string): Session {
    const session = this.sessions.get(uuid);
    if (!session) throw new MinecraftError('Minecraft 계정이 없습니다. 다시 로그인해 주세요.', 401);
    return session;
  }

  private async tokens(parameters: Record<string, string>, signal?: AbortSignal): Promise<{ access_token: string; refresh_token: string }> {
    return responseJson(await fetch(`${authority}/token`, {
      method: 'POST', body: new URLSearchParams({ client_id: this.clientId, scope, ...parameters }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000)
    }), 'POST');
  }

  private async exchange(accessToken: string, signal?: AbortSignal): Promise<{ accessToken: string; expiresAt: number }> {
    const xbox = await postJson<{ Token: string }>('https://user.auth.xboxlive.com/user/authenticate', {
      Properties: { AuthMethod: 'RPS', SiteName: 'user.auth.xboxlive.com', RpsTicket: `d=${accessToken}` },
      RelyingParty: 'http://auth.xboxlive.com', TokenType: 'JWT'
    }, signal);
    const xsts = await postJson<{ Token: string; DisplayClaims: { xui: Array<{ uhs: string }> } }>('https://xsts.auth.xboxlive.com/xsts/authorize', {
      Properties: { SandboxId: 'RETAIL', UserTokens: [xbox.Token] }, RelyingParty: 'rp://api.minecraftservices.com/', TokenType: 'JWT'
    }, signal);
    const minecraft = await postJson<{ access_token: string; expires_in: number }>(`${services}/authentication/login_with_xbox`, {
      identityToken: `XBL3.0 x=${xsts.DisplayClaims.xui[0].uhs};${xsts.Token}`
    }, signal);
    if (typeof minecraft.access_token !== 'string' || !minecraft.access_token || !Number.isFinite(minecraft.expires_in) || minecraft.expires_in <= 0) {
      throw new Error('Minecraft 인증 응답이 올바르지 않습니다.');
    }
    return { accessToken: minecraft.access_token, expiresAt: Date.now() + minecraft.expires_in * 1000 - 60000 };
  }

  login(): Promise<HeadAccountState> {
    if (!this.loggingIn) {
      const controller = this.loginController = new AbortController();
      const timeout = setTimeout(() => controller.abort(new Error('로그인 시간이 초과되었습니다. 다시 시도해 주세요.')), 180000);
      this.loggingIn = this.performLogin(controller.signal).finally(() => {
        clearTimeout(timeout); this.loginController = undefined; this.loggingIn = undefined;
      });
    }
    return this.loggingIn;
  }

  cancelLogin(): void {
    this.loginController?.abort(new Error('로그인이 취소되었습니다.'));
  }

  private async performLogin(signal: AbortSignal): Promise<HeadAccountState> {
    await this.initialize();
    signal.throwIfAborted();
    if (!this.clientId) throw new Error('PDE Microsoft 앱 등록 설정이 아직 없습니다. README의 로그인 설정을 확인해 주세요.');
    const verifier = randomBytes(32).toString('base64url');
    const state = randomBytes(32).toString('hex');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const server = createServer();
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
      });
      signal.throwIfAborted();
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('로그인 콜백을 열지 못했습니다.');
      const redirectUri = `http://localhost:${address.port}/callback`;
      const parameters = new URLSearchParams({ client_id: this.clientId, response_type: 'code', redirect_uri: redirectUri,
        scope, state, code_challenge: challenge, code_challenge_method: 'S256', prompt: 'select_account' });
      const code = await new Promise<string>((resolve, reject) => {
        let finished = false;
        const onAbort = () => finish(signal.reason);
        const finish = (error?: Error, value?: string) => {
          if (finished) return;
          finished = true;
          signal.removeEventListener('abort', onAbort);
          error ? reject(error) : resolve(value!);
        };
        signal.addEventListener('abort', onAbort, { once: true });
        server.on('request', (request, response) => {
          const url = new URL(request.url || '/', redirectUri);
          if (request.method !== 'GET' || url.pathname !== '/callback' || url.searchParams.get('state') !== state) {
            response.writeHead(400).end('Invalid login callback.'); return;
          }
          response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
          response.end('PDE로 돌아가세요. 이 창은 닫아도 됩니다.');
          const value = url.searchParams.get('code');
          finish(value ? undefined : new Error('로그인이 취소되었거나 거부되었습니다.'), value || undefined);
        });
        void shell.openExternal(`${authority}/authorize?${parameters}`).catch(error => finish(error));
      });
      const tokens = await this.tokens({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirectUri }, signal);
      const authentication = await this.exchange(tokens.access_token, signal);
      const profile = await responseJson<MinecraftProfile>(await fetch(`${services}/minecraft/profile`, {
        headers: { Authorization: `Bearer ${authentication.accessToken}` }, signal: AbortSignal.any([signal, AbortSignal.timeout(30000)])
      }));
      const uuid = accountUuid(profile.id);
      let face: string | undefined;
      const skin = profile.skins.find(skin => skin.state === 'ACTIVE');
      if (skin) { try { face = skinFaceImage(await downloadSkin(skin.url, signal)); } catch { /* The account remains usable with the default face icon. */ } }
      if (typeof profile.name !== 'string' || typeof tokens.refresh_token !== 'string' || !tokens.refresh_token) throw new Error('Minecraft 계정 응답이 올바르지 않습니다.');
      await this.updateSessions(sessions => {
        signal.throwIfAborted();
        sessions.set(uuid, { refreshToken: tokens.refresh_token, uuid, username: profile.name, face, authentication,
          enabled: sessions.get(uuid)?.enabled ?? true });
      });
      this.lastLoginUuid = uuid;
      return this.state();
    } finally {
      server.closeAllConnections(); server.close();
    }
  }

  private refresh(uuid: string): Promise<void> {
    const existing = this.refreshing.get(uuid);
    if (existing) return existing;
    const task = (async () => {
      const session = this.session(uuid);
      let tokens: Awaited<ReturnType<MinecraftAccount['tokens']>>;
      try { tokens = await this.tokens({ grant_type: 'refresh_token', refresh_token: session.refreshToken }); }
      catch (error) {
        if (error instanceof MinecraftError && error.status === 400) throw new MinecraftError('다시 로그인해 주세요.', 401);
        throw error;
      }
      let updated: Session | undefined;
      await this.updateSessions(sessions => {
        const current = sessions.get(uuid);
        if (current?.refreshToken === session.refreshToken) {
          updated = { ...current, refreshToken: tokens.refresh_token || current.refreshToken, authentication: undefined };
          sessions.set(uuid, updated);
        }
      });
      if (!updated) return;
      const authentication = await this.exchange(tokens.access_token);
      await this.updateSessions(sessions => {
        const current = sessions.get(uuid);
        if (current?.refreshToken === updated.refreshToken) sessions.set(uuid, { ...current, authentication });
      });
    })().finally(() => { this.refreshing.delete(uuid); });
    this.refreshing.set(uuid, task);
    return task;
  }

  async request<T>(uuid: string, route: string, init: RequestInit = {}): Promise<T> {
    await this.initialize();
    const authentication = this.session(uuid).authentication;
    if (!authentication || Date.now() >= authentication.expiresAt) await this.refresh(uuid);
    const send = () => fetch(`${services}${route}`, { ...init,
      headers: { ...init.headers, Authorization: `Bearer ${this.session(uuid).authentication!.accessToken}` }, signal: AbortSignal.timeout(30000) });
    let response = await send();
    if (response.status === 401) {
      await this.refresh(uuid);
      // Mutations retry through the queue's rate gate, never twice inside one request.
      if (init.method && init.method !== 'GET') throw new MinecraftError('인증을 갱신했습니다. 스킨 요청을 다시 시도합니다.', 401, 0, `${init.method} ${new URL(response.url).pathname}`);
      response = await send();
    }
    return responseJson<T>(response, init.method ?? 'GET');
  }

  async logout(uuid: string): Promise<HeadAccountState> {
    await this.initialize();
    this.session(uuid);
    await this.updateSessions(sessions => { sessions.delete(uuid); });
    return this.state();
  }

  async setEnabled(uuid: string, enabled: boolean): Promise<HeadAccountState> {
    await this.initialize();
    this.session(uuid);
    await this.updateSessions(sessions => { sessions.set(uuid, { ...this.session(uuid), enabled }); });
    return this.state();
  }
}
