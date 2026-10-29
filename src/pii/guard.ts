// Leak guard: a last, deliberately over-cautious scan of the CLEANED text before it is sent. Anything here was
// not redacted but looks risky, so the user should look at it before sending. It never changes the text itself,
// which keeps precision of the redaction high while still catching what the detectors missed.
import { findAmounts } from './finance';
import { hasHealthTerm } from './health';
import { PLACEHOLDER_RE, type Vault } from './vault';

export interface Risk {
  start: number;
  end: number;
  text: string;
  reason: 'known-value' | 'email' | 'long-number' | 'amount' | 'health' | 'name-intro';
  /** high = probably a leak, worth stopping auto-send; low = worth a glance (invoice totals, article numbers). */
  severity: 'high' | 'low';
}

const LOW = new Set<Risk['reason']>(['long-number', 'amount']);

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Replace placeholders by spaces (same length) so offsets stay valid and nothing inside them matches. */
const mask = (s: string) => s.replace(PLACEHOLDER_RE, (m) => ' '.repeat(m.length));

const CHECKS: { reason: Risk['reason']; re: RegExp }[] = [
  { reason: 'email', re: /[^\s@]+@[^\s@]+\.[A-Za-z]{2,}/g },
  // 5+ digits in a row (or grouped like 123 456 789) that are not a year
  { reason: 'long-number', re: /(?<![\d.,'’])\d(?:[\s.'’-]?\d){4,}(?![\d.,'’])/g },
  { reason: 'name-intro', re: /\b(?:my name is|my name's|ich heisse|ich heiße|mein name ist|je m'appelle|mon nom est|mi chiamo)\s+[a-zäöüéè]{2,}(?:\s[a-zäöüéè]{2,})?\b/gi },
];

export function residualRisks(clean: string, vault?: Vault): Risk[] {
  const text = mask(clean);
  const out: Risk[] = [];
  const add = (start: number, end: number, reason: Risk['reason']) => {
    if (out.some((r) => start < r.end && r.start < end)) return;
    out.push({ start, end, text: clean.slice(start, end), reason, severity: LOW.has(reason) ? 'low' : 'high' });
  };

  // Known real values of this conversation that still appear (any casing) — the strongest signal.
  for (const { value } of vault?.knownValues() ?? []) {
    if (value.length < 4) continue;
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(value)}(?![\\p{L}\\p{N}])`, 'giu');
    for (const m of text.matchAll(re)) add(m.index!, m.index! + m[0].length, 'known-value');
  }
  for (const { reason, re } of CHECKS) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      if (reason === 'long-number' && /^(?:19|20)\d{2}$/.test(m[0])) continue;
      add(m.index!, m.index! + m[0].length, reason);
    }
  }
  for (const a of findAmounts(text)) add(a.start, a.end, 'amount');
  // Health terms: check per sentence so the reported span is readable.
  for (const m of text.matchAll(/[^.\n!?]+/g)) {
    if (hasHealthTerm(m[0])) add(m.index!, m.index! + m[0].length, 'health');
  }
  return out.sort((a, b) => a.start - b.start);
}

export const RISK_LABEL: Record<Risk['reason'], string> = {
  'known-value': 'a protected value appears unredacted',
  email: 'looks like an email address',
  'long-number': 'long number (ID? account?)',
  amount: 'money amount',
  health: 'health information',
  'name-intro': 'possible name in lowercase',
};

/** A flagged span with a little text around it, so it can be shown in context ("…paid to <hit> on 3 May…"). */
export function riskContext(clean: string, risk: Pick<Risk, 'start' | 'end'>, radius = 40): { before: string; hit: string; after: string } {
  const flat = (s: string) => s.replace(/\s+/g, ' ');
  const from = Math.max(0, risk.start - radius);
  const to = Math.min(clean.length, risk.end + radius);
  return {
    before: (from > 0 ? '…' : '') + flat(clean.slice(from, risk.start)),
    hit: flat(clean.slice(risk.start, risk.end)).slice(0, 160),
    after: flat(clean.slice(risk.end, to)) + (to < clean.length ? '…' : ''),
  };
}
