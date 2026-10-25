import { describe, expect, it } from 'vitest';
import { detectFinancial } from '../src/pii/finance';
import { residualRisks } from '../src/pii/guard';
import { detectHealth } from '../src/pii/health';
import { isProductLike, isPublicTerm } from '../src/pii/public-terms';
import { detectDates, detectIds, detectPeopleAndOrgs } from '../src/pii/structured';
import { Vault } from '../src/pii/vault';

const texts = (es: { text: string }[]) => es.map((e) => e.text);
const has = (es: { text: string }[], v: string) => texts(es).includes(v);

describe('dates', () => {
  it.each([
    ['Date: 20 mars 2026 · Lieu', '20 mars 2026'],
    ["envoyer l'offre (2 avril 2026)", '2 avril 2026'],
    ['Prochain contrôle: 1er août 2025.', '1er août 2025'],
    ['the order from 24th September 2026.', '24th September 2026'],
    ['DOB July 11, 1974', 'July 11, 1974'],
    ['DOB 13th September 1972', '13th September 1972'],
    ['Basel, 05.01.26', '05.01.26'],
    ['geboren am 27.10.93,', '27.10.93'],
    ['Date: 01/16/2026', '01/16/2026'],
    ['ci vediamo il 3 marzo per la visita', '3 marzo'],
    ['am 3. März 2025', '3. März 2025'],
  ])('%s', (text, value) => expect(texts(detectDates(text))).toContain(value));

  it.each(['Version 1.2.3', 'IP 192.168.1.10', 'Im Mai ist es warm', 'march forward'])('no date in %s', (text) => {
    expect(detectDates(text)).toHaveLength(0);
  });
});

describe('identifiers', () => {
  it.each([
    ['Invoice no. 2025-1088 | Customer ID: 910955', ['2025-1088', '910955']],
    ['Ticket T-35852', ['T-35852']],
    ['my order number is W585016', ['W585016']],
    ['N° patient 834126 | Matricule: 64666', ['834126', '64666']],
    ['Rechnung Nr. 2025-3058 | Kundennummer: 705077', ['2025-3058', '705077']],
    ['N° de contrat: BL-87198', ['BL-87198']],
    ['Facture n° 2026-1135 | N° client: 691832', ['2026-1135', '691832']],
    ['numero pratica: 2024/118-B', ['2024/118-B']],
  ])('%s', (text, values) => {
    const found = texts(detectIds(text));
    for (const v of values) expect(found).toContain(v);
  });

  it.each(['ISO 9001 certified', 'COVID-19 measures', 'Fall 2025 semester', 'CHE-697.883.483 MWST', 'Passwort123 is weak', 'Art. 266c OR'])(
    'no id in %s',
    (text) => expect(detectIds(text)).toHaveLength(0),
  );
});

describe('financial', () => {
  it('redacts personal amounts in context only', () => {
    const text = "Jahreslohn brutto: CHF 108'000 | Bonus 2025: CHF 5'500\nTotal Rechnung: CHF 1'250.00\nMietkaution: CHF 3'300.– auf ein Sperrkonto.";
    const found = texts(detectFinancial(text));
    expect(found).toEqual(["CHF 108'000", "CHF 5'500", "CHF 3'300.–"]);
    expect(texts(detectFinancial(text, 'all'))).toContain("CHF 1'250.00");
  });
  it.each([
    ["Le loyer mensuel s’élève à 2'300 francs payable", "2'300 francs"],
    ['salary adjustment for Elvis Glover to CHF 100,000 approved', 'CHF 100,000'],
    ['lo stipendio annuo è di CHF 95 000', 'CHF 95 000'],
  ])('%s', (text, v) => expect(texts(detectFinancial(text))).toContain(v));
});

describe('health', () => {
  it.each([
    ['Diagnose: rezidivierende depressive Störung, mittelgradige Episode\n', 'rezidivierende depressive Störung, mittelgradige Episode'],
    ['Aktuelle Medikation: Sertralin 50 mg\n', 'Sertralin 50 mg'],
    ['Excusé(e): Leila Berset (en arrêt maladie, diabète de type 2)', 'diabète de type 2'],
    ['Current medication: escitalopram 10 mg\n', 'escitalopram 10 mg'],
    ["Diagnostic: asthme bronchique\nTraitement actuel: Symbicort\n", 'asthme bronchique'],
    ['Wegen meiner lumbale Diskushernie L4/L5 kann ich erst ab nächster Woche', 'lumbale Diskushernie L4/L5'],
    ["she's on lithium since spring", 'lithium'],
    ['MRI shows a Kreuzbandriss links', 'Kreuzbandriss'],
  ])('%s', (text, v) => expect(texts(detectHealth(text)).some((t) => t.includes(v) || v.includes(t))).toBe(true));

  it.each(['Wir hatten eine Netzwerkstörung im Büro.', 'The meeting is on Teams.', 'Bitte Diagnose-Tool öffnen'])('no health in %s', (text) =>
    expect(detectHealth(text)).toHaveLength(0),
  );
});

