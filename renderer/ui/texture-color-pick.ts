import { Color, Mesh, SRGBColorSpace, type Intersection, type Texture } from 'three/webgpu';

let pixelContext: CanvasRenderingContext2D | null = null;

export function readTextureColor(hit: Intersection): [number, number, number, number] | null {
  if (!hit.uv || !hit.face || !(hit.object as Mesh).isMesh) return null;
  const mesh = hit.object as Mesh;
  const material = Array.isArray(mesh.material) ? mesh.material[hit.face.materialIndex] : mesh.material;
  const map = (material as typeof material & { map?: Texture })?.map;
  const image = map?.image;
  if (!map || !image?.width || !image?.height) return null;
  const settings = material.userData.textureColorPick;
  const uv = hit.uv.clone();
  const attributeIndex = settings?.useVertexTint ? hit.face.a : hit.instanceId ?? 0;
  const transform = settings?.uvAttribute ? mesh.geometry.getAttribute(settings.uvAttribute) : undefined;
  if (transform) uv.set(uv.x * transform.getX(attributeIndex) + transform.getZ(attributeIndex),
    uv.y * transform.getY(attributeIndex) + transform.getW(attributeIndex));
  if (map.matrixAutoUpdate) map.updateMatrix();
  map.transformUv(uv);
  const x = Math.max(0, Math.min(image.width - 1, Math.floor(uv.x * image.width)));
  const y = Math.max(0, Math.min(image.height - 1, Math.floor(uv.y * image.height)));
  if (!pixelContext) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    pixelContext = canvas.getContext('2d', { willReadFrequently: true });
  }
  if (!pixelContext) return null;
  pixelContext.clearRect(0, 0, 1, 1);
  pixelContext.drawImage(image, x, y, 1, 1, 0, 0, 1, 1);
  const rgba = pixelContext.getImageData(0, 0, 1, 1).data;
  const color = new Color().setRGB(rgba[0] / 255, rgba[1] / 255, rgba[2] / 255, SRGBColorSpace);
  const tint = settings?.tintAttribute ? mesh.geometry.getAttribute(settings.tintAttribute) : undefined;
  color.multiply(tint ? new Color().setRGB(tint.getX(attributeIndex), tint.getY(attributeIndex), tint.getZ(attributeIndex))
    : new Color(settings?.tintHex ?? 0xffffff));
  color.convertLinearToSRGB();
  return [Math.round(color.r * 255), Math.round(color.g * 255), Math.round(color.b * 255), rgba[3]];
}
