export interface HeadAccountState {
  configured: boolean;
  username?: string;
  uuid?: string;
  error?: string;
}

export interface HeadTextureState {
  running: boolean;
  phase: 'idle' | 'uploading' | 'waiting' | 'restoring' | 'complete' | 'cancelled' | 'failed';
  total: number;
  completed: number;
  failed: number;
  retryAt?: number;
  error?: string;
}

export interface HeadTextureResult {
  source: string;
  url: string;
}

export interface HeadTextureApi {
  account(): Promise<HeadAccountState>;
  login(): Promise<HeadAccountState>;
  logout(): Promise<HeadAccountState>;
  start(sources: string[]): Promise<{ success: boolean; error?: string }>;
  cancel(): Promise<void>;
  state(): Promise<HeadTextureState>;
  subscribe(callback: (event: { state?: HeadTextureState; result?: HeadTextureResult; account?: HeadAccountState }) => void): () => void;
}
