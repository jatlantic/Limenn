// Runs on the supported chat sites (claude.ai, chatgpt.com). Three jobs:
//  1. Show the Limenn bar (overlay.ts) where the user types privately.
//  2. Put the cleaned prompt + redacted files into the site's composer and send.
//  3. Restore placeholders like [PERSON-1] in the rendered conversation with the real values (display only).
// All site-specific DOM knowledge lives in the adapters (./adapters) so it is easy to fix when a site changes.
import { type ContentRequest, type ContentResponse, VAULT_KEY } from '../shared/messages';
import { composeMessage } from '../shared/compose';
import type { JobState } from '../shared/jobs';
import { PLACEHOLDER_RE, placeholderId, type VaultData } from '../pii/vault';
import { pickAdapter } from './adapters';
import { mountOverlay } from './overlay';

const found = pickAdapter(location.href);
if (!found) throw new Error(`Limenn: no adapter for ${location.host}`);
const site = found;
const SELECTORS = site.selectors;

const q = <T extends Element>(list: string[], root: ParentNode = document): T | null => {
  for (const s of list) {
    const el = root.querySelector<T>(s);
    if (el) return el;
  }
  return null;
};
const qAll = (list: string[]): Element[] => {
  for (const s of list) {
    const els = [...document.querySelectorAll(s)];
    if (els.length) return els;
  }
  return [];
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(fn: () => T | null | undefined | false, timeout = 15000, every = 150): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error(`Timed out waiting for ${location.host}`);
    await wait(every);
  }
}

// ---------- Composer ----------

// A composer is either a rich-text editor (contenteditable, e.g. ProseMirror) or a plain <textarea>.
const composerText = (el: HTMLElement | null) => (el instanceof HTMLTextAreaElement ? el.value : el?.textContent) ?? '';

