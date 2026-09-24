import * as THREE from 'three/webgpu';
import { type GeometryInstanceMeta, type GeometryMeta, type OtherItem } from '../pbde/pbde-types';
import { planUvTransforms } from '../batching/geometry-batching';
import { setEntityStateAttributes } from '../../entity-material';
import { createTextDisplayTemplates, getTextDisplayTemplateKey, textDisplayInstanceAttributeNames } from './text-display';

export const loadedObjectGroup = new THREE.Group();

export type GlobalBrightness = { enabled: boolean; sky: number; block: number };

export type LoadedSelection = Map<THREE.Object3D, Set<number>>;
// 리로드 이후 늦게 도착한 비동기 결과를 무시하기 위한 세대 토큰
export let currentLoadGen = 0;

export function beginPbdeLoadGeneration(): number {
    return ++currentLoadGen;
}

export const MAX_INSTANCES_PER_INSTANCED_MESH = 32768;
export const INITIAL_INSTANCES_PER_INSTANCED_MESH = MAX_INSTANCES_PER_INSTANCED_MESH >> 1;
const signatureHashScratch = new ArrayBuffer(8);
const signatureHashView = new DataView(signatureHashScratch);
const instanceBrightnessColor = new THREE.Color();
export type Brightness = { sky?: number; block?: number };
export type SignatureGroup = {
    parts: GeometryMeta[];
    instances: GeometryInstanceMeta[];
    geometryKey: string;
    instancedUvTransformCount: number;
    uvPlan?: ReturnType<typeof planUvTransforms>;
    tintParts?: number[];
    isAtlasBatch?: boolean;
};
export type MaterialUpdate = {
    instancedMesh: THREE.InstancedMesh;
    materials: THREE.Material[];
    pendingMaterialSlots: Array<{ index: number; promise: Promise<THREE.Material> }>;
    signature: string;
};
const skyLightColors = [
    0x2c2621, 0x302a25, 0x342e2a, 0x39332f,
    0x3f3934, 0x453f3a, 0x4c4641, 0x544e49,
    0x5e5853, 0x69635e, 0x77716d, 0x87817c,
    0x9c9691, 0xb6b0ac, 0xdad4cf, 0xfcfcfc
];

function effectiveBrightness(brightness?: Brightness): Brightness {
    const global = loadedObjectGroup.userData.globalBrightness as GlobalBrightness | undefined;
    return global?.enabled && (brightness?.sky ?? 15) === 15 && (brightness?.block ?? 0) === 0 ? global : brightness ?? {};
}

export function setInstanceSkyBrightness(mesh: THREE.InstancedMesh, instanceId: number, brightness?: Brightness): void {
    const level = Math.round(THREE.MathUtils.clamp(effectiveBrightness(brightness).sky ?? 15, 0, 15));
    mesh.setColorAt(instanceId, instanceBrightnessColor.setHex(skyLightColors[level]));
    mesh.instanceColor!.setUsage(THREE.DynamicDrawUsage);
}

export function addLoadedInstance(selection: LoadedSelection, mesh: THREE.Object3D, instanceId: number): void {
    let ids = selection.get(mesh);
    if (!ids) selection.set(mesh, ids = new Set<number>());
    ids.add(instanceId);
}

