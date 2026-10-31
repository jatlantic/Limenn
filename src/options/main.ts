import { customEntities, ENTITY_TYPES, guessType, looksLikeShape, makeRule, normalizeValue, parseRules, type ProtectedRule, sameRule, validateShape } from '../pii/custom';
import { mergeEntities } from '../pii/merge';
import type { EntityType, Settings } from '../pii/types';
import { PROTECTED_KEY } from '../shared/jobs';
import { logoSvg } from '../shared/logo';
import { IS_FIREFOX } from '../shared/platform';
import { addProtected, loadProtected, loadSettings, removeProtected, saveProtected, saveSettings } from '../shared/storage';

document.getElementById('logo')!.innerHTML = logoSvg(14);

const form = document.getElementById('form') as HTMLFormElement;
const msg = document.getElementById('msg')!;
const field = (name: string) => form.elements.namedItem(name) as HTMLInputElement;

function read(base: Settings): Settings {
  return {
    ...base,
    enableNer: field('enableNer').checked,
    nerThreshold: +field('nerThreshold').value,
    allowList: (form.elements.namedItem('allowList') as HTMLTextAreaElement).value.split('\n').map((s) => s.trim()).filter(Boolean),
    persistMapping: field('persistMapping').checked,
    docVault: field('docVault').checked,
    financialPolicy: (form.elements.namedItem('financialPolicy') as HTMLSelectElement).value as Settings['financialPolicy'],
    nextGen: (form.elements.namedItem('nextGen') as HTMLSelectElement).value as Settings['nextGen'],
  };
}

(async () => {
  const s = await loadSettings();
  field('enableNer').checked = s.enableNer;
  field('nerThreshold').value = String(s.nerThreshold);
  (form.elements.namedItem('allowList') as HTMLTextAreaElement).value = s.allowList.join('\n');
  field('persistMapping').checked = s.persistMapping;
  field('docVault').checked = s.docVault;
  (form.elements.namedItem('financialPolicy') as HTMLSelectElement).value = s.financialPolicy;
  (form.elements.namedItem('nextGen') as HTMLSelectElement).value = s.nextGen;
})();

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  await saveSettings(read(await loadSettings()));
  msg.textContent = 'Saved.';
  msg.className = 'ok';
});

// ---------- protected words & patterns (saved immediately, independent of the form) ----------
const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const valueIn = el<HTMLInputElement>('pr-value');
const typeIn = el<HTMLSelectElement>('pr-type');
typeIn.innerHTML = ENTITY_TYPES.map((t) => `<option>${t}</option>`).join('');
let typeTouched = false;

/** What the typed text will become, or why it can't be added. */
function pending(): { kind: ProtectedRule['kind']; value: string; error?: string } {
  const value = normalizeValue(valueIn.value);
  const kind = looksLikeShape(value) ? 'shape' : 'words';
  const error = !value ? undefined : kind === 'shape' ? validateShape(value) : value.length < 2 ? 'Enter at least 2 characters.' : undefined;
  return { kind, value, error };
}

function renderPending() {
  const p = pending();
  if (!typeTouched && p.value) typeIn.value = guessType(p.value);
  el('pr-kind').textContent = !p.value ? '' : p.error ?? (p.kind === 'shape' ? 'pattern · # digit, A letter, * any characters inside a word' : 'word or phrase · any upper/lower case, whole words only');
  el('pr-kind').classList.toggle('bad', !!p.error);
  el<HTMLButtonElement>('pr-add').disabled = !p.value || !!p.error;
}

async function renderList() {
  const rules = await loadProtected();
  el('pr-list').innerHTML = rules.length
    ? rules
        .map(
          (r) =>
            `<li><span class="k ${r.kind}">${r.kind === 'shape' ? 'pattern' : 'words'}</span><span class="v ${r.kind}">${esc(r.value)}</span><span class="t">${esc(r.type)}</span><button type="button" class="btn ghost sm" data-remove="${esc(r.id)}" aria-label="Remove ${esc(r.value)}" title="Stop protecting this">remove</button></li>`,
        )
        .join('')
    : '<li class="empty">Nothing yet. Add a word above, or click one in the workspace.</li>';
  renderTry(rules);
}

function renderTry(rules: ProtectedRule[]) {
  const text = el<HTMLTextAreaElement>('pr-try').value;
  const ents = mergeEntities(customEntities(text, rules));
  let html = '';
  let pos = 0;
  for (const e of ents) {
    html += esc(text.slice(pos, e.start)) + `<mark title="${esc(e.type)}">${esc(e.text)}</mark>`;
    pos = e.end;
  }
  el('pr-try-out').innerHTML = text ? html + esc(text.slice(pos)) + `\n\n${ents.length} protected` : '';
}

async function addPending() {
  const p = pending();
  if (!p.value || p.error) return;
  await addProtected(makeRule(p.kind, p.value, typeIn.value as EntityType));
  valueIn.value = '';
  typeTouched = false;
  renderPending();
  valueIn.focus();
}

valueIn.addEventListener('input', renderPending);
valueIn.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  addPending();
});
typeIn.addEventListener('change', () => (typeTouched = true));
el('pr-add').addEventListener('click', addPending);
el('pr-list').addEventListener('click', async (e) => {
  const id = (e.target as HTMLElement).dataset.remove;
  if (id) await removeProtected(id);
});
el('pr-try').addEventListener('input', async () => renderTry(await loadProtected()));
chrome.storage.local.onChanged.addListener((c) => c[PROTECTED_KEY] && renderList());

el('pr-export').addEventListener('click', async () => {
  const rules = await loadProtected();
  const blob = new Blob([JSON.stringify({ limenn: 'protected-list', version: 1, rules }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `limenn-protected-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});
el('pr-import').addEventListener('click', () => el('pr-file').click());
el<HTMLInputElement>('pr-file').addEventListener('change', async (e) => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  let incoming: ProtectedRule[];
  try {
    incoming = parseRules(JSON.parse(await file.text()));
  } catch {
    incoming = [];
  }
  if (!incoming.length) {
    el('pr-kind').textContent = 'That file has no protected words or patterns limenn can read.';
    el('pr-kind').classList.add('bad');
    return;
  }
  const rules = await loadProtected();
  const added = incoming.filter((r) => !rules.some((x) => sameRule(x, r)));
  await saveProtected([...rules, ...added]);
  el('pr-kind').classList.remove('bad');
  el('pr-kind').textContent = `Imported ${added.length} new entr${added.length === 1 ? 'y' : 'ies'}${incoming.length > added.length ? ` (${incoming.length - added.length} already in your list)` : ''}.`;
});

renderPending();
renderList();

// About: the installed version and browser build, to quote when reporting a problem.
el('about-version').textContent = `version ${chrome.runtime.getManifest().version} · ${IS_FIREFOX ? 'Firefox' : 'Chrome'} build`;
