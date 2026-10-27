// Document Vault: documents in a linked folder are prepared ahead of time (text extraction + regex/BERT/Jev
// detection) and cached in `<folder>/.limenn/`. Sending one later only assigns placeholders (applyEntities),
// which takes milliseconds. Shared by the extension (File System Access API) and the desktop app (node:fs).
import { customEntities, type ProtectedRule, wordsRules } from '../pii/custom';
import { applyEntities, detect, statsOf, type RedactOptions } from '../pii/pipeline';
import type { Entity, Settings } from '../pii/types';
import { Vault } from '../pii/vault';
import { buildGazetteer, type KnownValue } from '../pii/gazetteer';
import type { IndexEntry, PreparedDoc, VaultFileInfo, VaultFs, VaultIndex } from './types';

const INDEX = 'index.json';

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
export const sha256 = async (data: Uint8Array | string) =>
  hex(await crypto.subtle.digest('SHA-256', typeof data === 'string' ? new TextEncoder().encode(data) : (data as Uint8Array<ArrayBuffer>)));

/** Stable id per path, safe as a file name. */
export const docId = async (path: string) => (await sha256(path)).slice(0, 16);

/** Only the settings that change detection results; a different key re-prepares the doc. */
/** Bump when detection rules change, so prepared vault documents are re-prepared with the new rules. */
export const DETECTOR_VERSION = 4;

export const settingsKey = (s: Settings, nextGen = false) =>
  JSON.stringify([DETECTOR_VERSION, nextGen, s.financialPolicy, s.enableNer && s.nerModel, s.nerThreshold, s.enableJev && !!s.openrouterKey && [s.jevModel, s.jevThreshold], [...s.allowList].sort()]);

export async function loadIndex(fs: VaultFs): Promise<VaultIndex> {
  const raw = await fs.readCache(INDEX).catch(() => null);
  if (!raw) return { version: 1, docs: {} };
  try {
    const idx = JSON.parse(raw) as VaultIndex;
    return idx.version === 1 ? idx : { version: 1, docs: {} };
  } catch {
    return { version: 1, docs: {} };
  }
}

const saveIndex = (fs: VaultFs, idx: VaultIndex) => fs.writeCache(INDEX, JSON.stringify(idx));

export async function loadDoc(fs: VaultFs, id: string): Promise<PreparedDoc | null> {
  const raw = await fs.readCache(`${id}.json`).catch(() => null);
  return raw ? (JSON.parse(raw) as PreparedDoc) : null;
}

export async function saveDoc(fs: VaultFs, doc: PreparedDoc, idx?: VaultIndex) {
  await fs.writeCache(`${doc.id}.json`, JSON.stringify(doc));
  const index = idx ?? (await loadIndex(fs));
  index.docs[doc.id] = toEntry(doc);
  await saveIndex(fs, index);
}

const toEntry = (d: PreparedDoc): IndexEntry => ({
  id: d.id,
  path: d.path,
  name: d.name,
  size: d.size,
  mtime: d.mtime,
  hash: d.hash,
  settingsKey: d.settingsKey,
  status: d.status,
  error: d.error,
  entityCount: d.entities.length,
  meta: d.meta,
  preparedAt: d.preparedAt,
});

export interface PrepareDeps {
  settings: Settings;
  ner?: RedactOptions['ner'];
  /** Next-generation span model; preparation runs ahead of time, so its extra cost is invisible to the user. */
  spanNer?: RedactOptions['spanNer'];
  classify?: RedactOptions['classify'];
  extract: (name: string, bytes: Uint8Array, onProgress?: (frac: number, label: string) => void) => Promise<{ text: string; meta: string }>;
}

/** Progress of one scan: `frac` is the overall share done (0–1), `label` what is happening right now. */
export interface ScanProgress {
  path: string;
  done: number;
  total: number;
  status: 'preparing' | 'ready' | 'error';
  frac: number;
  label: string;
}

/** Extract + detect one file. Never throws: failures are stored as status 'error' so the UI can show them. */
export async function prepareFile(
  file: VaultFileInfo,
  bytes: Uint8Array,
  deps: PrepareDeps,
  prev?: PreparedDoc | null,
  onProgress?: (frac: number, label: string) => void,
): Promise<PreparedDoc> {
  const t0 = performance.now();
  const base = {
    id: await docId(file.path),
    path: file.path,
    name: file.name,
    size: file.size,
    mtime: file.mtime,
    hash: await sha256(bytes),
    settingsKey: settingsKey(deps.settings, !!deps.spanNer),
    allowList: [...deps.settings.allowList],
    review: prev?.review ?? { allow: [], manual: [] },
  };
  try {
    // Reading takes most of the time for long or scanned documents, detection the rest.
    const { text, meta } = await deps.extract(file.name, bytes, (f, label) => onProgress?.(0.7 * f, label));
    onProgress?.(0.75, 'finding personal data');
    // Detect without the per-document review lists: they are applied at use time, so editing them is instant.
    const d = await detect(text, { settings: deps.settings, ner: deps.ner, spanNer: deps.spanNer, classify: deps.classify });
    onProgress?.(1, 'done');
    return { ...base, status: 'ready', text, meta, entities: d.entities, candidates: d.candidates, warnings: d.warnings, preparedAt: Date.now(), prepareMs: Math.round(performance.now() - t0) };
  } catch (e) {
    return { ...base, status: 'error', error: (e as Error).message, text: '', meta: '', entities: [], candidates: 0, warnings: [], preparedAt: Date.now(), prepareMs: Math.round(performance.now() - t0) };
  }
}

