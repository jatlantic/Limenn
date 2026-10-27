import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyDoc, docId, loadDoc, scanVault } from '../src/docvault/cache';
import { nodeVaultFs } from '../src/docvault/node-fs';
import { compileShape, customEntities, deriveShape, guessType, looksLikeShape, makeRule, parseRules, sameRule, validateShape, wordsRules } from '../src/pii/custom';
import { passesLowercaseNameGate } from '../src/pii/filters';
import { joinNameParts } from '../src/pii/merge';
import { capitalizeLowercaseWords, redact } from '../src/pii/pipeline';
import { DEFAULT_SETTINGS, type EntityType } from '../src/pii/types';
import { Vault } from '../src/pii/vault';

const settings = { ...DEFAULT_SETTINGS, enableNer: false, enableJev: false };
const words = (value: string, type: EntityType = 'ORG') => ({ kind: 'words' as const, value, type });
const shape = (value: string, type: EntityType = 'ID_NUMBER') => ({ kind: 'shape' as const, value, type });
const found = (text: string, rules: Parameters<typeof customEntities>[1]) => customEntities(text, rules).map((e) => e.text);

describe('shapes', () => {
  it('derives a shape from an example value', () => {
    expect(deriveShape('EMP-20431')).toBe('EMP-#####');
    expect(deriveShape('P-2024-117')).toBe('P-####-###');
    expect(deriveShape('anna.meier@acme.ch')).toBe('*@acme.ch');
    expect(deriveShape('Anna Meier')).toBeUndefined(); // no digits: protect the words themselves
    expect(deriveShape('12')).toBeUndefined(); // too broad
  });

  it('rejects shapes that would match almost anything', () => {
    for (const s of ['*', '**', '##', '#####', 'A*', '* *', '***x']) expect(validateShape(s), s).toBeTruthy();
    for (const s of ['EMP-#####', '*@acme.ch', '######', 'P-####-AA', 'AHV 756.####.####.##']) expect(validateShape(s), s).toBeUndefined();
    expect(validateShape('E' + '#'.repeat(70))).toMatch(/at most/);
    expect(() => compileShape('*')).toThrow();
  });

  it('matches whole values only, in any case', () => {
    const r = [shape('EMP-#####')];
    expect(found('ids EMP-20431, emp-99812 and EMP-123456 or XEMP-11111', r)).toEqual(['EMP-20431', 'emp-99812']);
  });

  it('A is one letter, * stays inside one word, a space matches any whitespace', () => {
    expect(found('Ref P-2024-AB and P-2024-A1', [shape('P-####-AA')])).toEqual(['P-2024-AB']);
    expect(found('Mail (anna.meier@acme.ch), not anna@acme.com.', [shape('*@acme.ch')])).toEqual(['anna.meier@acme.ch']);
    expect(found('Nr. 756.1234.\n5678.97 und 756 1234', [shape('756.####. ####.##')])).toEqual(['756.1234.\n5678.97']);
  });

  it('a trailing * does not swallow the end of the sentence', () => {
    expect(found('see CASE-7781b.', [shape('CASE-####*')])).toEqual(['CASE-7781b']);
  });

  it('stays fast on large adversarial input', () => {
    const big = 'a'.repeat(200_000) + ' ' + 'x@'.repeat(100_000);
    const t = performance.now();
    customEntities(big, [shape('*@*.ch'), shape('**@acme.ch'.replace('**', '*')), shape('EMP-#####')]);
    expect(performance.now() - t).toBeLessThan(1500);
  });
});

describe('words', () => {
  it('matches whole words in any case and across line breaks', () => {
    const r = [words('Projekt Falke')];
    expect(found('Zu projekt  falke und Projekt\nFalke, nicht Projekt Falkenstein', r)).toEqual(['projekt  falke', 'Projekt\nFalke']);
  });

  it('works for umlauts and does not match inside words', () => {
    expect(found('Frau Müller, Müllerstrasse, müller', [words('Müller', 'PERSON')])).toEqual(['Müller', 'müller']);
  });

  it('guesses a placeholder type and tells words from shapes', () => {
    expect(guessType('Anna Meier')).toBe('PERSON');
    expect(guessType('EMP-20431')).toBe('ID_NUMBER');
    expect(guessType('a@b.ch')).toBe('EMAIL');
    expect(guessType('+41 79 123 45 67')).toBe('PHONE');
    expect(looksLikeShape('EMP-#####')).toBe(true);
    expect(looksLikeShape('Projekt Falke')).toBe(false);
  });
});

describe('in the pipeline', () => {
  it('protected words and shapes win over other detections and get consistent placeholders across texts', async () => {
    const vault = new Vault();
    const rules = [words('Projekt Falke'), shape('EMP-#####')];
    const prompt = 'Status Projekt Falke for EMP-20431, mail anna@example.ch';
    const fileA = 'EMP-20431 leads projekt falke. EMP-55555 helps.';
    const a = await redact(prompt, { settings, vault, manual: customEntities(prompt, rules) });
    const b = await redact(fileA, { settings, vault, manual: customEntities(fileA, rules) });
    expect(a.clean).toBe('Status [ORG-1] for [ID-NUMBER-1], mail [EMAIL-1]');
    expect(b.clean).toBe('[ID-NUMBER-1] leads [ORG-1]. [ID-NUMBER-2] helps.');
    // One placeholder per value whatever the case; it restores to the spelling seen first.
    expect(vault.restore(b.clean).toLowerCase()).toBe(fileA.toLowerCase());
  });

  it('"send unchanged" exempts a single value matched by a shape', async () => {
    const text = 'EMP-20431 and EMP-55555';
    const r = await redact(text, { settings, vault: new Vault(), manual: customEntities(text, [shape('EMP-#####')]), allow: new Set(['EMP-55555']) });
    expect(r.clean).toBe('[ID-NUMBER-1] and EMP-55555');
  });
});

