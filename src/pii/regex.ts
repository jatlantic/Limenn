import { detectFinancial, type FinancialPolicy } from './finance';
import { detectHealth } from './health';
import { detectAddresses, detectDates, detectIds, detectPeopleAndOrgs } from './structured';
import type { Entity, EntityType } from './types';

interface Rule {
  type: EntityType;
  re: RegExp;
  /** Optional checksum / sanity validation on the matched text. */
  validate?: (m: string) => boolean;
  /** Use a capture group instead of the whole match. */
  group?: number;
}

const digits = (s: string) => s.replace(/\D/g, '');

export function luhn(num: string): boolean {
  const d = digits(num);
  if (d.length < 13 || d.length > 19) return false;
  let sum = 0;
  for (let i = 0; i < d.length; i++) {
    let n = +d[d.length - 1 - i];
    if (i % 2 === 1) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
  }
  return sum % 10 === 0;
}

export function ibanValid(raw: string): boolean {
  const s = raw.replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(s)) return false;
  const re = s.slice(4) + s.slice(0, 4);
  let rem = 0;
  for (const ch of re) {
    const v = ch >= 'A' ? (ch.charCodeAt(0) - 55).toString() : ch;
    for (const c of v) rem = (rem * 10 + +c) % 97;
  }
  return rem === 1;
}

/** Swiss AHV/AVS number 756.XXXX.XXXX.XX with EAN-13 check digit. */
export function ahvValid(raw: string): boolean {
  const d = digits(raw);
  if (d.length !== 13 || !d.startsWith('756')) return false;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += +d[i] * (i % 2 === 0 ? 1 : 3);
  return (10 - (sum % 10)) % 10 === +d[12];
}

// Standards, products and units that look like codes: ISO27001, COVID-19, SHA256, H264, RTX4090, Q2-2023
const CODE_WORDS = /^(?:ISO|DIN|IEC|EN|RFC|CVE|ECLI|COVID|SARS|SHA|MD5|UTF|H26|RTX|GTX|GPT|DDR|USB|PCIE|LTE|ART|RSA|AES|TLS|Q[1-4]-|FY|CHF|EUR|USD|GBP)/;

// Codes that identify banks, securities or message formats rather than people, and timestamps:
// CH-8001 (postcode) · DEUTDEFF500 (BIC) · DE0008471021 (ISIN) · MT202COV (SWIFT) · 2022-02-16T10
const NOT_PERSONAL_CODE = /^(?:[A-Z]{1,2}-\d{4,5}|[A-Z]{6}[A-Z0-9]{2}(?:[A-Z0-9]{3})?|[A-Z]{2}[A-Z0-9]{9}\d|MT\d{3}[A-Z]*|\d{4}-\d{2}-\d{2}T\d{2})$/;
const MONTHS =
  'Jan(?:uar|uary)?|Feb(?:ruar|ruary)?|Mär(?:z)?|Mar(?:ch)?|Apr(?:il)?|Mai|May|Jun(?:i|e)?|Jul(?:i|y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Okt(?:ober)?|Oct(?:ober)?|Nov(?:ember)?|Dez(?:ember)?|Dec(?:ember)?';

const L = "A-Za-zÄÖÜäöüßéèàç"; // letters incl. umlauts/accents
const ADDRESS_RES = [
  // compound German street names: "Bahnhofstrasse 12", "Rosenweg 3a"
  `[A-ZÄÖÜ][${L}-]*(?:strasse|straße|str\\.|gasse|weg|platz|allee|ring|rain|halde|graben)\\s\\d{1,4}[a-z]?`,
  // separate-word: "Sankt Leonhard Strasse 5", "Lake Road 12"
  `(?:[A-ZÄÖÜ][${L}-]+\\s){1,2}(?:Strasse|Straße|Street|Road|Avenue|Lane|Drive)\\s\\d{1,4}[a-z]?`,
  // English number-first: "221B Baker Street"
  `\\d{1,4}[A-Za-z]?\\s(?:[A-Z][${L}-]+\\s){1,2}(?:Street|St\\.|Road|Rd\\.|Avenue|Ave\\.|Lane|Drive|Boulevard|Blvd\\.)`,
  // French/Italian: "Rue du Lac 4", "Via Cantonale 10"
  `(?:Rue|Avenue|Chemin|Route|Via)\\s(?:de la |du |des |de |d'|della )?[A-ZÄÖÜ][${L}-]+\\s\\d{1,4}[a-z]?`,
];

