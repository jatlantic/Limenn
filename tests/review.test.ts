import { describe, expect, it } from 'vitest';
import { residualRisks, riskContext } from '../src/pii/guard';
import { composeMessage } from '../src/shared/compose';
import type { JobState } from '../src/shared/jobs';

describe('attachment names', () => {
  const items = [
    { kind: 'prompt', clean: '' },
    { kind: 'file', name: 'Lohnausweis_Muster Hans.pdf', clean: 'Lohn [AMOUNT-1]' },
    { kind: 'file', name: 'Zeugnis Muster.docx', clean: 'Zeugnis' },
  ];
  it('never carries the original file name to the AI', () => {
    const m = composeMessage({ items } as unknown as JobState);
    expect(m.files.map((f) => f.name)).toEqual(['document-1.redacted.txt', 'document-2.redacted.txt']);
    expect(JSON.stringify(m)).not.toMatch(/Muster|Lohnausweis/);
  });
  it('same for documents written into the message', () => {
    const m = composeMessage({ items } as unknown as JobState, { inline: true });
    expect(m.text).toContain('<document name="document-1">');
    expect(m.text).not.toMatch(/Muster|Lohnausweis/);
  });
  it('keeps the name when protection is off (nothing is hidden then)', () => {
    const m = composeMessage({ items, unprotected: true } as unknown as JobState);
    expect(m.files[0].name).toBe('Lohnausweis_Muster Hans.txt');
  });
});

describe('riskContext', () => {
  it('shows the flagged text with its surroundings', () => {
    const clean = 'Name: [PERSON-1] Kontakt: hans@example.com Bemerkung: keine';
    const [r] = residualRisks(clean);
    expect(r.reason).toBe('email');
    const c = riskContext(clean, r, 9);
    expect(c.hit).toBe('hans@example.com');
    expect(c.before).toBe('…Kontakt: ');
    expect(c.after).toBe(' Bemerkun…');
  });
  it('does not add ellipses at the edges of the text', () => {
    const c = riskContext('a@b.ch', { start: 0, end: 6 });
    expect(c).toEqual({ before: '', hit: 'a@b.ch', after: '' });
  });
});