describe('document vault', () => {
  let dir: string;
  beforeEach(async () => (dir = await mkdtemp(join(tmpdir(), 'limenn-custom-'))));
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('applies the protected list to prepared documents, together with their own review marks', async () => {
    await writeFile(join(dir, 'memo.txt'), 'Memo for EMP-20431 about Projekt Falke.\nDear client, thanks.');
    const fs = nodeVaultFs(dir);
    await scanVault(fs, { settings, extract: async (_n: string, b: Uint8Array) => ({ text: new TextDecoder().decode(b), meta: 'text' }) });
    const doc = (await loadDoc(fs, await docId('memo.txt')))!;
    doc.review = { allow: [], manual: [['Dear client', 'PERSON']] };
    const r = applyDoc(doc, new Vault(), { rules: [words('Projekt Falke'), shape('EMP-#####')] });
    expect(r.clean).toBe('Memo for [ID-NUMBER-1] about [ORG-1].\n[PERSON-1], thanks.');
  });
});

describe('import and storage helpers', () => {
  it('parses exported files, dropping invalid and duplicate entries', () => {
    const rules = parseRules({
      limenn: 'protected-list',
      rules: [
        { kind: 'words', value: 'Projekt  Falke', type: 'ORG' },
        { kind: 'words', value: 'projekt falke', type: 'ORG' },
        { kind: 'shape', value: '*', type: 'ID_NUMBER' },
        { kind: 'shape', value: 'EMP-#####', type: 'NOPE' },
        { kind: 'regex', value: '.*' },
        'junk',
      ],
    });
    expect(rules.map((r) => [r.kind, r.value, r.type])).toEqual([
      ['words', 'Projekt Falke', 'ORG'],
      ['shape', 'EMP-#####', 'ID_NUMBER'],
    ]);
    expect(parseRules('nonsense')).toEqual([]);
  });

  it('turns old manual marks into word rules and compares rules loosely', () => {
    expect(wordsRules([['Anna Meier', 'PERSON']])).toEqual([{ kind: 'words', value: 'Anna Meier', type: 'PERSON' }]);
    expect(sameRule(makeRule('words', ' anna  meier ', 'PERSON'), { kind: 'words', value: 'Anna Meier' })).toBe(true);
    expect(sameRule(makeRule('shape', 'EMP-#####', 'ID_NUMBER'), { kind: 'words', value: 'EMP-#####' })).toBe(false);
  });

  it('migrates the old manual list into the protected list once', async () => {
    const store: Record<string, unknown> = { 'limenn.manual': [['Anna Meier', 'PERSON']], 'limenn.protected': [makeRule('shape', 'EMP-#####', 'ID_NUMBER')] };
    const local = {
      get: async (keys: string | string[]) => Object.fromEntries([keys].flat().filter((k) => k in store).map((k) => [k, structuredClone(store[k])])),
      set: async (o: Record<string, unknown>) => void Object.assign(store, structuredClone(o)),
      remove: async (k: string) => void delete store[k],
    };
    (globalThis as { chrome?: unknown }).chrome = { storage: { local } };
    try {
      const { loadProtected } = await import('../src/shared/storage');
      const rules = await loadProtected();
      expect(rules.map((r) => r.value)).toEqual(['EMP-#####', 'Anna Meier']);
      expect(store['limenn.manual']).toBeUndefined();
      expect((await loadProtected()).length).toBe(2);
    } finally {
      delete (globalThis as { chrome?: unknown }).chrome;
    }
  });
});

describe('names that belong together', () => {
  const person = (text: string, t: string, source: 'ner' | 'regex' | 'manual' = 'ner', score = 1) => ({ start: text.indexOf(t), end: text.indexOf(t) + t.length, text: t, type: 'PERSON' as const, source, score });

  it('joins name parts split at a hyphen or a single space', () => {
    const text = 'Treffen mit Anna-Lena Müller-Lüdenscheidt und Hans Meier.';
    const joined = joinNameParts(text, [person(text, 'Anna-Lena Müller'), person(text, 'Lüdenscheidt'), person(text, 'Hans'), person(text, 'Meier')]);
    expect(joined.map((e) => e.text)).toEqual(['Anna-Lena Müller-Lüdenscheidt', 'Hans Meier']);
  });

  it('keeps separate people and the user’s own marks apart', () => {
    const text = 'Hans, Meier and Anna Keller';
    expect(joinNameParts(text, [person(text, 'Hans'), person(text, 'Meier')]).length).toBe(2);
    expect(joinNameParts(text, [person(text, 'Anna', 'manual'), person(text, 'Keller')]).length).toBe(2);
  });

  it('the lowercase pass keeps offsets and only trusts real names', () => {
    const t = 'bitte schreib hans meier, max 5 items; mark the date';
    expect(capitalizeLowercaseWords(t)).toHaveLength(t.length);
    expect(capitalizeLowercaseWords(t)).toBe('Bitte Schreib Hans Meier, Max 5 Items; Mark The Date');
    const at = (s: string, score = 1) => ({ ...person(t, s), score });
    expect(passesLowercaseNameGate(at('hans meier'), t)).toBe(true);
    expect(passesLowercaseNameGate(at('hans meier', 0.9), t)).toBe(false);
    expect(passesLowercaseNameGate(at('max'), t)).toBe(false); // everyday word
    expect(passesLowercaseNameGate(at('date', 0.95), t)).toBe(false); // not sure enough for one word
  });
});
