// Service worker: routes cleaning jobs between the Limenn bar (content script), the side panel and the
// offscreen engine; persists the placeholder mapping; relays live progress to the claude.ai tab.
import { ALLOW_KEY, HISTORY_KEY, type HistoryEntry, WS_TABS_KEY, DOCVAULT_KEY, type DocVaultState, emptyDocVault, type EngineResult, type JobInput, type JobState, LAST_INPUT_KEY, LAST_JOB_KEY } from './shared/jobs';
import { loadProtected, loadSettings, saveVault } from './shared/storage';
import { Vault, type VaultData } from './pii/vault';
import { VAULT_KEY } from './shared/messages';
import { ADAPTERS, NEW_CHAT_URL, pickAdapter, type SiteAdapter } from './content/adapters';
import { IS_FIREFOX } from './shared/platform';

// Chrome has a side panel; Firefox has a sidebar (sidebar_action in its manifest) that the toolbar button toggles.
const firefoxSidebar = () => (globalThis as unknown as { browser?: { sidebarAction?: { open(): Promise<void>; toggle(): Promise<void> } } }).browser?.sidebarAction;
if (chrome.sidePanel) chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);
else chrome.action.onClicked.addListener(() => void firefoxSidebar()?.toggle().catch(console.error));

// Firefox may not offer this (or content scripts may not reach storage.session); the content script then asks us for the vault.
const allowContentScripts = () =>
  Promise.resolve(chrome.storage.session.setAccessLevel?.({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' })).catch(console.error);
chrome.runtime.onInstalled.addListener(allowContentScripts);
// First install: show the three steps to get going.
chrome.runtime.onInstalled.addListener((d) => d.reason === 'install' && chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html') }));
chrome.runtime.onStartup.addListener(allowContentScripts);
allowContentScripts();

// ---------- offscreen engine ----------

// Chrome runs the engine in an offscreen document. Firefox has no offscreen API, but its background page has a DOM,
// so the same engine page runs in a hidden iframe there.
let creating: Promise<void> | null = null;
let engineFrame: HTMLIFrameElement | null = null;
async function ensureEngine() {
  if (!chrome.offscreen) {
    if (engineFrame?.isConnected) return;
    creating ??= (async () => {
      engineFrame = document.createElement('iframe');
      engineFrame.hidden = true;
      engineFrame.src = chrome.runtime.getURL('engine.html');
      document.documentElement.append(engineFrame);
      keepAlive();
      await waitForEngine();
    })().finally(() => (creating = null));
    return creating;
  }
  const existing = await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT] });
  if (existing.length) return;
  creating ??= chrome.offscreen
    .createDocument({ url: 'engine.html', reasons: [chrome.offscreen.Reason.WORKERS], justification: 'Runs the local PII detection models and PDF text extraction.' })
    .then(waitForEngine)
    .finally(() => (creating = null));
  await creating;
}

/** Firefox unloads an idle background page after ~30 s, which would drop the engine (and its loaded models) mid-job. */
let keepAliveTimer: number | undefined;
function keepAlive() {
  if (keepAliveTimer != null) return;
  keepAliveTimer = window.setInterval(() => void chrome.runtime.getPlatformInfo(), 20_000);
}

/** createDocument resolves before the engine's module has registered its listener; messages sent earlier are lost. */
async function waitForEngine() {
  for (let i = 0; i < 100; i++) {
    const r = await chrome.runtime.sendMessage({ target: 'engine', type: 'ping' }).catch(() => undefined);
    if (r?.ok) return;
    await new Promise((res) => setTimeout(res, 100));
  }
}

async function warmUp() {
  const settings = await loadSettings();
  if (!settings.enableNer) return;
  await ensureEngine();
  chrome.runtime.sendMessage({ target: 'engine', type: 'warm', model: settings.nerModel }).catch(() => {});
}
chrome.runtime.onInstalled.addListener(warmUp);
chrome.runtime.onStartup.addListener(warmUp);

// ---------- Document Vault ----------

async function docVault(): Promise<DocVaultState> {
  return ((await chrome.storage.local.get(DOCVAULT_KEY))[DOCVAULT_KEY] as DocVaultState | undefined) ?? emptyDocVault();
}
async function patchDocVault(p: Partial<DocVaultState>) {
  await chrome.storage.local.set({ [DOCVAULT_KEY]: { ...(await docVault()), ...p } });
}

/** Prepare new/changed documents in the linked folder (runs in the offscreen engine). */
async function scanDocVault() {
  const state = await docVault();
  if (!state.folder || state.status === 'scanning') return state;
  await patchDocVault({ status: 'scanning', error: undefined, progress: undefined });
  await ensureEngine();
  const res = await chrome.runtime.sendMessage({ target: 'engine', type: 'vault-scan', settings: await loadSettings() }).catch((e: Error) => ({ ok: false, error: e.message }));
  if (res?.ok) await patchDocVault({ status: 'idle', docs: res.docs, scannedAt: Date.now(), progress: undefined });
  else await patchDocVault({ status: res?.code === 'needs-permission' ? 'needs-permission' : 'error', error: res?.error, progress: undefined });
  return docVault();
}

const VAULT_ALARM = 'limenn-vault-scan';
const scheduleScan = () => chrome.alarms.create(VAULT_ALARM, { periodInMinutes: 5 });
chrome.runtime.onInstalled.addListener(scheduleScan);
chrome.runtime.onStartup.addListener(() => {
  scheduleScan();
  // A scan interrupted by a browser restart must not stay "scanning" forever.
  docVault().then((s) => {
    if (s.status === 'scanning') return patchDocVault({ status: 'idle', progress: undefined });
  });
});
chrome.alarms.onAlarm.addListener((a) => a.name === VAULT_ALARM && scanDocVault());

// ---------- jobs ----------

async function storedVault(): Promise<VaultData | undefined> {
  const s = await chrome.storage.session.get(VAULT_KEY);
  const l = await chrome.storage.local.get(VAULT_KEY);
  return (s[VAULT_KEY] ?? l[VAULT_KEY]) as VaultData | undefined;
}

/** Firefox content scripts get no storage.session change events, so tell the chat tabs to reload the vault. */
function notifyVaultChanged() {
  chrome.tabs
    .query({ url: ADAPTERS.flatMap((a) => a.hosts.map((h) => `https://${h}/*`)) })
    .then((tabs) => tabs.forEach((t) => t.id != null && chrome.tabs.sendMessage(t.id, { type: 'limenn:vault-changed' }).catch(() => {})))
    .catch(() => {});
}

/** Session history: one entry per question, updated as the job progresses. */
async function recordHistory(job: JobState, prompt: string, files: string[]) {
  const list = ((await chrome.storage.session.get(HISTORY_KEY))[HISTORY_KEY] ?? []) as HistoryEntry[];
  const entry: HistoryEntry = {
    id: job.id,
    at: job.createdAt,
    site: job.site,
    source: job.source,
    prompt: prompt.slice(0, 2000),
    files,
    protected: job.items.reduce((a, i) => a + i.entities.length, 0),
    status: job.status,
  };
  const i = list.findIndex((e) => e.id === job.id);
  if (i >= 0) list[i] = entry;
  else list.push(entry);
  await chrome.storage.session.set({ [HISTORY_KEY]: list.slice(-500) });
}

async function runJob(job: JobState, input: JobInput, displayPrompt = input.prompt): Promise<JobState> {
  const settings = await loadSettings();
  // Review corrections persist across restarts (chrome.storage.local).
  const session = await chrome.storage.local.get(ALLOW_KEY);
  await chrome.storage.session.set({ [LAST_INPUT_KEY]: { input, tabId: job.tabId, source: job.source, autoSend: job.autoSend, title: job.title } });
  await ensureEngine();
  publish(job);
  const res: EngineResult = await chrome.runtime.sendMessage({
    target: 'engine',
    type: 'run',
    job,
    input,
    settings,
    vault: await storedVault(),
    allow: [...((session[ALLOW_KEY] as string[]) ?? []), ...settings.allowList],
    rules: await loadProtected(),
  });
  await saveVault(new Vault(res.vault), settings.persistMapping);
  if (IS_FIREFOX) notifyVaultChanged();
  publish(res.job);
  await recordHistory(res.job, displayPrompt, [...input.files.map((f) => f.name), ...(input.vaultDocs ?? []).map((d) => d.name)]).catch(() => {});
  return res.job;
}

/** Store the latest job (for a panel opened later) and forward it to the tab's Limenn bar. */
function publish(job: JobState) {
  chrome.storage.session.set({ [LAST_JOB_KEY]: job }).catch(() => {});
  if (job.tabId != null) chrome.tabs.sendMessage(job.tabId, { type: 'limenn:job', job }).catch(() => {});
}

const titleOf = (input: JobInput) =>
  (input.prompt.trim().split('\n')[0] || input.files.map((f) => f.name).join(', ') || 'Untitled').slice(0, 80);

/** What the Limenn bar (content script on the chat site) may ask for; everything else is for extension pages only. */
const CONTENT_MESSAGES = new Set(['limenn:clean', 'limenn:status', 'limenn:answer', 'limenn:answer-status', 'limenn:warm', 'limenn:open-panel', 'limenn:workspace:open', 'limenn:vault:get']);
const ENGINE_URL = chrome.runtime.getURL('engine.html');
const WORKSPACE_URL = chrome.runtime.getURL('workspace.html');

// ---------- workspace: Limenn's own tab, with ChatGPT / Claude working in a background tab ----------

const woken = new Set<string>();
async function wakeTab(tabId: number, windowId: number) {
  const [prev] = await chrome.tabs.query({ active: true, windowId }).catch(() => []);
  await chrome.tabs.update(tabId, { active: true }).catch(() => {});
  await new Promise((r) => setTimeout(r, 2500));
  if (prev?.id != null && prev.id !== tabId) await chrome.tabs.update(prev.id, { active: true }).catch(() => {});
}

/**
 * Focus the workspace tab, or open one. Found through runtime.getContexts: querying tabs by URL would need the
 * "tabs" permission, which the extension doesn't ask for (it failed silently, so the button did nothing).
 */
async function openWorkspace(windowId?: number) {
  // Firefox has no getContexts, but it lets an extension find its own pages by URL.
  const tabId = chrome.runtime.getContexts
    ? (await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.TAB], documentUrls: [WORKSPACE_URL] }).catch(() => []))[0]?.tabId
    : (await chrome.tabs.query({ url: WORKSPACE_URL }).catch(() => []))[0]?.id;
  if (tabId != null && tabId >= 0) {
    const tab = await chrome.tabs.update(tabId, { active: true }).catch(() => undefined);
    if (tab) return void chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
  }
  await chrome.tabs.create({ url: WORKSPACE_URL, ...(windowId != null ? { windowId } : {}) });
}

