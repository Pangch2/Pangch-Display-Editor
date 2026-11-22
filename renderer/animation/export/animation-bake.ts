import { Matrix4, Quaternion, Vector3, type Group } from 'three/webgpu';
import { activeAnimation, animationClips, animationTimelineEnd, minecraftTransformParts, sampleTrack, ticksPerSecond, transformMatrix, type AnimationTransform } from '../animation-data';
import type { DisplayTransformParts } from '../display-transformation';
import { animationProjectData, animationSession, previewAnimation, selectAnimationClip, setAnimationEnabled } from '../animation-state';
import { flushProjectEdits } from '../../save/pending-edits';
import { generateSummonCommands, summonPassengerEntities, type Compound } from '../../export/summon-command';
import { quoteSnbt, snbtNumber, SnbtLiteral, stringifySnbt, type SnbtValue } from '../../export/snbt';
import { yieldPreview } from '../yield-preview';

/**
 * What one passenger receives at one game tick.
 * m: merged into the entity, s: keys replaced whole, d: keys removed,
 * it: `item replace` argument, k + f: the entity type to become and its whole NBT.
 */
export type BakedEntry = { m?: Compound; s?: Compound; d?: Compound; it?: string; k?: string; f?: Compound };
/** frames[game tick]: passenger index → entry. loopDelay is in game ticks. */
export type BakedClip = { name: string; loopMode: 'once' | 'hold' | 'loop'; loopDelay: number; frames: Map<number, BakedEntry>[] };
/** parts: the passenger indices that have entries, ascending. passengers: how many the root carries. */
export type BakedAnimation = { clips: BakedClip[]; parts: number[]; passengers?: number };

/** keys: the texts of the keys bakePart writes; texts: every key's text. */
export type BakedSample = { id: string; signature: string; entity: Compound; transformation: SnbtValue; pose: string; matrix?: AnimationTransform;
    keys: Map<string, string>; texts: Map<string, string> };

// Matrix-element error below which a step counts as smooth, or as the same motion (blocks for translation).
const tolerance = 0.002;

/**
 * merge: a tick that continues the previous tick's motion (the same straight path) is not exported; without it every changed tick is.
 * quantize: a step is dropped, and the running step's interpolation lengthened to reach its target, when the lengthened one stays
 * within this of every pose on the way (per matrix element, blocks for translation). 0 turns it off.
 * preroll: a part about to move after a hold gets its held pose again one tick earlier, so the move starts from a settled pose.
 * It only applies with merge; without it every moving tick is sent anyway.
 */
export type BakeQuality = { merge: boolean; preroll: boolean; quantize: number };
export const bakeQualities = {
    performance: { merge: true, preroll: false, quantize: 0.01 },
    balanced: { merge: true, preroll: true, quantize: 0 },
    quality: { merge: false, preroll: false, quantize: 0 }
} satisfies Record<string, BakeQuality>;
const defaultQuality: BakeQuality = { merge: true, preroll: false, quantize: 0 };
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const removed = new SnbtLiteral('1b');
// The editor fits rotation and scale to a replacement model at its key, so a pose change with one of these is a jump.
const modelKeys = new Set(['item', 'block_state', 'item_display']);
const isCompound = (value: SnbtValue | undefined): value is Compound => !!value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof SnbtLiteral);

function numbers(value: SnbtValue | undefined, length: number): number[] | undefined {
    if (!Array.isArray(value) || value.length !== length) return undefined;
    if (value.every(entry => typeof entry === 'number')) return value.slice() as number[];
    const list = value.map(snbtNumber);
    return list?.every(entry => entry !== undefined) ? list as number[] : undefined;
}

function numericTransform(value: SnbtValue): AnimationTransform | undefined {
    if (Array.isArray(value)) return numbers(value, 16);
    if (!isCompound(value)) return undefined;
    const translation = numbers(value.translation, 3), left_rotation = numbers(value.left_rotation, 4);
    const scale = numbers(value.scale, 3), right_rotation = numbers(value.right_rotation, 4);
    return translation && left_rotation && scale && right_rotation ? { translation, left_rotation, scale, right_rotation } : undefined;
}

