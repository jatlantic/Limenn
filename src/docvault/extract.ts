// Plain text from the document types professionals actually send: PDF (with OCR for scanned pages), Word,
// Excel, PowerPoint, OpenDocument, RTF, HTML, e-mail (.eml), images (OCR) and plain text. Runs in the browser
// engine and in Node (desktop, benchmark); OCR is only available where the caller provides it.
import JSZip from 'jszip';
import { extractPdfText, type OcrPage } from '../pdf/extract';

export interface ExtractDeps {
  pdfjs: any;
  /** mammoth (Node) or mammoth.browser — only needed for .docx */
  mammoth?: { extractRawText(input: { arrayBuffer: ArrayBuffer } | { buffer: Uint8Array }): Promise<{ value: string }> };
  /** OCR for a rendered PDF page (browser engine). */
  ocrPage?: OcrPage;
  /** OCR for an image file (browser engine). */
  ocrImage?: (bytes: Uint8Array, name: string, onProgress?: (frac: number) => void) => Promise<string>;
}

export type ExtractProgress = (frac: number, label: string) => void;

export const IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif', '.tif', '.tiff'];
const ext = (name: string) => name.toLowerCase().replace(/^.*(\.[^.]+)$/, '$1');
const chars = (text: string) => `${(text.length / 1000).toFixed(1)}k chars`;

const decodeXml = (s: string) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');

/** Text runs of an Office/OpenDocument XML part, one paragraph per line. */
function xmlText(xml: string, run: string, para: string): string {
  return xml
    .replace(new RegExp(`</${para}>`, 'g'), '\n')
    .replace(/<a:br\/>|<w:br\/>|<text:line-break\/>|<text:tab\/>|<w:tab\/>/g, (m) => (m.includes('tab') ? '\t' : '\n'))
    .replace(new RegExp(`<${run}(?:\\s[^>]*)?>([^<]*)</${run}>`, 'g'), (_, t) => `\u0000${t}\u0000`)
    .replace(/<[^>]+>/g, '')
    .replace(/\u0000/g, '')
    .split('\n')
    .map((l) => decodeXml(l).trim())
    .filter(Boolean)
    .join('\n');
}

const byNumber = (a: string, b: string) => (+(a.match(/(\d+)\.xml$/)?.[1] ?? 0)) - +(b.match(/(\d+)\.xml$/)?.[1] ?? 0);

async function xlsxText(zip: JSZip): Promise<string> {
  const shared: string[] = [];
  const ss = await zip.file('xl/sharedStrings.xml')?.async('string');
  if (ss) for (const si of ss.match(/<si>[\s\S]*?<\/si>/g) ?? []) shared.push(decodeXml((si.match(/<t[^>]*>([^<]*)<\/t>/g) ?? []).map((t) => t.replace(/<[^>]+>/g, '')).join('')));
  const names = [...(await zip.file('xl/workbook.xml')?.async('string') ?? '').matchAll(/<sheet [^>]*name="([^"]*)"/g)].map((m) => decodeXml(m[1]));
  const sheets = Object.keys(zip.files).filter((f) => /^xl\/worksheets\/sheet\d+\.xml$/.test(f)).sort(byNumber);
  const out: string[] = [];
  for (const [i, f] of sheets.entries()) {
    const xml = await zip.file(f)!.async('string');
    const rows: string[] = [];
    for (const row of xml.match(/<row[^>]*>[\s\S]*?<\/row>/g) ?? []) {
      const cells: string[] = [];
      for (const c of row.match(/<c [^>]*?(?:\/>|>[\s\S]*?<\/c>)/g) ?? []) {
        const v = c.match(/<v>([^<]*)<\/v>/)?.[1] ?? c.match(/<t[^>]*>([^<]*)<\/t>/)?.[1];
        if (v == null) continue;
        cells.push(/t="s"/.test(c) ? (shared[+v] ?? '') : decodeXml(v));
      }
      if (cells.some((c) => c.trim())) rows.push(cells.join('\t'));
    }
    out.push(`--- Sheet ${names[i] ?? i + 1} ---\n${rows.join('\n')}`);
  }
  return out.join('\n\n');
}

async function pptxText(zip: JSZip): Promise<string> {
  const slides = Object.keys(zip.files).filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f)).sort(byNumber);
  const notes = Object.keys(zip.files).filter((f) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(f)).sort(byNumber);
  const out: string[] = [];
  for (const [i, f] of slides.entries()) {
    let t = xmlText(await zip.file(f)!.async('string'), 'a:t', 'a:p');
    const n = notes[i] && xmlText(await zip.file(notes[i])!.async('string'), 'a:t', 'a:p');
    if (n) t += `\n[notes] ${n}`;
    out.push(`--- Slide ${i + 1} ---\n${t}`);
  }
  return out.join('\n\n');
}

