import type { EntityType } from './types';

export interface VaultEntry {
  value: string;
  type: EntityType;
}

export interface VaultData {
  byKey: Record<string, string>;
  byPlaceholder: Record<string, VaultEntry>;
  counters: Partial<Record<EntityType, number>>;
}

const normalize = (type: EntityType, v: string) => {
  const s = v.trim().replace(/\s+/g, ' ');
  // Structured identifiers compare without separators: "CH93 0076..." == "CH9300076..."
  if (['IBAN', 'CREDIT_CARD', 'PHONE', 'NATIONAL_ID'].includes(type)) return s.replace(/[\s.\-()]/g, '').toLowerCase();
  return s.toLowerCase();
};

/**
 * Placeholders use hyphens ([PERSON-1], [NATIONAL-ID-2], [PERSON-1-SURNAME]) because claude.ai renders
 * messages as Markdown and underscores (_1_) would turn into italics and split the placeholder.
 * Also matches markdown-escaped \[PERSON-1\] and the older underscore form.
 */
export const PLACEHOLDER_RE = /\\?\[([A-Z]+(?:[-_][A-Z]+)*[-_]\d+(?:[-_](?:FIRST|SURNAME))?)\\?\]/g;
export const placeholderId = (raw: string) => raw.replace(/_/g, '-');

const NAME_LIKE: EntityType[] = ['PERSON', 'ORG', 'LOCATION'];

/**
 * Bidirectional mapping between real values and placeholders.
 * The same value always gets the same placeholder within one vault (= one conversation).
 */
export class Vault {
  data: VaultData;

  constructor(data?: VaultData) {
    this.data = data ?? { byKey: {}, byPlaceholder: {}, counters: {} };
  }

  placeholderFor(type: EntityType, value: string): string {
    const key = `${type}:${normalize(type, value)}`;
    const existing = this.data.byKey[key] ?? this.sameNameOtherType(type, value);
    if (existing) {
      this.preferCasing(existing, value);
      return existing;
    }
    const n = (this.data.counters[type] ?? 0) + 1;
    this.data.counters[type] = n;
    const ph = `[${type.replace(/_/g, '-')}-${n}]`;
    this.data.byKey[key] = ph;
    this.data.byPlaceholder[ph.slice(1, -1)] = { value, type };
    if (type === 'PERSON') this.registerNameParts(ph, value);
    return ph;
  }

  /** NER sometimes types the same name PERSON in one place and ORG/LOCATION in another: keep one placeholder. */
  private sameNameOtherType(type: EntityType, value: string): string | undefined {
    if (!NAME_LIKE.includes(type)) return undefined;
    for (const t of NAME_LIKE) {
      const ph = t !== type ? this.data.byKey[`${t}:${normalize(t, value)}`] : undefined;
      if (ph) return ph;
    }
    return undefined;
  }

  /** "jazmin" first, "Jazmin" later: restore with the properly cased form. */
  private preferCasing(ph: string, value: string) {
    const entry = this.data.byPlaceholder[ph.slice(1, -1)];
    if (!entry || entry.value === value) return;
    const flat = (v: string) => v === v.toLowerCase() || v === v.toUpperCase();
    if (flat(entry.value) && !flat(value) && entry.value.toLowerCase() === value.toLowerCase()) entry.value = value;
  }

  /**
   * "Anna Meier" → also map a standalone "Anna" to [PERSON-1-FIRST] and "Meier" to [PERSON-1-SURNAME],
   * so Claude can tell they refer to the same person.
   */
  private registerNameParts(ph: string, value: string) {
    const parts = value.trim().split(/\s+/).filter((p) => !/^(?:Dr|Prof|med|Herr|Frau|Mr|Mrs|Ms)\.?$/i.test(p));
    if (parts.length < 2) return;
    const aliases: [string, string][] = [
      [parts[0], 'FIRST'],
      [parts[parts.length - 1], 'SURNAME'],
    ];
    for (const [part, suffix] of aliases) {
      if (part.length < 3) continue;
      const key = `PERSON:${normalize('PERSON', part)}`;
      if (this.data.byKey[key]) continue;
      const aph = `${ph.slice(0, -1)}-${suffix}]`;
      this.data.byKey[key] = aph;
      this.data.byPlaceholder[aph.slice(1, -1)] = { value: part, type: 'PERSON' };
    }
  }

  /** [placeholder id, entry] pairs, longest value first. */
  knownEntries(): [string, VaultEntry][] {
    return Object.entries(this.data.byPlaceholder).sort((a, b) => b[1].value.length - a[1].value.length);
  }

  /** All known values (longest first) for propagating detections to other occurrences. */
  knownValues(): VaultEntry[] {
    return Object.values(this.data.byPlaceholder).sort((a, b) => b.value.length - a.value.length);
  }

  lookup(placeholder: string): VaultEntry | undefined {
    return this.data.byPlaceholder[placeholderId(placeholder)];
  }

  restore(text: string): string {
    return text.replace(PLACEHOLDER_RE, (m, id) => this.data.byPlaceholder[placeholderId(id)]?.value ?? m);
  }

  get size() {
    return Object.keys(this.data.byPlaceholder).length;
  }
}
