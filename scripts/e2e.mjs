// End-to-end check in a real Chromium (CloakBrowser) with the built extension loaded.
//
//   node scripts/e2e.mjs                 type the sample prompt + PDF into the Limenn bar on claude.ai, send,
//                                        check outgoing requests contain no PII and the answer is restored
//   node scripts/e2e.mjs --no-send       stop after cleaning (Review first mode, nothing is sent)
//   node scripts/e2e.mjs --incognito     use Claude's incognito (private) chat
//   node scripts/e2e.mjs --keep-open     leave the browser open afterwards (demo)
//   node scripts/e2e.mjs --site=chatgpt  run against chatgpt.com instead of claude.ai
//   node scripts/e2e.mjs --workspace     send from the limenn workspace tab instead of the bar (chat site in a
//                                        background tab); reports the chat tab's state when sending fails
//   node scripts/e2e.mjs --workspace --letter   …with the rent-deposit letter (fixtures/rent_letter.txt)
//
// Log in to claude.ai once in the opened window; the profile in .cache/e2e-profile is reused.
// Screenshots go to $E2E_OUT (default: .cache/e2e).
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const cloakPath = process.env.CLOAKBROWSER_PATH ?? '/opt/homebrew/lib/node_modules/cloakbrowser/dist/index.js';
const { launchPersistentContext } = await import(cloakPath);

const root = resolve(import.meta.dirname, '..');
const out = process.env.E2E_OUT ?? resolve(root, '.cache/e2e');
mkdirSync(out, { recursive: true });
const send = !process.argv.includes('--no-send');
const siteId = (process.argv.find((a) => a.startsWith('--site=')) ?? '--site=claude').slice(7);
const SITES = {
  claude: { url: 'https://claude.ai/new', host: 'claude.ai', composer: '[data-testid="chat-input"]', answer: '[data-is-streaming]', done: '[data-is-streaming="false"]', user: '[data-testid="user-message"]', session: /sessionKey/ },
  chatgpt: { url: 'https://chatgpt.com/', host: 'chatgpt.com', composer: '#prompt-textarea, textarea#mobile-composer-prompt', answer: '[data-message-author-role="assistant"]', done: '[data-message-author-role="assistant"]:not(:has(.result-streaming))', user: '[data-message-author-role="user"], li[data-message-role="user"]', session: /session-token/ },
};
const site = SITES[siteId];
if (!site) throw new Error(`unknown --site=${siteId}`);
const incognito = process.argv.includes('--incognito'); // Claude's private chat mode
// --workspace: send from Limenn's own tab; the chat site runs in a background tab the extension opens itself.
// --letter: use the rent-deposit letter (fixtures/rent_letter.txt) instead of the prompt + contract PDF.
const workspace = process.argv.includes('--workspace');
const letter = process.argv.includes('--letter');
const expected = JSON.parse(readFileSync(resolve(root, 'fixtures/expected.json'), 'utf8'));
const prompt = readFileSync(resolve(root, 'fixtures/sample_prompt.txt'), 'utf8');
const allPii = [...expected['sample_prompt.txt'].mustRedact, ...expected['sample_contract.pdf'].mustRedact];

// Chrome can keep running a cached background worker from an older build in a reused profile.
rmSync(resolve(root, '.cache/e2e-profile/Default/Service Worker'), { recursive: true, force: true });

const ctx = await launchPersistentContext({
  userDataDir: resolve(root, '.cache/e2e-profile'),
  headless: false,
  extensionPaths: [resolve(root, 'dist')],
  viewport: null,
  args: ['--window-size=1500,950'],
});

let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 });
const extId = new URL(sw.url()).host;
console.log('extension id', extId);

// Monitor = the side panel page, opened as a tab so the test can read it.
const panel = await ctx.newPage();
await panel.goto(`chrome-extension://${extId}/sidepanel.html`);
await panel.waitForFunction(() => document.querySelector('#model-text')?.textContent?.includes('ready'), null, { timeout: 600_000 });
console.log('panel: model ready');

if (workspace) process.exit(await runWorkspace());

