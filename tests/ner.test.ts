import { describe, expect, it } from 'vitest';
import { chunkText, groupTokens } from '../src/pii/ner';

describe('groupTokens', () => {
  it('aligns wordpieces and groups BIO tags into spans', () => {
    const text = 'Frau Anna Meier-Zürcher arbeitet bei Helvetia in St. Gallen.';
    const tok = (word: string, entity = 'O', score = 0.99) => ({ word, entity, score });
    const tokens = [
      tok('Frau'), tok('Anna', 'B-PER'), tok('Meier', 'I-PER'), tok('-', 'I-PER'), tok('Z', 'I-PER'), tok('##ür', 'I-PER'), tok('##cher', 'I-PER'),
      tok('arbeitet'), tok('bei'), tok('He', 'B-ORG'), tok('##lve', 'I-ORG'), tok('##tia', 'O'), tok('in'),
      tok('St', 'B-LOC'), tok('.', 'I-LOC'), tok('Gallen', 'I-LOC'), tok('.'),
    ];
    const ents = groupTokens(text, tokens, 100);
    expect(ents.map((e) => [e.type, e.text, e.start])).toEqual([
      ['PERSON', 'Anna Meier-Zürcher', 105],
      ['ORG', 'Helvetia', 137],
      ['LOCATION', 'St. Gallen', 149],
    ]);
  });
  it('does not join entities across newlines', () => {
    const text = 'Anhang\nKlinik Hirslanden';
    const ents = groupTokens(text, [
      { word: 'Anhang', entity: 'B-ORG', score: 0.9 },
      { word: 'Klinik', entity: 'I-ORG', score: 0.9 },
      { word: 'Hirslanden', entity: 'I-ORG', score: 0.9 },
    ]);
    expect(ents.map((e) => e.text)).toEqual(['Anhang', 'Klinik Hirslanden']);
  });
});

describe('chunkText', () => {
  it('covers the whole text without overlap', () => {
    const text = Array.from({ length: 200 }, (_, i) => `Sentence number ${i} is here.`).join(' ');
    const chunks = chunkText(text, 500);
    expect(chunks.map((c) => c.text).join('')).toBe(text);
    expect(chunks.every((c) => c.text.length <= 500)).toBe(true);
  });
});
