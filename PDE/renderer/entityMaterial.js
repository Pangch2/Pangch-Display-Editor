import { MeshBasicNodeMaterial } from 'three/webgpu';
import * as TSL from 'three/tsl';

export function createEntityMaterial(diffuseTex, tintHex = 0xffffff, useInstancedUv = false) {
  const blockLightLevel = TSL.uniform(1.0);
  const skyLightLevel = TSL.uniform(1.0);

  // 🚀 Instanced UV 지원
  // useInstancedUv가 true이면, 정점(vertex)의 기본 uv에 인스턴스별로 제공되는 instancedUvOffset을 더해 최종 uv를 계산합니다.
  const uv = TSL.uv();
  const finalUv = useInstancedUv ? uv.add(TSL.attribute('instancedUvOffset', 'vec2')) : uv;
  const diffuseNode = TSL.texture(diffuseTex, finalUv);

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
  const tintVec = TSL.vec3(r, g, b);

  const lightDir0 = TSL.normalize(TSL.vec3(0.2, 1.0, -0.7));
  const lightDir1 = TSL.normalize(TSL.vec3(-0.2, 1.0, 0.7));

  // 잘못된 normal() 함수 대신 TSL.normalWorld 사용
  const n = TSL.normalize(TSL.normalWorld);
  const light0 = TSL.max(TSL.dot(lightDir0, n), TSL.float(0.0));
  const light1 = TSL.max(TSL.dot(lightDir1, n), TSL.float(0.0));

  const lightSum = TSL.add(light0, light1);
  const scaledLight = TSL.mul(lightSum, TSL.float(0.6));
  const biasedLight = TSL.add(scaledLight, TSL.float(0.4));
  const lightAccum = TSL.pow(TSL.min(TSL.float(1.0), biasedLight), 2.2);

  const lightMapColor = TSL.add(
    TSL.mul(TSL.max(blockLightLevel, skyLightLevel), TSL.float(0.75)),
    TSL.float(0.25)
  );

  const litColor = TSL.vec4(
    TSL.mul(TSL.mul(TSL.mul(diffuseNode.xyz, tintVec), lightAccum), lightMapColor),
    diffuseNode.w
  );

  const material = new MeshBasicNodeMaterial();
  material.colorNode = litColor;
  material.transparent = true;
  material.fog = false;
  material.flatShading = true;
  material.alphaTest = 0.1;

  return { material, blockLightLevel, skyLightLevel };
}