import {
    Group,
    MathUtils,
    Object3D } from 'three/webgpu';
import * as GroupUtils from './group';
import type { CloneJobEntry } from './group';
import * as Overlay from '../selection/overlay';
import { isPbdeLogEnabled, pbdeLogNames } from '../../load-project/pbde/pbde-log';
import { ObjectStore } from '../../scene-store/object-store';
import { objectIsCustomPivot, objectPivot, setObjectIsCustomPivot, setObjectPivot, type ObjectBatch } from '../../scene-store/object-access';
import { appendInstanceCopies } from '../../scene-store/object-batches';

const getDisplayType = Overlay.getDisplayType;

import { cloneAnimationTarget } from '../../animation/animation-state';

interface SceneOrderEntry {
    type: 'group' | 'object';
    id: string;
}

interface DuplicateUserData {
    objectUuidToInstance?: ObjectStore<{ mesh: Object3D; instanceId: number }>;
    objectToGroup?: Map<string, string>;
    objectNames?: Map<string, string>;
    objectLabels?: Map<string, string>;
    objectIsItemDisplay?: Set<string>;
    objectDisplayTypes?: Map<string, string>;
    objectBlockProps?: Map<string, unknown>;
    objectTextDisplayOptions?: Map<string, unknown>;
    objectNbt?: Map<string, string>;
    objectBrightness?: Map<string, unknown>;
    objectTextures?: Map<string, string>;
    objectDisplayKinds?: Map<string, string>;
    sceneOrder?: SceneOrderEntry[];
}

interface DirectSourceLocation {
    parentGroupId: string | null;
    index: number;
}

type PendingObjectEntry = GroupUtils.GroupChildObject | SceneOrderEntry;

interface PendingContainerInsertions {
    afterSource: Map<string, PendingObjectEntry[]>;
    fallback: PendingObjectEntry[];
}

interface DirectInsertionPlan {
    sourceLocations: Map<string, DirectSourceLocation>;
    byParent: Map<string | null, PendingContainerInsertions>;
}

interface CloneResult {
    mesh: ObjectBatch;
    instanceId: number;
    objectUuid: string;
    coveredByGroup: boolean;
}

interface DuplicateTimingStats {
    attrsMs: number;
    metadataMs: number;
}



export interface DuplicationSelection {
    groups: Set<string>;
    objects: Map<ObjectBatch, Set<number>>;
}

function cloneData<T>(value: T): T {
    if (value === null || value === undefined) return value;
    if (value instanceof Map) return new Map([...value].map(([key, val]) => [cloneData(key), cloneData(val)])) as T;
    if (value instanceof Set) return new Set([...value].map(cloneData)) as T;
    const clone = (value as { clone?: unknown }).clone;
    if (typeof clone === 'function') {
        try { return clone.call(value); } catch { /* fallback below */ }
    }
    if (typeof structuredClone === 'function') {
        try { return structuredClone(value); } catch { /* fallback below */ }
    }
    if (Array.isArray(value)) return value.map(cloneData) as T;
    if (typeof value === 'object') return { ...(value as Record<string, unknown>) } as T;
    return value;
}

function ensureStores(loadedObjectGroup: Group) {
    const ud = loadedObjectGroup.userData as DuplicateUserData;
    if (!ud.objectUuidToInstance) ud.objectUuidToInstance = new ObjectStore<{ mesh: Object3D; instanceId: number }>();
    if (!ud.objectNames) ud.objectNames = new Map<string, string>();
    if (!ud.objectLabels) ud.objectLabels = new Map<string, string>();
    if (!ud.objectIsItemDisplay) ud.objectIsItemDisplay = new Set<string>();
    if (!ud.objectDisplayTypes) ud.objectDisplayTypes = new Map<string, string>();
    if (!ud.objectBlockProps) ud.objectBlockProps = new Map<string, unknown>();
    if (!ud.objectTextDisplayOptions) ud.objectTextDisplayOptions = new Map<string, unknown>();
    return ud;
}

