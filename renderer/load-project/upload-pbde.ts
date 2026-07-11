import { openWithAnimation, closeWithAnimation } from '../ui/ui-open-close.js';
import * as THREE from 'three/webgpu';
import { beginPbdeLoadGeneration, loadAndRenderPbde, loadedObjectGroup, performSelection } from './mesh-builder';
import { isPbdeLogEnabled, pbdeLogNames } from './pbde-log';

type ModalOverlayElement = HTMLDivElement & { escHandler?: (event: KeyboardEvent) => void };
type ScenePrecompileTrace = {
    available: boolean;
    profileEnabled: boolean;
    compileMs: number;
    profileMs: number;
    fullCompileMs: number;
    gpuQueueWaitMs: number;
    objectTraces: ScenePrecompileObjectTrace[];
};
type ScenePrecompileObjectTrace = {
    index: number;
    name: string;
    compileMs: number;
    instanceCount: number;
    materialCount: number;
    attributeKey: string;
    vertexCount: number;
};
type RenderSettledFrameTrace = {
    index: number;
    frameIntervalMs: number;
    renderCpuMs: number;
    gpuQueueWaitMs: number;
    gpuQueueAvailable: boolean;
};
type RenderSettledTrace = {
    requestedFrames: number;
    renderedFrames: number;
    frameWaitMs: number;
    gpuWaitMs: number;
    totalMs: number;
    frameIntervalsMs: number[];
    frameTraces: RenderSettledFrameTrace[];
    gpuQueueAvailable: boolean;
};
type RenderSettledDetail = {
    frames: number;
    traceFrames: boolean;
    waitForGpu: boolean;
    resolve: (trace: RenderSettledTrace) => void;
};
type ScenePrecompileDetail = {
    resolve: (trace: ScenePrecompileTrace) => void;
};
type CameraState = {
    position: [number, number, number];
    target: [number, number, number];
    zoom: number;
};
type ProjectState = {
    id: string;
    children: THREE.Object3D[];
    data: Record<string, unknown>;
    camera?: CameraState;
};

const projects: ProjectState[] = [];
let activeProject = -1;
let projectTabDropMarkerEl: HTMLElement | null = null;
let projectTabDropMarkerClass: 'project-tab-drop-before' | 'project-tab-drop-after' | null = null;

export { loadedObjectGroup };

function clearProjectTabDropMarker(): void {
    if (projectTabDropMarkerEl && projectTabDropMarkerClass) {
        projectTabDropMarkerEl.classList.remove(projectTabDropMarkerClass);
    }
    projectTabDropMarkerEl = null;
    projectTabDropMarkerClass = null;
}

function applyProjectTabDropMarker(row: HTMLElement, mode: 'before' | 'after'): void {
    const markerClass = mode === 'before' ? 'project-tab-drop-before' : 'project-tab-drop-after';
    if (projectTabDropMarkerEl === row && projectTabDropMarkerClass === markerClass) return;
    clearProjectTabDropMarker();
    row.classList.add(markerClass);
    projectTabDropMarkerEl = row;
    projectTabDropMarkerClass = markerClass;
}

function updateProjectDetails(): void {
    const details = loadedObjectGroup.userData.projectDetails as Record<string, string> | undefined;
    const panel = document.getElementById('project-details');
    if (!panel) return;

    panel.hidden = false;
    document.title = details?.name ? `PDE - ${details.name}` : 'PDE';
    for (const key of ['name', 'mainNBT', 'nbt']) {
        const input = document.getElementById(`project-${key}`) as HTMLInputElement | null;
        if (!input) continue;
        input.value = details?.[key] || '';
        input.oninput = () => {
            if (!details) return;
            details[key] = input.value;
            if (key === 'name') {
                document.title = input.value ? `PDE - ${input.value}` : 'PDE';
                saveActiveProject();
                renderProjectTabs();
            }
        };
    }
}

function saveActiveProject(): void {
    if (activeProject < 0) return;
    projects[activeProject].children = [...loadedObjectGroup.children];
    projects[activeProject].data = Object.fromEntries(
        Object.entries(loadedObjectGroup.userData).filter(([, value]) => typeof value !== 'function')
    );
    const detail: { state?: CameraState } = {};
    window.dispatchEvent(new CustomEvent('pde:get-camera-state', { detail }));
    projects[activeProject].camera = detail.state;
}

