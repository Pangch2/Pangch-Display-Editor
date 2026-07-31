import { FrontSide, Matrix4, MeshBasicNodeMaterial, type Texture } from 'three/webgpu';
import {
  uniform,
  renderGroup,
  uv,
  attribute,
  texture,
  vec3,
  normalize,
  normalWorld,
  max,
  dot,
  float,
  add,
  mul,
  pow,
  min,
  vec4,
  mix,
  positionLocal,
  modelWorldMatrix,
  modelWorldMatrixInverse,
  modelViewProjection,
  vec2,
  sRGBTransferEOTF,
  sRGBTransferOETF
} from 'three/tsl';

export const dragSelectedAttributeName = 'dragSelected';
export const dragDeltaMatrix = new Matrix4();

const tintNodeCache = new Map<number, ReturnType<typeof vec3>>();
const shadingEnabled = uniform(1.0);
const dragDeltaMatrixNode = uniform(dragDeltaMatrix).setGroup(renderGroup);
const draggedPosition = modelWorldMatrixInverse
  .mul(dragDeltaMatrixNode)
  .mul(modelWorldMatrix)
  .mul(vec4(positionLocal, 1.0)).xyz;
export const dragPreviewPositionNode = mix(positionLocal, draggedPosition, attribute(dragSelectedAttributeName, 'float'));

const srgbToLinear = (c: number): number => {
  const x = Math.min(1, Math.max(0, c));
  return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
};

const getTintNode = (tintHex?: number): ReturnType<typeof vec3> => {
  const normalizedTint = (tintHex ?? 0xffffff) >>> 0;
  let tintNode = tintNodeCache.get(normalizedTint);
  if (!tintNode) {
    const rS = ((normalizedTint >> 16) & 0xff) / 255;
    const gS = ((normalizedTint >> 8) & 0xff) / 255;
    const bS = (normalizedTint & 0xff) / 255;
    tintNode = vec3(srgbToLinear(rS), srgbToLinear(gS), srgbToLinear(bS));
    tintNodeCache.set(normalizedTint, tintNode);
  }
  return tintNode;
};

const lightDir0 = normalize(vec3(0.2, 1.0, -0.7));
const lightDir1 = normalize(vec3(-0.2, 1.0, 0.7));
const worldNormal = normalize(normalWorld);
const light0 = max(dot(lightDir0, worldNormal), float(0.0));
const light1 = max(dot(lightDir1, worldNormal), float(0.0));
const lightSum = add(light0, light1);
const scaledLight = mul(lightSum, float(0.6));
const biasedLight = add(scaledLight, float(0.4));
const directionalLight = pow(min(float(1.0), biasedLight), 2.2);

export function toggleShading(): boolean {
  shadingEnabled.value = 1 - shadingEnabled.value;
  return shadingEnabled.value === 1;
}

export function createEntityMaterial(diffuseTex: Texture, tintHex = 0xffffff, useInstancedUv = false, useInstancedUvTransform = false, instancedUvTransformCount = 1, instancedUvTransformIndex = 0) {
  const blockLightLevel = uniform(0.0);
  const skyLightLevel = uniform(15.0);

  // Instanced UV 지원
  // useInstancedUvTransform은 atlas 내 texture scale/offset까지 instance별로 적용한다.
  const uvNode = uv();
  const uvTransformCount = Math.max(1, instancedUvTransformCount | 0);
  let uvTransformNode = null;
  if (useInstancedUvTransform) {
    const attributeName = uvTransformCount === 1 ? 'instancedUvTransform' : `instancedUvTransform${instancedUvTransformIndex}`;
    uvTransformNode = attribute(attributeName, 'vec4');
  }
  const offsetUv = useInstancedUv
    ? uvNode.add(attribute('instancedUvOffset', 'vec2'))
    : uvNode;
  const finalUv = useInstancedUvTransform
    ? uvNode.mul(uvTransformNode.xy).add(uvTransformNode.zw)
    : useInstancedUv
      ? mix(
          offsetUv,
          attribute('uvMirrorCenter', 'vec2').add(attribute('instancedUvOffset', 'vec2')).mul(2).sub(offsetUv),
          attribute('instancedUvFlip', 'vec2')
        )
      : uvNode;
  const diffuseNode = texture(diffuseTex, finalUv);

  const tintVec = getTintNode(tintHex);

  const normalizedSkyLight = skyLightLevel.div(15.0);
  const lightMapColor = normalizedSkyLight.div(float(4.0).sub(normalizedSkyLight.mul(3.0)));

  const unlitColor = vec4(mul(diffuseNode.xyz, tintVec), diffuseNode.w);
  const litColor = vec4(
    mul(mul(mul(diffuseNode.xyz, tintVec), directionalLight), lightMapColor),
    diffuseNode.w
  );

  const material = new MeshBasicNodeMaterial();
  material.positionNode = dragPreviewPositionNode;
  material.colorNode = mix(unlitColor, litColor, shadingEnabled);
  material.map = diffuseTex;
  material.transparent = true;
  material.fog = false;
  material.flatShading = true;
  material.alphaTest = 0.1;

  return { material, blockLightLevel, skyLightLevel };
}

const endPortalColors = [
  [0.022087, 0.098399, 0.110818], [0.011892, 0.095924, 0.089485],
  [0.027636, 0.101689, 0.100326], [0.046564, 0.109883, 0.114838],
  [0.064901, 0.117696, 0.097189], [0.063761, 0.086895, 0.123646],
  [0.084817, 0.111994, 0.166380], [0.097489, 0.154120, 0.091064],
  [0.106152, 0.131144, 0.195191], [0.097721, 0.110188, 0.187229],
  [0.133516, 0.138278, 0.148582], [0.070006, 0.243332, 0.235792],
  [0.196766, 0.142899, 0.214696], [0.047281, 0.315338, 0.321970],
  [0.204675, 0.390010, 0.302066], [0.080955, 0.314821, 0.661491]
] as const;

if (import.meta.env.DEV) console.assert(endPortalColors.length === 16, 'End portal palette must keep Minecraft\'s 16 colors.');

export function createEndPortalMaterial(endSkyTexture: Texture, endPortalTexture: Texture, layerCount: 15 | 16): MeshBasicNodeMaterial {
  const projectedUv = modelViewProjection.xy.div(modelViewProjection.w).mul(0.5).add(0.5);
  let portalColor = sRGBTransferOETF(texture(endSkyTexture, projectedUv).rgb).mul(vec3(...endPortalColors[0]));

  for (let layer = 1; layer <= layerCount; layer++) {
    const angle = (layer * layer * 4321 + layer * 9) * 2 * Math.PI / 180;
    const scale = (4.5 - layer / 4) * 2;
    const rotatedUv = vec2(
      projectedUv.x.mul(Math.cos(angle)).sub(projectedUv.y.mul(Math.sin(angle))),
      projectedUv.x.mul(Math.sin(angle)).add(projectedUv.y.mul(Math.cos(angle)))
    ).mul(scale);
    const layerUv = rotatedUv.add(vec2(17 / layer, 0)).mul(0.5).add(0.25);
    portalColor = portalColor.add(sRGBTransferOETF(texture(endPortalTexture, layerUv).rgb).mul(vec3(...endPortalColors[layer - 1])));
  }

  const material = new MeshBasicNodeMaterial();
  material.positionNode = dragPreviewPositionNode;
  material.colorNode = vec4(sRGBTransferEOTF(portalColor), 1);
  material.side = FrontSide;
  material.depthWrite = true;
  material.transparent = false;
  material.toneMapped = false;
  material.fog = false;
  return material;
}
