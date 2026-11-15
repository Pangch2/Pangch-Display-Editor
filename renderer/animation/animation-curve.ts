// The curve belongs to the segment ending at a key; absent means linear.
export const animationEasings = ['sine-in', 'sine-out', 'sine-in-out', 'back-in', 'back-out', 'elastic-in', 'elastic-out', 'bounce-in', 'bounce-out'] as const;
export type AnimationEasing = typeof animationEasings[number];
// Piecewise cubic Bezier from (0, 0) to (1, 1): x is segment time, y is progress. Handles are absolute points.
export type CurvePoint = { x: number; y: number; in?: [number, number]; out?: [number, number] };
export type BezierCurve = { points: CurvePoint[] };
export type AnimationCurve = 'step' | AnimationEasing | [number, number, number, number] | BezierCurve;
// 0 and 2 are the legacy start/end handles; on a point curve they mean the first point's out and last point's in.
export type CurveTarget = 0 | 2 | { point: number; handle?: 'in' | 'out' };

const maxCurvePoints = 4096;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const cubic = (t: number, a: number, b: number, c: number, d: number) =>
    (1 - t) ** 3 * a + 3 * (1 - t) ** 2 * t * b + 3 * (1 - t) * t ** 2 * c + t ** 3 * d;
const finite = (value: unknown, length: number): value is number[] =>
    Array.isArray(value) && value.length === length && value.every(Number.isFinite);

