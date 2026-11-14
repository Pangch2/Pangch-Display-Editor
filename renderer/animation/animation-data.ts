import { Euler, Matrix3, Matrix4, Quaternion, Vector3 } from 'three/webgpu';
import { decomposeDisplayMatrix, needsDecomposedTransformation, type DisplayTransformParts } from './display-transformation';
import type { TextDisplayOptions } from '../load-project/display/text-display';
import { compileMathExpression } from '../math-expression';

export type AnimationTransform = number[] | DisplayTransformParts;
// The curve belongs to the segment ending at this key; absent means linear.
export const animationEasings = ['sine-in', 'sine-out', 'sine-in-out', 'back-in', 'back-out', 'elastic-in', 'elastic-out', 'bounce-in', 'bounce-out'] as const;
export type AnimationCurve = 'step' | typeof animationEasings[number] | [number, number, number, number];
export type AnimationProperties = {
    nbt: string;
    brightness?: { sky: number; block: number } | null;
    name?: string;
    displayType?: 'block_display' | 'item_display' | 'text_display';
    options?: TextDisplayOptions;
};
export type AnimationChannel = 'translation' | 'rotation' | 'scale';
export const animationChannels: AnimationChannel[] = ['translation', 'rotation', 'scale'];
export type AnimationVector = [number | string, number | string, number | string];
export type AnimationKey = { tick: number; transform: AnimationTransform; curve?: AnimationCurve; texture?: string; properties?: AnimationProperties; pivot?: number[] | null;
    channels?: AnimationChannel[]; curves?: Partial<Record<AnimationChannel, AnimationCurve>>;
    values?: Partial<Record<AnimationChannel, AnimationVector>>; pre?: Partial<Record<AnimationChannel, AnimationVector>> };
// Item name of the camera object's default model, drawn from the lucide camera glyph (pbde/camera-item-assets.ts).
export const animationCameraItem = 'pde:camera';
export type AnimationTrack = { type: 'group' | 'object'; id: string; keys: AnimationKey[] };
export type AnimationLayerTiming = { id: string; starts: number[]; interval?: number };
export type AnimationClip = { id?: string; name?: string; duration: number; tickRate?: number; tracks: AnimationTrack[];
    loopMode?: 'once' | 'hold' | 'loop'; loopDelay?: number; endTick?: number; transitionTicks?: number; excludedNodes?: string[];
    layers?: string[]; layerTimings?: AnimationLayerTiming[] };
// The original timeline remains the first clip so old projects retain their data. `camera` is the object the view follows.
export type AnimationData = AnimationClip & { clips?: AnimationClip[]; activeClip?: string; camera?: string };
export const ticksPerSecond = 20;

export function animationClips(data: AnimationData): AnimationClip[] { return [data, ...(data.clips ?? [])]; }
export function activeAnimation(data: AnimationData): AnimationClip {
    return animationClips(data).find(clip => (clip.id ?? 'default') === data.activeClip) ?? data;
}
export function animationLayers(data: AnimationData, primary = activeAnimation(data)): AnimationClip[] {
    // Older projects shared the first clip's layers across all clips.
    const ids = primary.layers ?? data.layers;
    return animationClips(data).filter(clip => clip !== primary && ids?.includes(clip.id ?? 'default'));
}
export function animationEndTick(clip: AnimationClip): number {
    return clip.endTick ?? clip.tracks.reduce((last, track) => Math.max(last, track.keys[track.keys.length - 1]?.tick ?? 0), 0);
}
export function animationPlayback(clip: AnimationClip, elapsed: number): { tick: number; finished: boolean } {
    const end = animationEndTick(clip), tick = Math.max(0, elapsed), finished = tick >= end + 1;
    if (clip.loopMode === 'loop') return { tick: Math.min(end, tick % (end + 1 + (clip.loopDelay ?? 0))), finished: false };
    return { tick: finished && clip.loopMode === 'once' ? 0 : Math.min(end, tick), finished };
}
export function animationLayerPlayback(primary: AnimationClip, layer: AnimationClip, elapsed: number, seconds = elapsed / (primary.tickRate ?? ticksPerSecond)):
    { tick: number | undefined; finished: boolean } {
    const timing = primary.layerTimings?.find(timing => timing.id === (layer.id ?? 'default'));
    if (!timing) return animationPlayback(layer, seconds * (layer.tickRate ?? ticksPerSecond));
    const rate = (layer.tickRate ?? ticksPerSecond) / (primary.tickRate ?? ticksPerSecond), end = animationEndTick(layer);
    const finished = timing.interval === undefined && (!timing.starts.length || elapsed >= timing.starts[timing.starts.length - 1] + (end + 1) / rate);
    let start: number | undefined;
    for (const tick of timing.starts) { if (tick > elapsed) break; start = tick; }
    if (start === undefined) return { tick: undefined, finished };
    const tick = (timing.interval === undefined ? elapsed - start : (elapsed - start) % timing.interval) * rate;
    return { tick: tick < end + 1 ? Math.min(end, tick) : undefined, finished };
}
export function animationTimelineEnd(data: AnimationData, primary = activeAnimation(data)): number {
    return animationLayers(data, primary).reduce((end, layer) => {
        const timing = primary.layerTimings?.find(timing => timing.id === (layer.id ?? 'default'));
        if (!timing?.starts.length) return end;
        return Math.max(end, timing.starts[timing.starts.length - 1] + Math.ceil((animationEndTick(layer) + 1)
            * (primary.tickRate ?? ticksPerSecond) / (layer.tickRate ?? ticksPerSecond)) - 1);
    }, animationEndTick(primary));
}

