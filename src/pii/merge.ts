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