/** Set a textarea's value the way typing would, so React-controlled inputs pick it up. */
function setTextareaValue(el: HTMLTextAreaElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

function clearComposer(el: HTMLElement) {
  el.focus();
  if (!composerText(el).trim()) return;
  if (el instanceof HTMLTextAreaElement) return setTextareaValue(el, '');
  document.execCommand('selectAll');
  document.execCommand('delete');
}

function insertText(el: HTMLElement, text: string) {
  el.focus();
  if (el instanceof HTMLTextAreaElement) return setTextareaValue(el, el.value + text);
  // ProseMirror handles paste natively: keeps newlines and lets Claude turn long text into an attachment.
  const dt = new DataTransfer();
  dt.setData('text/plain', text);
  const handled = !el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  if (!handled) document.execCommand('insertText', false, text);
}

/** claude.ai keeps drafts (incl. attachments) — remove anything that didn't come through Limenn. */
async function clearAttachments() {
  for (let i = 0; i < 20; i++) {
    const btn = document.querySelector<HTMLButtonElement>(SELECTORS.attachmentRemove);
    if (!btn) return;
    btn.click();
    await wait(150);
  }
}

async function attachFiles(files: File[]) {
  if (!files.length) return;
  const before = document.querySelectorAll(SELECTORS.attachmentThumb).length;
  const dt = new DataTransfer();
  files.forEach((f) => dt.items.add(f));
  const input = q<HTMLInputElement>(SELECTORS.fileInput);
  if (input) {
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  } else {
    // Fallback: simulate dropping the files onto the composer.
    const target = q<HTMLElement>(SELECTORS.composer) ?? document.body;
    for (const type of ['dragenter', 'dragover', 'drop']) {
      target.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
    }
  }
  // Thumbnail markup differs per site; the file names showing up near the composer count as well.
  const composerArea = () => (q<HTMLElement>(SELECTORS.composer)?.closest('form, fieldset') as HTMLElement | null)?.innerText ?? '';
  await waitFor(
    () => document.querySelectorAll(SELECTORS.attachmentThumb).length >= before + files.length || files.every((f) => composerArea().includes(f.name)),
    8000,
  ).catch(() => {
    throw new Error(`${site.label} did not accept the attachment`);
  });
}

async function pressSend(timeout = 60000) {
  const t0 = Date.now();
  let asked = false;
  const btn = await waitFor(() => {
    const b = q<HTMLButtonElement>(SELECTORS.sendButton);
    if (b && !b.disabled && b.getAttribute('aria-disabled') !== 'true') return b;
    // An upload only finishes while the tab is shown: ask the background to bring it forward for a moment.
    if (!asked && document.hidden && Date.now() - t0 > 12000) {
      asked = true;
      chrome.runtime.sendMessage({ type: 'limenn:wake' }).catch(() => {});
    }
    return null;
  }, timeout).catch(() => {
    throw Object.assign(new Error('The send button stayed disabled (the upload may not have finished).'), { name: 'SendUnavailable' });
  });
  await wait(250);
  btn.click();
  // Confirm: the composer empties once Claude has taken the message.
  await waitFor(() => !composerText(q<HTMLElement>(SELECTORS.composer)).trim(), 10000).catch(() => {
    throw new Error(`${site.label} did not accept the message`);
  });
}

const PENDING_KEY = 'limenn.pendingAnswer';
const WATCH_MS = 10 * 60_000;
/** An answer is complete when the site stopped streaming and the text has been unchanged this long. */
const SETTLE_MS = 1500;

/**
 * After sending: follow the assistant's reply and report it (restored) to the side panel while it streams.
 * The watch is remembered in sessionStorage, because some sites (Grok) reload the page when a new chat gets
 * its own URL, which restarts this script mid-answer; on start, resumePendingAnswer() picks it up again.
 */
function watchAnswer(jobId: string, resume?: { before: number; t0: number }) {
  const before = resume?.before ?? qAll(SELECTORS.assistantMessage).length;
  const started = resume?.t0 ?? Date.now();
  try {
    sessionStorage.setItem(PENDING_KEY, JSON.stringify({ jobId, before, t0: started }));
  } catch {}
  let last = '';
  let lastRaw = '';
  let lastChange = Date.now();
  let lastDone = false;
  let timer: number | undefined;
  let finished = false;
  let fallback = { text: '', since: Date.now() };
  let lastBeat = 0;
  /** Tells the workspace why nothing is showing (it shows this after a while), and whether this tab is hidden. */
  const heartbeat = (messages: number, chars: number, why: string) => {
    if (Date.now() - lastBeat < 4000) return;
    lastBeat = Date.now();
    chrome.runtime.sendMessage({ type: 'limenn:answer-status', jobId, why, messages, before, chars, hidden: document.hidden }).catch(() => {});
  };
  const finish = () => {
    finished = true;
    obs.disconnect();
    clearInterval(poll);
    clearTimeout(timer);
    try {
      sessionStorage.removeItem(PENDING_KEY);
    } catch {}
  };
  const report = async () => {
    // The vault may still be loading right after a page reload; without it the placeholders could not be mapped back.
    await vaultReady.catch(() => {});
    if (finished) return;
    if (Date.now() - started > WATCH_MS) {
      // Give up, but don't leave the workspace on "writing…" forever.
      if (last && !lastDone) chrome.runtime.sendMessage({ type: 'limenn:answer', jobId, text: last, raw: lastRaw, done: true }).catch(() => {});
      return finish();
    }
    const msgs = qAll(SELECTORS.assistantMessage);
    if (msgs.length <= before) return heartbeat(msgs.length, 0, 'no answer bubble yet');
    const el = msgs[msgs.length - 1] as HTMLElement;
    let body = answerText(el);
    if (!body && !site.isStreaming(el)) {
      // The site's markup may have changed so the answer body is not recognised: once the message has stopped
      // changing, fall back to all of its text rather than showing nothing.
      const all = el.innerText.trim();
      if (all !== fallback.text) fallback = { text: all, since: Date.now() };
      if (all && Date.now() - fallback.since >= 3000) body = all;
    }
    const rawText = unrestoreString(body);
    const text = restoreString(rawText);
    if (!text) return heartbeat(msgs.length, el.innerText.length, 'answer bubble found, no text yet');
    if (text !== last) lastChange = Date.now();
    // A site's "still writing" signal can be missed (Grok has no stable one), which used to end the watch after the
    // first chunk. So an answer only counts as complete once it has also stopped changing for a moment.
    const done = !site.isStreaming(el) && Date.now() - lastChange >= SETTLE_MS;
    if (text === last && done === lastDone) return;
    last = text;
    lastRaw = rawText;
    lastDone = done;
    chrome.runtime.sendMessage({ type: 'limenn:answer', jobId, text, raw: rawText, done }).catch(() => {});
    if (done) finish();
  };
  const obs = new MutationObserver(() => {
    clearTimeout(timer);
    timer = window.setTimeout(report, 300);
  });
  obs.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['data-is-streaming'] });
  // Safety net: background tabs throttle timers and some sites update text without a mutation we see, and the
  // "settled" check needs a tick even when nothing changes any more.
  const poll = window.setInterval(report, 1500);
  // The answer may already be complete (fast reply, or after a reload), so no further mutation would trigger a report.
  timer = window.setTimeout(report, 800);
}

function resumePendingAnswer() {
  try {
    const p = JSON.parse(sessionStorage.getItem(PENDING_KEY) ?? 'null') as { jobId: string; before: number; t0: number } | null;
    if (p && Date.now() - p.t0 < WATCH_MS) watchAnswer(p.jobId, p);
    else sessionStorage.removeItem(PENDING_KEY);
  } catch {}
}

