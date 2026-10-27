// Side panel = live monitor. Shows every stage of the latest cleaning job (pushed by the background
// worker via chrome.storage.session) and lets the user correct detections, which re-cleans the job.
import type { ModelStatus } from '../engine/model';
import { sameRule } from '../pii/custom';
import { composeMessage, protectedCount } from '../shared/compose';
import { ALLOW_KEY, type ItemView, type JobState, LAST_JOB_KEY, PROTECTED_KEY, type StepState } from '../shared/jobs';
import { logoSvg } from '../shared/logo';
import { PLACEHOLDER_RE } from '../pii/vault';
import { type ContentResponse, ENABLED_KEY } from '../shared/messages';
import { CHAT_URL_PATTERNS, NEW_CHAT_URL, pickAdapter } from '../content/adapters';
import { clearVault, loadProtected, loadVault, saveProtected } from '../shared/storage';
import { attachProtect } from '../shared/protect-popover';
import { initDocVault } from './docvault';
import { RISK_LABEL } from '../pii/guard';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
/** What the user sees as the origin of a detection (no technique names). */
const SOURCE_LABEL: Record<string, string> = { regex: 'format', ner: 'context', jev: 'second look', manual: 'you' };
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

let job: JobState | null = null;
const site = () => job?.site ?? 'Claude';
let active = 'prompt';

$('logo').innerHTML = logoSvg(14, 'lg-top');
// Protection on/off, shared with the Limenn bar in every tab.
const setEnabledUi = (on: boolean) => {
  $<HTMLInputElement>('enabled').checked = on;
  $('enabled-label').textContent = on ? 'on' : 'off';
  document.body.classList.toggle('off', !on);
};
chrome.storage.local.get(ENABLED_KEY).then((r) => setEnabledUi(r[ENABLED_KEY] !== false));
chrome.storage.local.onChanged.addListener((c) => c[ENABLED_KEY] && setEnabledUi(c[ENABLED_KEY].newValue !== false));
$('open-workspace').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'limenn:workspace:open' }));
$<HTMLInputElement>('enabled').addEventListener('change', (e) => chrome.storage.local.set({ [ENABLED_KEY]: (e.target as HTMLInputElement).checked }));
$('empty-art').innerHTML = logoSvg(22, 'lg-empty');

// ---------- toast ----------
let toastTimer: number | undefined;
function toast(msg: string, error = false) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast' + (error ? ' error' : '');
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (t.hidden = true), error ? 6000 : 2500);
}

// ---------- model status ----------
function renderModel(s: ModelStatus) {
  $('model').className = `model ${s.state}`;
  $('model-text').textContent = s.state === 'ready' ? 'ready · runs on this device' : (s.detail ?? '');
  $('model-bar').style.width = s.progress != null ? `${Math.round(s.progress * 100)}%` : '0';
}
renderModel({ state: 'loading', detail: 'Starting local model…' });

// ---------- job rendering ----------
const STATUS_LABEL: Record<JobState['status'], string> = {
  running: 'Cleaning',
  cleaned: 'Cleaned',
  sending: 'Sending',
  sent: 'Sent',
  error: 'Error',
};

function stepRow(n: number, name: string, desc: string, s: StepState | undefined, res: string) {
  const st = s?.status ?? 'pending';
  const mark = st === 'done' ? '✓' : st === 'error' ? '!' : String(n);
  return `<li class="step ${st}"><span class="mark">${mark}</span><div><div class="name">${name}</div><div class="desc">${desc}</div></div><div class="res">${res}</div></li>`;
}

const ms = (s?: StepState) => (s?.ms != null ? `${s.ms < 1000 ? s.ms + ' ms' : (s.ms / 1000).toFixed(1) + ' s'}` : '');
const resText = (s: StepState | undefined, unit: string) => {
  if (!s || s.status === 'pending') return '—';
  if (s.status === 'running') return 'running…';
  if (s.status === 'skipped') return esc(s.info ?? 'skipped');
  if (s.status === 'error') return `<span style="color:var(--red)">${esc(s.info ?? 'failed')}</span>`;
  return `<b>${s.count ?? 0}</b> ${unit}<br>${ms(s)}`;
};

