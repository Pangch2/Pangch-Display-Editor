import type { BufferGeometry, Material } from 'three/webgpu';
import type { GeometryMeta } from '../pbde/pbde-types';

/** One draw group per part, in part order; a single material when every part uses the same one. */
export function setAtlasPartMaterial(geometry: BufferGeometry, parts: GeometryMeta[], materials: Material[]): Material | Material[] {
    geometry.clearGroups();
    let indexStart = 0;
    for (const [index, part] of parts.entries()) {
        geometry.addGroup(indexStart, part.indicesLen, index);
        indexStart += part.indicesLen;
    }
    return materials.every(material => material === materials[0]) ? materials[0] : materials;
}
