import type { Settings } from '../pii/types';
import { logoSvg } from '../shared/logo';
import { loadSettings, saveSettings } from '../shared/storage';

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
  (form.elements.namedItem('financialPolicy') as HTMLSelectElement).value = s.financialPolicy;
  (form.elements.namedItem('nextGen') as HTMLSelectElement).value = s.nextGen;
})();

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  await saveSettings(read(await loadSettings()));
  msg.textContent = 'Saved.';
  msg.className = 'ok';
});