const expressionCache = new Map<string, NonNullable<ReturnType<typeof compileMathExpression>>>();
export function animationExpression(source: string, tick: number, rate = ticksPerSecond, t = 0, value = 0): number {
    let expression = expressionCache.get(source);
    if (!expression) {
        expression = compileMathExpression(source, ['time', 'tick', 't', 'value']);
        if (!expression) throw new Error(`잘못된 애니메이션 수식: ${source}`);
        if (expressionCache.size >= 256) expressionCache.clear();
        expressionCache.set(source, expression);
    }
    const result = expression({ time: tick / rate, tick, t, value });
    if (!Number.isFinite(result) || !Number.isFinite(Math.fround(result))) throw new Error(`유한한 값이 아닌 애니메이션 수식: ${source}`);
    return result;
}

export function keyHasChannel(key: AnimationKey, channel: AnimationChannel): boolean { return !key.channels || key.channels.includes(channel); }
export function channelKeys(keys: AnimationKey[], channel: AnimationChannel | 'all'): AnimationKey[] {
    return channel === 'all' ? keys : keys.filter(key => keyHasChannel(key, channel));
}
export function keyCurve(key: AnimationKey, channel: AnimationChannel | 'all'): AnimationCurve | undefined {
    return channel === 'all' ? key.curve : key.curves?.[channel] ?? key.curve;
}
export function setKeyCurve(key: AnimationKey, channel: AnimationChannel | 'all', curve?: AnimationCurve): void {
    if (channel === 'all') { key.curve = curve; delete key.curves; }
    else {
        if (curve === undefined && key.curve === undefined) {
            if (key.curves) delete key.curves[channel];
            if (key.curves && !Object.keys(key.curves).length) delete key.curves;
        } else (key.curves ??= {})[channel] = curve ?? [1 / 3, 1 / 3, 2 / 3, 2 / 3];
    }
}

export function copyKeyChannels(key: AnimationKey, channel: AnimationChannel | 'all'): AnimationKey {
    const copy = structuredClone(key);
    if (channel === 'all') return copy;
    copy.channels = [channel];
    for (const field of ['values', 'pre', 'curves'] as const) {
        if (copy[field]) for (const other of animationChannels) if (other !== channel) delete copy[field][other];
    }
    delete copy.texture; delete copy.properties; delete copy.pivot;
    return copy;
}

export function removeKeyChannels(track: AnimationTrack, ticks: Set<number>, channel: AnimationChannel | 'all'): void {
    track.keys = track.keys.filter(key => {
        if (!ticks.has(key.tick)) return true;
        if (channel === 'all') return false;
        key.channels = (key.channels ?? animationChannels).filter(value => value !== channel);
        for (const field of ['values', 'pre', 'curves'] as const) if (key[field]) delete key[field][channel];
        return key.channels.length > 0 || key.texture !== undefined || !!key.properties || key.pivot !== undefined;
    });
}

export function mergeAnimationKey(track: AnimationTrack, key: AnimationKey): void {
    const existing = track.keys.find(entry => entry.tick === key.tick);
    if (!existing) track.keys.push(key);
    else if (!key.channels) {
        for (const field of Object.keys(existing)) delete existing[field];
        Object.assign(existing, key);
    }
    else {
        const matrix = sampleTrack([key], key.tick, ticksPerSecond, existing.transform);
        existing.transform = keyTransform(matrix);
        if (existing.channels) existing.channels = [...new Set([...existing.channels, ...key.channels])];
        for (const channel of key.channels) {
            for (const field of ['values', 'pre'] as const) {
                if (key[field]?.[channel]) (existing[field] ??= {})[channel] = key[field][channel];
                else if (existing[field]) delete existing[field][channel];
            }
            setKeyCurve(existing, channel, keyCurve(key, channel));
        }
    }
    track.keys.sort((a, b) => a.tick - b.tick);
}

