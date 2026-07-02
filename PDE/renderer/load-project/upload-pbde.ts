import { openWithAnimation, closeWithAnimation } from '../ui/ui-open-close.js';
import * as THREE from 'three/webgpu';
import { beginPbdeLoadGeneration, loadAndRenderPbde, loadedObjectGroup, performSelection } from './mesh-builder';

type ModalOverlayElement = HTMLDivElement & { escHandler?: (event: KeyboardEvent) => void };
type RenderSettledDetail = {
    frames: number;
    resolve: () => void;
};

export { loadedObjectGroup };

function waitForRenderSettled(frames = 3): Promise<void> {
    return new Promise(resolve => {
        window.dispatchEvent(new CustomEvent<RenderSettledDetail>('pde:wait-render-settled', {
            detail: { frames, resolve }
        }));
    });
}

async function logFinalPbdeLoadTime(startMs: number, mode: 'open' | 'merge', fileCount: number): Promise<void> {
    const renderSettleStartMs = performance.now();
    await waitForRenderSettled();
    const renderSettleElapsedMs = performance.now() - renderSettleStartMs;

    const elapsedSeconds = (performance.now() - startMs) / 1000;
    console.log(`[PBDE] Render settle wait: ${renderSettleElapsedMs.toFixed(2)}ms (${mode}, ${fileCount} file${fileCount === 1 ? '' : 's'}).`);
    console.log(`[PBDE] Final load time: ${elapsedSeconds.toFixed(2)}s (${mode}, ${fileCount} file${fileCount === 1 ? '' : 's'}, after materials + scene panel + rendered frames).`);
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

