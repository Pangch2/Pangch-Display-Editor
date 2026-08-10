export type RgbColor = [number, number, number];
export type OklchColor = [number, number, number];
type ColorPickerOptions = { oklch?: boolean; onOklchChange?: (enabled: boolean) => void; onClose?: () => void };

let picker: HTMLElement | null = null;
let anchor: HTMLElement | null = null;
let onInput: ((color: RgbColor) => void) | null = null;
let hue = 0;
let saturation = 0;
let value = 0;
let options: ColorPickerOptions = {};

const clampByte = (number: number): number => Math.round(Math.min(255, Math.max(0, number)));

const srgbChannel = (value: number): number => {
  const channel = value / 255;
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
};

const linearChannel = (value: number): number => clampByte((value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055) * 255);

export async function pickScreenColor(): Promise<RgbColor | null> {
  const EyeDropper = (window as unknown as { EyeDropper?: new () => { open: () => Promise<{ sRGBHex: string }> } }).EyeDropper;
  if (!EyeDropper) return null;
  try {
    const { sRGBHex } = await new EyeDropper().open();
    return [1, 3, 5].map(index => parseInt(sRGBHex.slice(index, index + 2), 16)) as RgbColor;
  } catch {
    return null;
  }
}

export function rgbToOklch([red, green, blue]: RgbColor): OklchColor {
  const r = srgbChannel(red);
  const g = srgbChannel(green);
  const b = srgbChannel(blue);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const lightness = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const labB = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return [lightness, Math.hypot(a, labB), (Math.atan2(labB, a) * 180 / Math.PI + 360) % 360];
}