function switchProject(index: number): void {
    if (index < 0 || index >= projects.length || index === activeProject) return;
    loadedObjectGroup.userData.resetSelection?.();
    saveActiveProject();
    loadedObjectGroup.clear();
    for (const [key, value] of Object.entries(loadedObjectGroup.userData)) {
        if (typeof value !== 'function') delete loadedObjectGroup.userData[key];
    }
    activeProject = index;
    Object.assign(loadedObjectGroup.userData, projects[index].data);
    for (const child of projects[index].children) loadedObjectGroup.add(child);
    if (projects[index].camera) {
        window.dispatchEvent(new CustomEvent('pde:set-camera-state', { detail: projects[index].camera }));
    }
    updateProjectDetails();
    renderProjectTabs();
    window.dispatchEvent(new CustomEvent('pde:scene-updated'));
}

function addProject(): void {
    saveActiveProject();
    projects.push({ id: crypto.randomUUID(), children: [], data: {} });
    switchProject(projects.length - 1);
}

function deleteProject(index: number): void {
    if (index < 0 || index >= projects.length || projects.length === 1) return;
    if (index !== activeProject) {
        const activeId = projects[activeProject]?.id;
        projects.splice(index, 1);
        activeProject = projects.findIndex(project => project.id === activeId);
        renderProjectTabs();
        return;
    }
    loadedObjectGroup.userData.resetSelection?.();
    loadedObjectGroup.clear();
    for (const [key, value] of Object.entries(loadedObjectGroup.userData)) {
        if (typeof value !== 'function') delete loadedObjectGroup.userData[key];
    }
    const nextIndex = Math.min(index, projects.length - 2);
    projects.splice(index, 1);
    activeProject = -1;
    if (projects.length) switchProject(nextIndex);
    else {
        updateProjectDetails();
        renderProjectTabs();
        window.dispatchEvent(new CustomEvent('pde:scene-updated'));
    }
}

function renderProjectTabs(): void {
    clearProjectTabDropMarker();
    const previous = document.getElementById('previous-project') as HTMLButtonElement | null;
    const next = document.getElementById('next-project') as HTMLButtonElement | null;
    const tab = document.getElementById('project-tab') as HTMLButtonElement | null;
    const menu = document.getElementById('project-tab-menu');
    if (!previous || !next || !tab || !menu) return;
    const enabled = projects.length > 1;
    previous.disabled = !enabled;
    next.disabled = !enabled;
    const name = (projects[activeProject]?.data.projectDetails as Record<string, string> | undefined)?.name;
    tab.textContent = name || '프로젝트 탭';
    menu.replaceChildren(...projects.map((project, index) => {
        const row = document.createElement('div');
        row.className = 'project-tab-row';
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'project-tab-option';
        button.draggable = true;
        button.classList.toggle('active', index === activeProject);
        button.textContent = (project.data.projectDetails as Record<string, string> | undefined)?.name || `새 프로젝트 ${index + 1}`;
        button.onclick = () => switchProject(index);
        button.ondragstart = event => {
            event.dataTransfer?.setData('text/project-index', String(index));
            if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
        };
        button.ondragend = clearProjectTabDropMarker;
        row.ondragover = event => {
            const from = Number(event.dataTransfer?.getData('text/project-index'));
            if (!Number.isInteger(from)) return;
            event.preventDefault();
            const rect = row.getBoundingClientRect();
            applyProjectTabDropMarker(row, event.clientY < rect.top + rect.height / 2 ? 'before' : 'after');
        };
        row.ondrop = event => {
            event.preventDefault();
            const from = Number(event.dataTransfer?.getData('text/project-index'));
            if (!Number.isInteger(from)) return;
            const rect = row.getBoundingClientRect();
            const mode = event.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
            clearProjectTabDropMarker();
            saveActiveProject();
            const activeId = projects[activeProject].id;
            const [moved] = projects.splice(from, 1);
            let insertAt = index + (mode === 'after' ? 1 : 0);
            if (from < insertAt) insertAt--;
            projects.splice(insertAt, 0, moved);
            activeProject = projects.findIndex(item => item.id === activeId);
            renderProjectTabs();
        };
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'delete-project';
        remove.innerHTML = '&#xE18E;';
        remove.title = `${button.textContent} 삭제`;
        remove.setAttribute('aria-label', remove.title);
        remove.disabled = projects.length === 1;
        remove.onclick = event => {
            event.stopPropagation();
            deleteProject(index);
        };
        row.append(button, remove);
        return row;
    }), (() => {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = '+ 추가 프로젝트 창';
        button.onclick = addProject;
        return button;
    })());
}

