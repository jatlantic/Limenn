# Privacy Policy: limenn

_Last updated: 25 October 2026_

limenn ("the extension") removes personal data from what you type or attach on chatgpt.com, chat.openai.com, claude.ai and grok.com before it is sent, and puts the real values back into the answers you see. This policy explains what the extension does with your data.

## Summary

**The extension does not collect, transmit, sell or share any personal data or usage data.** It has no servers, no analytics, no telemetry and no accounts. All processing happens inside your browser.

## What the extension processes, and where

| Data | What happens to it | Where it stays |
| --- | --- | --- |
| Text you type into the limenn bar or the workspace, and files you attach (PDF, Word, Excel, PowerPoint, e-mail, images, scans) | Documents are read on your computer, scans with on-device text recognition. Personal data is detected by rules and machine-learning models bundled with the extension, then replaced with placeholders such as `[PERSON-1]`. | Only in your browser's memory while it is being processed |
| The session history (what you asked, when, on which site) | Shown in the workspace's *history* panel | `chrome.storage.session`: browser memory only, deleted when the browser closes, or earlier with *clear history now* |
| The placeholder mapping (e.g. `[PERSON-1]` → the real name) | Used to show real values in the chat site's answers | `chrome.storage.session`, deleted when the browser closes. You can turn on *Remember the placeholder vault* in Settings to keep it in `chrome.storage.local` on your computer. |
| Settings and your "never redact" list | Used to configure detection | `chrome.storage.local` on your computer |
| Your protected words and patterns | Always replaced in your text and files | `chrome.storage.local` on your computer. *Export list* in Settings saves them to a file of your choice; that file contains the terms themselves, so keep it private. |
| Document vault folder (optional) | If you link a folder, the extension reads the documents in it, keeps its prepared results in `.limenn/` and writes cleaned copies to `limenn-prepared/` in that folder | Your local disk, plus a copy of the prepared results in the browser's local storage. Chrome asks for your permission to access the folder. |

The extension makes **no network requests of its own**. Its content security policy (`connect-src 'self'`) blocks all outbound connections from its own pages, and the detection models ship inside the extension package.

## What the chat site receives

The extension writes the **cleaned** text, which contains placeholders instead of personal data, into the chat site's message box. When you choose to send it, the chat site (OpenAI, Anthropic or xAI) receives the cleaned text under its own privacy policy. Limenn cannot control what those services do with the text you send them.

Detection is automatic and can miss things. Review the cleaned text, and use the side panel to mark anything that was missed, before you send.

The real values are filled back in only on your computer. In the workspace this happens in limenn's own tab, which no website can access. On the chat site itself, the restored text is part of that page, so the page's own scripts could technically read it. If you switch protection off, text and files go to the chat site unchanged.

## Permissions and why they are needed

- **Access to chatgpt.com, chat.openai.com, claude.ai and grok.com**: to show the limenn bar, put the cleaned prompt into the site's message box (also for messages written in the workspace) and restore placeholders in answers. The extension does not run on any other website.
- **sidePanel**: shows the review panel.
- **storage**: stores settings and the placeholder mapping locally.
- **offscreen**: runs the local detection models, document reading and text recognition in a hidden extension page.
- **alarms**: periodically re-checks the optional document vault folder for new documents.

## Data sharing and sale

None. Use of data complies with the Chrome Web Store User Data Policy, including its Limited Use requirements. No data is transferred to third parties, used for advertising, used to determine creditworthiness, or used for any purpose other than the single purpose described above.

## Deleting your data

- Close the browser to clear the session mapping, or click **Clear vault** in the side panel.
- Remove the extension to delete all of its stored settings and mappings.
- Prepared document vault files are in the folder you linked (`.limenn/` and `limenn-prepared/`). Delete them there.
- The session history disappears when the browser closes, or immediately with *clear history now*.

## Children

The extension is not directed at children under 13 and collects no information from anyone.

## Changes

Changes to this policy are published in this file in the project repository, and the date at the top is updated.

## Contact

Use the issue tracker of the project's GitHub repository, or for security matters see [SECURITY.md](SECURITY.md).