function renderSteps(item: ItemView) {
  const s = item.steps;
  const siteState: StepState = {
    status: job!.status === 'sent' ? 'done' : job!.status === 'sending' ? 'running' : job!.status === 'error' ? 'error' : 'pending',
  };
  const siteRes = job!.status === 'sent' ? 'sent ✓' : job!.status === 'cleaned' ? 'in composer' : job!.status === 'error' ? 'failed' : '—';
  $('steps').innerHTML = [
    item.kind === 'file' ? stepRow(1, 'Read document', 'on this device', s.extract, s.extract.status === 'done' ? `${esc(s.extract.info ?? '')}<br>${ms(s.extract)}` : resText(s.extract, '')) : '',
    stepRow(item.kind === 'file' ? 2 : 1, 'Fixed formats', 'Emails, phones, IBAN, AHV, cards, dates, addresses, IDs', s.regex, resText(s.regex, 'found')),
    stepRow(item.kind === 'file' ? 3 : 2, 'Names in context', 'People, organisations, places — on this device', s.ner, resText(s.ner, 'found') + (s.ner.info && s.ner.status === 'done' ? `<br>${esc(s.ner.info)}` : '')),
    stepRow(item.kind === 'file' ? 4 : 3, site(), `Cleaned text + files handed to ${site()}`, siteState, siteRes),
  ].join('');
}

function renderJob() {
  if (!job) {
    $('empty').hidden = false;
    $('job').hidden = true;
    return;
  }
  $('empty').hidden = true;
  $('job').hidden = false;
  $('job-title').textContent = job.title;
  document.querySelectorAll('.site-name').forEach((el) => (el.textContent = site()));
  $('job-meta').textContent = `Latest request · ${new Date(job.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}${job.totalMs ? ` · cleaned in ${(job.totalMs / 1000).toFixed(1)} s` : ''}`;
  const status = $('job-status');
  status.className = `status ${job.status}`;
  status.textContent = STATUS_LABEL[job.status];
  const total = protectedCount(job);
  $('job-count').textContent = job.items.length ? `${total} item${total === 1 ? '' : 's'} protected` : '';

  if (!job.items.length) {
    $('tabs').innerHTML = '';
    $('steps').innerHTML = stepRow(1, 'Preparing', 'Reading your input', { status: 'running' }, '');
    $('original').innerHTML = '';
    $('clean-out').innerHTML = '';
    $('types').innerHTML = '';
    return;
  }
  if (!job.items.some((i) => i.id === active)) active = job.items[0].id;
  $('tabs').innerHTML = job.items
    .map((i) => `<button role="tab" data-tab="${esc(i.id)}" aria-selected="${i.id === active}" title="${esc(i.name)}">${esc(i.name)}<span class="n">${i.entities.length || ''}</span></button>`)
    .join('');
  const item = job.items.find((i) => i.id === active)!;
  renderSteps(item);

  // highlighted original
  let html = '';
  let pos = 0;
  for (const e of item.entities) {
    html += esc(item.original.slice(pos, e.start));
    html += `<span class="m ${e.source}" data-value="${esc(e.text)}" title="${esc(e.type)} → ${esc(e.placeholder)} · ${SOURCE_LABEL[e.source] ?? e.source} ${(e.score * 100).toFixed(0)}% · click to send unchanged">${esc(e.text)}</span>`;
    pos = e.end;
  }
  html += esc(item.original.slice(pos));
  $('original').innerHTML = html || '<span style="color:var(--faint)">Waiting for text…</span>';

  const counts = new Map<string, number>();
  for (const e of item.entities) counts.set(e.type, (counts.get(e.type) ?? 0) + 1);
  $('types').innerHTML = [...counts].sort((a, b) => b[1] - a[1]).map(([t, n]) => `<span>${esc(t)} <b>${n}</b></span>`).join('');

  const clean = item.kind === 'prompt' && item.clean ? composeMessage(job).text : item.clean;
  $('clean-out').innerHTML = esc(clean).replace(new RegExp(PLACEHOLDER_RE.source, 'g'), (m) => `<span class="ph">${m}</span>`);

  renderAnswer();

  $('warnings').innerHTML = job.items.flatMap((i) => [
    ...(i.risks ?? []).filter((r) => r.severity === 'high').map((r) => `<li><b>Possible leak</b> in ${esc(i.name)}: “${esc(r.text.slice(0, 80))}” — ${RISK_LABEL[r.reason]}. Select it in the text above to protect it.</li>`),
    ...i.warnings.map((w) => `<li>${esc(i.name)}: ${esc(w)}</li>`),
  ]).join('') + (job.error ? `<li>${esc(job.error)}</li>` : '');
}

