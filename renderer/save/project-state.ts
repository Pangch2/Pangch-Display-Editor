import { Matrix4, Vector3, Quaternion, type Group } from 'three/webgpu';
import { getPlayerHeadTexture } from '../load-project/display/player-head-atlas';
import { applySceneVisibility } from '../controls/scene-visibility';
import { getMirrorPlane, setMirrorPlane, worldXReflection } from '../controls/transform/mirror-planes';
import type { GroupData } from '../controls/grouping/group';
import { runSteps, validatePdeProject, type PdeEditorState, type PdeNode, type PdeProject, type ObjectEditorState } from './pde-format';
import { animationCameraObject } from '../animation/animation-camera';
import { animationSession, serializeAnimation, importAnimation, renderModelTransform } from '../animation/animation-state';
import { getDisplayType, getInstanceHasHat, getInstanceMatrix, hasInstanceHatData, objectHeadValues, objectIsCustomPivot, objectPivot, setInstanceHasHat,
    setObjectHeadValues, setObjectIsCustomPivot, setObjectPivot, type ObjectRef } from '../scene-store/object-access';

export type ProjectSelection = { groups: Iterable<string>; objectUuids: Iterable<string> };

export function serializeProject(root: Group, selection?: ProjectSelection): PdeProject {
    const project = runSteps(serializeProjectSteps(root, selection));
    validatePdeProject(project);
    return project;
}

