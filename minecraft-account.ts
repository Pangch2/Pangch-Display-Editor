import { app, safeStorage, shell } from 'electron';
import { createServer } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { HeadAccountState } from './head-texture-types.js';

const services = 'https://api.minecraftservices.com';
const authority = 'https://login.microsoftonline.com/consumers/oauth2/v2.0';
const scope = 'XboxLive.signin offline_access';
type Session = { refreshToken: string; uuid: string; username: string };
export type MinecraftProfile = {
  id: string;
  name: string;
  skins: Array<{ state: string; url: string; variant: string }>;
};

export class MinecraftError extends Error {
  constructor(message: string, public status = 0, public retryAt = 0) { super(message); }
}

export async function writeAccountFile(name: string, value: unknown): Promise<void> {
  const target = path.join(app.getPath('userData'), name);
  await fs.writeFile(`${target}.tmp`, JSON.stringify(value), { mode: 0o600 });
  await fs.rename(`${target}.tmp`, target);
}

export async function readAccountFile<T>(name: string): Promise<T | undefined> {
  try { return JSON.parse(await fs.readFile(path.join(app.getPath('userData'), name), 'utf8')) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}

async function responseJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const retry = response.headers.get('retry-after');
    const retryAt = retry ? (/^\d+$/.test(retry) ? Date.now() + Number(retry) * 1000 : Date.parse(retry)) : 0;
    // Do not forward identity-provider response bodies: they can contain credentials.
    throw new MinecraftError(response.status === 401 ? '다시 로그인해 주세요.'
      : response.status === 403 ? '계정 또는 PDE 앱의 Minecraft API 접근 권한을 확인해 주세요.'
      : `Minecraft 인증/스킨 요청 실패 (HTTP ${response.status})`, response.status, retryAt || 0);
  }
  return response.status === 204 ? undefined as T : await response.json() as T;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  return responseJson<T>(await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000)
  }));
}

export class MinecraftAccount {
  private session?: Session;
  private accessToken = '';
  private expiresAt = 0;
  private clientId = '';
  private ready?: Promise<void>;
  private loggingIn?: Promise<HeadAccountState>;
  private refreshing?: Promise<void>;

  private initialize(): Promise<void> {
    return this.ready ??= (async () => {
      const config = await readAccountFile<{ clientId?: string }>('pde-minecraft-config.json');
      this.clientId = process.env.PDE_MICROSOFT_CLIENT_ID || config?.clientId || '';
      if (this.clientId && !/^[a-f\d-]{36}$/i.test(this.clientId)) throw new Error('PDE Microsoft Client ID 설정이 올바르지 않습니다.');
      const stored = await readAccountFile<{ encrypted: string }>('pde-minecraft-account.json');
      if (stored && safeStorage.isEncryptionAvailable()) {
        try { this.session = JSON.parse(safeStorage.decryptString(Buffer.from(stored.encrypted, 'base64'))); }
        catch { this.session = undefined; }
      }
    })();
  }

  async state(): Promise<HeadAccountState> {
    await this.initialize();
    return { configured: !!this.clientId, username: this.session?.username, uuid: this.session?.uuid };
  }

