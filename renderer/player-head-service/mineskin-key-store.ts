import { safeStorage } from 'electron';
import { randomUUID } from 'node:crypto';
import { readAccountFile, writeAccountFile } from './minecraft-account.js';
import type { MineSkinKey } from './head-texture-types.js';

const keysFile = 'pde-mineskin-keys.json';
const keyValue = (value: unknown): string => {
  if (typeof value !== 'string' || value.length > 512 || !/^[\x21-\x7e]*$/.test(value.trim())) throw new Error('MineSkin API 키가 올바르지 않습니다.');
  return value.trim();
};
const keyId = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/.test(value)) throw new Error('MineSkin 키 ID가 올바르지 않습니다.');
  return value;
};
const secureStorage = async () => {
  if (!await safeStorage.isAsyncEncryptionAvailable() || (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')) {
    throw new Error('운영체제의 안전한 키 저장소를 사용할 수 없습니다.');
  }
};

export class MineSkinKeyStore {
  private keys: MineSkinKey[] = [];
  private ready?: Promise<void>;
  async list(): Promise<MineSkinKey[]> {
    await (this.ready ??= (async () => {
      const stored = await readAccountFile<{ encrypted: string }>(keysFile);
      let keys: MineSkinKey[] = [];
      if (stored) {
        await secureStorage();
        try {
          keys = JSON.parse((await safeStorage.decryptStringAsync(Buffer.from(stored.encrypted, 'base64'))).result);
          if (!Array.isArray(keys) || keys.length > 64 || new Set(keys.map(entry => keyId(entry.id))).size !== keys.length) throw new Error();
          keys = keys.map(entry => ({ id: keyId(entry.id), key: keyValue(entry.key) }));
        } catch { throw new Error('저장된 MineSkin 키 목록을 읽을 수 없습니다.'); }
      }
      this.keys = keys;
    })().catch(error => { this.ready = undefined; throw error; }));
    return this.keys.map(entry => ({ ...entry }));
  }
  async change(action: 'add' | 'update' | 'remove', id?: unknown, value?: unknown): Promise<MineSkinKey[]> {
    const keys = await this.list();
    if (action === 'add') {
      if (keys.length >= 64) throw new Error('MineSkin 키는 최대 64개까지 저장할 수 있습니다.');
      keys.push({ id: randomUUID(), key: '' });
    } else {
      const index = keys.findIndex(entry => entry.id === keyId(id));
      if (index < 0) throw new Error('MineSkin 키를 찾을 수 없습니다.');
      if (action === 'remove') keys.splice(index, 1);
      else keys[index].key = keyValue(value);
    }
    await secureStorage();
    await writeAccountFile(keysFile, { encrypted: (await safeStorage.encryptStringAsync(JSON.stringify(keys))).toString('base64') });
    this.keys = keys;
    return this.list();
  }
}
