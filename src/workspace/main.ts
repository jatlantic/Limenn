// Limenn workspace: a tab of its own where the user writes and reads. Each message is cleaned on this device,
// sent through the user's ChatGPT, Claude or Grok account in a background tab (content script delivers it), and
// the answer comes back here with the real values filled in. Switching assistants carries the conversation
// so far along, as cleaned text only.
import type { SiteAdapter } from '../content/adapters';
import { DOCVAULT_KEY, type DocVaultState, emptyDocVault, HISTORY_KEY, type HistoryEntry, type JobFile, type JobState } from '../shared/jobs';
import { logoSvg } from '../shared/logo';
import { ENABLED_KEY } from '../shared/messages';
import { loadVault } from '../shared/storage';
import { PLACEHOLDER_RE, placeholderId } from '../pii/vault';
import { SUPPORTED_EXT } from '../docvault/types';
import { customEntities } from '../pii/custom';
import { attachProtect } from '../shared/protect-popover';

type Site = SiteAdapter['id'];
interface Turn {
  id: string;
  site: Site;
  prompt: string;
  files: string[];
  /** The cleaned prompt that went out (placeholders only). */
  clean?: string;
  status: 'running' | 'sent' | 'cleaned' | 'error';
  step?: string;
  protectedCount?: number;
  /** Sent with protection switched off. */
  unprotected?: boolean;
  answer?: string;
  raw?: string;
  /** Last note from the chat tab about why no answer text is there yet. */
  diag?: { why: string; messages: number; hidden: boolean; at: number };
  done?: boolean;
  error?: string;
}
interface Thread {
  id: string;
  startedAt: number;
  site: Site;
  turns: Turn[];
  /** Turn ids each assistant's chat has already seen; the rest is sent along as context. */
  seenBy: Partial<Record<Site, string[]>>;
  newChat: Partial<Record<Site, boolean>>;
}

const THREAD_KEY = 'limenn.wsThread';
/** Earlier conversations of this session (chrome.storage.session: gone when the browser closes). */
const ARCHIVE_KEY = 'limenn.wsArchive';
const LABEL: Record<Site, string> = { chatgpt: 'ChatGPT', claude: 'Claude', grok: 'Grok' };
const ALL_SITES = Object.keys(LABEL) as Site[];
const freshThread = (site: Site, newChat = false): Thread => ({
  id: crypto.randomUUID(),
  startedAt: Date.now(),
  site,
  turns: [],
  seenBy: {},
  newChat: newChat ? Object.fromEntries(ALL_SITES.map((s) => [s, true])) : {},
});
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

$('logo').innerHTML = logoSvg(14, 'ws-logo');
$<HTMLInputElement>('files').accept = `${SUPPORTED_EXT.join(',')},application/pdf,text/*,image/*`;

let thread: Thread = freshThread('chatgpt');
let archive: Thread[] = [];
let files: File[] = [];
let picked: { id: string; name: string }[] = [];
let docVault: DocVaultState = emptyDocVault();
let busy = false;

const save = () => chrome.storage.session.set({ [THREAD_KEY]: thread, [ARCHIVE_KEY]: archive }).catch(() => {});

function toast(msg: string, error = false) {
  const t = $('toast');
  t.textContent = msg;
  t.className = `toast${error ? ' error' : ''}`;
  t.hidden = false;
  clearTimeout((toast as unknown as { h?: number }).h);
  (toast as unknown as { h?: number }).h = window.setTimeout(() => (t.hidden = true), 4500);
}

// ---------- rendering ----------

/** The answer with real values put back, each restored value highlighted. */
async function answerHtml(turn: Turn): Promise<string> {
  if (!turn.raw) return esc(turn.answer ?? '');
  const vault = await loadVault();
  let html = '';
  let pos = 0;
  for (const m of turn.raw.matchAll(new RegExp(PLACEHOLDER_RE.source, 'g'))) {
    const real = vault.lookup(placeholderId(m[1]))?.value;
    html += esc(turn.raw.slice(pos, m.index));
    html += real ? `<mark title="${esc(m[0])}">${esc(real)}</mark>` : esc(m[0]);
    pos = m.index! + m[0].length;
  }
  return html + esc(turn.raw.slice(pos));
}