document.addEventListener('DOMContentLoaded', () => {
    const tabs = document.getElementById('project-tabs');
    const menu = document.getElementById('project-tab-menu');
    tabs?.addEventListener('dragstart', event => event.stopPropagation());
    document.getElementById('previous-project')?.addEventListener('click', () => switchProject((activeProject - 1 + projects.length) % projects.length));
    document.getElementById('next-project')?.addEventListener('click', () => switchProject((activeProject + 1) % projects.length));
    document.getElementById('project-tab')?.addEventListener('click', event => {
        event.stopPropagation();
        if (menu) menu.hidden = !menu.hidden;
    });
    document.addEventListener('click', event => {
        if (!menu || !tabs) return;
        if (event.composedPath().includes(tabs)) return;
        menu.hidden = true;
    });
    menu?.addEventListener('dragend', clearProjectTabDropMarker);
    addProject();
});

function waitForScenePrecompiled(): Promise<ScenePrecompileTrace> {
    return new Promise(resolve => {
        window.dispatchEvent(new CustomEvent<ScenePrecompileDetail>('pde:precompile-scene', {
            detail: { resolve }
        }));
    });
}

function waitForRenderSettled(frames = 3, traceFrames = false, waitForGpu = false): Promise<RenderSettledTrace> {
    return new Promise(resolve => {
        window.dispatchEvent(new CustomEvent<RenderSettledDetail>('pde:wait-render-settled', {
            detail: { frames, traceFrames, waitForGpu, resolve }
        }));
    });
}

async function logFinalPbdeLoadTime(startMs: number, mode: 'open' | 'merge', fileCount: number): Promise<void> {
    const logFinalLoadTime = isPbdeLogEnabled(pbdeLogNames.finalLoadTime);
    const logRenderSettleWait = isPbdeLogEnabled(pbdeLogNames.renderSettleWait);
    const logRenderSettleTrace = isPbdeLogEnabled(pbdeLogNames.renderSettleTrace);
    const logRenderSettleFrameTrace = isPbdeLogEnabled(pbdeLogNames.renderSettleFrameTrace);
    if (!logFinalLoadTime && !logRenderSettleWait && !logRenderSettleTrace && !logRenderSettleFrameTrace) return;

    const traceFrames = logRenderSettleTrace || logRenderSettleFrameTrace;
    const waitForGpu = true;
    const renderSettleStartMs = performance.now();
    const settleTrace = await waitForRenderSettled(1, traceFrames, waitForGpu);
    const renderSettleElapsedMs = performance.now() - renderSettleStartMs;
    const firstRenderTrace = settleTrace.frameTraces[0];
    const maxRenderCpuMs = settleTrace.frameTraces.reduce((max, trace) => Math.max(max, trace.renderCpuMs), 0);
    const maxQueueObservedMs = settleTrace.frameTraces.reduce((max, trace) => Math.max(max, trace.gpuQueueWaitMs), 0);

    const elapsedSeconds = (performance.now() - startMs) / 1000;
    if (logRenderSettleWait) {
        console.log(`[PBDE] Render settle wait: ${renderSettleElapsedMs.toFixed(2)}ms (${mode}, ${fileCount} file${fileCount === 1 ? '' : 's'}).`);
    }
    if (logRenderSettleTrace) {
        console.log(
            `[PBDE][RenderSettleTrace] requestedFrames=${settleTrace.requestedFrames}, renderedFrames=${settleTrace.renderedFrames}, frameWait=${settleTrace.frameWaitMs.toFixed(2)}ms, postLastFrameGpuWait=${settleTrace.gpuWaitMs.toFixed(2)}ms, firstRenderCpu=${(firstRenderTrace?.renderCpuMs ?? 0).toFixed(2)}ms, maxRenderCpu=${maxRenderCpuMs.toFixed(2)}ms, maxQueueObserved=${settleTrace.gpuQueueAvailable ? `${maxQueueObservedMs.toFixed(2)}ms` : 'missing'}, queue=${settleTrace.gpuQueueAvailable ? 'available' : 'missing'}, frameIntervals=${settleTrace.frameIntervalsMs.map(ms => ms.toFixed(2)).join('/') || '-'}.`
        );
    }
    if (logRenderSettleFrameTrace) {
        console.log(
            `[PBDE][RenderSettleFrameTrace] ${settleTrace.frameTraces.map(trace => `#${trace.index}: interval=${trace.frameIntervalMs.toFixed(2)}ms, renderCpu=${trace.renderCpuMs.toFixed(2)}ms, queueSinceSubmit=${trace.gpuQueueAvailable ? `${trace.gpuQueueWaitMs.toFixed(2)}ms` : 'missing'}`).join('; ') || '-'}${settleTrace.gpuQueueAvailable ? ' (queueSinceSubmit values can overlap)' : ''}.`
        );
    }
    if (logFinalLoadTime) {
        console.log(`[PBDE] Final load time: ${elapsedSeconds.toFixed(2)}s (${mode}, ${fileCount} file${fileCount === 1 ? '' : 's'}, after GPU work settled).`);
    }
}

