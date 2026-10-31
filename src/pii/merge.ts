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

/** "3. OG, " in front of a street: the floor belongs to the address. */
const FLOOR_BEFORE = /(?<![\p{L}\p{N}])(?:\d{1,2}\.[ \t]?(?:OG|UG|Stock|Etage|Obergeschoss)|EG|DG|UG|Erdgeschoss|Dachgeschoss),?[ \t]*$/u;

/**
 * Address parts found by different rules: "Marktstr. 59" + ", " + "47798 Krefeld" (+ a floor in front). Joined into one
 * ADDRESS, so the AI sees one address instead of [ADDRESS-1], [POSTAL_CODE-1] side by side.
 */
export function joinAddressParts(text: string, entities: Entity[]): Entity[] {
  const out: Entity[] = [];
  for (const e of entities) {
    const prev = out[out.length - 1];
    const gap = prev ? text.slice(prev.end, e.start) : '';
    const joinable = prev && prev.type === 'ADDRESS' && (e.type === 'POSTAL_CODE' || e.type === 'LOCATION') && prev.source !== 'manual' && e.source !== 'manual';
    if (joinable && /^,?[ \t]*\n?[ \t]*$/.test(gap)) {
      out[out.length - 1] = { ...prev, end: e.end, text: text.slice(prev.start, e.end), score: Math.min(prev.score, e.score) };
      continue;
    }
    if (e.type === 'ADDRESS' && e.source !== 'manual') {
      const line = text.slice(Math.max(prev?.end ?? 0, e.start - 40), e.start);
      const floor = FLOOR_BEFORE.exec(line);
      if (floor) {
        const start = e.start - floor[0].length;
        out.push({ ...e, start, text: text.slice(start, e.end) });
        continue;
      }
    }
    out.push(e);
  }
  return out;
}
