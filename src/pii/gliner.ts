// Next-generation span detector: GLiNER multi-PII (mDeBERTa-v3 base, Apache-2.0) as an int8 ONNX model,
// ~350 MB, running on the CPU through ONNX Runtime — in Node (desktop app, benchmark) and in the browser (WASM).
// This file is runtime-agnostic: the tokenizer and the ONNX session are injected.
//
// GLiNER prompt: [CLS] <<ENT>> label1 <<ENT>> label2 … <<SEP>> word1 word2 … [SEP]; every candidate span of up
// to `maxWidth` words gets a score per label. Ported from the reference implementation (span "markerV0").
import type { Entity, EntityType } from './types';

/** Labels the model is asked for → Limenn entity type (the "v1" set chosen on the dev split). */
export const GLINER_LABELS: Record<string, EntityType> = {
  person: 'PERSON',
  organization: 'ORG',
  company: 'ORG',
  city: 'LOCATION',
  'street address': 'ADDRESS',
  'postal code': 'POSTAL_CODE',
  date: 'DATE',
  'date of birth': 'DATE',
  email: 'EMAIL',
  'phone number': 'PHONE',
  iban: 'IBAN',
  'credit card number': 'CREDIT_CARD',
  'social security number': 'NATIONAL_ID',
  'identity card number': 'ID_NUMBER',
  'passport number': 'ID_NUMBER',
  'account number': 'ID_NUMBER',
  'customer id': 'ID_NUMBER',
  'license plate': 'ID_NUMBER',
  'ip address': 'IP',
  url: 'URL',
  'medical condition': 'HEALTH',
  medication: 'HEALTH',
  salary: 'FINANCIAL',
};

export interface GlinerTokenizer {
  encode(text: string): number[];
  sep_token_id?: number;
}
/** Minimal ONNX Runtime surface (onnxruntime-node and onnxruntime-web both provide it). */
export interface OrtLike {
  Tensor: new (type: string, data: BigInt64Array | Uint8Array, dims: number[]) => unknown;
}
export interface OrtSession {
  run(feeds: Record<string, unknown>): Promise<Record<string, { data: Float32Array | ArrayLike<number>; dims: readonly number[] }>>;
}

export interface GlinerOptions {
  tokenizer: GlinerTokenizer;
  session: OrtSession;
  ort: OrtLike;
  labels?: Record<string, EntityType>;
  maxWidth?: number;
  /** Characters per chunk (GLiNER reads ~384 words at a time). */
  chunkChars?: number;
  /** Spans below this score are not returned at all (thresholds per type are applied later, see ensemble.ts). */
  minScore?: number;
}

// Same word splitter as the reference implementation ("whitespace" splitter: words, or single symbols).
const WORD = /\w+(?:[-_]\w+)*|\S/gu;

function chunks(text: string, size: number): [number, string][] {
  const out: [number, string][] = [];
  let pos = 0;
  while (pos < text.length) {
    let end = Math.min(pos + size, text.length);
    if (end < text.length) {
      const w = text.slice(pos, end);
      const cut = Math.max(w.lastIndexOf('\n'), w.lastIndexOf('. '));
      if (cut > size * 0.4) end = pos + cut + 1;
      else {
        const sp = w.lastIndexOf(' ');
        if (sp > 0) end = pos + sp + 1;
      }
    }
    out.push([pos, text.slice(pos, end)]);
    pos = end;
  }
  return out;
}

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

export function createGlinerDetector(opts: GlinerOptions): (text: string) => Promise<Entity[]> {
  const labels = opts.labels ?? GLINER_LABELS;
  const names = Object.keys(labels);
  const maxWidth = opts.maxWidth ?? 12;
  const chunkChars = opts.chunkChars ?? 1200;
  const minScore = opts.minScore ?? 0.3;
  const sep = opts.tokenizer.sep_token_id ?? 2;
  // Token ids of the prompt part are the same for every chunk.
  const promptWords = names.flatMap((n) => ['<<ENT>>', n]).concat('<<SEP>>');
  const promptIds = promptWords.map((w) => opts.tokenizer.encode(w).slice(1, -1));
  const wordIdCache = new Map<string, number[]>();
  const encodeWord = (w: string) => {
    let ids = wordIdCache.get(w);
    if (!ids) {
      ids = opts.tokenizer.encode(w).slice(1, -1);
      if (wordIdCache.size < 50_000) wordIdCache.set(w, ids);
    }
    return ids;
  };
  const i64 = (xs: number[]) => BigInt64Array.from(xs, (x) => BigInt(x));

  async function runChunk(offset: number, text: string): Promise<Entity[]> {
    const words: { start: number; end: number }[] = [];
    for (const m of text.matchAll(WORD)) words.push({ start: m.index!, end: m.index! + m[0].length });
    if (!words.length) return [];
    const inputIds: number[] = [1];
    const wordsMask: number[] = [0];
    for (const ids of promptIds) for (const id of ids) (inputIds.push(id), wordsMask.push(0));
    words.forEach((w, i) => {
      const ids = encodeWord(text.slice(w.start, w.end));
      ids.forEach((id, k) => (inputIds.push(id), wordsMask.push(k === 0 ? i + 1 : 0)));
    });
    inputIds.push(sep);
    wordsMask.push(0);
    const n = words.length;
    const spanIdx: number[] = [];
    const spanMask: number[] = [];
    for (let i = 0; i < n; i++)
      for (let j = 0; j < maxWidth; j++) {
        spanIdx.push(i, i + j);
        spanMask.push(i + j < n ? 1 : 0);
      }
    const T = opts.ort.Tensor;
    const feeds = {
      input_ids: new T('int64', i64(inputIds), [1, inputIds.length]),
      attention_mask: new T('int64', i64(inputIds.map(() => 1)), [1, inputIds.length]),
      words_mask: new T('int64', i64(wordsMask), [1, wordsMask.length]),
      text_lengths: new T('int64', i64([n]), [1, 1]),
      span_idx: new T('int64', i64(spanIdx), [1, n * maxWidth, 2]),
      span_mask: new T('bool', Uint8Array.from(spanMask), [1, n * maxWidth]),
    };
    const out = await opts.session.run(feeds);
    const logits = out.logits.data;
    const C = names.length;
    const cands: { s: number; e: number; c: number; p: number }[] = [];
    // logits: [1, n, maxWidth, C]
    for (let i = 0; i < n; i++)
      for (let j = 0; j < maxWidth && i + j < n; j++)
        for (let c = 0; c < C; c++) {
          const p = sigmoid(logits[(i * maxWidth + j) * C + c] as number);
          if (p >= minScore) cands.push({ s: i, e: i + j, c, p });
        }
    // Greedy flat decoding: highest score first, no overlapping spans.
    cands.sort((a, b) => b.p - a.p);
    const taken: { s: number; e: number }[] = [];
    const ents: Entity[] = [];
    for (const k of cands) {
      if (taken.some((t) => k.s <= t.e && t.s <= k.e)) continue;
      taken.push(k);
      const start = offset + words[k.s].start;
      const end = offset + words[k.e].end;
      ents.push({ start, end, text: '', type: labels[names[k.c]], source: 'ner', score: k.p });
    }
    return ents;
  }

  return async (text: string) => {
    const out: Entity[] = [];
    for (const [off, chunk] of chunks(text, chunkChars)) out.push(...(await runChunk(off, chunk)));
    for (const e of out) e.text = text.slice(e.start, e.end);
    return out.sort((a, b) => a.start - b.start);
  };
}