async function odfText(zip: JSZip): Promise<string> {
  const xml = (await zip.file('content.xml')?.async('string')) ?? '';
  return xml
    .replace(/<text:(?:p|h)[^>]*\/>/g, '\n')
    .replace(/<\/text:(?:p|h)>|<\/table:table-row>/g, '\n')
    .replace(/<\/table:table-cell>/g, '\t')
    .replace(/<text:tab\/>/g, '\t')
    .replace(/<text:line-break\/>/g, '\n')
    .replace(/<text:s(?: text:c="(\d+)")?\/>/g, (_, n) => ' '.repeat(+(n ?? 1)))
    .replace(/<[^>]+>/g, '')
    .split('\n')
    .map((l) => decodeXml(l).replace(/\t+$/, '').trim())
    .filter(Boolean)
    .join('\n');
}

/** RTF → text: drops control words, groups like font tables, and decodes \'hh and \uN escapes. */
export function rtfText(rtf: string): string {
  let out = '';
  let depth = 0;
  const skipAt: number[] = [];
  const skipping = () => skipAt.length > 0 && depth >= skipAt[skipAt.length - 1];
  for (let i = 0; i < rtf.length; i++) {
    const c = rtf[i];
    if (c === '{') {
      depth++;
      const m = rtf.slice(i + 1, i + 30).match(/^\\\*?\\?(fonttbl|colortbl|stylesheet|info|pict|object|header|footer|\*)/);
      if (m && !skipping()) skipAt.push(depth);
      continue;
    }
    if (c === '}') {
      if (skipAt.length && skipAt[skipAt.length - 1] === depth) skipAt.pop();
      depth--;
      continue;
    }
    if (c === '\\') {
      const rest = rtf.slice(i + 1);
      let m: RegExpMatchArray | null;
      if ((m = rest.match(/^'([0-9a-f]{2})/i))) {
        if (!skipping()) out += new TextDecoder('windows-1252').decode(new Uint8Array([parseInt(m[1], 16)]));
        i += 3;
      } else if ((m = rest.match(/^u(-?\d+)\s?\??/))) {
        if (!skipping()) out += String.fromCharCode(+m[1] < 0 ? +m[1] + 65536 : +m[1]);
        i += m[0].length;
      } else if ((m = rest.match(/^([a-z]+)(-?\d+)? ?/i))) {
        if (!skipping() && /^(par|line|row|sect|page)$/.test(m[1])) out += '\n';
        if (!skipping() && /^(tab|cell)$/.test(m[1])) out += '\t';
        i += m[0].length;
      } else {
        if (!skipping() && /[\\{}]/.test(rest[0])) out += rest[0];
        i += 1;
      }
      continue;
    }
    if (!skipping() && c !== '\r' && c !== '\n') out += c;
  }
  return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** HTML → readable text (block elements become line breaks; scripts and styles are dropped). */
export function htmlText(html: string): string {
  return decodeXml(
    html
      .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|tr|h[1-6]|section|article|table|blockquote)>/gi, '\n')
      .replace(/<\/t[dh]>/gi, '\t')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' '),
  )
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join('\n');
}

const qpDecode = (s: string) => {
  const bytes: number[] = [];
  const src = s.replace(/=\r?\n/g, '');
  for (let i = 0; i < src.length; i++) {
    if (src[i] === '=' && /^[0-9A-F]{2}$/i.test(src.slice(i + 1, i + 3))) {
      bytes.push(parseInt(src.slice(i + 1, i + 3), 16));
      i += 2;
    } else bytes.push(...new TextEncoder().encode(src[i]));
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
};
const b64Decode = (s: string) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/\s/g, '')), (c) => c.charCodeAt(0)));
/** "=?UTF-8?Q?M=C3=BCller?=" header words. */
const decodeWords = (s: string) =>
  s.replace(/=\?[^?]+\?([QB])\?([^?]*)\?=/gi, (_, enc, t) => (enc.toUpperCase() === 'B' ? b64Decode(t) : qpDecode(t.replace(/_/g, ' '))));