export async function addTextDisplayItems(
    items: OtherItem[],
    registerObject: (mesh: THREE.InstancedMesh, instanceId: number, uuid: string, groupId: string | null) => void,
    selection?: LoadedSelection
): Promise<void> {
    const templates = await createTextDisplayTemplates(items);
    const reusableByMaterial = new Map<THREE.Material, THREE.InstancedMesh>();
    for (const child of loadedObjectGroup.children) {
        const mesh = child as THREE.InstancedMesh;
        if (!mesh.isInstancedMesh || !mesh.userData.textDisplayTemplateKeys || mesh.count >= getInstancedCapacity(mesh)) continue;
        reusableByMaterial.set(mesh.material as THREE.Material, mesh);
    }

    const groups = new Map<THREE.Material, Array<{ item: OtherItem; template: THREE.InstancedMesh; key: string }>>();
    const reusedMeshes = new Set<THREE.InstancedMesh>();
    const usedMaterials = new Set<THREE.Material>();
    for (const item of items) {
        const key = getTextDisplayTemplateKey(item);
        const template = templates.get(key)!;
        const material = template.material as THREE.Material;
        const mesh = reusableByMaterial.get(material);
        if (mesh && mesh.count < getInstancedCapacity(mesh)) {
            const instanceId = mesh.count++;
            mesh.setMatrixAt(instanceId, new THREE.Matrix4().fromArray(item.transform).transpose());
            for (const attributeName of textDisplayInstanceAttributeNames) {
                const attribute = mesh.geometry.getAttribute(attributeName);
                const source = template.geometry.getAttribute(attributeName);
                for (let component = 0; component < attribute.itemSize; component++) {
                    attribute.setComponent(instanceId, component, source.getComponent(0, component));
                }
                attribute.needsUpdate = true;
            }
            setInstanceSkyBrightness(mesh, instanceId, item.brightness as Brightness | undefined);
            (mesh.userData.textDisplayTemplateKeys as Map<number, string>).set(instanceId, key);
            registerObject(mesh, instanceId, item.uuid, item.groupId);
            if (selection) addLoadedInstance(selection, mesh, instanceId);
            reusedMeshes.add(mesh);
            usedMaterials.add(material);
            continue;
        }

        const group = groups.get(material) ?? [];
        group.push({ item, template, key });
        groups.set(material, group);
    }
    const usedGeometries = new Set<THREE.BufferGeometry>();
    for (const [material, group] of groups) {
        usedMaterials.add(material);
        const sourceGeometry = group[0].template.geometry;
        for (let start = 0; start < group.length; start += MAX_INSTANCES_PER_INSTANCED_MESH) {
            const chunk = group.slice(start, start + MAX_INSTANCES_PER_INSTANCED_MESH);
            const capacity = getAppendableInstanceCapacity(chunk.length);
            const geometry = start === 0 ? sourceGeometry : sourceGeometry.clone();
            usedGeometries.add(geometry);
            for (const attributeName of textDisplayInstanceAttributeNames) {
                const source = chunk[0].template.geometry.getAttribute(attributeName);
                const values = new Float32Array(capacity * source.itemSize);
                chunk.forEach(({ template }, instanceId) => {
                    const attribute = template.geometry.getAttribute(attributeName);
                    for (let component = 0; component < attribute.itemSize; component++) {
                        values[instanceId * attribute.itemSize + component] = attribute.getComponent(0, component);
                    }
                });
                geometry.setAttribute(attributeName, new THREE.InstancedBufferAttribute(values, source.itemSize));
            }
            geometry.boundingBox = chunk.reduce(
                (bounds, { template }) => bounds.union(template.geometry.boundingBox!),
                new THREE.Box3()
            );
            geometry.boundingSphere = geometry.boundingBox.getBoundingSphere(new THREE.Sphere());
            setEntityStateAttributes(geometry, capacity);
            const textMesh = new THREE.InstancedMesh(geometry, material, capacity);
            textMesh.instanceMatrix = new THREE.StorageInstancedBufferAttribute(capacity, 16);
            textMesh.count = chunk.length;
            textMesh.userData.displayType = 'text_display';
            textMesh.userData.textDisplayTemplateKeys = new Map<number, string>();
            textMesh.frustumCulled = false;
            textMesh.renderOrder = 1;
            textMesh.layers.enable(2);
            chunk.forEach(({ item, key }, instanceId) => {
                textMesh.setMatrixAt(instanceId, new THREE.Matrix4().fromArray(item.transform).transpose());
                setInstanceSkyBrightness(textMesh, instanceId, item.brightness as Brightness | undefined);
                textMesh.userData.textDisplayTemplateKeys.set(instanceId, key);
                registerObject(textMesh, instanceId, item.uuid, item.groupId);
                if (selection) addLoadedInstance(selection, textMesh, instanceId);
            });
            textMesh.instanceMatrix.needsUpdate = true;
            if (textMesh.instanceColor) textMesh.instanceColor.needsUpdate = true;
            textMesh.computeBoundingSphere();
            loadedObjectGroup.add(textMesh);
        }
    }
    for (const mesh of reusedMeshes) {
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
        mesh.computeBoundingSphere();
    }
    for (const template of templates.values()) {
        if (!usedGeometries.has(template.geometry)) template.geometry.dispose();
    }
    for (const material of new Set(Array.from(templates.values(), template => template.material as THREE.Material))) {
        if (usedMaterials.has(material)) continue;
        (material as THREE.MeshBasicNodeMaterial).map?.dispose();
        material.dispose();
    }
}

type InstancedGeometryAttribute = THREE.InstancedBufferAttribute | THREE.InterleavedBufferAttribute;

export function isInstancedGeometryAttribute(attribute: unknown): attribute is InstancedGeometryAttribute {
    const candidate = attribute as THREE.InstancedBufferAttribute & {
        isInterleavedBufferAttribute?: boolean;
        data?: { isInstancedInterleavedBuffer?: boolean };
    };
    return !!(candidate?.isInstancedBufferAttribute
        || (candidate?.isInterleavedBufferAttribute && candidate.data?.isInstancedInterleavedBuffer));
}

export function getInstancedCapacity(mesh: THREE.InstancedMesh): number {
    let capacity = mesh.instanceMatrix.count;
    if (mesh.instanceColor) capacity = Math.min(capacity, mesh.instanceColor.count);
    for (const attribute of Object.values(mesh.geometry.attributes)) {
        if (isInstancedGeometryAttribute(attribute)) capacity = Math.min(capacity, attribute.count);
    }
    return capacity;
}

function mixHash(hash: number, value: number): number {
    hash ^= value >>> 0;
    return Math.imul(hash, 16777619) >>> 0;
}

function hashString(hash: number, value: string): number {
    for (let i = 0; i < value.length; i++) {
        hash = mixHash(hash, value.charCodeAt(i));
    }
    return mixHash(hash, value.length);
}