export function oklchToRgb([lightness, chroma, colorHue]: OklchColor): RgbColor {
  const angle = colorHue * Math.PI / 180;
  const a = chroma * Math.cos(angle);
  const b = chroma * Math.sin(angle);
  const lRoot = lightness + 0.3963377774 * a + 0.2158037573 * b;
  const mRoot = lightness - 0.1055613458 * a - 0.0638541728 * b;
  const sRoot = lightness - 0.0894841775 * a - 1.291485548 * b;
  const l = lRoot ** 3;
  const m = mRoot ** 3;
  const s = sRoot ** 3;
  return [
    linearChannel(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    linearChannel(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    linearChannel(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)
  ];
}

export function hexToRgb(hex: string): RgbColor {
  return [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16)) as RgbColor;
}

export function rgbToHex(color: RgbColor): string {
  return `#${color.map(channel => clampByte(channel).toString(16).padStart(2, '0')).join('')}`;
}

function hsvToRgb(h: number, s: number, v: number): RgbColor {
  const chroma = v * s;
  const section = h / 60;
  const second = chroma * (1 - Math.abs(section % 2 - 1));
  const [red, green, blue] = section < 1 ? [chroma, second, 0]
    : section < 2 ? [second, chroma, 0]
    : section < 3 ? [0, chroma, second]
    : section < 4 ? [0, second, chroma]
    : section < 5 ? [second, 0, chroma]
    : [chroma, 0, second];
  const match = v - chroma;
  return [red, green, blue].map(channel => clampByte((channel + match) * 255)) as RgbColor;
}

function rgbToHsv([red, green, blue]: RgbColor): [number, number, number] {
  const [r, g, b] = [red / 255, green / 255, blue / 255];
  const maximum = Math.max(r, g, b);
  const minimum = Math.min(r, g, b);
  const delta = maximum - minimum;
  const nextHue = delta === 0 ? 0
    : maximum === r ? 60 * (((g - b) / delta) % 6)
    : maximum === g ? 60 * ((b - r) / delta + 2)
    : 60 * ((r - g) / delta + 4);
  return [(nextHue + 360) % 360, maximum === 0 ? 0 : delta / maximum, maximum];
}

function currentRgb(): RgbColor {
  return hsvToRgb(hue, saturation, value);
}

function syncPicker(emit = true, syncChannels = true): void {
  if (!picker) return;
  const color = currentRgb();
  picker.style.setProperty('--hue', String(hue));
  picker.querySelector<HTMLElement>('.color-picker-marker')!.style.left = `${saturation * 100}%`;
  picker.querySelector<HTMLElement>('.color-picker-marker')!.style.top = `${(1 - value) * 100}%`;
  picker.querySelector<HTMLInputElement>('.color-picker-hue')!.value = String(hue);
  picker.querySelector<HTMLInputElement>('.color-picker-hex')!.value = `#${color.map(channel => channel.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
  if (syncChannels) {
    const labels = picker.querySelectorAll<HTMLElement>('[data-channel-label]');
    const inputs = picker.querySelectorAll<HTMLInputElement>('[data-channel]');
    const channelValues = options.oklch ? rgbToOklch(color) : color;
    const channelLabels = options.oklch ? ['L', 'C', 'H'] : ['R', 'G', 'B'];
    labels.forEach((label, index) => { label.textContent = channelLabels[index]; });
    inputs.forEach((input, index) => {
      input.min = '0';
      input.max = options.oklch ? ['1', '0.5', '360'][index] : '255';
      input.step = options.oklch ? ['0.001', '0.001', '0.1'][index] : '1';
      input.value = options.oklch ? channelValues[index].toFixed(index === 2 ? 1 : 3) : String(channelValues[index]);
    });
  }
  if (emit) onInput?.(color);
}

function setSurfaceColor(event: PointerEvent): void {
  if (!picker) return;
  const surface = picker.querySelector<HTMLElement>('.color-picker-surface')!;
  const rect = surface.getBoundingClientRect();
  saturation = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
  value = 1 - Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height));
  syncPicker();
}

function positionPicker(): void {
  if (!picker || !anchor) return;
  const rect = anchor.getBoundingClientRect();
  picker.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - picker.offsetWidth - 8))}px`;
  picker.style.top = `${Math.max(8, Math.min(rect.bottom + 5, innerHeight - picker.offsetHeight - 8))}px`;
}

function closePicker(): void {
  if (picker) picker.hidden = true;
  options.onClose?.();
  anchor = null;
  onInput = null;
  options = {};
}

function createPicker(): HTMLElement {
  const element = document.createElement('section');
  element.className = 'color-picker';
  element.hidden = true;
  element.setAttribute('role', 'dialog');
  element.setAttribute('aria-label', '색상 선택');
  element.innerHTML = `
    <header><span>색상 선택</span><button type="button" aria-label="닫기">×</button></header>
    <div class="color-picker-surface"><span class="color-picker-marker"></span></div>
    <input class="color-picker-hue" type="range" min="0" max="359" aria-label="색조">
    <div class="color-picker-values">
      <button class="color-picker-eyedropper lucide-icon" type="button" title="색 스포이드" aria-label="색 스포이드">\uE13B</button>
      <label class="color-picker-oklch"><span>OKLCH</span><input type="checkbox"></label>
      <label class="color-picker-channel"><span data-channel-label>R</span><input class="pde-input" type="number" min="0" max="255" data-channel="r"></label>
      <label class="color-picker-channel"><span data-channel-label>G</span><input class="pde-input" type="number" min="0" max="255" data-channel="g"></label>
      <label class="color-picker-channel"><span data-channel-label>B</span><input class="pde-input" type="number" min="0" max="255" data-channel="b"></label>
      <input class="color-picker-hex pde-input" aria-label="16진수 색상" maxlength="7">
    </div>
    ${['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'].map(direction => `<span class="color-picker-resize color-picker-resize-${direction}" data-resize="${direction}"></span>`).join('')}`;
  const savedWidth = Number(localStorage.getItem('pdeColorPickerWidth'));
  const savedHeight = Number(localStorage.getItem('pdeColorPickerHeight'));
  if (savedWidth > 0) element.style.width = `${Math.min(savedWidth, innerWidth - 16)}px`;
  if (savedHeight > 0) element.style.height = `${Math.min(savedHeight, innerHeight - 16)}px`;
  document.body.append(element);

  const surface = element.querySelector<HTMLElement>('.color-picker-surface')!;
  surface.onpointerdown = event => {
    surface.setPointerCapture(event.pointerId);
    setSurfaceColor(event);
  };
  surface.onpointermove = event => { if (surface.hasPointerCapture(event.pointerId)) setSurfaceColor(event); };
  element.querySelector<HTMLInputElement>('.color-picker-hue')!.oninput = event => {
    hue = Number((event.target as HTMLInputElement).value);
    syncPicker();
  };
  element.querySelectorAll<HTMLInputElement>('[data-channel]').forEach(input => {
    input.oninput = () => {
      const values = [...element.querySelectorAll<HTMLInputElement>('[data-channel]')].map(field => Number(field.value));
      const rgb = options.oklch ? oklchToRgb(values as OklchColor) : values.map(clampByte) as RgbColor;
      const next = rgbToHsv(rgb);
      if (value === 0 && next[2] > 0) value = next[2];
      else [hue, saturation, value] = next;
      syncPicker();
    };
  });
  element.querySelector<HTMLInputElement>('.color-picker-hex')!.onchange = event => {
    const match = /^#?([\da-f]{6})$/i.exec((event.target as HTMLInputElement).value.trim());
    if (!match) return syncPicker(false);
    const rgb = [0, 2, 4].map(index => parseInt(match[1].slice(index, index + 2), 16)) as RgbColor;
    [hue, saturation, value] = rgbToHsv(rgb);
    syncPicker();
  };
  element.querySelector<HTMLElement>('header button')!.onclick = closePicker;
  element.querySelector<HTMLInputElement>('.color-picker-oklch input')!.onchange = event => {
    options.oklch = (event.target as HTMLInputElement).checked;
    options.onOklchChange?.(!!options.oklch);
    syncPicker(false);
  };
  element.querySelector<HTMLButtonElement>('.color-picker-eyedropper')!.onclick = async () => {
    const rgb = await pickScreenColor();
    if (!rgb) return;
    [hue, saturation, value] = rgbToHsv(rgb);
    syncPicker();
  };
  element.querySelectorAll<HTMLElement>('[data-resize]').forEach(handle => {
    handle.onpointerdown = event => {
      event.preventDefault();
      handle.setPointerCapture(event.pointerId);
      const direction = handle.dataset.resize!;
      const start = element.getBoundingClientRect();
      const startX = event.clientX;
      const startY = event.clientY;
      handle.onpointermove = moveEvent => {
        if (!handle.hasPointerCapture(moveEvent.pointerId)) return;
        const deltaX = moveEvent.clientX - startX;
        const deltaY = moveEvent.clientY - startY;
        const minimumWidth = 300;
        const minimumHeight = 300;
        const right = start.right;
        const bottom = start.bottom;
        let left = direction.includes('w') ? Math.min(right - minimumWidth, Math.max(8, start.left + deltaX)) : start.left;
        let top = direction.includes('n') ? Math.min(bottom - minimumHeight, Math.max(8, start.top + deltaY)) : start.top;
        let width = direction.includes('w') ? right - left : direction.includes('e') ? Math.max(minimumWidth, Math.min(innerWidth - start.left - 8, start.width + deltaX)) : start.width;
        let height = direction.includes('n') ? bottom - top : direction.includes('s') ? Math.max(minimumHeight, Math.min(innerHeight - start.top - 8, start.height + deltaY)) : start.height;
        width = Math.min(width, innerWidth - left - 8);
        height = Math.min(height, innerHeight - top - 8);
        element.style.left = `${left}px`;
        element.style.top = `${top}px`;
        element.style.width = `${width}px`;
        element.style.height = `${height}px`;
      };
    };
  });
  new ResizeObserver(() => {
    if (element.hidden || !element.offsetWidth || !element.offsetHeight) return;
    localStorage.setItem('pdeColorPickerWidth', String(element.offsetWidth));
    localStorage.setItem('pdeColorPickerHeight', String(element.offsetHeight));
  }).observe(element);
  document.addEventListener('pointerdown', event => {
    if (!element.hidden && !element.contains(event.target as Node) && !anchor?.contains(event.target as Node)) closePicker();
  }, true);
  window.addEventListener('resize', positionPicker);
  return element;
}

export function openColorPicker(target: HTMLElement, color: RgbColor, update: (color: RgbColor) => void, pickerOptions: ColorPickerOptions = {}): void {
  picker ??= createPicker();
  if (!picker.hidden) options.onClose?.();
  anchor = target;
  onInput = update;
  options = pickerOptions;
  [hue, saturation, value] = rgbToHsv(color);
  picker.hidden = false;
  picker.querySelector<HTMLInputElement>('.color-picker-oklch input')!.checked = !!options.oklch;
  syncPicker(false);
  positionPicker();
}

if (import.meta.env.DEV) {
  console.assert(hsvToRgb(...rgbToHsv([255, 0, 0])).join() === '255,0,0', 'Color picker RGB/HSV conversion failed.');
  console.assert(oklchToRgb(rgbToOklch([255, 0, 0])).join() === '255,0,0', 'Color picker OKLCH conversion failed.');
}
