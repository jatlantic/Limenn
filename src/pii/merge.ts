import type { Entity, Source } from './types';

const PRIORITY: Record<Source, number> = { manual: 4, regex: 3, ner: 2, jev: 1 };

/**
 * Resolve overlapping detections into a non-overlapping, sorted list.
 * Higher-priority sources win; within the same source the longer span wins.
 */
export function mergeEntities(entities: Entity[]): Entity[] {
  const sorted = [...entities].sort(
    (a, b) =>
      PRIORITY[b.source] - PRIORITY[a.source] ||
      b.end - b.start - (a.end - a.start) ||
      a.start - b.start,
  );
  const kept: Entity[] = [];
  for (const e of sorted) {
    if (e.end <= e.start) continue;
    if (kept.some((k) => e.start < k.end && k.start < e.end)) continue;
    kept.push(e);
  }
  return kept.sort((a, b) => a.start - b.start);
}

export function overlapsAny(start: number, end: number, entities: Entity[]): boolean {
  return entities.some((e) => start < e.end && e.start < end);
}

/**
 * Name parts the model returned separately but that belong together: "Anna-Lena Müller" + "-" + "Lüdenscheidt", or
 * "Hans" + " " + "Meier". Joined into one PERSON, so the AI sees one person (and no telltale "[PERSON-1]-[PERSON-2]").
 * The user's own marks are never changed.
 */
export function joinNameParts(text: string, entities: Entity[]): Entity[] {
  const out: Entity[] = [];
  for (const e of entities) {
    const prev = out[out.length - 1];
    const gap = prev ? text.slice(prev.end, e.start) : '';
    if (prev && prev.type === 'PERSON' && e.type === 'PERSON' && prev.source !== 'manual' && e.source !== 'manual' && /^(?:-| )$/.test(gap)) {
      out[out.length - 1] = { ...prev, end: e.end, text: text.slice(prev.start, e.end), score: Math.min(prev.score, e.score), source: prev.source === 'regex' || e.source === 'regex' ? 'regex' : prev.source };
    } else out.push(e);
  }
  return out;
}
