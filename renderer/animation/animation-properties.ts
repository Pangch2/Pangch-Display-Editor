import type { Group, InstancedMesh } from 'three/webgpu';
import type { AnimationPose } from './animation-state';
import type { AnimationProperties } from './animation-data';
import { applyAnimationPose } from './animation-state';
import { currentLoadGen, loadedObjectGroup, setInstanceSkyBrightness } from '../load-project/display/display-instancing';
import { previewDisplayObjects, updateDisplayObjectMatrix, updateTextDisplay } from '../load-project/display/mesh-builder';
import { trackProjectEdit } from '../save/pending-edits';
import { yieldPreview } from './yield-preview';

type PendingProperties = { pose: AnimationPose; running: boolean; revision: number; invalidModels?: Map<string, string> };
const pendingProperties = new WeakMap<object, PendingProperties>();

function modelSignature(properties: AnimationProperties, texture?: string): string {
    return JSON.stringify([properties.displayType, properties.name, properties.options, properties.nbt, texture]);
}

export function hasPendingAnimationProperties(root: Group): boolean {
    return !!pendingProperties.get(root.userData.objectUuidToInstance)?.running;
}

export function applyAnimationProperties(root: Group, pose: AnimationPose): Set<string> {
    const data = root.userData;
    const refs = data.objectUuidToInstance;
    let update = refs && pendingProperties.get(refs);
    // Group-only previews must retain object restoration already in flight.
    if (update?.running) {
        update.revision++;
        for (const [id, node] of pose) update.pose.set(id, node);
    }
    else if (update) update.pose = new Map(pose);
    const currentType = (id: string) => data.objectTextDisplayOptions?.has(id) ? 'text_display'
        : data.objectIsItemDisplay?.has(id) ? 'item_display' : 'block_display';
    const matches = (id: string, value: AnimationProperties) => data.objectNames?.get(id) === value.name && currentType(id) === value.displayType
        && (value.displayType !== 'text_display' || JSON.stringify(data.objectTextDisplayOptions?.get(id)) === JSON.stringify(value.options));
    const pending = new Set<string>();
    let changed = false;
    for (const [id, node] of pose) {
        const properties = node.properties;
        if (!properties) continue;
        if (node.type === 'group') {
            const group = data.groups?.get(id);
            if (group && (group.nbt ?? '') !== properties.nbt) { group.nbt = properties.nbt; changed = true; }
            continue;
        }
        const ref = data.objectUuidToInstance?.get(id);
        if (!ref) continue;
        if ((data.objectNbt?.get(id) ?? '') !== properties.nbt) {
            (data.objectNbt ??= new Map()).set(id, properties.nbt); changed = true;
        }
        const brightness = data.objectBrightness?.get(id);
        if (brightness ? !properties.brightness || (brightness.sky ?? 15) !== properties.brightness.sky || (brightness.block ?? 0) !== properties.brightness.block
            : properties.brightness !== null) {
            if (properties.brightness) (data.objectBrightness ??= new Map()).set(id, { ...properties.brightness });
            else data.objectBrightness?.delete(id);
            if ((ref.mesh as InstancedMesh).isInstancedMesh) {
                setInstanceSkyBrightness(ref.mesh, ref.instanceId, properties.brightness ?? undefined);
                ref.mesh.instanceColor.needsUpdate = true;
            }
            changed = true;
        }
        if (root !== loadedObjectGroup) continue;
        if (matches(id, properties)) continue;
        pending.add(id);
    }
    const blocked = update?.invalidModels && [...update.invalidModels].some(([id, signature]) => {
        const node = pose.get(id);
        return pending.has(id) && node?.properties && modelSignature(node.properties, node.texture) === signature;
    });
    if (pending.size && !update?.running && !blocked) {
        if (!update) pendingProperties.set(refs, update = { pose: new Map(pose), running: false, revision: 0 });
        const state = update;
        const generation = currentLoadGen;
        const revision = state.revision;
        state.invalidModels = undefined;
        let failed = false;
        const attempted = new Map<string, string>();
        state.running = true;
        void trackProjectEdit((async () => {
            await yieldPreview();
            while (data.objectUuidToInstance === refs && generation === currentLoadGen) {
                const requests: Parameters<typeof previewDisplayObjects>[0] = [];
                let updated = false;
                let deadline = performance.now() + 8;
                for (const [id, node] of state.pose) {
                    const next = node.properties;
                    if (node.type !== 'object' || !next || !refs.has(id) || matches(id, next)) continue;
                    updated = true;
                    if (next.displayType === 'text_display' && currentType(id) === 'text_display') {
                        await updateTextDisplay(id, next.name!, next.options ?? {});
                        data.animationPreviewRevision = (data.animationPreviewRevision ?? 0) + 1;
                    } else if (next.displayType === 'item_display' && currentType(id) === 'item_display'
                        && next.name!.split('[')[0] === 'player_head'
                        && data.objectNames.get(id).split('[')[0] === next.name!.split('[')[0]) {
                        await updateDisplayObjectMatrix(id, next.name!, true);
                        data.animationPreviewRevision = (data.animationPreviewRevision ?? 0) + 1;
                    } else {
                        attempted.set(id, modelSignature(next, node.texture));
                        requests.push({ objectUuid: id, name: next.name!,
                            isItemDisplay: next.displayType === 'item_display', isTextDisplay: next.displayType === 'text_display', options: next.options,
                            paintTexture: node.texture });
                    }
                    if (performance.now() >= deadline) {
                        await yieldPreview(); deadline = performance.now() + 8;
                    }
                    if (data.objectUuidToInstance !== refs || generation !== currentLoadGen) return;
                }
                if (!updated) return;
                if (requests.length) await previewDisplayObjects(requests, request => {
                    const next = state.pose.get(request.objectUuid);
                    return next?.properties?.name === request.name
                        && (next.properties.displayType === 'item_display') === request.isItemDisplay
                        && (next.properties.displayType === 'text_display') === request.isTextDisplay
                        && JSON.stringify(next.properties.options) === JSON.stringify(request.options)
                        && next.texture === request.paintTexture;
                }, ids => {
                    applyAnimationPose(root, new Map(ids.flatMap(id => {
                        const node = state.pose.get(id);
                        return node ? [[id, node] as const] : [];
                    })));
                });
                if (data.objectUuidToInstance !== refs || generation !== currentLoadGen) return;
                applyAnimationPose(root, state.pose);
                window.dispatchEvent(new Event('pde:animation-preview'));
                window.dispatchEvent(new Event('pde:animation-properties-updated'));
            }
        })().catch(error => {
            failed = true;
            if (Array.isArray(error?.invalidObjectIds)) state.invalidModels = new Map(error.invalidObjectIds
                .filter((id: string) => attempted.has(id)).map((id: string) => [id, attempted.get(id)!]));
            if (error?.name !== 'AbortError') console.error('애니메이션 개체 속성을 복원하지 못했습니다.', error);
        })
            .finally(() => {
                state.running = false;
                if (failed && !state.invalidModels?.size && state.revision !== revision && generation === currentLoadGen && data.objectUuidToInstance === refs) {
                    applyAnimationProperties(root, state.pose);
                }
            }));
    }
    if (changed) window.dispatchEvent(new Event('pde:animation-properties-updated'));
    return pending;
}