/** Wait until the Limenn content script in a tab answers. */
async function contentReady(tabId: number, timeout = 30000) {
  for (const t0 = Date.now(); Date.now() - t0 < timeout; ) {
    const r = await chrome.tabs.sendMessage(tabId, { type: 'limenn:ping' }).catch(() => undefined);
    if (r?.ok) return;
    await new Promise((res) => setTimeout(res, 300));
  }
  throw new Error('The chat tab did not load. Is the site reachable, and are you logged in?');
}

/** The workspace's chat tab for a site: reused for follow-ups, opened in the background when missing. */
async function workspaceTab(site: SiteAdapter['id'], newChat: boolean, windowId?: number): Promise<number> {
  const tabs = ((await chrome.storage.session.get(WS_TABS_KEY))[WS_TABS_KEY] ?? {}) as Record<string, number>;
  let tab = tabs[site] != null ? await chrome.tabs.get(tabs[site]).catch(() => undefined) : undefined;
  if (tab?.url && pickAdapter(tab.url)?.id !== site) tab = undefined;
  if (!tab) tab = await chrome.tabs.create({ url: NEW_CHAT_URL[site], active: false, windowId });
  else if (newChat) await chrome.tabs.update(tab.id!, { url: NEW_CHAT_URL[site] });
  await chrome.storage.session.set({ [WS_TABS_KEY]: { ...tabs, [site]: tab.id } });
  if (newChat || tab.status !== 'complete') await new Promise((res) => setTimeout(res, 1500));
  await contentReady(tab.id!);
  return tab.id!;
}

