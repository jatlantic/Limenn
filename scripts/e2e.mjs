// End-to-end check in a real Chromium (CloakBrowser) with the built extension loaded.
//
//   node scripts/e2e.mjs                 type the sample prompt + PDF into the Limenn bar on claude.ai, send,
//                                        check outgoing requests contain no PII and the answer is restored
//   node scripts/e2e.mjs --no-send       stop after cleaning (Review first mode, nothing is sent)
//   node scripts/e2e.mjs --incognito     use Claude's incognito (private) chat
//   node scripts/e2e.mjs --keep-open     leave the browser open afterwards (demo)
//   node scripts/e2e.mjs --site=chatgpt  run against chatgpt.com instead of claude.ai
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
  claude: { url: 'https://claude.ai/new', host: 'claude.ai', composer: '[data-testid="chat-input"]', answer: '[data-is-streaming]', done: '[data-is-streaming="false"]' },
  chatgpt: { url: 'https://chatgpt.com/', host: 'chatgpt.com', composer: '#prompt-textarea, textarea#mobile-composer-prompt', answer: '[data-message-author-role="assistant"]', done: '[data-message-author-role="assistant"]:not(:has(.result-streaming))' },
};
const site = SITES[siteId];
if (!site) throw new Error(`unknown --site=${siteId}`);
const incognito = process.argv.includes('--incognito'); // Claude's private chat mode
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

console.log(failures ? `FAILED (${failures})` : 'OK', '→ screenshots in', out);
if (!process.argv.includes('--keep-open')) await ctx.close();
process.exit(failures ? 1 : 0);
