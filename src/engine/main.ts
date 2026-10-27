// Offscreen document: the single place where cleaning runs (BERT model, pdf.js). Everything runs locally.
// Offscreen documents can only use chrome.runtime, so settings + vault come in with each request
// and the updated vault goes back to the background worker, which persists it.
import * as pdfjs from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { customEntities } from '../pii/custom';
import { redact } from '../pii/pipeline';
import { residualRisks } from '../pii/guard';
import type { Entity } from '../pii/types';
import { Vault } from '../pii/vault';
import { applyEvent, emptySteps, type EngineResult, type EngineRun, type ItemView, type JobFile, type JobState } from '../shared/jobs';
import { getClassifier, getGliner } from './model';
import { browserVaultFs, cachedVaultFs, folderAccess, loadFolderHandle } from '../docvault/browser-fs';
import { ocrImageFile, ocrPdfPage } from '../ocr/browser';
import { applyDoc, loadDoc, loadGazetteer, loadIndex, saveDoc, scanVault, writePreparedCopy } from '../docvault/cache';
import { extractText } from '../docvault/extract';
import type { DocReview, VaultFs } from '../docvault/types';
import type { Settings } from '../pii/types';

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

/** Message of anything thrown (workers reject with strings or events, not only Errors). */
const errMsg = (e: unknown) => (e instanceof Error ? e.message : typeof e === 'string' ? e : (e as { message?: string })?.message ?? JSON.stringify(e) ?? String(e));

const b64ToBytes = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

const broadcast = (job: JobState) => chrome.runtime.sendMessage({ type: 'limenn:job', job }).catch(() => {});


async function readFile(f: JobFile, onProgress?: (frac: number, label: string) => void): Promise<{ text: string; meta: string }> {
  return extract(f.name, b64ToBytes(f.data), onProgress);
}

async function run(req: EngineRun): Promise<EngineResult> {
  const t0 = performance.now();
  const job = req.job;
  const vault = new Vault(req.vault);
  const allow = new Set(req.allow);

  // Items first (so the panel can show the full plan immediately)
  const items: ItemView[] = [];
  if (req.input.prompt.trim()) {
    items.push({ id: 'prompt', kind: 'prompt', name: 'Prompt', original: req.input.prompt, clean: '', entities: [], warnings: [], steps: emptySteps() });
    items[0].steps.extract = { status: 'skipped', info: 'plain text' };
  }
  req.input.files.forEach((f, i) =>
    items.push({ id: `file-${i}`, kind: 'file', name: f.name, original: '', clean: '', entities: [], warnings: [], steps: emptySteps() }),
  );
  (req.input.vaultDocs ?? []).forEach((d) =>
    items.push({ id: `vault-${d.id}`, kind: 'file', name: d.name, original: '', clean: '', entities: [], warnings: [], steps: emptySteps() }),
  );
  job.items = items;
  broadcast(job);

  // Only load BERT if something actually needs detection (vault docs are already prepared).
  const needsModel = !job.unprotected && items.some((i) => !i.id.startsWith('vault-'));
  const ner = req.settings.enableNer && needsModel
    ? await getClassifier(req.settings.nerModel, modelStatus).catch(() => undefined)
    : undefined;

  // In the workspace a second of extra latency is fine, and it catches lowercase names ("i am maria keller").
  const thorough = req.settings.nextGen === 'all' || (req.job.source === 'workspace' && req.settings.nextGen !== 'off');
  const spanNer = thorough && needsModel ? await getGliner(modelStatus).catch(() => undefined) : undefined;

  // Personal gazetteer from the linked vault folder (if any): catches known clients in prompts.
  const known = await vaultFs().then(loadGazetteer, () => []);

  for (const item of items) {
    if (item.id.startsWith('vault-')) {
      item.steps.extract = { status: 'running' };
      broadcast(job);
      try {
        const t = performance.now();
        const doc = await loadDoc(await vaultFs(), item.id.slice(6));
        if (!doc) throw new Error(`${item.name} is no longer in the vault`);
        if (job.unprotected) {
          Object.assign(item, { original: doc.text, clean: doc.text, meta: doc.meta });
          item.steps = { ...emptySteps(), extract: { status: 'done', info: `vault · ${doc.meta} · sent unchanged` } };
          broadcast(job);
          continue;
        }
        const r = applyDoc(doc, vault, { allow, rules: req.rules });
        const ms = Math.round(performance.now() - t);
        item.original = doc.text;
        item.meta = doc.meta;
        item.clean = r.clean;
    item.risks = residualRisks(r.clean, vault);
        item.risks = residualRisks(r.clean, vault);
        item.entities = r.entities;
        item.stats = r.stats;
        item.warnings.push(...doc.warnings);
        const count = (s: string) => r.entities.filter((e) => e.source === s).length;
        item.steps = {
          extract: { status: 'done', ms, info: `vault · ${doc.meta}` },
          regex: { status: 'done', count: count('regex'), info: 'prepared' },
          ner: { status: 'done', count: count('ner'), info: 'prepared' },
          jev: { status: 'done', count: count('jev'), candidates: doc.candidates, info: 'prepared' },
        };
      } catch (e) {
        item.steps.extract = { status: 'error', info: (e as Error).message };
        item.warnings.push((e as Error).message);
      }
      broadcast(job);
      continue;
    }
    if (item.kind === 'file') {
      item.steps.extract = { status: 'running' };
      broadcast(job);
      const t = performance.now();
      try {
        const f = req.input.files[+item.id.split('-')[1]];
        let last = 0;
        const { text, meta } = await readFile(f, (_frac, label) => {
          if (Date.now() - last < 250) return;
          last = Date.now();
          item.steps.extract = { status: 'running', info: label };
          broadcast(job);
        });
        item.original = text;
        item.meta = meta;
        item.steps.extract = { status: 'done', ms: Math.round(performance.now() - t), info: meta };
      } catch (e) {
        item.steps.extract = { status: 'error', info: errMsg(e) };
        item.warnings.push(errMsg(e));
        continue;
      }
    }
    if (job.unprotected) {
      // Protection switched off: documents are still read (PDF, OCR …), but nothing is replaced.
      item.clean = item.original;
      for (const k of ['regex', 'ner', 'jev'] as const) item.steps[k] = { status: 'skipped', info: 'protection off' };
      broadcast(job);
      continue;
    }
    const r = await redact(item.original, {
      settings: req.settings,
      vault,
      ner,
      spanNer,
      allow,
      manual: customEntities(item.original, req.rules ?? []),
      known,
      onEvent: (e) => {
        applyEvent(item.steps, e);
        broadcast(job);
      },
    });
    item.clean = r.clean;
    item.risks = residualRisks(r.clean, vault);
    item.entities = r.entities;
    item.stats = r.stats;
    item.warnings.push(...r.warnings);
    broadcast(job);
  }

  job.status = 'cleaned';
  job.totalMs = Math.round(performance.now() - t0);
  return { job, vault: vault.data };
}

