import { autoSaveInterval, defaultAutoSaveSettings, type AutoSaveSettings } from './auto-save-settings.js';
import type { ProjectSaveResult } from '../project-file-store.js';

export type AutoSaveSnapshot = { name: string; data: Uint8Array };
/** Returns the snapshot, or a generator that yields between pieces of work and yields `true` once the scene has been read. */
export type AutoSaveCapture = () => AutoSaveSnapshot | Iterator<unknown, AutoSaveSnapshot>;
type AutoSaveProject = { capture: AutoSaveCapture; baseline?: Uint8Array; ready: Promise<void>; revision: number; suspended: boolean; error?: string };

// Work per slice before the page gets a turn; long captures stay under a frame or two at a time.
const sliceMs = 8;
// A hidden window has nobody to keep responsive, and its timers are throttled, so its captures run in one go.
const hidden = () => typeof document !== 'undefined' && document.hidden;
const pageTurn = () => new Promise(resolve => setTimeout(resolve));

/** Byte comparison in slices, so a large project's comparison doesn't stall the page. */
async function sameBytes(a: Uint8Array | undefined, b: Uint8Array): Promise<boolean> {
    if (!a || a.length !== b.length) return false;
    for (let start = 0; start < a.length; start += 1 << 22) {
        const end = Math.min(a.length, start + (1 << 22));
        for (let index = start; index < end; index++) if (a[index] !== b[index]) return false;
        if (end < a.length && !hidden()) await pageTurn();
    }
    return true;
}

export class AutoSaveController {
    private projects = new Map<string, AutoSaveProject>();
    private settings = { ...defaultAutoSaveSettings };
    private timer: ReturnType<typeof setInterval> | undefined;
    private running = false;

    /** changes: a count that moves whenever the user may have edited something (history, typing, clicks). */
    constructor(private flush: () => Promise<void>,
        private save: (id: string, snapshot: AutoSaveSnapshot, maximum: number) => Promise<ProjectSaveResult>,
        private reportError: (error: string) => void,
        private changes: () => number = () => 0) {}

    register(id: string, capture: AutoSaveCapture): void {
        const project: AutoSaveProject = { capture, revision: 0, suspended: false, ready: Promise.resolve() };
        this.projects.set(id, project);
        project.ready = this.setBaseline(id, project);
        this.reportErrors();
    }

    forget(id: string): void { this.projects.delete(id); this.reportErrors(); }
    suspend(id: string): void {
        const project = this.projects.get(id);
        if (project) { project.revision++; project.suspended = true; }
    }
    resume(id: string): void {
        const project = this.projects.get(id);
        if (project) project.suspended = false;
    }
    /** Drops captures in progress because the scene they read is about to be swapped; the next cycle captures again. */
    cancel(): void {
        for (const project of this.projects.values()) project.revision++;
    }

    configure(settings: AutoSaveSettings): void {
        const reset = !this.timer || settings.enabled !== this.settings.enabled || autoSaveInterval(settings) !== autoSaveInterval(this.settings);
        this.settings = { ...settings };
        if (!reset) return;
        this.stop();
        if (settings.enabled) this.timer = setInterval(() => { void this.run(); }, autoSaveInterval(settings));
    }

    stop(): void { clearInterval(this.timer); this.timer = undefined; }

    async run(): Promise<void> {
        if (this.running || !this.settings.enabled) return;
        this.running = true;
        const requests = [...this.projects].filter(([, project]) => !project.suspended)
            .map(([id, project]) => ({ id, project, revision: project.revision }));
        const current = (request: typeof requests[number]) => this.settings.enabled
            && this.projects.get(request.id) === request.project && !request.project.suspended && request.project.revision === request.revision;
        try {
            await this.flush();
            // Every tab is captured before any is written, so a slow write cannot mix in later edits.
            const snapshots: (typeof requests[number] & { snapshot: AutoSaveSnapshot })[] = [];
            for (const request of requests) {
                await request.project.ready;
                if (!current(request)) continue;
                try {
                    const snapshot = await this.capture(request.project.capture, () => current(request));
                    if (snapshot) snapshots.push({ ...request, snapshot });
                } catch (error) { if (current(request)) request.project.error = String(error); }
            }
            const changed: typeof snapshots = [];
            for (const request of snapshots) {
                const same = await sameBytes(request.project.baseline, request.snapshot.data);
                if (!current(request)) continue;
                if (same) request.project.error = undefined;
                else changed.push(request);
            }
            for (const request of changed) {
                if (!current(request)) continue;
                const { id, project, snapshot } = request;
                try {
                    const result = await this.save(id, snapshot, this.settings.maximum);
                    if (!current(request)) continue;
                    if (result.success) { project.baseline = snapshot.data; project.error = undefined; }
                    else if (!result.canceled) project.error = `${snapshot.name || '새 프로젝트'}: ${result.error ?? '자동저장 실패'}`;
                } catch (error) { if (current(request)) project.error = String(error); }
            }
            this.reportErrors();
        } catch (error) { this.reportError(String(error)); }
        finally { this.running = false; }
    }

    // The baseline is the state as registered: an edit while the scene is being read drops it, so the next cycle saves instead.
    private async setBaseline(id: string, project: AutoSaveProject): Promise<void> {
        const changes = this.changes(), revision = project.revision;
        const valid = (read: boolean) => this.projects.get(id) === project && project.revision === revision && (read || this.changes() === changes);
        try {
            const snapshot = await this.capture(project.capture, valid);
            if (snapshot) project.baseline = snapshot.data;
        } catch (error) { if (valid(true)) project.error = String(error); }
        this.reportErrors();
    }

    /** Runs a capture in slices, giving the page a turn between them; undefined when `valid` turns false. */
    private async capture(capture: AutoSaveCapture, valid: (read: boolean) => boolean): Promise<AutoSaveSnapshot | undefined> {
        const steps = capture();
        if (!('next' in steps)) return steps;
        let read = false, sliceStart = performance.now();
        for (;;) {
            const step = steps.next();
            if (step.done) return valid(true) ? step.value : undefined;
            if (step.value === true) read = true;
            if (performance.now() - sliceStart < sliceMs || hidden()) continue;
            await pageTurn();
            if (!valid(read)) return undefined;
            sliceStart = performance.now();
        }
    }

    private reportErrors(): void {
        this.reportError([...this.projects.values()].flatMap(project => project.error ? [project.error] : []).join('\n'));
    }
}
