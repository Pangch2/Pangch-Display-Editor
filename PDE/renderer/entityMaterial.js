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

export function createEntityMaterial(diffuseTex, tintHex = 0xffffff, useInstancedUv = false) {
  const blockLightLevel = uniform(1.0);
  const skyLightLevel = uniform(1.0);

  // Instanced UV 지원
  // useInstancedUv가 true이면, 정점(vertex)의 기본 uv에 인스턴스별로 제공되는 instancedUvOffset을 더해 최종 uv를 계산합니다.
  const uvNode = uv();
  const finalUv = useInstancedUv ? uvNode.add(attribute('instancedUvOffset', 'vec2')) : uvNode;
  const diffuseNode = texture(diffuseTex, finalUv);

  // Apply optional tint as a constant multiplier. Incoming hex is in sRGB,
  // so convert to linear before multiplying with the (linearized) sampled texture.
  const srgbToLinear = (c) => {
    const x = Math.min(1, Math.max(0, c));
    return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
  };
  const rS = ((tintHex >> 16) & 0xff) / 255;
  const gS = ((tintHex >> 8) & 0xff) / 255;
  const bS = (tintHex & 0xff) / 255;
  const r = srgbToLinear(rS);
  const g = srgbToLinear(gS);
  const b = srgbToLinear(bS);
  const tintVec = vec3(r, g, b);

  const lightDir0 = normalize(vec3(0.2, 1.0, -0.7));
  const lightDir1 = normalize(vec3(-0.2, 1.0, 0.7));

  // 잘못된 normal() 함수 대신 TSL.normalWorld 사용
  const n = normalize(normalWorld);
  const light0 = max(dot(lightDir0, n), float(0.0));
  const light1 = max(dot(lightDir1, n), float(0.0));

  const lightSum = add(light0, light1);
  const scaledLight = mul(lightSum, float(0.6));
  const biasedLight = add(scaledLight, float(0.4));
  const lightAccum = pow(min(float(1.0), biasedLight), 2.2);

  const lightMapColor = add(
    mul(max(blockLightLevel, skyLightLevel), float(0.75)),
    float(0.25)
  );

  const litColor = vec4(
    mul(mul(mul(diffuseNode.xyz, tintVec), lightAccum), lightMapColor),
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