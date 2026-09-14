import type { HeadTextureState } from './head-texture-types.js';

export interface TextureJob { key: string; sources: string[]; png: Uint8Array; }
export interface TextureQueueOptions {
  backup(): Promise<void>;
  upload(job: TextureJob): Promise<string>;
  reconcile(job: TextureJob): Promise<string | undefined>;
  restore(): Promise<void>;
  finish(): Promise<void>;
  result(job: TextureJob, url: string): Promise<void>;
  status(state: HeadTextureState): void;
  now?(): number;
  sleep?(ms: number): Promise<void>;
}

export const retryDelay = (attempt: number): number => Math.min(300000, 30000 * 2 ** Math.min(attempt, 4));
export const retryable = (error: unknown): boolean => {
  const status = (error as { status?: number })?.status;
  return !status || status === 401 || status === 408 || status === 429 || status >= 500;
};

export class HeadTextureQueue {
  state: HeadTextureState = { running: false, phase: 'idle', total: 0, completed: 0, failed: 0 };
  private cancelled = false;
  private nextChange = 0;
  private wake?: () => void;
  private task?: Promise<void>;
  private now: () => number;
  constructor(private options: TextureQueueOptions) { this.now = options.now ?? Date.now; }

  start(jobs: TextureJob[], cached = 0, invalid = 0): void {
    if (this.state.running) throw new Error('이미 텍스처 생성 또는 스킨 복원이 진행 중입니다.');
    this.cancelled = false;
    this.state = { running: true, phase: 'uploading', total: jobs.length + cached + invalid, completed: cached, failed: invalid,
      error: invalid ? `${invalid}개 텍스처는 유효한 64×64/64×32 PNG가 아니므로 원본을 유지합니다.` : undefined };
    this.publish();
    this.task = this.run(jobs);
  }

  cancel(): void { this.cancelled = true; this.wake?.(); }
  resume(): void { this.wake?.(); }
  settled(): Promise<void> { return this.task ?? Promise.resolve(); }
  private publish(update: Partial<HeadTextureState> = {}): void {
    Object.assign(this.state, update); this.options.status({ ...this.state });
  }
  private async sleep(ms: number): Promise<void> {
    if (ms <= 0) return;
    if (this.options.sleep) return this.options.sleep(ms);
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => { this.wake = undefined; resolve(); }, ms);
      this.wake = () => { clearTimeout(timer); this.wake = undefined; resolve(); };
    });
  }
  // All skin mutations, including restoration, share this gate.
  private async change<T>(action: () => Promise<T>): Promise<T> {
    while (this.now() < this.nextChange) await this.sleep(this.nextChange - this.now());
    try { return await action(); }
    catch (error) {
      this.nextChange = Math.max(this.nextChange, Number((error as { retryAt?: number })?.retryAt) || 0);
      throw error;
    }
    finally { this.nextChange = Math.max(this.nextChange, this.now() + 3000); }
  }
  private async restore(): Promise<void> {
    let attempt = 0;
    for (;;) {
      this.publish({ phase: 'restoring', retryAt: undefined });
      try { await this.change(() => this.options.restore()); return; }
      catch (error) {
        const retryAt = Math.max(this.now() + retryDelay(attempt++), Number((error as { retryAt?: number })?.retryAt) || 0);
        this.publish({ error: `원래 스킨 복원 대기: ${error instanceof Error ? error.message : String(error)}`, retryAt });
        await this.sleep(retryAt - this.now());
      }
    }
  }
  private async run(jobs: TextureJob[]): Promise<void> {
    const pending = jobs.map(job => ({ job, attempt: 0, due: 0, uncertain: false, url: '' }));
    let dirty = false;
    try {
      // Recover an interrupted previous run before taking a new backup.
      await this.restore();
      if (pending.length && !this.cancelled) await this.options.backup();
      while (pending.length && !this.cancelled) {
        pending.sort((a, b) => a.due - b.due);
        const current = pending[0];
        if (current.due > this.now()) {
          if (dirty) { await this.restore(); dirty = false; }
          if (this.cancelled) break;
          this.publish({ phase: 'waiting', retryAt: current.due });
          await this.sleep(current.due - this.now());
          continue;
        }
        this.publish({ phase: 'uploading', retryAt: undefined });
        try {
          if (current.uncertain && !current.url) current.url = await this.options.reconcile(current.job) || '';
          if (!current.url) {
            current.uncertain = true;
            dirty = true;
            current.url = await this.change(() => {
              if (this.cancelled) throw new Error('생성이 취소되었습니다.');
              return this.options.upload(current.job);
            });
          }
          await this.options.result(current.job, current.url);
          pending.shift();
          this.publish({ completed: this.state.completed + 1, error: undefined });
        } catch (error) {
          if (this.cancelled) break;
          this.publish({ error: error instanceof Error ? error.message : String(error) });
          if (!retryable(error)) {
            pending.shift(); this.publish({ failed: this.state.failed + 1 });
          } else {
            // Reconcile BEFORE restoring: otherwise the uncertain upload becomes unobservable.
            if (current.uncertain && !current.url) {
              try { current.url = await this.options.reconcile(current.job) || ''; } catch { /* retry after connectivity returns */ }
            }
            current.due = Math.max(this.now() + retryDelay(current.attempt++), Number((error as { retryAt?: number })?.retryAt) || 0);
          }
        }
      }
    } catch (error) {
      this.publish({ failed: this.state.failed + pending.length, error: error instanceof Error ? error.message : String(error) });
    } finally {
      await this.restore();
      try { await this.options.finish(); }
      catch (error) { this.publish({ failed: this.state.failed + 1, error: String(error) }); }
      this.publish({ running: false, phase: this.cancelled ? 'cancelled' : this.state.failed ? 'failed' : 'complete', retryAt: undefined });
    }
  }
}