describe('people and organisations', () => {
  it.each([
    ['[09:06] Customer: hi, this is steven murphy', 'steven murphy'],
    ['[09:11] Kunde: hallo, hier ist eduard burri', 'eduard burri'],
    ['Viele Grüsse\neduard\n', 'eduard'],
    ['From: Steven Murphy <s.murphy@gmx.ch>', 'Steven Murphy'],
    ['PATIENT: GLOVER JAZMIN, DOB July 11, 1974', 'GLOVER JAZMIN'],
    ['Nom: BOURCARD, Zoey\n', 'BOURCARD, Zoey'],
    ['Hallo janine,\n', 'janine'],
    ['[09:09] Odie (Support): Hi Steven', 'Odie'],
    ['Zeugnis ausgestellt von Dr. Erich Hodel, Klinik Bethanien.', 'Klinik Bethanien'],
    ['Lindenhof Clinic · Internal Medicine', 'Lindenhof Clinic'],
    ['Bailleresse: Favre Immobilier SA, Rue de Bourg 105', 'Favre Immobilier SA'],
    ['Transcription – Limmat Fiduciaire SA | Ticket', 'Limmat Fiduciaire SA'],
  ])('%s', (text, v) => expect(texts(detectPeopleAndOrgs(text))).toContain(v));

  it.each(['Hi team,\n', 'Best regards,\nResponsable RH\n', 'Name: (bitte ausfüllen)'])('no person in %s', (text) =>
    expect(detectPeopleAndOrgs(text).filter((e) => e.type === 'PERSON')).toHaveLength(0),
  );
});

describe('public terms', () => {
  it('knows products and institutions', () => {
    expect(isPublicTerm('Microsoft Teams')).toBe(true);
    expect(isPublicTerm('Tribunal fédéral.')).toBe(true);
    expect(isProductLike('MacBook Air 13')).toBe(true);
    expect(isProductLike('Sonos Era 100')).toBe(true);
    expect(isPublicTerm('Klinik Bethanien')).toBe(false);
  });
});

describe('leak guard', () => {
  it('flags known values in other casing, and risky leftovers', () => {
    const vault = new Vault();
    vault.placeholderFor('PERSON', 'Steven Murphy');
    const clean = '[PERSON-1] wrote. later steven murphy called from 079 123 45 67. Diagnosis was diabetes. Total CHF 1200.';
    const risks = residualRisks(clean, vault);
    const reasons = risks.map((r) => `${r.reason}:${r.text}`);
    expect(reasons).toContain('known-value:steven murphy');
    expect(risks.find((r) => r.reason === 'long-number')?.severity).toBe('low');
    expect(risks.some((r) => r.reason === 'health' && r.severity === 'high')).toBe(true);
    expect(risks.some((r) => r.reason === 'amount')).toBe(true);
    // placeholders themselves never count
    expect(residualRisks('[PERSON-1] and [IBAN-1]', vault)).toHaveLength(0);
  });
});

it('helper sanity', () => expect(has([{ text: 'a' }], 'a')).toBe(true));

describe('generic additions', () => {
  it.each([
    ['Berufserfahrung 03/2019 – 05/2022', '03/2019', detectDates],
    ['seit März 2019 bei der Firma', 'März 2019', detectDates],
    ['Kennzeichen ZH 123456 parkiert', 'ZH 123456', detectIds],
    ['Versichertenkarte 80756 0001 2345 6789 012', '80756 0001 2345 6789 012', detectIds],
    ['ZSR K123456, GLN 7601000123456', 'K123456', detectIds],
    ['Gespräch mit M. Rossi vereinbart', 'M. Rossi', detectPeopleAndOrgs],
    ['Bitte an sig.ra Bernasconi weiterleiten', 'Bernasconi', detectPeopleAndOrgs],
    ['Chat: Famiglia Pedrazzini', 'Pedrazzini', detectPeopleAndOrgs],
    ['versichert bei der Helvetia Versicherungen seit', 'Helvetia Versicherungen', detectPeopleAndOrgs],
  ] as const)('%s', (text, v, fn) => expect(texts(fn(text))).toContain(v));

  it('treats every amount on a statement as financial', () => {
    const t = "Kontoauszug 01.03.–31.03.2026\n02.03. Migros  CHF 84.20\n05.03. Gutschrift  CHF 5'200.00";
    expect(texts(detectFinancial(t))).toEqual(['CHF 84.20', "CHF 5'200.00"]);
  });

  it('keeps plate-like years and postcodes out', () => expect(detectIds('BE 2025 und GE 1205')).toHaveLength(0));
});

it.each([
  ['[09:12] Sandra (Support): Hallo Eduard, wie kann ich helfen?', 'Eduard'],
  ['Danke, Eduard! Der Fall ist erfasst.', 'Eduard'],
])('greeting/thanks in chat: %s', (text, v) => expect(texts(detectPeopleAndOrgs(text))).toContain(v));

describe('precision round 2', () => {
  it.each([
    ["It's super easy with your new card.", 'super easy'],
    ['This is to notify you of your requirement', 'to notify you'],
    ['Dear Parent, the transfusion', 'Parent'],
  ])('no person in %s', (text, v) => expect(texts(detectPeopleAndOrgs(text))).not.toContain(v));
  it('still finds chat introductions', () => {
    expect(texts(detectPeopleAndOrgs('[09:06] Customer: hi, this is steven murphy\n'))).toContain('steven murphy');
    expect(texts(detectPeopleAndOrgs('hallo, hier ist eduard burri, ich'))).toContain('eduard burri');
  });
  it.each(['This Critical Illness Insurance Policy', 'United Kingdom Bank Security Team'])('no generic org in %s', (text) =>
    expect(detectPeopleAndOrgs(text).filter((e) => e.type === 'ORG')).toHaveLength(0),
  );
  it.each([
    ['born in 1974 in Basel', ['1974']],
    ['he worked there between 1982 and 1984.', ['1982', '1984']],
    ['zwischen 2015 und 2019 wohnhaft', ['2015', '2019']],
    ['Urteil 4A_123/2020 vom 3. März', ['4A_123/2020']],
    ['applications nos. 511 and 513/02 lodged', ['511', '513/02']],
  ] as const)('legal/years: %s', (text, vals) => {
    const found = [...texts(detectDates(text)), ...texts(detectIds(text))];
    for (const v of vals) expect(found).toContain(v);
  });
});
