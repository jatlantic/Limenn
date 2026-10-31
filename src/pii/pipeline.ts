import { findCandidates } from './candidates';
import { joinAddressParts, joinNameParts, mergeEntities } from './merge';
import { detectNer, type TokenClassifier } from './ner';
import { detectRegex } from './regex';
import type { Classifier, ClassifierResult, Entity, Settings } from './types';
import { combineModels, DEFAULT_ENSEMBLE } from './ensemble';
import { passesLowercaseNameGate, passesProperNounGate, retypeByShape } from './filters';
import { detectKnown, type KnownValue } from './gazetteer';
import { isProductLike, isPublicTerm } from './public-terms';
import { Vault } from './vault';

/** Allow-list comparison ignores case and trailing punctuation ("Claude." == "claude"). */
export const allowKey = (s: string) => s.trim().replace(/[.,;:!?)\]]+$/, '').toLowerCase();

/**
 * The cased NER model ignores ALL-CAPS names ("PATIENT: GLOVER JAZMIN"). Runs of 2+ ALL-CAPS words are
 * title-cased for the model only; every word keeps its length, so offsets map 1:1 to the original text.
 */
export function titleCaseCapsRuns(text: string): string {
  return text.replace(/(?<![\p{L}])\p{Lu}{3,}(?:[ \t,-]+\p{Lu}{3,})+(?![\p{L}])/gu, (run) => {
    const out = run.replace(/\p{Lu}+/gu, (w) => {
      const t = w[0] + w.slice(1).toLowerCase();
      return t.length === w.length ? t : w;
    });
    return out.length === run.length ? out : run;
  });
}

/**
 * People type names in lowercase ("bitte schreib hans meier"), which the cased NER model never tags. For a second
 * pass every lowercase word is capitalised (same length, so offsets map 1:1); only PERSON hits that were all lowercase
 * in the original are kept from it. Limited to prompt-sized texts, where casual typing happens.
 */
