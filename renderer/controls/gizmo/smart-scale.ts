import { Box3, Group, Matrix4, Object3D, Quaternion, Vector3 } from 'three/webgpu';
import type { Mesh } from 'three/webgpu';
import { applyDeltaToSelection } from '../selection/drag';
import { mergeInstanceIds, type InstanceIdRange } from '../selection/instance-ranges';
import * as Overlay from '../selection/overlay';
import type { SelectedItem, SelectionState } from '../selection/select';

type Axis = 'x' | 'y' | 'z';

interface ScaleExtrudeSegment {
    selection: SelectionState;
    selectionKey: string;
    cloneRanges: Map<Object3D, InstanceIdRange[]>;
    appliedDelta: Matrix4;
    segmentIndex: Vector3;
    pivotWorld: Vector3;
    activationAxes: Axis[];
}

interface ScaleExtrudeDrag {
    gizmoAxis: string;
    directionKey: string;
    box: Box3;
    sourceBox: Box3;
    frame: Matrix4;
    referenceScale: Vector3;
    baseScaleRatio: Vector3;
    currentScaleRatio: Vector3;
    pivotWorld: Vector3;
    sourcePivotWorld: Vector3;
    fillBox: Box3;
    sourceRanges: Map<Object3D, InstanceIdRange[]>;
    cloneRanges: Map<Object3D, InstanceIdRange[]> | null;
    appliedDelta: Matrix4;
    segmentIndex: Vector3;
    activeAxes: { x: boolean; y: boolean; z: boolean };
    axisDirections: { x: boolean; y: boolean; z: boolean };
    sourceSelection: SelectionState | null;
    sourceSelectionKey: string;
    segments: ScaleExtrudeSegment[];
    selectionKey: string;
    changed: boolean;
    active: boolean;
}

interface SmartScaleCallbacks {
    cancelPreview(): void;
    duplicateSelected(): SelectedItem[];
    deleteSelectedAndRestore(selection: SelectionState): void;
    applyMirrorDelta(deltaMatrix: Matrix4): void;
    commitSelectionOverlay(deltaMatrix: Matrix4): void;
}

let enabled = false;
let drag: ScaleExtrudeDrag | null = null;
let visualPivot: Vector3 | null = null;

export function toggleSmartScale(): boolean {
    enabled = !enabled;
    if (!enabled) resetSmartScaleSession();
    console.log(`스마트 스케일 ${enabled ? 'On' : 'Off'}`);
    return enabled;
}

export function isSmartScaleEnabled(): boolean {
    return enabled;
}

export function getSmartScaleVisualPivot(): Vector3 | null {
    return visualPivot;
}

export function resetSmartScaleSession(): void {
    drag = null;
    visualPivot = null;
}

function canBeginSmartScaleDrag(isEnabled: boolean, mode: string, itemCount: number): boolean {
    return isEnabled && mode === 'scale' && itemCount > 0;
}

function getSelectionKey(items: SelectedItem[]): string {
    return items.map(({ mesh, instanceId }) => `${mesh.uuid}:${instanceId}`).sort().join('|');
}

function getDirectionKey(gizmoAxis: string, directions: { x: boolean; y: boolean; z: boolean }): string {
    return gizmoAxis === 'XYZ'
        ? gizmoAxis
        : [...gizmoAxis].map(axis => `${axis}${directions[axis.toLowerCase() as 'x' | 'y' | 'z'] ? '+' : '-'}`).join('');
}

function getExtrudeScale(scale: number, referenceScale: number): number {
    return Math.abs(referenceScale) + Math.abs(scale - referenceScale);
}

function canContinueSmartScaleSession(
    currentDrag: Pick<ScaleExtrudeDrag, 'selectionKey'> | null,
    selectionKey: string
): boolean {
    return !!currentDrag
        && currentDrag.selectionKey === selectionKey;
}

