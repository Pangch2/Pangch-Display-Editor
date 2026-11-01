export function normalizeTransformInput(value: number, rotation = false): number {
    if (rotation) {
        value %= 360;
        if (value > 180) value -= 360;
        else if (value < -180) value += 360;
    }
    const rounded = Number(value.toFixed(6));
    return rounded === 0 ? 0 : rounded;
}
