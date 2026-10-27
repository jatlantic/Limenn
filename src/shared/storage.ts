import { makeRule, type ProtectedRule, sameRule } from '../pii/custom';
import { DEFAULT_SETTINGS, type EntityType, type Settings } from '../pii/types';
import { Vault, type VaultData } from '../pii/vault';
import { ALLOW_KEY, MANUAL_KEY, PROTECTED_KEY } from './jobs';
import { SETTINGS_KEY, VAULT_KEY } from './messages';

/**
 * The extension runs fully on this device: only the bundled NER model, never the network classifier (Jev). These
 * fields are pinned here so a stored value from an older version (or a tampered one) can't turn either back on.
 */
const LOCAL_ONLY = { nerModel: DEFAULT_SETTINGS.nerModel, enableJev: false, openrouterKey: '' } satisfies Partial<Settings>;

export async function loadSettings(): Promise<Settings> {
  const r = await chrome.storage.local.get(SETTINGS_KEY);
  const stored = r[SETTINGS_KEY] as Partial<Settings> | undefined;
  // Older versions stored an OpenRouter key: don't keep a secret the extension no longer uses.
  if (stored?.openrouterKey) await saveSettings({ ...DEFAULT_SETTINGS, ...stored });
  return { ...DEFAULT_SETTINGS, ...stored, ...LOCAL_ONLY };
}

export async function saveSettings(s: Settings) {
  await chrome.storage.local.set({ [SETTINGS_KEY]: { ...s, ...LOCAL_ONLY } });
}

export async function loadVault(): Promise<Vault> {
  const s = await chrome.storage.session.get(VAULT_KEY);
  const l = await chrome.storage.local.get(VAULT_KEY);
  return new Vault((s[VAULT_KEY] ?? l[VAULT_KEY]) as VaultData | undefined);
}

export async function saveVault(v: Vault, persist: boolean) {
  await chrome.storage.session.set({ [VAULT_KEY]: v.data });
  if (persist) await chrome.storage.local.set({ [VAULT_KEY]: v.data });
  else await chrome.storage.local.remove(VAULT_KEY);
}

export async function clearVault() {
  await chrome.storage.session.remove(VAULT_KEY);
  await chrome.storage.local.remove(VAULT_KEY);
}

/** The "always protect" list. Manual marks from older versions (value/type pairs) are moved into it once. */
export async function loadProtected(): Promise<ProtectedRule[]> {
  const r = await chrome.storage.local.get([PROTECTED_KEY, MANUAL_KEY]);
  const rules = (r[PROTECTED_KEY] as ProtectedRule[] | undefined) ?? [];
  const legacy = (r[MANUAL_KEY] as [string, EntityType][] | undefined) ?? [];
  if (!legacy.length) return rules;
  for (const [value, type] of legacy) if (!rules.some((x) => sameRule(x, { kind: 'words', value }))) rules.push(makeRule('words', value, type));
  await chrome.storage.local.set({ [PROTECTED_KEY]: rules });
  await chrome.storage.local.remove(MANUAL_KEY);
  return rules;
}

export async function saveProtected(rules: ProtectedRule[]) {
  await chrome.storage.local.set({ [PROTECTED_KEY]: rules });
}

/**
 * Add a rule (or replace the same one with a new type). Protecting a value also takes it off the session's
 * "send unchanged" list, so the newest decision wins.
 */
export async function addProtected(rule: ProtectedRule) {
  const rules = (await loadProtected()).filter((x) => !sameRule(x, rule));
  rules.push(rule);
  const allow = ((await chrome.storage.local.get(ALLOW_KEY))[ALLOW_KEY] as string[] | undefined) ?? [];
  await chrome.storage.local.set({ [PROTECTED_KEY]: rules, [ALLOW_KEY]: allow.filter((v) => v.toLowerCase() !== rule.value.toLowerCase()) });
}

export async function removeProtected(id: string) {
  await saveProtected((await loadProtected()).filter((x) => x.id !== id));
}
