import type { Entity, EntityType } from './types';

/** Raw per-token output of a transformers.js token-classification pipeline (ignore_labels: []). */
export interface TokenPrediction {
  entity: string;
  score: number;
  word: string;
}

export type TokenClassifier = (text: string) => Promise<TokenPrediction[]>;

const LABEL_MAP: Record<string, EntityType> = {
  PER: 'PERSON',
  PERSON: 'PERSON',
  ORG: 'ORG',
  LOC: 'LOCATION',
  GPE: 'LOCATION',
  DATE: 'DATE',
};

const MAX_CHUNK_CHARS = 1200;

/** Split text into chunks below the model's 512-token limit, preferring paragraph/sentence boundaries. */
export function chunkText(text: string, max = MAX_CHUNK_CHARS): { offset: number; text: string }[] {
  const chunks: { offset: number; text: string }[] = [];
  let pos = 0;
  while (pos < text.length) {
    let end = Math.min(pos + max, text.length);
    if (end < text.length) {
      const window = text.slice(pos, end);
      const cut = Math.max(window.lastIndexOf('\n'), window.lastIndexOf('. '), window.lastIndexOf('? '));
      if (cut > max * 0.4) end = pos + cut + 1;
      else {
        const sp = window.lastIndexOf(' ');
        if (sp > 0) end = pos + sp + 1;
      }
    }
    chunks.push({ offset: pos, text: text.slice(pos, end) });
    pos = end;
  }
  return chunks;
}

interface AlignedToken extends TokenPrediction {
  start: number;
  end: number;
  sub: boolean;
}

/** Locate each wordpiece in the source text (the pipeline does not return offsets). */
function align(text: string, tokens: TokenPrediction[]): AlignedToken[] {
  const out: AlignedToken[] = [];
  let cursor = 0;
  for (const t of tokens) {
    const sub = t.word.startsWith('##');
    const piece = sub ? t.word.slice(2) : t.word;
    if (!piece || piece === '[UNK]') continue;
    const idx = text.indexOf(piece, cursor);
    // Don't let one unmatched token (normalisation quirks) derail the rest.
    if (idx < 0 || idx - cursor > 40) continue;
    out.push({ ...t, start: idx, end: idx + piece.length, sub });
    cursor = idx + piece.length;
  }
  return out;
}

const tagOf = (label: string): [string, string] =>
  /^[BIES]-/.test(label) ? [label[0], label.slice(2)] : label === 'O' ? ['O', ''] : ['I', label];

/** BIO-group aligned tokens into entity spans, expanding to whole words. */
export function groupTokens(text: string, tokens: TokenPrediction[], offset = 0): Entity[] {
  const aligned = align(text, tokens);
  const out: Entity[] = [];
  let cur: { type: string; start: number; end: number; scores: number[] } | null = null;
  const flush = () => {
    if (!cur) return;
    const type = LABEL_MAP[cur.type];
    if (type) {
      let { start, end } = cur;
      while (start > 0 && /[\p{L}\p{N}]/u.test(text[start - 1])) start--;
      while (end < text.length && /[\p{L}\p{N}]/u.test(text[end])) end++;
      const value = text.slice(start, end);
      const score = cur.scores.reduce((a, b) => a + b, 0) / cur.scores.length;
      out.push({ start: start + offset, end: end + offset, text: value, type, source: 'ner', score });
    }
    cur = null;
  };
  for (const t of aligned) {
    const [prefix, type] = tagOf(t.entity);
    if (prefix === 'O') {
      // A subword labelled O inside an entity word still belongs to it.
      if (cur && t.sub && t.start === cur.end) {
        cur.end = t.end;
        continue;
      }
      flush();
      continue;
    }
    const continues =
      cur &&
      cur.type === type &&
      (prefix === 'I' || prefix === 'E' || t.sub) &&
      t.start - cur.end <= 2 &&
      !text.slice(cur.end, t.start).includes('\n');
    if (continues) {
      cur!.end = t.end;
      cur!.scores.push(t.score);
    } else {
      flush();
      cur = { type, start: t.start, end: t.end, scores: [t.score] };
    }
  }
  flush();
  return out;
}

export async function detectNer(text: string, classify: TokenClassifier): Promise<Entity[]> {
  const out: Entity[] = [];
  for (const chunk of chunkText(text)) {
    if (!chunk.text.trim()) continue;
    const tokens = await classify(chunk.text);
    out.push(...groupTokens(chunk.text, tokens, chunk.offset));
  }
  // Drop tiny / punctuation-only spans
  return out.filter((e) => /\p{L}{2,}/u.test(e.text));
}

/** Build a classifier backed by transformers.js. Works in Node (tests) and in extension pages. */
export async function createTransformersClassifier(
  model: string,
  opts: { onProgress?: (p: { status: string; progress?: number; file?: string }) => void; configure?: (env: any) => void } = {},
): Promise<TokenClassifier> {
  const { pipeline, env } = await import('@huggingface/transformers');
  opts.configure?.(env);
  const pipe: any = await pipeline('token-classification', model, {
    dtype: 'q8',
    progress_callback: opts.onProgress as any,
  });
  return async (text: string) => (await pipe(text, { ignore_labels: [] })) as TokenPrediction[];
}