/** Reads the project stepwise (yields every few thousand objects); the result is not validated yet. */
export function* serializeProjectSteps(root: Group, selection?: ProjectSelection): Generator<void, PdeProject> {
    let work = 0;
    const data = root.userData;
    const refs = (data.objectUuidToInstance ?? new Map()) as Map<string, ObjectRef>;
    const groups = (data.groups ?? new Map()) as Map<string, GroupData>;
    const state: PdeEditorState = {
        version: 1, objects: [], groups: [],
        hiddenObjectUuids: [...(data.hiddenObjectUuids ?? [])].filter(id => refs.has(id)),
        hiddenGroupIds: [...(data.hiddenGroupIds ?? [])].filter(id => groups.has(id)),
        objectMirrorPairs: [...(data.objectMirrorPairs ?? [])].filter(([a, b]) => refs.has(a) && refs.has(b)),
        groupMirrorPairs: [...(data.groupMirrorPairs ?? [])].filter(([a, b]) => groups.has(a) && groups.has(b)),
        globalBrightness: !selection && data.globalBrightness ? { ...data.globalBrightness } : undefined
    };
    root.updateWorldMatrix(true, true);
    const inverse = root.matrixWorld.clone().invert();
    const seenObjects = new Set<string>();
    const seenGroups = new Set<string>();
    const groupStack = new Set<string>();
    const saveObject = (uuid: string): PdeNode | undefined => {
        if (selection && uuid === animationCameraObject(root)) return undefined; // the camera is unique: it is never copied
        const ref = refs.get(uuid);
        if (!ref || seenObjects.has(uuid)) return undefined;
        seenObjects.add(uuid);
        const { mesh, instanceId } = ref;
        mesh.updateWorldMatrix(true, false);
        const base = animationSession(root);
        const properties = base.enabled ? base.base.get(uuid)?.properties : undefined;
        const name = properties?.name ?? data.objectNames?.get(uuid) ?? mesh.name ?? '';
        const type = getDisplayType(mesh, instanceId);
        const isText = properties ? properties.displayType === 'text_display' : type === 'text_display' || data.objectTextDisplayOptions?.has(uuid);
        const isItem = !isText && (properties ? properties.displayType === 'item_display' : data.objectIsItemDisplay?.has(uuid) ?? type === 'item_display');
        const isHead = isItem && name.split('[')[0].replace(/^minecraft:/, '') === 'player_head';
        const renderModel = renderModelTransform(root, uuid, mesh, instanceId);
        const matrix = getInstanceMatrix(mesh, instanceId, new Matrix4()).multiply(renderModel.clone().invert());
        matrix.premultiply(inverse.clone().multiply(mesh.matrixWorld));
        if (base.enabled && base.base.has(uuid)) matrix.fromArray(base.base.get(uuid)!.matrix);
        const object: ObjectEditorState = { uuid, label: data.objectLabels?.get(uuid) };
        const pivot = objectPivot(root, uuid);
        // Pivots use display coordinates so a different render batch keeps the same point.
        if (base.enabled) object.pivot = base.base.get(uuid)?.pivot;
        else if (pivot) object.pivot = pivot.clone().applyMatrix4(renderModel).toArray();
        const isCustomPivot = base.enabled ? base.base.get(uuid)?.isCustomPivot : objectIsCustomPivot(root, uuid);
        if (isCustomPivot !== undefined) object.isCustomPivot = isCustomPivot;
        Object.assign(object, objectHeadValues(root, uuid));
        if (mesh.userData.imageHeadLayer !== undefined) object.imageHeadLayer = mesh.userData.imageHeadLayer;
        state.objects.push(object);
        const paintTexture = isHead ? (base.enabled ? base.base.get(uuid)?.texture : undefined) ?? getPlayerHeadTexture(uuid, data) : undefined;
        if (hasInstanceHatData(mesh)) object.hasHat = (base.enabled ? base.base.get(uuid)?.hasHat : undefined) ?? getInstanceHasHat(mesh, instanceId);
        if (isHead && !paintTexture) throw new Error(`헤드 텍스처를 저장할 수 없습니다: ${uuid}`);
        return {
            uuid, name, transforms: matrix.transpose().toArray(), nbt: properties?.nbt ?? data.objectNbt?.get(uuid) ?? '',
            brightness: properties ? properties.brightness ?? undefined : data.objectBrightness?.get(uuid),
            ...(isText ? { isTextDisplay: true, options: structuredClone(properties ? properties.options ?? {} : data.objectTextDisplayOptions?.get(uuid) ?? {}) }
                : isItem ? { isItemDisplay: true, paintTexture } : { isBlockDisplay: true })
        };
    };
    // Objects are saved directly; only groups step, so a big scene doesn't make a generator per object.
    const saveGroup = function* (id: string): Generator<void, PdeNode | undefined> {
        if (groupStack.has(id)) throw new Error('순환 그룹은 저장할 수 없습니다.');
        const group = groups.get(id);
        if (!group || seenGroups.has(id)) return undefined;
        seenGroups.add(id);
        groupStack.add(id);
        const session = animationSession(root);
        const baseMatrix = session.enabled ? session.base.get(id)?.matrix : undefined;
        const position = group.position.clone(), quaternion = group.quaternion.clone(), scale = group.scale.clone();
        if (baseMatrix) {
            new Matrix4().fromArray(baseMatrix).decompose(position, quaternion, scale);
            if (!Number.isFinite(quaternion.w)) quaternion.identity();
        }
        state.groups.push({
            id, position: position.toArray(), quaternion: quaternion.toArray(), scale: scale.toArray(),
            matrix: baseMatrix ?? group.matrix?.toArray(),
            pivot: session.enabled ? session.base.get(id)?.pivot
                : group.pivot ? Array.isArray(group.pivot) ? [...group.pivot] : group.pivot.toArray() : undefined,
            isCustomPivot: group.isCustomPivot
        });
        const children: PdeNode[] = [];
        for (const child of group.children) {
            const node = child.type === 'object' ? saveObject(child.id) : yield* saveGroup(child.id);
            if (node) children.push(node);
            if (++work % 1024 === 0) yield;
        }
        groupStack.delete(id);
        return { uuid: id, name: group.name, isCollection: true, transforms: new Matrix4().toArray(),
            nbt: (session.enabled ? session.base.get(id)?.properties?.nbt : undefined) ?? group.nbt ?? '', children };
    };
    const children: PdeNode[] = [];
    const selectedGroups = new Set(selection?.groups);
    const selectedObjects = new Set(selection?.objectUuids);
    const coveredBySelection = (parent: string | undefined): boolean => {
        const visited = new Set<string>();
        while (parent && !visited.has(parent)) {
            if (selectedGroups.has(parent)) return true;
            visited.add(parent);
            parent = groups.get(parent)?.parent;
        }
        return false;
    };
    // Scene order first, then anything it missed; listed lazily so a big scene isn't copied up front.
    const entries = function* (): Generator<{ type: string; id: string }> {
        yield* (data.sceneOrder ?? []) as { type: string; id: string }[];
        for (const group of groups.values()) if (!group.parent) yield { type: 'group', id: group.id };
        for (const id of groups.keys()) yield { type: 'group', id };
        for (const id of refs.keys()) yield { type: 'object', id };
    };
    for (const entry of entries()) {
        if (selection) {
            const parent = entry.type === 'group' ? groups.get(entry.id)?.parent : data.objectToGroup?.get(entry.id);
            if (!(entry.type === 'group' ? selectedGroups : selectedObjects).has(entry.id) || coveredBySelection(parent)) continue;
        }
        const node = entry.type === 'object' ? saveObject(entry.id) : yield* saveGroup(entry.id);
        if (node) children.push(node);
        if (++work % 1024 === 0) yield;
    }
    state.hiddenObjectUuids = state.hiddenObjectUuids.filter(id => seenObjects.has(id));
    state.hiddenGroupIds = state.hiddenGroupIds.filter(id => seenGroups.has(id));
    state.objectMirrorPairs = state.objectMirrorPairs.filter(([a, b]) => seenObjects.has(a) && seenObjects.has(b));
    state.groupMirrorPairs = state.groupMirrorPairs.filter(([a, b]) => seenGroups.has(a) && seenGroups.has(b));
    state.mirrorPlanes = [...state.objectMirrorPairs, ...state.groupMirrorPairs].filter(([a, b]) => a < b)
        .map(([a, b]) => [a, getMirrorPlane(root, a, b)] as [string, Matrix4])
        .filter(([, plane]) => plane !== worldXReflection).map(([id, plane]) => [id, plane.toArray()]);
    state.animation = serializeAnimation(root, seenObjects, seenGroups, !!selection);
    const project: PdeProject = {
        pdeFormatVersion: 1, name: data.projectDetails?.name ?? '', mainNBT: data.projectDetails?.mainNBT ?? '',
        nbt: data.projectDetails?.nbt ?? '',
        parentEntity: data.projectDetails?.parentEntity ?? 'item_display',
        summonPosition: data.projectDetails?.summonPosition ?? '~ ~ ~',
        children, editorState: state
    };
    return project;
}

