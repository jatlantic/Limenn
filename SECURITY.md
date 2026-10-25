# Security

## Reporting a vulnerability

Please report vulnerabilities **privately** with GitHub's *Report a vulnerability* button on the **Security** tab. Please don't open a public issue. We aim to reply within 5 working days.

Include the extension version (`chrome://extensions`), your Chrome version, the affected site and the steps to reproduce.

We especially want to hear about:
- personal data that reaches a chat site although limenn reports it as protected
- any network request made by limenn itself
- a web page that reads what limenn keeps, or drives the extension

## How limenn is protected

- **Nothing leaves your computer through limenn.** Detection, document reading and OCR run on your computer. Every model ships inside the package and nothing is downloaded at runtime. The content security policy of the extension pages (`connect-src 'self' blob: data:`) blocks requests to the internet, even if there is a bug.
- **Websites can't look inside.** The limenn bar on chat sites lives in a *closed* shadow root, so the site's scripts can't read the bar or its text field. The extension exposes no web-accessible files, so pages can't detect or fingerprint it by loading its resources.
- **Few permissions.** limenn uses `sidePanel`, `storage`, `offscreen` and `alarms`, plus host access to chatgpt.com, chat.openai.com, claude.ai and grok.com only. It doesn't use `tabs`, `scripting`, `<all_urls>` or `externally_connectable`.
- **Strict messaging.** The background worker ignores other extensions. It accepts a short allowlist of messages from the content script, and only from the supported chat sites. The detection engine only answers limenn's own pages, never a web page or a content script.
- **Pinned models.** `models/models.lock.json` pins every model file to a fixed version and a SHA-256 hash. The build fails if a file differs.
- **No remote code.** Every script ships in the package. The build is minified but not obfuscated, as the Chrome Web Store requires.

## Limits

- **The workspace is the most private way to use limenn.** It's an extension page that no website can access. When you type into the limenn bar on a chat site instead, a site that wanted to could record your keystrokes before limenn cleans them. Browsers give extensions no way to prevent that.
- **Restored answers on the chat site are part of that page.** When limenn puts real values back into an answer *on the chat site*, that site's scripts could read them. In the workspace, answers are restored in limenn's own tab.
- **Detection is very good, but not perfect.** limenn warns when something that looks personal is still in the cleaned text and doesn't send automatically then. Check "what ChatGPT saw" before you send anything highly sensitive.
- **The code is public.** Anyone can read how limenn works, including its rules and models. That's what makes it auditable. It doesn't weaken the protection, because that never depended on keeping the method secret.
- **Chat sites change.** If a site changes its layout, inserting the prompt or reading the answer can break. limenn then shows an error instead of sending anything.