async function precompileLoadedScene(mode: 'open' | 'merge', fileCount: number): Promise<void> {
    if (localStorage.getItem('pdeAwaitScenePrecompile') !== '1') {
        if (isPbdeLogEnabled(pbdeLogNames.scenePrecompileSkipped)) {
            console.log(`[PBDE] Scene precompile skipped: set localStorage.pdeAwaitScenePrecompile='1' to await compileAsync (${mode}, ${fileCount} file${fileCount === 1 ? '' : 's'}).`);
        }
        return;
    }

    const precompileStartMs = performance.now();
    const trace = await waitForScenePrecompiled();
    const elapsedMs = performance.now() - precompileStartMs;
    const topObjectTraces = [...trace.objectTraces]
        .sort((a, b) => b.compileMs - a.compileMs)
        .slice(0, 10);
    const objectCompileSumMs = trace.objectTraces.reduce((sum, item) => sum + item.compileMs, 0);
    const topObjectCompileSumMs = topObjectTraces.reduce((sum, item) => sum + item.compileMs, 0);
    if (isPbdeLogEnabled(pbdeLogNames.scenePrecompile)) {
        console.log(
            `[PBDE] Scene precompile: total=${elapsedMs.toFixed(2)}ms, compile=${trace.compileMs.toFixed(2)}ms, profile=${trace.profileMs.toFixed(2)}ms, fullCompile=${trace.fullCompileMs.toFixed(2)}ms, gpuWait=${trace.gpuQueueWaitMs.toFixed(2)}ms, profiled=${trace.profileEnabled ? 'yes' : 'no'}, objectProfiles=${trace.objectTraces.length}, objectSum=${objectCompileSumMs.toFixed(2)}ms, top10Sum=${topObjectCompileSumMs.toFixed(2)}ms, available=${trace.available ? 'yes' : 'no'} (${mode}, ${fileCount} file${fileCount === 1 ? '' : 's'}).`
        );
    }
    if (trace.profileEnabled && isPbdeLogEnabled(pbdeLogNames.precompileTrace)) {
        console.log(
            `[PBDE][PrecompileTrace] ${topObjectTraces.map(item => `#${item.index}: compile=${item.compileMs.toFixed(2)}ms, instances=${item.instanceCount}, materials=${item.materialCount}, vertices=${item.vertexCount}, attrs=${item.attributeKey}, name=${item.name}`).join('; ') || '-'}.`
        );
    }
}

async function loadpbde(files: File | File[], reuseCurrentProject = false): Promise<void> {
    const fileList = Array.isArray(files) ? files : [files];
    if (fileList.length === 0) return;

    const perceivedLoadStartMs = performance.now();

    try {
        for (const file of fileList) {
            if (!reuseCurrentProject && (activeProject < 0 || projects[activeProject].children.length > 0 || projects[activeProject].data.projectDetails)) addProject();
            await loadAndRenderPbde(file, false, beginPbdeLoadGeneration());
            updateProjectDetails();
            saveActiveProject();
            renderProjectTabs();
            window.dispatchEvent(new CustomEvent('pde:scene-updated'));
        }
    } catch (e) {
        console.error("Error loading project files:", e);
    }
    await precompileLoadedScene('open', fileList.length);
    await logFinalPbdeLoadTime(perceivedLoadStartMs, 'open', fileList.length);
}

async function mergepbde(files: File | File[]): Promise<void> {
    const fileList = Array.isArray(files) ? files : [files];
    if (fileList.length === 0) return;

    const perceivedLoadStartMs = performance.now();

    const batchGen = beginPbdeLoadGeneration();
    const allNewMeshes = new Set<THREE.Object3D>();

    try {
        for (const file of fileList) {
            // Merge always appends (isMerge = true)
            const newMeshes = await loadAndRenderPbde(file, true, batchGen);
            newMeshes.forEach(m => allNewMeshes.add(m));
        }

        // Requirement: Select all newly added objects after all files are loaded.
        performSelection(allNewMeshes);

    } catch (e) {
        console.error("Error merging project files:", e);
    }
    window.dispatchEvent(new CustomEvent('pde:scene-updated'));
    await precompileLoadedScene('merge', fileList.length);
    await logFinalPbdeLoadTime(perceivedLoadStartMs, 'merge', fileList.length);
}