async function workspaceSend(msg: { input: JobInput; site: SiteAdapter['id']; newChat?: boolean; jobId: string; displayPrompt?: string; unprotected?: boolean }, windowId?: number): Promise<JobState> {
  const tabId = await workspaceTab(msg.site, !!msg.newChat, windowId);
  const job: JobState = {
    id: msg.jobId,
    tabId,
    source: 'workspace',
    autoSend: true,
    createdAt: Date.now(),
    status: 'running',
    title: titleOf(msg.input),
    site: ADAPTERS.find((a) => a.id === msg.site)?.label,
    items: [],
    unprotected: !!msg.unprotected,
  };
  const cleaned = await runJob(job, msg.input, msg.displayPrompt);
  if (cleaned.status === 'error') return cleaned;
  // Leak guard: never send automatically when something risky is still in the cleaned text.
  if (!cleaned.unprotected && cleaned.items.some((i) => i.risks?.some((r) => r.severity === 'high'))) return { ...cleaned, status: 'cleaned' };
  const urlBefore = (await chrome.tabs.get(tabId).catch(() => undefined))?.url;
  let r = await chrome.tabs.sendMessage(tabId, { type: 'limenn:deliver', job: cleaned }).catch((e: Error) => ({ ok: false, error: e.message }));
  // Grok reloads the page once a new chat gets its own URL, which closes this message channel mid-delivery. If the
  // tab moved to a new URL the message went out, and the restarted content script keeps following the answer.
  if (!r?.ok && /channel closed|port closed|Receiving end does not exist/i.test(r?.error ?? '')) {
    const urlAfter = (await chrome.tabs.get(tabId).catch(() => undefined))?.url;
    if (urlAfter && urlAfter !== urlBefore) r = { ok: true };
  }
  const done: JobState = r?.ok ? { ...cleaned, status: 'sent' } : { ...cleaned, status: 'error', error: r?.error ?? 'Could not send' };
  publish(done);
  await recordHistory(done, msg.displayPrompt ?? msg.input.prompt, [...msg.input.files.map((f) => f.name), ...(msg.input.vaultDocs ?? []).map((d) => d.name)]).catch(() => {});
  return done;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  const fromWorkspace = sender.url?.startsWith(WORKSPACE_URL) || sender.url?.startsWith(chrome.runtime.getURL('welcome.html'));
  if (sender.tab && !fromWorkspace && !(CONTENT_MESSAGES.has(msg?.type) && sender.tab.url && pickAdapter(sender.tab.url))) return false;
  switch (msg?.type) {
    // Live progress from the engine → also to the tab (the panel receives it directly).
    case 'limenn:job':
      if (sender.url === ENGINE_URL) publish(msg.job);
      return false;

    case 'limenn:clean': {
      const input: JobInput = msg.input;
      const job: JobState = {
        id: crypto.randomUUID(),
        tabId: sender.tab?.id ?? msg.tabId,
        source: sender.tab ? 'overlay' : 'panel',
        autoSend: !!msg.autoSend,
        createdAt: Date.now(),
        status: 'running',
        title: titleOf(input),
        site: sender.tab?.url ? pickAdapter(sender.tab.url)?.label : undefined,
        items: [],
      };
      runJob(job, input).then(
        (j) => sendResponse({ ok: true, job: j }),
        (e: Error) => sendResponse({ ok: false, error: e.message }),
      );
      return true;
    }

    // Panel changed the allow/manual lists → re-run the last job with the same input.
    case 'limenn:reclean': {
      chrome.storage.session.get([LAST_INPUT_KEY, LAST_JOB_KEY]).then(async (s) => {
        const last = s[LAST_INPUT_KEY] as { input: JobInput } | undefined;
        const prev = s[LAST_JOB_KEY] as JobState | undefined;
        if (!last || !prev) return sendResponse({ ok: false, error: 'Nothing to re-clean.' });
        const job: JobState = { ...prev, status: 'running', items: [], createdAt: Date.now(), error: undefined, totalMs: undefined };
        try {
          sendResponse({ ok: true, job: await runJob(job, last.input) });
        } catch (e) {
          sendResponse({ ok: false, error: (e as Error).message });
        }
      });
      return true;
    }

    // The Limenn bar reports what happened when delivering to Claude.
    case 'limenn:status': {
      chrome.storage.session.get(LAST_JOB_KEY).then((s) => {
        const job = s[LAST_JOB_KEY] as JobState | undefined;
        if (job && job.id === msg.jobId) {
          job.status = msg.status;
          if (msg.error) job.error = msg.error;
          chrome.storage.session.set({ [LAST_JOB_KEY]: job });
          chrome.runtime.sendMessage({ type: 'limenn:job', job }).catch(() => {});
        }
      });
      return false;
    }

    case 'limenn:warm':
      loadSettings().then(async (settings) => {
        if (!settings.enableNer) return sendResponse({ ok: true });
        await ensureEngine();
        sendResponse(await chrome.runtime.sendMessage({ target: 'engine', type: 'warm', model: settings.nerModel }).catch(() => ({ ok: false })));
      });
      return true;

    case 'limenn:answer': {
      chrome.storage.session.get(LAST_JOB_KEY).then((s) => {
        const job = s[LAST_JOB_KEY] as JobState | undefined;
        if (job && job.id === msg.jobId) {
          job.answer = { text: msg.text, raw: msg.raw, done: msg.done };
          chrome.storage.session.set({ [LAST_JOB_KEY]: job });
        }
      });
      return false;
    }

    case 'limenn:vault:linked':
      // Re-authorising the same folder keeps the list; linking a new folder starts empty.
      docVault()
        .then((s) => patchDocVault({ folder: msg.folder, access: msg.access, status: 'idle', docs: msg.keepDocs ? s.docs : [], error: undefined }))
        .then(scanDocVault)
        .then(sendResponse);
      return true;

    case 'limenn:vault:unlinked':
      chrome.storage.local.set({ [DOCVAULT_KEY]: emptyDocVault() }).then(() => sendResponse({ ok: true }));
      return true;

    case 'limenn:vault:scan':
      scanDocVault().then(sendResponse);
      return true;

    case 'limenn:vault:progress':
      patchDocVault({ progress: msg.progress });
      return false;

    case 'limenn:vault:doc':
    case 'limenn:vault:review':
      ensureEngine()
        .then(() => chrome.runtime.sendMessage({ target: 'engine', type: `vault-${msg.type.split(':')[2]}`, id: msg.id, review: msg.review }))
        .then(async (r) => {
          // Keep the listed entity counts in sync after a review edit.
          if (r?.ok && msg.type === 'limenn:vault:review') {
            const s = await docVault();
            await patchDocVault({ docs: s.docs.map((d) => (d.id === msg.id ? { ...d, entityCount: r.doc.entities.length } : d)) });
          }
          sendResponse(r);
        }, (e: Error) => sendResponse({ ok: false, error: e.message }));
      return true;

    case 'limenn:workspace:send':
      workspaceSend(msg, sender.tab?.windowId).then(
        (job) => sendResponse({ ok: true, job }),
        (e: Error) => sendResponse({ ok: false, error: e.message }),
      );
      return true;

    case 'limenn:workspace:open':
      openWorkspace(sender.tab?.windowId);
      return false;

    case 'limenn:workspace:open-site':
      // Go to the chat site itself, with the Limenn bar open and focused (reuses the workspace's tab when there is one).
      (async () => {
        const tabs = ((await chrome.storage.session.get(WS_TABS_KEY))[WS_TABS_KEY] ?? {}) as Record<string, number>;
        let tab = tabs[msg.site] != null ? await chrome.tabs.get(tabs[msg.site]).catch(() => undefined) : undefined;
        tab ??= (await chrome.tabs.query({ url: ADAPTERS.find((a) => a.id === msg.site)!.hosts.map((h) => `https://${h}/*`) }))[0];
        if (tab?.id != null) await chrome.tabs.update(tab.id, { active: true });
        else tab = await chrome.tabs.create({ url: NEW_CHAT_URL[msg.site as SiteAdapter['id']], windowId: sender.tab?.windowId });
        if (tab.windowId != null) chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
        await contentReady(tab.id!);
        await chrome.tabs.sendMessage(tab.id!, { type: 'limenn:show-bar' });
      })().catch(console.error);
      return false;

    case 'limenn:workspace:show-chat':
      chrome.storage.session.get(WS_TABS_KEY).then((r) => {
        const id = ((r[WS_TABS_KEY] ?? {}) as Record<string, number>)[msg.site];
        if (id != null) chrome.tabs.update(id, { active: true }).catch(() => {});
      });
      return false;

    case 'limenn:open-panel':
      if (chrome.sidePanel) {
        if (sender.tab?.id != null) chrome.sidePanel.open({ tabId: sender.tab.id }).catch(console.error);
      } else {
        // Firefox only opens the sidebar from a user action; if this relay is not accepted as one, the toolbar button still works.
        firefoxSidebar()?.open().catch(() => {});
      }
      return false;

    case 'limenn:answer-status':
      // Some sites hold back rendering in a tab nobody looks at: if the answer has not shown up, bring the chat tab
      // forward for a moment, then go back to where the user was.
      if (msg.hidden && sender.tab?.id != null && !woken.has(msg.jobId)) {
        woken.add(msg.jobId);
        wakeTab(sender.tab.id, sender.tab.windowId);
      }
      return false;

    case 'limenn:vault:get':
      // Content scripts that cannot read chrome.storage.session (Firefox) get the vault from here.
      storedVault().then((vault) => sendResponse({ ok: true, vault: vault ?? null }));
      return true;
  }
  return false;
});
