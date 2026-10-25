import type { SiteAdapter } from './types';

// grok.com (seen 2026-10): a Tiptap/ProseMirror composer labelled "Ask Grok anything", a submit button with
// data-testid="chat-submit", a hidden file input behind the "Attach" button, and chat bubbles (.message-bubble)
// with data-testid="user-message" for the user's turns. Logged out, Grok shows a sign-up card instead of answering.
export const grok: SiteAdapter = {
  id: 'grok',
  label: 'Grok',
  hosts: ['grok.com'],
  selectors: {
    composer: ['div.tiptap.ProseMirror[contenteditable="true"]', '[contenteditable="true"][aria-label*="Grok"]', 'div.ProseMirror[contenteditable="true"]', 'form textarea'],
    fileInput: ['input[type="file"]'],
    sendButton: ['button[data-testid="chat-submit"]', 'button[aria-label="Submit"]', 'button[type="submit"][aria-label]'],
    attachmentThumb: 'form [data-testid*="attachment"], form [data-testid*="file"], form [class*="file-preview"], form [class*="attachment"]',
    attachmentRemove: 'form button[aria-label^="Remove"], form button[data-testid*="remove"]',
    assistantMessage: ['[data-testid="assistant-message"]', '.message-bubble:not([data-testid="user-message"])'],
    // Not .message-bubble: that is the whole message, and nested bodies are dropped, which would leave nothing.
    answerBody: '.response-content-markdown, .markdown',
    userMessage: '[data-testid="user-message"]',
  },
  // While Grok writes, the submit button turns into a stop button.
  isStreaming: (el) =>
    !!document.querySelector('button[aria-label="Stop"], button[aria-label*="Stop"], button[data-testid="stop-button"]') ||
    !!el.querySelector('[class*="streaming"], [class*="animate-pulse"]'),
};
