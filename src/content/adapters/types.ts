/**
 * Everything the content script needs to know about one chat site. Selectors are lists of fallbacks,
 * tried in order, so a site redesign usually only needs a new entry at the front.
 */
export interface SiteAdapter {
  id: 'claude' | 'chatgpt' | 'grok';
  /** Shown in the Limenn bar ("Ask Claude privately", step "Claude"). */
  label: string;
  /** Hostnames this adapter runs on. */
  hosts: string[];
  selectors: {
    composer: string[];
    fileInput: string[];
    sendButton: string[];
    /** One element per attached file in the composer (to confirm uploads). */
    attachmentThumb: string;
    attachmentRemove: string;
    assistantMessage: string[];
    /** Rendered markdown inside an assistant message (excludes thinking summaries etc.). */
    answerBody: string;
    userMessage: string;
  };
  /** Is the given (last) assistant message still being generated? */
  isStreaming(msg: HTMLElement): boolean;
}
