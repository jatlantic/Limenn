import { describe, expect, it } from 'vitest';
import { ahvValid, detectRegex, ibanValid, luhn } from '../src/pii/regex';
import { mergeEntities } from '../src/pii/merge';

const types = (t: string) => detectRegex(t).map((e) => [e.type, e.text]);

describe('checksums', () => {
  it('validates IBAN', () => {
    expect(ibanValid('CH93 0076 2011 6238 5295 7')).toBe(true);
    expect(ibanValid('DE89 3704 0044 0532 0130 00')).toBe(true);
    expect(ibanValid('CH93 0076 2011 6238 5295 8')).toBe(false);
  });
  it('validates Luhn and AHV', () => {
    expect(luhn('4111 1111 1111 1111')).toBe(true);
    expect(luhn('4111 1111 1111 1112')).toBe(false);
    expect(ahvValid('756.1234.5678.97')).toBe(true);
    expect(ahvValid('756.1234.5678.98')).toBe(false);
  });
});

describe('detectRegex', () => {
  it('finds contact data', () => {
    const r = types('Mail anna.meier@example.ch or call +41 79 123 45 67 / 044 668 18 00, see https://example.ch/x');
    expect(r).toContainEqual(['EMAIL', 'anna.meier@example.ch']);
    expect(r).toContainEqual(['PHONE', '+41 79 123 45 67']);
    expect(r).toContainEqual(['PHONE', '044 668 18 00']);
    expect(r).toContainEqual(['URL', 'https://example.ch/x']);
  });
  it('finds identifiers by checksum', () => {
    const r = types('IBAN CH93 0076 2011 6238 5295 7, card 4111 1111 1111 1111, AHV 756.1234.5678.97');
    expect(r).toContainEqual(['IBAN', 'CH93 0076 2011 6238 5295 7']);
    expect(r).toContainEqual(['CREDIT_CARD', '4111 1111 1111 1111']);
    expect(r).toContainEqual(['NATIONAL_ID', '756.1234.5678.97']);
  });
  it('masks card-, IBAN- and AHV-shaped values even with wrong check digits', () => {
    const r = types('Karte 4111 1111 1111 1112. IBAN: DE12 3456 7890 1234 5678 00. AHV 756.4861.4247.98. Amex 3756 123456 78901.');
    expect(r).toContainEqual(['CREDIT_CARD', '4111 1111 1111 1112']);
    expect(r).toContainEqual(['IBAN', 'DE12 3456 7890 1234 5678 00']);
    expect(r).toContainEqual(['NATIONAL_ID', '756.4861.4247.98']);
    expect(r).toContainEqual(['CREDIT_CARD', '3756 123456 78901']);
  });
  it('finds unlabelled codes and accented e-mails, not standards or bank codes', () => {
    const r = types(
      'Write to hadivià@aol.com. Bring D9QCBRN6LB (not the U2723QE monitor) and ref 8863249430, device e4a8e5b2-5c3d-497f-9d2c-1b66c4b923a1, **Employee ID:** 002871, ' +
        'license plate K4R-278, application no. 32340/96. ISO27001, COVID-19, BIC DEUTDEFF500, ISIN DE0008471021, CHF 1250.50, 2022-02-16T10:00.',
    );
    for (const v of ['hadivià@aol.com', 'D9QCBRN6LB', '8863249430', 'e4a8e5b2-5c3d-497f-9d2c-1b66c4b923a1', '002871', 'K4R-278', '32340/96']) {
      expect(r.find(([, x]) => x === v)).toBeDefined();
    }
    for (const v of ['U2723QE', 'ISO27001', 'COVID-19', 'DEUTDEFF500', 'DE0008471021', '1250', '2022-02-16T10']) {
      expect(r.find(([t, x]) => x.includes(v) && t !== 'DATE' && t !== 'HEALTH')).toBeUndefined();
    }
  });
  it('finds dates, addresses and labelled ids', () => {
    const r = types('geboren am 14.07.1988, seit 3. März 2024, wohnhaft Bahnhofstrasse 12, 9000 St. Gallen. Patienten-Nr. 4402819. 221B Baker Street');
    expect(r).toContainEqual(['DATE', '14.07.1988']);
    expect(r).toContainEqual(['DATE', '3. März 2024']);
    expect(r).toContainEqual(['ADDRESS', 'Bahnhofstrasse 12']);
    expect(r).toContainEqual(['POSTAL_CODE', '9000 St. Gallen']);
    expect(r).toContainEqual(['ID_NUMBER', '4402819']);
    expect(r).toContainEqual(['ADDRESS', '221B Baker Street']);
  });
  it('leaves ordinary numbers alone', () => {
    expect(types('Die Probezeit beträgt 3 Monate, 25 Ferientage, CHF 7850 pro Monat, Art. 336c OR')).toEqual([]);
  });
});

describe('name introductions', () => {
  it('catches lowercase self-introductions', () => {
    expect(types('my name is max mustermann - tell me more about him')).toContainEqual(['PERSON', 'max mustermann']);
    expect(types('Hallo, ich heisse anna meier und wohne in Bern')).toContainEqual(['PERSON', 'anna meier']);
    expect(types('My name is Lukas.')).toContainEqual(['PERSON', 'Lukas']);
  });
});

describe('phone and email formats', () => {
  it.each([
    '+41 79 123 45 67', '+41791234567', '079 123 45 67', '079/123 45 67', '0041 79 123 45 67', '+41 (0)79 123 45 67',
    '+49 151 23456789', '030 12345678', '+44 20 7946 0958', '+1 (555) 123-4567', '555-123-4567', '+33 6 12 34 56 78',
  ])('phone %s', (p) => expect(types(`Tel. ${p} bitte`)).toContainEqual(['PHONE', p]));
  it.each(['max.mustermann@firma.de', 'Max_Mustermann+test@sub.example.co.uk'])('email %s', (m) =>
    expect(types(`Mail ${m}.`)).toContainEqual(['EMAIL', m]),
  );
  it('finds case references (Aktenzeichen) as their own type', () => {
    expect(types('Az. 12 O 345/24')).toContainEqual(['CASE_REF', '12 O 345/24']);
    expect(types('Aktenzeichen: VN-2026-00412')).toContainEqual(['CASE_REF', 'VN-2026-00412']);
    expect(types('Unser Zeichen 4711/26-ks')).toContainEqual(['CASE_REF', '4711/26-ks']);
    expect(types('Case No. 2024/118')).toContainEqual(['CASE_REF', '2024/118']);
    expect(mergeEntities(detectRegex('Aktenzeichen: VN-2026-00412')).map((e) => e.type)).toEqual(['CASE_REF']);
  });
  it('keeps money amounts when the policy is none', () => {
    expect(detectRegex('Kaution 1.250,00 EUR, Miete CHF 1\'850', { financialPolicy: 'none' }).filter((e) => e.type === 'FINANCIAL')).toEqual([]);
  });
  it('does not read a floor and street as "SURNAME, Firstname"', () => {
    expect(types('Wohnung 3. OG, Marktstr. 59').filter(([t]) => t === 'PERSON')).toEqual([]);
  });
});
