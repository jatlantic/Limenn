// The Limenn bar: a search-style input floating over the chat site. Text + files typed here are cleaned by the
// extension engine first; only the cleaned version is put into the site's composer.
import { protectedCount } from '../shared/compose';
import { DOCVAULT_KEY, type DocVaultState, emptyDocVault, type JobFile, type JobState, type StepState } from '../shared/jobs';
import { logoSvg } from '../shared/logo';
import { ENABLED_KEY, SETTINGS_KEY } from '../shared/messages';
import { loadSettings } from '../shared/storage';
import type { Settings } from '../pii/types';
import { SUPPORTED_EXT } from '../docvault/types';
import type { SiteAdapter } from './adapters';
import css from './overlay.css';

type Deliver = (job: JobState, send: boolean) => Promise<void>;
type ClickSend = (jobId: string) => Promise<void>;
type SetRaw = (on: boolean) => void;

const ICON = {
  clip: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m21.4 11.1-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5"/></svg>',
  send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
  min: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 12h12"/></svg>',
  file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>',
  vault: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="12" cy="12" r="3"/><path d="M12 9V7M12 17v-2M15 12h2M7 12h2"/></svg>',
  shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/></svg>',
};

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

const readB64 = (f: File) =>
  new Promise<string>((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(',')[1] ?? '');
    r.onerror = () => rej(r.error);
    r.readAsDataURL(f);
  });

