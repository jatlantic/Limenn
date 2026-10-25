// FINANCIAL detection: amounts that describe a person's finances (salary, bonus, rent, deposit, debt, balance).
// Business amounts (invoice lines and totals) stay readable by default, because the model needs them to be
// useful. Policy 'all' redacts every amount.
import type { Entity } from './types';

const CUR = String.raw`(?:CHF|SFr\.|Fr\.|sFr\.|EUR|€|USD|US\$|\$|£|GBP)`;
const CUR_WORD = String.raw`(?:CHF|Fr\.|Franken|francs?|franchi|EUR|Euro|euros?|€|USD|Dollar|dollars?)`;
// 108'000 · 108’000 · 108 000 · 100,000 · 1'100.50 · 3'300.– · 5500
const NUM = String.raw`\d{1,3}(?:['’ ,.]\d{3})+(?:[.,]\d{1,2}|\.[–-]{1,2})?|\d+(?:[.,]\d{1,2}|\.[–-]{1,2})?`;
// Shorthand amounts without a currency: 50k · 1.2m · 3 Mio. · 250 thousand · 2 Millionen (only kept when the context is personal finance)
const SHORT = String.raw`(?<![\p{L}\d'’.,])\d+(?:[.,]\d+)?\s?(?:k|K|m|M|Mio\.?|Mrd\.?|million|millions|Millionen|thousand|Tausend|mille)(?![\p{L}\d])`;
const AMOUNT_RE = new RegExp(String.raw`${CUR}\s?(?:${NUM})(?:\s?(?:Mio\.?|Mio|million|millions|k))?|(?<![\d'’.,])(?:${NUM})\s?(?:Mio\.?\s)?${CUR_WORD}(?![\p{L}])|${SHORT}`, 'gu');

const KEYWORDS = [
  // de
  'lohn', 'jahreslohn', 'monatslohn', 'bruttolohn', 'nettolohn', 'lohnanpassung', 'lohnerhöhung', 'gehalt', 'salär', 'bonus', 'gratifikation', '13\\. monatslohn',
  'miete', 'mietzins', 'nettomiete', 'bruttomiete', 'mietkaution', 'kaution', 'nebenkosten', 'einkommen', 'vermögen', 'schulden', 'betreibung', 'kontostand',
  'saldo', 'guthaben', 'rente', 'pension', 'alimente', 'unterhalt', 'steuerbar', 'steuerbares', 'abfindung', 'hypothek', 'kredit', 'darlehen', 'taggeld',
  'wunschlohn', 'lohnvorstellung', 'vergleich', 'vergleichssumme', 'entschädigung', 'genugtuung', 'busse', 'bussgeld', 'ordnungsbusse', 'schaden', 'schadensumme', 'forderung', 'streitwert', 'steuer', 'steuern', 'gutschrift', 'belastung', 'zahlung', 'überweisung', 'saldo', 'rechnungsbetrag offen',
  // fr
  'transaction', 'règlement',
  'prétentions salariales', 'amende', 'dommage', 'créance', 'impôt', 'impôts', 'crédit', 'débit', 'versement', 'virement', 'valeur litigieuse',
  'salaire', 'salarial', 'rémunération', 'prime', 'loyer', 'garantie de loyer', 'caution', 'charges', 'revenu', 'revenus', 'fortune', 'dettes', 'dette',
  'poursuite', 'solde', 'rente', 'pension alimentaire', 'indemnité', 'hypothèque', 'prêt', 'crédit',
  // en
  'settlement', 'settle', 'payout', 'award',
  'expected salary', 'salary expectations', 'fine', 'damage', 'damages', 'claim', 'claimed', 'tax due', 'tax', 'credit', 'debit', 'transfer', 'payment', 'amount in dispute',
  'salary', 'wage', 'wages', 'pay', 'bonus', 'compensation', 'rent', 'deposit', 'security deposit', 'income', 'net worth', 'assets', 'debt', 'debts', 'loan',
  'mortgage', 'balance', 'pension', 'alimony', 'severance', 'taxable',
  // it
  'transazione', 'risarcimento', 'indennizzo',
  'pretese salariali', 'multa', 'danno', 'credito', 'addebito', 'accredito', 'bonifico', 'imposta', 'imposte', 'pagamento', 'valore litigioso', 'spese accessorie',
  'stipendio', 'salario', 'retribuzione', 'affitto', 'pigione', 'cauzione', 'deposito', 'reddito', 'patrimonio', 'debito', 'debiti', 'saldo', 'mutuo', 'prestito',
];
const KEYWORD_RE = new RegExp(`(?<![\\p{L}])(?:${KEYWORDS.join('|')})`, 'giu');

export type FinancialPolicy = 'context' | 'all';

/** Is a personal-finance keyword within `radius` characters before the amount (same line), or right after it? */
function inContext(text: string, start: number, end: number, radius = 60): boolean {
  const lineStart = text.lastIndexOf('\n', start - 1) + 1;
  const before = text.slice(Math.max(lineStart, start - radius), start);
  const lineEnd = text.indexOf('\n', end);
  const after = text.slice(end, Math.min(lineEnd < 0 ? text.length : lineEnd, end + 30));
  KEYWORD_RE.lastIndex = 0;
  if (KEYWORD_RE.test(before)) return true;
  KEYWORD_RE.lastIndex = 0;
  return KEYWORD_RE.test(after);
}

export function findAmounts(text: string): { start: number; end: number }[] {
  AMOUNT_RE.lastIndex = 0;
  return [...text.matchAll(AMOUNT_RE)].map((m) => {
    const v = m[0].replace(/[\s,]+$/, '');
    return { start: m.index!, end: m.index! + v.length };
  });
}

// On a bank statement or tax notice every amount is the person's own money.
const STATEMENT_RE =
  /(?:Kontoauszug|Konto-?auszug|Vermögensausweis|Steuerveranlagung|Veranlagungsverfügung|Steuerrechnung|Lohnausweis|Lohnabrechnung|relevé de compte|extrait de compte|avis de taxation|décision de taxation|bordereau d'impôt|fiche de salaire|décompte de salaire|estratto conto|notifica di tassazione|decisione di tassazione|busta paga|conteggio salario|account statement|bank statement|tax assessment|notice of assessment|payslip|pay slip)/i;

export function detectFinancial(text: string, policy: FinancialPolicy = 'context'): Entity[] {
  const all = policy === 'all' || STATEMENT_RE.test(text);
  return findAmounts(text)
    .filter((a) => all || inContext(text, a.start, a.end))
    .map((a) => ({ start: a.start, end: a.end, text: text.slice(a.start, a.end), type: 'FINANCIAL' as const, source: 'regex' as const, score: 0.9 }));
}