export function keyTransform(matrix: Matrix4): AnimationTransform {
    const m = matrix.clone().transpose().toArray();
    return needsDecomposedTransformation(m) ? decomposeDisplayMatrix(m) : m;
}

export function transformMatrix(value: AnimationTransform): Matrix4 {
    if (Array.isArray(value)) return new Matrix4().fromArray(value).transpose();
    return new Matrix4().compose(new Vector3().fromArray(value.translation),
        new Quaternion().fromArray(value.left_rotation), new Vector3().fromArray(value.scale))
        .multiply(new Matrix4().makeRotationFromQuaternion(new Quaternion().fromArray(value.right_rotation)));
}

const transformPartsCache = new WeakMap<number[], { matrix: number[]; parts: DisplayTransformParts }>();

// MatrixUtil.svdDecompose in resources/client: five Jacobi sweeps followed by QR.
// The lossless parts form bypasses Minecraft's absolute cutoffs for tiny axes/shear.
export function minecraftTransformParts(value: AnimationTransform): DisplayTransformParts {
    if (!Array.isArray(value)) return value;
    const cached = transformPartsCache.get(value);
    if (cached && cached.matrix.every((component, index) => component === value[index])) return cached.parts;
    const matrix = transformMatrix(value);
    const a = new Matrix3().setFromMatrix4(matrix);
    const symmetric = a.clone().transpose().multiply(a);
    const right = new Quaternion();
    const rotation = (axis: number, sine: number, cosine: number) => {
        const length = Math.hypot(sine, cosine);
        return new Quaternion(axis === 0 ? sine / length : 0, axis === 1 ? sine / length : 0,
            axis === 2 ? sine / length : 0, cosine / length);
    };
    const rotateMatrix = (q: Quaternion) => new Matrix3().setFromMatrix4(new Matrix4().makeRotationFromQuaternion(q));
    for (let sweep = 0; sweep < 5; sweep++) {
        for (const [p, q, axis, sign] of [[0, 1, 2, 1], [0, 2, 1, -1], [1, 2, 0, 1]]) {
            const e = symmetric.elements;
            if (e[q * 3 + p] ** 2 + e[p * 3 + q] ** 2 <= 1e-6) continue;
            const sine = (e[q * 3 + p] + e[p * 3 + q]) / 2;
            const cosine = 2 * (e[p * 3 + p] - e[q * 3 + q]);
            const r = (3 + 2 * Math.sqrt(2)) * sine * sine < cosine * cosine
                ? rotation(axis, sign * sine, cosine) : rotation(axis, sign * Math.sin(Math.PI / 8), Math.cos(Math.PI / 8));
            right.multiply(r);
            const basis = rotateMatrix(r);
            symmetric.multiply(basis).premultiply(basis.clone().transpose());
        }
    }
    right.normalize();
    const zeroX = symmetric.elements[0] < 1e-6;
    const zeroY = symmetric.elements[4] < 1e-6;
    a.multiply(rotateMatrix(right));
    const left = new Quaternion();
    const qr = (axis: number, x: number, y: number, sign = 1) => {
        const length = Math.hypot(x, y);
        let sine = length > 1e-6 ? y : 0;
        let cosine = Math.abs(x) + Math.max(length, 1e-6);
        if (x < 0) [sine, cosine] = [cosine, sine];
        const r = rotation(axis, sign * sine, cosine);
        left.multiply(r);
        a.premultiply(rotateMatrix(r).transpose());
    };
    qr(2, zeroX ? a.elements[4] : a.elements[0], zeroX ? -a.elements[3] : a.elements[1]);
    qr(1, zeroX ? a.elements[8] : a.elements[0], zeroX ? -a.elements[6] : a.elements[2], -1);
    qr(0, zeroY ? a.elements[8] : a.elements[4], zeroY ? -a.elements[7] : a.elements[5]);
    const parts = { translation: [value[3], value[7], value[11]], left_rotation: left.normalize().toArray(),
        scale: [a.elements[0], a.elements[4], a.elements[8]], right_rotation: right.conjugate().toArray() };
    transformPartsCache.set(value, { matrix: value.slice(), parts });
    return parts;
}