async function deliver(job: JobState, send: boolean) {
  const { text, files } = composeMessage(job);
  const composer = await waitFor(() => q<HTMLElement>(SELECTORS.composer), 8000);
  clearComposer(composer);
  await clearAttachments();
  let message = text;
  let attached = false;
  try {
    await attachFiles(files.map((f) => new File([f.content], f.name, { type: f.mime })));
    attached = files.length > 0;
  } catch {
    // Uploads need an account on some sites (ChatGPT logged out): put the cleaned documents into the message instead.
    await clearAttachments();
    message = composeMessage(job, { inline: true }).text;
  }
  insertText(composer, message);
  if (send) {
    // Count answers before sending: some sites (Grok) show the new answer's bubble right away.
    const before = qAll(SELECTORS.assistantMessage).length;
    try {
      await pressSend(attached ? 30000 : 60000);
    } catch (e) {
      // The upload never completed: send the cleaned documents inside the message instead of giving up.
      if (!attached || (e as Error).name !== 'SendUnavailable') throw e;
      await clearAttachments();
      clearComposer(composer);
      insertText(composer, composeMessage(job, { inline: true }).text);
      await pressSend(60000);
    }
    watchAnswer(job.id, { before, t0: Date.now() });
  }
}

/** The visible answer text (without the screen-reader heading and the thinking summary). */
function answerText(el: HTMLElement): string {
  const bodies = [...el.querySelectorAll<HTMLElement>(SELECTORS.answerBody)].filter((b) => !b.parentElement?.closest(SELECTORS.answerBody));
  // No markdown body yet = the model is still thinking; report nothing instead of the thinking summary.
  return bodies.map((b) => b.innerText).join('\n\n').trim();
}

function lastAnswer(): ContentResponse {
  const msgs = qAll(SELECTORS.assistantMessage);
  const last = msgs[msgs.length - 1] as HTMLElement | undefined;
  if (!last) return { ok: false, error: `No ${site.label} answer found on this page.` };
  return { ok: true, text: restoreString(answerText(last)) };
}

// ---------- Restoring placeholders ----------

let vault: VaultData | null = null;

/** Map restored values in a text back to placeholders (the DOM may already show real values). */
function unrestoreString(s: string): string {
  if (!vault) return s;
  const entries = Object.entries(vault.byPlaceholder).sort((a, b) => b[1].value.length - a[1].value.length);
  let out = s;
  for (const [id, v] of entries) {
    if (v.value.length < 3) continue;
    out = out.split(v.value).join(`[${id}]`);
  }
  return out;
}

const restoreString = (s: string) =>
  vault ? s.replace(PLACEHOLDER_RE, (m, id) => vault!.byPlaceholder[placeholderId(id)]?.value ?? m) : s;

const hasHighlights = 'Highlight' in window && !!CSS.highlights;
const highlight = hasHighlights ? new Highlight() : null;
/** Placeholders in the user's own messages: shown as-is (that is what Claude received), marked as protected. */
const protectedMark = hasHighlights ? new Highlight() : null;
if (highlight) CSS.highlights.set('limenn-restored', highlight);
if (protectedMark) CSS.highlights.set('limenn-protected', protectedMark);

/** Restored answer text nodes, so the user can flip between Claude's raw answer and the restored one. */
const restoredNodes = new Map<Text, { raw: string; restored: string; ranges: [number, number][] }>();
let showRaw = false;

function markPlaceholders(node: Text) {
  if (!protectedMark || !vault || !node.nodeValue) return;
  for (const m of node.nodeValue.matchAll(PLACEHOLDER_RE)) {
    if (!vault.byPlaceholder[placeholderId(m[1])]) continue;
    const r = new Range();
    r.setStart(node, m.index!);
    r.setEnd(node, m.index! + m[0].length);
    protectedMark.add(r);
  }
}

function addRestoredHighlights(node: Text, ranges: [number, number][]) {
  if (!highlight) return;
  for (const [s, e] of ranges) {
    const r = new Range();
    r.setStart(node, s);
    r.setEnd(node, e);
    highlight.add(r);
  }
}

/** Flip all restored answers between "as Claude wrote it" (placeholders) and "restored" (real values). */
function setRaw(on: boolean) {
  showRaw = on;
  highlight?.clear();
  protectedMark?.clear();
  for (const [node, v] of restoredNodes) {
    if (!node.isConnected) {
      restoredNodes.delete(node);
      continue;
    }
    node.nodeValue = on ? v.raw : v.restored;
  }
  // Re-mark: placeholders everywhere in raw mode, restored values otherwise (user messages always show placeholders).
  restoreTree(document.body);
  if (!on) for (const [node, v] of restoredNodes) addRestoredHighlights(node, v.ranges);
}

