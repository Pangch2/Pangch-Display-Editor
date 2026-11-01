import type { Matrix4 } from 'three/webgpu';

export interface InstanceIdRange {
    start: number;
    count: number;
}

export function mergeInstanceIds(instanceIds: number[]): InstanceIdRange[] {
    instanceIds.sort((a, b) => a - b);

    const ranges: InstanceIdRange[] = [];
    for (const instanceId of instanceIds) {
        const range = ranges[ranges.length - 1];
        if (range && instanceId <= range.start + range.count) {
            range.count = Math.max(range.count, instanceId - range.start + 1);
        } else {
            ranges.push({ start: instanceId, count: 1 });
        }
    }
    return ranges;
}

export function transformInstanceRange(matrices: Float32Array, matrix: Matrix4, start: number, count: number): void {
    const e = matrix.elements;
    const end = (start + count) * 16;
    for (let offset = start * 16; offset < end; offset += 4) {
        const x = matrices[offset], y = matrices[offset + 1], z = matrices[offset + 2], w = matrices[offset + 3];
        matrices[offset] = e[0] * x + e[4] * y + e[8] * z + e[12] * w;
        matrices[offset + 1] = e[1] * x + e[5] * y + e[9] * z + e[13] * w;
        matrices[offset + 2] = e[2] * x + e[6] * y + e[10] * z + e[14] * w;
        matrices[offset + 3] = e[3] * x + e[7] * y + e[11] * z + e[15] * w;
    }
}