/** .eml → the headers people care about plus the readable body (text/plain preferred, else HTML). */
export function emlText(raw: string): string {
  const [head, ...rest] = raw.split(/\r?\n\r?\n/);
  const headers = head.replace(/\r?\n[ \t]+/g, ' ');
  const pick = (h: string) => headers.match(new RegExp(`^${h}:\\s*(.*)$`, 'mi'))?.[1];
  const lines = ['From', 'To', 'Cc', 'Date', 'Subject'].map((h) => (pick(h) ? `${h}: ${decodeWords(pick(h)!)}` : '')).filter(Boolean);
  const body = rest.join('\n\n');
  const decodePart = (h: string, b: string) => {
    const enc = h.match(/content-transfer-encoding:\s*([\w-]+)/i)?.[1]?.toLowerCase();
    const t = enc === 'base64' ? b64Decode(b) : enc === 'quoted-printable' ? qpDecode(b) : b;
    return /content-type:\s*text\/html/i.test(h) ? htmlText(t) : t;
  };
  const boundary = headers.match(/boundary="?([^";\s]+)"?/i)?.[1];
  let text = '';
  if (boundary) {
    const parts = body.split(`--${boundary}`).map((p) => {
      const [h, ...b] = p.replace(/^\r?\n/, '').split(/\r?\n\r?\n/);
      return { h, b: b.join('\n\n') };
    });
    const plain = parts.find((p) => /content-type:\s*text\/plain/i.test(p.h));
    const html = parts.find((p) => /content-type:\s*text\/html/i.test(p.h));
    const nested = parts.find((p) => /content-type:\s*multipart\//i.test(p.h));
    const attachments = parts.map((p) => p.h.match(/filename="?([^";\r\n]+)"?/i)?.[1]).filter(Boolean);
    text = plain ? decodePart(plain.h, plain.b) : html ? decodePart(html.h, html.b) : nested ? emlText(`${nested.h}\n\n${nested.b}`) : '';
    if (attachments.length) text += `\n\n[attachments: ${attachments.join(', ')}]`;
  } else text = decodePart(headers, body);
  return [...lines, '', text.trim()].join('\n');
}

/** Plain text of a document. Throws for files that have no readable text. */
export async function extractText(name: string, bytes: Uint8Array, deps: ExtractDeps, onProgress?: ExtractProgress): Promise<{ text: string; meta: string }> {
  const e = ext(name);
  if (e === '.pdf') {
    const { text, pages, empty, ocrPages } = await extractPdfText(bytes, deps.pdfjs, { ocrPage: deps.ocrPage, onProgress });
    if (empty) throw new Error(deps.ocrPage ? `${name}: no readable text found, even with OCR.` : `${name} has no text layer (scanned PDF?). OCR is only available in the browser extension.`);
    const meta = `${pages} page${pages > 1 ? 's' : ''}${ocrPages ? ` · ${ocrPages} read by OCR` : ''}`;
    return { text, meta };
  }
  if (IMAGE_EXT.includes(e)) {
    if (!deps.ocrImage) throw new Error(`${name}: images need OCR, which is only available in the browser extension.`);
    onProgress?.(0, 'reading image (OCR)');
    const text = await deps.ocrImage(bytes, name, (f) => onProgress?.(f, 'reading image (OCR)'));
    if (text.replace(/\s/g, '').length < 5) throw new Error(`${name}: no readable text found in the image.`);
    return { text, meta: `image · OCR · ${chars(text)}` };
  }
  if (e === '.docx') {
    if (!deps.mammoth) throw new Error('Word documents are not supported here.');
    const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const input = typeof window === 'undefined' ? { buffer: bytes } : { arrayBuffer: ab };
    const { value } = await deps.mammoth.extractRawText(input as never);
    return { text: value, meta: chars(value) };
  }
  if (['.xlsx', '.xlsm', '.pptx', '.odt', '.ods', '.odp'].includes(e)) {
    const zip = await JSZip.loadAsync(bytes);
    const text = e.startsWith('.xls') ? await xlsxText(zip) : e === '.pptx' ? await pptxText(zip) : await odfText(zip);
    if (!text.trim()) throw new Error(`${name}: no text found.`);
    const unit = e.startsWith('.xls') || e === '.ods' ? 'spreadsheet' : e === '.pptx' || e === '.odp' ? 'slides' : 'document';
    return { text, meta: `${unit} · ${chars(text)}` };
  }
  const raw = new TextDecoder().decode(bytes);
  if (e === '.rtf') {
    const text = rtfText(raw);
    return { text, meta: chars(text) };
  }
  if (e === '.html' || e === '.htm') {
    const text = htmlText(raw);
    return { text, meta: chars(text) };
  }
  if (e === '.eml') {
    const text = emlText(raw);
    return { text, meta: `e-mail · ${chars(text)}` };
  }
  return { text: raw, meta: chars(raw) };
}