function easing(curve: AnimationEasing, amount: number): number {
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

// Solves x(t) = amount on one monotonic segment and returns its y.
function segmentAmount(amount: number, x0: number, y0: number, x1: number, y1: number, x2: number, y2: number, x3: number, y3: number): number {
    let low = 0, high = 1;
    for (let i = 0; i < 32; i++) {
        const t = (low + high) / 2;
        if (cubic(t, x0, x1, x2, x3) < amount) low = t;
        else high = t;
    }
    return cubic((low + high) / 2, y0, y1, y2, y3);
}

export function curveAmount(curve: AnimationCurve | undefined, amount: number): number {
    if (curve === 'step') return amount < 1 ? 0 : 1;
    if (!curve || amount <= 0 || amount >= 1) return amount;
    if (typeof curve === 'string') return easing(curve, amount);
    if (Array.isArray(curve)) return segmentAmount(amount, 0, 0, curve[0], curve[1], curve[2], curve[3], 1, 1);
    const points = curve.points;
    let low = 0, high = points.length - 1;
    while (high - low > 1) {
        const middle = (low + high) >> 1;
        if (points[middle].x < amount) low = middle;
        else high = middle;
    }
    const p = points[low], q = points[high];
    return segmentAmount(amount, p.x, p.y, p.out![0], p.out![1], q.in![0], q.in![1], q.x, q.y);
}

// Each x stays inside its segment and handles never cross, which keeps time monotonic and survives subdivision.
export function validAnimationCurve(curve: unknown): curve is AnimationCurve {
    if (curve === 'step' || animationEasings.includes(curve as AnimationEasing)) return true;
    if (finite(curve, 4)) return curve[0] >= 0 && curve[0] <= curve[2] && curve[2] <= 1;
    const points = (curve as BezierCurve | null | undefined)?.points;
    if (!Array.isArray(points) || points.length < 2 || points.length > maxCurvePoints) return false;
    const first = points[0], last = points[points.length - 1];
    if (first?.x !== 0 || first.y !== 0 || last?.x !== 1 || last.y !== 1) return false;
    return points.every((point, index) => {
        if (!point || !Number.isFinite(point.y)) return false;
        const next = points[index + 1];
        return index === points.length - 1 || !!next && finite(point.out, 2) && finite(next.in, 2)
            && point.x < next.x && point.x <= point.out![0] && point.out![0] <= next.in![0] && next.in![0] <= next.x;
    });
}

// Cubic Hermite pieces with x handles at thirds, so time stays linear inside each piece.
function fitEasing(name: AnimationEasing): BezierCurve {
    const e = 1e-5, f = (t: number) => easing(name, t);
    const right = (t: number) => (-3 * f(t) + 4 * f(t + e) - f(t + 2 * e)) / (2 * e);
    const left = (t: number) => (3 * f(t) - 4 * f(t - e) + f(t - 2 * e)) / (2 * e);
    const value = (t: number) => t <= 0 ? 0 : t >= 1 ? 1 : f(t);
    // Bounce changes direction instantly; its kinks become points with separate handles.
    const breaks = name === 'bounce-out' ? [0, 1, 2, 2.5, 2.75].map(t => t / 2.75)
        : name === 'bounce-in' ? [0, .25, .75, 1.75, 2.75].map(t => t / 2.75) : [0, 1];
    const points: CurvePoint[] = [{ x: 0, y: 0 }];
    const fit = (a: number, b: number) => {
        const h = (b - a) / 3, out: [number, number] = [a + h, value(a) + right(a) * h], into: [number, number] = [b - h, value(b) - left(b) * h];
        let error = 0;
        for (let i = 1; i < 16; i++) error = Math.max(error, Math.abs(cubic(i / 16, value(a), out[1], into[1], value(b)) - f(a + 3 * h * i / 16)));
        if (error > 4e-4 && b - a > 1 / 128) { fit(a, (a + b) / 2); fit((a + b) / 2, b); return; }
        points[points.length - 1].out = out;
        points.push({ x: b, y: value(b), in: into });
    };
    for (let i = 1; i < breaks.length; i++) fit(breaks[i - 1], breaks[i]);
    return { points };
}

const presetCurves = new Map<AnimationEasing, BezierCurve>();
// Always a fresh copy, so callers may edit it.
export function toBezierCurve(curve: AnimationCurve | undefined): BezierCurve {
    if (curve === 'step') throw new Error('단계 보간은 곡선 점으로 바꿀 수 없습니다.');
    if (typeof curve === 'string') {
        let preset = presetCurves.get(curve);
        if (!preset) presetCurves.set(curve, preset = fitEasing(curve));
        return structuredClone(preset);
    }
    if (curve && !Array.isArray(curve)) return structuredClone(curve);
    const [x1, y1, x2, y2] = Array.isArray(curve) ? curve : [1 / 3, 1 / 3, 2 / 3, 2 / 3];
    return { points: [{ x: 0, y: 0, out: [x1, y1] }, { x: 1, y: 1, in: [x2, y2] }] };
}

// Exact de Casteljau split, so adding a point never changes playback. Without x, splits the widest span.
export function insertCurvePoint(curve: AnimationCurve | undefined, x?: number): BezierCurve {
    const result = toBezierCurve(curve), points = result.points;
    if (x === undefined) {
        let gap = 0;
        for (let i = 1; i < points.length - 1; i++) if (points[i + 1].x - points[i].x > points[gap + 1].x - points[gap].x) gap = i;
        x = (points[gap].x + points[gap + 1].x) / 2;
    }
    const index = points.findIndex(point => point.x >= x);
    if (index < 1 || points[index].x === x || points.length >= maxCurvePoints) return result;
    const p = points[index - 1], q = points[index];
    let low = 0, high = 1;
    for (let i = 0; i < 52; i++) {
        const t = (low + high) / 2;
        if (cubic(t, p.x, p.out![0], q.in![0], q.x) < x) low = t;
        else high = t;
    }
    const t = (low + high) / 2;
    const lerp = (a: number[], b: number[]): [number, number] => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    const a = lerp([p.x, p.y], p.out!), b = lerp(p.out!, q.in!), c = lerp(q.in!, [q.x, q.y]);
    const d = lerp(a, b), e = lerp(b, c), m = lerp(d, e);
    if (!(m[0] > p.x && m[0] < q.x)) return result;
    p.out = a; q.in = c;
    points.splice(index, 0, { x: m[0], y: m[1], in: d, out: e });
    return result;
}

export function removeCurvePoint(curve: AnimationCurve | undefined, index: number): BezierCurve {
    const result = toBezierCurve(curve);
    if (index > 0 && index < result.points.length - 1) result.points.splice(index, 1);
    return result;
}

// dx/dy are in segment units. A moved point carries its handles and pushes neighbor handles out of its way.
export function moveCurveControl(curve: AnimationCurve | undefined, target: CurveTarget, dx: number, dy: number): AnimationCurve | undefined {
    if (typeof target === 'number' && (curve === undefined || Array.isArray(curve))) {
        const next: [number, number, number, number] = Array.isArray(curve) ? [...curve] : [1 / 3, 1 / 3, 2 / 3, 2 / 3];
        next[target] = clamp(next[target] + dx, target === 0 ? 0 : next[0], target === 0 ? next[2] : 1);
        next[target + 1] += dy;
        return validAnimationCurve(next) ? next : curve;
    }
    const result = toBezierCurve(curve), points = result.points;
    const { point: index, handle } = typeof target === 'number'
        ? { point: target === 0 ? 0 : points.length - 1, handle: target === 0 ? 'out' as const : 'in' as const } : target;
    const p = points[index], previous = points[index - 1], next = points[index + 1];
    if (!p) return curve;
    if (handle) {
        const control = p[handle];
        if (!control || !(handle === 'in' ? previous : next)) return curve;
        control[0] = handle === 'in' ? clamp(control[0] + dx, previous.out![0], p.x) : clamp(control[0] + dx, p.x, next.in![0]);
        control[1] += dy;
    } else {
        if (!previous || !next) return curve;
        const margin = (next.x - previous.x) * 1e-3;
        const x = dx ? clamp(p.x + dx, previous.x + margin, next.x - margin) : p.x, shift = x - p.x;
        p.x = x; p.y += dy;
        p.in = [clamp(p.in![0] + shift, previous.x, x), p.in![1] + dy];
        p.out = [clamp(p.out![0] + shift, x, next.x), p.out![1] + dy];
        previous.out![0] = Math.min(previous.out![0], p.in[0]);
        next.in![0] = Math.max(next.in![0], p.out[0]);
    }
    // Never hand back a curve the project validator would reject on reopen.
    return validAnimationCurve(result) ? result : curve;
}