const claude = ctx.pages()[0] === panel ? await ctx.newPage() : ctx.pages()[0];
await claude.bringToFront();
await claude.goto(`${site.url}${incognito && siteId === 'claude' ? '?incognito' : ''}`);
console.log(`Waiting for ${site.host} composer (log in in the window if asked, up to 5 min)…`);
await claude.waitForSelector(site.composer, { timeout: 300_000 });
await claude.waitForSelector('#limenn-bar-host', { state: 'attached' });

const bar = claude.locator('#limenn-bar-host');
if (await bar.locator('.pill').isVisible()) await bar.locator('.pill').click();
await bar.locator('.review').setChecked(!send);
await bar.locator('textarea').fill(prompt);
await bar.locator('input[type=file]').setInputFiles(resolve(root, 'fixtures/sample_contract.pdf'));
await bar.locator('.chip').waitFor();
await claude.screenshot({ path: `${out}/1-bar-filled.png` });

// Capture everything that leaves the browser towards claude.ai.
const outgoing = [];
claude.on('request', (r) => {
  if (r.method() === 'POST' && r.url().includes(site.host)) outgoing.push({ url: r.url(), body: r.postDataBuffer()?.toString('utf8') ?? '' });
});

const t0 = Date.now();
await bar.locator('textarea').press('Enter');
await claude.waitForTimeout(700);
await claude.screenshot({ path: `${out}/2-bar-processing.png` });
await bar.locator('.summary:not([hidden])').waitFor({ timeout: 600_000 });
console.log(`bar: ${await bar.locator('.summary').innerText()} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
await claude.screenshot({ path: `${out}/3-bar-done.png` });

let failures = 0;
const job = await panel.evaluate(() => chrome.storage.session.get('limenn.lastJob').then((r) => r['limenn.lastJob']));
for (const item of job.items) {
  const key = item.kind === 'prompt' ? 'sample_prompt.txt' : 'sample_contract.pdf';
  const leaked = expected[key].mustRedact.filter((s) => item.clean.includes(s));
  console.log(`${item.name}: ${expected[key].mustRedact.length - leaked.length}/${expected[key].mustRedact.length} redacted`, leaked.length ? { leaked } : '', JSON.stringify(item.stats));
  failures += leaked.length;
}
if (job.status === 'error') {
  console.log('job error:', job.error);
  failures++;
}

await panel.setViewportSize({ width: 420, height: 1400 });
await panel.screenshot({ path: `${out}/4-panel-prompt.png`, fullPage: true });
await panel.click('#tabs button:nth-child(2)').catch(() => {});
await panel.screenshot({ path: `${out}/5-panel-pdf.png`, fullPage: true });

if (send) {
  await claude.bringToFront();
  await claude.waitForSelector(site.done, { timeout: 240_000 });
  // ChatGPT: wait for the stop button to disappear too.
  await claude.waitForFunction(() => !document.querySelector('button[data-testid="stop-button"]'), null, { timeout: 240_000 });
  await claude.waitForTimeout(2000);
  const sentText = outgoing.map((o) => o.body).join('\n');
  const leakedOut = allPii.filter((s) => sentText.includes(s));
  const placeholdersSent = (sentText.match(/\[[A-Z-]+-\d+(?:-[A-Z]+)?\]/g) ?? []).length;
  console.log(`outgoing POSTs: ${outgoing.length} (${outgoing.map((o) => new URL(o.url).pathname.split('/').slice(-1)[0]).join(', ')})`);
  console.log(`placeholders in outgoing requests: ${placeholdersSent}, real PII values in outgoing requests: ${leakedOut.length}`, leakedOut);
  failures += leakedOut.length;
  const answer = await claude.$$eval(site.answer, (els) => els.at(-1)?.innerText ?? '');
  const restored = ['Lukas', 'Petra Vogel', 'Brunner'].filter((n) => answer.includes(n));
  const unresolved = answer.match(/\[[A-Z-]+-\d+(?:-[A-Z]+)?\]/g) ?? [];
  console.log('answer shows real names:', restored, '| unresolved placeholders:', unresolved);
  if (!restored.length) failures++;
  await claude.screenshot({ path: `${out}/6-claude-answer.png` });
  await panel.waitForTimeout(1500);
  const panelAnswer = await panel.textContent('#answer').catch(() => '');
  console.log('panel answer box:', panelAnswer ? `${panelAnswer.length} chars, real names: ${['Lukas', 'Petra Vogel'].filter((n) => panelAnswer.includes(n))}` : 'empty');
  await panel.screenshot({ path: `${out}/7-panel-answer.png`, fullPage: true });
}

/**
 * Workspace flow: write in workspace.html, send, and check what the chat site received and what came back. When the
 * send fails, report the chat tab's state (hidden? text in the box? attachment stuck? send button disabled?).
 */
async function runWorkspace() {
  const fixture = letter
    ? { prompt: 'Kannst du mir eine überarbeitete Version schreiben?', file: 'rent_letter.txt', keys: [null, 'rent_letter.txt'] }
    : { prompt, file: 'sample_contract.pdf', keys: ['sample_prompt.txt', 'sample_contract.pdf'] };
  const pii = fixture.keys.filter(Boolean).flatMap((k) => expected[k].mustRedact);
  const outgoing = [];
  // Everything the browser sends out, file uploads included (ChatGPT puts them on another host with PUT).
  ctx.on('request', (r) => {
    if (['POST', 'PUT', 'PATCH'].includes(r.method()) && /^https:/.test(r.url())) outgoing.push({ url: r.url(), body: r.postDataBuffer()?.toString('utf8') ?? '' });
  });
  // The chat tab the extension opens: log in once in the window if asked.
  ctx.on('page', (p) => p.url().includes(site.host) && console.log('chat tab opened:', p.url()));

  // Log in first (the profile in .cache/e2e-profile keeps it): the workspace's own chat tab shares the cookies.
  const login = await ctx.newPage();
  await login.goto(site.url);
  console.log(`Waiting for ${site.host} (log in in the window if asked, up to 5 min)…`);
  await login.waitForSelector(site.composer, { timeout: 300_000 });
  const loggedIn = async () => (await ctx.cookies(site.url)).some((c) => site.session.test(c.name));
  // --login: wait until the user has logged in (uploads only work with an account).
  if (process.argv.includes('--login') && !(await loggedIn())) {
    console.log(`--login: please log in to ${site.host} in the browser window (up to 5 min)…`);
    for (const t0 = Date.now(); !(await loggedIn()) && Date.now() - t0 < 300_000; ) await login.waitForTimeout(2000);
  }
  const account = await loggedIn();
  console.log(`${site.host}: ${account ? 'logged in' : 'NOT logged in (uploads are refused; documents go into the message as text)'}`);
  await login.close();

  const ws = await ctx.newPage();
  await ws.goto(`chrome-extension://${extId}/workspace.html`);
  await ws.click(`.sites button[data-site="${siteId}"]`);
  await ws.fill('#prompt', fixture.prompt);
  await ws.setInputFiles('#files', resolve(root, 'fixtures', fixture.file));
  await ws.screenshot({ path: `${out}/ws-1-filled.png` });
  const t0 = Date.now();
  await ws.click('#send');

  // Done when the turn shows an answer with its copy buttons, an error, or a held-back review.
  const result = await ws
    .waitForFunction(
      () => {
        const t = [...document.querySelectorAll('.turn')].at(-1);
        if (!t) return null;
        if (t.querySelector('.ai-actions')) return 'answered';
        if (t.querySelector('.status.error') && !t.querySelector('.review')) return 'error';
        if (t.querySelector('.review')) return 'held back';
        return null;
      },
      null,
      { timeout: 600_000, polling: 1000 },
    )
    .then((h) => h.jsonValue());
  console.log(`workspace: ${result} after ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  const steps = await ws.$$eval('.turn .status', (els) => els.map((e) => e.textContent.trim()));
  console.log('workspace status:', steps.at(-1));
  await ws.screenshot({ path: `${out}/ws-2-result.png`, fullPage: true });

  let failures = 0;
  const chat = ctx.pages().find((p) => p.url().includes(site.host));
  if (result !== 'answered') {
    failures++;
    if (chat) {
      const state = await chat.evaluate(
        ({ composer }) => {
          const box = document.querySelector(composer);
          const send = document.querySelector('button[data-testid="send-button"], #composer-submit-button, button[aria-label="Send message"], button[aria-label="Send prompt"]');
          return {
            hidden: document.hidden,
            composerChars: (box?.value ?? box?.textContent ?? '').length,
            attachments: document.querySelectorAll('form [data-testid*="attachment"], form [class*="file-tile"], form button[aria-label^="Remove file"]').length,
            sendButton: send ? { disabled: send.disabled, ariaDisabled: send.getAttribute('aria-disabled') } : 'not found',
          };
        },
        { composer: site.composer },
      );
      console.log('chat tab state:', state);
      await chat.screenshot({ path: `${out}/ws-3-chat-tab.png` });
    }
  }

  // Nothing personal may leave: check every request to the chat site.
  const sentText = outgoing.map((o) => o.body).join('\n');
  const leaked = pii.filter((s) => sentText.includes(s));
  const placeholdersSent = (sentText.match(/\[[A-Z_-]+-\d+(?:-[A-Z]+)?\]/g) ?? []).length;
  if (process.env.E2E_DEBUG) for (const o of outgoing) console.log('  out', o.url.slice(0, 110), o.body.length);
  console.log(`outgoing requests: ${outgoing.length}, placeholders in them: ${placeholdersSent}, real PII values in them: ${leaked.length}`, leaked);
  failures += leaked.length;
  // No placeholder seen = the message body was not visible to this check, so "no leaks" would prove nothing.
  if (!placeholdersSent) console.log('(the message body is not visible in the captured requests; checked on the chat page instead)');
  if (letter) {
    const kept = expected['rent_letter.txt'].mustKeep.filter((s) => sentText.includes(s));
    console.log(`amounts/terms kept: ${kept.length}/${expected['rent_letter.txt'].mustKeep.length}`);
  }

  // What the chat site received, read from its own message bubble (the network body is not visible to this script).
  // limenn leaves the user's own message as sent (placeholders only), so this is exactly the text that went out.
  if (chat) {
    const sent = await chat.$$eval(site.user, (els) => {
      const el = els.at(-1);
      return el ? { text: el.innerText, html: el.outerHTML.length } : null;
    });
    if (!sent) {
      console.log('no sent message found in the chat tab');
      failures++;
    } else {
      const leakedDom = pii.filter((s) => sent.text.includes(s));
      const notes = sent.text.split('personal data in this message').length - 1;
      const asFile = /document-\d+\.redacted\.txt/.test(sent.text) || !/<document name=/.test(sent.text);
      const placeholders = (sent.text.match(/\[[A-Z_-]+-\d+(?:-[A-Z]+)?\]/g) ?? []).length;
      console.log(`sent message (from the chat page): ${sent.text.length} chars, ${placeholders} placeholders, note ×${notes}, document ${asFile ? 'as an uploaded file' : 'inline as text'}, real values: ${leakedDom.length}`, leakedDom);
      failures += leakedDom.length;
      if (notes !== 1) failures++;
      if (!placeholders) failures++;
      if (fixture.keys[1]) {
        const docKeep = expected[fixture.keys[1]].mustKeep.filter((s) => sent.text.includes(s)).length;
        if (!asFile) console.log(`document terms kept in the message: ${docKeep}/${expected[fixture.keys[1]].mustKeep.length}`);
      }
    }
  }

  if (result === 'answered') {
    const answer = await ws.$$eval('.turn .msg.ai .text', (els) => els.at(-1)?.innerText ?? '');
    const unresolved = answer.match(/\[[A-Z_-]+-\d+(?:-[A-Z]+)?\]/g) ?? [];
    console.log(`workspace answer: ${answer.length} chars | unresolved placeholders:`, unresolved);
    if (!answer) failures++;
  }
  console.log(failures ? `FAILED (${failures})` : 'OK', '→ screenshots in', out);
  if (!process.argv.includes('--keep-open')) await ctx.close();
  return failures ? 1 : 0;
}

console.log(failures ? `FAILED (${failures})` : 'OK', '→ screenshots in', out);
if (!process.argv.includes('--keep-open')) await ctx.close();
process.exit(failures ? 1 : 0);