export function curveAmount(curve: AnimationCurve | undefined, amount: number): number {
    if (curve === 'step') return amount < 1 ? 0 : 1;
    if (!curve || amount <= 0 || amount >= 1) return amount;
    if (typeof curve === 'string') {
        const bounce = (t: number): number => {
            if (t < 1 / 2.75) return 7.5625 * t * t;
            if (t < 2 / 2.75) return 7.5625 * (t -= 1.5 / 2.75) * t + .75;
            if (t < 2.5 / 2.75) return 7.5625 * (t -= 2.25 / 2.75) * t + .9375;
            return 7.5625 * (t -= 2.625 / 2.75) * t + .984375;
        };
        switch (curve) {
            case 'sine-in': return 1 - Math.cos(amount * Math.PI / 2);
            case 'sine-out': return Math.sin(amount * Math.PI / 2);
            case 'sine-in-out': return (1 - Math.cos(Math.PI * amount)) / 2;
            case 'back-in': return 2.70158 * amount ** 3 - 1.70158 * amount ** 2;
            case 'back-out': return 1 + 2.70158 * (amount - 1) ** 3 + 1.70158 * (amount - 1) ** 2;
            case 'elastic-in': return -(2 ** (10 * amount - 10)) * Math.sin((10 * amount - 10.75) * 2 * Math.PI / 3);
            case 'elastic-out': return 2 ** (-10 * amount) * Math.sin((10 * amount - .75) * 2 * Math.PI / 3) + 1;
            case 'bounce-in': return 1 - bounce(1 - amount);
            case 'bounce-out': return bounce(amount);
        }
    }
    const cubic = (t: number, a: number, b: number) => 3 * (1 - t) ** 2 * t * a + 3 * (1 - t) * t ** 2 * b + t ** 3;
    let low = 0, high = 1;
    for (let i = 0; i < 32; i++) {
        const t = (low + high) / 2;
        if (cubic(t, curve[0], curve[2]) < amount) low = t;
        else high = t;
    }
    return cubic((low + high) / 2, curve[1], curve[3]);
}

export function channelValue(transform: AnimationTransform, channel: AnimationChannel, axis: number): number {
    const parts = minecraftTransformParts(transform);
    if (channel !== 'rotation') return parts[channel][axis];
    const rotation = new Euler().setFromQuaternion(new Quaternion().fromArray(parts.left_rotation));
    return [rotation.x, rotation.y, rotation.z][axis] * 180 / Math.PI;
}

export function isDisplayReplacement(keys: AnimationKey[], index: number): boolean {
    const target = keys[index].properties;
    if (!target) return false;
    for (let i = index - 1; i >= 0; i--) {
        const previous = keys[i].properties;
        if (previous) return previous.displayType !== target.displayType
            || target.displayType !== 'text_display' && previous.name !== target.name;
    }
    return false;
}

function channelSegment(keys: AnimationKey[], channel: AnimationChannel, tick: number) {
    const entries = channelKeys(keys, channel);
    if (!entries.length) return undefined;
    const next = entries.findIndex(key => key.tick >= tick);
    const target = next < 0 ? entries[entries.length - 1] : entries[next];
    const previous = next <= 0 || target.tick === tick ? target : entries[next - 1];
    const amount = target === previous ? 0 : curveAmount(keyCurve(target, channel), (tick - previous.tick) / (target.tick - previous.tick));
    return { previous, target, amount };
}

export function keyChannelValues(key: AnimationKey, channel: AnimationChannel, tick = key.tick, rate = ticksPerSecond,
    t = 0, pre = false): number[] {
    const values = pre ? key.pre?.[channel] ?? key.values?.[channel] : key.values?.[channel];
    return [0, 1, 2].map(axis => {
        const fallback = channelValue(key.transform, channel, axis), value = values?.[axis] ?? fallback;
        return typeof value === 'string' ? animationExpression(value, tick, rate, t, fallback) : value;
    });
}

export function sampleChannelValues(keys: AnimationKey[], channel: AnimationChannel, tick: number, rate = ticksPerSecond,
    base: AnimationTransform = keys[0]?.transform): number[] {
    const segment = channelSegment(keys, channel, tick);
    if (!segment) return [0, 1, 2].map(axis => base ? channelValue(base, channel, axis) : channel === 'scale' ? 1 : 0);
    const { previous, target, amount } = segment;
    const phase = previous === target ? 0 : (tick - previous.tick) / (target.tick - previous.tick);
    const from = keyChannelValues(previous, channel, tick, rate, phase);
    if (previous === target || keyCurve(target, channel) === 'step'
        || channel !== 'translation' && isDisplayReplacement(keys, keys.indexOf(target))) return from;
    const to = keyChannelValues(target, channel, tick, rate, phase, true);
    if (channel === 'rotation' && !previous.values?.rotation && !target.values?.rotation && !target.pre?.rotation) {
        const left = new Quaternion().fromArray(minecraftTransformParts(previous.transform).left_rotation)
            .slerp(new Quaternion().fromArray(minecraftTransformParts(target.transform).left_rotation), amount);
        const euler = new Euler().setFromQuaternion(left);
        return [euler.x, euler.y, euler.z].map(value => value * 180 / Math.PI);
    }
    return from.map((value, axis) => value + (to[axis] - value) * amount);
}