/** True when both write the same SNBT text, checked without writing it: numbers compare as the float32 they are written as. */
function sameSnbt(a: SnbtValue | undefined, b: SnbtValue | undefined): boolean {
    if (a === b) return true;
    if (typeof a === 'number') return typeof b === 'number' && Math.fround(a) === Math.fround(b);
    if (a instanceof SnbtLiteral) return b instanceof SnbtLiteral && a.literal === b.literal;
    if (Array.isArray(a)) {
        if (!Array.isArray(b) || a.length !== b.length) return false;
        for (let index = 0; index < a.length; index++) if (a[index] !== b[index] && !sameSnbt(a[index], b[index])) return false;
        return true;
    }
    if (!isCompound(a) || !isCompound(b)) return false;
    const keys = Object.keys(a), others = Object.keys(b);
    if (keys.length !== others.length) return false;
    for (let index = 0; index < keys.length; index++) {
        const key = keys[index];
        if (key !== others[index] || a[key] !== b[key] && !sameSnbt(a[key], b[key])) return false;
    }
    return true;
}

const quotedKeys = new Map<string, string>();

export function bakeSample(entity: Compound, previous: BakedSample | undefined, floats: Map<number, string>): BakedSample {
    if (previous && sameSnbt(entity, previous.entity)) return previous;
    // An unchanged value keeps the previous sample's text.
    const texts = new Map<string, string>();
    for (const [key, value] of Object.entries(entity)) {
        const oldText = previous?.texts.get(key);
        texts.set(key, oldText !== undefined && sameSnbt(value, previous!.entity[key]) ? oldText : stringifySnbt(value, floats));
    }
    // The signature is stringifySnbt(entity), put together from the key texts.
    // Interpolation belongs to the exporter: every NBT write to a display restarts it (Display.readAdditionalSaveData).
    const keys = new Map<string, string>(), fields: string[] = [];
    for (const [key, literal] of texts) {
        if (key !== 'id' && key !== 'transformation' && key !== 'interpolation_duration' && key !== 'start_interpolation') keys.set(key, literal);
        let quoted = quotedKeys.get(key);
        if (quoted === undefined) quotedKeys.set(key, quoted = quoteSnbt(key, true) + ':');
        fields.push(quoted + literal);
    }
    const signature = '{' + fields.join(',') + '}';
    if (previous?.signature === signature) return previous;
    const { id, transformation = identity } = entity;
    return { id: String(id), signature, entity, transformation, pose: texts.get('transformation') ?? stringifySnbt(transformation, floats),
        matrix: numericTransform(transformation), keys, texts };
}

function setKey(entry: BakedEntry, key: string, sample: BakedSample): void {
    const value = sample.entity[key];
    if (value === undefined) (entry.d ??= {})[key] = removed;
    else if (key === 'item' && sample.id === 'item_display') entry.it = itemArgument(value);
    // A merge keeps the old compound's other keys (block state properties, item components), so compounds are replaced.
    else if (isCompound(value)) (entry.s ??= {})[key] = value;
    else (entry.m ??= {})[key] = value;
}

function itemArgument(item: SnbtValue): string {
    const { id, count, components } = item as Compound;
    const list = isCompound(components) ? Object.entries(components).map(([key, value]) => key.startsWith('!') ? key : `${key}=${stringifySnbt(value)}`) : [];
    return String(id) + (list.length ? `[${list.join(',')}]` : '') + (count === undefined ? '' : ` ${snbtNumber(count)}`);
}

function wholeEntity(sample: BakedSample): Compound {
    const { id: _id, ...nbt } = sample.entity;
    return { ...nbt, transformation: sample.transformation, interpolation_duration: 0 };
}