// ---------- Document Vault ----------

/**
 * The linked folder. Without folder permission (after a browser restart) the prepared results mirrored in
 * IndexedDB are used, so prepared documents can still be sent; only scanning needs `requireFolder`.
 */
async function vaultFs(requireFolder = false): Promise<VaultFs> {
  const h = await loadFolderHandle();
  if (!h) throw new Error('No vault folder linked.');
  const access = await folderAccess(h);
  if (access) return browserVaultFs(h, access);
  if (requireFolder) throw Object.assign(new Error('Limenn needs permission to read the vault folder again.'), { code: 'needs-permission' });
  return cachedVaultFs();
}

let mammoth: Promise<any> | null = null;
const extract = (name: string, bytes: Uint8Array, onProgress?: (frac: number, label: string) => void) =>
  extractText(
    name,
    bytes,
    {
      pdfjs,
      mammoth: name.toLowerCase().endsWith('.docx') ? { extractRawText: async (i) => (await (mammoth ??= import('mammoth/mammoth.browser').then((m) => m.default ?? m))).extractRawText(i) } : undefined,
      ocrPage: ocrPdfPage,
      ocrImage: ocrImageFile,
    },
    onProgress,
  );

let scanning: Promise<object> | null = null;
async function vaultScan(settings: Settings) {
  if (scanning) return scanning;
  scanning = (async () => {
    const fs = await vaultFs(true);
    const ner = settings.enableNer ? await getClassifier(settings.nerModel, modelStatus).catch(() => undefined) : undefined;
    // Vault documents are prepared ahead of time, so the slower next-generation model costs the user nothing.
    const spanNer = settings.nextGen !== 'off' ? await getGliner(modelStatus).catch(() => undefined) : undefined;
    const res = await scanVault(fs, { settings, ner, spanNer, extract }, (p) =>
      chrome.runtime.sendMessage({ type: 'limenn:vault:progress', progress: p }).catch(() => {}),
    );
    // Mirror every prepared result into IndexedDB (readCache does it on read), so sending works without folder access.
    for (const id of res.unchanged) await fs.readCache(`${id}.json`).catch(() => null);
    return { docs: Object.values(res.index.docs), prepared: res.prepared.length, removed: res.removed.length };
  })().finally(() => (scanning = null));
  return scanning;
}

type VaultMsg =
  | { target: 'engine'; type: 'vault-scan'; settings: Settings }
  | { target: 'engine'; type: 'vault-doc'; id: string }
  | { target: 'engine'; type: 'vault-review'; id: string; review: DocReview };

async function vaultMessage(msg: VaultMsg): Promise<object> {
  if (msg.type === 'vault-scan') return vaultScan(msg.settings);
  const fs = await vaultFs();
  const doc = await loadDoc(fs, msg.id);
  if (!doc) throw new Error('Document not found');
  if (msg.type === 'vault-doc') return { doc };
  doc.review = msg.review;
  await saveDoc(fs, doc, await loadIndex(fs));
  await writePreparedCopy(fs, doc);
  return { doc };
}

const modelStatus = (s: unknown) => chrome.runtime.sendMessage({ type: 'limenn:model', status: s }).catch(() => {});

chrome.runtime.onMessage.addListener((msg: EngineRun | VaultMsg | { target: 'engine'; type: 'warm'; model: string } | { target: 'engine'; type: 'ping' }, sender, sendResponse) => {
  // Only the service worker and extension pages drive the engine, never a content script on a web page.
  if (msg?.target !== 'engine' || sender.id !== chrome.runtime.id || sender.tab) return false;
  if (msg.type !== 'run' && msg.type !== 'warm' && msg.type !== 'ping') {
    vaultMessage(msg).then(
      (r) => sendResponse({ ok: true, ...(r as object) }),
      (e) => sendResponse({ ok: false, error: e.message, code: e.code }),
    );
    return true;
  }
  if (msg.type === 'ping') {
    sendResponse({ ok: true });
    return false;
  }
  if (msg.type === 'warm') {
    getClassifier(msg.model, modelStatus).then(() => sendResponse({ ok: true }), () => sendResponse({ ok: false }));
    return true;
  }
  run(msg).then(sendResponse, (e: Error) => {
    msg.job.status = 'error';
    msg.job.error = e.message;
    sendResponse({ job: msg.job, vault: msg.vault });
  });
  return true;
});
