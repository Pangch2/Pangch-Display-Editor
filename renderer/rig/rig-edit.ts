import { Matrix4, type Group } from 'three/webgpu';
import { applyTransformHistoryState, captureTransformState, recordStateChange, refreshHistory } from '../controls/undo-redo/scene-history';
import { getInstanceMatrix, invalidateBatchBounds, objectRef, objectSlots, setInstanceMatrix, type ObjectBatch } from '../scene-store/object-access';
import { captureRig, restoreRig, rigData, rigRestWorlds } from './rig-data';

export function rigChanged(): void { window.dispatchEvent(new Event('pde:rig-changed')); }

const nearIdentity = (matrix: Matrix4) => matrix.elements.every((value, index) => Math.abs(value - (index % 5 === 0 ? 1 : 0)) < 1e-6);

/**
 * Starts an edit-mode rig change. follow() carries bound displays along their bones' rest moves, blended by weight like the skin
 * (in Blockbench a bone moved in edit mode carries its mesh); commit() records the rig and those displays as one undo step.
 */
export function beginRigEdit(root: Group) {
    const before = captureRig(root);
    const bound = [...new Set(before.armatures.flatMap(armature => Object.keys(armature.weights)))];
    const transform = bound.length ? captureTransformState(root, objectSlots(root, bound), []) : undefined;
    const rests = new Map(before.armatures.map(armature => [armature.id, rigRestWorlds(armature)]));
    const starts = new Map<string, Matrix4>(), moved = new Set<string>();
    for (const id of bound) {
        const ref = objectRef(root, id);
        if (ref) starts.set(id, getInstanceMatrix(ref.mesh, ref.instanceId, new Matrix4()));
    }
    const follow = (): void => {
        const batches = new Set<ObjectBatch>(), blend = new Matrix4();
        root.updateWorldMatrix(true, true);
        for (const armature of rigData(root).armatures) {
            const was = rests.get(armature.id), moves = new Map<string, Matrix4>();
            if (!was) continue;
            for (const [id, world] of rigRestWorlds(armature)) {
                const old = was.get(id);
                if (old && old.determinant() !== 0) moves.set(id, world.clone().multiply(old.clone().invert()));
            }
            for (const [id, weights] of Object.entries(armature.weights)) {
                const start = starts.get(id), ref = objectRef(root, id);
                if (!start || !ref) continue;
                blend.elements.fill(0);
                let sum = 0;
                for (const [bone, weight] of Object.entries(weights)) {
                    const move = weight > 0 ? moves.get(bone) : undefined;
                    if (!move) continue;
                    for (let index = 0; index < 16; index++) blend.elements[index] += move.elements[index] * weight;
                    sum += weight;
                }
                if (sum) blend.multiplyScalar(1 / sum); else blend.identity();
                if (nearIdentity(blend) && !moved.has(id)) continue;
                moved.add(id);
                // Instance matrices are relative to their batch, bones to the project root.
                const toBatch = ref.mesh.matrixWorld.clone().invert().multiply(root.matrixWorld);
                setInstanceMatrix(ref.mesh, ref.instanceId, toBatch.clone().multiply(blend).multiply(toBatch.invert()).multiply(start));
                batches.add(ref.mesh);
            }
        }
        batches.forEach(invalidateBatchBounds);
    };
    const commit = (): void => {
        const after = captureRig(root);
        if (JSON.stringify(after) === JSON.stringify(before)) return;
        const afterTransform = moved.size ? captureTransformState(root, objectSlots(root, bound), []) : undefined;
        recordStateChange({
            before: { rig: before, transform: afterTransform && transform },
            after: { rig: after, transform: afterTransform },
            apply: state => {
                restoreRig(root, state.rig);
                if (state.transform) applyTransformHistoryState(root, state.transform);
            },
            refresh: () => { if (afterTransform) refreshHistory(root); rigChanged(); }
        });
        if (afterTransform) window.dispatchEvent(new CustomEvent('pde:scene-updated'));
        rigChanged();
    };
    return { before, follow, commit };
}
export type RigEdit = ReturnType<typeof beginRigEdit>;

/** Applies a rig edit as one undo step; a failed edit is rolled back and rethrown. */
export function editRig(root: Group, action: () => void): void {
    const edit = beginRigEdit(root);
    try { action(); } catch (error) { restoreRig(root, edit.before); throw error; }
    edit.follow();
    edit.commit();
}