  private async saveSession(): Promise<void> {
    if (!safeStorage.isEncryptionAvailable() || (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')) {
      throw new Error('운영체제의 안전한 계정 저장소를 사용할 수 없습니다.');
    }
    await writeAccountFile('pde-minecraft-account.json', {
      encrypted: safeStorage.encryptString(JSON.stringify(this.session)).toString('base64')
    });
  }

  private async tokens(parameters: Record<string, string>): Promise<{ access_token: string; refresh_token: string }> {
    return responseJson(await fetch(`${authority}/token`, {
      method: 'POST', body: new URLSearchParams({ client_id: this.clientId, scope, ...parameters }),
      signal: AbortSignal.timeout(30000)
    }));
  }

  private async exchange(accessToken: string): Promise<void> {
    const xbox = await postJson<{ Token: string }>('https://user.auth.xboxlive.com/user/authenticate', {
      Properties: { AuthMethod: 'RPS', SiteName: 'user.auth.xboxlive.com', RpsTicket: `d=${accessToken}` },
      RelyingParty: 'http://auth.xboxlive.com', TokenType: 'JWT'
    });
    const xsts = await postJson<{ Token: string; DisplayClaims: { xui: Array<{ uhs: string }> } }>('https://xsts.auth.xboxlive.com/xsts/authorize', {
      Properties: { SandboxId: 'RETAIL', UserTokens: [xbox.Token] }, RelyingParty: 'rp://api.minecraftservices.com/', TokenType: 'JWT'
    });
    const minecraft = await postJson<{ access_token: string; expires_in: number }>(`${services}/authentication/login_with_xbox`, {
      identityToken: `XBL3.0 x=${xsts.DisplayClaims.xui[0].uhs};${xsts.Token}`
    });
    this.accessToken = minecraft.access_token;
    this.expiresAt = Date.now() + minecraft.expires_in * 1000 - 60000;
  }

  login(): Promise<HeadAccountState> {
    return this.loggingIn ??= this.performLogin().finally(() => { this.loggingIn = undefined; });
  }

  private async performLogin(): Promise<HeadAccountState> {
    await this.initialize();
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
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('로그인 콜백을 열지 못했습니다.');
      const redirectUri = `http://localhost:${address.port}/callback`;
      const code = await new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('로그인 시간이 초과되었습니다. 다시 시도해 주세요.')), 180000);
        const finish = (error?: Error, value?: string) => { clearTimeout(timeout); error ? reject(error) : resolve(value!); };
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
        const parameters = new URLSearchParams({ client_id: this.clientId, response_type: 'code', redirect_uri: redirectUri,
          scope, state, code_challenge: challenge, code_challenge_method: 'S256', prompt: 'select_account' });
        void shell.openExternal(`${authority}/authorize?${parameters}`).catch(error => finish(error));
      });
      const tokens = await this.tokens({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirectUri });
      await this.exchange(tokens.access_token);
      const profile = await responseJson<MinecraftProfile>(await fetch(`${services}/minecraft/profile`, {
        headers: { Authorization: `Bearer ${this.accessToken}` }, signal: AbortSignal.timeout(30000)
      }));
      if (this.session && this.session.uuid !== profile.id) throw new Error('기존 계정을 로그아웃한 후 다른 계정으로 로그인해 주세요.');
      this.session = { refreshToken: tokens.refresh_token, uuid: profile.id, username: profile.name };
      await this.saveSession();
      return this.state();
    } catch (error) {
      this.accessToken = ''; this.expiresAt = 0;
      throw error;
    } finally { server.closeAllConnections(); server.close(); }
  }

  private async refresh(): Promise<void> {
    return this.refreshing ??= (async () => {
      if (!this.session) throw new MinecraftError('먼저 헤드 페인트 계정에 로그인해 주세요.', 401);
      let tokens: Awaited<ReturnType<MinecraftAccount['tokens']>>;
      try { tokens = await this.tokens({ grant_type: 'refresh_token', refresh_token: this.session.refreshToken }); }
      catch (error) {
        if (error instanceof MinecraftError && error.status === 400) throw new MinecraftError('다시 로그인해 주세요.', 401);
        throw error;
      }
      this.session.refreshToken = tokens.refresh_token || this.session.refreshToken;
      await this.saveSession();
      await this.exchange(tokens.access_token);
    })().finally(() => { this.refreshing = undefined; });
  }

  async request<T>(route: string, init: RequestInit = {}): Promise<T> {
    await this.initialize();
    if (this.loggingIn) await this.loggingIn;
    if (!this.accessToken || Date.now() >= this.expiresAt) await this.refresh();
    const send = () => fetch(`${services}${route}`, { ...init,
      headers: { ...init.headers, Authorization: `Bearer ${this.accessToken}` }, signal: AbortSignal.timeout(30000) });
    let response = await send();
    if (response.status === 401) {
      await this.refresh();
      // Mutations retry through the queue's rate gate, never twice inside one request.
      if (init.method && init.method !== 'GET') throw new MinecraftError('인증을 갱신했습니다. 스킨 요청을 다시 시도합니다.', 401);
      response = await send();
    }
    return responseJson<T>(response);
  }

  async logout(): Promise<HeadAccountState> {
    await this.initialize();
    if (this.loggingIn) await this.loggingIn;
    await fs.rm(path.join(app.getPath('userData'), 'pde-minecraft-account.json'), { force: true });
    this.session = undefined; this.accessToken = ''; this.expiresAt = 0;
    return this.state();
  }
}
