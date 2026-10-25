// Personal gazetteer: people and organisations that appear with high confidence in the user's own vault
// documents. A client named in last month's file is then caught in today's one-line prompt, even in lowercase
// or without context ("can you draft a reply to meier gmbh?"). Built locally during vault preparation; never sent.
import { isRoleOrPronoun } from './filters';
import { isPublicTerm } from './public-terms';
import type { Entity, EntityType } from './types';

export interface KnownValue {
  value: string;
  type: EntityType;
  /** In how many documents it was found. */
  docs: number;
}

const GAZ_TYPES = new Set<EntityType>(['PERSON', 'ORG']);
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Collect confident PERSON / ORG values from prepared documents (rules, manual marks, or model score ≥ minScore). */
export function buildGazetteer(docs: { entities: Entity[] }[], minScore = 0.9, max = 5000): KnownValue[] {
  const seen = new Map<string, KnownValue>();
  for (const d of docs) {
    const inDoc = new Set<string>();
    for (const e of d.entities) {
      if (!GAZ_TYPES.has(e.type)) continue;
      if (e.source !== 'regex' && e.source !== 'manual' && e.score < minScore) continue;
      const value = e.text.trim().replace(/\s+/g, ' ');
      // Single words are too ambiguous out of context ("Rose", "Weber"): only multi-word names and orgs.
      if (value.length < 5 || !/\s/.test(value) || isRoleOrPronoun(value) || isPublicTerm(value)) continue;
      const key = `${e.type}:${value.toLowerCase()}`;
      if (inDoc.has(key)) continue;
      inDoc.add(key);
      const k = seen.get(key) ?? { value, type: e.type, docs: 0 };
      k.docs++;
      seen.set(key, k);
    }
  }
  return [...seen.values()].sort((a, b) => b.docs - a.docs || b.value.length - a.value.length).slice(0, max);
}

/** Find gazetteer values in a text (case-insensitive, whole words; longest first so "Anna Meier AG" beats "Anna Meier"). */
export function detectKnown(text: string, known: KnownValue[]): Entity[] {
  const out: Entity[] = [];
  const sorted = [...known].sort((a, b) => b.value.length - a.value.length);
  for (const k of sorted) {
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(k.value).replace(/ /g, '\\s+')}(?![\\p{L}\\p{N}])`, 'giu');
    for (const m of text.matchAll(re)) {
      const start = m.index!;
      const end = start + m[0].length;
      if (out.some((e) => start < e.end && e.start < end)) continue;
      out.push({ start, end, text: m[0], type: k.type, source: 'regex', score: 0.97 });
    }
  }
  return out;
}
