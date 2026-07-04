const TRUE_VALUES = new Set(['1', 'true', 'on', 'yes', 'enabled']);
const FALSE_VALUES = new Set(['0', 'false', 'off', 'no', 'disabled']);

export const pbdeLogNames = {
    finalLoadTime: 'Final load time',
    renderSettleWait: 'Render settle wait',
    renderSettleTrace: 'RenderSettleTrace',
    renderSettleFrameTrace: 'RenderSettleFrameTrace',
    scenePrecompileSkipped: 'Scene precompile skipped',
    scenePrecompile: 'Scene precompile',
    precompileTrace: 'PrecompileTrace',
    processingItems: 'Processing items',
    loadTimings: 'Load timings',
    geometryStats: 'Geometry stats',
    meshUploaded: 'Mesh uploaded',
    finishedProcessing: 'Finished processing',
    sceneTimings: 'Scene timings',
    parseTimings: 'Parse timings'
} as const;

type PbdeLogName = typeof pbdeLogNames[keyof typeof pbdeLogNames];

type PbdeLogDefinition = {
    defaultEnabled: boolean;
};

const pbdeLogDefinitions: Record<PbdeLogName, PbdeLogDefinition> = {
    [pbdeLogNames.finalLoadTime]: { defaultEnabled: true },
    [pbdeLogNames.renderSettleWait]: { defaultEnabled: false },
    [pbdeLogNames.renderSettleTrace]: { defaultEnabled: false },
    [pbdeLogNames.renderSettleFrameTrace]: { defaultEnabled: false },
    [pbdeLogNames.scenePrecompileSkipped]: { defaultEnabled: false },
    [pbdeLogNames.scenePrecompile]: { defaultEnabled: false },
    [pbdeLogNames.precompileTrace]: { defaultEnabled: false },
    [pbdeLogNames.processingItems]: { defaultEnabled: true },
    [pbdeLogNames.loadTimings]: { defaultEnabled: false },
    [pbdeLogNames.geometryStats]: { defaultEnabled: false },
    [pbdeLogNames.meshUploaded]: { defaultEnabled: false },
    [pbdeLogNames.finishedProcessing]: { defaultEnabled: false },
    [pbdeLogNames.sceneTimings]: { defaultEnabled: false },
    [pbdeLogNames.parseTimings]: { defaultEnabled: false }
};

function normalizeLogName(name: string): string {
    return name.replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function getPbdeLogDefinition(name: string): PbdeLogDefinition | null {
    return pbdeLogDefinitions[name as PbdeLogName] ?? null;
}

function getPbdeLogStorageKeys(name: string): string[] {
    const normalizedName = normalizeLogName(name);
    return [
        name,
        `PBDE ${name}`,
        `pdeLog.${name}`,
        `pdeLog${normalizedName}`,
        `pdeLog.${normalizedName}`,
        normalizedName
    ];
}

function readLocalStorageFlag(name: string): string | null {
    if (typeof localStorage === 'undefined') return null;

    for (const key of getPbdeLogStorageKeys(name)) {
        const value = localStorage.getItem(key);
        if (value !== null) return value;
    }

    const normalizedName = normalizeLogName(name);
    for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key || normalizeLogName(key) !== normalizedName) continue;
        return localStorage.getItem(key);
    }

    return null;
}

export function setPbdeLogEnabled(name: string, enabled: boolean): void {
    if (typeof localStorage === 'undefined') return;

    const normalizedName = normalizeLogName(name);
    for (const key of getPbdeLogStorageKeys(name)) {
        localStorage.removeItem(key);
    }
    localStorage.setItem(`pdeLog.${normalizedName}`, enabled ? '1' : '0');
}

export function setAllPbdeLogsEnabled(enabled: boolean): void {
    for (const name of Object.values(pbdeLogNames)) {
        setPbdeLogEnabled(name, enabled);
    }
}

export function getPbdeLogDefaultEnabled(name: string): boolean {
    return getPbdeLogDefinition(name)?.defaultEnabled ?? false;
}

export function getPbdeLogNames(): PbdeLogName[] {
    return [...Object.values(pbdeLogNames)];
}

export function isPbdeLogEnabled(name: string, defaultEnabled?: boolean): boolean {
    const value = readLocalStorageFlag(name);
    if (value === null) return defaultEnabled ?? getPbdeLogDefaultEnabled(name);

    const normalizedValue = value.trim().toLowerCase();
    if (TRUE_VALUES.has(normalizedValue)) return true;
    if (FALSE_VALUES.has(normalizedValue)) return false;
    return defaultEnabled ?? getPbdeLogDefaultEnabled(name);
}