const store = {
  get: (k: string) => {
    try {
      return localStorage.getItem(`limenn.${k}`);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string) => {
    try {
      localStorage.setItem(`limenn.${k}`, v);
    } catch {}
  },
};

export function mountOverlay(site: SiteAdapter, deliver: Deliver, pressSend: ClickSend, setRaw: SetRaw) {
  const L = site.label;
  if (document.getElementById('limenn-bar-host')) return;
  const host = document.createElement('div');
  host.id = 'limenn-bar-host';
  // Closed: the chat site's own scripts cannot reach into the bar and read what is typed there.
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `<style>${css}</style>
    <div class="shell" part="shell">
      <div class="bar">
        <div class="brand handle" title="Drag anywhere on the bar to move it · double-click to reset"><span class="grip" aria-hidden="true">⠿</span><span class="word">limenn</span>${logoSvg(13, 'limenn-g1')}</div>
        <div class="divider"></div>
        <textarea rows="1" placeholder="Ask ${L} privately — personal data never leaves your browser"></textarea>
        <span class="off-note">Protection is off. Type in ${L}'s own box as usual; nothing is changed.</span>
        <input type="file" multiple accept="${SUPPORTED_EXT.join(',')},application/pdf,text/*,image/*" hidden />
        <button class="icon vault-btn" title="Prepared documents from your vault folder" aria-label="Vault documents" aria-expanded="false">${ICON.vault}<span class="n" hidden></span></button>
        <button class="icon attach" title="Attach PDF or text file" aria-label="Attach file">${ICON.clip}</button>
        <button class="icon minimize" title="Minimize" aria-label="Minimize">${ICON.min}</button>
        <button class="send" aria-label="Clean and send" title="Remove personal data on this computer, then put the cleaned text into the chat (Enter)">Send ${ICON.send}</button>
      </div>
      <div class="chips" hidden></div>
      <div class="vault-pop" hidden>
        <input class="vault-q" type="search" placeholder="Search prepared documents" aria-label="Search vault documents" />
        <div class="vault-list" role="listbox" aria-multiselectable="true"></div>
        <div class="vault-foot"><span class="vault-status"></span><span class="spacer"></span><button class="link vault-manage" title="Link or manage your document folder in the side panel">Manage vault ↗</button></div>
      </div>
      <div class="foot">
        <div class="idle-info"></div>
        <div class="steps" hidden></div>
        <div class="summary" hidden></div>
        <span class="spacer"></span>
        <label class="toggle" title="Show the cleaned prompt in ${L}'s composer and let you review before sending"><input type="checkbox" class="review" /> Review first</label>
        <label class="toggle protect" title="Switch Limenn's protection on or off (all tabs)"><input type="checkbox" class="enabled" checked /> Protect</label>
        <button class="link workspace" title="Write and read in Limenn's own tab">Workspace ↗</button>
        <button class="link details" title="Open the side panel: what was found and exactly what the AI received">Details ↗</button>
      </div>
    </div>
    <button class="pill" title="Open the Limenn bar" hidden><span class="word">limenn</span><span class="pill-off">off</span>${logoSvg(12, 'limenn-g2')}</button>`;
  document.documentElement.appendChild(host);

  const $ = <T extends Element = HTMLElement>(s: string) => root.querySelector(s) as unknown as T;
  const shell = $('.shell');
  const ta = $<HTMLTextAreaElement>('textarea');
  const fileInput = $<HTMLInputElement>('input[type=file]');
  const chips = $('.chips');
  const sendBtn = $<HTMLButtonElement>('.send');
  const steps = $('.steps');
  const summary = $('.summary');
  const idleInfo = $('.idle-info');
  const review = $<HTMLInputElement>('.review');
  const pill = $('.pill');
  const enabled = $<HTMLInputElement>('.enabled');

  let files: File[] = [];
  /** Prepared vault documents picked for the next message. */
  let picked: { id: string; name: string }[] = [];
  let docVault: DocVaultState = emptyDocVault();
  const vaultBtn = $<HTMLButtonElement>('.vault-btn');
  const vaultPop = $('.vault-pop');
  const vaultQ = $<HTMLInputElement>('.vault-q');
  let current: JobState | null = null;
  let busy = false;
  let raw = false;
  /** Job whose cleaned prompt sits in the site's composer waiting for the user's review. */
  let reviewingId: string | null = null;
  review.checked = store.get('review') === '1';

  // ---- protection on/off (shared by all tabs and the side panel) ----
  const setEnabled = (on: boolean) => {
    enabled.checked = on;
    host.classList.toggle('off', !on);
    if (!on) setVaultOpen(false);
  };
  chrome.storage.local.get(ENABLED_KEY).then((r) => setEnabled(r[ENABLED_KEY] !== false));
  chrome.storage.onChanged.addListener((c, area) => {
    if (area === 'local' && c[ENABLED_KEY]) setEnabled(c[ENABLED_KEY].newValue !== false);
  });
  enabled.addEventListener('change', () => chrome.storage.local.set({ [ENABLED_KEY]: enabled.checked }));

  // ---- layout helpers ----
  const grow = () => {
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, Math.min(340, innerHeight * 0.5)) + 'px';
  };
  const setMin = (min: boolean) => {
    host.classList.toggle('min', min);
    shell.hidden = min;
    pill.hidden = !min;
    store.set('min', min ? '1' : '0');
  };

  setMin(store.get('min') === '1');

  const renderChips = () => {
    chips.hidden = !files.length && !picked.length;
    chips.innerHTML =
      picked.map((d) => `<span class="chip vault" title="Prepared in your vault — sent instantly">${ICON.vault}${esc(d.name)}<button class="x" data-vault="${esc(d.id)}" aria-label="Remove">×</button></span>`).join('') +
      files.map((f, i) => `<span class="chip">${ICON.file}${esc(f.name)}<button class="x" data-i="${i}" aria-label="Remove" title="Remove this file">×</button></span>`).join('');
    const n = vaultBtn.querySelector<HTMLElement>('.n')!;
    n.hidden = !picked.length;
    n.textContent = String(picked.length);
  };

  // ---- Document Vault ----
  const STATUS_TEXT: Record<DocVaultState['status'], string> = {
    idle: '',
    scanning: 'Preparing new documents…',
    'needs-permission': 'Prepared documents work. To add new ones, allow folder access again in the side panel.',
    error: 'Vault error',
  };
  function renderVault() {
    const term = vaultQ.value.trim().toLowerCase();
    // Only prepared documents can be attached; the rest are still being prepared (or failed) in the side panel.
    const ready = docVault.docs.filter((d) => d.status === 'ready');
    const docs = ready.filter((d) => !term || d.path.toLowerCase().includes(term));
    const waiting = docVault.docs.length - ready.length;
    const list = $('.vault-list');
    if (!docVault.folder) {
      list.innerHTML = `<div class="vault-empty">No vault folder linked yet. Link one in the side panel: documents in it are prepared ahead of time, so attaching them here is instant.</div>`;
    } else if (!docs.length) {
      list.innerHTML = `<div class="vault-empty">${ready.length ? 'No match.' : docVault.docs.length ? 'No prepared documents yet. Progress is shown in the side panel.' : 'No supported documents in the folder yet.'}</div>`;
    } else {
      list.innerHTML = docs
        .map((d) => {
          const on = picked.some((p) => p.id === d.id);
          const st = `${d.entityCount} protected`;
          return `<button class="vault-item${on ? ' on' : ''}" title="${on ? 'Remove from' : 'Attach to'} this message (already prepared, cleaned instantly)" role="option" aria-selected="${on}" data-id="${esc(d.id)}"><span class="box">${on ? '✓' : ''}</span><span class="nm">${esc(d.name)}${d.path !== d.name ? `<small>${esc(d.path)}</small>` : ''}</span><span class="st ${d.status}">${st}</span></button>`;
        })
        .join('');
    }
    const p = docVault.progress;
    $('.vault-status').textContent =
      docVault.status === 'scanning' && p
        ? `Preparing ${Math.min(p.done + 1, p.total)}/${p.total} · ${Math.round(100 * (p.frac ?? 0))}%`
        : docVault.status === 'error'
          ? `Vault error: ${docVault.error ?? ''}`
          : STATUS_TEXT[docVault.status] || (docVault.folder ? `${docVault.folder} · ${ready.length} prepared${waiting ? ` · ${waiting} not ready` : ''}` : '');
  }
  const setVaultOpen = (open: boolean) => {
    vaultPop.hidden = !open;
    vaultBtn.setAttribute('aria-expanded', String(open));
    if (open) {
      renderVault();
      vaultQ.focus();
    }
  };
  chrome.storage.local.get(DOCVAULT_KEY).then((r) => {
    docVault = (r[DOCVAULT_KEY] as DocVaultState | undefined) ?? emptyDocVault();
    renderVault();
  });
  chrome.storage.onChanged.addListener((c, area) => {
    if (area !== 'local' || !c[DOCVAULT_KEY]) return;
    docVault = (c[DOCVAULT_KEY].newValue as DocVaultState | undefined) ?? emptyDocVault();
    // Drop picks whose document disappeared from the folder.
    picked = picked.filter((p) => docVault.docs.some((d) => d.id === p.id && d.status === 'ready'));
    renderVault();
    renderChips();
  });

  const showFoot = (mode: 'idle' | 'steps' | 'summary') => {
    idleInfo.hidden = mode !== 'idle';
    steps.hidden = mode !== 'steps';
    summary.hidden = mode !== 'summary';
  };

  const stepHtml = (label: string, s: StepState | undefined, n?: string) =>
    `<span class="step ${s?.status ?? 'pending'}"><span class="dot"></span>${label}${n ? ` <span class="n">${n}</span>` : ''}</span>`;

  function aggregate(job: JobState, key: 'extract' | 'regex' | 'ner'): { s: StepState; n?: string } {
    const all = job.items.map((i) => i.steps[key]).filter((s) => s.status !== 'skipped' || key !== 'extract');
    if (!all.length) return { s: { status: 'skipped' } };
    const status = all.some((s) => s.status === 'running')
      ? 'running'
      : all.some((s) => s.status === 'error')
        ? 'error'
        : all.every((s) => s.status === 'pending')
          ? 'pending'
          : all.every((s) => s.status === 'skipped')
            ? 'skipped'
            : all.some((s) => s.status === 'pending')
              ? 'running'
              : 'done';
    const count = all.reduce((a, s) => a + (s.count ?? 0), 0);
    return { s: { status }, n: status === 'done' && key !== 'extract' ? String(count) : undefined };
  }

  function renderJob(job: JobState) {
    current = job;
    if (job.status === 'running' || job.status === 'sending') {
      showFoot('steps');
      const hasFiles = job.items.some((i) => i.kind === 'file');
      const parts = [
        hasFiles ? (() => { const a = aggregate(job, 'extract'); return stepHtml('read', a.s); })() : '',
        (() => { const a = aggregate(job, 'regex'); return stepHtml('formats', a.s, a.n); })(),
        (() => { const a = aggregate(job, 'ner'); return stepHtml('names', a.s, a.n); })(),
        stepHtml(L, { status: job.status === 'sending' ? 'running' : 'pending' }),
      ].filter(Boolean);
      steps.innerHTML = parts.join('<span class="arrow">→</span>');
      return;
    }
    showFoot('summary');
    const n = protectedCount(job);
    if (job.status === 'error') {
      summary.innerHTML = `<span class="err">${esc(job.error ?? 'Something went wrong')}</span>`;
    } else if (job.status === 'cleaned') {
      const risky = job.items.flatMap((i) => i.risks ?? []).filter((r) => r.severity === 'high').length;
      summary.innerHTML = `<span class="badge">${n} protected</span>${risky ? `<span class="err">⚠ ${risky} possible leak${risky > 1 ? 's' : ''} — check the side panel or ${L}'s box before sending.</span>` : `<span>Cleaned prompt is in ${L}'s box — review it there.</span>`}<button class="primary-sm send-now" title="Send the cleaned message now">Send to ${L}</button>`;
    } else if (job.status === 'sent') {
      summary.innerHTML = `<span class="badge">${n} protected</span><span>${L} only saw placeholders · <span class="restored-note">highlighted values were filled in by Limenn</span></span><button class="link raw-toggle" title="Switch between your real data and the placeholders the AI saw">${raw ? 'Show restored answer' : `Show what ${L} wrote`}</button>`;
    }
  }

  // ---- moving the bar ----
  type Pos = { x: number; y: number } | null;
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
  function applyPos(p: Pos) {
    if (!p) {
      host.style.left = host.style.top = host.style.right = host.style.transform = '';
      return;
    }
    const r = host.getBoundingClientRect();
    host.style.transform = 'none';
    host.style.right = 'auto';
    host.style.left = `${clamp(p.x, 8, Math.max(8, innerWidth - r.width - 8))}px`;
    host.style.top = `${clamp(p.y, 8, Math.max(8, innerHeight - r.height - 8))}px`;
  }
  const savedPos = (): Pos => {
    try {
      return JSON.parse(store.get('pos') ?? 'null');
    } catch {
      return null;
    }
  };
  applyPos(savedPos());
  addEventListener('resize', () => applyPos(savedPos()));

  const INTERACTIVE = 'textarea, input, button, select, label, a, .chips, .vault-pop, .summary';
  function makeDraggable(handle: HTMLElement, onClick?: () => void) {
    let start: { x: number; y: number; left: number; top: number } | null = null;
    let moved = false;
    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      // The whole bar is a drag surface, except the controls inside it.
      const target = e.composedPath()[0] as HTMLElement;
      if (handle !== pill && target.closest?.(INTERACTIVE)) return;
      const r = host.getBoundingClientRect();
      start = { x: e.clientX, y: e.clientY, left: r.left, top: r.top };
      moved = false;
      handle.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    handle.addEventListener('pointermove', (e) => {
      if (!start) return;
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      if (!moved && Math.hypot(dx, dy) < 4) return;
      moved = true;
      host.classList.add('dragging');
      applyPos({ x: start.left + dx, y: start.top + dy });
    });
    handle.addEventListener('pointerup', () => {
      if (!start) return;
      start = null;
      host.classList.remove('dragging');
      if (moved) {
        const r = host.getBoundingClientRect();
        store.set('pos', JSON.stringify({ x: r.left, y: r.top }));
      } else onClick?.();
    });
    handle.addEventListener('dblclick', (e) => {
      if (handle !== pill && (e.composedPath()[0] as HTMLElement).closest?.(INTERACTIVE)) return;
      store.set('pos', 'null');
      applyPos(null);
    });
  }

  // ---- actions ----
  async function submit() {
    if (busy || !enabled.checked) return;
    const prompt = ta.value;
    if (!prompt.trim() && !files.length && !picked.length) return ta.focus();
    busy = true;
    sendBtn.disabled = true;
    if (raw) {
      raw = false;
      setRaw(false);
    }
    // Open the side panel so the user can watch the processing (must happen inside the user gesture).
    chrome.runtime.sendMessage({ type: 'limenn:open-panel' }).catch(() => {});
    showFoot('steps');
    steps.innerHTML = stepHtml('Preparing', { status: 'running' });
    try {
      const jf: JobFile[] = await Promise.all(
        files.map(async (f) => ({ name: f.name, mime: f.type || (f.name.endsWith('.pdf') ? 'application/pdf' : 'text/plain'), data: await readB64(f) })),
      );
      const res = await chrome.runtime.sendMessage({ type: 'limenn:clean', input: { prompt, files: jf, vaultDocs: picked }, autoSend: !review.checked });
      if (!res?.ok) throw new Error(res?.error ?? 'Cleaning failed');
      const job: JobState = res.job;
      if (job.status === 'error') throw new Error(job.error);
      ta.value = '';
      files = [];
      picked = [];
      setVaultOpen(false);
      renderChips();
      grow();
      // Leak guard: something risky is still in the cleaned text → never auto-send, let the user look first.
      const risky = job.items.flatMap((i) => i.risks ?? []).filter((r) => r.severity === 'high').length;
      await finish(job, !review.checked && !risky);
    } catch (e) {
      renderJob({ ...(current ?? ({ items: [] } as unknown as JobState)), status: 'error', error: (e as Error).message });
    } finally {
      busy = false;
      sendBtn.disabled = false;
    }
  }

  async function finish(job: JobState, send: boolean) {
    renderJob({ ...job, status: send ? 'sending' : 'cleaned' });
    try {
      await deliver(job, send);
      const status = send ? 'sent' : 'cleaned';
      reviewingId = send ? null : job.id;
      chrome.runtime.sendMessage({ type: 'limenn:status', jobId: job.id, status }).catch(() => {});
      renderJob({ ...job, status });
    } catch (e) {
      chrome.runtime.sendMessage({ type: 'limenn:status', jobId: job.id, status: 'error', error: (e as Error).message }).catch(() => {});
      renderJob({ ...job, status: 'error', error: `Could not deliver to ${L}: ${(e as Error).message}` });
    }
  }

  /** Review mode: the cleaned text is already in the composer, so only press Claude's send button. */
  async function clickSend(job: JobState) {
    renderJob({ ...job, status: 'sending' });
    try {
      await pressSend(job.id);
      chrome.runtime.sendMessage({ type: 'limenn:status', jobId: job.id, status: 'sent' }).catch(() => {});
      renderJob({ ...job, status: 'sent' });
    } catch (e) {
      renderJob({ ...job, status: 'error', error: `Could not send: ${(e as Error).message}` });
    }
  }

  const onPromptKey = (e: KeyboardEvent) => {
    e.stopPropagation(); // keep the site's shortcuts from firing while typing here
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      submit();
    }
  };
  const onVaultKey = (e: KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === 'Escape') setVaultOpen(false);
  };
  ta.addEventListener('input', grow);
  ta.addEventListener('keydown', onPromptKey);
  // key-guard.ts stops keys typed in the bar before the site sees them (and before they reach these fields): it hands
  // them over here instead.
  globalThis.__limennKeys = (e) => {
    const el = root.activeElement;
    if (e.type === 'keydown') {
      if (el === ta) onPromptKey(e as KeyboardEvent);
      else if (el === vaultQ) onVaultKey(e as KeyboardEvent);
    } else if (e.type === 'input') {
      if (el === ta) grow();
      else if (el === vaultQ) renderVault();
    }
  };
  sendBtn.addEventListener('click', submit);
  $('.attach').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    files.push(...(fileInput.files ?? []));
    fileInput.value = '';
    renderChips();
  });
  chips.addEventListener('click', (e) => {
    const vid = (e.target as HTMLElement).dataset.vault;
    if (vid) {
      picked = picked.filter((p) => p.id !== vid);
      renderChips();
      renderVault();
      return;
    }
    const i = (e.target as HTMLElement).dataset.i;
    if (i == null) return;
    files.splice(+i, 1);
    renderChips();
  });
  shell.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.stopPropagation();
    shell.classList.add('drag');
  });
  shell.addEventListener('dragleave', () => shell.classList.remove('drag'));
  shell.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    shell.classList.remove('drag');
    files.push(...(e.dataTransfer?.files ?? []));
    renderChips();
  });
  vaultBtn.addEventListener('click', () => setVaultOpen(vaultPop.hidden !== false));
  // The document vault is a beta feature: its button shows only when switched on in Settings.
  const showVaultButton = (on: boolean) => {
    vaultBtn.hidden = !on;
    if (!on) setVaultOpen(false);
  };
  loadSettings().then((s) => showVaultButton(s.docVault), () => showVaultButton(false));
  chrome.storage.local.onChanged.addListener((c) => c[SETTINGS_KEY] && showVaultButton(!!(c[SETTINGS_KEY].newValue as Settings | undefined)?.docVault));
  vaultQ.addEventListener('input', renderVault);
  vaultQ.addEventListener('keydown', onVaultKey);
  $('.vault-list').addEventListener('click', (e) => {
    const id = (e.target as HTMLElement).closest<HTMLElement>('.vault-item')?.dataset.id;
    const doc = docVault.docs.find((d) => d.id === id);
    if (!doc || doc.status !== 'ready') return;
    picked = picked.some((p) => p.id === doc.id) ? picked.filter((p) => p.id !== doc.id) : [...picked, { id: doc.id, name: doc.name }];
    renderChips();
    renderVault();
  });
  $('.vault-manage').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'limenn:open-panel' }).catch(() => {}));
  review.addEventListener('change', () => store.set('review', review.checked ? '1' : '0'));
  $('.workspace').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'limenn:workspace:open' }).catch(() => {}));
  $('.details').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'limenn:open-panel' }).catch(() => {}));
  $('.minimize').addEventListener('click', () => setMin(true));
  makeDraggable(shell);
  makeDraggable(pill, () => {
    setMin(false);
    applyPos(savedPos());
    ta.focus();
  });
  summary.addEventListener('click', async (e) => {
    if ((e.target as HTMLElement).classList.contains('raw-toggle')) {
      raw = !raw;
      setRaw(raw);
      chrome.runtime.sendMessage({ type: 'limenn:raw-state', on: raw }).catch(() => {});
      if (current) renderJob(current);
      return;
    }
    if (!(e.target as HTMLElement).classList.contains('send-now') || !current) return;
    reviewingId = null;
    await clickSend(current);
  });

  return {
    /** Open (un-minimise) the bar and put the cursor in it. */
    show() {
      setMin(false);
      applyPos(savedPos());
      ta.focus();
      shell.animate([{ boxShadow: '0 0 0 6px rgba(26, 60, 255, 0.35)' }, { boxShadow: '0 0 0 0 rgba(26, 60, 255, 0)' }], { duration: 900 });
    },
    /** The side panel flipped raw/restored. */
    syncRaw(on: boolean) {
      raw = on;
      if (current) renderJob(current);
    },
    /** Live progress pushed from the background worker. */
    onJob(job: JobState) {
      const mine = busy || job.id === reviewingId;
      if (!mine) return;
      if (job.status === 'running') renderJob(job);
      // A re-clean triggered from the side panel while reviewing: replace what's in the composer.
      else if (job.status === 'cleaned' && !busy && job.id === reviewingId) {
        deliver(job, false).then(() => renderJob(job), (e) => renderJob({ ...job, status: 'error', error: e.message }));
      }
    },
  };
}
