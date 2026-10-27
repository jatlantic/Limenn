// The user's own "always protect" list: fixed words/phrases and simple shapes such as EMP-##### that the detectors
// don't know. Stored only on this device (see shared/storage.ts); every match becomes a 'manual' entity, which wins
// over all other detections in mergeEntities.
//
// Shape syntax:  #  one digit        A  one letter        *  any characters inside one word (at most 2)
//                a space matches any run of whitespace; everything else is literal and case-insensitive.
import type { Entity, EntityType } from './types';

export interface ProtectedRule {
  id: string;
  kind: 'words' | 'shape';
  value: string;
  type: EntityType;
  addedAt: number;
}

export const MAX_SHAPE_LENGTH = 64;
const MAX_STARS = 2;
/** Characters `*` may cover: anything inside a word or an e-mail address, not brackets, quotes or sentence marks. */
const STAR_CHAR = `[^\\s()<>\\[\\]{}"'«»“”‘’,;:!?]`;
const STAR = `${STAR_CHAR}{0,40}?`;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isWordChar = (c: string) => /[\p{L}\p{N}]/u.test(c);

/** Whitespace-normalised value as stored ("Anna   Meier\n" → "Anna Meier"). */
export const normalizeValue = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Typed text looks like a shape (has a digit/any slot) rather than plain words. */
export const looksLikeShape = (s: string) => /[#*]/.test(s);

/** Why a shape can't be used, or undefined when it is fine. Broad shapes would redact half of every text. */
export function validateShape(shape: string): string | undefined {
  const s = normalizeValue(shape);
  if (!s) return 'Enter a pattern.';
  if (s.length > MAX_SHAPE_LENGTH) return `Patterns can be at most ${MAX_SHAPE_LENGTH} characters long.`;
  if ((s.match(/\*/g) ?? []).length > MAX_STARS) return `Use * at most ${MAX_STARS} times.`;
  const slots = (s.match(/[#A]/g) ?? []).length;
  const literals = s.replace(/[#A* ]/g, '').length;
  if (!slots && !s.includes('*')) return 'A pattern needs # (digit), A (letter) or * (any characters); add plain words as words instead.';
  if (!literals && slots < 6) return 'Too broad: add a fixed part (like EMP- or @acme.ch) or use at least 6 # / A.';
  if (literals + slots < 3) return 'Too broad: make the pattern longer.';
  return undefined;
}

/** Regex for a valid shape (throws on an invalid one). */
export function compileShape(shape: string): RegExp {
  const err = validateShape(shape);
  if (err) throw new Error(err);
  const s = normalizeValue(shape);
  let body = '';
  for (const c of s) {
    if (c === '#') body += '\\p{Nd}';
    else if (c === 'A') body += '\\p{L}';
    else if (c === '*') body += STAR;
    else if (c === ' ') body += '\\s+';
    else body += escapeRe(c);
  }
  return new RegExp(`${boundaryBefore(s[0])}${body}${boundaryAfter(s[s.length - 1])}`, 'giu');
}

/** Regex for a word or phrase: whole words, any case, any whitespace between the words (PDF line breaks). */
export function compileWords(value: string): RegExp {
  const v = normalizeValue(value);
  const body = v.split(' ').map(escapeRe).join('\\s+');
  return new RegExp(`${boundaryBefore(v[0])}${body}${boundaryAfter(v[v.length - 1])}`, 'giu');
}

// A match may not start or end in the middle of a word ("Meier" doesn't match inside "Meierhof").
function boundaryBefore(first: string) {
  if (first === '*') return `(?<!${STAR_CHAR})`;
  return isWordChar(first) || first === '#' ? '(?<![\\p{L}\\p{N}])' : '';
}
function boundaryAfter(last: string) {
  if (last === '*') return `(?!${STAR_CHAR})`;
  return isWordChar(last) || last === '#' ? '(?![\\p{L}\\p{N}])' : '';
}

/**
 * The shape of an example value: digits become #, letters stay ("EMP-20431" → "EMP-#####"). An e-mail address
 * becomes "*@domain". Undefined when the value has no digits and no @ (then only the words themselves make sense).
 */
export function deriveShape(value: string): string | undefined {
  const v = normalizeValue(value);
  const email = v.match(/^[^\s@]+(@[\p{L}\p{N}.-]+\.\p{L}{2,})$/u);
  if (email) return `*${email[1]}`;
  if (!/\p{Nd}/u.test(v)) return undefined;
  const shape = v.replace(/\p{Nd}/gu, '#');
  return validateShape(shape) ? undefined : shape;
}

/** A sensible placeholder type for a value the user picked. */
export function guessType(value: string): EntityType {
  const v = normalizeValue(value);
  if (/@/.test(v)) return 'EMAIL';
  if (/^\+?[\d\s()/.-]{7,}$/.test(v)) return 'PHONE';
  if (/\d/.test(v) || /#/.test(v)) return 'ID_NUMBER';
  if (/^(\p{Lu}[\p{L}'’-]+)(\s\p{Lu}[\p{L}'’-]+){1,3}$/u.test(v)) return 'PERSON';
  return 'ORG';
}

const cache = new Map<string, RegExp>();
function regexFor(rule: Pick<ProtectedRule, 'kind' | 'value'>): RegExp | undefined {
  const key = `${rule.kind}\u0000${rule.value}`;
  let re = cache.get(key);
  if (!re) {
    try {
      re = rule.kind === 'shape' ? compileShape(rule.value) : compileWords(rule.value);
    } catch {
      return undefined; // an invalid stored rule (e.g. imported) is skipped, never fatal
    }
    if (cache.size > 500) cache.clear();
    cache.set(key, re);
  }
  return re;
}

/** Every occurrence of every rule in `text`, as manual entities (overlaps are resolved later by mergeEntities). */
export function customEntities(text: string, rules: readonly Pick<ProtectedRule, 'kind' | 'value' | 'type'>[]): Entity[] {
  const out: Entity[] = [];
  for (const rule of rules) {
    if (normalizeValue(rule.value).length < 2) continue;
    const re = regexFor(rule);
    if (!re) continue;
    for (const m of text.matchAll(re)) {
      let match = m[0];
      // A trailing * must not swallow the end of the sentence ("ref EMP-* ." → keep the period out).
      if (rule.kind === 'shape' && rule.value.trimEnd().endsWith('*')) match = match.replace(/[.\-_]+$/, '');
      if (!match) continue;
      out.push({ start: m.index!, end: m.index! + match.length, text: match, type: rule.type, source: 'manual', score: 1 });
    }
  }
  return out;
}

/** Older versions stored manual marks as [value, type] pairs; those become word rules. */
export const wordsRules = (pairs: readonly [string, EntityType][]): Pick<ProtectedRule, 'kind' | 'value' | 'type'>[] =>
  pairs.map(([value, type]) => ({ kind: 'words', value, type }));

/** New rule with a fresh id. */
export function makeRule(kind: ProtectedRule['kind'], value: string, type: EntityType): ProtectedRule {
  return { id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, kind, value: normalizeValue(value), type, addedAt: Date.now() };
}

/** Same rule (kind + value, ignoring case and whitespace)? Used to de-duplicate adds and imports. */
export const sameRule = (a: Pick<ProtectedRule, 'kind' | 'value'>, b: Pick<ProtectedRule, 'kind' | 'value'>) =>
  a.kind === b.kind && normalizeValue(a.value).toLowerCase() === normalizeValue(b.value).toLowerCase();

const TYPES: EntityType[] = ['PERSON', 'ORG', 'LOCATION', 'ADDRESS', 'EMAIL', 'PHONE', 'IBAN', 'CREDIT_CARD', 'NATIONAL_ID', 'ID_NUMBER', 'DATE', 'IP', 'URL', 'POSTAL_CODE', 'HEALTH', 'FINANCIAL'];

/** Parse an exported file (or anything else) into valid rules; invalid entries are dropped. */
export function parseRules(json: unknown): ProtectedRule[] {
  const list = Array.isArray(json) ? json : Array.isArray((json as { rules?: unknown })?.rules) ? (json as { rules: unknown[] }).rules : [];
  const out: ProtectedRule[] = [];
  for (const r of list as Partial<ProtectedRule>[]) {
    if (!r || (r.kind !== 'words' && r.kind !== 'shape') || typeof r.value !== 'string') continue;
    const value = normalizeValue(r.value);
    if (value.length < 2 || value.length > 200 || (r.kind === 'shape' && validateShape(value))) continue;
    const type = TYPES.includes(r.type as EntityType) ? (r.type as EntityType) : guessType(value);
    if (out.some((o) => sameRule(o, { kind: r.kind!, value }))) continue;
    out.push({ ...makeRule(r.kind, value, type), ...(typeof r.addedAt === 'number' ? { addedAt: r.addedAt } : {}) });
  }
  return out;
}

export const ENTITY_TYPES = TYPES;
