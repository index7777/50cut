'use client';

/**
 * Font loader with IndexedDB cache.
 * First load ~4MB. Cached forever after.
 */

const DB_NAME = '50cut-cache';
const STORE = 'fonts';
const DEFAULT_FONT_URL =
  process.env.NEXT_PUBLIC_SUBTITLE_FONT_URL ||
  'https://cdn.jsdelivr.net/gh/notofonts/noto-cjk@main/Sans/SubsetOTF/TC/NotoSansTC-Regular.otf';

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(key: string): Promise<Uint8Array | undefined> {
  try {
    const db = await openDB();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(key);
      req.onsuccess = () => resolve(req.result as Uint8Array | undefined);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return undefined;
  }
}

async function idbSet(key: string, value: Uint8Array): Promise<void> {
  try {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // Cache failure is not fatal — just re-download next time
  }
}

/**
 * Load the subtitle font, cached in IndexedDB after first fetch.
 */
export async function loadSubtitleFont(
  onProgress?: (progress: number) => void,
  url: string = DEFAULT_FONT_URL
): Promise<Uint8Array> {
  const cacheKey = `font:${url}`;
  const cached = await idbGet(cacheKey);
  if (cached && cached.byteLength > 100_000) {
    onProgress?.(1);
    return cached;
  }

  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Font download failed: ${resp.status}`);

  // Progress via ReadableStream(若伺服器沒給 content-length 就退回 indeterminate)
  const total = Number(resp.headers.get('content-length') ?? 0);
  if (!resp.body) {
    const buf = new Uint8Array(await resp.arrayBuffer());
    await idbSet(cacheKey, buf);
    onProgress?.(1);
    return buf;
  }

  const reader = resp.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      received += value.byteLength;
      if (total > 0) onProgress?.(received / total);
    }
  }
  const buf = new Uint8Array(received);
  let offset = 0;
  for (const c of chunks) {
    buf.set(c, offset);
    offset += c.byteLength;
  }
  await idbSet(cacheKey, buf);
  onProgress?.(1);
  return buf;
}