function interpolatePivot(value: Matrix4, pivot: number[] | null | undefined, from: AnimationTransform, to = from, amount = 0): Matrix4 {
    if (!pivot) return value;
    // Stored translations include pivot compensation, which must follow the sampled rotation/scale.
    const point = new Vector3().fromArray(pivot);
    const offset = point.clone().applyMatrix4(transformMatrix(from).setPosition(0, 0, 0))
        .lerp(point.clone().applyMatrix4(transformMatrix(to).setPosition(0, 0, 0)), amount);
    const position = new Vector3().setFromMatrixPosition(value);
    point.applyMatrix4(value).sub(position);
    return value.setPosition(position.add(offset).sub(point));
}

export function sampleTrack(keys: AnimationKey[], tick: number, rate = ticksPerSecond, base?: AnimationTransform, pivot?: number[] | null): Matrix4 {
    const keyedPivot = samplePivot(keys, tick);
    if (keyedPivot !== undefined) pivot = keyedPivot;
    if (keys.some(key => key.channels || key.values || key.pre || key.curves)) {
        const transforms = keys.filter(key => !key.channels || key.channels.length);
        const anchor = transforms.length === 1 ? transforms[0] : undefined;
        // Property-only keys retain the exact matrix, including tiny axes that SVD would round away.
        if (!transforms.length && base) return transformMatrix(base);
        if (anchor && (!anchor.channels || anchor.channels.length === animationChannels.length) && !anchor.values && !anchor.pre) {
            return transformMatrix(anchor.transform);
        }
        const rotation = sampleChannelValues(keys, 'rotation', tick, rate, base);
        const segment = channelSegment(keys, 'rotation', tick);
        const right = new Quaternion().fromArray(minecraftTransformParts(base ?? keys[0].transform).right_rotation);
        if (segment) {
            right.fromArray(minecraftTransformParts(segment.previous.transform).right_rotation);
            if (keyCurve(segment.target, 'rotation') !== 'step' && !isDisplayReplacement(keys, keys.indexOf(segment.target))) {
                right.slerp(new Quaternion().fromArray(minecraftTransformParts(segment.target.transform).right_rotation), segment.amount);
            }
        }
        const value = transformMatrix({ translation: sampleChannelValues(keys, 'translation', tick, rate, base),
            scale: sampleChannelValues(keys, 'scale', tick, rate, base),
            left_rotation: new Quaternion().setFromEuler(new Euler(...rotation.map(value => value * Math.PI / 180) as [number, number, number])).toArray(),
            right_rotation: right.toArray() });
        if (!pivot) return value;
        const translation = channelSegment(keys, 'translation', tick);
        const from = translation?.previous.transform ?? base ?? keys[0].transform;
        const to = translation && !isDisplayReplacement(keys, keys.indexOf(translation.target)) ? translation.target.transform : from;
        return interpolatePivot(value, pivot, from, to, translation?.amount);
    }
    if (tick <= keys[0].tick) return transformMatrix(keys[0].transform);
    const next = keys.findIndex(key => key.tick >= tick);
    if (next < 0) return transformMatrix(keys[keys.length - 1].transform);
    if (keys[next].tick === tick) return transformMatrix(keys[next].transform);
    const previous = keys[next - 1], target = keys[next];
    const curve = target.curve;
    if (curve === 'step') return transformMatrix(previous.transform);
    const amount = curveAmount(curve, (tick - previous.tick) / (target.tick - previous.tick));
    const from = minecraftTransformParts(previous.transform), to = minecraftTransformParts(target.transform);
    const translation = new Vector3().fromArray(from.translation).lerp(new Vector3().fromArray(to.translation), amount);
    // Replacement fitting changes rotation/scale together with the model at its key.
    if (isDisplayReplacement(keys, next)) return transformMatrix(previous.transform).setPosition(translation);
    return interpolatePivot(transformMatrix({
        translation: translation.toArray(),
        scale: new Vector3().fromArray(from.scale).lerp(new Vector3().fromArray(to.scale), amount).toArray(),
        left_rotation: new Quaternion().fromArray(from.left_rotation).slerp(new Quaternion().fromArray(to.left_rotation), amount).toArray(),
        right_rotation: new Quaternion().fromArray(from.right_rotation).slerp(new Quaternion().fromArray(to.right_rotation), amount).toArray()
    }), pivot, previous.transform, target.transform, amount);
}