function registerClone(
    loadedObjectGroup: Group,
    sourceMesh: ObjectBatch,
    sourceInstanceId: number,
    targetMesh: ObjectBatch,
    targetInstanceId: number,
    targetGroupId: string | null
): string {
    const stores = ensureStores(loadedObjectGroup);
    const sourceUuid = stores.objectUuidToInstance!.uuidAt(sourceMesh, sourceInstanceId);
    const targetUuid = MathUtils.generateUUID();

    stores.objectUuidToInstance!.set(targetUuid, { mesh: targetMesh, instanceId: targetInstanceId });

    if (!sourceUuid) {
        stores.objectNames!.set(targetUuid, targetUuid.slice(0, 8));
        return targetUuid;
    }

    const sourceName = stores.objectNames!.get(sourceUuid);
    if (sourceName) stores.objectNames!.set(targetUuid, sourceName);
    const sourceLabel = stores.objectLabels!.get(sourceUuid);
    if (sourceLabel !== undefined) stores.objectLabels!.set(targetUuid, sourceLabel);
    if (stores.objectIsItemDisplay!.has(sourceUuid)) stores.objectIsItemDisplay!.add(targetUuid);

    const displayType = stores.objectDisplayTypes!.get(sourceUuid);
    if (displayType) stores.objectDisplayTypes!.set(targetUuid, displayType);

    if (stores.objectBlockProps!.has(sourceUuid)) {
        stores.objectBlockProps!.set(targetUuid, cloneData(stores.objectBlockProps!.get(sourceUuid)));
    }
    if (stores.objectTextDisplayOptions!.has(sourceUuid)) {
        const options = cloneData(stores.objectTextDisplayOptions!.get(sourceUuid));
        if (options && typeof options === 'object') delete (options as Record<string, unknown>).pageTypeValues;
        stores.objectTextDisplayOptions!.set(targetUuid, options);
    }
    if (stores.objectNbt?.has(sourceUuid)) stores.objectNbt.set(targetUuid, stores.objectNbt.get(sourceUuid)!);
    if (stores.objectBrightness?.has(sourceUuid)) {
        stores.objectBrightness.set(targetUuid, cloneData(stores.objectBrightness.get(sourceUuid)));
    }
    if (stores.objectTextures?.has(sourceUuid)) stores.objectTextures.set(targetUuid, stores.objectTextures.get(sourceUuid)!);
    setObjectPivot(loadedObjectGroup, targetUuid, objectPivot(loadedObjectGroup, sourceUuid)?.clone());
    if (targetMesh.userData.mixedDisplayKinds) {
        const kind = getDisplayType(sourceMesh, sourceInstanceId) ?? sourceMesh.userData?.displayType ?? 'block_display';
        (stores.objectDisplayKinds ??= new Map<string, string>()).set(targetUuid, kind);
    }
    setObjectIsCustomPivot(loadedObjectGroup, targetUuid, objectIsCustomPivot(loadedObjectGroup, sourceUuid));

    cloneAnimationTarget(loadedObjectGroup, sourceUuid, targetUuid, targetGroupId);

    return targetUuid;
}

function prepareDirectInsertionPlan(
    loadedObjectGroup: Group,
    jobs: CloneJobEntry[]
): DirectInsertionPlan {
    const stores = ensureStores(loadedObjectGroup);
    const groups = GroupUtils.getGroups(loadedObjectGroup);
    const sourceLocations = new Map<string, DirectSourceLocation>();
    const wantedByParent = new Map<string | null, Set<string>>();

    for (const job of jobs) {
        const sourceUuid = stores.objectUuidToInstance!.uuidAt(job.mesh, job.instanceId);
        if (!sourceUuid) continue;
        const parentGroupId = stores.objectToGroup?.get(sourceUuid) ?? null;
        let wanted = wantedByParent.get(parentGroupId);
        if (!wanted) wantedByParent.set(parentGroupId, wanted = new Set());
        wanted.add(sourceUuid);
    }

    for (const [parentGroupId, wanted] of wantedByParent) {
        const container = parentGroupId
            ? groups.get(parentGroupId)?.children
            : stores.sceneOrder;
        if (!Array.isArray(container)) continue;
        for (let index = 0; index < container.length; index++) {
            const entry = container[index];
            if (entry.type === 'object' && wanted.has(entry.id!)) {
                sourceLocations.set(entry.id!, { parentGroupId, index });
            }
        }
    }

    return { sourceLocations, byParent: new Map() };
}

function getPendingContainer(plan: DirectInsertionPlan, parentGroupId: string | null): PendingContainerInsertions {
    let pending = plan.byParent.get(parentGroupId);
    if (!pending) {
        pending = { afterSource: new Map(), fallback: [] };
        plan.byParent.set(parentGroupId, pending);
    }
    return pending;
}