export const LOWERCASE_PASS_MAX = 4000;
export const capitalizeLowercaseWords = (text: string) => text.replace(/(?<![\p{L}\p{N}])\p{Ll}[\p{Ll}'’]+/gu, (w) => w[0].toUpperCase() + w.slice(1));

/** A model (NER/Jev) hit that is a product, platform or public institution, not personal data. */
const isPublic = (e: Entity) => (e.source === 'ner' || e.source === 'jev') && (isPublicTerm(e.text) || isProductLike(e.text));

/** NER spans sometimes include trailing punctuation ("Claude."). */
function trimEntity(text: string, e: Entity): Entity {
  const v = e.text.replace(/[\s.,;:!?]+$/, '');
  return v.length === e.text.length ? e : { ...e, end: e.start + v.length, text: text.slice(e.start, e.start + v.length) };
}

export interface RedactOptions {
  settings: Settings;
  vault: Vault;
  /** Stage 2 classifier; omit to skip NER. */
  ner?: TokenClassifier;
  /**
   * Optional span-level model (e.g. GLiNER) used next to or instead of `ner`. Returns spans with scores; those at or
   * above `settings.nerThreshold` are accepted, the rest go to Jev like uncertain BERT spans.
   */
  spanNer?: (text: string) => Promise<Entity[]>;
  /** Personal gazetteer from the user's vault documents (see gazetteer.ts). */
  known?: KnownValue[];
  /**
   * Stage 3 classifier for uncertain spans (Jev, see jev.ts). Injected rather than imported so builds that must not
   * talk to the network (the browser extension) never bundle it; omit to skip stage 3.
   */
  classify?: Classifier;
  onEvent?: (e: StageEvent) => void;
  /** Entities the user removed in the review UI (by original text) — never redact these. */
  allow?: Set<string>;
  /** Extra spans the user marked manually. */
  manual?: Entity[];
}

export type Stage = 'regex' | 'ner' | 'jev';

export interface StageEvent {
  stage: Stage;
  status: 'start' | 'done' | 'skipped' | 'error';
  /** Entities found by this stage (for jev: accepted spans). */
  count?: number;
  /** Jev only: how many candidate spans were asked about. */
  candidates?: number;
  ms?: number;
  info?: string;
}

export interface RedactResult {
  clean: string;
  entities: (Entity & { placeholder: string })[];
  stats: { regex: number; ner: number; jev: number; manual: number; propagated: number; candidates: number; jevCostUsd: number };
  jev?: ClassifierResult;
  warnings: string[];
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Name parts that are also everyday words: only propagated right after an honorific ("Herr Wolf").
const AMBIGUOUS_PARTS = new Set(
  (
    'wolf winter sommer summer hope may april june rose blanc noir petit grand klein gross weiss schwarz braun fuchs vogel fischer bauer koch ' +
    'müller meier berg stein wald baum bach brunner frei frey hart young king white black brown green stone wood rich long little bell ' +
    'page price love joy faith grace hunter mason baker cook miller smith lane hill rivière fontaine roche martin bernard laurent ' +
    'claude marie colombo ferrari rossi bianchi neri sole luna mare fiore pace'
  ).split(' '),
);
const HONORIFIC_BEFORE = /(?:Herrn?|Frau|Fr\.|Hr\.|Dr\.|Prof\.|Mr\.?|Mrs\.?|Ms\.?|Monsieur|Madame|Mme\.?|M\.|Signor|Signora|Sig\.ra|Sig\.)\s$/;
// Articles / prepositions in front of a capitalised word mean it is used as a noun ("dem Wolf", "im Winter", "le Blanc").
const ARTICLE_BEFORE = /(?:^|[\s(])(?:der|die|das|dem|den|des|ein|eine|einem|einen|einer|im|am|vom|zum|zur|beim|ins|the|a|an|of|in|on|le|la|les|du|des|un|une|au|aux|il|lo|gli|del|della|nel|nella|al)\s$/i;

/** Find further occurrences of values already in the vault (e.g. a name detected once, repeated later). */
function propagate(text: string, vault: Vault, current: Entity[]): Entity[] {
  const out: Entity[] = [];
  for (const [id, { value, type }] of vault.knownEntries()) {
    if (value.length < 3) continue;
    const alias = /-(?:FIRST|SURNAME)$/.test(id);
    // Names/orgs also match in other casing ("steven murphy" ↔ "Steven Murphy", alias "eduard" ↔ "Eduard").
    // Common-word aliases are protected by AMBIGUOUS_PARTS / ARTICLE_BEFORE below.
    const ci = (type === 'PERSON' || type === 'ORG') && value.length >= 4;
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(value)}(?![\\p{L}\\p{N}])`, ci ? 'giu' : 'gu');
    for (const m of text.matchAll(re)) {
      const start = m.index!;
      const end = start + m[0].length;
      if (current.some((e) => e.start <= start && end <= e.end)) continue; // already covered
      // Known values override NER fragments, but never regex/manual hits.
      if (current.some((e) => e.source !== 'ner' && e.source !== 'jev' && start < e.end && e.start < end)) continue;
      if (out.some((e) => start < e.end && e.start < end)) continue;
      if (alias) {
        const before = text.slice(Math.max(0, start - 12), start);
        const afterHonorific = HONORIFIC_BEFORE.test(before);
        if (!afterHonorific) {
          if (AMBIGUOUS_PARTS.has(value.toLowerCase()) || ARTICLE_BEFORE.test(before)) continue;
        }
      }
      out.push({ start, end, text: m[0], type, source: 'regex', score: 1 });
    }
  }
  return out;
}

export interface Detection {
  /** Merged, non-overlapping detections (before placeholders are assigned). */
  entities: Entity[];
  candidates: number;
  jev?: ClassifierResult;
  warnings: string[];
}

/**
 * The expensive part of redaction: regex, BERT and Jev. The result does not depend on the placeholder vault,
 * so it can be cached per document (Document Vault) and applied to any conversation later.
 */
export async function detect(text: string, opts: Omit<RedactOptions, 'vault'>): Promise<Detection> {
  const { settings } = opts;
  const allow = new Set([...(opts.allow ?? []), ...settings.allowList].map(allowKey));
  const warnings: string[] = [];
  const notAllowed = (e: Entity) => !allow.has(allowKey(e.text));

  const emit = opts.onEvent ?? (() => {});
  let t = performance.now();
  const since = () => Math.round(performance.now() - t);

  emit({ stage: 'regex', status: 'start' });
  const regexHits = [...detectRegex(text, { financialPolicy: settings.financialPolicy }), ...(opts.known?.length ? detectKnown(text, opts.known) : [])].filter(notAllowed);
  emit({ stage: 'regex', status: 'done', count: regexHits.length, ms: since() });

  let nerAccepted: Entity[] = [];
  let nerLow: Entity[] = [];
  // Model hits pass the allow list, the public-term filter and the proper-noun gate (roles, pronouns…).
  // An amount needs a number: "monthly salary" or "the settlement" on their own say nothing about anyone's money.
  const keepModelHit = (e: Entity) => notAllowed(e) && !isPublic(e) && passesProperNounGate(e, text) && (e.type !== 'FINANCIAL' || (settings.financialPolicy !== 'none' && /\d/.test(e.text)));
  const ens = { ...DEFAULT_ENSEMBLE, tokenHigh: settings.nerThreshold, ...settings.ensemble };
  const useToken = settings.enableNer && !!opts.ner;
  if (useToken || opts.spanNer) {
    t = performance.now();
    emit({ stage: 'ner', status: 'start' });
    const tokenHits = useToken
      ? (await detectNer(titleCaseCapsRuns(text), opts.ner!)).map((e) => retypeByShape(trimEntity(text, { ...e, text: text.slice(e.start, e.end) }))).filter(keepModelHit)
      : [];
    if (useToken && text.length <= LOWERCASE_PASS_MAX && /(?<![\p{L}\p{N}])\p{Ll}{2,}/u.test(text)) {
      const lower = (await detectNer(capitalizeLowercaseWords(text), opts.ner!))
        .map((e) => trimEntity(text, { ...e, text: text.slice(e.start, e.end) }))
        .filter((e) => e.type === 'PERSON' && !/\p{Lu}/u.test(e.text) && notAllowed(e) && !isPublic(e) && passesLowercaseNameGate(e, text))
        .filter((e) => !tokenHits.some((t) => e.start < t.end && t.start < e.end));
      tokenHits.push(...lower);
    }
    const spanHits = opts.spanNer ? (await opts.spanNer(text)).map((e) => retypeByShape(trimEntity(text, { ...e, source: 'ner' as const }))).filter(keepModelHit) : [];
    if (useToken && opts.spanNer) {
      ({ accepted: nerAccepted, uncertain: nerLow } = combineModels(tokenHits, spanHits, ens));
    } else if (useToken) {
      nerAccepted = tokenHits.filter((e) => e.score >= settings.nerThreshold);
      nerLow = tokenHits.filter((e) => e.score < settings.nerThreshold);
    } else {
      nerAccepted = spanHits.filter((e) => e.score >= (ens.spanHigh[e.type] ?? ens.spanHighDefault));
      nerLow = spanHits.filter((e) => e.score >= ens.spanLow && e.score < (ens.spanHigh[e.type] ?? ens.spanHighDefault));
    }
    emit({ stage: 'ner', status: 'done', count: nerAccepted.length, ms: since(), info: nerLow.length ? `${nerLow.length} uncertain${settings.enableJev && opts.classify ? ' → Jev' : ''}` : undefined });
  } else {
    emit({ stage: 'ner', status: 'skipped', info: settings.enableNer ? 'model unavailable' : 'disabled' });
  }

  // "Send unchanged" also beats the user's own patterns, so one match of a shape can be exempted.
  let merged = joinAddressParts(text, joinNameParts(text, mergeEntities([...(opts.manual ?? []).filter(notAllowed), ...regexHits, ...nerAccepted])));

  let jev: ClassifierResult | undefined;
  let candidates = 0;
  if (settings.enableJev && opts.classify) {
    const cands = findCandidates(text, merged, nerLow).filter((c) => !allow.has(allowKey(c.text)) && !isPublicTerm(c.text));
    candidates = cands.length;
    if (cands.length && settings.openrouterKey) {
      t = performance.now();
      emit({ stage: 'jev', status: 'start', candidates: cands.length });
      try {
        jev = await opts.classify(cands, settings);
        merged = mergeEntities([...merged, ...jev.entities.filter((e) => !isPublic(e))]);
        emit({ stage: 'jev', status: 'done', count: jev.entities.length, candidates: cands.length, ms: since(), info: jev.costUsd ? `$${jev.costUsd.toFixed(5)}` : undefined });
      } catch (err) {
        warnings.push(`Jev stage failed, continuing without it: ${(err as Error).message}`);
        emit({ stage: 'jev', status: 'error', candidates: cands.length, info: (err as Error).message });
      }
    } else if (cands.length) {
      warnings.push(`${cands.length} uncertain spans were not checked (no OpenRouter key set).`);
      emit({ stage: 'jev', status: 'skipped', candidates: cands.length, info: 'no OpenRouter key' });
    } else {
      emit({ stage: 'jev', status: 'skipped', candidates: 0, info: 'nothing uncertain' });
    }
  } else {
    emit({ stage: 'jev', status: 'skipped', info: 'disabled' });
  }

  return { entities: merged, candidates, jev, warnings };
}

export interface ApplyOptions {
  /** Values never redacted (session allow list + settings.allowList). */
  allow?: Iterable<string>;
  /** Spans the user marked manually; they win over cached detections. */
  manual?: Entity[];
}

/**
 * The cheap part of redaction: assign placeholders from the conversation's vault, catch repeated
 * occurrences of known values and rebuild the text. No model calls — used directly for prepared vault documents.
 */
export function applyEntities(text: string, detected: Entity[], vault: Vault, opts: ApplyOptions = {}) {
  const allow = new Set([...(opts.allow ?? [])].map(allowKey));
  const notAllowed = (e: Entity) => !allow.has(allowKey(e.text));
  let merged = mergeEntities([...(opts.manual ?? []).filter(notAllowed), ...detected.filter(notAllowed)]);

  // Register placeholders, then catch repeated occurrences of known values.
  for (const e of merged) vault.placeholderFor(e.type, e.text);
  const propagated = propagate(text, vault, merged).filter(notAllowed);
  // mergeEntities ranks regex (= known value) above ner/jev, so overlapping fragments get replaced.
  merged = mergeEntities([...merged, ...propagated]);

  let clean = '';
  let pos = 0;
  const entities: RedactResult['entities'] = [];
  for (const e of merged) {
    const placeholder = vault.placeholderFor(e.type, e.text);
    clean += text.slice(pos, e.start) + placeholder;
    pos = e.end;
    entities.push({ ...e, placeholder });
  }
  clean += text.slice(pos);
  return { clean, entities, propagated: propagated.length };
}

export function statsOf(entities: RedactResult['entities'], propagated: number, candidates: number, jevCostUsd: number): RedactResult['stats'] {
  const count = (s: Entity['source']) => entities.filter((e) => e.source === s).length;
  return {
    regex: count('regex') - propagated,
    ner: count('ner'),
    jev: count('jev'),
    manual: count('manual'),
    propagated,
    candidates,
    jevCostUsd,
  };
}

export async function redact(text: string, opts: RedactOptions): Promise<RedactResult> {
  const d = await detect(text, opts);
  const allow = [...(opts.allow ?? []), ...opts.settings.allowList];
  const { clean, entities, propagated } = applyEntities(text, d.entities, opts.vault, { allow });
  return { clean, entities, stats: statsOf(entities, propagated, d.candidates, d.jev?.costUsd ?? 0), jev: d.jev, warnings: d.warnings };
}

export const PREAMBLE =
  'Note: personal data in this message and its attachments was replaced by placeholders in square brackets, like [PERSON-#] or [EMAIL-#]. ' +
  'Treat each placeholder as the real value, and when you refer to it, repeat the placeholder exactly (including the square brackets). Do not invent real values.';
