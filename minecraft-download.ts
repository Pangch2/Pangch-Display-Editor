import axios from 'axios';
import { createHash } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { fromBufferPromise, type Entry } from 'yauzl';
import pLimit from 'p-limit';
import { unzipMinecraftFiles } from './minecraft-assets.js';

export async function downloadMinecraftFiles(
  url: string,
  filter: (name: string) => boolean
): Promise<Record<string, Uint8Array>> {
  const startTime = Date.now();
  const controller = new AbortController();
  let transferredBytes = 0;
  const request = async (range?: string) => {
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await axios.get<Buffer>(url, {
          responseType: 'arraybuffer',
          decompress: false,
          timeout: 120_000,
          signal: range ? controller.signal : undefined,
          headers: { 'Accept-Encoding': 'identity', ...(range ? { Range: range } : {}) }
        });
        transferredBytes += response.data.length;
        return response;
      } catch (error) {
        if (controller.signal.aborted || attempt >= 1) throw error;
      }
    }
  };
  const extractFullArchive = (data: Buffer) => {
    const expectedHash = /\/objects\/([a-f0-9]{40})\//i.exec(url)?.[1];
    if (expectedHash && createHash('sha1').update(data).digest('hex') !== expectedHash.toLowerCase()) {
      throw new Error('Minecraft archive checksum mismatch.');
    }
    return unzipMinecraftFiles(data, filter);
  };
  const tasks: Promise<void>[] = [];
  try {
    // The ZIP footer locates the central directory; yauzl parses the index.
    // Client jars have thousands of index records; fetch the index in one RTT.
    // Server bundles have a small index, so the ZIP footer is usually enough.
    const tailSize = url.endsWith('/client.jar') ? 4 * 1024 * 1024 : 65557;
    const tail = await request(`bytes=-${tailSize}`);
    if (tail.status === 200) return await extractFullArchive(tail.data);
    const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(String(tail.headers['content-range']));
    if (tail.status !== 206 || !match) throw new Error('Minecraft server does not support byte ranges.');
    const tailStart = Number(match[1]);
    const totalSize = Number(match[3]);
    if (!Number.isSafeInteger(totalSize) || totalSize < tail.data.length || totalSize > 512 * 1024 * 1024
      || Number(match[2]) !== totalSize - 1 || tailStart + tail.data.length !== totalSize) {
      throw new Error('Invalid Minecraft archive size.');
    }
    if (tailStart === 0) return await extractFullArchive(tail.data);

    const data = Buffer.alloc(totalSize);
    tail.data.copy(data, tailStart);
    const readRange = async (start: number, end: number) => {
      const response = await request(`bytes=${start}-${end - 1}`);
      if (response.status !== 206 || response.headers['content-range'] !== `bytes ${start}-${end - 1}/${totalSize}`
        || response.data.length !== end - start || (tail.headers.etag && response.headers.etag !== tail.headers.etag)) {
        throw new Error('Minecraft server returned an invalid byte range.');
      }
      response.data.copy(data, start);
    };
    const zip = await fromBufferPromise(data, { lazyEntries: true, autoClose: false });
    const entries: Entry[] = [];
    // yauzl stores the initial central-directory byte offset in readEntryCursor.
    const directoryStart = Number(zip.readEntryCursor);
    try {
      if (!Number.isSafeInteger(directoryStart) || directoryStart < 0 || directoryStart >= totalSize) {
        throw new Error('Invalid Minecraft ZIP directory offset.');
      }
      if (directoryStart < tailStart) await readRange(directoryStart, tailStart);
      for await (const entry of zip.eachEntry()) entries.push(entry);
    } finally {
      zip.close();
    }
    entries.sort((a, b) => a.relativeOffsetOfLocalHeader - b.relativeOffsetOfLocalHeader);
    const selected: Entry[] = [];
    const ranges: Array<{ start: number; end: number }> = [];
    entries.forEach((entry, index) => {
      if (entry.fileName.endsWith('/') || !filter(entry.fileName)) return;
      selected.push(entry);
      const start = entry.relativeOffsetOfLocalHeader;
      const end = entries[index + 1]?.relativeOffsetOfLocalHeader ?? directoryStart;
      if (start < 0 || end <= start || end > directoryStart || start + 30 + entry.compressedSize > end) {
        throw new Error('Invalid Minecraft ZIP entry offset.');
      }
      const previous = ranges[ranges.length - 1];
      // Merge nearby files so thousands of assets share a few HTTP requests.
      if (previous && start - previous.end <= 64 * 1024) previous.end = end;
      else ranges.push({ start, end });
    });
    const limit = pLimit(4);
    for (const range of ranges) {
      // Bound each request while using four connections for larger spans.
      for (let start = range.start; start < Math.min(range.end, directoryStart, tailStart); start += 4 * 1024 * 1024) {
        const end = Math.min(start + 4 * 1024 * 1024, range.end, directoryStart, tailStart);
        tasks.push(limit(() => readRange(start, end)));
      }
    }
    await Promise.all(tasks);
    const files = await unzipMinecraftFiles(data, filter);
    for (const entry of selected) {
      const bytes = files[entry.fileName];
      if (!bytes || bytes.length !== entry.uncompressedSize || crc32(bytes) !== entry.crc32) {
        throw new Error(`Minecraft asset checksum mismatch: ${entry.fileName}`);
      }
    }
    console.log(`Minecraft selective download: ${(transferredBytes / 1048576).toFixed(1)}/${(totalSize / 1048576).toFixed(1)} MiB in ${Date.now() - startTime}ms`);
    return files;
  } catch (error) {
    controller.abort();
    await Promise.allSettled(tasks);
    console.log(`Minecraft selective download failed (${error instanceof Error ? error.message : String(error)}); retrying the full archive.`);
    return extractFullArchive((await request()).data);
  }
}