function getScaleFrame(initialMatrix: Matrix4, sourceMatrix?: Matrix4 | null): Matrix4 {
    const framePosition = new Vector3();
    const frameRotation = new Quaternion();
    initialMatrix.decompose(framePosition, frameRotation, new Vector3());
    const frame = new Matrix4().compose(framePosition, frameRotation, new Vector3(1, 1, 1));
    if (!sourceMatrix) return frame;

    const x = new Vector3().setFromMatrixColumn(sourceMatrix, 0).normalize();
    const y = new Vector3().setFromMatrixColumn(sourceMatrix, 1).normalize();
    const z = new Vector3().setFromMatrixColumn(sourceMatrix, 2).normalize();
    if (Math.max(Math.abs(x.dot(y)), Math.abs(x.dot(z)), Math.abs(y.dot(z))) <= 1e-6) return frame;

    return new Matrix4().makeBasis(x, y, z).setPosition(framePosition);
}

function getInstanceRanges(items: SelectedItem[]): Map<Object3D, InstanceIdRange[]> {
    const idsByMesh = new Map<Object3D, number[]>();
    for (const { mesh, instanceId } of items) {
        const ids = idsByMesh.get(mesh) ?? [];
        ids.push(instanceId);
        idsByMesh.set(mesh, ids);
    }
    return new Map(Array.from(idsByMesh, ([mesh, ids]) => [mesh, mergeInstanceIds(ids)]));
}

function getRebasedScaleState(
    referenceBox: Box3,
    currentBox: Box3,
    gizmoAxis: string,
    directions: { x: boolean; y: boolean; z: boolean }
): { sourceBox: Box3; baseScaleRatio: Vector3 } {
    const sourceBox = currentBox.clone();
    const referenceSize = referenceBox.getSize(new Vector3());
    const currentSize = currentBox.getSize(new Vector3());
    const baseScaleRatio = new Vector3(1, 1, 1);
    for (const axis of ['x', 'y', 'z'] as const) {
        if (!gizmoAxis.includes(axis.toUpperCase()) || currentSize[axis] >= referenceSize[axis] - 1e-6) continue;
        baseScaleRatio[axis] = currentSize[axis] / referenceSize[axis];
        if (directions[axis]) sourceBox.max[axis] = sourceBox.min[axis] + referenceSize[axis];
        else sourceBox.min[axis] = sourceBox.max[axis] - referenceSize[axis];
    }
    return { sourceBox, baseScaleRatio };
}

function cloneSelectionState(selection: SelectionState): SelectionState {
    const primary = selection.primary;
    return {
        groups: new Set(selection.groups),
        objects: new Map(Array.from(selection.objects, ([mesh, ids]) => [mesh, new Set(ids)])),
        primary: primary?.type === 'group'
            ? { type: 'group', id: primary.id }
            : primary
                ? { type: 'object', mesh: primary.mesh, instanceId: primary.instanceId }
                : null
    };
}

function trackCurrentSegment(
    currentDrag: ScaleExtrudeDrag,
    clones: SelectedItem[],
    selection: SelectionState,
    activationAxes: Axis[] = []
): void {
    currentDrag.selectionKey = getSelectionKey(clones);
    currentDrag.cloneRanges = getInstanceRanges(clones);
    currentDrag.segments.push({
        selection: cloneSelectionState(selection),
        selectionKey: currentDrag.selectionKey,
        cloneRanges: currentDrag.cloneRanges,
        appliedDelta: currentDrag.appliedDelta.clone(),
        segmentIndex: currentDrag.segmentIndex.clone(),
        pivotWorld: currentDrag.pivotWorld.clone(),
        activationAxes
    });
}

function syncCurrentSegment(currentDrag: ScaleExtrudeDrag): void {
    const segment = currentDrag.segments[currentDrag.segments.length - 1];
    if (!segment) return;
    segment.appliedDelta.copy(currentDrag.appliedDelta);
    segment.segmentIndex.copy(currentDrag.segmentIndex);
    segment.pivotWorld.copy(currentDrag.pivotWorld);
}