export interface ScanResult {
  index: VaultIndex;
  prepared: string[];
  unchanged: string[];
  removed: string[];
}

/**
 * Bring the cache in line with the folder: prepare new/changed files, drop deleted ones.
 * A file counts as changed if size/mtime differ AND its content hash differs (a plain `touch` is cheap).
 */
export async function scanVault(
  fs: VaultFs,
  deps: PrepareDeps,
  onProgress?: (e: ScanProgress) => void,
): Promise<ScanResult> {
  const index = await loadIndex(fs);
  const files = await fs.list();
  const key = settingsKey(deps.settings, !!deps.spanNer);
  const seen = new Set<string>();
  const res: ScanResult = { index, prepared: [], unchanged: [], removed: [] };
  const todo: { file: VaultFileInfo; id: string }[] = [];

  for (const file of files) {
    const id = await docId(file.path);
    seen.add(id);
    const entry = index.docs[id];
    if (entry && entry.settingsKey === key && entry.size === file.size && entry.mtime === file.mtime) {
      res.unchanged.push(id);
      continue;
    }
    todo.push({ file, id });
  }

  let done = 0;
  for (const { file, id } of todo) {
    // Progress messages are throttled: OCR reports many small steps.
    let last = 0;
    const report = (f: number, label: string, status: ScanProgress['status'] = 'preparing', force = false) => {
      const now = Date.now();
      if (!force && now - last < 150) return;
      last = now;
      onProgress?.({ path: file.path, done, total: todo.length, status, frac: (done + f) / todo.length, label });
    };
    report(0, 'reading', 'preparing', true);
    const bytes = await fs.read(file.path);
    const entry = index.docs[id];
    if (entry && entry.settingsKey === key && entry.hash === (await sha256(bytes))) {
      // Only the timestamp changed.
      entry.mtime = file.mtime;
      res.unchanged.push(id);
    } else {
      const doc = await prepareFile(file, bytes, deps, await loadDoc(fs, id), (f, label) => report(f, label));
      await fs.writeCache(`${id}.json`, JSON.stringify(doc));
      await writePreparedCopy(fs, doc);
      index.docs[id] = toEntry(doc);
      res.prepared.push(id);
      report(1, doc.status === 'ready' ? 'prepared' : 'failed', doc.status, true);
    }
    done++;
    await saveIndex(fs, index);
  }

  for (const id of Object.keys(index.docs)) {
    if (seen.has(id)) continue;
    await fs.removePrepared?.(index.docs[id].path).catch(() => {});
    delete index.docs[id];
    await fs.removeCache(`${id}.json`).catch(() => {});
    res.removed.push(id);
  }
  await saveIndex(fs, index);
  if (res.prepared.length || res.removed.length || !(await fs.readCache(GAZETTEER))) await saveGazetteer(fs, index);
  return res;
}

/**
 * The cleaned copy in `limenn-prepared/`: exactly the kind of text the AI receives, so it can be checked or
 * attached by hand. Placeholder numbers here are per document; in a chat they are numbered per conversation.
 */
export async function writePreparedCopy(fs: VaultFs, doc: PreparedDoc) {
  if (!fs.writePrepared) return;
  if (doc.status !== 'ready') return fs.removePrepared?.(doc.path).catch(() => {});
  const { clean, entities } = applyDoc(doc, new Vault());
  const head = `Cleaned by Limenn on this device · ${doc.name} · ${doc.meta} · ${entities.length} personal values replaced\n` +
    `Placeholders like [PERSON-1] stand for the original values, which stay in the source file.\n\n`;
  await fs.writePrepared(doc.path, head + clean).catch(() => {});
}

const GAZETTEER = 'gazetteer.json';

/** Rebuild the personal gazetteer from all prepared documents (people / organisations found with high confidence). */
export async function saveGazetteer(fs: VaultFs, index: VaultIndex): Promise<KnownValue[]> {
  const docs: PreparedDoc[] = [];
  for (const id of Object.keys(index.docs)) {
    const d = await loadDoc(fs, id);
    if (d?.status === 'ready') docs.push({ ...d, entities: d.entities.filter((e) => !d.review.allow.includes(e.text.trim())) });
  }
  const gaz = buildGazetteer(docs);
  await fs.writeCache(GAZETTEER, JSON.stringify(gaz));
  return gaz;
}

export async function loadGazetteer(fs: VaultFs): Promise<KnownValue[]> {
  const raw = await fs.readCache(GAZETTEER).catch(() => null);
  try {
    return raw ? (JSON.parse(raw) as KnownValue[]) : [];
  } catch {
    return [];
  }
}


/**
 * The fast path: turn a prepared doc into redacted text for the current conversation.
 * `allow` is the session's "send unchanged" list and `rules` the user's protected words and shapes; the doc's own
 * review lists are added on top.
 */
export function applyDoc(doc: PreparedDoc, vault: Vault, session: { allow?: Iterable<string>; rules?: readonly Pick<ProtectedRule, 'kind' | 'value' | 'type'>[] } = {}) {
  if (doc.status !== 'ready') throw new Error(doc.error ?? `${doc.name} is not prepared`);
  const allow = [...(session.allow ?? []), ...(doc.allowList ?? []), ...doc.review.allow];
  const manual = customEntities(doc.text, [...wordsRules(doc.review.manual), ...(session.rules ?? [])]);
  const r = applyEntities(doc.text, doc.entities, vault, { allow, manual });
  return { ...r, stats: statsOf(r.entities, r.propagated, doc.candidates, 0) };
}
