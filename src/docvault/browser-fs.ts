// VaultFs on the File System Access API (extension pages + offscreen engine share one IndexedDB).
// The linked folder's handle lives in IndexedDB because chrome.storage can't hold handles. The cache goes to
// `<folder>/.limenn/` when write access was granted and is always mirrored into IndexedDB, so prepared
// documents can still be sent after a browser restart, before Chrome has granted folder access again.
import { CACHE_DIR, isSkippedDir, isSupported, PREPARED_DIR, preparedName, type VaultFileInfo, type VaultFs } from './types';

const DB = 'limenn-docvault';
const HANDLES = 'handles';
const CACHE = 'cache';

function openDb(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => {
      r.result.createObjectStore(HANDLES);
      r.result.createObjectStore(CACHE);
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

async function idb<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  const db = await openDb();
  return new Promise<T>((res, rej) => {
    const req = fn(db.transaction(store, mode).objectStore(store));
    req.onsuccess = () => res(req.result as T);
    req.onerror = () => rej(req.error);
  }).finally(() => db.close());
}

export const saveFolderHandle = (h: FileSystemDirectoryHandle) => idb(HANDLES, 'readwrite', (s) => s.put(h, 'folder'));
export const loadFolderHandle = () => idb<FileSystemDirectoryHandle | undefined>(HANDLES, 'readonly', (s) => s.get('folder'));
export async function unlinkFolder() {
  await idb(HANDLES, 'readwrite', (s) => s.delete('folder'));
  await idb(CACHE, 'readwrite', (s) => s.clear());
}

type PermissionHandle = FileSystemDirectoryHandle & {
  queryPermission(d: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
  requestPermission(d: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
};

/** 'readwrite' | 'read' | null — never prompts (safe in the offscreen document). */
export async function folderAccess(h: FileSystemDirectoryHandle): Promise<'readwrite' | 'read' | null> {
  const p = h as PermissionHandle;
  if ((await p.queryPermission({ mode: 'readwrite' })) === 'granted') return 'readwrite';
  if ((await p.queryPermission({ mode: 'read' })) === 'granted') return 'read';
  return null;
}

/** Prompts for access; must run inside a user gesture on an extension page. */
export async function requestFolderAccess(h: FileSystemDirectoryHandle): Promise<'readwrite' | 'read' | null> {
  const p = h as PermissionHandle;
  if ((await p.requestPermission({ mode: 'readwrite' })) === 'granted') return 'readwrite';
  if ((await p.requestPermission({ mode: 'read' })) === 'granted') return 'read';
  return null;
}

async function fileAt(root: FileSystemDirectoryHandle, path: string): Promise<File> {
  const parts = path.split('/');
  let dir = root;
  for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p);
  return (await dir.getFileHandle(parts.at(-1)!)).getFile();
}

const idbCache = {
  get: async (name: string) => (await idb<string | undefined>(CACHE, 'readonly', (s) => s.get(name))) ?? null,
  put: (name: string, data: string) => idb(CACHE, 'readwrite', (s) => s.put(data, name)),
  del: (name: string) => idb(CACHE, 'readwrite', (s) => s.delete(name)),
};

/** The prepared results only (from IndexedDB): enough to send prepared documents, but not to scan the folder. */
export function cachedVaultFs(): VaultFs {
  const noFolder = () => Promise.reject(Object.assign(new Error('Limenn needs permission to read the vault folder again.'), { code: 'needs-permission' }));
  return { list: noFolder, read: noFolder, readCache: idbCache.get, writeCache: (n, d) => idbCache.put(n, d).then(() => {}), removeCache: (n) => idbCache.del(n).then(() => {}) };
}

export function browserVaultFs(root: FileSystemDirectoryHandle, access: 'readwrite' | 'read'): VaultFs {
  const cacheDir = () => root.getDirectoryHandle(CACHE_DIR, { create: true });
  const dirFor = async (path: string, create: boolean) => {
    let dir = await root.getDirectoryHandle(PREPARED_DIR, { create });
    for (const p of path.split('/').slice(0, -1)) dir = await dir.getDirectoryHandle(p, { create });
    return dir;
  };
  return {
    async list() {
      const out: VaultFileInfo[] = [];
      const walk = async (dir: FileSystemDirectoryHandle, prefix: string) => {
        for await (const [name, h] of (dir as unknown as AsyncIterable<[string, FileSystemHandle]>)) {
          if (h.kind === 'directory') {
            if (!isSkippedDir(name, prefix === '')) await walk(h as FileSystemDirectoryHandle, `${prefix}${name}/`);
          } else if (isSupported(name)) {
            const f = await (h as FileSystemFileHandle).getFile();
            out.push({ path: prefix + name, name, size: f.size, mtime: f.lastModified });
          }
        }
      };
      await walk(root, '');
      return out.sort((a, b) => a.path.localeCompare(b.path));
    },
    read: async (path) => new Uint8Array(await (await fileAt(root, path)).arrayBuffer()),
    async readCache(name) {
      const mirrored = await idbCache.get(name);
      if (mirrored != null || access === 'read') return mirrored;
      try {
        const text = await (await (await cacheDir()).getFileHandle(name)).getFile().then((f) => f.text());
        await idbCache.put(name, text); // results prepared before the mirror existed
        return text;
      } catch {
        return null;
      }
    },
    async writeCache(name, data) {
      await idbCache.put(name, data);
      if (access === 'read') return;
      const w = await (await (await cacheDir()).getFileHandle(name, { create: true })).createWritable();
      await w.write(data);
      await w.close();
    },
    async removeCache(name) {
      await idbCache.del(name);
      if (access === 'read') return;
      await (await cacheDir()).removeEntry(name).catch(() => {});
    },
    ...(access === 'readwrite'
      ? {
          async writePrepared(path: string, text: string) {
            const file = preparedName(path).split('/').at(-1)!;
            const w = await (await (await dirFor(path, true)).getFileHandle(file, { create: true })).createWritable();
            await w.write(text);
            await w.close();
          },
          async removePrepared(path: string) {
            await (await dirFor(path, false)).removeEntry(preparedName(path).split('/').at(-1)!).catch(() => {});
          },
        }
      : {}),
  };
}