export function beginSmartScaleDrag(
    mode: string,
    gizmoAxis: string | null,
    directions: { x: boolean; y: boolean; z: boolean },
    items: SelectedItem[],
    initialMatrix: Matrix4,
    initialScale: Vector3,
    initialPosition: Vector3,
    sourceMatrix?: Matrix4 | null
): void {
    visualPivot = null;
    if (!canBeginSmartScaleDrag(enabled, mode, items.length) || !gizmoAxis || gizmoAxis === 'XYZ') {
        if (drag) drag.active = false;
        return;
    }

    const selectionKey = getSelectionKey(items);
    const directionKey = getDirectionKey(gizmoAxis, directions);
    const referenceScale = drag?.selectionKey === selectionKey ? drag.referenceScale.clone() : initialScale.clone();
    const frame = getScaleFrame(initialMatrix, sourceMatrix);
    const frameInverse = frame.clone().invert();
    const box = new Box3().makeEmpty();
    for (const { mesh, instanceId } of items) {
        const localBox = Overlay.getInstanceLocalBox(mesh, instanceId);
        if (!localBox) continue;
        const itemInFrame = frameInverse.clone().multiply(Overlay.getInstanceWorldMatrix(mesh, instanceId, new Matrix4()));
        Overlay.unionTransformedBox3(box, localBox, itemInFrame);
    }
    if (box.isEmpty()) {
        drag = null;
        return;
    }
    if (canContinueSmartScaleSession(drag, selectionKey)) {
        const rebased = getRebasedScaleState(drag.box, box, gizmoAxis, directions);
        drag.gizmoAxis = gizmoAxis;
        drag.directionKey = directionKey;
        drag.frame.copy(frame);
        drag.sourceBox.copy(rebased.sourceBox);
        drag.fillBox.copy(box);
        drag.sourceRanges = getInstanceRanges(items);
        drag.baseScaleRatio.copy(rebased.baseScaleRatio);
        drag.currentScaleRatio.copy(rebased.baseScaleRatio);
        drag.pivotWorld.copy(initialPosition);
        drag.sourcePivotWorld.copy(initialPosition);
        drag.cloneRanges = null;
        drag.appliedDelta.identity();
        drag.segmentIndex.set(0, 0, 0);
        drag.activeAxes = { x: false, y: false, z: false };
        drag.axisDirections = { ...directions };
        drag.sourceSelection = null;
        drag.sourceSelectionKey = selectionKey;
        drag.segments.length = 0;
        drag.changed = false;
        drag.active = true;
        return;
    }
    drag = {
        gizmoAxis,
        directionKey,
        box,
        sourceBox: box.clone(),
        frame,
        referenceScale,
        baseScaleRatio: new Vector3(1, 1, 1),
        currentScaleRatio: new Vector3(1, 1, 1),
        pivotWorld: initialPosition.clone(),
        sourcePivotWorld: initialPosition.clone(),
        fillBox: box.clone(),
        sourceRanges: getInstanceRanges(items),
        cloneRanges: null,
        appliedDelta: new Matrix4(),
        segmentIndex: new Vector3(),
        activeAxes: { x: false, y: false, z: false },
        axisDirections: { ...directions },
        sourceSelection: null,
        sourceSelectionKey: selectionKey,
        segments: [],
        selectionKey,
        changed: false,
        active: true
    };
}

export function endSmartScaleDrag(): boolean {
    const changed = !!drag?.active && drag.changed;
    if (drag) drag.active = false;
    visualPivot = null;
    return changed;
}

function getBoxDelta(sourceBox: Box3, targetBox: Box3): Matrix4 {
    const sourceSize = sourceBox.getSize(new Vector3());
    const sourceCenter = sourceBox.getCenter(new Vector3());
    const targetCenter = targetBox.getCenter(new Vector3());
    return new Matrix4().makeTranslation(targetCenter.x, targetCenter.y, targetCenter.z)
        .scale(targetBox.getSize(new Vector3()).divide(sourceSize))
        .multiply(new Matrix4().makeTranslation(-sourceCenter.x, -sourceCenter.y, -sourceCenter.z));
}

