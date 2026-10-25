// Agreement-based combination of the token model (BERT) and a span model (e.g. GLiNER).
// A plain union maximises recall but doubles false positives (external benchmark, Oct 2026). Instead:
//  - both models agree on a span (overlap, same type)      → accept
//  - one model alone, above its per-type "high" threshold   → accept
//  - one model alone, above "low" but below "high"          → uncertain (goes to Jev, if enabled)
// When both found the same entity, the boundaries come from the model that is stronger for that type:
// BERT for PERSON / ORG / LOCATION, the span model for everything else (dates, IDs, addresses…).
import type { Entity, EntityType } from './types';

export interface EnsembleThresholds {
  /** Token model alone: accept at/above this (default: settings.nerThreshold). */
  tokenHigh: number;
  /** Token model counts as "agreeing" at/above this. */
  tokenLow: number;
  /** Span model alone: accept at/above this, per type (fallback: spanHighDefault). */
  spanHigh: Partial<Record<EntityType, number>>;
  spanHighDefault: number;
  /** Span model counts as "agreeing" / goes to Jev at/above this. */
  spanLow: number;
}

/** Tuned on a held-out development set (objective F2, Oct 2026). */
export const DEFAULT_ENSEMBLE: EnsembleThresholds = {
  tokenHigh: 0.85,
  tokenLow: 0.5,
  spanHigh: { ADDRESS: 0.3, CREDIT_CARD: 0.3, DATE: 0.3, EMAIL: 0.3, FINANCIAL: 0.9, HEALTH: 0.7, IBAN: 0.5, ID_NUMBER: 0.3, IP: 0.9, LOCATION: 0.3, NATIONAL_ID: 0.3, ORG: 0.5, PERSON: 0.7, PHONE: 0.3, POSTAL_CODE: 0.3, URL: 0.3 },
  spanHighDefault: 0.5,
  spanLow: 0.3,
};

const TOKEN_MODEL_TYPES = new Set<EntityType>(['PERSON', 'ORG', 'LOCATION']);
const overlaps = (a: Entity, b: Entity) => a.start < b.end && b.start < a.end;

export function combineModels(token: Entity[], span: Entity[], t: EnsembleThresholds): { accepted: Entity[]; uncertain: Entity[] } {
  const accepted: Entity[] = [];
  const uncertain: Entity[] = [];
  const usedToken = new Set<Entity>();

  for (const s of span) {
    if (s.score < t.spanLow) continue;
    const partner = token.find((k) => k.type === s.type && k.score >= t.tokenLow && overlaps(k, s));
    if (partner) {
      usedToken.add(partner);
      // Type-routing: boundaries from the model that is stronger for this type.
      accepted.push(TOKEN_MODEL_TYPES.has(s.type) ? { ...partner, score: Math.max(partner.score, s.score) } : { ...s, score: Math.max(partner.score, s.score) });
      continue;
    }
    const high = t.spanHigh[s.type] ?? t.spanHighDefault;
    (s.score >= high ? accepted : uncertain).push(s);
  }
  for (const k of token) {
    if (usedToken.has(k)) continue;
    if (k.score >= t.tokenHigh) accepted.push(k);
    else if (k.score >= t.tokenLow) uncertain.push(k);
  }
  return { accepted, uncertain };
}
