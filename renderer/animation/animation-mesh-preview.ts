import { Matrix4, type Group } from 'three/webgpu';
import { getBatchMatrixVersion, getInstanceCount, type ObjectBatch } from '../scene-store/object-access';
import type { AnimationPose } from './animation-state';

type MeshState = {
    mesh: ObjectBatch;
    parent: string | null;
    matrix: Matrix4;
    inverseParent: Matrix4;
    autoUpdate: boolean;
    version: number;
    count: number;
};

export type AnimationMeshPreview = {
    source: AnimationPose;
    base: AnimationPose;
    size: number;
    objects: Map<string, { mesh: ObjectBatch; instanceId: number }>;
    groups: unknown;
    groupCount: number;
    animatedGroups: Set<string>;
    local: AnimationPose;
    groupBase: AnimationPose;
    meshes: Map<ObjectBatch, MeshState>;
    valid: boolean;
};

export function createAnimationMeshPreview(root: Group, local: AnimationPose, base: AnimationPose, animatedGroups: Set<string>): AnimationMeshPreview | undefined {
    const objects = root.userData.objectUuidToInstance as AnimationMeshPreview['objects'];
    if (!objects) return undefined;
    const preview: AnimationMeshPreview = {
        source: local, base, size: local.size, objects, groups: root.userData.groups, groupCount: root.userData.groups?.size ?? 0, animatedGroups,
        local: new Map(), groupBase: new Map(), meshes: new Map(), valid: true
    };
    const counts = new Map<ObjectBatch, number>();
    const parents = new Map<string, string | null>();
    const motionParent = (id: string | null): string | null => {
        if (!id || animatedGroups.has(id)) return id;
        if (!parents.has(id)) parents.set(id, motionParent(local.get(id)?.parent ?? null));
        return parents.get(id)!;
    };
    for (const [id, node] of local) {
        if (node.type === 'group') {
            preview.local.set(id, node);
            preview.groupBase.set(id, base.get(id)!);
            continue;
        }
        const ref = objects.get(id);
        if (!ref || ref.mesh.parent !== root) return undefined;
        const { mesh } = ref;
        const parentId = motionParent(node.parent);
        let state = preview.meshes.get(mesh);
        if (!state) {
            const parent = parentId && base.get(parentId);
            const inverseParent = parent ? new Matrix4().fromArray(parent.matrix) : new Matrix4();
            if (inverseParent.determinant() === 0) return undefined;
            if (mesh.matrixAutoUpdate) mesh.updateMatrix();
            preview.meshes.set(mesh, state = { mesh, parent: parentId, matrix: mesh.matrix.clone(),
                inverseParent: inverseParent.invert(), autoUpdate: mesh.matrixAutoUpdate, version: getBatchMatrixVersion(mesh), count: getInstanceCount(mesh) });
        }
        // shortcut: independently animated groups sharing a batch use per-instance playback; split batches if that becomes a bottleneck.
        if (state.parent !== parentId) return undefined;
        counts.set(mesh, (counts.get(mesh) ?? 0) + 1);
    }
    for (const [mesh, count] of counts) if (count !== getInstanceCount(mesh)) return undefined;
    return preview;
}

export function canReuseAnimationMeshPreview(root: Group, preview: AnimationMeshPreview, local: AnimationPose, base: AnimationPose, animatedGroups: Set<string>): boolean {
    if (!preview.valid || preview.source !== local || preview.base !== base || preview.size !== local.size
        || preview.objects !== root.userData.objectUuidToInstance || preview.groups !== root.userData.groups
        || preview.groupCount !== (root.userData.groups?.size ?? 0) || local.size !== preview.objects.size + preview.groupCount
        || preview.animatedGroups.size !== animatedGroups.size || [...animatedGroups].some(id => !preview.animatedGroups.has(id))) return false;
    for (const state of preview.meshes.values()) {
        if (state.mesh.parent !== root || getBatchMatrixVersion(state.mesh) !== state.version || getInstanceCount(state.mesh) !== state.count) return false;
    }
    return true;
}

export function applyAnimationMeshPreview(root: Group, preview: AnimationMeshPreview, pose: AnimationPose): void {
    const value = new Matrix4();
    for (const state of preview.meshes.values()) {
        const parent = state.parent && pose.get(state.parent);
        if (parent) value.fromArray(parent.matrix).multiply(state.inverseParent).multiply(state.matrix);
        else value.copy(state.matrix);
        state.mesh.matrixAutoUpdate = false;
        if (state.mesh.matrix.equals(value)) continue;
        state.mesh.matrix.copy(value);
        state.mesh.matrixWorldNeedsUpdate = true;
    }
    root.updateMatrixWorld(true);
}

export function restoreAnimationMeshPreview(preview: AnimationMeshPreview): void {
    for (const state of preview.meshes.values()) {
        state.mesh.matrix.copy(state.matrix);
        state.mesh.matrixAutoUpdate = state.autoUpdate;
        state.mesh.matrixWorldNeedsUpdate = true;
    }
}