async function render() {
  document.querySelectorAll<HTMLButtonElement>('.sites button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.site === thread.site)));
  $<HTMLTextAreaElement>('prompt').placeholder = `Ask ${LABEL[thread.site]} privately…`;
  $('open-site').textContent = `open ${LABEL[thread.site]} with limenn ↗`;
  $<HTMLTextAreaElement>('prompt').placeholder = document.body.classList.contains('off') ? `Protection is off: this goes to ${LABEL[thread.site]} unchanged` : `Ask ${LABEL[thread.site]} privately…`;
  $('empty').hidden = thread.turns.length > 0;
  const html = await Promise.all(
    thread.turns.map(async (t) => {
      const status =
        t.status === 'error'
          ? `<div class="status error"><span class="dot"></span>${esc(t.error ?? 'Something went wrong')}</div>`
          : t.status === 'running'
            ? `<div class="status"><span class="dot"></span>${esc(t.step ?? 'cleaning on this device…')}</div>`
            : t.status === 'cleaned'
              ? `<div class="status error"><span class="dot"></span>not sent: something that looks personal is still in the cleaned text. <button data-show-clean="${t.id}" title="Show the cleaned text and what still looks personal">check it</button></div>`
              : t.unprotected
                ? `<div class="status unprotected"><span class="dot"></span>protection off · sent to ${LABEL[t.site]} unchanged</div>`
                : `<div class="status done"><span class="dot"></span>${t.protectedCount ?? 0} values protected · sent to ${LABEL[t.site]} <button data-show-clean="${t.id}" title="Show exactly what was sent, with placeholders">what ${LABEL[t.site]} saw</button></div>`;
      const ai =
        t.answer || t.raw
          ? `<div class="msg ai"><div class="who"><b>${LABEL[t.site]}</b>${t.done ? '' : '· writing…'}</div><div class="text">${await answerHtml(t)}</div>${t.done ? `<div class="ai-actions"><button class="btn sm primary" data-copy="${t.id}" title="Copy the answer with your real data filled in">copy with your real data</button><button class="btn sm ghost" data-copy-raw="${t.id}" title="Copy the answer as the AI wrote it, with placeholders">copy as ${LABEL[t.site]} wrote it</button></div>` : ''}</div>`
          : t.status === 'sent'
            ? `<div class="msg ai"><div class="who"><b>${LABEL[t.site]}</b>· waiting for the answer…</div>${t.diag && Date.now() - t.diag.at < 20000 ? `<div class="text" style="opacity:.7;font-size:12px">${esc(t.diag.why)}${t.diag.hidden ? ' (the chat tab is in the background)' : ''}. <button data-show-chat="${t.site}">show the ${LABEL[t.site]} tab</button></div>` : ''}</div>`
            : '';
      return `<article class="turn" data-id="${t.id}">
        <div class="msg you"><div class="who">you</div><div class="text" title="Click a word to protect it from now on">${esc(t.prompt)}</div>${t.files.length ? `<div class="files">${t.files.map((f) => `<span>${esc(f)}</span>`).join('')}</div>` : ''}</div>
        ${status}
        <pre class="clean" data-clean="${t.id}" title="Click a word that should not have been sent to protect it from now on" hidden>${esc(t.clean ?? '')}</pre>
        ${ai}
      </article>`;
    }),
  );
  $('thread').querySelectorAll('.turn').forEach((n) => n.remove());
  $('thread').insertAdjacentHTML('beforeend', html.join(''));
}

function renderChips() {
  $('chips').hidden = !files.length && !picked.length;
  $('chips').innerHTML =
    picked.map((d) => `<span class="chip">vault · ${esc(d.name)}<button data-unpick="${esc(d.id)}" aria-label="Remove" title="Remove this document from the message">×</button></span>`).join('') +
    files.map((f, i) => `<span class="chip">${esc(f.name)}<button data-file="${i}" aria-label="Remove" title="Remove this file">×</button></span>`).join('');
}

function renderVaultPick() {
  const ready = docVault.docs.filter((d) => d.status === 'ready');
  $('vault-pick').innerHTML = ready.length
    ? ready.map((d) => `<button data-pick="${esc(d.id)}" title="Attach this prepared document (cleaned instantly)" class="${picked.some((p) => p.id === d.id) ? 'on' : ''}"><span>${esc(d.name)}</span><small>${d.entityCount} protected</small></button>`).join('')
    : `<div class="empty">${docVault.folder ? 'No prepared documents yet. Progress is shown in the side panel.' : 'No vault folder linked. Link one in the side panel.'}</div>`;
}

// ---------- sending ----------

const readB64 = (f: File) =>
  new Promise<string>((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(',')[1] ?? '');
    r.onerror = () => rej(r.error);
    r.readAsDataURL(f);
  });