function getScaleExtrudeDelta(
    box: Box3,
    transformedBox: Box3,
    directions: { x: boolean; y: boolean; z: boolean },
    segmentIndex = new Vector3(),
    sourceBox = box
): Matrix4 | null {
    const target = sourceBox.clone();
    const referenceSize = box.getSize(new Vector3());
    const transformedSize = transformedBox.getSize(new Vector3());
    let grew = false;

    for (const axis of ['x', 'y', 'z'] as const) {
        const segmentSize = Math.min(
            Math.max(transformedSize[axis] - referenceSize[axis] * (segmentIndex[axis] + 1), 0),
            referenceSize[axis]
        );
        if (segmentSize <= referenceSize[axis] * 1e-6) continue;
        const offset = referenceSize[axis] * segmentIndex[axis];
        if (directions[axis]) {
            target.min[axis] = sourceBox.max[axis] + offset;
            target.max[axis] = target.min[axis] + segmentSize;
        } else {
            target.max[axis] = sourceBox.min[axis] - offset;
            target.min[axis] = target.max[axis] - segmentSize;
        }
        grew = true;
    }
    if (!grew) return null;

    return getBoxDelta(sourceBox, target);
}

function getScaleFillTarget(
    referenceBox: Box3,
    sourceBox: Box3,
    scaleRatio: Vector3,
    baseScaleRatio: Vector3,
    gizmoAxis: string,
    directions: { x: boolean; y: boolean; z: boolean }
): Box3 {
    const target = sourceBox.clone();
    const referenceSize = referenceBox.getSize(new Vector3());
    for (const axis of ['x', 'y', 'z'] as const) {
        if (!gizmoAxis.includes(axis.toUpperCase()) || baseScaleRatio[axis] >= 1 - 1e-6) continue;
        const size = referenceSize[axis] * Math.min(scaleRatio[axis], 1);
        if (directions[axis]) target.max[axis] = target.min[axis] + size;
        else target.min[axis] = target.max[axis] - size;
    }
    return target;
}

function getContinuedScaleRatio(base: Vector3, scale: Vector3, reference: Vector3): Vector3 {
    return new Vector3(
        Math.abs(scale.x / reference.x) - 1,
        Math.abs(scale.y / reference.y) - 1,
        Math.abs(scale.z / reference.z) - 1
    ).add(base);
}

function getTargetSegmentIndex(scaleRatio: Vector3): Vector3 {
    return new Vector3(
        Math.max(0, Math.ceil(scaleRatio.x - 1 - 1e-6) - 1),
        Math.max(0, Math.ceil(scaleRatio.y - 1 - 1e-6) - 1),
        Math.max(0, Math.ceil(scaleRatio.z - 1 - 1e-6) - 1)
    );
}

function isPastTarget(segmentIndex: Vector3, targetSegmentIndex: Vector3): boolean {
    return segmentIndex.x > targetSegmentIndex.x
        || segmentIndex.y > targetSegmentIndex.y
        || segmentIndex.z > targetSegmentIndex.z;
}

export function normalizeSmartScaleDrag(
    selectionHelper: Mesh,
    directions: { x: boolean; y: boolean; z: boolean }
): { x: boolean; y: boolean; z: boolean } {
    if (!drag?.active) return { ...directions };
    const scaleDirections = { ...drag.axisDirections };
    for (const axis of ['x', 'y', 'z'] as const) {
        if (!drag.gizmoAxis.includes(axis.toUpperCase())) continue;
        const inputScale = selectionHelper.scale[axis];
        scaleDirections[axis] = inputScale < drag.referenceScale[axis] ? !directions[axis] : directions[axis];
        selectionHelper.scale[axis] = getExtrudeScale(inputScale, drag.referenceScale[axis]);
    }
    return scaleDirections;
}

