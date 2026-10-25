// VaultFs on node:fs — used by the desktop app, the benchmark and tests.
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { CACHE_DIR, isSkippedDir, isSupported, PREPARED_DIR, preparedName, type VaultFileInfo, type VaultFs } from './types';

export function nodeVaultFs(root: string): VaultFs {
  const cache = join(root, CACHE_DIR);
  return {
    async list() {
      const out: VaultFileInfo[] = [];
      const walk = async (dir: string) => {
        for (const e of await readdir(dir, { withFileTypes: true })) {
          const full = join(dir, e.name);
          if (e.isDirectory()) {
            if (!isSkippedDir(e.name, dir === root)) await walk(full);
            continue;
          }
          if (e.name.startsWith('.')) continue;
          else if (e.isFile() && isSupported(e.name)) {
            const s = await stat(full);
            out.push({ path: relative(root, full).split(sep).join('/'), name: e.name, size: s.size, mtime: Math.round(s.mtimeMs) });
          }
        }
      };
      await walk(root);
      return out.sort((a, b) => a.path.localeCompare(b.path));
    },
    read: async (path) => new Uint8Array(await readFile(join(root, ...path.split('/')))),
    readCache: (name) => readFile(join(cache, name), 'utf8').catch(() => null),
    async writeCache(name, data) {
      await mkdir(cache, { recursive: true });
      await writeFile(join(cache, name), data);
    },
    removeCache: (name) => rm(join(cache, name), { force: true }),
    async writePrepared(path, text) {
      const out = join(root, PREPARED_DIR, ...preparedName(path).split('/'));
      await mkdir(dirname(out), { recursive: true });
      await writeFile(out, text);
    },
    removePrepared: (path) => rm(join(root, PREPARED_DIR, ...preparedName(path).split('/')), { force: true }),
  };
}
