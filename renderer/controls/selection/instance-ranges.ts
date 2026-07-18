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