/** Earlier turns this assistant's chat hasn't seen (asked elsewhere, or before a reopened conversation), cleaned text only. */
function contextFor(site: Site): string {
  const seen = new Set(thread.seenBy[site] ?? []);
  const missed = thread.turns.slice(0, -1).filter((t) => !seen.has(t.id) && t.clean && t.status === 'sent' && !t.unprotected);
  if (!missed.length) return '';
  const lines = missed.map((t) => `User: ${t.clean}\n${LABEL[t.site]}: ${t.raw ?? '(no answer)'}`);
  return `Earlier in this conversation (with another assistant):\n\n${lines.join('\n\n')}\n\n---\n\n`;
}

async function send() {
  const ta = $<HTMLTextAreaElement>('prompt');
  const prompt = ta.value.trim();
  if (busy || (!prompt && !files.length && !picked.length)) return;
  const unprotected = (await chrome.storage.local.get(ENABLED_KEY))[ENABLED_KEY] === false;
  busy = true;
  $<HTMLButtonElement>('send').disabled = true;
  const site = thread.site;
  const turn: Turn = { id: crypto.randomUUID(), site, prompt, files: [...picked.map((p) => p.name), ...files.map((f) => f.name)], status: 'running', unprotected };
  thread.turns.push(turn);
  const context = contextFor(site);
  const newChat = !!thread.newChat[site];
  const sending = { files: [...files], picked: [...picked] };
  ta.value = '';
  files = [];
  picked = [];
  renderChips();
  $('vault-pick').hidden = true;
  await render();
  scrollDown();
  try {
    const jf: JobFile[] = await Promise.all(sending.files.map(async (f) => ({ name: f.name, mime: f.type || 'application/octet-stream', data: await readB64(f) })));
    const res = await chrome.runtime.sendMessage({
      type: 'limenn:workspace:send',
      jobId: turn.id,
      site,
      newChat,
      displayPrompt: prompt,
      unprotected,
      input: { prompt: context + prompt, files: jf, vaultDocs: sending.picked },
    });
    if (!res?.ok) throw new Error(res?.error ?? 'Could not send');
    const job: JobState = res.job;
    const p = job.items.find((i) => i.kind === 'prompt');
    // Show only the new message, not the context block sent along with it.
    turn.clean = p ? (context ? p.clean.slice(p.clean.indexOf('---\n\n') + 5) : p.clean) : '';
    turn.protectedCount = job.items.reduce((a, i) => a + i.entities.length, 0);
    turn.status = job.status === 'sent' ? 'sent' : job.status === 'error' ? 'error' : 'cleaned';
    turn.error = job.error;
    if (turn.status === 'sent') {
      // This chat has now seen everything so far (the earlier turns went along as context).
      thread.seenBy[site] = thread.turns.map((t) => t.id);
      thread.newChat[site] = false;
    }
  } catch (e) {
    turn.status = 'error';
    turn.error = (e as Error).message;
  } finally {
    busy = false;
    $<HTMLButtonElement>('send').disabled = false;
    save();
    await render();
    scrollDown();
  }
}

const scrollDown = () => window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });

// ---------- live updates from the engine and the chat tab ----------

chrome.runtime.onMessage.addListener((msg) => {
  const turn = thread.turns.find((t) => t.id === (msg.job?.id ?? msg.jobId));
  if (!turn) return false;
  if (msg.type === 'limenn:job' && turn.status === 'running') {
    const items = (msg.job as JobState).items;
    const running = items.flatMap((i) => Object.entries(i.steps).filter(([, s]) => s.status === 'running').map(([k, s]) => `${i.name.toLowerCase()} · ${s.info ?? k}`));
    turn.step = running[0] ? `cleaning on this device: ${running[0]}` : 'cleaning on this device…';
    render();
  }
  if (msg.type === 'limenn:answer-status') {
    if (!turn.answer) {
      turn.diag = { why: msg.why, messages: msg.messages, hidden: msg.hidden, at: Date.now() };
      render();
    }
    return false;
  }
  if (msg.type === 'limenn:answer') {
    turn.answer = msg.text;
    turn.raw = msg.raw;
    turn.done = msg.done;
    if (msg.done) save();
    render().then(() => msg.done && scrollDown());
  }
  return false;
});

// ---------- controls ----------