/**
 * Only nodeValue is changed (no elements inserted) so React's reconciliation on claude.ai keeps working;
 * the CSS Custom Highlight API marks restored values without touching the DOM structure.
 */
function restoreNode(node: Text) {
  if (!vault || !node.nodeValue || !node.nodeValue.includes('[')) return;
  const parent = node.parentElement;
  if (!parent || parent.closest('[contenteditable="true"], textarea, script, style')) return;
  if (parent.closest(SELECTORS.userMessage) || showRaw) {
    // The user's own message stays as sent (and so does the answer in "show what Claude wrote" mode):
    // placeholders are only marked.
    markPlaceholders(node);
    return;
  }
  // Note: don't call .test() on the global regex first — matchAll would continue from its lastIndex
  // and silently skip the first placeholder in the node.
  PLACEHOLDER_RE.lastIndex = 0;
  const raw = node.nodeValue;
  let out = '';
  let pos = 0;
  const ranges: [number, number][] = [];
  for (const m of raw.matchAll(PLACEHOLDER_RE)) {
    const entry = vault.byPlaceholder[placeholderId(m[1])];
    if (!entry) continue;
    out += raw.slice(pos, m.index);
    ranges.push([out.length, out.length + entry.value.length]);
    out += entry.value;
    pos = m.index! + m[0].length;
  }
  if (!ranges.length) return;
  out += raw.slice(pos);
  restoredNodes.set(node, { raw, restored: out, ranges });
  node.nodeValue = out;
  addRestoredHighlights(node, ranges);
}

function restoreTree(root: Node) {
  if (root.nodeType === Node.TEXT_NODE) return restoreNode(root as Text);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let n: Node | null;
  while ((n = walker.nextNode())) restoreNode(n as Text);
}

const observer = new MutationObserver((mutations) => {
  if (!vault) return;
  for (const m of mutations) {
    if (m.type === 'characterData') restoreNode(m.target as Text);
    else m.addedNodes.forEach(restoreTree);
  }
});

let vaultReady: Promise<void> = Promise.resolve();
async function loadVault() {
  // Firefox does not expose storage.session to content scripts at all, so even reaching for it can throw.
  const s = await Promise.resolve()
    .then(() => chrome.storage.session.get(VAULT_KEY))
    .catch(() => ({}) as Record<string, unknown>);
  const l = await chrome.storage.local.get(VAULT_KEY).catch(() => ({}) as Record<string, unknown>);
  let stored = ((s as Record<string, unknown>)[VAULT_KEY] ?? l[VAULT_KEY] ?? null) as VaultData | null;
  // Firefox keeps storage.session away from content scripts: the background page hands over the session vault.
  if (!stored) stored = (await chrome.runtime.sendMessage({ type: 'limenn:vault:get' }).catch(() => undefined))?.vault ?? null;
  vault = stored;
  if (vault) restoreTree(document.body);
}

chrome.storage.onChanged.addListener((changes) => {
  if (changes[VAULT_KEY]) loadVault();
});
vaultReady = loadVault().catch(() => {});
observer.observe(document.body, { childList: true, subtree: true, characterData: true });

// ---------- Limenn bar + messaging ----------

const overlay = mountOverlay(
  site,
  deliver,
  async (jobId: string) => {
    const before = qAll(SELECTORS.assistantMessage).length;
    await pressSend();
    watchAnswer(jobId, { before, t0: Date.now() });
  },
  setRaw,
);

resumePendingAnswer();

chrome.runtime.onMessage.addListener((msg: ContentRequest | { type: 'limenn:job'; job: JobState }, sender, sendResponse: (r: ContentResponse) => void) => {
  if (sender.id !== chrome.runtime.id) return false;
  if (msg.type === 'limenn:job') {
    overlay?.onJob(msg.job);
    return false;
  }
  if ((msg as { type: string }).type === 'limenn:vault-changed') {
    vaultReady = loadVault().catch(() => {});
    return false;
  }
  if (msg.type === 'limenn:raw') {
    setRaw(msg.on);
    overlay?.syncRaw(msg.on);
    return false;
  }
  if ((msg as { type: string }).type === 'limenn:deliver') {
    // From the Limenn workspace tab: put the cleaned message in, send it, follow the answer.
    deliver((msg as unknown as { job: JobState }).job, true).then(
      () => sendResponse({ ok: true }),
      (e: Error) => sendResponse({ ok: false, error: e.message }),
    );
    return true;
  }
  if ((msg as { type: string }).type === 'limenn:show-bar') {
    overlay?.show();
    return false;
  }
  if (msg.type === 'limenn:ping') sendResponse({ ok: true });
  else if (msg.type === 'limenn:lastAnswer') sendResponse(lastAnswer());
  return false;
});