function queueDirectCloneEntry(
    plan: DirectInsertionPlan,
    sourceUuid: string | undefined,
    targetGroupId: string | null,
    entry: PendingObjectEntry
): void {
    const location = sourceUuid ? plan.sourceLocations.get(sourceUuid) : undefined;
    const pending = getPendingContainer(plan, targetGroupId);
    if (!sourceUuid || location?.parentGroupId !== targetGroupId) {
        pending.fallback.push(entry);
        return;
    }

    let entries = pending.afterSource.get(sourceUuid);
    if (!entries) pending.afterSource.set(sourceUuid, entries = []);
    entries.push(entry);
}

function flushDirectCloneInsertions(loadedObjectGroup: Group, plan: DirectInsertionPlan): void {
    const groups = GroupUtils.getGroups(loadedObjectGroup);
    const stores = ensureStores(loadedObjectGroup);

    for (const [parentGroupId, pending] of plan.byParent) {
        const container = parentGroupId ? groups.get(parentGroupId)?.children : stores.sceneOrder;
        if (!Array.isArray(container)) continue;

        const rebuilt: PendingObjectEntry[] = [];
        for (const entry of container) {
            rebuilt.push(entry);
            if (entry.type !== 'object' || !entry.id) continue;
            const additions = pending.afterSource.get(entry.id);
            if (!additions) continue;
            rebuilt.push(...additions);
            pending.afterSource.delete(entry.id);
        }
        for (const additions of pending.afterSource.values()) rebuilt.push(...additions);
        rebuilt.push(...pending.fallback);

        if (parentGroupId) {
            const parent = groups.get(parentGroupId);
            if (parent) parent.children = rebuilt as GroupUtils.GroupChild[];
        } else {
            stores.sceneOrder = rebuilt as SceneOrderEntry[];
        }
    }
}

function insertCloneEntry(
    loadedObjectGroup: Group,
    sourceMesh: ObjectBatch,
    sourceInstanceId: number,
    targetGroupId: string | null,
    targetUuid: string,
    coveredByGroup: boolean,
    insertionPlan: DirectInsertionPlan
): void {
    const stores = ensureStores(loadedObjectGroup);
    const sourceUuid = stores.objectUuidToInstance!.uuidAt(sourceMesh, sourceInstanceId);

    if (targetGroupId) {
        const targetGroup = GroupUtils.getGroups(loadedObjectGroup).get(targetGroupId);
        if (!targetGroup) return;
        if (!Array.isArray(targetGroup.children)) targetGroup.children = [];

        stores.objectToGroup = GroupUtils.getObjectToGroup(loadedObjectGroup);
        stores.objectToGroup.set(targetUuid, targetGroupId);

        if (!coveredByGroup) {
            queueDirectCloneEntry(insertionPlan, sourceUuid, targetGroupId, { type: 'object', id: targetUuid });
            return;
        }

        targetGroup.children.push({ type: 'object', id: targetUuid });
        return;
    }

    queueDirectCloneEntry(insertionPlan, sourceUuid, null, { type: 'object', id: targetUuid });
}

function getAncestorSelected(groups: Map<string, GroupUtils.GroupData>, groupId: string | null | undefined, selectedGroups: Set<string> | null): boolean {
    let current = groupId ?? null;
    while (current) {
        if (selectedGroups?.has(current)) return true;
        current = groups.get(current)?.parent ?? null;
    }
    return false;
}

function cloneInstancedBatch(
    loadedObjectGroup: Group,
    sourceMesh: ObjectBatch,
    jobs: CloneJobEntry[],
    insertionPlan: DirectInsertionPlan,
    timings?: DuplicateTimingStats
): CloneResult[] {
    const attrsStart = timings ? performance.now() : 0;
    const slots = appendInstanceCopies(sourceMesh, jobs.map(job => job.instanceId));
    if (slots.length !== jobs.length) return [];
    if (timings) {
        timings.attrsMs += performance.now() - attrsStart;
    }
    const metadataStart = timings ? performance.now() : 0;
    const results = jobs.map((job, index) => {
        const { mesh, instanceId } = slots[index];
        const objectUuid = registerClone(loadedObjectGroup, sourceMesh, job.instanceId, mesh, instanceId, job.targetGroupId ?? null);
        insertCloneEntry(loadedObjectGroup, sourceMesh, job.instanceId, job.targetGroupId, objectUuid, job.coveredByGroup, insertionPlan);
        return { mesh, instanceId, objectUuid, coveredByGroup: job.coveredByGroup };
    });
    if (timings) timings.metadataMs += performance.now() - metadataStart;
    return results;
}

function addSelection(selection: DuplicationSelection, result: CloneResult): void {
    if (result.coveredByGroup) return;
    if (!selection.objects.has(result.mesh)) selection.objects.set(result.mesh, new Set());
    selection.objects.get(result.mesh)!.add(result.instanceId);
}