export function updateSmartScaleDuringDrag(
    selectionHelper: Mesh,
    directions: { x: boolean; y: boolean; z: boolean },
    currentSelection: SelectionState,
    loadedObjectGroup: Group,
    callbacks: SmartScaleCallbacks
): boolean {
    if (!drag?.active) return false;

    const axes = ['x', 'y', 'z'] as const;
    const directionChanged = axes.some(axis =>
        drag!.gizmoAxis.includes(axis.toUpperCase()) && drag!.axisDirections[axis] !== directions[axis]
    );

    const frameInverse = drag.frame.clone().invert();
    const scaleRatio = getContinuedScaleRatio(drag.baseScaleRatio, selectionHelper.scale, drag.referenceScale);
    drag.currentScaleRatio.copy(scaleRatio);
    const transformedBox = drag.box.clone();
    transformedBox.max.copy(transformedBox.min).add(drag.box.getSize(new Vector3()).multiply(scaleRatio));
    const targetSegmentIndex = getTargetSegmentIndex(scaleRatio);
    const scaleDirections = directions;

    while (drag.segments.length > 0 && drag.segments.some(segment => (
        directionChanged
        || isPastTarget(segment.segmentIndex, targetSegmentIndex)
        || segment.activationAxes.some(axis => scaleRatio[axis] <= 1 + 1e-6)
    ))) {
        const previousSegment = drag.segments[drag.segments.length - 2];
        const selection = previousSegment?.selection ?? drag.sourceSelection;
        if (!selection) break;
        callbacks.deleteSelectedAndRestore(selection);
        drag.segments.pop();
        if (previousSegment) {
            drag.selectionKey = previousSegment.selectionKey;
            drag.cloneRanges = previousSegment.cloneRanges;
            drag.appliedDelta.copy(previousSegment.appliedDelta);
            drag.segmentIndex.copy(previousSegment.segmentIndex);
            drag.pivotWorld.copy(previousSegment.pivotWorld);
        } else {
            drag.selectionKey = drag.sourceSelectionKey;
            drag.cloneRanges = null;
            drag.appliedDelta.identity();
            drag.segmentIndex.set(0, 0, 0);
            drag.pivotWorld.copy(drag.sourcePivotWorld);
        }
        selectionHelper.position.copy(drag.pivotWorld);
    }

    for (const axis of axes) {
        if (!drag.gizmoAxis.includes(axis.toUpperCase()) || drag.axisDirections[axis] === scaleDirections[axis]) continue;
        drag.segmentIndex[axis] = 0;
        drag.axisDirections[axis] = scaleDirections[axis];
    }
    drag.directionKey = getDirectionKey(drag.gizmoAxis, scaleDirections);

    const hasPartialSource = axes.some(axis => (
        drag!.gizmoAxis.includes(axis.toUpperCase()) && drag!.baseScaleRatio[axis] < 1 - 1e-6
    ));
    if (!drag.cloneRanges && hasPartialSource) {
        callbacks.cancelPreview();
        const fillTarget = getScaleFillTarget(
            drag.box, drag.sourceBox, scaleRatio, drag.baseScaleRatio, drag.gizmoAxis, scaleDirections
        );
        if (!drag.fillBox.equals(fillTarget)) {
            const fillWorldDelta = drag.frame.clone()
                .multiply(getBoxDelta(drag.fillBox, fillTarget))
                .multiply(frameInverse);
            applyDeltaToSelection({
                deltaMatrix: fillWorldDelta,
                meshToInstanceRanges: drag.sourceRanges,
                selectedGroupIds: currentSelection.groups,
                loadedObjectGroup
            });
            callbacks.applyMirrorDelta(fillWorldDelta);
            drag.fillBox.copy(fillTarget);
            drag.pivotWorld.applyMatrix4(fillWorldDelta);
            drag.sourcePivotWorld.copy(drag.pivotWorld);
            drag.changed = true;
            selectionHelper.position.copy(drag.pivotWorld);
            visualPivot = drag.pivotWorld;
            callbacks.commitSelectionOverlay(fillWorldDelta);
        }
        if (axes.some(axis => (
            drag!.gizmoAxis.includes(axis.toUpperCase())
            && drag!.baseScaleRatio[axis] < 1 - 1e-6
            && scaleRatio[axis] <= 1 + 1e-6
        ))) return true;
    }

    const extrudingAxes = axes.filter(axis => scaleRatio[axis] > 1 + 1e-6);
    const newAxes = extrudingAxes.filter(axis => !drag.activeAxes[axis]);
    for (const axis of axes) drag.activeAxes[axis] = scaleRatio[axis] > 1 + 1e-6;

    if (!drag.cloneRanges) {
        if (!getScaleExtrudeDelta(drag.box, transformedBox, scaleDirections, undefined, drag.sourceBox)) {
            visualPivot = null;
            selectionHelper.updateMatrixWorld();
            return false;
        }
        callbacks.cancelPreview();
        drag.sourceSelection ??= cloneSelectionState(currentSelection);
        const clones = callbacks.duplicateSelected();
        trackCurrentSegment(drag, clones, currentSelection, extrudingAxes);
        drag.changed = true;
    } else if (newAxes.length > 0) {
        const clones = callbacks.duplicateSelected();
        trackCurrentSegment(drag, clones, currentSelection, newAxes);
        drag.changed = true;
    }

    while (
        drag.segmentIndex.x < targetSegmentIndex.x ||
        drag.segmentIndex.y < targetSegmentIndex.y ||
        drag.segmentIndex.z < targetSegmentIndex.z
    ) {
        const completedLocalDelta = getScaleExtrudeDelta(drag.box, transformedBox, scaleDirections, drag.segmentIndex, drag.sourceBox);
        if (!completedLocalDelta) break;
        const completedWorldDelta = drag.frame.clone().multiply(completedLocalDelta).multiply(frameInverse);
        const deltaMatrix = completedWorldDelta.clone().multiply(drag.appliedDelta.clone().invert());
        applyDeltaToSelection({
            deltaMatrix,
            meshToInstanceRanges: drag.cloneRanges,
            selectedGroupIds: currentSelection.groups,
            loadedObjectGroup
        });
        callbacks.applyMirrorDelta(deltaMatrix);
        drag.changed = true;
        drag.appliedDelta.copy(completedWorldDelta);
        drag.pivotWorld.setFromMatrixPosition(drag.frame).applyMatrix4(completedWorldDelta);
        syncCurrentSegment(drag);
        const clones = callbacks.duplicateSelected();
        for (const axis of axes) {
            if (drag.segmentIndex[axis] < targetSegmentIndex[axis]) drag.segmentIndex[axis]++;
        }
        trackCurrentSegment(drag, clones, currentSelection);
    }

    const localDelta = getScaleExtrudeDelta(drag.box, transformedBox, scaleDirections, drag.segmentIndex, drag.sourceBox);
    if (!localDelta) return true;
    const worldDelta = drag.frame.clone().multiply(localDelta).multiply(frameInverse);
    const deltaMatrix = worldDelta.clone().multiply(drag.appliedDelta.clone().invert());
    applyDeltaToSelection({
        deltaMatrix,
        meshToInstanceRanges: drag.cloneRanges,
        selectedGroupIds: currentSelection.groups,
        loadedObjectGroup
    });
    callbacks.applyMirrorDelta(deltaMatrix);
    drag.changed = true;
    drag.appliedDelta.copy(worldDelta);
    drag.pivotWorld.setFromMatrixPosition(drag.frame).applyMatrix4(worldDelta);
    syncCurrentSegment(drag);
    selectionHelper.position.copy(drag.pivotWorld);
    visualPivot = drag.pivotWorld;
    callbacks.commitSelectionOverlay(deltaMatrix);
    return true;
}

