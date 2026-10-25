// Served from the extension itself: MV3 forbids loading the runtime from a CDN.
import ortMjsUrl from 'ort-dist/ort-wasm-simd-threaded.asyncify.mjs?url';
import ortWasmUrl from 'ort-dist/ort-wasm-simd-threaded.asyncify.wasm?url';
import { createGlinerDetector } from '../pii/gliner';
import { createTransformersClassifier, type TokenClassifier, type TokenPrediction } from '../pii/ner';
import type { Entity } from '../pii/types';

export type ModelStatus = { state: 'idle' | 'loading' | 'ready' | 'error'; progress?: number; detail?: string };

/** Every model ships inside the extension (dist/models, see models/models.lock.json); nothing is downloaded. */
const MODELS_URL = chrome.runtime.getURL('models/');

function useBundledModels(env: any) {
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.localModelPath = MODELS_URL;
  env.useBrowserCache = false;
}

let classifier: Promise<TokenClassifier> | null = null;
let loadedModel = '';
const memo = new Map<string, TokenPrediction[]>();

/** Lazily load the bundled BERT NER model (WASM). */
export function getClassifier(model: string, onStatus: (s: ModelStatus) => void): Promise<TokenClassifier> {
  if (classifier && loadedModel === model) return classifier;
  loadedModel = model;
  memo.clear();
  const files = new Map<string, { loaded: number; total: number }>();
  onStatus({ state: 'loading', progress: 0, detail: 'Loading the detector…' });
  classifier = createTransformersClassifier(model, {
    configure: (env) => {
      useBundledModels(env);
      env.backends.onnx.wasm.wasmPaths = {
        mjs: new URL(ortMjsUrl, location.href).href,
        wasm: new URL(ortWasmUrl, location.href).href,
      };
      env.backends.onnx.wasm.numThreads = 1;
    },
    onProgress: (p: any) => {
      if (p.status === 'progress' && p.file) {
        files.set(p.file, { loaded: p.loaded ?? 0, total: p.total ?? 0 });
        const all = [...files.values()];
        const total = all.reduce((a, f) => a + f.total, 0);
        const loaded = all.reduce((a, f) => a + f.loaded, 0);
        onStatus({ state: 'loading', progress: total ? loaded / total : 0, detail: `Loading model ${(loaded / 1e6).toFixed(0)} / ${(total / 1e6).toFixed(0)} MB` });
      }
    },
  }).then(
    (fn) => {
      onStatus({ state: 'ready', detail: 'Detector ready' });
      return async (text: string) => {
        const hit = memo.get(text);
        if (hit) return hit;
        const r = await fn(text);
        memo.set(text, r);
        return r;
      };
    },
    (err) => {
      classifier = null;
      onStatus({ state: 'error', detail: `Model failed: ${err.message}` });
      throw err;
    },
  );
  return classifier;
}

// ---------- next-generation detector (GLiNER multi-PII, int8 ONNX, ~350 MB, runs on the CPU via WASM) ----------
// The browser needs a WASM-safe int8 variant (gliner-web-q8.onnx, see models/models.lock.json): the published int8 export
// computes wrong scores on ONNX Runtime Web.
const BUNDLED_MODEL = 'models/gliner-web-q8.onnx';
let gliner: Promise<(text: string) => Promise<Entity[]>> | null = null;

export function getGliner(onStatus: (s: ModelStatus) => void): Promise<(text: string) => Promise<Entity[]>> {
  gliner ??= (async () => {
    onStatus({ state: 'loading', progress: 0, detail: 'Loading the second detector…' });
    // Same ONNX Runtime module instance as transformers.js (one WASM runtime in the page).
    const ort = await import('onnxruntime-web/webgpu');
    ort.env.wasm.wasmPaths = { mjs: new URL(ortMjsUrl, location.href).href, wasm: new URL(ortWasmUrl, location.href).href };
    // One thread: multi-threaded WASM (needs cross-origin isolation) was slower for prompt-sized inputs in tests.
    ort.env.wasm.numThreads = 1;
    const res = await fetch(chrome.runtime.getURL(BUNDLED_MODEL)).catch(() => undefined);
    if (!res?.ok) throw new Error('next-generation model is missing from this build');
    const session = await ort.InferenceSession.create(new Uint8Array(await res.arrayBuffer()), { executionProviders: ['wasm'] });
    const { AutoTokenizer, env } = await import('@huggingface/transformers');
    useBundledModels(env);
    const tokenizer = await AutoTokenizer.from_pretrained('onnx-community/gliner_multi_pii-v1');
    onStatus({ state: 'ready', detail: 'Second detector ready' });
    return createGlinerDetector({
      session: session as never,
      ort: ort as never,
      tokenizer: { encode: (t: string) => tokenizer.encode(t), sep_token_id: tokenizer.sep_token_id ?? 2 },
    });
  })().catch((e) => {
    gliner = null;
    onStatus({ state: 'error', detail: `Second detector failed: ${(e as Error).message}` });
    throw e;
  });
  return gliner;
}
