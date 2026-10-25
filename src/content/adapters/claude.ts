import type { SiteAdapter } from './types';

export const claude: SiteAdapter = {
  id: 'claude',
  label: 'Claude',
  hosts: ['claude.ai'],
  selectors: {
    composer: ['[data-testid="chat-input"]', 'div.ProseMirror[contenteditable="true"]'],
    fileInput: ['input[data-testid="file-upload"]', '#chat-input-file-upload-onpage', 'input[type="file"]'],
    sendButton: ['button[data-testid="chat-input-send"]', 'button[aria-label="Send message"]'],
    attachmentThumb: '[data-testid="file-thumbnail"]',
    attachmentRemove: 'button[data-cds-attachment-remove], button[aria-label^="Remove "]',
    assistantMessage: ['[data-testid="assistant-message"]', '[data-is-streaming]', '.font-claude-response'],
    answerBody: '.standard-markdown, .progressive-markdown',
    userMessage: '[data-testid="user-message"]',
  },
  isStreaming: (el) => (el.closest('[data-is-streaming]') ?? el).getAttribute('data-is-streaming') !== 'false',
};