export function sampleTexture(keys: AnimationKey[], tick: number, base?: string): string | undefined {
    for (let index = keys.length - 1; index >= 0; index--) {
        if (keys[index].tick <= tick && keys[index].texture !== undefined) return keys[index].texture;
    }
    return base;
}

export function samplePivot(keys: AnimationKey[], tick: number): number[] | null | undefined {
    for (let index = keys.length - 1; index >= 0; index--) {
        if (keys[index].tick <= tick && keys[index].pivot !== undefined) return keys[index].pivot;
    }
    return undefined;
}

export function sampleProperties(keys: AnimationKey[], tick: number, base?: AnimationProperties): AnimationProperties | undefined {
    let previous: AnimationKey | undefined;
    for (const key of keys) {
        if (!key.properties) continue;
        if (key.tick <= tick) { previous = key; continue; }
        const from = previous?.properties ?? base, to = key.properties;
        const start = previous?.tick ?? 0;
        if (tick <= start || from?.displayType !== 'text_display' || to.displayType !== 'text_display' || key.curve === 'step') return from;
        // Display.calculateInterpolationProgress: the key interval supplies interpolation_duration.
        const amount = Math.fround(Math.max(0, Math.min(1, curveAmount(key.curve, (tick - start) / (key.tick - start)))));
        return { ...from, options: interpolateTextOptions(from.options ?? {}, to.options ?? {}, amount) };
    }
    return previous?.properties ?? base;
}

function interpolateTextOptions(from: TextDisplayOptions, to: TextDisplayOptions, amount: number): TextDisplayOptions {
    // TextDisplay uses ARGB.srgbLerp for backgrounds and signed-byte Mth.lerpInt for text opacity.
    const lerpInt = (a: number, b: number) => a + Math.floor(Math.fround(amount * (b - a)));
    const opacity = (a: number, b: number) => {
        if (a === b) return a;
        const signedByte = (value: number) => Math.round(value * 255) << 24 >> 24;
        return (lerpInt(signedByte(a), signedByte(b)) & 255) / 255;
    };
    const options = { ...from };
    if (from.alpha !== to.alpha) options.alpha = opacity(from.alpha ?? 1, to.alpha ?? 1);
    if (from.pageAlphas?.length || to.pageAlphas?.length) {
        options.pageAlphas = (from.pages?.length ? from.pages : ['']).map((_, index) => opacity(
            from.pageAlphas?.[index] ?? from.alpha ?? 1, to.pageAlphas?.[index] ?? to.alpha ?? 1));
    }
    if (from.backgroundAlpha !== to.backgroundAlpha) {
        options.backgroundAlpha = lerpInt(Math.round((from.backgroundAlpha ?? 0.25) * 255), Math.round((to.backgroundAlpha ?? 0.25) * 255)) / 255;
    }
    if (from.backgroundColor !== to.backgroundColor) {
        const a = Number.parseInt((from.backgroundColor ?? '#000000').slice(1), 16);
        const b = Number.parseInt((to.backgroundColor ?? '#000000').slice(1), 16);
        options.backgroundColor = '#' + [16, 8, 0].map(shift => lerpInt(a >> shift & 255, b >> shift & 255)
            .toString(16).padStart(2, '0')).join('');
    }
    return options;
}

export function offsetAnimationChannel(track: AnimationTrack, channel: AnimationChannel, before: number[], after: number[]): void {
    const factors = before.map((value, axis) => channel === 'scale' && value !== 0 ? after[axis] / value : 1);
    const offsets = before.map((value, axis) => factors[axis] === 1 ? after[axis] - value : 0);
    if (factors.every(value => Math.abs(value - 1) < 1e-10) && offsets.every(value => Math.abs(value) < 1e-10)) return;
    for (const key of track.keys) {
        if (key.tick === 0 || !keyHasChannel(key, channel)) continue;
        for (const field of ['values', 'pre'] as const) {
            if (field === 'pre' && !key.pre?.[channel]) continue;
            const vector = key[field]?.[channel] ?? [0, 1, 2].map(axis => channelValue(key.transform, channel, axis));
            // Keep the stored transform so expressions retain their original `value` binding.
            (key[field] ??= {})[channel] = vector.map((value, axis) => {
                const factor = factors[axis], offset = offsets[axis];
                if (factor === 1 && offset === 0) return value;
                return typeof value === 'string' ? `(${value})*(${factor})+(${offset})` : value * factor + offset;
            }) as AnimationVector;
        }
    }
}