let vaultValues: string[] = [];
let vaultEntries: [string, string][] = [];
let showRawAnswer = false;

function renderAnswer() {
  const a = job?.answer;
  $('answer-box').hidden = !a;
  if (!a) return;
  $('answer-state').className = `live${a.done ? ' done' : ''}`;
  $('answer-state').textContent = a.done ? 'complete' : 'streaming…';
  $('ans-restored').setAttribute('aria-selected', String(!showRawAnswer));
  $('ans-raw').setAttribute('aria-selected', String(showRawAnswer));
  if (showRawAnswer) {
    $('answer-note').textContent = `This is exactly what ${site()} wrote. It never saw your real data, only these placeholders.`;
    $('answer').innerHTML = esc(a.raw ?? toRaw(a.text)).replace(new RegExp(PLACEHOLDER_RE.source, 'g'), (m) => `<span class="ph">${m}</span>`);
    return;
  }
  $('answer-note').textContent = `Highlighted values were filled in by Limenn on this device. ${site()} wrote placeholders there.`;
  // Highlight the values Limenn put back in.
  let html = esc(a.text);
  for (const v of vaultValues) {
    if (v.length < 3) continue;
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${esc(v).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'gu');
    html = html.replace(re, (m) => `<mark>${m}</mark>`);
  }
  $('answer').innerHTML = html.replace(/<mark>([^<]*)<mark>([^<]*)<\/mark>([^<]*)<\/mark>/g, '<mark>$1$2$3</mark>');
}

/** Fallback: map restored values back to their placeholders. */
const toRaw = (text: string) => vaultEntries.reduce((t, [ph, v]) => (v.length < 3 ? t : t.split(v).join(`[${ph}]`)), text);

async function setRawAnswer(on: boolean) {
  showRawAnswer = on;
  renderAnswer();
  // Flip the answer on the chat page too, so both views agree.
  if (job?.tabId != null) chrome.tabs.sendMessage(job.tabId, { type: 'limenn:raw', on }).catch(() => {});
}
$('ans-restored').addEventListener('click', () => setRawAnswer(false));
$('ans-raw').addEventListener('click', () => setRawAnswer(true));

$('copy-answer-inline').addEventListener('click', async () => {
  if (!job?.answer) return;
  await navigator.clipboard.writeText(showRawAnswer ? (job.answer.raw ?? toRaw(job.answer.text)) : job.answer.text);
  toast('Answer copied with real values.');
});

// ---------- corrections ----------
// Corrections ("send unchanged" / "protect") are remembered across browser restarts in chrome.storage.local.
async function sessionList<T>(key: string): Promise<T[]> {
  return ((await chrome.storage.local.get(key))[key] as T[]) ?? [];
}

async function reclean() {
  const res = await chrome.runtime.sendMessage({ type: 'limenn:reclean' });
  if (!res?.ok) toast(res?.error ?? 'Re-clean failed', true);
}

$('tabs').addEventListener('click', (e) => {
  const id = (e.target as HTMLElement).closest<HTMLElement>('[data-tab]')?.dataset.tab;
  if (id) {
    active = id;
    renderJob();
  }
});

$('original').addEventListener('click', async (e) => {
  const value = (e.target as HTMLElement).dataset.value?.trim();
  if (!value) return;
  const allow = await sessionList<string>(ALLOW_KEY);
  // A word the user protected by hand stops being protected; a shape keeps working for every other value.
  await saveProtected((await loadProtected()).filter((r) => !sameRule(r, { kind: 'words', value })));
  await chrome.storage.local.set({ [ALLOW_KEY]: [...new Set([...allow, value])] });
  toast(`“${value}” will be sent unchanged.`);
  renderKept();
  reclean();
});

// Click any other word (or select a few) to protect it, or everything shaped like it, from now on.
attachProtect(document.body, {
  selector: '#original, #clean-out',
  onAdded: () => {
    renderKept();
    reclean();
    return 'Re-cleaning…';
  },
  onRemoved: () => {
    renderKept();
    reclean();
  },
});