document.querySelectorAll<HTMLButtonElement>('.sites button').forEach((b) =>
  b.addEventListener('click', () => {
    thread.site = b.dataset.site as Site;
    save();
    render();
    $('prompt').focus();
  }),
);
$('new-chat').addEventListener('click', () => {
  archiveCurrent();
  thread = freshThread(thread.site, true);
  save();
  render();
  $('prompt').focus();
});
// Protection on/off: the same setting as the Limenn bar and the side panel.
function setEnabledUi(on: boolean) {
  $<HTMLInputElement>('enabled').checked = on;
  $('enabled-label').textContent = on ? 'protect on' : 'protect off';
  document.body.classList.toggle('off', !on);
  $('off-badge').hidden = on;
  render();
}
chrome.storage.local.get(ENABLED_KEY).then((r) => setEnabledUi(r[ENABLED_KEY] !== false));
chrome.storage.local.onChanged.addListener((c) => c[ENABLED_KEY] && setEnabledUi(c[ENABLED_KEY].newValue !== false));
$<HTMLInputElement>('enabled').addEventListener('change', (e) => {
  const on = (e.target as HTMLInputElement).checked;
  chrome.storage.local.set({ [ENABLED_KEY]: on });
  if (!on) toast('Protection is off: messages and files go to the AI unchanged until you switch it back on.', true);
});
$('open-site').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'limenn:workspace:open-site', site: thread.site }));

// ---------- history (this browser session only) ----------

function archiveCurrent() {
  if (!thread.turns.length) return;
  archive = [...archive.filter((t) => t.id !== thread.id), thread].slice(-50);
}

const time = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const SOURCE: Record<HistoryEntry['source'], string> = { workspace: 'workspace', overlay: 'limenn bar', panel: 'side panel' };

async function renderHistory() {
  const entries = (((await chrome.storage.session.get(HISTORY_KEY))[HISTORY_KEY] ?? []) as HistoryEntry[]).slice().reverse();
  const threadOf = (id: string) => [thread, ...archive].find((t) => t.turns.some((x) => x.id === id));
  $('history-list').innerHTML = entries.length
    ? entries
        .map((e) => {
          const th = e.source === 'workspace' ? threadOf(e.id) : undefined;
          const files = e.files.length ? ` · ${e.files.length} file${e.files.length > 1 ? 's' : ''}` : '';
          return `<li><button ${th ? `data-thread="${th.id}"` : 'disabled'} title="${th ? 'Open this conversation' : 'Asked directly on the site'}">
            <span class="meta"><b>${esc(e.site ?? '')}</b><span>${time(e.at)}</span><span>${SOURCE[e.source]}</span><span>${e.protected} protected${files}</span>${e.status === 'error' ? '<span class="danger">failed</span>' : ''}</span>
            <span class="q">${esc(e.prompt || e.files.join(', ') || '(empty)')}</span></button></li>`;
        })
        .join('')
    : '<li class="empty">Nothing asked yet in this session.</li>';
}