export function putKey(track: AnimationTrack, tick: number, matrix: Matrix4, base: Matrix4, channels?: AnimationChannel[]): void {
    if (tick > 0) {
        const missing = channels?.filter(channel => !track.keys.some(key => keyHasChannel(key, channel)));
        if (!track.keys.length || missing?.length) mergeAnimationKey(track, { tick: 0, transform: keyTransform(base), ...(missing?.length ? { channels: missing } : {}) });
    }
    const key: AnimationKey = { tick, transform: keyTransform(matrix), ...(channels ? { channels: [...channels] } : {}) };
    const index = track.keys.findIndex(entry => entry.tick === tick);
    if (index < 0) track.keys.push(key);
    else {
        const existing = track.keys[index];
        if (channels && existing.channels) existing.channels = [...new Set([...existing.channels, ...channels])];
        else if (!channels) delete existing.channels;
        existing.transform = key.transform;
        for (const channel of channels ?? animationChannels) {
            if (existing.values) delete existing.values[channel];
            if (existing.pre) delete existing.pre[channel];
        }
    }
    track.keys.sort((a, b) => a.tick - b.tick);
}

function validateAnimationClip(value: any, objects: Set<string>, groups: Set<string>): void {
    const vector = (entry: unknown, size: number): entry is number[] => Array.isArray(entry) && entry.length === size
        && entry.every(n => typeof n === 'number' && Number.isFinite(n) && Number.isFinite(Math.fround(n)));
    const quaternion = (entry: unknown) => vector(entry, 4) && Math.abs(Math.hypot(...entry) - 1) < 1e-4;
    if (!value || !Number.isSafeInteger(value.duration) || value.duration < 1 || !Array.isArray(value.tracks)) throw new Error('잘못된 애니메이션 길이 또는 트랙입니다.');
    if (value.tickRate !== undefined && (typeof value.tickRate !== 'number' || !Number.isFinite(value.tickRate)
        || value.tickRate < 1 || value.tickRate > 10000)) throw new Error('틱 속도는 1~10000틱/초여야 합니다.');
    if (value.id !== undefined && (typeof value.id !== 'string' || !value.id.length || value.id.length > 128)
        || value.name !== undefined && (typeof value.name !== 'string' || !value.name.trim() || value.name.length > 120)
        || value.loopMode !== undefined && !['once', 'hold', 'loop'].includes(value.loopMode)
        || ['loopDelay', 'endTick', 'transitionTicks'].some(name => value[name] !== undefined && (!Number.isSafeInteger(value[name]) || value[name] < 0))
        || value.excludedNodes !== undefined && (!Array.isArray(value.excludedNodes) || new Set(value.excludedNodes).size !== value.excludedNodes.length
            || value.excludedNodes.some(id => !objects.has(id) && !groups.has(id)))) throw new Error('잘못된 애니메이션 설정입니다.');
    const validCurve = (curve: unknown) => curve === 'step' || animationEasings.includes(curve as typeof animationEasings[number])
        || vector(curve, 4) && curve[0] >= 0 && curve[2] <= 1 && curve[0] <= curve[2];
    const seen = new Set<string>();
    for (const track of value.tracks) {
        if (!track || !['object', 'group'].includes(track.type) || !(track.type === 'group' ? groups : objects).has(track.id)
            || seen.has(track.id) || !Array.isArray(track.keys) || !track.keys.length) throw new Error('잘못된 애니메이션 대상입니다.');
        seen.add(track.id);
        let previous = -1;
        for (const key of track.keys) {
            if (!key || !Number.isSafeInteger(key.tick) || key.tick <= previous || key.tick < 0) throw new Error('잘못된 키프레임 시간입니다.');
            previous = key.tick;
            if (key.channels !== undefined && (!Array.isArray(key.channels) || new Set(key.channels).size !== key.channels.length
                || key.channels.some(channel => !animationChannels.includes(channel)))) throw new Error('잘못된 애니메이션 채널입니다.');
            for (const field of ['values', 'pre', 'curves']) if (key[field] !== undefined) {
                const values = key[field];
                if (!values || typeof values !== 'object' || Array.isArray(values) || Object.entries(values).some(([channel, value]) =>
                    !animationChannels.includes(channel as AnimationChannel) || !keyHasChannel(key, channel as AnimationChannel)
                    || (field === 'curves' ? !validCurve(value) : !Array.isArray(value) || value.length !== 3 || value.some(component =>
                        typeof component === 'number' ? !Number.isFinite(component) || !Number.isFinite(Math.fround(component))
                            : typeof component !== 'string' || !compileMathExpression(component, ['time', 'tick', 't', 'value']))))) {
                    throw new Error('잘못된 애니메이션 채널 값 또는 수식입니다.');
                }
            }
            if (key.pivot !== undefined && key.pivot !== null && !vector(key.pivot, 3)) throw new Error('잘못된 키프레임 피벗입니다.');
            if (key.properties !== undefined) {
                const p = key.properties;
                if (!p || typeof p !== 'object' || Array.isArray(p) || typeof p.nbt !== 'string'
                    || Object.keys(p).some(name => !['nbt', 'brightness', 'name', 'displayType', 'options'].includes(name))
                    || (track.type === 'group' ? Object.keys(p).some(name => name !== 'nbt')
                        : typeof p.name !== 'string' || !['block_display', 'item_display', 'text_display'].includes(p.displayType)
                            || p.brightness !== null && (!p.brightness || typeof p.brightness !== 'object'
                                || ['sky', 'block'].some(name => !Number.isInteger(p.brightness[name]) || p.brightness[name] < 0 || p.brightness[name] > 15)))
                    || p.options !== undefined && (p.displayType !== 'text_display' || !p.options || typeof p.options !== 'object' || Array.isArray(p.options))) {
                    throw new Error('잘못된 키프레임 개체 속성입니다.');
                }
            }
            if (key.texture !== undefined && (track.type !== 'object' || typeof key.texture !== 'string'
                || !/^(data:image\/png;base64,|https?:\/\/)/.test(key.texture))) throw new Error('잘못된 키프레임 텍스처입니다.');
            if (key.curve !== undefined && !validCurve(key.curve)) throw new Error('잘못된 키프레임 곡선입니다.');
            const t = key.transform;
            // Inverting affine transforms can leave roundoff in the homogeneous row.
            if (Array.isArray(t) ? !vector(t, 16) || t.slice(12).some((component, index) => Math.abs(component - (index === 3 ? 1 : 0)) > 1e-8)
                : !t || !vector(t.translation, 3) || !vector(t.scale, 3) || !quaternion(t.left_rotation) || !quaternion(t.right_rotation)) throw new Error('잘못된 키프레임 변형입니다.');
        }
    }
}

