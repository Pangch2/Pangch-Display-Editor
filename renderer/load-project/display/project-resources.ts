import { BufferGeometry, type InstancedMesh, Material, type Mesh, Node, type Object3D, Texture } from 'three/webgpu';
import { getAtlasPartMaterials } from '../batching/atlas-part-material';
import { disposeTexture, forgetBlockRenderResources } from './block-render-resources';
import { clearImageHeadBlackMaterial, headGeometries } from './player-head-atlas';

type ProjectScene = { children: Object3D[]; data: Record<string, any> };
type ProjectResource = BufferGeometry | InstancedMesh | Material | Texture;

function addMaterialResources(material: Material, resources: Set<ProjectResource>): void {
    if (resources.has(material)) return;
    resources.add(material);
    const nodes: Node[] = [];
    for (const value of Object.values(material)) {
        if (value instanceof Texture) resources.add(value);
        if (value instanceof Node) nodes.push(value);
    }
    const seen = new Set<Node>();
    while (nodes.length) {
        const node = nodes.pop()!;
        if (seen.has(node)) continue;
        seen.add(node);
        if ('value' in node && node.value instanceof Texture) resources.add(node.value);
        nodes.push(...node.getChildren());
    }
}

function collectProjectResources(project: ProjectScene): Set<ProjectResource> {
    const resources = new Set<ProjectResource>();
    for (const child of project.children) child.traverse(object => {
        const mesh = object as Mesh;
        if (!mesh.isMesh) return;
        if ((mesh as InstancedMesh).isInstancedMesh) resources.add(mesh as InstancedMesh);
        resources.add(mesh.geometry);
        for (const material of [...(Array.isArray(mesh.material) ? mesh.material : [mesh.material]), ...getAtlasPartMaterials(mesh.geometry)]) addMaterialResources(material, resources);
    });
    for (const material of project.data.playerHeadAtlasMaterials ?? []) addMaterialResources(material, resources);
    for (const texture of project.data.blockAtlasTextures ?? []) resources.add(texture);
    for (const page of project.data.textDisplayAtlases?.pages ?? []) {
        resources.add(page.texture);
        for (const material of page.materials.values()) addMaterialResources(material, resources);
    }
    return resources;
}

export function disposeProjectResources(project: ProjectScene, remainingProjects: Iterable<ProjectScene>): void {
    const resources = collectProjectResources(project);
    const retained = new Set<ProjectResource>(Object.values(headGeometries ?? {}).filter(Boolean));
    for (const remaining of remainingProjects) for (const resource of collectProjectResources(remaining)) retained.add(resource);
    for (const resource of retained) resources.delete(resource);
    const retainedImages = new Set([...retained].filter(resource => resource instanceof Texture).map(texture => texture.image));
    forgetBlockRenderResources(resources);
    clearImageHeadBlackMaterial(resources);
    for (const resource of resources) {
        if (resource instanceof Texture && !retainedImages.has(resource.image)) disposeTexture(resource);
        else resource.dispose();
    }
}