/**
 * The decomposition of `to` nearest `from`. L·S·R equals (L·Ta)(Ta·S·Tb)(Tb·R) for 180° turns Ta, Tb about one axis each,
 * and Ta·S·Tb only flips scale signs, so every variant shows the same matrix while the game interpolates between parts.
 */
function continuousParts(from?: AnimationTransform, to?: AnimationTransform): DisplayTransformParts | undefined {
    if (!from || !to) return undefined;
    const previous = minecraftTransformParts(from), next = minecraftTransformParts(to);
    const turn = (axis: number) => new Quaternion(axis === 0 ? 1 : 0, axis === 1 ? 1 : 0, axis === 2 ? 1 : 0, axis < 0 ? 1 : 0);
    const distance = (a: number[], b: Quaternion) => 1 - Math.abs(new Quaternion().fromArray(a).dot(b));
    let best: DisplayTransformParts | undefined, score = Infinity;
    for (const a of [-1, 0, 1, 2]) for (const b of [-1, 0, 1, 2]) {
        const left = new Quaternion().fromArray(next.left_rotation).multiply(turn(a)), right = turn(b).multiply(new Quaternion().fromArray(next.right_rotation));
        const scale = next.scale.map((value, axis) => value * (a < 0 || a === axis ? 1 : -1) * (b < 0 || b === axis ? 1 : -1));
        const value = distance(previous.left_rotation, left) + distance(previous.right_rotation, right)
            + scale.reduce((sum, entry, axis) => sum + (entry - previous.scale[axis]) ** 2, 0);
        if (value < score) { score = value; best = { translation: next.translation, left_rotation: left.toArray(), scale, right_rotation: right.toArray() }; }
    }
    return best;
}

/**
 * One passenger's entries for one clip, keyed by game tick. `ticks[i]` is the game tick of `samples[i]`.
 * `breaks`: sample indices where a move must start a new interpolation even when one segment would fit.
 */
export function bakePart(samples: BakedSample[], ticks: number[], dirtyKeys: string[], swaps: boolean, breaks?: Set<number>,
    quality: BakeQuality = defaultQuality): Map<number, BakedEntry> {
    return bakePrepared(preparePart(samples, ticks, dirtyKeys, swaps), breaks, quality).entries;
}

type PreparedPart = { samples: BakedSample[]; ticks: number[]; snap: boolean[]; forced: boolean[]; base: Map<number, BakedEntry>;
    linear: (from: number, to: number, limit?: number) => boolean; elements: (index: number) => number[] | undefined };

