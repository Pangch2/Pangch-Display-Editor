const playerHeadAtlasScroll = document.getElementById('player-head-atlas-scroll')!;
const clampPlayerHeadAtlasZoom = (zoom: number): number => Math.min(256, Math.max(1, zoom));
let playerHeadAtlasZoom = 1;

const renderPlayerHeadAtlases = (canvases: HTMLCanvasElement[]): void => {
    const boxes = (canvases.length ? canvases : [null]).map(canvas => {
        const box = document.createElement('div');
        box.className = 'player-head-atlas-box';
        if (canvas) box.append(canvas);
        return box;
    });
    playerHeadAtlasScroll.replaceChildren(...boxes);
};

window.addEventListener('pde:player-head-atlases-changed', event => {
    renderPlayerHeadAtlases((event as CustomEvent<HTMLCanvasElement[]>).detail);
});

playerHeadAtlasScroll.addEventListener('wheel', event => {
    if (!(event.target instanceof Element)) return;
    const box = event.target.closest<HTMLElement>('.player-head-atlas-box');
    const canvas = box?.querySelector('canvas');
    if (!box || !canvas) return;
    event.preventDefault();
    const before = canvas.getBoundingClientRect();
    const textureX = (event.clientX - before.left) / before.width;
    const textureY = (event.clientY - before.top) / before.height;
    playerHeadAtlasZoom = clampPlayerHeadAtlasZoom(playerHeadAtlasZoom * (event.deltaY < 0 ? 1.15 : 1 / 1.15));
    playerHeadAtlasScroll.style.setProperty('--player-head-atlas-zoom', String(playerHeadAtlasZoom));
    const after = canvas.getBoundingClientRect();
    box.scrollLeft += after.left + textureX * after.width - event.clientX;
    box.scrollTop += after.top + textureY * after.height - event.clientY;
}, { passive: false });

renderPlayerHeadAtlases([]);

if (import.meta.env.DEV) console.assert(clampPlayerHeadAtlasZoom(0) === 1 && clampPlayerHeadAtlasZoom(Infinity) === 256, 'Player head atlas zoom limits are broken.');
