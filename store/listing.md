# Chrome Web Store submission kit

Paste these into the Developer Dashboard. Every field below matches what the extension actually does, which is what reviewers check.

## Store listing

**Name:** limenn

**Summary (≤132 characters, same as the manifest):**
Removes personal data from prompts and files on your device before they reach ChatGPT or Claude, and restores it in answers.

**Category:** Productivity (alternative: Privacy & Security, if your dashboard offers it)

**Language:** English

**Description:**

> Use ChatGPT and Claude without handing over personal data.
>
> limenn adds a small bar to chatgpt.com and claude.ai. Type your prompt there, attach files if you need to, and Limenn replaces names, e-mail addresses, phone numbers, IBANs, social-security and ID numbers, addresses, health details and similar data with placeholders such as [PERSON-1] before anything is sent. When the answer arrives, Limenn fills the real values back in, on your screen only.
>
> EVERYTHING RUNS ON YOUR COMPUTER
> • Detection uses pattern rules and two compact AI models that ship inside the extension and run in your browser.
> • The extension makes no network requests of its own, and its security policy blocks them outright.
> • No accounts, no analytics, no tracking. The placeholder mapping is deleted when you close the browser.
>
> FEATURES
> • Consistent placeholders across your prompt and all attached files
> • PDF, Word (.docx) and text files are redacted locally before upload
> • Side panel to review every detection: click to keep a value, select text to protect more
> • Your own protected list: click a word once to replace it from then on, or protect everything shaped like it (e.g. EMP-#####); stored only in your browser, with export/import
> • Optional Document Vault: link a folder once and its documents are prepared in advance
> • Multilingual (English, German, French, Italian and more), with Swiss and EU formats
>
> PLEASE NOTE
> Automatic detection can miss things. Review the cleaned prompt before sending: Limenn warns you about likely leaks.
>
> Free for personal and other noncommercial use (PolyForm Noncommercial 1.0.0). Source code: <GitHub URL>
>
> Not affiliated with or endorsed by OpenAI or Anthropic. ChatGPT is a trademark of OpenAI, and Claude is a trademark of Anthropic.

**Graphics to upload:**
- Icon 128×128: `public/icons/128.png`
- At least one screenshot at 1280×800 or 640×400 (PNG/JPEG). Suggested set:
  1. The Limenn bar on chatgpt.com with a prompt typed in
  2. The cleaned prompt in ChatGPT's box ("4 protected")
  3. A restored answer with highlighted values
  4. The side panel showing the detections
  5. The settings page ("Everything runs on this computer")
- Small promo tile 440×280 (optional but recommended)

**Homepage URL:** the GitHub repository URL
**Support URL:** `<GitHub URL>/issues`

## Privacy practices tab

**Single purpose:**
> Protect personal data when using AI chat websites: the extension detects personal data in prompts and files on the user's device, replaces it with placeholders before it is submitted to ChatGPT or Claude, and restores the original values in the displayed answers.

**Permission justifications:**

| Permission | Justification |
| --- | --- |
| `sidePanel` | Shows the review panel, where users see what was detected and can keep or protect individual values. |
| `storage` | Stores the user's settings locally, and the placeholder-to-value mapping in session storage, so that answers can be restored. Nothing is synced or transmitted. |
| `offscreen` | Runs the bundled on-device detection models (ONNX Runtime WebAssembly) and PDF text extraction in an offscreen document, because service workers cannot host them. |
| `alarms` | Rescans the optional local Document Vault folder every few minutes, so that new documents are prepared before the user needs them. |
| Host `https://chatgpt.com/*`, `https://chat.openai.com/*` | Injects the Limenn bar, places the cleaned prompt and redacted files into ChatGPT's message box, and restores placeholders in the displayed answers. |
| Host `https://claude.ai/*` | Same as above, for Claude. |

**Remote code:** No, I am not using remote code. (All JavaScript and WebAssembly ships in the package. The model weights are bundled data files.)

**Data usage:** tick **none** of the data categories. The extension processes the content the user types (user-generated website content) locally to transform it, but does not collect it. Under the Chrome Web Store definition, nothing is "collected" because nothing leaves the device or is retained beyond the browser session by default.

Certify all three:
- [x] I do not sell or transfer user data to third parties, outside of the approved use cases
- [x] I do not use or transfer user data for purposes that are unrelated to my item's single purpose
- [x] I do not use or transfer user data to determine creditworthiness or for lending purposes

**Privacy policy URL:** `<GitHub URL>/blob/main/PRIVACY.md` (or a page on limenn.io with the same text)

## Notes for the reviewer (optional field)

> All detection runs locally. The package is about 400 MB because it bundles two ONNX models: `models/gliner-web-q8.onnx` (GLiNER multi-PII, Apache-2.0) and `models/Xenova/distilbert-base-multilingual-cased-ner-hrl` (AFL-3.0). Their SHA-256 hashes are listed in `models/models.lock.json` in the source repository. The extension pages' CSP restricts `connect-src` to `'self'`, and the extension makes no network requests. `'wasm-unsafe-eval'` is required for ONNX Runtime WebAssembly. To test: open chatgpt.com (no login needed), type "Write to Anna Meier, anna@example.ch" into the Limenn bar at the top and press Enter.

## Before submitting

- [ ] Run `npm run release` and upload `release/limenn-<version>.zip`
- [ ] Make the GitHub repository public, so the privacy policy and support URLs resolve
- [ ] Replace `<GitHub URL>` above
- [ ] Take the screenshots (1280×800)
- [ ] Complete developer account verification (one-time fee, verified contact email)
