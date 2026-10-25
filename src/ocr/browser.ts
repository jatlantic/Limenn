// On-device OCR for scanned PDF pages and images (offscreen engine). Tesseract 5 LSTM with the "best" models
// for German, French, Italian and English, all bundled with the extension (dist/ocr, dist/models/tessdata_best):
// nothing is downloaded. The worker starts on first use and is shut down again after a quiet minute.
import { createWorker, OEM, PSM, type Worker } from 'tesseract.js';

const LANGS = ['deu', 'fra', 'ita', 'eng'];
/** ~300 dpi: the resolution Tesseract is trained for. Capped so huge pages don't exhaust memory. */
const TARGET_DPI = 300;
const MAX_SIDE = 5000;
const IDLE_MS = 60_000;

let worker: Promise<Worker> | null = null;
let idle: ReturnType<typeof setTimeout> | undefined;
let onJobProgress: ((frac: number) => void) | undefined;

function getWorker(): Promise<Worker> {
  clearTimeout(idle);
  worker ??= (async () => {
    const w = await createWorker(LANGS, OEM.LSTM_ONLY, {
      workerPath: chrome.runtime.getURL('ocr/worker.min.js'),
      // The full SIMD build: the trimmed "-lstm" builds lack the float kernels the "best" models need.
      corePath: chrome.runtime.getURL('ocr/tesseract-core-simd.wasm.js'),
      langPath: chrome.runtime.getURL('models/tessdata_best'),
      gzip: false,
      workerBlobURL: false,
      cacheMethod: 'none',
      logger: (m: { status: string; progress: number }) => {
        if (m.status === 'recognizing text') onJobProgress?.(m.progress);
      },
    });
    // Automatic page segmentation (columns, tables); keep spaces between words as on the page.
    await w.setParameters({ tessedit_pageseg_mode: PSM.AUTO, preserve_interword_spaces: '1' });
    return w;
  })().catch((e) => {
    worker = null;
    throw e;
  });
  return worker;
}

function scheduleShutdown() {
  clearTimeout(idle);
  idle = setTimeout(() => {
    const w = worker;
    worker = null;
    w?.then((x) => x.terminate()).catch(() => {});
  }, IDLE_MS);
}

/** Recognise one image (canvas, blob or bytes). Jobs run one after another on the single worker. */
let queue: Promise<unknown> = Promise.resolve();
async function recognize(image: HTMLCanvasElement | Blob | Uint8Array, onProgress?: (frac: number) => void): Promise<string> {
  const job = queue.then(async () => {
    const w = await getWorker();
    onJobProgress = onProgress;
    try {
      const input = image instanceof Uint8Array ? new Blob([image as Uint8Array<ArrayBuffer>]) : image;
      const { data } = await w.recognize(input as never);
      return cleanOcr(data.text);
    } finally {
      onJobProgress = undefined;
      scheduleShutdown();
    }
  });
  queue = job.catch(() => {});
  return job;
}

/** Undo typical OCR artefacts: hyphenated line breaks, stray spaces before punctuation, runs of blank lines. */
export function cleanOcr(text: string): string {
  return text
    .replace(/(\p{Ll})-\n(\p{Ll})/gu, '$1$2')
    .replace(/[ \t]+([,.;:!?])/g, '$1')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Render a pdf.js page at ~300 dpi to a canvas, binarisation is left to Tesseract (it does it adaptively). */
export async function ocrPdfPage(page: any, onProgress?: (frac: number) => void): Promise<string> {
  const base = page.getViewport({ scale: 1 });
  const scale = Math.min(TARGET_DPI / 72, MAX_SIDE / Math.max(base.width, base.height));
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  // intent 'print': the display path waits for requestAnimationFrame, which never fires in the hidden
  // offscreen document, so rendering would hang forever.
  await page.render({ canvasContext: ctx, canvas, viewport, intent: 'print' }).promise;
  try {
    return await recognize(canvas, onProgress);
  } finally {
    canvas.width = canvas.height = 0;
  }
}

/** OCR an image file. Browser-decodable formats are upscaled when small; TIFF goes to Tesseract directly. */
export async function ocrImageFile(bytes: Uint8Array, name: string, onProgress?: (frac: number) => void): Promise<string> {
  if (/\.tiff?$/i.test(name)) return recognize(bytes, onProgress);
  const bitmap = await createImageBitmap(new Blob([bytes as Uint8Array<ArrayBuffer>]));
  // Phone photos and screenshots are often below 300 dpi; upscaling small text helps the recogniser.
  const up = Math.max(1, Math.min(3, 2000 / Math.max(bitmap.width, bitmap.height)));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * up);
  canvas.height = Math.round(bitmap.height * up);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  try {
    return await recognize(canvas, onProgress);
  } finally {
    canvas.width = canvas.height = 0;
  }
}