async function renderKept() {
  const allow = await sessionList<string>(ALLOW_KEY);
  const rules = await loadProtected();
  $('kept-box').hidden = !allow.length && !rules.length;
  $('kept-allow').hidden = !allow.length;
  $('kept').innerHTML = allow.map((v) => `<button data-undo="${esc(v)}" title="Protect again">${esc(v)} ×</button>`).join('');
  $('protected-count').textContent = rules.length ? `${rules.length} protected word${rules.length === 1 ? '' : 's'} & pattern${rules.length === 1 ? '' : 's'}` : '';
}
$('manage-protected').addEventListener('click', () => chrome.runtime.openOptionsPage());
chrome.storage.local.onChanged.addListener((c) => (c[PROTECTED_KEY] || c[ALLOW_KEY]) && renderKept());
$('kept').addEventListener('click', async (e) => {
  const v = (e.target as HTMLElement).dataset.undo;
  if (!v) return;
  await chrome.storage.local.set({ [ALLOW_KEY]: (await sessionList<string>(ALLOW_KEY)).filter((x) => x !== v) });
  renderKept();
  reclean();
});

// ---------- vault ----------
async function renderMapping() {
  const vault = await loadVault();
  const entries = Object.entries(vault.data.byPlaceholder);
  vaultValues = entries.map(([, v]) => v.value).sort((a, b) => b.length - a.length);
  vaultEntries = entries.map(([ph, v]) => [ph, v.value] as [string, string]).sort((a, b) => b[1].length - a[1].length);
  $('map-count').textContent = String(entries.length);
  $('mapping').innerHTML = entries.map(([ph, v]) => `<tr><td>[${esc(ph)}]</td><td>${esc(v.value)}</td></tr>`).join('');
}

$('clear-map').addEventListener('click', async () => {
  await clearVault();
  renderMapping();
  toast('Vault cleared. Older answers keep their placeholders.');
});

// ---------- chat tab helpers ----------
async function chatTab(): Promise<chrome.tabs.Tab | undefined> {
  const [current] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (current?.url && pickAdapter(current.url)) return current;
  const [any] = await chrome.tabs.query({ url: CHAT_URL_PATTERNS, currentWindow: true });
  return any;
}

document.querySelectorAll<HTMLButtonElement>('[data-open-site]').forEach((btn) =>
  btn.addEventListener('click', async () => {
    const id = btn.dataset.openSite as keyof typeof NEW_CHAT_URL;
    const tab = await chatTab();
    if (tab?.id && tab.url && pickAdapter(tab.url)?.id === id) chrome.tabs.update(tab.id, { active: true });
    else chrome.tabs.create({ url: NEW_CHAT_URL[id] });
  }),
);

$('copy-answer').addEventListener('click', async () => {
  const tab = await chatTab();
  if (!tab?.id) return toast('Open a ChatGPT, Claude or Grok conversation first.', true);
  const res: ContentResponse | undefined = await chrome.tabs.sendMessage(tab.id, { type: 'limenn:lastAnswer' }).catch(() => undefined);
  if (!res?.ok) return toast(res && !res.ok ? res.error : 'Reload the chat tab once after installing Limenn.', true);
  await navigator.clipboard.writeText(res.text ?? '');
  toast('Answer copied with real values restored.');
});

$('copy').addEventListener('click', async () => {
  if (!job) return;
  const item = job.items.find((i) => i.id === active);
  const text = item?.kind === 'prompt' ? composeMessage(job).text : (item?.clean ?? '');
  await navigator.clipboard.writeText(text);
  toast('Cleaned text copied.');
});

$('open-options').addEventListener('click', () => chrome.runtime.openOptionsPage());

// ---------- live updates ----------
chrome.storage.session.onChanged.addListener((changes) => {
  if (changes[LAST_JOB_KEY]) {
    job = changes[LAST_JOB_KEY].newValue as JobState;
    renderJob();
  }
  if (changes['limenn.vault']) renderMapping();
});
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'limenn:model') renderModel(msg.status);
  if (msg?.type === 'limenn:raw-state') {
    showRawAnswer = !!msg.on;
    renderAnswer();
  }
  if (msg?.type === 'limenn:job' && msg.job) {
    job = msg.job;
    renderJob();
  }
  return false;
});

(async () => {
  job = ((await chrome.storage.session.get(LAST_JOB_KEY))[LAST_JOB_KEY] as JobState) ?? null;
  renderJob();
  renderMapping();
  renderKept();
  initDocVault(toast);
  // Make sure the engine is up and the model loaded; reports progress via limenn:model.
  chrome.runtime.sendMessage({ type: 'limenn:warm' }).then((r) => r?.ok && renderModel({ state: 'ready' }), () => {});
})();
