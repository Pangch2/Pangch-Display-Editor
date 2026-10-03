import { InterleavedBuffer, InterleavedBufferAttribute, type BufferGeometry, type InstancedMesh, type Material } from 'three/webgpu';
import { getTintComponents } from '../../entity-material';
import { getBlockMaterial, getMaterialKey, sharedPlaceholderMaterial } from '../display/block-render-resources';
import type { GeometryMeta } from '../pbde/pbde-types';
import type { planUvTransforms } from './geometry-batching';
import { isSceneHistoryResourceRetained } from '../../controls/undo-redo/scene-history';

type UvPlan = ReturnType<typeof planUvTransforms>;
const originalPartMaterials = new WeakMap<object, { materials: Material[]; groups: BufferGeometry['groups'] }>();

export async function getAtlasPartMaterial(parts: GeometryMeta[], uvPlan: UvPlan, tintParts: number[], gen: number, instanceCount: number): Promise<Material | undefined> {
    // Multiple instances must retain part-major drawing: coincident surfaces
    // can otherwise change color. Blended and special materials also stay put.
    if (instanceCount !== 1 || parts.length < 2
        || !parts[0].texPath.startsWith('__ATLAS__')
        || parts.some(part => part.texPath !== parts[0].texPath || ((part.tintHex ?? 0xffffff) >>> 0) > 0xffffff)) return;
    if (new Set(parts.map((part, index) => getMaterialKey(part,
        uvPlan.slots[index] < 0 ? 0 : uvPlan.sourceParts.length, Math.max(0, uvPlan.slots[index]), tintParts.includes(index) ? index : -1))).size === 1) return;
    return getBlockMaterial(parts[0].texPath, 0xffffff, gen, 0, 0, -1, true);
}

export function setAtlasPartMaterial(geometry: BufferGeometry, parts: GeometryMeta[], uvPlan: UvPlan, tintParts: number[], materials: Material[], instanceCount: number, atlasMaterial?: Material): Material | Material[] {
    geometry.deleteAttribute('atlasPartTint');
    geometry.deleteAttribute('atlasPartUvTransform');
    geometry.userData = { ...geometry.userData };
    delete geometry.userData.atlasPartFallback;
    geometry.clearGroups();
    let indexStart = 0;
    const combineGroups = instanceCount === 1 && !materials.includes(sharedPlaceholderMaterial!);
    for (const [index, part] of parts.entries()) {
        const previous = geometry.groups.at(-1);
        if (combineGroups && previous && !materials[index].transparent && materials[previous.materialIndex!] === materials[index]) previous.count += part.indicesLen;
        else geometry.addGroup(indexStart, part.indicesLen, index);
        indexStart += part.indicesLen;
    }
    if (!atlasMaterial) return materials.every(material => material === materials[0]) ? materials[0] : materials;
    let start = 0;
    const groups = parts.map((part, materialIndex) => {
        const group = { start, count: part.indicesLen, materialIndex };
        start += part.indicesLen;
        return group;
    });
    const fallback = geometry.userData.atlasPartFallback = {};
    originalPartMaterials.set(fallback, { materials: [...materials], groups });
    const values = new Float32Array(geometry.getAttribute('position').count * 7);
    let vertex = 0;
    for (const [index, part] of parts.entries()) {
        const tintAttribute = tintParts.includes(index) ? geometry.getAttribute(`instancedTint${index}`) : undefined;
        const tint = tintAttribute ? [tintAttribute.getX(0), tintAttribute.getY(0), tintAttribute.getZ(0)] : getTintComponents(part.tintHex);
        const slot = uvPlan.slots[index];
        const name = uvPlan.sourceParts.length === 1 ? 'instancedUvTransform' : `instancedUvTransform${slot}`;
        const uvAttribute = slot < 0 ? undefined : geometry.getAttribute(name);
        const uv = uvAttribute ? [uvAttribute.getX(0), uvAttribute.getY(0), uvAttribute.getZ(0), uvAttribute.getW(0)] : [1, 1, 0, 0];
        const end = vertex + part.posLen / 3;
        for (; vertex < end; vertex++) { values.set(tint, vertex * 7); values.set(uv, vertex * 7 + 3); }
    }
    const buffer = new InterleavedBuffer(values, 7);
    geometry.setAttribute('atlasPartTint', new InterleavedBufferAttribute(buffer, 3, 0));
    geometry.setAttribute('atlasPartUvTransform', new InterleavedBufferAttribute(buffer, 4, 3));
    return atlasMaterial;
}

export function restoreAtlasPartMaterials(mesh: InstancedMesh): void {
    const original = originalPartMaterials.get(mesh.geometry.userData.atlasPartFallback);
    if (!original) return;
    const oldGeometry = mesh.geometry;
    const geometry = oldGeometry.clone();
    geometry.userData = { ...geometry.userData };
    delete geometry.userData.atlasPartFallback;
    geometry.deleteAttribute('atlasPartTint');
    geometry.deleteAttribute('atlasPartUvTransform');
    geometry.groups = original.groups.map(group => ({ ...group }));
    mesh.geometry = geometry;
    mesh.material = [...original.materials];
    if (!isSceneHistoryResourceRetained(oldGeometry)) oldGeometry.dispose();
}
