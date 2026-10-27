// "Always protect this": click a word (or select a few) in a message and add it, or everything shaped like it, to the
// user's protected list. Shared by the workspace and the side panel; text is found with caretRangeFromPoint, so the
// pages don't have to wrap words in elements.
import { customEntities, deriveShape, ENTITY_TYPES, guessType, makeRule, normalizeValue, type ProtectedRule, validateShape } from '../pii/custom';
import type { EntityType } from '../pii/types';
import { addProtected, removeProtected } from './storage';

export interface ProtectOptions {
  /** Elements inside `root` whose words can be clicked. */
  selector: string;
  /** Called after a rule was added (e.g. re-clean the current job), with a short note for the confirmation. */
  onAdded?: (rule: ProtectedRule, target: HTMLElement) => string | void | Promise<string | void>;
  onRemoved?: (rule: ProtectedRule) => void;
}

/** Letters, digits and the characters that keep IDs and e-mail addresses together. */
const WORD = /[\p{L}\p{N}@._+\-'’/]/u;
const EDGE = /^[.\-_'’/+]+|[.\-_'’/+]+$/g;
/** A placeholder such as [PERSON-1] is already protected. */
const PLACEHOLDER = /^\[?[A-Z]+(?:[-_][A-Z]+)*[-_]\d+(?:[-_](?:FIRST|SURNAME))?\]?$/;

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** Character offset of a DOM position within `el`'s text. */
function offsetIn(el: Element, node: Node, offset: number): number {
  const r = document.createRange();
  r.selectNodeContents(el);
  r.setEnd(node, offset);
  return r.toString().length;
}

function wordAt(text: string, i: number): [number, number] | undefined {
  let s = i;
  let e = i;
  while (s > 0 && WORD.test(text[s - 1])) s--;
  while (e < text.length && WORD.test(text[e])) e++;
  return trim(text, s, e);
}

function trim(text: string, s: number, e: number): [number, number] | undefined {
  while (s < e && /[\s.\-_'’/+,;:!?()"«»“”]/.test(text[s])) s++;
  while (e > s && /[\s.\-_'’/+,;:!?()"«»“”]/.test(text[e - 1])) e--;
  return e - s >= 2 ? [s, e] : undefined;
}

/** Grow a span by one word to the left (-1) or right (1), across whitespace only. */
function grow(text: string, [s, e]: [number, number], dir: -1 | 1): [number, number] {
  if (dir < 0) {
    let j = s;
    while (j > 0 && /[ \t]/.test(text[j - 1])) j--;
    if (j === s || !j || !WORD.test(text[j - 1])) return [s, e];
    while (j > 0 && WORD.test(text[j - 1])) j--;
    return trim(text, j, e) ?? [s, e];
  }
  let j = e;
  while (j < text.length && /[ \t]/.test(text[j])) j++;
  if (j === e || j >= text.length || !WORD.test(text[j])) return [s, e];
  while (j < text.length && WORD.test(text[j])) j++;
  return trim(text, s, j) ?? [s, e];
}

let pop: HTMLDivElement | undefined;
function close() {
  pop?.remove();
  pop = undefined;
}

/** Make the words inside `root` (matching `opts.selector`) clickable for protection. */
export function attachProtect(root: HTMLElement, opts: ProtectOptions) {
  root.addEventListener('mouseup', (ev) => {
    if (ev.button !== 0) return;
    const target = (ev.target as HTMLElement).closest<HTMLElement>(opts.selector);
    if (!target || !root.contains(target)) return;
    // Highlights, buttons and links keep their own click behaviour.
    if ((ev.target as HTMLElement).closest('button, a, input, select, [data-value]')) return;
    const text = target.textContent ?? '';
    let span: [number, number] | undefined;
    const sel = document.getSelection();
    if (sel && !sel.isCollapsed && target.contains(sel.anchorNode) && target.contains(sel.focusNode)) {
      const r = sel.getRangeAt(0);
      span = trim(text, offsetIn(target, r.startContainer, r.startOffset), offsetIn(target, r.endContainer, r.endOffset));
      if (span && span[1] - span[0] > 120) span = undefined;
    } else {
      const r = document.caretRangeFromPoint?.(ev.clientX, ev.clientY);
      if (r && target.contains(r.startContainer)) span = wordAt(text, offsetIn(target, r.startContainer, r.startOffset));
    }
    if (!span || PLACEHOLDER.test(text.slice(span[0], span[1]))) return;
    open(target, text, span, ev.clientX, ev.clientY, opts);
  });
  document.addEventListener('keydown', (e) => e.key === 'Escape' && close());
  document.addEventListener('mousedown', (e) => pop && !pop.contains(e.target as Node) && close());
}

function open(target: HTMLElement, text: string, first: [number, number], x: number, y: number, opts: ProtectOptions) {
  close();
  let span = first;
  const value = () => normalizeValue(text.slice(span[0], span[1]));
  let typeTouched = false;

  pop = document.createElement('div');
  pop.className = 'lp-pop';
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', 'Protect from now on');
  pop.innerHTML = `
    <div class="lp-head">
      <button class="lp-grow" data-dir="-1" title="Add the word before">‹</button>
      <b class="lp-val" title="Click to start over from the word you clicked"></b>
      <button class="lp-grow" data-dir="1" title="Add the word after">›</button>
      <button class="lp-x" aria-label="Close" title="Close">×</button>
    </div>
    <label class="lp-type">protect as <select>${ENTITY_TYPES.map((t) => `<option>${t}</option>`).join('')}</select></label>
    <button class="btn primary sm lp-words" title="Replace exactly these words in every message and file from now on (any upper/lower case)"></button>
    <div class="lp-shape" hidden>
      <span class="lp-or">or everything shaped like</span>
      <input class="lp-shape-in" spellcheck="false" aria-label="Pattern" />
      <span class="lp-hint"># digit · A letter · * any characters</span>
      <span class="lp-count" aria-live="polite"></span>
      <button class="btn sm lp-shape-add" title="Replace every value of this shape from now on, e.g. all employee numbers">protect this pattern</button>
    </div>
    <div class="lp-done" hidden><span></span><button class="btn ghost sm lp-undo" title="Take it off your protected list again">undo</button></div>`;
  document.body.append(pop);
  const $ = <T extends HTMLElement>(s: string) => pop!.querySelector<T>(s)!;
  const type = $<HTMLSelectElement>('select');
  const shapeIn = $<HTMLInputElement>('.lp-shape-in');

  const refreshShape = () => {
    const err = validateShape(shapeIn.value);
    const n = err ? 0 : customEntities(text, [{ kind: 'shape', value: shapeIn.value, type: 'ID_NUMBER' }]).length;
    $('.lp-count').textContent = err ?? `matches ${n}× here`;
    $('.lp-count').classList.toggle('bad', !!err);
    $<HTMLButtonElement>('.lp-shape-add').disabled = !!err;
  };
  const refresh = () => {
    const v = value();
    $('.lp-val').textContent = v;
    $('.lp-words').textContent = `always protect “${v.length > 40 ? v.slice(0, 39) + '…' : v}”`;
    if (!typeTouched) type.value = guessType(v);
    const shape = deriveShape(v);
    $('.lp-shape').hidden = !shape;
    if (shape) {
      shapeIn.value = shape;
      refreshShape();
    }
  };
  refresh();

  // Place next to the click, inside the viewport.
  const w = pop.offsetWidth;
  const h = pop.offsetHeight;
  pop.style.left = `${Math.max(8, Math.min(x - 20, innerWidth - w - 8))}px`;
  pop.style.top = `${y + 14 + h > innerHeight - 8 ? Math.max(8, y - h - 14) : y + 14}px`;

  pop.querySelectorAll<HTMLButtonElement>('.lp-grow').forEach((b) =>
    b.addEventListener('click', () => {
      span = grow(text, span, +b.dataset.dir! as -1 | 1);
      refresh();
    }),
  );
  $('.lp-val').addEventListener('click', () => {
    span = first;
    refresh();
  });
  $('.lp-x').addEventListener('click', close);
  type.addEventListener('change', () => (typeTouched = true));
  shapeIn.addEventListener('input', refreshShape);
  shapeIn.addEventListener('keydown', (e) => e.key === 'Enter' && !$<HTMLButtonElement>('.lp-shape-add').disabled && add('shape'));
  $('.lp-words').addEventListener('click', () => add('words'));
  $('.lp-shape-add').addEventListener('click', () => add('shape'));

  async function add(kind: ProtectedRule['kind']) {
    const rule = makeRule(kind, kind === 'shape' ? shapeIn.value : value(), type.value as EntityType);
    await addProtected(rule);
    const note = (await opts.onAdded?.(rule, target)) ?? '';
    const p = pop;
    if (!p) return;
    p.querySelectorAll<HTMLElement>(':scope > :not(.lp-done)').forEach((n) => (n.hidden = true));
    p.querySelector<HTMLElement>('.lp-done')!.hidden = false;
    p.querySelector('.lp-done span')!.innerHTML = `<b>${esc(rule.value)}</b> is protected from now on.${note ? ` ${esc(note)}` : ''}`;
    p.querySelector('.lp-undo')!.addEventListener('click', async () => {
      await removeProtected(rule.id);
      opts.onRemoved?.(rule);
      close();
    });
    setTimeout(() => pop === p && close(), 6000);
  }
}
