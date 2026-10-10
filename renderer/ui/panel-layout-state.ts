export type DockSide = 'left' | 'right';
export type PanelId = 'player-head-atlas' | 'scene-objects' | 'project-details' | 'head-painter';
export type PanelGroup = { panels: PanelId[]; activePanelId: PanelId };
export type PanelLayout = { version: 2; left: PanelGroup[]; right: PanelGroup[] };
export type DropPlacement = { side: DockSide; mode: 'split'; index: number }
    | { side: DockSide; mode: 'merge'; targetPanelId: PanelId };

export const panelIds: PanelId[] = ['player-head-atlas', 'scene-objects', 'project-details', 'head-painter'];
export const dockSides: DockSide[] = ['left', 'right'];

export function singlePanelGroup(id: PanelId): PanelGroup {
    return { panels: [id], activePanelId: id };
}

export function restorePanelLayout(saved: string | null, fallback: PanelLayout, painterAfterDetails: boolean): PanelLayout {
    try {
        const value = JSON.parse(saved ?? 'null');
        if (!value) return fallback;
        const legacy = value.version === undefined;
        if (!legacy && value.version !== 2) return fallback;
        const layout: PanelLayout = { version: 2, left: [], right: [] };
        for (const side of dockSides) {
            const entries = legacy ? value[side] ?? [] : value[side];
            if (!Array.isArray(entries)) return fallback;
            for (const entry of entries) {
                const group = legacy ? singlePanelGroup(entry) : entry;
                if (!group || !Array.isArray(group.panels) || !group.panels.length
                    || !group.panels.every((id: PanelId) => panelIds.includes(id))
                    || !group.panels.includes(group.activePanelId)) return fallback;
                layout[side].push({ panels: [...group.panels], activePanelId: group.activePanelId });
            }
        }
        const ids = dockSides.flatMap(side => layout[side].flatMap(group => group.panels));
        if (new Set(ids).size !== ids.length) return fallback;
        if (legacy && ids.length === panelIds.length - 1 && !ids.includes('head-painter')) {
            const side = layout.left.some(group => group.panels.includes('project-details')) ? 'left' : 'right';
            const index = layout[side].findIndex(group => group.panels.includes('project-details'));
            layout[side].splice(index + Number(painterAfterDetails), 0, singlePanelGroup('head-painter'));
            ids.push('head-painter');
        }
        return ids.length === panelIds.length ? layout : fallback;
    } catch {
        return fallback;
    }
}

export function selectVisiblePanel(group: PanelGroup, isVisible: (id: PanelId) => boolean): PanelId {
    return group.panels.includes(group.activePanelId) && isVisible(group.activePanelId)
        ? group.activePanelId : group.panels.find(isVisible) ?? group.panels[0];
}

export function movePanelInLayout(layout: PanelLayout, panelId: PanelId, placement: DropPlacement): PanelLayout {
    const target = placement.mode === 'merge'
        ? layout[placement.side].find(group => group.panels.includes(placement.targetPanelId)) : undefined;
    const sourceSide = dockSides.find(side => layout[side].some(group => group.panels.includes(panelId)))!;
    const sourceIndex = layout[sourceSide].findIndex(group => group.panels.includes(panelId));
    const source = layout[sourceSide][sourceIndex];
    if (source === target) {
        return { ...layout, [sourceSide]: layout[sourceSide].map(group => group === source ? { ...group, activePanelId: panelId } : group) };
    }
    const next: PanelLayout = { version: 2, left: [], right: [] };
    for (const side of dockSides) {
        next[side] = layout[side].flatMap(group => {
            if (group !== source) return [group];
            const panels = group.panels.filter(id => id !== panelId);
            return panels.length ? [{ panels, activePanelId: panels.includes(group.activePanelId) ? group.activePanelId : panels[0] }] : [];
        });
    }
    if (target) {
        next[placement.side] = next[placement.side].map(group => group === target
            ? { panels: [...group.panels, panelId], activePanelId: panelId } : group);
    } else if (placement.mode === 'split') {
        const index = placement.index - Number(sourceSide === placement.side && source.panels.length === 1 && sourceIndex < placement.index);
        next[placement.side].splice(Math.max(0, Math.min(index, next[placement.side].length)), 0, singlePanelGroup(panelId));
    }
    return next;
}
