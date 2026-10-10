export type AutoSaveUnit = 'hours' | 'minutes' | 'seconds';
export type AutoSaveSettings = { enabled: boolean; time: number; unit: AutoSaveUnit; maximum: number };

export const autoSaveStorageKey = 'pdeAutoSave';
export const defaultAutoSaveSettings: AutoSaveSettings = { enabled: true, time: 5, unit: 'minutes', maximum: 5 };
const unitMilliseconds = { hours: 3600000, minutes: 60000, seconds: 1000 };

export function autoSaveInterval(settings: AutoSaveSettings): number {
    return settings.time * unitMilliseconds[settings.unit];
}

export function updateAutoSaveSettings(previous: AutoSaveSettings, values: Partial<Record<keyof AutoSaveSettings, unknown>>): AutoSaveSettings {
    const next = { ...previous };
    if (typeof values.enabled === 'boolean') next.enabled = values.enabled;
    let time = typeof values.time === 'string' ? (/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(values.time.trim()) ? Number(values.time) : NaN)
        : typeof values.time === 'number' ? values.time : previous.time;
    const unit = Object.prototype.hasOwnProperty.call(unitMilliseconds, String(values.unit)) ? values.unit as AutoSaveUnit : previous.unit;
    if (values.unit !== undefined && values.time === undefined && time * unitMilliseconds[unit] < 30000) time = 30000 / unitMilliseconds[unit];
    const interval = time * unitMilliseconds[unit];
    // Browser timers overflow above this limit and would run every millisecond.
    if (Number.isFinite(interval) && interval >= 30000 && interval <= 2147483647) {
        next.time = time;
        next.unit = unit;
    }
    if (typeof values.maximum === 'number' || typeof values.maximum === 'string') {
        const maximum = typeof values.maximum === 'string' && !/^\d+$/.test(values.maximum.trim()) ? NaN : Number(values.maximum);
        if (Number.isSafeInteger(maximum) && maximum > 0) next.maximum = maximum;
    }
    return next;
}

export function readAutoSaveSettings(storage: Pick<Storage, 'getItem'>): AutoSaveSettings {
    try {
        const values = JSON.parse(storage.getItem(autoSaveStorageKey) ?? '{}');
        return updateAutoSaveSettings(defaultAutoSaveSettings, values && typeof values === 'object' ? values : {});
    } catch { return { ...defaultAutoSaveSettings }; }
}
