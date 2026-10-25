import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyDoc, docId, loadDoc, scanVault } from '../src/docvault/cache';
import { nodeVaultFs } from '../src/docvault/node-fs';
import { redact } from '../src/pii/pipeline';
import { DEFAULT_SETTINGS } from '../src/pii/types';
import { Vault } from '../src/pii/vault';

const settings = { ...DEFAULT_SETTINGS, enableNer: false, enableJev: false };
const extract = async (_name: string, bytes: Uint8Array) => ({ text: new TextDecoder().decode(bytes), meta: 'text' });
const deps = { settings, extract };

const LETTER = 'Dear client,\nplease transfer to CH93 0076 2011 6238 5295 7 and confirm to anna.meier@example.ch.\nAHV 756.1234.5678.97, phone +41 79 123 45 67.\nWrite again to anna.meier@example.ch.';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'limenn-vault-'));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe('document vault', () => {
  it('applyDoc on cached detections equals a full redact() with the same vault', async () => {
    await writeFile(join(dir, 'letter.txt'), LETTER);
    const fs = nodeVaultFs(dir);
    await scanVault(fs, deps);
    const doc = (await loadDoc(fs, await docId('letter.txt')))!;
    expect(doc.status).toBe('ready');

    // Same conversation state on both sides: something was already redacted before.
    const a = new Vault();
    const b = new Vault();
    await redact('Mail to other@example.ch', { settings, vault: a });
    await redact('Mail to other@example.ch', { settings, vault: b });

    const full = await redact(LETTER, { settings, vault: a });
    const fast = applyDoc(doc, b);
    expect(fast.clean).toBe(full.clean);
    expect(fast.entities.map((e) => e.placeholder)).toEqual(full.entities.map((e) => e.placeholder));
    expect(b.data).toEqual(a.data);
    expect(b.restore(fast.clean)).toBe(LETTER);
    expect(fast.clean).toContain('[EMAIL-2]'); // numbering continues the conversation
  });

  it('applies session and per-document review lists', async () => {
    await writeFile(join(dir, 'letter.txt'), LETTER);
    const fs = nodeVaultFs(dir);
    await scanVault(fs, deps);
    const doc = (await loadDoc(fs, await docId('letter.txt')))!;
    doc.review = { allow: ['anna.meier@example.ch'], manual: [['Dear client', 'PERSON']] };
    const r = applyDoc(doc, new Vault());
    expect(r.clean).toContain('anna.meier@example.ch');
    expect(r.clean.startsWith('[PERSON-1],')).toBe(true);
  });

  it('only re-prepares new or changed files and drops deleted ones', async () => {
    await writeFile(join(dir, 'a.txt'), LETTER);
    await writeFile(join(dir, 'b.md'), 'Call +41 79 765 43 21');
    await writeFile(join(dir, 'ignored.exe'), 'x');
    const fs = nodeVaultFs(dir);

    const first = await scanVault(fs, deps);
    expect(first.prepared).toHaveLength(2);

    const second = await scanVault(fs, deps);
    expect(second.prepared).toHaveLength(0);
    expect(second.unchanged).toHaveLength(2);

    // touch without content change → hash check, no re-prepare
    const later = new Date(Date.now() + 5000);
    await utimes(join(dir, 'a.txt'), later, later);
    expect((await scanVault(fs, deps)).prepared).toHaveLength(0);

    await writeFile(join(dir, 'b.md'), 'Call +41 79 765 43 22 now');
    await rm(join(dir, 'a.txt'));
    const third = await scanVault(fs, deps);
    expect(third.prepared).toEqual([await docId('b.md')]);
    expect(third.removed).toEqual([await docId('a.txt')]);
  });

  it('re-prepares when detection settings change, and keeps review edits', async () => {
    await writeFile(join(dir, 'a.txt'), LETTER);
    const fs = nodeVaultFs(dir);
    await scanVault(fs, deps);
    const id = await docId('a.txt');
    const doc = (await loadDoc(fs, id))!;
    doc.review.allow.push('x');
    await fs.writeCache(`${id}.json`, JSON.stringify(doc));
    const r = await scanVault(fs, { ...deps, settings: { ...settings, allowList: [...settings.allowList, 'Acme'] } });
    expect(r.prepared).toEqual([id]);
    expect((await loadDoc(fs, id))!.review.allow).toEqual(['x']);
  });

  it('stores extraction failures as error docs', async () => {
    await writeFile(join(dir, 'scan.pdf'), 'not a pdf');
    const fs = nodeVaultFs(dir);
    await scanVault(fs, { ...deps, extract: async () => Promise.reject(new Error('no text layer')) });
    const doc = (await loadDoc(fs, await docId('scan.pdf')))!;
    expect(doc.status).toBe('error');
    expect(() => applyDoc(doc, new Vault())).toThrow(/no text layer/);
  });
});

describe('document vault allow list', () => {
  it('keeps settings.allowList on the fast path, like redact()', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'limenn-vault-'));
    const text = 'Patient: Claude Meier, claude@example.ch. Ask Claude to summarise.';
    await writeFile(join(dir, 'a.txt'), text);
    const fs = nodeVaultFs(dir);
    const s = { ...settings, allowList: ['Claude'] };
    await scanVault(fs, { settings: s, extract });
    const doc = (await loadDoc(fs, await docId('a.txt')))!;
    // Simulate a name detected by NER so the FIRST alias "Claude" gets registered.
    doc.entities.push({ start: 9, end: 21, text: 'Claude Meier', type: 'PERSON', source: 'ner', score: 0.99 });
    doc.entities.sort((a, b) => a.start - b.start);
    const fast = applyDoc(doc, new Vault());
    expect(fast.clean).toContain('Ask Claude to summarise');
    await rm(dir, { recursive: true, force: true });
  });
});

describe('personal gazetteer', () => {
  it('learns confident names from vault docs and finds them in later prompts, any casing', async () => {
    const { buildGazetteer, detectKnown } = await import('../src/pii/gazetteer');
    const ent = (text: string, type: 'PERSON' | 'ORG', source: 'regex' | 'ner', score: number) => ({ start: 0, end: text.length, text, type, source, score });
    const gaz = buildGazetteer([
      { entities: [ent('Anna Meier', 'PERSON', 'ner', 0.97), ent('Meier Treuhand AG', 'ORG', 'regex', 1), ent('Rose', 'PERSON', 'ner', 0.99), ent('the applicant', 'PERSON', 'ner', 0.95), ent('Low Score', 'PERSON', 'ner', 0.6)] },
    ]);
    expect(gaz.map((g) => g.value).sort()).toEqual(['Anna Meier', 'Meier Treuhand AG']);
    const found = detectKnown('can you draft a reply to anna  meier at meier treuhand ag?', gaz).map((e) => e.text);
    expect(found).toEqual(['meier treuhand ag', 'anna  meier']);
  });

  it('is rebuilt on scan and stored in the vault cache', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'limenn-vault-'));
    await writeFile(join(dir, 'a.txt'), 'From: Steven Murphy <s@x.ch>\nContract with Limmat Consulting GmbH.');
    const fs = nodeVaultFs(dir);
    await scanVault(fs, deps);
    const { loadGazetteer } = await import('../src/docvault/cache');
    expect((await loadGazetteer(fs)).map((g) => g.value)).toEqual(expect.arrayContaining(['Steven Murphy', 'Limmat Consulting GmbH']));
    await rm(dir, { recursive: true, force: true });
  });
});