/** The part of bakePart that does not depend on breaks or quality, so the restart passes of bakeAnimation share it. */
function preparePart(samples: BakedSample[], ticks: number[], dirtyKeys: string[], swaps: boolean): PreparedPart {
    const entries = new Map<number, BakedEntry>();
    const entry = (index: number) => {
        let value = entries.get(ticks[index]);
        if (!value) entries.set(ticks[index], value = {});
        return value;
    };
    samples = samples.slice(); // Flipped steps are re-expressed below without touching the caller's samples.
    const last = samples.length - 1;
    // snap: the pose is set at once. forced: NBT is written, so the transformation must be sent again in that tick.
    const snap = [true], forced = [false];
    // Tick 0 sets everything any clip changes, so a clip can start from wherever another one stopped.
    const first = entry(0);
    for (const key of dirtyKeys) setKey(first, key, samples[0]);
    if (swaps) { first.k = samples[0].id; first.f = wholeEntity(samples[0]); }
    for (let index = 1; index <= last; index++) {
        const previous = samples[index - 1], current = samples[index];
        snap[index] = forced[index] = false;
        if (current === previous) continue;
        if (current.id !== previous.id) {
            const target = entry(index);
            target.k = current.id; target.f = wholeEntity(current);
            snap[index] = true;
            continue;
        }
        const changed = [...new Set([...previous.keys.keys(), ...current.keys.keys()])].filter(key => previous.keys.get(key) !== current.keys.get(key));
        if (!changed.length) continue;
        const target = entry(index);
        for (const key of changed) setKey(target, key, current);
        snap[index] = current.pose !== previous.pose && changed.some(key => modelKeys.has(key));
        forced[index] = !snap[index] && !!(target.m || target.s || target.d);
    }
    // A flattened axis or a flipped decomposition (left rotation 180° + two scale signs) makes the decomposed parts jump
    // between ticks whose matrices are close, so the game's slerp spins the display in between. Such a step is sent as the
    // equal parts form nearest the previous pose (a scale passing through 0 stays a scale); if that still jumps, it snaps.
    const shown = new Map<BakedSample, number[]>();
    const elementsOf = (sample: BakedSample) => {
        let value = shown.get(sample);
        if (!value && sample.matrix) shown.set(sample, value = transformMatrix(sample.matrix).elements);
        return value;
    };
    const smooth = (from: number, to: number): boolean => {
        const a = samples[from].matrix, b = samples[to].matrix;
        if (!a || !b) return true;
        const start = elementsOf(samples[from])!, end = elementsOf(samples[to])!, middle = chord(a, b)(0.5);
        let change = 0, error = 0;
        for (let element = 0; element < 16; element++) {
            change = Math.max(change, Math.abs(end[element] - start[element]));
            error = Math.max(error, Math.abs(middle[element] - (start[element] + end[element]) / 2));
        }
        // A real turn of up to 180° per step stays within half the change.
        return error <= tolerance || error <= change / 2;
    };
    for (let index = 1; index <= last; index++) {
        if (snap[index] || samples[index].pose === samples[index - 1].pose || smooth(index - 1, index)) continue;
        const original = samples[index], parts = continuousParts(samples[index - 1].matrix, original.matrix);
        if (parts) samples[index] = { ...original, transformation: parts, pose: stringifySnbt(parts), matrix: parts };
        if (parts && smooth(index - 1, index)) continue;
        samples[index] = original;
        snap[index] = true; forced[index] = false;
    }
    const matrices = samples.map(elementsOf);
    // Display.createInterpolatedRenderState: the game interpolates the decomposed parts linearly, as two plain keys do here.
    const isLinear = (from: number, to: number, limit: number): boolean => {
        const a = samples[from].matrix, b = samples[to].matrix;
        if (!a || !b) return false;
        let at: ((amount: number) => number[]) | undefined;
        for (let index = from + 1; index < to; index++) {
            const wanted = matrices[index];
            if (!wanted) return false;
            const amount = (ticks[index] - ticks[from]) / (ticks[to] - ticks[from]);
            const actual = amount > 0 && amount < 1 ? (at ??= chord(a, b))(amount) : sampleTrack([{ tick: 0, transform: a }, { tick: 1, transform: b }], amount).elements;
            for (let element = 0; element < 16; element++) if (Math.abs(actual[element] - wanted[element]) > limit) return false;
        }
        return true;
    };
    // The restart passes ask the same spans again.
    const known = new Map<number, Map<number, boolean>>();
    const linear = (from: number, to: number, limit = tolerance): boolean => {
        let spans = known.get(limit);
        if (!spans) known.set(limit, spans = new Map());
        const span = from * samples.length + to;
        let value = spans.get(span);
        if (value === undefined) spans.set(span, value = isLinear(from, to, limit));
        return value;
    };
    return { samples, ticks, snap, forced, base: entries, linear, elements: index => matrices[index] };
}

