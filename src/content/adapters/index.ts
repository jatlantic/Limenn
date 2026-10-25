import { chatgpt } from './chatgpt';
import { claude } from './claude';
import { grok } from './grok';
import type { SiteAdapter } from './types';

export const ADAPTERS: SiteAdapter[] = [claude, chatgpt, grok];

export const pickAdapter = (url: string): SiteAdapter | undefined => {
  const host = new URL(url).hostname;
  return ADAPTERS.find((a) => a.hosts.some((h) => host === h || host.endsWith(`.${h}`)));
};

/** URL patterns for chrome.tabs.query. */
export const CHAT_URL_PATTERNS = ADAPTERS.flatMap((a) => a.hosts.map((h) => `https://${h}/*`));

export const NEW_CHAT_URL: Record<SiteAdapter['id'], string> = {
  claude: 'https://claude.ai/new',
  chatgpt: 'https://chatgpt.com/',
  grok: 'https://grok.com/',
};

export type { SiteAdapter };
