// Side panel section for the Document Vault: link a folder, watch documents get prepared, and review a
// document's detections ahead of time (per-document allow/protect lists, applied every time it is sent).
import { loadFolderHandle, requestFolderAccess, saveFolderHandle, unlinkFolder } from '../docvault/browser-fs';
import { manualEntities } from '../docvault/cache';
import type { PreparedDoc } from '../docvault/types';
import { mergeEntities } from '../pii/merge';
import type { EntityType } from '../pii/types';
import { DOCVAULT_KEY, type DocVaultState, emptyDocVault } from '../shared/jobs';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export function initDocVault(toast: (msg: string, error?: boolean) => void) {
  let state: DocVaultState = emptyDocVault();
  let open: PreparedDoc | null = null;

  const send = (msg: object) => chrome.runtime.sendMessage(msg);

  function render() {
    const linked = !!state.folder;
    const p = state.progress;
    $('dv-intro').hidden = linked;
    $('dv-scan').hidden = !linked;
    $('dv-unlink').hidden = !linked;
    $('dv-link').textContent = !linked ? 'Link vault folder' : state.status === 'needs-permission' ? 'Re-authorize folder' : 'Change folder';
    $('dv-link').className = `btn sm ${!linked || state.status === 'needs-permission' ? 'primary' : ''}`;
    $<HTMLButtonElement>('dv-scan').disabled = state.status === 'scanning';
    const ready = state.docs.filter((d) => d.status === 'ready').length;
    $('dv-summary').textContent = linked
      ? state.status === 'scanning'
        ? p ? `preparing ${Math.min(p.done + 1, p.total)}/${p.total}…` : 'scanning…'
        : `${state.folder} · ${ready}/${state.docs.length} ready`
      : '';
    const scanning = state.status === 'scanning';
    const pct = Math.round(100 * (p?.frac ?? (p ? p.done / Math.max(1, p.total) : 0)));
    $('dv-progress').hidden = !scanning;
    $('dv-bar').style.width = `${p ? Math.max(3, pct) : 0}%`;
    $('dv-bar').parentElement!.setAttribute('aria-valuenow', String(pct));
    $('dv-progress-label').textContent = p ? `${p.path.split('/').pop()} · ${p.label ?? 'preparing'}` : 'looking for new documents…';
    $('dv-progress-pct').textContent = p ? `${pct}%${p.total > 1 ? ` · ${Math.min(p.done + 1, p.total)}/${p.total}` : ''}` : '';
    $('dv-prepared-note').hidden = !linked || state.access !== 'readwrite';
    const warn = state.status === 'needs-permission' ? 'Prepared documents can still be sent. To pick up new or changed files, Chrome needs your permission again: click anywhere in this panel.' : state.status === 'error' ? `Vault error: ${state.error ?? 'unknown'}` : '';
    if (state.status === 'needs-permission') askOnNextClick();
    $('dv-warn').hidden = !warn;
    $('dv-warn').textContent = warn;
    $('dv-list').innerHTML = state.docs
      .map((d) => {
        const preparing = state.status === 'scanning' && p?.path === d.path;
        const docPct = p ? Math.round(100 * Math.min(1, Math.max(0, (p.frac ?? 0) * p.total - p.done))) : 0;
        const st = preparing ? `${docPct}%` : d.status === 'ready' ? `${d.entityCount} protected` : 'error';
        return `<li data-id="${esc(d.id)}" title="${esc(d.error ?? 'Click to review')}"><span class="nm">${esc(d.name)}<small>${esc([d.path !== d.name ? d.path : '', d.meta].filter(Boolean).join(' · '))}</small></span><span class="st ${preparing ? 'preparing' : d.status}">${st}</span></li>`;
      })
      .join('');
  }

  function renderReview() {
    $('dv-review').hidden = !open;
    if (!open) return;
    $('dv-review-name').textContent = open.name;
    const allow = new Set(open.review.allow);
    // Same view the send path produces: cached detections + this doc's manual marks.
    const ents = mergeEntities([...manualEntities(open.text, open.review.manual), ...open.entities]);
    let html = '';
    let pos = 0;
    for (const e of ents) {
      html += esc(open.text.slice(pos, e.start));
      const off = allow.has(e.text.trim());
      html += `<span class="m ${e.source}${off ? ' allowed' : ''}" data-value="${esc(e.text)}" title="${esc(e.type)} · ${({ regex: 'format', ner: 'context', jev: 'second look', manual: 'you' } as Record<string, string>)[e.source] ?? e.source} · click to ${off ? 'protect again' : 'send unchanged'}">${esc(e.text)}</span>`;
      pos = e.end;
    }
    $('dv-review-doc').innerHTML = html + esc(open.text.slice(pos));
  }

  async function saveReview() {
    if (!open) return;
    const r = await send({ type: 'limenn:vault:review', id: open.id, review: open.review });
    if (!r?.ok) return toast(r?.error ?? 'Could not save', true);
    open = r.doc;
    renderReview();
  }

  // Chrome only shows its permission prompt during a user gesture, so ask on the next click in the panel.
  let asking = false;
  function askOnNextClick() {
    if (asking) return;
    asking = true;
    document.addEventListener(
      'click',
      async (e) => {
        if ((e.target as HTMLElement).closest('#dv-link, #dv-unlink')) return void (asking = false); // those buttons handle it
        try {
          const handle = await loadFolderHandle();
          const access = handle && (await requestFolderAccess(handle));
          if (access) await send({ type: 'limenn:vault:linked', folder: handle!.name, access, keepDocs: true });
        } finally {
          asking = false;
        }
      },
      { capture: true, once: true },
    );
  }

  $('dv-link').addEventListener('click', async () => {
    try {
      // Re-authorize keeps the same folder; otherwise pick a new one (user gesture required for both).
      let handle = state.status === 'needs-permission' ? await loadFolderHandle() : undefined;
      handle ??= await (window as unknown as { showDirectoryPicker(o: object): Promise<FileSystemDirectoryHandle> }).showDirectoryPicker({ id: 'limenn-vault', mode: 'readwrite' });
      const access = await requestFolderAccess(handle);
      if (!access) return toast('Limenn needs read access to the folder.', true);
      await saveFolderHandle(handle);
      if (access === 'read') toast('Read-only access: prepared results stay in this browser instead of the folder.');
      await send({ type: 'limenn:vault:linked', folder: handle.name, access, keepDocs: state.status === 'needs-permission' });
    } catch (e) {
      if ((e as Error).name !== 'AbortError') toast((e as Error).message, true);
    }
  });
  $('dv-scan').addEventListener('click', () => send({ type: 'limenn:vault:scan' }));
  $('dv-unlink').addEventListener('click', async () => {
    await unlinkFolder();
    await send({ type: 'limenn:vault:unlinked' });
    open = null;
    renderReview();
    toast('Vault folder unlinked. Files and the .limenn cache in it were left untouched.');
  });
  $('dv-list').addEventListener('click', async (e) => {
    const id = (e.target as HTMLElement).closest<HTMLElement>('[data-id]')?.dataset.id;
    if (!id) return;
    const r = await send({ type: 'limenn:vault:doc', id });
    if (!r?.ok) return toast(r?.error ?? 'Could not open', true);
    if (r.doc.status !== 'ready') return toast(r.doc.error ?? 'Not prepared', true);
    open = r.doc;
    renderReview();
  });
  $('dv-review-close').addEventListener('click', () => {
    open = null;
    renderReview();
  });
  $('dv-review-doc').addEventListener('click', (e) => {
    const v = (e.target as HTMLElement).dataset.value?.trim();
    if (!v || !open) return;
    const allow = new Set(open.review.allow);
    if (allow.has(v)) allow.delete(v);
    else allow.add(v);
    open.review.allow = [...allow];
    open.review.manual = open.review.manual.filter(([m]) => m !== v);
    saveReview();
  });
  document.addEventListener('selectionchange', () => {
    const sel = document.getSelection();
    const text = sel?.toString().trim() ?? '';
    if (sel?.anchorNode && $('dv-review-doc').contains(sel.anchorNode) && text.length >= 2 && text.length <= 120) {
      $('dv-sel-text').textContent = text;
      $('dv-sel').hidden = false;
    } else if (!$('dv-sel').contains(document.activeElement)) $('dv-sel').hidden = true;
  });
  $('dv-sel-add').addEventListener('click', () => {
    const v = $('dv-sel-text').textContent ?? '';
    if (!v || !open) return;
    open.review.manual = [...open.review.manual.filter(([m]) => m !== v), [v, $<HTMLSelectElement>('dv-sel-type').value as EntityType]];
    open.review.allow = open.review.allow.filter((a) => a !== v);
    $('dv-sel').hidden = true;
    saveReview();
  });

  chrome.storage.local.onChanged.addListener((c) => {
    if (!c[DOCVAULT_KEY]) return;
    state = (c[DOCVAULT_KEY].newValue as DocVaultState | undefined) ?? emptyDocVault();
    render();
  });
  chrome.storage.local.get(DOCVAULT_KEY).then((r) => {
    state = (r[DOCVAULT_KEY] as DocVaultState | undefined) ?? emptyDocVault();
    render();
    // Opening the panel is a good moment to pick up new files.
    if (state.folder) send({ type: 'limenn:vault:scan' }).catch(() => {});
  });
}