export function restoreEditorState(root: Group, state: PdeEditorState | undefined, isMerge: boolean,
    objectIds = new Map<string, string>(), groupIds = new Map<string, string>()): void {
    if (!state) return;
    const data = root.userData;
    const refs = data.objectUuidToInstance as Map<string, ObjectRef>;
    const objectId = (id: string) => objectIds.get(id) ?? id;
    const groupId = (id: string) => groupIds.get(id) ?? id;
    for (const object of state.objects) {
        const uuid = objectId(object.uuid);
        const ref = refs.get(uuid);
        if (!ref) throw new Error(`PDE 오브젝트를 복원할 수 없습니다: ${uuid}`);
        const { mesh, instanceId } = ref;
        if (object.label !== undefined) data.objectLabels.set(uuid, object.label);
        const pivot = object.pivot ?? object.customPivot;
        if (pivot) setObjectPivot(root, uuid, new Vector3().fromArray(pivot).applyMatrix4(renderModelTransform(root, uuid, mesh, instanceId).invert()));
        if (object.isCustomPivot !== undefined) setObjectIsCustomPivot(root, uuid, object.isCustomPivot);
        setObjectHeadValues(root, uuid, object);
        if (object.hasHat !== undefined) setInstanceHasHat(mesh, instanceId, object.hasHat);
    }
    for (const group of state.groups) {
        const target = (data.groups as Map<string, GroupData>).get(groupId(group.id));
        if (!target) throw new Error(`PDE 그룹을 복원할 수 없습니다: ${group.id}`);
        target.position = new Vector3().fromArray(group.position);
        target.quaternion = new Quaternion().fromArray(group.quaternion);
        target.scale = new Vector3().fromArray(group.scale);
        if (group.matrix) target.matrix = new Matrix4().fromArray(group.matrix);
        if (group.pivot) target.pivot = new Vector3().fromArray(group.pivot);
        target.isCustomPivot = group.isCustomPivot;
    }
    for (const [key, remap] of [['hiddenObjectUuids', objectId], ['hiddenGroupIds', groupId]] as const) {
        const values = isMerge ? data[key] ?? new Set<string>() : new Set<string>();
        state[key].forEach(id => values.add(remap(id)));
        data[key] = values;
    }
    for (const [key, remap] of [['objectMirrorPairs', objectId], ['groupMirrorPairs', groupId]] as const) {
        const values = isMerge ? data[key] ?? new Map<string, string>() : new Map<string, string>();
        state[key].forEach(([a, b]) => values.set(remap(a), remap(b)));
        data[key] = values;
    }
    if (!isMerge) data.mirrorPlanes = new Map();
    for (const [id, plane] of state.mirrorPlanes ?? []) {
        const a = objectIds.get(id) ?? groupIds.get(id) ?? id;
        const b = data.objectMirrorPairs.get(a) ?? data.groupMirrorPairs.get(a);
        if (b) setMirrorPlane(root, a, b, new Matrix4().fromArray(plane));
    }
    if (!isMerge) data.globalBrightness = state.globalBrightness;
    importAnimation(root, state.animation, isMerge, objectIds, groupIds);
    applySceneVisibility(root);
}
