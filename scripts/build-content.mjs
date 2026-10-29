// Content scripts must be classic scripts, so build them (and the service worker) with esbuild as IIFEs.
import { build } from 'esbuild';
import { constants, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import lock from '../models/models.lock.json' with { type: 'json' };
import { CACHE, fetchModels } from './fetch-models.mjs';
import { DIST, TARGET, firefoxManifest, shipped } from './target.mjs';

await build({
  entryPoints: { content: 'src/content/main.ts', background: 'src/background.ts' },
  outdir: DIST,
  bundle: true,
  format: 'iife',
  target: TARGET === 'firefox' ? 'firefox128' : 'chrome120',
  minify: true,
  legalComments: 'none',
  loader: { '.css': 'text' },
});
copyFileSync('src/content/content.css', `${DIST}/content.css`);
console.log('built content.js, background.js');

// Every model the extension uses is bundled (models/models.lock.json): the extension never downloads anything.
// fetchModels() downloads missing files into .cache/models and verifies each file's sha256 before it is copied.
await fetchModels();
for (const f of shipped(lock.files)) {
  if (f.optional && !existsSync(resolve(CACHE, f.path))) continue;
  const out = `${DIST}/models/${f.dest ?? f.path}`;
  mkdirSync(dirname(out), { recursive: true });
  copyFileSync(resolve(CACHE, f.path), out, constants.COPYFILE_FICLONE);
}
console.log(`bundled ${shipped(lock.files).length} model files into ${DIST}/models`);

// On-device OCR (tesseract.js): the worker script and the full SIMD WebAssembly core (the trimmed "-lstm" cores
// lack the float kernels the tessdata_best models need), loaded from the extension package.
mkdirSync(`${DIST}/ocr`, { recursive: true });
copyFileSync('node_modules/tesseract.js/dist/worker.min.js', `${DIST}/ocr/worker.min.js`);
for (const f of readdirSync('node_modules/tesseract.js-core')) if (/^tesseract-core-simd\.(wasm|wasm\.js)$/.test(f)) copyFileSync(`node_modules/tesseract.js-core/${f}`, `${DIST}/ocr/${f}`);
console.log(`bundled the OCR engine into ${DIST}/ocr`);

if (TARGET === 'firefox') {
  const manifest = JSON.parse(readFileSync('public/manifest.json', 'utf8'));
  writeFileSync(`${DIST}/manifest.json`, JSON.stringify(firefoxManifest(manifest), null, 2));
  console.log(`wrote the Firefox manifest to ${DIST}/manifest.json`);
}
