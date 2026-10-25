export interface OutgoingFile {
  name: string;
  content: string;
  mime: string;
}

export type ContentRequest =
  | { type: 'limenn:ping' }
  | { type: 'limenn:lastAnswer' }
  | { type: 'limenn:raw'; on: boolean };

export type ContentResponse =
  | { ok: true; text?: string }
  | { ok: false; error: string };

export const VAULT_KEY = 'limenn.vault';
export const SETTINGS_KEY = 'limenn.settings';
/** chrome.storage.local: false when the user switched protection off (all tabs). */
export const ENABLED_KEY = 'limenn.enabled';
