import { Matrix4, MeshBasicNodeMaterial } from 'three/webgpu';
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
  modelWorldMatrixInverse
} from 'three/tsl';

export const dragSelectedAttributeName = 'dragSelected';
export const dragDeltaMatrix = new Matrix4();

const tintNodeCache = new Map();
const shadingEnabled = uniform(1.0);
const dragDeltaMatrixNode = uniform(dragDeltaMatrix).setGroup(renderGroup);
const draggedPosition = modelWorldMatrixInverse
  .mul(dragDeltaMatrixNode)
  .mul(modelWorldMatrix)
  .mul(vec4(positionLocal, 1.0)).xyz;
export const dragPreviewPositionNode = mix(positionLocal, draggedPosition, attribute(dragSelectedAttributeName, 'float'));

const srgbToLinear = (c) => {
  const x = Math.min(1, Math.max(0, c));
  return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
};

const getTintNode = (tintHex) => {
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

export function toggleShading() {
  shadingEnabled.value = 1 - shadingEnabled.value;
  return shadingEnabled.value === 1;
}

export function createEntityMaterial(diffuseTex, tintHex = 0xffffff, useInstancedUv = false, useInstancedUvTransform = false, instancedUvTransformCount = 1, instancedUvTransformIndex = 0) {
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
  const finalUv = useInstancedUvTransform
    ? uvNode.mul(uvTransformNode.xy).add(uvTransformNode.zw)
    : useInstancedUv
      ? uvNode.add(attribute('instancedUvOffset', 'vec2'))
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