/** sampleTrack between two keys at 0 and 1, for 0 < amount < 1: the same lerps, slerps and compose, set up once per pair. */
function chord(a: AnimationTransform, b: AnimationTransform): (amount: number) => number[] {
    const from = minecraftTransformParts(a), to = minecraftTransformParts(b);
    const translation = [new Vector3().fromArray(from.translation), new Vector3().fromArray(to.translation), new Vector3()];
    const scale = [new Vector3().fromArray(from.scale), new Vector3().fromArray(to.scale), new Vector3()];
    const left = [new Quaternion().fromArray(from.left_rotation), new Quaternion().fromArray(to.left_rotation), new Quaternion()];
    const right = [new Quaternion().fromArray(from.right_rotation), new Quaternion().fromArray(to.right_rotation), new Quaternion()];
    const matrix = new Matrix4(), rotation = new Matrix4();
    return amount => matrix.compose(translation[2].copy(translation[0]).lerp(translation[1], amount), left[2].copy(left[0]).slerp(left[1], amount),
        scale[2].copy(scale[0]).lerp(scale[1], amount)).multiply(rotation.makeRotationFromQuaternion(right[2].copy(right[0]).slerp(right[1], amount))).elements;
}

/** The entries of a prepared part for these breaks, and where its steps start: a new break at a step start changes nothing. */
function bakePrepared({ samples, ticks, snap, forced, base, linear, elements }: PreparedPart, breaks: Set<number> | undefined,
    quality: BakeQuality): { entries: Map<number, BakedEntry>; starts: number[] } {
    const entries = new Map<number, BakedEntry>();
    // Sends below add to `m`, so each bake gets its own.
    for (const [tick, value] of base) entries.set(tick, value.m ? { ...value, m: { ...value.m } } : { ...value });
    const entry = (index: number) => {
        let value = entries.get(ticks[index]);
        if (!value) entries.set(ticks[index], value = {});
        return value;
    };
    const last = samples.length - 1;
    let pose = '';
    const send = (index: number, to: number) => {
        const target = samples[to];
        // A forced write restarts the client's interpolation clock (start_interpolation is not saved), replaying the last move
        // unless interpolation_duration 0 is sent with it, even when the pose is unchanged.
        if (target.pose === pose && !forced[index]) return;
        Object.assign(entry(index).m ??= {}, { transformation: target.transformation,
            interpolation_duration: target.pose === samples[index].pose ? 0 : ticks[to] - ticks[index] });
        pose = target.pose;
    };
    // Steps: from `index` the part interpolates to the pose of `to`; a snap step sets its pose at once.
    const steps: { index: number; to: number; snap?: boolean }[] = [];
    for (let index = 0; index <= last;) {
        if (snap[index]) {
            steps.push({ index, to: index, snap: true });
            if (++index > last || snap[index]) continue;
        }
        let limit = index;
        while (limit < last && !snap[limit + 1]) if (forced[++limit] || breaks?.has(limit)) break;
        let to = index;
        while (to < limit && samples[to + 1].pose === samples[index].pose) to++;
        if (to === index && limit > index) {
            to++;
            // Same motion: a tick continuing the previous tick's straight path adds nothing.
            while (quality.merge && to < limit && linear(index, to + 1)) to++;
        }
        steps.push({ index, to });
        index = to === index ? index + 1 : to;
    }
    // Quantization: the next step is dropped and the running one interpolates on to its target while that stays within `quantize`
    // of every pose on the way, so a move keeps its speed and a hold stays a hold. Through a tick where other parts restart it must
    // also move under `quantize` per tick: tick jitter there delays the restarting parts by a tick, but not this one.
    const slow = (from: number, to: number) => {
        const a = elements(from), b = elements(to);
        return !!a && !!b && a.every((value, element) => Math.abs(b[element] - value) <= quality.quantize * (ticks[to] - ticks[from]));
    };
    // breaksBefore[index]: how many breaks lie below sample `index`.
    const breaksBefore = [0];
    if (quality.quantize > 0) for (let index = 0; index <= last; index++) breaksBefore.push(breaksBefore[index] + (breaks?.has(index) ? 1 : 0));
    for (let position = 1; quality.quantize > 0 && position < steps.length; position++) {
        const running = steps[position - 1], next = steps[position];
        if (running.snap || next.snap || running.index === running.to || next.index !== running.to || forced[next.index]) continue;
        const passes = breaksBefore[next.to] > breaksBefore[running.index + 1];
        if (!linear(running.index, next.to, quality.quantize) || passes && !slow(running.index, next.to)) continue;
        running.to = next.to;
        steps.splice(position--, 1);
    }
    steps.forEach(({ index, to, snap: snapped }) => {
        if (snapped) {
            // A new entity is summoned with its pose; anything else is set here and moves on from the next tick.
            if (index && samples[index].id !== samples[index - 1].id) pose = samples[index].pose;
            else { pose = ''; send(index, index); }
            return;
        }
        // Each step ends where the next starts. The client starts an update from the last rendered frame (Display.lastProgress),
        // so a move aimed past the next update trails parts that are not, by up to half a tick of motion at 60 fps.
        send(index, to);
        const held = samples[index].pose;
        if (quality.merge && quality.preroll && index >= 2 && samples[to].pose !== held && samples[index - 1].pose === held && samples[index - 2].pose === held) {
            const before = entry(index - 1);
            // An entry there already writes NBT, which sends the transformation with it.
            if (!before.m?.transformation) Object.assign(before.m ??= {}, { transformation: samples[index].transformation, interpolation_duration: 0 });
        }
    });
    return { entries, starts: steps.map(step => step.index) };
}

