import type { Group, InstancedMesh, Mesh } from 'three/webgpu';
import { getAllDescendantGroups, getAllGroupChildren } from '../grouping/group';
import type { SelectionState } from '../selection/select';
import { getLinkedMirrorSelection } from '../transform/mirroring';
import { captureSelectionTransformState, type TransformHistoryState } from '../undo-redo/scene-history';
import type { QueueItem, SelectionSource } from './vertex-swap';

export function captureVertexHistoryState(
    root: Group,
    selection: SelectionState,
    queue: QueueItem[],
    source?: SelectionSource
): TransformHistoryState {
    const objects = new Map<Mesh | InstancedMesh, Set<number>>(
        Array.from(selection.objects, ([mesh, ids]) => [mesh, new Set(ids)])
    );
    const groups = new Set(selection.groups);
    const addObject = (mesh: Mesh | InstancedMesh, instanceId: number): void => {
        const ids = objects.get(mesh) ?? new Set<number>();
        ids.add(instanceId);
        objects.set(mesh, ids);
    };

    // Queued sources can move even though they are no longer selected.
    for (const item of queue) {
        for (const entry of item.type === 'bundle' ? item.items : [item]) {
            if (entry.type === 'group') groups.add(entry.id!);
            else addObject(entry.mesh!, entry.instanceId!);
        }
    }
    if (source?.type === 'group') groups.add(source.id);
    else if (source?.type === 'object') addObject(source.mesh, source.instanceId);

    // Snap applies mirror deltas to group descendants as well as direct objects.
    for (const groupId of [...groups]) {
        getAllDescendantGroups(root, groupId).forEach(id => groups.add(id));
        getAllGroupChildren(root, groupId).forEach(({ mesh, instanceId }) => addObject(mesh, instanceId));
    }
    const items = Array.from(objects, ([mesh, ids]) =>
        [...ids].map(instanceId => ({ type: 'object' as const, mesh, instanceId }))
    ).flat();
    const linked = getLinkedMirrorSelection(root, items, groups);
    linked.objects.forEach((ids, mesh) => ids.forEach(id => addObject(mesh, id)));
    linked.groups.forEach(id => groups.add(id));

    const before = captureSelectionTransformState(root, objects, groups);
    // The first click is a pending snap gesture, not a selection to restore on undo.
    before.ui.gizmo?.selectedVertexKeys.clear();
    return before;
}
