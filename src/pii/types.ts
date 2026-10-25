export type EntityType =
  | 'PERSON'
  | 'ORG'
  | 'LOCATION'
  | 'ADDRESS'
  | 'EMAIL'
  | 'PHONE'
  | 'IBAN'
  | 'CREDIT_CARD'
  | 'NATIONAL_ID'
  | 'ID_NUMBER'
  | 'DATE'
  | 'IP'
  | 'URL'
  | 'POSTAL_CODE'
  | 'HEALTH'
  | 'FINANCIAL';

export type Source = 'regex' | 'ner' | 'jev' | 'manual';

export interface Entity {
  start: number;
  end: number;
  text: string;
  type: EntityType;
  source: Source;
  score: number;
}

/** A span that stages 1+2 were unsure about, to be decided by the classifier. */
export interface Candidate {
  start: number;
  end: number;
  text: string;
  context: string;
  hint?: EntityType;
}

/** Result of an optional stage-3 classifier for uncertain spans (implemented by jev.ts in the desktop app). */
export interface ClassifierResult {
  entities: Entity[];
  costUsd: number;
  decisions: { candidate: Candidate; answer?: { choice: string; probabilities?: Record<string, number> } }[];
}

export type Classifier = (candidates: Candidate[], settings: Settings) => Promise<ClassifierResult>;

export interface Settings {
  openrouterKey: string;
  jevModel: string;
  jevThreshold: number;
  nerModel: string;
  nerThreshold: number;
  enableNer: boolean;
  enableJev: boolean;
  /** Terms never redacted (assistant names, your own product names, ...). */
  allowList: string[];
  /** Keep the placeholder mapping across browser restarts (stored locally, never sent anywhere). */
  persistMapping: boolean;
  /** 'context': only amounts next to salary/rent/debt… words; 'all': every money amount. */
  financialPolicy: 'context' | 'all';
  /** Thresholds for combining a token model with a span model (see ensemble.ts); optional overrides. */
  ensemble?: Partial<import('./ensemble').EnsembleThresholds>;
  /** Next-generation span detector (local, CPU): off, only for vault documents (prepared ahead of time), or everywhere. */
  nextGen: 'off' | 'vault' | 'all';
}

export const DEFAULT_SETTINGS: Settings = {
  openrouterKey: '',
  jevModel: 'typesafe/jev-1.13',
  jevThreshold: 0.6,
  nerModel: 'Xenova/distilbert-base-multilingual-cased-ner-hrl',
  nerThreshold: 0.85,
  enableNer: true,
  enableJev: true,
  allowList: ['Claude', 'Anthropic', 'ChatGPT', 'OpenAI'],
  persistMapping: false,
  financialPolicy: 'context',
  nextGen: 'vault',
};
