/** Gizmo drag steps from settings (localStorage, see drag-value-input.ts); a null step does not snap. */
export function readGizmoDragValues() {
    const value = (key: string, defaultValue = '0.0001'): number | null => {
        const stored = Number(localStorage.getItem(key) ?? defaultValue);
        return Number.isFinite(stored) && stored > 0 ? stored : null;
    };
    return {
        position: value('pdePositionDragValue'),
        rotation: value('pdeRotationDragValue'),
        scale: value('pdeScaleDragValue'),
        finePosition: value('pdeFinePositionDragValue', '0'),
        fineRotation: value('pdeFineRotationDragValue', '0'),
        fineScale: value('pdeFineScaleDragValue', '0'),
        align: localStorage.getItem('pdeDragAlign') === 'true',
        rotationSensitivity: value('pdeRotationSensitivity', '1') ?? 1,
        distanceScale: localStorage.getItem('pdeGizmoDistanceScale') !== 'false'
    };
}
