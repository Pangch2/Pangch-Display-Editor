import { MeshBasicNodeMaterial } from 'three/webgpu';
import {
  uniform,
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
  vec4
} from 'three/tsl';

const tintNodeCache = new Map();

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

export function createEntityMaterial(diffuseTex, tintHex = 0xffffff, useInstancedUv = false) {
  const blockLightLevel = uniform(1.0);
  const skyLightLevel = uniform(1.0);

  // Instanced UV 지원
  // useInstancedUv가 true이면, 정점(vertex)의 기본 uv에 인스턴스별로 제공되는 instancedUvOffset을 더해 최종 uv를 계산합니다.
  const uvNode = uv();
  const finalUv = useInstancedUv ? uvNode.add(attribute('instancedUvOffset', 'vec2')) : uvNode;
  const diffuseNode = texture(diffuseTex, finalUv);

  const tintVec = getTintNode(tintHex);

  const lightMapColor = add(
    mul(max(blockLightLevel, skyLightLevel), float(0.75)),
    float(0.25)
  );

  const litColor = vec4(
    mul(mul(mul(diffuseNode.xyz, tintVec), directionalLight), lightMapColor),
    diffuseNode.w
  );

  const material = new MeshBasicNodeMaterial();
  material.colorNode = litColor;
  material.map = diffuseTex;
  material.transparent = true;
  material.fog = false;
  material.flatShading = true;
  material.alphaTest = 0.1;

  return { material, blockLightLevel, skyLightLevel };
}
