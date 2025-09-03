import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';

export function createEntityMaterial(diffuseTex) {
  const blockLightLevel = TSL.uniform(1.0);
  const skyLightLevel = TSL.uniform(1.0);

  const diffuseNode = TSL.texture(diffuseTex, TSL.uv());

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

  const litColor = TSL.mul(TSL.mul(diffuseNode, lightAccum), lightMapColor);

  const material = new THREE.MeshBasicNodeMaterial();
  material.colorNode = litColor;
  material.alphaTest = 0.1;

  return { material, blockLightLevel, skyLightLevel };
}