export function validateAnimation(value: any, objects: Set<string>, groups: Set<string>): asserts value is AnimationData {
    if (!value || value.clips !== undefined && !Array.isArray(value.clips)) throw new Error('잘못된 애니메이션 목록입니다.');
    if (value.camera !== undefined && !objects.has(value.camera)) throw new Error('잘못된 애니메이션 카메라입니다.');
    const clips = animationClips(value);
    const ids = new Set<string>();
    for (const clip of clips) {
        if (clip !== value && (!clip || (clip as AnimationData).clips !== undefined)) throw new Error('잘못된 애니메이션 클립입니다.');
        validateAnimationClip(clip, objects, groups);
        const id = clip.id ?? 'default';
        if (ids.has(id)) throw new Error('중복된 애니메이션 ID입니다.');
        ids.add(id);
    }
    if (value.activeClip !== undefined && !ids.has(value.activeClip)
        || clips.some(clip => clip.layers !== undefined && (!Array.isArray(clip.layers) || new Set(clip.layers).size !== clip.layers.length
            || clip.layers.some(id => !ids.has(id))))) throw new Error('잘못된 애니메이션 재생 참조입니다.');
    for (const clip of clips) {
        if (clip.layerTimings === undefined) continue;
        if (!Array.isArray(clip.layerTimings)) throw new Error('잘못된 동작 배치입니다.');
        const seen = new Set<string>();
        for (const timing of clip.layerTimings) {
            if (!timing || !ids.has(timing.id) || seen.has(timing.id) || !Array.isArray(timing.starts)
                || timing.starts.some((tick, index) => !Number.isSafeInteger(tick) || tick < 0 || index > 0 && tick <= timing.starts[index - 1])
                || timing.interval !== undefined && (!Number.isSafeInteger(timing.interval) || timing.interval < 1 || timing.starts.length !== 1)) {
                throw new Error('동작 시점은 중복 없는 0 이상의 정수, 반복 간격은 1 이상의 정수여야 합니다.');
            }
            seen.add(timing.id);
        }
    }
}
