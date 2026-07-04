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

export { loadedObjectGroup };

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

async function loadpbde(files: File | File[]): Promise<void> {
    const fileList = Array.isArray(files) ? files : [files];
    if (fileList.length === 0) return;

    const perceivedLoadStartMs = performance.now();

    // Use a single generation ID for the batch operation to ensure textures/materials are valid for all files.
    const batchGen = beginPbdeLoadGeneration();

    try {
        // First file: clear scene (isMerge = false)
        // Subsequent files: merge (isMerge = true)
        for (let i = 0; i < fileList.length; i++) {
            const isMerge = (i > 0); 
            await loadAndRenderPbde(fileList[i], isMerge, batchGen);
        }
        // Requirement: Do not perform multi-selection for "Open" (loadpbde) even with multiple files.
    } catch (e) {
        console.error("Error loading project files:", e);
    }
    window.dispatchEvent(new CustomEvent('pde:scene-updated'));
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
        <h3 style="margin-top: 0; color: #f0f0f0;">프로젝트 파일 감지됨</h3>
        <p style="color: #aaa; margin-bottom: 25px;">어떻게 열건가요?</p>
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

    const newProjectBtn = document.getElementById('new-project-btn') as HTMLButtonElement | null;
    if (newProjectBtn) {
        newProjectBtn.addEventListener('click', () => {
            if (files && files.length > 0) {
                loadpbde(files);
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

