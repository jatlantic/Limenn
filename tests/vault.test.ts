import { describe, expect, it } from 'vitest';
import { Vault } from '../src/pii/vault';

describe('Vault', () => {
  it('reuses placeholders for the same value and restores text', () => {
    const v = new Vault();
    expect(v.placeholderFor('PERSON', 'Anna Meier')).toBe('[PERSON-1]');
    expect(v.placeholderFor('PERSON', 'anna  meier')).toBe('[PERSON-1]');
    expect(v.placeholderFor('PERSON', 'Lukas Brunner')).toBe('[PERSON-2]');
    expect(v.placeholderFor('IBAN', 'CH93 0076 2011 6238 5295 7')).toBe('[IBAN-1]');
    expect(v.placeholderFor('IBAN', 'CH9300762011623852957')).toBe('[IBAN-1]');
    expect(v.restore('Dear [PERSON-1], pay to \\[IBAN_1\\]. Unknown [FOO-9] stays.')).toBe(
      'Dear Anna Meier, pay to CH93 0076 2011 6238 5295 7. Unknown [FOO-9] stays.',
    );
  });
  it('links first and last names to the full name', () => {
    const v = new Vault();
    v.placeholderFor('PERSON', 'Dr. Anna Meier');
    expect(v.placeholderFor('PERSON', 'Meier')).toBe('[PERSON-1-SURNAME]');
    expect(v.placeholderFor('PERSON', 'Anna')).toBe('[PERSON-1-FIRST]');
    expect(v.restore('[PERSON-1-FIRST] [PERSON-1-SURNAME]')).toBe('Anna Meier');
  });
  it('serialises', () => {
    const v = new Vault();
    v.placeholderFor('EMAIL', 'a@b.ch');
    expect(new Vault(JSON.parse(JSON.stringify(v.data))).restore('[EMAIL-1]')).toBe('a@b.ch');
  });
});

describe('vault consistency', () => {
  it('reuses a placeholder when NER types the same name differently', async () => {
    const { Vault } = await import('../src/pii/vault');
    const v = new Vault();
    const a = v.placeholderFor('PERSON', 'Zoey Bourcard');
    expect(v.placeholderFor('LOCATION', 'Zoey Bourcard')).toBe(a);
    expect(v.placeholderFor('EMAIL', 'zoey@x.ch')).not.toBe(a);
  });

  it('restores the properly cased form', async () => {
    const { Vault } = await import('../src/pii/vault');
    const v = new Vault();
    const ph = v.placeholderFor('PERSON', 'jazmin glover');
    v.placeholderFor('PERSON', 'Jazmin Glover');
    expect(v.restore(`Hi ${ph}`)).toBe('Hi Jazmin Glover');
  });
});
