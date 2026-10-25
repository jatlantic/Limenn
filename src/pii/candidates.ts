import { overlapsAny } from './merge';
import type { Candidate, Entity, EntityType } from './types';

const HONORIFIC =
  /\b(?:[Hh]err|[Hh]errn|[Ff]rau|Dr\.|dr\.|Prof\.|prof\.|Mr\.?|mr\.?|Mrs\.?|mrs\.?|Ms\.?|ms\.?|Miss|Monsieur|Madame|Mme\.?|Signor|Signora)\s+((?:[\p{L}][\p{L}'-]+\.?[ \t]?){1,2})/gu;
// Two or more consecutive capitalised words: "Klinik Hirslanden", "Peter Muster"
const CAP_SEQ = /(?<![\p{L}\p{N}])(?:[A-ZÄÖÜ][\p{Ll}'-]+(?:[ \t]+|-)){1,3}[A-ZÄÖÜ][\p{Ll}'-]+(?![\p{L}\p{N}])/gu;
// Codes mixing letters and digits, or long digit runs: "AB-48213-X", "4402819"
const CODE = /(?<![\p{L}\p{N}])(?=[A-Z0-9-/]*\d)(?=[A-Z0-9-/]*[A-Z])[A-Z0-9][A-Z0-9-/]{4,}(?![\p{L}\p{N}])|(?<![\d.,'])\d{5,}(?![\d.,'])/gu;

// Capitalised function words that commonly start sentences or are generic nouns.
const STOP = new Set(
  (
    'Der Die Das Den Dem Des Ein Eine Einen Einem Einer Sehr Geehrte Geehrter Liebe Lieber Mit Freundlichen Grüssen Grüßen ' +
    'Hi Hello Hallo Grüezi Bonjour Bitte Danke Vielen Dank Sie Ihr Ihre Ihnen Wir Ich Er Es Und Oder Aber Wenn Bei Von Vom Zum Zur Im In Am An Auf Für Nach Seit Gemäss Gemäß ' +
    'The A An This That These Those Dear Best Regards Kind Sincerely Yours Please Thank Thanks We I You He She It They And Or But If At Of On In For To From With ' +
    'Monday Tuesday Wednesday Thursday Friday Saturday Sunday Montag Dienstag Mittwoch Donnerstag Freitag Samstag Sonntag ' +
    'January February March April May June July August September October November December Januar Februar März Mai Juni Juli Oktober Dezember ' +
    'Arbeitsvertrag Vertrag Arbeitgeber Arbeitnehmer Lohn Gehalt Rechnung Betreff Datum Seite Anlage Kündigung Ferien Probezeit Arbeitszeit Arzt Ärztin ' +
    'Contract Employer Employee Salary Invoice Subject Date Page Section Article Artikel Absatz Ziffer'
  ).split(' '),
);

/** Excerpt around a span, with already-detected entities masked so less PII leaves the browser. */
function contextAround(text: string, start: number, end: number, accepted: Entity[], radius = 120): string {
  const s = Math.max(0, start - radius);
  const e = Math.min(text.length, end + radius);
  let out = '';
  let pos = s;
  for (const ent of accepted) {
    if (ent.end <= s || ent.start >= e) continue;
    out += text.slice(pos, Math.max(pos, ent.start)) + `[${ent.type}]`;
    pos = Math.max(pos, ent.end);
  }
  out += text.slice(pos, e);
  return (s > 0 ? '…' : '') + out.replace(/\s+/g, ' ') + (e < text.length ? '…' : '');
}

/**
 * Spans that regex + NER did not confidently label but that look like they might be PII.
 * These are sent to the classifier (Jev) for a typed decision.
 */
export function findCandidates(text: string, accepted: Entity[], lowConfidence: Entity[], max = 60): Candidate[] {
  const out: Candidate[] = [];
  const seen = new Set<string>();
  const sortedAccepted = [...accepted].sort((a, b) => a.start - b.start);
  const add = (start: number, end: number, hint?: EntityType) => {
    let value = text.slice(start, end);
    const trimmed = value.replace(/[\s.,;:]+$/, '');
    end = start + trimmed.length;
    value = trimmed;
    if (value.length < 2 || overlapsAny(start, end, accepted)) return;
    if (out.some((c) => start < c.end && c.start < end)) return;
    const words = value.split(/[\s-]+/);
    if (words.every((w) => STOP.has(w))) return;
    const key = value.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ start, end, text: value, context: contextAround(text, start, end, sortedAccepted), hint });
  };

  for (const e of lowConfidence) add(e.start, e.end, e.type);
  for (const m of text.matchAll(HONORIFIC)) {
    const name = m[1];
    const s = m.index! + m[0].indexOf(name);
    add(s, s + name.length, 'PERSON');
  }
  for (const m of text.matchAll(CODE)) add(m.index!, m.index! + m[0].length, 'ID_NUMBER');
  for (const m of text.matchAll(CAP_SEQ)) {
    // strip leading stop words ("Die Helvetia Versicherung" → "Helvetia Versicherung")
    let s = m.index!;
    let v = m[0];
    let first: string;
    while (STOP.has((first = v.split(/[ \t-]+/)[0]))) {
      const rest = v.slice(first.length).replace(/^[ \t-]+/, '');
      s += v.length - rest.length;
      v = rest;
    }
    if (!/[ \t-]/.test(v) || /-Nr$/.test(v)) continue;
    add(s, s + v.length);
  }
  return out.slice(0, max);
}
