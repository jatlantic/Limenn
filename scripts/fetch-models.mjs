// Downloads the models the extension bundles (models/models.lock.json) into .cache/models and checks their SHA-256.
// The extension itself never downloads anything: these files ship inside the package.
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, renameSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import lock from '../models/models.lock.json' with { type: 'json' };

export const CACHE = resolve(import.meta.dirname, '../.cache/models');

export const sha256File = (path) =>
  new Promise((ok, fail) => {
    const h = createHash('sha256');
    createReadStream(path).on('data', (d) => h.update(d)).on('end', () => ok(h.digest('hex'))).on('error', fail);
  });

/** Ensure every locked file is in .cache/models with the right hash. Throws with a list of what is missing. */
export async function fetchModels({ log = console.log } = {}) {
  const problems = [];
  for (const f of lock.files) {
    const path = resolve(CACHE, f.path);
    if (existsSync(path) && (await sha256File(path)) === f.sha256) continue;
    const url = f.dest === 'gliner-web-q8.onnx' ? (process.env.LIMENN_WEB_MODEL_URL ?? f.url) : f.url;
    if (!url) {
      if (f.optional) {
        log(`skipping optional ${f.path} (no download URL): the extension works without it`);
        continue;
      }
      problems.push(`${f.path}: not found and no download URL. ${f.build ?? ''}`);
      continue;
    }
    log(`downloading ${f.path}`);
    const res = await fetch(url);
    if (!res.ok) {
      problems.push(`${f.path}: download failed (${res.status})`);
      continue;
    }
    mkdirSync(dirname(path), { recursive: true });
    await writeFile(`${path}.part`, Buffer.from(await res.arrayBuffer()));
    const got = await sha256File(`${path}.part`);
    if (got !== f.sha256) {
      problems.push(`${f.path}: sha256 mismatch (got ${got})`);
      continue;
    }
    renameSync(`${path}.part`, path);
  }
  if (problems.length) throw new Error(`Model files not ready:\n  ${problems.join('\n  ')}`);
  log(`models ok (${lock.files.length} files)`);
}

if (import.meta.url === `file://${process.argv[1]}`) await fetchModels();
