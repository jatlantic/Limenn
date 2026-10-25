import type { SiteAdapter } from './types';

// chatgpt.com: ProseMirror composer (#prompt-textarea) or, in newer layouts, a plain <textarea>
// (#mobile-composer-prompt, seen 2026-10 when logged out). Messages carry data-message-author-role, or in that newer
// layout li[data-message-role] with data-message-complete once the answer has finished.
// While an answer streams, the send button is replaced by a stop button. Verify with scripts/dev/chatgpt-probe.mjs.
export const chatgpt: SiteAdapter = {
  id: 'chatgpt',
  label: 'ChatGPT',
  hosts: ['chatgpt.com', 'chat.openai.com'],
  selectors: {
    composer: ['#prompt-textarea[contenteditable="true"]', 'div.ProseMirror[contenteditable="true"]', '#prompt-textarea', 'textarea#mobile-composer-prompt', 'form textarea'],
    fileInput: ['input[type="file"]:not([accept^="image"])', 'input[type="file"]'],
    sendButton: ['button[data-testid="send-button"]', '#composer-submit-button', 'button[aria-label="Send prompt"]', 'button[aria-label="Send message"]'],
    attachmentThumb: 'form [data-testid*="attachment"], form [class*="file-tile"], form button[aria-label^="Remove file"]',
    attachmentRemove: 'form button[aria-label^="Remove file"], form button[aria-label^="Remove"]',
    assistantMessage: ['[data-message-author-role="assistant"]', 'li[data-message-role="assistant"]'],
    answerBody: '.markdown, [data-assistant-markdown-root], [data-assistant-writing-block]',
    userMessage: '[data-message-author-role="user"], li[data-message-role="user"]',
  },
  isStreaming: (el) =>
    !!document.querySelector('button[data-testid="stop-button"], button[aria-label="Stop streaming"]') ||
    !!el.querySelector('.result-streaming, .streaming-animation') ||
    (el.matches('li[data-message-role]') && !el.hasAttribute('data-message-complete')),
};
