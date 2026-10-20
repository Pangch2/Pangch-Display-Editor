import { nativeImage } from 'electron';
import { createHash } from 'node:crypto';

export const textureUrl = (value: string): string => {
  if (!/^https?:\/\/textures\.minecraft\.net\/texture\/[a-f\d]+$/i.test(value)) throw new Error('Minecraft 텍스처 URL 응답이 올바르지 않습니다.');
  return value.replace(/^http:/, 'https:');
};

export function decodePng(bytes: Uint8Array): { key: string; png: Uint8Array } {
  const buffer = Buffer.from(bytes);
  const invalid = (message: string) => Object.assign(new Error(message), { status: 400 });
  if (buffer.length > 1024 * 1024 || buffer.length < 24 || buffer.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') {
    throw invalid('1MB 이하의 PNG 스킨만 사용할 수 있습니다.');
  }
  const width = buffer.readUInt32BE(16), height = buffer.readUInt32BE(20);
  if (width !== 64 || (height !== 64 && height !== 32)) throw invalid('스킨은 64×64 또는 64×32 PNG여야 합니다.');
  const image = nativeImage.createFromBuffer(buffer);
  if (image.isEmpty() || image.getSize().width !== width || image.getSize().height !== height) throw invalid('PNG 스킨을 읽을 수 없습니다.');
  return { key: createHash('sha256').update(`${width}x${height}:`).update(image.toBitmap()).digest('hex'), png: image.toPNG() };
}

export async function downloadSkin(url: string, signal?: AbortSignal): Promise<Uint8Array> {
  const response = await fetch(textureUrl(url), {
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000), redirect: 'error'
  });
  if (!response.ok) throw Object.assign(new Error(`스킨 다운로드 실패 (HTTP ${response.status})`), { status: response.status });
  const chunks: Uint8Array[] = [];
  let length = 0;
  if (!response.body) throw new Error('스킨 응답이 비어 있습니다.');
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    length += chunk.length;
    if (length > 1024 * 1024) throw Object.assign(new Error('스킨 크기가 너무 큽니다.'), { status: 400 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function skinFaceImage(bytes: Uint8Array): string {
  const image = nativeImage.createFromBuffer(Buffer.from(decodePng(bytes).png));
  const face = image.crop({ x: 8, y: 8, width: 8, height: 8 }).toBitmap();
  const hat = image.crop({ x: 40, y: 8, width: 8, height: 8 }).toBitmap();
  // nativeImage bitmaps already have their color channels multiplied by alpha.
  for (let i = 0; i < face.length; i += 4) {
    const remaining = 1 - hat[i + 3] / 255;
    for (let channel = 0; channel < 4; channel++) {
      face[i + channel] = Math.round(hat[i + channel] + face[i + channel] * remaining);
    }
  }
  return nativeImage.createFromBitmap(face, { width: 8, height: 8 }).toDataURL();
}
