// Downloads the models the extension bundles (models/models.lock.json) into .cache/models and checks their SHA-256.
// The extension itself never downloads anything: these files ship inside the package.
import { createHash } from 'node:crypto';
import { copyFileSync, createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import lock from '../models/models.lock.json' with { type: 'json' };
import { shipped } from './target.mjs';

export const CACHE = resolve(import.meta.dirname, '../.cache/models');

export const sha256File = (path) =>
  new Promise((ok, fail) => {
    const h = createHash('sha256');
    createReadStream(path).on('data', (d) => h.update(d)).on('end', () => ok(h.digest('hex'))).on('error', fail);
  });


/** Fetch a URL (or copy a local path / file:// URL) to `dest`, streaming to disk and retrying transient failures. */
async function download(url, dest, attempts = 3) {
  if (!/^https?:/i.test(url)) {
    copyFileSync(url.startsWith('file:') ? fileURLToPath(url) : isAbsolute(url) ? url : resolve(url), dest);
    return;
  }
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(30 * 60_000) });
      if (!res.ok || !res.body) throw new Error(`download failed (${res.status} ${url})`);
      await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
      return;
    } catch (e) {
      if (i >= attempts) throw new Error(e.message.startsWith('download failed') ? e.message : `download failed (${e.cause?.code ?? e.message})`);
      await new Promise((r) => setTimeout(r, 1500 * i));
    }
  }
}

/** Ensure every locked file is in .cache/models with the right hash. Throws with a list of what is missing. */
export async function fetchModels({ log = console.log } = {}) {
  const problems = [];
  for (const f of shipped(lock.files)) {
    const path = resolve(CACHE, f.path);
    if (existsSync(path) && (await sha256File(path)) === f.sha256) continue;
    const url = f.dest === 'gliner-web-q8.onnx' ? (process.env.LIMENN_WEB_MODEL_URL ?? f.url) : f.url;
    if (!url) {
      if (f.optional) {
        log(`\n!! ${f.path} is NOT included: no download URL. The extension works without it (rules + name model only).\n!! To include it, set LIMENN_WEB_MODEL_URL to a URL or local path of gliner-web-q8.onnx.\n`);
        continue;
      }
      problems.push(`${f.path}: not found and no download URL. ${f.build ?? ''}`);
      continue;
    }
    log(`downloading ${f.path}`);
    mkdirSync(dirname(path), { recursive: true });
    try {
      await download(url, `${path}.part`);
    } catch (e) {
      rmSync(`${path}.part`, { force: true });
      problems.push(`${f.path}: ${e.message}`);
      continue;
    }
    const got = await sha256File(`${path}.part`);
    if (got !== f.sha256) {
      rmSync(`${path}.part`, { force: true });
      problems.push(`${f.path}: sha256 mismatch (got ${got})`);
      continue;
    }
    renameSync(`${path}.part`, path);
  }
  if (problems.length) throw new Error(`Model files not ready:\n  ${problems.join('\n  ')}`);
  log(`models ok (${shipped(lock.files).length} files)`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await fetchModels();