// 파일 드래그 앤 드롭 처리 로직

function createDropModal(files?: File[]) {
    const existingModal = document.getElementById('drop-modal-overlay');
    if (existingModal) {
        existingModal.remove();
    }
    const modalOverlay = document.createElement('div') as ModalOverlayElement;
    modalOverlay.id = 'drop-modal-overlay';
    Object.assign(modalOverlay.style, {
        position: 'fixed',
        top: 0,
        left: 0,
        width: '100%',
        height: '100%',
        background: 'rgba(0, 0, 0, 0.6)',
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        zIndex: 10000
    });

    const modalContent = document.createElement('div');
    Object.assign(modalContent.style, {
        background: '#2a2a2e',
        padding: '30px',
        borderRadius: '12px',
        border: '1px solid #3a3a3e',
        textAlign: 'center',
        boxShadow: '0 5px 15px rgba(0,0,0,0.3)',
    });
    
    openWithAnimation(modalContent);

    modalContent.innerHTML = `
        <h3 style="margin: 0 0 4px; color: #f0f0f0;">프로젝트 파일 감지됨</h3>
        <p style="color: #aaa; margin: 0 0 6px; font-size: 16px;">어떻게 열건가요?</p>
        <label style="display: flex; align-items: center; justify-content: center; gap: 5px; margin-bottom: 15px; color: #ccc; cursor: pointer; font-size: 14px;">
            <input id="reuse-current-project" type="checkbox">
            현재 프로젝트에서 열기
        </label>
        <div style="display: flex; gap: 15px;">
            <button id="new-project-btn" class="project-ui-button">프로젝트 열기</button>
            <button id="merge-project-btn" class="project-ui-button">프로젝트 합치기</button>
        </div>
    `;

    modalOverlay.appendChild(modalContent);
    document.body.appendChild(modalOverlay);

    modalOverlay.addEventListener('click', (e) => {
        if (e.target === modalOverlay) {
            closeDropModal();
        }
    });
    const handleEscKey = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
            closeDropModal();
        }
    };
    modalOverlay.escHandler = handleEscKey;
    document.addEventListener('keydown', handleEscKey);

    const reuseCurrentProject = document.getElementById('reuse-current-project') as HTMLInputElement | null;
    if (reuseCurrentProject) {
        reuseCurrentProject.checked = localStorage.getItem('pdeReuseCurrentProject') === '1';
        reuseCurrentProject.addEventListener('change', () => {
            localStorage.setItem('pdeReuseCurrentProject', reuseCurrentProject.checked ? '1' : '0');
        });
    }

    const newProjectBtn = document.getElementById('new-project-btn') as HTMLButtonElement | null;
    if (newProjectBtn) {
        newProjectBtn.addEventListener('click', () => {
            if (files && files.length > 0) {
                loadpbde(files, reuseCurrentProject?.checked);
            }
            closeDropModal();
        });
    }

    const mergeProjectBtn = document.getElementById('merge-project-btn') as HTMLButtonElement | null;
    if (mergeProjectBtn) {
        mergeProjectBtn.addEventListener('click', () => {
            if (files && files.length > 0) {
                mergepbde(files);
            }
            closeDropModal();
        });
    }
}

function closeDropModal() {
    const modal = document.getElementById('drop-modal-overlay') as ModalOverlayElement | null;
    if (modal) {
        if (modal.escHandler) {
            document.removeEventListener('keydown', modal.escHandler);
        }

        const modalContent = modal.querySelector('div');
        if (modalContent) {
            closeWithAnimation(modalContent).then(() => {
                modal.remove();
            });
        } else {
            modal.remove();
        }
    }
}

window.addEventListener('dragover', (e) => {
    e.preventDefault();
});

window.addEventListener('drop', (e) => {
    e.preventDefault();
    
    const validFiles: File[] = [];
    
    if (e.dataTransfer.items) {
        for (const item of e.dataTransfer.items) {
            if (item.kind === 'file') {
                const file = item.getAsFile();
                if (file) {
                    const extension = file.name.split('.').pop()?.toLowerCase();
                    if (extension === 'bdengine' || extension === 'pdengine') {
                        validFiles.push(file);
                    }
                }
            }
        }
    } else {
        for (const file of e.dataTransfer.files) {  
            const extension = file.name.split('.').pop()?.toLowerCase();
            if (extension === 'bdengine' || extension === 'pdengine') {
                validFiles.push(file);
            }
        }
    }

    if (validFiles.length > 0) {
        createDropModal(validFiles);
    }
});

