export interface HeadAccount {
  uuid: string;
  username: string;
  face?: string;
  enabled: boolean;
}

export interface HeadAccountState {
  configured: boolean;
  accounts: HeadAccount[];
  error?: string;
}

export interface HeadTextureState {
  running: boolean;
  phase: 'idle' | 'uploading' | 'applying' | 'waiting' | 'restoring' | 'complete' | 'cancelled' | 'failed';
  total: number;
  completed: number;
  failed: number;
  retryAt?: number;
  restoreBlocked?: boolean;
  error?: string;
}

export interface HeadTextureResult {
  source: string;
  url: string;
}

export interface MineSkinKey { id: string; key: string; }

export interface HeadTextureApi {
  mineSkinKeys(): Promise<MineSkinKey[]>;
  addMineSkinKey(): Promise<MineSkinKey[]>;
  updateMineSkinKey(id: string, key: string): Promise<MineSkinKey[]>;
  removeMineSkinKey(id: string): Promise<MineSkinKey[]>;
  account(): Promise<HeadAccountState>;
  login(): Promise<HeadAccountState>;
  cancelLogin(): Promise<void>;
  logout(uuid: string): Promise<HeadAccountState>;
  setEnabled(uuid: string, enabled: boolean): Promise<HeadAccountState>;
  start(sources: string[]): Promise<{ success: boolean; error?: string }>;
  cancel(): Promise<void>;
  retryRestore(): Promise<void>;
  setInputLocked(locked: boolean): Promise<void>;
  state(): Promise<HeadTextureState>;
  subscribe(callback: (event: { state?: HeadTextureState; result?: HeadTextureResult; account?: HeadAccountState; log?: string }) => void): () => void;
}