function hashNumber(hash: number, value: number): number {
    signatureHashView.setFloat64(0, value, true);
    hash = mixHash(hash, signatureHashView.getUint32(0, true));
    return mixHash(hash, signatureHashView.getUint32(4, true));
}

export function buildPartHashKeys(parts: GeometryMeta[]): { signature: string; geometryKey: string } {
    let signatureHashA = 2166136261;
    let signatureHashB = 16777619;
    let geometryHashA = 2166136261;
    let geometryHashB = 16777619;

    signatureHashA = mixHash(signatureHashA, parts.length);
    signatureHashB = mixHash(signatureHashB, parts.length);
    geometryHashA = mixHash(geometryHashA, parts.length);
    geometryHashB = mixHash(geometryHashB, parts.length);

    for (const part of parts) {
        const geometryBufferKey = getGeometryBufferKey(part);
        signatureHashA = hashString(signatureHashA, part.geometryId);
        signatureHashA = hashString(signatureHashA, geometryBufferKey);
        signatureHashA = mixHash(signatureHashA, part.geometryIndex);
        signatureHashA = hashString(signatureHashA, part.texPath);
        signatureHashA = hashString(signatureHashA, part.atlasKey ?? '');
        signatureHashA = mixHash(signatureHashA, (part.tintHex ?? 0xffffff) >>> 0);
        signatureHashB = hashString(signatureHashB, part.texPath);
        signatureHashB = hashString(signatureHashB, part.atlasKey ?? '');
        signatureHashB = mixHash(signatureHashB, (part.tintHex ?? 0xffffff) >>> 0);
        signatureHashB = hashString(signatureHashB, part.geometryId);
        signatureHashB = hashString(signatureHashB, geometryBufferKey);
        signatureHashB = mixHash(signatureHashB, part.geometryIndex);

        geometryHashA = hashString(geometryHashA, part.geometryId);
        geometryHashA = hashString(geometryHashA, geometryBufferKey);
        geometryHashA = mixHash(geometryHashA, part.geometryIndex);
        geometryHashB = mixHash(geometryHashB, part.geometryIndex);
        geometryHashB = hashString(geometryHashB, part.geometryId);
        geometryHashB = hashString(geometryHashB, geometryBufferKey);

        for (let i = 0; i < part.modelMatrix.length; i++) {
            signatureHashA = hashNumber(signatureHashA, part.modelMatrix[i]);
            signatureHashB = hashNumber(signatureHashB, part.modelMatrix[part.modelMatrix.length - 1 - i]);
            geometryHashA = hashNumber(geometryHashA, part.modelMatrix[i]);
            geometryHashB = hashNumber(geometryHashB, part.modelMatrix[part.modelMatrix.length - 1 - i]);
        }
    }

    return {
        signature: `${parts.length}|${signatureHashA.toString(36)}|${signatureHashB.toString(36)}`,
        geometryKey: `${parts.length}|${geometryHashA.toString(36)}|${geometryHashB.toString(36)}`
    };
}

export function getGeometryBufferKey(part: GeometryMeta): string {
    return part.geometryBufferKey ?? `${part.geometryId}|${part.geometryIndex}`;
}

export function getInstancePartUvTransform(
    meta: GeometryInstanceMeta,
    partIndex: number
): [number, number, number, number] | undefined {
    return meta.atlasUvTransforms?.[partIndex] ?? meta.atlasUvTransform;
}

function getInstancedUvTransformCount(parts: GeometryMeta[], instances: GeometryInstanceMeta[]): number {
    return planUvTransforms(parts, instances).sourceParts.length;
}

if (import.meta.env.DEV) {
    const uvA: [number, number, number, number] = [0.25, 0.25, 0, 0];
    const uvB: [number, number, number, number] = [0.25, 0.25, 0.5, 0];
    const parts = [{ uvTransform: uvA }, { uvTransform: uvB }] as GeometryMeta[];
    console.assert(
        getInstancedUvTransformCount(parts, [{ atlasUvTransforms: [uvA, uvB] }] as GeometryInstanceMeta[]) === 0
        && getInstancedUvTransformCount(parts, [{ atlasUvTransforms: [uvA, uvA] }] as GeometryInstanceMeta[]) === 1
        && getInstancedUvTransformCount(parts.slice(0, 1), [{ atlasUvTransform: uvB }] as GeometryInstanceMeta[]) === 1
        && getInstancedUvTransformCount(parts, [{}] as GeometryInstanceMeta[]) === 0,
        'Only differing per-instance atlas UVs require shader attributes.'
    );
}

export function getInstanceDisplayType(instance: GeometryInstanceMeta, part?: GeometryMeta): 'item_display' | 'block_display' {
    return (instance.isItemDisplayModel ?? part?.isItemDisplayModel) ? 'item_display' : 'block_display';
}

export function getAppendableInstanceCapacity(count: number): number {
    return Math.max(count, Math.min(MAX_INSTANCES_PER_INSTANCED_MESH, Math.max(256, count * 2)));
}