/**
 * Plays every clip through the editor preview and turns what the summon exporter sees at each tick into per-passenger entries.
 * `summon` is taken at tick 0 of the first clip, whatever tick the editor shows, so passenger indices match the baked entries.
 */
export async function bakeAnimation(root: Group, signal?: AbortSignal, quality: BakeQuality = defaultQuality, expandRoot = false): Promise<BakedAnimation & { summon: string[] }> {
    const data = animationProjectData(root), session = animationSession(root);
    if (!data || !animationClips(data).some(clip => clip.tracks.some(track => track.keys.length))) throw new Error('내보낼 애니메이션 키프레임이 없습니다.');
    const wasEnabled = session.enabled, tick = session.tick, active = activeAnimation(data).id ?? 'default';
    const floats = new Map<number, string>();
    const sampled: { ticks: number[]; parts: BakedSample[][] }[] = [];
    let count: number | undefined, summon: string[] | undefined;
    let deadline = performance.now() + 8;
    // A message yield is not clamped to 4 ms like nested timeouts.
    const pause = async () => {
        if (performance.now() < deadline) return;
        await yieldPreview();
        deadline = performance.now() + 8;
        signal?.throwIfAborted();
    };
    if (!wasEnabled) setAnimationEnabled(root, true);
    try {
        for (const clip of animationClips(data)) {
            selectAnimationClip(root, clip.id ?? 'default');
            const rate = clip.tickRate ?? ticksPerSecond, end = animationTimelineEnd(data, clip), ticks: number[] = [], parts: BakedSample[][] = [];
            // Slower clips are sampled per editor tick and stretched; faster ones are sampled per game tick.
            for (let position = 0, done = false; !done; position += Math.max(1, rate / ticksPerSecond)) {
                const editorTick = Math.min(end, Math.round(position)), gameTick = Math.round(editorTick * ticksPerSecond / rate);
                done = editorTick >= end;
                if (ticks.length && gameTick <= ticks[ticks.length - 1]) continue;
                previewAnimation(root, editorTick);
                // Replacement models and head textures load asynchronously.
                await flushProjectEdits();
                await pause();
                signal?.throwIfAborted();
                summon ??= generateSummonCommands(root, 'datapack', expandRoot);
                const entities = summonPassengerEntities(root);
                if ((count ??= entities.length) !== entities.length) throw new Error('애니메이션 도중 내보내는 디스플레이 수가 달라져 내보낼 수 없습니다.');
                entities.forEach((entity, part) => (parts[part] ??= []).push(bakeSample(entity, parts[part]?.[ticks.length - 1], floats)));
                ticks.push(gameTick);
            }
            sampled.push({ ticks, parts });
        }
    } finally {
        selectAnimationClip(root, active);
        previewAnimation(root, tick);
        if (!wasEnabled) setAnimationEnabled(root, false);
        await flushProjectEdits();
    }
    const clips = animationClips(data).map((clip, index): BakedClip => ({ name: clip.name ?? '기본', loopMode: clip.loopMode ?? 'hold',
        loopDelay: Math.round((clip.loopDelay ?? 0) * ticksPerSecond / (clip.tickRate ?? ticksPerSecond)),
        frames: Array.from({ length: sampled[index].ticks[sampled[index].ticks.length - 1] + 1 }, () => new Map()) }));
    const animated: { part: number; dirtyKeys: string[]; swaps: boolean }[] = [];
    for (let part = 0; part < (count ?? 0); part++) {
        // Keys in order of appearance; a key is dirty where a sample writes it unlike the first one.
        const first = sampled[0].parts[part][0], keys = new Set(first.keys.keys()), dirty = new Set<string>();
        let moving = false, swaps = false, last: BakedSample | undefined;
        for (const { parts } of sampled) for (const sample of parts[part]) {
            if (sample === last) continue;
            last = sample;
            if (sample.signature === first.signature) continue;
            moving = true;
            if (sample.id !== first.id) swaps = true;
            for (const [key, text] of first.keys) if (sample.keys.get(key) !== text) dirty.add(key);
            for (const key of sample.keys.keys()) if (!keys.has(key)) { keys.add(key); dirty.add(key); }
        }
        if (moving) animated.push({ part, dirtyKeys: [...keys].filter(key => dirty.has(key)), swaps });
    }
    if (!animated.length) throw new Error('애니메이션에서 움직이는 디스플레이가 없습니다.');
    // The client starts an interpolation on its first tick after the packet, which drifts against server ticks.
    // Parts restarting in different ticks drift apart, so every part restarts wherever any part does, until no part adds a tick.
    for (const [index, { parts, ticks }] of sampled.entries()) {
        const sampleIndex = new Map(ticks.map((tick, position) => [tick, position])), breaks = new Set<number>(), added: number[] = [];
        const prepared: PreparedPart[] = [];
        for (const { part, dirtyKeys, swaps } of animated) {
            prepared.push(preparePart(parts[part], ticks, dirtyKeys, swaps));
            await pause();
        }
        // seen: how many of `added` the part was baked with. A part is baked again only when a newer break is not one of its step starts.
        const baked: { entries: Map<number, BakedEntry>; starts: Set<number>; seen: number }[] = [];
        let size: number;
        do {
            size = breaks.size;
            for (const [position, part] of prepared.entries()) {
                const last = baked[position];
                if (!last || added.slice(last.seen).some(start => !last.starts.has(start))) {
                    const { entries, starts } = bakePrepared(part, breaks, { ...quality, preroll: false });
                    baked[position] = { entries, starts: new Set(starts), seen: added.length };
                    await pause();
                } else last.seen = added.length;
            }
            for (const { entries } of baked) for (const tick of entries.keys()) {
                const start = sampleIndex.get(tick)!;
                if (!breaks.has(start)) { breaks.add(start); added.push(start); }
            }
        } while (breaks.size !== size);
        // Preroll entries hold a pose, so other parts need not restart there.
        const final = quality.merge && quality.preroll ? prepared.map(part => bakePrepared(part, breaks, quality).entries) : baked.map(({ entries }) => entries);
        animated.forEach(({ part }, position) => { for (const [gameTick, entry] of final[position]) clips[index].frames[gameTick].set(part, entry); });
    }
    return { clips, parts: animated.map(({ part }) => part), passengers: count, summon: summon! };
}
