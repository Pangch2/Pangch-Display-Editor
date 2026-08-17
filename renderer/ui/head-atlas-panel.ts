const playerHeadAtlasScroll = document.getElementById('player-head-atlas-scroll')!;
const playerHeadAtlasList = document.getElementById('player-head-atlas-list')!;
const clampPlayerHeadAtlasZoom = (zoom: number): number => Math.min(256, Math.max(1, zoom));
const clampPlayerHeadAtlasIndex = (index: number, count: number): number => Math.min(index, Math.max(0, count - 1));
let playerHeadAtlasZoom = 1;
let activePlayerHeadAtlas = 0;

const renderPlayerHeadAtlases = (canvases: HTMLCanvasElement[]): void => {
    activePlayerHeadAtlas = clampPlayerHeadAtlasIndex(activePlayerHeadAtlas, canvases.length);
    const box = document.createElement('div');
    box.className = 'player-head-atlas-box';
    if (canvases[activePlayerHeadAtlas]) box.append(canvases[activePlayerHeadAtlas]);
    playerHeadAtlasScroll.replaceChildren(box, playerHeadAtlasList);

    playerHeadAtlasList.hidden = canvases.length === 0;
    playerHeadAtlasList.replaceChildren(...canvases.map((canvas, index) => {
        const option = document.createElement('button');
        option.type = 'button';
        option.className = 'player-head-atlas-option';
        option.ariaPressed = String(index === activePlayerHeadAtlas);
        option.ariaLabel = `아틀라스 ${index + 1}, ${canvas.width} × ${canvas.height} 픽셀`;

        const thumbnail = document.createElement('canvas');
        thumbnail.width = thumbnail.height = 48;
        thumbnail.getContext('2d')?.drawImage(canvas, 0, 0, 48, 48);

        const description = document.createElement('span');
        description.className = 'player-head-atlas-description';
        const name = document.createElement('span');
        name.textContent = `아틀라스 ${index + 1}`;
        const resolution = document.createElement('span');
        resolution.textContent = `${canvas.width} × ${canvas.height} px`;
        description.append(name, resolution);
        option.append(thumbnail, description);
        option.addEventListener('click', () => {
            activePlayerHeadAtlas = index;
            renderPlayerHeadAtlases(canvases);
        });
        return option;
    }));
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

if (import.meta.env.DEV) {
    console.assert(clampPlayerHeadAtlasZoom(0) === 1 && clampPlayerHeadAtlasZoom(Infinity) === 256, 'Player head atlas zoom limits are broken.');
    console.assert(clampPlayerHeadAtlasIndex(2, 2) === 1 && clampPlayerHeadAtlasIndex(1, 0) === 0, 'Player head atlas selection limits are broken.');
}
