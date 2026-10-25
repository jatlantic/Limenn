import { describe, expect, it } from 'vitest';
import { redact } from '../src/pii/pipeline';
import { DEFAULT_SETTINGS } from '../src/pii/types';
import { Vault } from '../src/pii/vault';

const settings = { ...DEFAULT_SETTINGS, enableNer: false };

describe('redact', () => {
  it('redacts regex PII and restores it exactly', async () => {
    const vault = new Vault();
    const text = 'Write to anna@example.ch, IBAN CH93 0076 2011 6238 5295 7, phone +41 79 123 45 67.';
    const r = await redact(text, { settings: { ...settings, enableJev: false }, vault });
    expect(r.clean).toBe('Write to [EMAIL-1], IBAN [IBAN-1], phone [PHONE-1].');
    expect(vault.restore(r.clean)).toBe(text);
  });

  it('respects the allow list', async () => {
    const r = await redact('Hi Claude, mail a@b.ch', { settings: { ...settings, enableJev: false }, vault: new Vault(), allow: new Set(['a@b.ch']) });
    expect(r.clean).toBe('Hi Claude, mail a@b.ch');
  });
});

describe('propagation', () => {
  const s = { ...DEFAULT_SETTINGS, enableNer: false, enableJev: false };
  it('catches a known name in other casing', async () => {
    const vault = new Vault();
    await redact('From: Steven Murphy <s@x.ch>', { settings: s, vault });
    const r = await redact('hi again, steven murphy here', { settings: s, vault });
    expect(r.clean).toContain('[PERSON-1]');
  });
  it('does not turn common words into surnames', async () => {
    const vault = new Vault();
    await redact('From: Anna Wolf <a@x.ch>', { settings: s, vault });
    const r = await redact('Der Wolf im Wald. Herr Wolf kommt.', { settings: s, vault });
    expect(r.clean).toContain('Der Wolf im Wald');
    expect(r.clean).toContain('Herr [PERSON-1-SURNAME]');
  });
});

describe('model gate and ensemble', () => {
  it('drops roles and pronouns from model hits, keeps names', async () => {
    const { passesProperNounGate, isRoleOrPronoun } = await import('../src/pii/filters');
    for (const r of ['the applicant', 'The second applicant', 'She', 'the Government', 'die Beschwerdeführerin', 'Ministry of Foreign Affairs', 'la requérante'])
      expect(isRoleOrPronoun(r)).toBe(true);
    for (const n of ['Anna Meier', 'Justice Nourse', 'Helvetia']) expect(isRoleOrPronoun(n)).toBe(false);
    const mk = (text: string, start: number) => ({ start, end: start + text.length, text, type: 'PERSON' as const, source: 'ner' as const, score: 0.9 });
    // In normally capitalised text a lowercase model hit is a common word ("winter"), not a name …
    const a = 'Anna Meier signed the Report in Zürich after the winter break.';
    expect(passesProperNounGate(mk('winter', a.indexOf('winter')), a)).toBe(false);
    // … but chat lines, self-introductions and text typed all in lowercase keep lowercase names.
    const b = '[09:01] Customer: hi, john smith here';
    expect(passesProperNounGate(mk('john smith', b.indexOf('john')), b)).toBe(true);
    const c = 'Please draft this. I am maria keller from Basel.';
    expect(passesProperNounGate(mk('maria keller', c.indexOf('maria')), c)).toBe(true);
    const d = 'i need a settlement letter for john smith and his landlord';
    expect(passesProperNounGate(mk('john smith', d.indexOf('john')), d)).toBe(true);
    const f = 'summarise this scanned letter, including who wrote it and to whom';
    expect(passesProperNounGate(mk('who wrote it', f.indexOf('who')), f)).toBe(false);
  });
  it('accepts agreement and confident single-model spans, defers the rest', async () => {
    const { combineModels, DEFAULT_ENSEMBLE } = await import('../src/pii/ensemble');
    const e = (start: number, end: number, type: any, score: number) => ({ start, end, text: 'x', type, source: 'ner' as const, score });
    const token = [e(0, 10, 'PERSON', 0.6), e(20, 30, 'ORG', 0.95)];
    const span = [e(0, 12, 'PERSON', 0.4), e(40, 50, 'DATE', 0.7), e(60, 70, 'ID_NUMBER', 0.35)];
    const r = combineModels(token, span, { ...DEFAULT_ENSEMBLE, spanHigh: {}, spanHighDefault: 0.5 });
    expect(r.accepted.map((x) => [x.start, x.end, x.type])).toEqual([[0, 10, 'PERSON'], [40, 50, 'DATE'], [20, 30, 'ORG']]);
    expect(r.uncertain.map((x) => x.type)).toEqual(['ID_NUMBER']);
  });
});