export function flushPendingHeadClones(_loadedObjectGroup?: Group, _ctx?: unknown): Array<{ mesh: ObjectBatch, instanceId: number, targetGroupId: string | null, coveredByGroup: boolean }> {
    return [];
}

export function duplicateGroupsAndObjects(
    loadedObjectGroup: Group,
    groupIds: Set<string> | null,
    objectEntries: Array<{ mesh: ObjectBatch, instanceId: number }> | null
): DuplicationSelection {
    const logTimings = isPbdeLogEnabled(pbdeLogNames.duplicateTimings);
    const totalStart = logTimings ? performance.now() : 0;
    const timings: DuplicateTimingStats | undefined = logTimings ? { attrsMs: 0, metadataMs: 0 } : undefined;
    let groupCloneMs = 0;
    let collectMs = 0;
    let instancedCloneMs = 0;

    const newSelection: DuplicationSelection = { groups: new Set(), objects: new Map() };
    const groups = GroupUtils.getGroups(loadedObjectGroup);
    const idMap = new Map<string, string>();
    const jobs: CloneJobEntry[] = [];
    const directJobs: CloneJobEntry[] = [];
    const cloneGroupCtx = groupIds ? GroupUtils.createCloneGroupContext(loadedObjectGroup) : undefined;

    if (objectEntries) {
        const collectStart = logTimings ? performance.now() : 0;
        for (const { mesh, instanceId } of objectEntries) {
            const parentGroupId = GroupUtils.getSlotGroupId(loadedObjectGroup, mesh, instanceId) ?? null;
            if (getAncestorSelected(groups, parentGroupId, groupIds)) continue;
            directJobs.push({ mesh, instanceId, targetGroupId: parentGroupId as string, coveredByGroup: false });
        }
        if (logTimings) collectMs += performance.now() - collectStart;
    }

    const insertionPlan = prepareDirectInsertionPlan(loadedObjectGroup, directJobs);

    if (groupIds) {
        const groupCloneStart = logTimings ? performance.now() : 0;
        for (const groupId of groupIds) {
            const group = groups.get(groupId);
            if (!group || getAncestorSelected(groups, group.parent, groupIds)) continue;

            const newGroupId = GroupUtils.cloneGroupStructure(loadedObjectGroup, groupId, group.parent, idMap, cloneGroupCtx);
            if (newGroupId) newSelection.groups.add(newGroupId);
        }
        if (logTimings) groupCloneMs += performance.now() - groupCloneStart;

        const collectStart = logTimings ? performance.now() : 0;
        for (const groupId of groupIds) {
            const group = groups.get(groupId);
            const newGroupId = idMap.get(groupId);
            if (!group || !newGroupId || getAncestorSelected(groups, group.parent, groupIds)) continue;

            GroupUtils.collectCloneJobsFromGroup(
                loadedObjectGroup,
                groupId,
                newGroupId,
                { _groupIdMap: idMap },
                jobs
            );
        }
        if (logTimings) collectMs += performance.now() - collectStart;
    }

    for (const job of directJobs) jobs.push(job);

    const instancedJobs = new Map<ObjectBatch, CloneJobEntry[]>();
    for (const job of jobs) {
        let bucket = instancedJobs.get(job.mesh);
        if (!bucket) instancedJobs.set(job.mesh, bucket = []);
        bucket.push(job);
    }

    for (const [sourceMesh, batchJobs] of instancedJobs) {
        const instancedStart = logTimings ? performance.now() : 0;
        const results = cloneInstancedBatch(loadedObjectGroup, sourceMesh, batchJobs, insertionPlan, timings);
        if (logTimings) instancedCloneMs += performance.now() - instancedStart;
        for (const result of results) {
            addSelection(newSelection, result);
        }
    }

    flushDirectCloneInsertions(loadedObjectGroup, insertionPlan);

    if (logTimings && timings) {
        console.log(
            `[PBDE] Duplicate timings: total=${(performance.now() - totalStart).toFixed(2)}ms ` +
            `jobs=${jobs.length} ` +
            `groups=${newSelection.groups.size} batches=${instancedJobs.size} ` +
            `groupClone=${groupCloneMs.toFixed(2)}ms collect=${collectMs.toFixed(2)}ms ` +
            `instancedClone=${instancedCloneMs.toFixed(2)}ms ` +
            `attrs=${timings.attrsMs.toFixed(2)}ms metadata=${timings.metadataMs.toFixed(2)}ms`
        );
    }

    return newSelection;
}
