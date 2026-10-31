import type { RedactResult, Stage, StageEvent } from '../pii/pipeline';
import type { ProtectedRule } from '../pii/custom';
import type { Entity, Settings } from '../pii/types';
import type { VaultData } from '../pii/vault';
import type { IndexEntry } from '../docvault/types';
import type { Risk } from '../pii/guard';

export interface JobFile {
  name: string;
  mime: string;
  /** base64 */
  data: string;
}

export interface JobInput {
  prompt: string;
  files: JobFile[];
  /** Prepared Document Vault docs (by id) — redacted from cache, no model run at send time. */
  vaultDocs?: { id: string; name: string }[];
}

export type StepState = { status: 'pending' | 'running' | 'done' | 'skipped' | 'error'; count?: number; candidates?: number; ms?: number; info?: string };

export interface ItemView {
  id: string;
  kind: 'prompt' | 'file';
  name: string;
  meta?: string;
  original: string;
  clean: string;
  entities: (Entity & { placeholder: string })[];
  stats?: RedactResult['stats'];
  warnings: string[];
  /** Leak guard: risky-looking text that is still in the cleaned version. */
  risks?: Risk[];
  steps: Record<'extract' | Stage, StepState>;
}

export interface JobState {
  id: string;
  tabId?: number;
  source: 'overlay' | 'panel' | 'workspace';
  autoSend: boolean;
  createdAt: number;
  status: 'running' | 'cleaned' | 'sending' | 'sent' | 'error';
  title: string;
  /** Label of the chat site the job is for ("Claude", "ChatGPT"). */
  site?: string;
  items: ItemView[];
  totalMs?: number;
  error?: string;
  /** Protection was switched off: text and documents went out unchanged. */
  unprotected?: boolean;
  /** Claude's reply with the original values filled back in (display only, never sent anywhere). */
  answer?: { text: string; raw?: string; done: boolean };
}

/** Background → offscreen engine */
export interface EngineRun {
  target: 'engine';
  type: 'run';
  job: JobState;
  input: JobInput;
  settings: Settings;
  vault: VaultData | undefined;
  allow: string[];
  /** The user's protected words and shapes (see pii/custom.ts). */
  rules: ProtectedRule[];
}

export interface EngineResult {
  job: JobState;
  vault: VaultData;
}

export const emptySteps = (): ItemView['steps'] => ({
  extract: { status: 'pending' },
  regex: { status: 'pending' },
  ner: { status: 'pending' },
  jev: { status: 'pending' },
});

export const applyEvent = (steps: ItemView['steps'], e: StageEvent) => {
  steps[e.stage] = {
    status: e.status === 'start' ? 'running' : e.status,
    count: e.count,
    candidates: e.candidates,
    ms: e.ms,
    info: e.info,
  };
};

/** Document Vault state for the UI (chrome.storage.local: file names + counts only, no contents). */
export interface DocVaultState {
  folder: string | null;
  access?: 'readwrite' | 'read' | null;
  status: 'idle' | 'scanning' | 'needs-permission' | 'error';
  /** `frac`: share of the whole scan done (0–1); `label`: the current step, e.g. "reading page 3/12 (OCR)". */
  progress?: { path: string; done: number; total: number; frac?: number; label?: string };
  error?: string;
  docs: IndexEntry[];
  scannedAt?: number;
}
export const DOCVAULT_KEY = 'limenn.docvault';
export const emptyDocVault = (): DocVaultState => ({ folder: null, status: 'idle', docs: [] });

export const ALLOW_KEY = 'limenn.allow';
/** Before 1.1: manual marks as [value, type] pairs; migrated into PROTECTED_KEY by loadProtected(). */
export const MANUAL_KEY = 'limenn.manual';
/** chrome.storage.local: the user's "always protect" list (ProtectedRule[]); never leaves this browser. */
export const PROTECTED_KEY = 'limenn.protected';
export const LAST_JOB_KEY = 'limenn.lastJob';
/** chrome.storage.session: recent finished jobs by id, so the side panel can show an earlier workspace message. */
export const JOBS_KEY = 'limenn.jobs';
export const LAST_INPUT_KEY = 'limenn.lastInput';
/** chrome.storage.session: the chat tab the workspace uses per site ({ chatgpt: tabId, claude: tabId }). */
export const WS_TABS_KEY = 'limenn.wsTabs';
/** chrome.storage.session (memory only, cleared when the browser closes): everything asked this session. */
export const HISTORY_KEY = 'limenn.history';
export interface HistoryEntry {
  id: string;
  at: number;
  site?: string;
  source: JobState['source'];
  /** What the user typed (stays in this browser's memory, never sent anywhere). */
  prompt: string;
  files: string[];
  protected: number;
  status: JobState['status'];
}