if (import.meta.env.DEV) {
    console.assert(Math.abs(getExtrudeScale(2.4, 1) - 2.4) < 1e-9, 'Smart scale must shrink when the pointer moves back toward its drag origin.');
    console.assert(
        isPastTarget(getTargetSegmentIndex(new Vector3(2.1, 1, 1)), getTargetSegmentIndex(new Vector3(1.9, 1, 1))),
        'Smart scale must remove segments when its target segment decreases.'
    );
    console.assert(
        getDirectionKey('Y', { x: true, y: true, z: true }) !== getDirectionKey('Y', { x: true, y: false, z: true }),
        'Opposite gizmo handles must start separate smart-scale sessions.'
    );
    console.assert(
        canContinueSmartScaleSession({ selectionKey: 'selection' }, 'selection'),
        'Every axis must retain the original scale reference until the selection changes.'
    );
    const shearFrame = getScaleFrame(
        new Matrix4(),
        new Matrix4().set(1, 0, 0, 0, 0.5, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1)
    );
    console.assert(
        Math.abs(new Vector3().setFromMatrixColumn(shearFrame, 0).dot(new Vector3().setFromMatrixColumn(shearFrame, 1))) > 1e-6,
        'Smart scale must preserve a sheared local frame so adjacent clones share an edge.'
    );
    const box = new Box3(new Vector3(0, 0, 0), new Vector3(1, 1, 1));
    const stretched = new Box3(new Vector3(0, 0, 0), new Vector3(2.1, 1, 1));
    const tinyBox = new Box3(new Vector3(), new Vector3(1e-8, 1, 1));
    const tinyStretched = new Box3(new Vector3(), new Vector3(2.1e-8, 1, 1));
    const halfSource = new Box3(new Vector3(), new Vector3(0.5, 1, 1));
    const partialSource = new Box3(new Vector3(), new Vector3(0.3, 1, 1));
    const narrowSource = new Box3(new Vector3(), new Vector3(0.2, 1, 1));
    const rebasedNarrowSource = getRebasedScaleState(box, narrowSource, 'X', { x: true, y: true, z: true });
    const filledNarrowSource = getScaleFillTarget(
        box,
        rebasedNarrowSource.sourceBox,
        new Vector3(0.8, 1, 1),
        rebasedNarrowSource.baseScaleRatio,
        'X',
        { x: true, y: true, z: true }
    );
    const first = box.clone().applyMatrix4(getScaleExtrudeDelta(box, stretched, { x: true, y: true, z: true }, new Vector3(0, 0, 0))!);
    const second = box.clone().applyMatrix4(getScaleExtrudeDelta(box, stretched, { x: true, y: true, z: true }, new Vector3(1, 0, 0))!);
    const corner = box.clone().applyMatrix4(getScaleExtrudeDelta(box, new Box3(new Vector3(), new Vector3(2.1, 1.1, 1)), { x: true, y: true, z: true }, new Vector3(1, 0, 0))!);
    const tinyFirst = tinyBox.clone().applyMatrix4(getScaleExtrudeDelta(tinyBox, tinyStretched, { x: true, y: true, z: true })!);
    const restoredSource = halfSource.clone().applyMatrix4(getScaleExtrudeDelta(box, stretched, { x: true, y: true, z: true }, undefined, halfSource)!);
    const resumedSource = partialSource.clone().applyMatrix4(getScaleExtrudeDelta(
        box, new Box3(new Vector3(), new Vector3(1.3, 1, 1)), { x: true, y: true, z: true }, undefined, partialSource
    )!);
    const extrudedFromNarrowSource = narrowSource.clone().applyMatrix4(getScaleExtrudeDelta(
        box, new Box3(new Vector3(), new Vector3(1, 1.5, 1)), { x: true, y: true, z: true }, undefined, narrowSource
    )!);
    const extrudedFromNarrowSize = extrudedFromNarrowSource.getSize(new Vector3());
    console.assert(Math.abs(first.min.x - 1) < 1e-9 && Math.abs(first.max.x - 2) < 1e-9, 'Smart scale must cap each clone at the source size.');
    console.assert(Math.abs(second.min.x - 2) < 1e-9 && Math.abs(second.max.x - 2.1) < 1e-9, 'Smart scale must continue with a new clone.');
    console.assert(Math.abs(corner.min.x - 2) < 1e-9 && Math.abs(corner.min.y - 1) < 1e-9, 'Smart scale axes must keep independent segment positions.');
    console.assert(Math.abs(tinyFirst.min.x - 1e-8) < 1e-16 && Math.abs(tinyFirst.max.x - 2e-8) < 1e-16, 'Smart scale must not skip near-zero-sized axes.');
    console.assert(Math.abs(restoredSource.getSize(new Vector3()).x - 1) < 1e-9, 'Opposite smart scale must retain the initial reference size.');
    console.assert(
        Math.abs(resumedSource.min.x - 0.3) < 1e-9 && Math.abs(resumedSource.max.x - 0.6) < 1e-9,
        'Resumed smart scale must start at the partial source edge without a gap.'
    );
    console.assert(
        Math.abs(extrudedFromNarrowSize.x - 0.2) < 1e-9
            && Math.abs(extrudedFromNarrowSize.y - 0.5) < 1e-9
            && Math.abs(extrudedFromNarrowSize.z - 1) < 1e-9,
        'Changing axes must preserve the current shape while using the original reference size.'
    );
    console.assert(
        Math.abs(rebasedNarrowSource.baseScaleRatio.x - 0.2) < 1e-9
            && Math.abs(filledNarrowSource.getSize(new Vector3()).x - 0.8) < 1e-9,
        'A partial source must fill to the reference size before smart scale duplicates it.'
    );
}