const RULES: Rule[] = [
  // Unicode letters on both sides of the @: "hadivià@aol.com", "info@societe-expédition.fr"
  { type: 'EMAIL', re: /(?<![\p{L}\p{N}._%+-])[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.\p{L}{2,}(?![\p{L}\p{N}])/gu },
  // Standards and schema hosts (XML namespaces, schema locations) are not personal: w3.org, schemas.*, purl.org …
  { type: 'URL', re: /\bhttps?:\/\/[^\s<>"')\]]+/g, validate: (m) => !/^https?:\/\/(?:www\.)?(?:w3\.org|schemas\.[^/]+|purl\.org|fpml\.org|xmlns\.[^/]+|json-schema\.org|ietf\.org|iso\.org|schema\.org|ogp\.me|example\.(?:com|org|net))(?:\/|$)/i.test(m) },
  // Personal profiles without a scheme: linkedin.com/in/…, github.com/…, www.anna-meier.ch
  { type: 'URL', re: /\b(?:www\.)?(?:linkedin\.com\/in|github\.com|gitlab\.com|xing\.com\/profile|behance\.net|instagram\.com|x\.com|twitter\.com|facebook\.com)\/[A-Za-z0-9_.%-]+\/?/g },
  { type: 'URL', re: /\bwww\.[a-z0-9]+(?:-[a-z0-9]+)+\.[a-z]{2,6}(?:\/[^\s<>"')\]]*)?/g },
  { type: 'IBAN', re: /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?\b/g, validate: ibanValid },
  // A labelled IBAN is personal even when its check digits are wrong (typos, sample data): "IBAN: DE12 3456 7890 …"
  { type: 'IBAN', re: /\bIBAN\)?\s?[:#]?\s*([A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){1,7}(?: ?[A-Z0-9]{1,4})?)\b/g, group: 1 },
  { type: 'NATIONAL_ID', re: /\b756[.\s]?\d{4}[.\s]?\d{4}[.\s]?\d{2}\b/g, validate: ahvValid },
  // Written with separators, 756.XXXX.XXXX.XX is unmistakably an AHV number, even with a wrong check digit.
  { type: 'NATIONAL_ID', re: /\b756([.-])\d{4}\1\d{4}\1\d{2}\b/g },
  { type: 'NATIONAL_ID', re: /\b\d{3}-\d{2}-\d{4}\b/g }, // US SSN
  { type: 'CREDIT_CARD', re: /\b(?:\d[ -]?){12,18}\d\b/g, validate: luhn },
  // Card-shaped groups count without the Luhn check: 4532 1187 6548 3951 · 3756 123456 78901 · 3494-4142-6960-097
  { type: 'CREDIT_CARD', re: /(?<![\d.,-])[2-6]\d{3}([ -])\d{4}\1\d{4}\1\d{3,4}(?![\d-]|[.,]\d)/g },
  { type: 'CREDIT_CARD', re: /(?<![\d.,-])3\d{3}([ -])\d{6}\1\d{5}(?![\d-]|[.,]\d)/g },
  // …and so does any 12–19-digit number right after a card label: "Numero Carta: 1234 5678 9012 3456"
  {
    type: 'CREDIT_CARD',
    re: /(?:card|Karte|Kreditkarte|carte|carta|tarjeta|Visa|Mastercard|Amex|CC)(?:[ \t]?(?:number|nummer|nr\.?|no\.?|numéro|numero|n°))?[^\n\d]{0,12}?((?:\d[ -]?){11,18}\d)(?![\d-])/gi,
    group: 1,
  },
  {
    type: 'PHONE',
    // +41 79 123 45 67, 0041 44 ..., 079 123 45 67, +49 (0)30 1234567, (555) 123-4567
    re: /(?<![\w.])(?:(?:\+|00)\d{1,3}[\s./-]?(?:\(0\)[\s./-]?)?|0)(?:\(?\d{1,4}\)?[\s./-]?){2,5}\d{2,4}(?!\w|\.\d)|\(\d{3}\)\s?\d{3}-\d{4}\b|\b\d{3}[-.]\d{3}[-.]\d{4}\b/g,
    validate: (m) => {
      const n = digits(m).length;
      return n >= 9 && n <= 15;
    },
  },
  { type: 'IP', re: /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g },
  { type: 'IP', re: /\b(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}\b/g },
  // compressed IPv6: 2001:db8::1, fe80::1ff:fe23:4567:890a
  { type: 'IP', re: /(?<![\w:])(?:[0-9a-fA-F]{1,4}:){1,6}:(?:[0-9a-fA-F]{1,4}(?::[0-9a-fA-F]{1,4}){0,5})?(?![\w:])/g, validate: (m) => /[0-9a-fA-F]{3}/.test(m) && m.includes('::') },
  { type: 'DATE', re: /\b(?:0?[1-9]|[12]\d|3[01])[./-](?:0?[1-9]|1[0-2])[./-](?:19|20)\d{2}\b/g },
  { type: 'DATE', re: /\b(?:19|20)\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])\b/g },
  { type: 'DATE', re: new RegExp(`\\b(?:0?[1-9]|[12]\\d|3[01])\\.?\\s(?:${MONTHS})\\.?\\s(?:19|20)\\d{2}\\b`, 'g') },
  { type: 'DATE', re: new RegExp(`\\b(?:${MONTHS})\\.?\\s(?:0?[1-9]|[12]\\d|3[01])(?:st|nd|rd|th)?,?\\s(?:19|20)\\d{2}\\b`, 'g') },
  { type: 'ADDRESS', re: new RegExp(`(?<![${L}0-9])(?:${ADDRESS_RES.join('|')})(?![${L}0-9])`, 'g') },
  {
    type: 'POSTAL_CODE',
    // CH/AT 4-digit or DE 5-digit followed by a capitalised place name: "8001 Zürich", "CH-9000 St. Gallen"
    re: /\b(?:(?:CH|D|DE|A|AT)-)?\d{4,5}[ \t](?:St\.[ \t])?[A-ZÄÖÜ][a-zäöüéè]+(?:[ \t][A-ZÄÖÜ][a-zäöüéè]+)?(?![\p{L}])/gu,
  },
  // Long digit runs are identifiers (account, customer, tax numbers) when they are not amounts, phones or dates.
  { type: 'ID_NUMBER', re: /(?<![\p{L}\p{N}.,'’/+-])\d{9,19}(?![\p{L}\p{N}]|[.,'’]\d)/gu },
  // UUIDs and device/user identifiers: e4a8e5b2-5c3d-497f-9d2c-1b66c4b923a1 · a2b4c6d8e0f2a4b6c8d0e2f4a6b8c0d2
  { type: 'ID_NUMBER', re: /\b[0-9a-z]{8}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{12}\b/gi },
  {
    type: 'ID_NUMBER',
    re: /(?<![\p{L}\p{N}])[0-9a-z]{16,}(?![\p{L}\p{N}])/gu,
    validate: (m) => (m.match(/\d/g) ?? []).length >= 4 && (m.match(/[a-z]/g) ?? []).length >= 4,
  },
  // Upper-case codes mixing letters and digits: D9QCBRN6LB · BW95664TX · H2347624 · C64-5447-393 · ENG-NY-20230849
  {
    type: 'ID_NUMBER',
    re: /(?<![\p{L}\p{N}\-/.])[A-Z0-9]{1,20}(?:-[A-Z0-9]{2,10}){0,4}(?![\p{L}\p{N}]|-\w)/gu,
    validate: (m) => {
      const d = (m.match(/\d/g) ?? []).length;
      const l = (m.match(/[A-Z]/g) ?? []).length;
      if (!l || !d || CODE_WORDS.test(m) || NOT_PERSONAL_CODE.test(m)) return false;
      return m.includes('-') ? d >= 4 && m.length >= 7 : d >= 2 && l >= 1 && m.length >= 8 && !/^[A-Z]+\d{1,2}$/.test(m);
    },
  },
  // Licence plates after a label: "license plate K4R-278", "Kennzeichen ZH 123456", "plaque VD 4521"
  { type: 'ID_NUMBER', re: /\b(?:license|licence)[ \t]plate(?:[ \t]number)?[ \t:*]*([A-Z0-9]{1,4}(?:[ -][A-Z0-9]{1,4}){1,4})\b/gi, group: 1 },
  // ECHR-style application numbers: "application no. 32340/96", "(47676/99)"
  { type: 'ID_NUMBER', re: /(?<![\p{N}/.])\d{4,6}\/(?:\d{2}|(?:19|20)\d{2})(?![\p{N}/])/gu },
  {
    type: 'ID_NUMBER',
    // labelled identifiers: "Patient-Nr. 48213", "Policy No: AB-1234-XY", "Kundennummer 99812"
    re: /\b(?:(?:Patienten|Patient|Kunden|Versicherten|Mitarbeiter|Personal|Policen|Vertrags|Fall|Akten|Konto|Customer|Policy|Case|Account|Member|Employee|Passport|Pass|Steuer|Tax|User|Device|Medical[ \t]Record|Record|Driver'?s?[ \t]License|License|Licence|Certificate|National)[-\s_]?(?:nummer|nr\.?|no\.?|number|identifier|id|ID)|MRN|SSN)(?![\p{L}])[:\s#*|"'=]*([A-Z0-9][A-Z0-9-/.]{3,})/giu,
    group: 1,
    validate: (m) => /\d/.test(m), // "| Employee ID | Name |" is a table header
  },
];

// Self-introductions catch names even when typed in lowercase ("my name is max mustermann"),
// which the cased BERT model misses.
const NAME_INTRO =
  /\b(?:my name is|my name's|i am called|i'm called|call me|named|mein name ist|ich heisse|ich heiße|mein name lautet|je m'appelle|mon nom est|mi chiamo|il mio nome è)\s+((?:[\p{L}][\p{L}'-]+)(?:\s+[\p{L}][\p{L}'-]+){0,2})/giu;
const NAME_STOP = new Set(
  'and und et e or oder from aus von de da di at in bei with mit i ich je io tell me him her his ihm ihr sein about über and, but aber please bitte is ist am bin was war the der die das le la il'.split(' '),
);

function detectNameIntros(text: string): Entity[] {
  const out: Entity[] = [];
  for (const m of text.matchAll(NAME_INTRO)) {
    const words = m[1].split(/\s+/);
    const keep: string[] = [];
    for (const w of words) {
      if (NAME_STOP.has(w.toLowerCase())) break;
      keep.push(w);
    }
    if (!keep.length) continue;
    const value = keep.join(' ');
    const start = m.index! + m[0].length - m[1].length;
    out.push({ start, end: start + value.length, text: value, type: 'PERSON', source: 'regex', score: 0.95 });
  }
  return out;
}

export function detectRegex(text: string, opts: { financialPolicy?: FinancialPolicy } = {}): Entity[] {
  const out: Entity[] = [
    ...detectNameIntros(text),
    ...detectDates(text),
    ...detectIds(text),
    ...detectPeopleAndOrgs(text),
    ...detectAddresses(text),
    ...detectHealth(text),
    ...detectFinancial(text, opts.financialPolicy),
  ];
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    for (const m of text.matchAll(rule.re)) {
      let value = m[0];
      let start = m.index!;
      if (rule.group) {
        const g = m[rule.group];
        if (!g) continue;
        start += m[0].lastIndexOf(g);
        value = g;
      }
      value = value.replace(/[.,;:]+$/, '');
      if (rule.validate && !rule.validate(value)) continue;
      out.push({ start, end: start + value.length, text: value, type: rule.type, source: 'regex', score: 1 });
    }
  }
  return out;
}
