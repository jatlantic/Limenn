/** Reads one PDF page by OCR (rendered page → text). Provided by the browser engine; absent in Node. */
export type OcrPage = (page: any, onProgress?: (frac: number) => void) => Promise<string>;

/** Pages with fewer visible characters than this are treated as scanned and sent to OCR (when available). */
const MIN_PAGE_CHARS = 30;

/**
 * Extract plain text from a PDF with pdf.js, one line per text row, pages separated by a marker.
 * Scanned pages (no usable text layer) are read with `ocrPage` when given, so mixed PDFs work too.
 */
export async function extractPdfText(
  data: ArrayBuffer | Uint8Array,
  pdfjs: any,
  opts: { ocrPage?: OcrPage; onProgress?: (frac: number, label: string) => void } = {},
): Promise<{ text: string; pages: number; empty: boolean; ocrPages: number }> {
  const task = pdfjs.getDocument({
    data: data instanceof Uint8Array ? data : new Uint8Array(data),
    isEvalSupported: false,
    verbosity: 0,
  });
  const doc = await task.promise;
  const parts: string[] = [];
  let ocrPages = 0;
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    let line = '';
    const lines: string[] = [];
    for (const item of content.items as { str: string; hasEOL?: boolean }[]) {
      line += item.str;
      if (item.hasEOL) {
        lines.push(line);
        line = '';
      }
    }
    if (line) lines.push(line);
    let body = lines.join('\n').replace(/[ \t]+\n/g, '\n');
    if (body.replace(/\s/g, '').length < MIN_PAGE_CHARS && opts.ocrPage) {
      opts.onProgress?.((i - 1) / doc.numPages, `reading page ${i}/${doc.numPages} (OCR)`);
      const ocr = await opts.ocrPage(page, (f) => opts.onProgress?.((i - 1 + f) / doc.numPages, `reading page ${i}/${doc.numPages} (OCR)`));
      if (ocr.replace(/\s/g, '').length > body.replace(/\s/g, '').length) {
        body = ocr;
        ocrPages++;
      }
    }
    parts.push(`--- Page ${i} ---\n` + body);
    page.cleanup?.();
    opts.onProgress?.(i / doc.numPages, `reading page ${i}/${doc.numPages}`);
  }
  const text = parts.join('\n\n');
  const empty = text.replace(/--- Page \d+ ---/g, '').trim().length < 20;
  const pages = doc.numPages;
  await task.destroy();
  return { text, pages, empty, ocrPages };
}