function setHistoryOpen(open: boolean) {
  $('history').hidden = !open;
  $('history-btn').setAttribute('aria-expanded', String(open));
  if (open) renderHistory();
}
$('history-btn').addEventListener('click', () => setHistoryOpen($('history').hidden === true));
$('history-close').addEventListener('click', () => setHistoryOpen(false));
document.addEventListener('keydown', (e) => e.key === 'Escape' && setHistoryOpen(false));
$('history-list').addEventListener('click', (e) => {
  const id = (e.target as HTMLElement).closest<HTMLElement>('[data-thread]')?.dataset.thread;
  const found = archive.find((t) => t.id === id);
  if (!found || id === thread.id) return setHistoryOpen(false);
  // Reopen it: continuing starts fresh chats that receive the conversation so far as cleaned context.
  archiveCurrent();
  thread = { ...found, seenBy: {}, newChat: Object.fromEntries(ALL_SITES.map((s) => [s, true])) };
  archive = archive.filter((t) => t.id !== found.id);
  save();
  render().then(scrollDown);
  setHistoryOpen(false);
});
$('history-clear').addEventListener('click', async () => {
  await chrome.storage.session.remove([HISTORY_KEY, ARCHIVE_KEY]);
  archive = [];
  renderHistory();
  toast('History cleared.');
});
chrome.storage.session.onChanged.addListener((c) => c[HISTORY_KEY] && !$('history').hidden && renderHistory());
$('send').addEventListener('click', send);
$('prompt').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    send();
  }
});
$('prompt').addEventListener('input', () => {
  const ta = $<HTMLTextAreaElement>('prompt');
  ta.style.height = 'auto';
  ta.style.height = `${Math.min(ta.scrollHeight, innerHeight * 0.4)}px`;
});
$('attach').addEventListener('click', () => $('files').click());
$<HTMLInputElement>('files').addEventListener('change', (e) => {
  files.push(...((e.target as HTMLInputElement).files ?? []));
  (e.target as HTMLInputElement).value = '';
  renderChips();
});
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => {
  e.preventDefault();
  files.push(...(e.dataTransfer?.files ?? []));
  renderChips();
});
$('chips').addEventListener('click', (e) => {
  const t = e.target as HTMLElement;
  if (t.dataset.file) files.splice(+t.dataset.file, 1);
  if (t.dataset.unpick) picked = picked.filter((p) => p.id !== t.dataset.unpick);
  renderChips();
  renderVaultPick();
});
$('vault').addEventListener('click', () => {
  renderVaultPick();
  $('vault-pick').hidden = !$('vault-pick').hidden;
});
$('vault-pick').addEventListener('click', (e) => {
  const id = (e.target as HTMLElement).closest<HTMLElement>('[data-pick]')?.dataset.pick;
  const doc = docVault.docs.find((d) => d.id === id);
  if (!doc) return;
  picked = picked.some((p) => p.id === doc.id) ? picked.filter((p) => p.id !== doc.id) : [...picked, { id: doc.id, name: doc.name }];
  renderChips();
  renderVaultPick();
});
// Click a word in your message (or in what the AI saw) to protect it, or everything shaped like it, from now on.
attachProtect($('thread'), {
  selector: '.msg.you .text, pre.clean',
  onAdded: (rule, target) => {
    const turn = thread.turns.find((t) => t.id === target.closest<HTMLElement>('.turn')?.dataset.id);
    const sent = turn?.clean != null && customEntities(turn.clean, [rule]).length > 0;
    return sent ? 'This message already went out with it; it is replaced from your next message on.' : 'Applies to every message and file from now on.';
  },
});

/** The answer as plain text with every placeholder replaced by the real value (what the user pastes into an email). */
async function restoredText(turn: Turn): Promise<string> {
  if (!turn.raw) return turn.answer ?? '';
  const vault = await loadVault();
  return turn.raw.replace(new RegExp(PLACEHOLDER_RE.source, 'g'), (m, id) => vault.lookup(placeholderId(id))?.value ?? m);
}

$('thread').addEventListener('click', async (e) => {
  const el = e.target as HTMLElement;
  if (el.dataset.showChat) return void chrome.runtime.sendMessage({ type: 'limenn:workspace:show-chat', site: el.dataset.showChat });
  const copyId = el.dataset.copy ?? el.dataset.copyRaw;
  if (copyId) {
    const turn = thread.turns.find((t) => t.id === copyId);
    if (!turn) return;
    const text = el.dataset.copy ? await restoredText(turn) : (turn.raw ?? turn.answer ?? '');
    await navigator.clipboard.writeText(text);
    const label = el.textContent;
    el.textContent = 'copied ✓';
    setTimeout(() => (el.textContent = label), 1600);
    return;
  }
  const id = el.dataset.showClean;
  if (!id) return;
  const pre = document.querySelector<HTMLElement>(`[data-clean="${id}"]`);
  if (pre) pre.hidden = !pre.hidden;
});

chrome.storage.local.get(DOCVAULT_KEY).then((r) => (docVault = (r[DOCVAULT_KEY] as DocVaultState | undefined) ?? emptyDocVault()));
chrome.storage.local.onChanged.addListener((c) => {
  if (c[DOCVAULT_KEY]) {
    docVault = (c[DOCVAULT_KEY].newValue as DocVaultState | undefined) ?? emptyDocVault();
    if (!$('vault-pick').hidden) renderVaultPick();
  }
});
chrome.storage.session.get([THREAD_KEY, ARCHIVE_KEY]).then((r) => {
  const saved = r[THREAD_KEY] as Thread | undefined;
  if (saved?.id) thread = saved; // threads from before history existed are dropped
  archive = (r[ARCHIVE_KEY] as Thread[] | undefined) ?? [];
  // A turn that was still running when the tab was closed won't finish.
  thread.turns.forEach((t) => t.status === 'running' && Object.assign(t, { status: 'error', error: 'Interrupted' }));
  render();
});
$('prompt').focus();
