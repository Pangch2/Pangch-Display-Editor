import { autoSaveInterval, defaultAutoSaveSettings, type AutoSaveSettings } from './auto-save-settings.js';
import type { ProjectSaveResult } from '../project-file-store.js';

export type AutoSaveSnapshot = { name: string; data: Uint8Array };
type AutoSaveProject = { capture: () => AutoSaveSnapshot; baseline?: Uint8Array; revision: number; suspended: boolean; error?: string };

export class AutoSaveController {
    private projects = new Map<string, AutoSaveProject>();
    private settings = { ...defaultAutoSaveSettings };
    private timer: ReturnType<typeof setInterval> | undefined;
    private running = false;

    constructor(private flush: () => Promise<void>,
        private save: (id: string, snapshot: AutoSaveSnapshot, maximum: number) => Promise<ProjectSaveResult>,
        private reportError: (error: string) => void) {}

    register(id: string, capture: () => AutoSaveSnapshot): void {
        const project: AutoSaveProject = { capture, revision: 0, suspended: false };
        this.projects.set(id, project);
        try { project.baseline = capture().data; }
        catch (error) { project.error = String(error); }
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
            const snapshots: (typeof requests[number] & { snapshot: AutoSaveSnapshot })[] = [];
            for (const request of requests) {
                if (!current(request)) continue;
                const { project } = request;
                try {
                    const snapshot = project.capture();
                    const baseline = project.baseline;
                    if (baseline?.length === snapshot.data.length && baseline.every((value, index) => value === snapshot.data[index])) {
                        project.error = undefined;
                        continue;
                    }
                    snapshots.push({ ...request, snapshot });
                } catch (error) { if (current(request)) project.error = String(error); }
            }
            for (const request of snapshots) {
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

    private reportErrors(): void {
        this.reportError([...this.projects.values()].flatMap(project => project.error ? [project.error] : []).join('\n'));
    }
}
