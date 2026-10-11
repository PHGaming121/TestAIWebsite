/**
 * Puter Playground — application bootstrap and wiring.
 *
 * Everything is client-side: Puter.js provides the models and cloud services,
 * the workspace provides the files, and the agent loop ties them together.
 */
import { STARTERS, BACKENDS, KEYS } from './config.js';
import {
  $, $$, el, esc, debounce, prettyError, downloadBlob,
  readStorage, writeStorage, hasOpfs, hasFsAccessApi, formatBytes,
} from './util.js';
import { state, loadState, updateSettings, newConversation, setActive, activeConversation, addMessage, updateMessage, removeMessage, deleteConversation, renameConversation, on, saveConversations, pullFromPuterKv } from './store.js';
import { ensurePuter, shortModelName, puterUser, complete as llmComplete } from './llm.js';
import { runAgentTurn } from './agent.js';
import { ChatView, renderStarters } from './chat.js';
import { FilesPane, TermPane } from './panels.js';
import { GitHubPane } from './github-pane.js';
import { PublishPane } from './publish-pane.js';
import { MediaPane } from './media-pane.js';
import { MemoryPane } from './memory-pane.js';
import { ConnectionsPane } from './connections-pane.js';
import { ModelPicker } from './modelpicker.js';
import { openSettings } from './settings.js';
import { icon, toast, openModal, confirmDialog, promptDialog, approvalDialog, askUserDialog } from './ui.js';
import { createWorkspace, workspace, setWorkspace, onWorkspaceChange, pickDefaultBackend } from './workspace.js';
import { pullMemoriesFromCloud, pushMemoriesToCloud } from './memory.js';

/* ══════════════════════════ boot ══════════════════════════ */
const app = {
  chatView: null, filesPane: null, termPane: null, ghPane: null, pubPane: null, picker: null,
  cancelRef: { current: false },
  attachments: [],
  wsReady: false,
};

async function boot() {
  loadState();
  applyTheme(readStorage(KEYS.theme, 'dark'));
  buildSidebarBackends();
  buildWelcome();

  app.chatView = new ChatView({
    messages: $('#messages'),
    scroll: $('#chat-scroll'),
    welcome: $('#welcome'),
    getWs: () => workspace(),
    handlers: {
      onRegenerate: (m) => regenerate(m),
      onEditUser: (m) => editUserMessage(m),
      onDelete: (m) => deleteMsg(m),
      onMediaAdded: () => saveConversations(),
      onOpenFile: (path) => { switchTab('files'); app.filesPane.open(path).catch(() => {}); },
    },
  });

  app.filesPane = new FilesPane({
    treeEl: $('#file-tree'), viewEl: $('#file-view'), pathEl: $('#fv-path'),
    bodyEl: $('#fv-body'), previewEl: $('#fv-preview'), hintEl: $('#tree-hint'),
    getWs: () => workspace(),
    onChanged: () => refreshWorkspaceMeta(),
  });

  app.termPane = new TermPane({
    outEl: $('#term-out'), inEl: $('#term-in'), promptEl: $('#term-prompt'),
    runtimeEl: $('#term-runtime'), hintEl: $('#term-hint'),
    getWs: () => workspace(),
    onChanged: () => app.filesPane.refresh(),
  });
  app.termPane.setRuntime($('#term-runtime').value);

  wireStaticControls();
  renderConversations();
  renderConversation();

  // Puter.js + workspace + models (independent, run in parallel)
  const puterPromise = ensurePuter()
    .then((p) => { setPuterChip('ok', signedInLabel()); refreshUserButton(); return p; })
    .catch((e) => { setPuterChip('err', 'Puter offline'); showBanner(`${prettyError(e)} — the playground needs js.puter.com to reach the models.`); throw e; });

  initWorkspace(state.settings.backend).catch((e) => {
    toast(`Workspace: ${prettyError(e)} — falling back to memory`, { type: 'warn', timeout: 6000 });
    initWorkspace('memory');
  });

  app.picker = new ModelPicker({
    btn: $('#btn-model'), nameEl: $('#model-name'), dotEl: $('#model-dot'), menu: $('#model-menu'),
    searchEl: $('#model-search'), groupsEl: $('#model-groups'), favsEl: $('#model-favs'),
    footEl: $('#model-menu-foot'), customInput: $('#model-custom-input'), customBtn: $('#btn-model-custom'),
    refreshBtn: $('#btn-model-refresh'),
    onSelected: (id, key) => {
      const conv = activeConversation();
      if (conv) { conv.model = id; saveConversations(); }
      toast(`Model → ${shortModelName(id)}`, { type: 'ok', timeout: 2200 });
      renderConversations();
    },
  });
  app.picker.updateButton();

  // GitHub + publish panes need settings access
  app.ghPane = new GitHubPane({
    container: $('#gh-pane'), sideBody: $('#gh-body'), sidePill: $('#gh-pill'),
    getWs: () => workspace(),
    state: {
      settings: state.settings,
      updateSettings,
      openTab: (t) => switchTab(t),
      onWorkspaceChanged: () => app.filesPane.refresh(),
    },
    onConnected: () => { refreshWorkspaceMeta(); },
  });
  app.mediaPane = new MediaPane({
    container: $('#media-pane'), getWs: () => workspace(),
    onMedia: (media) => app.chatView.showMedia(activeConversation(), media),
    openFile: (path) => { switchTab('files'); app.filesPane.open(path).catch(() => {}); },
  });

  app.memPane = new MemoryPane({
    container: $('#memory-pane'),
    getSettings: () => state.settings,
    updateSettings,
    activeConv: () => activeConversation(),
    complete: (messages, opts) => llmComplete(messages, opts),
  });

  app.connPane = new ConnectionsPane({
    container: $('#connect-pane'),
    getSettings: () => state.settings,
    updateSettings,
    onModelsChanged: () => app.picker?.load({ force: true }),
  });

  app.pubPane = new PublishPane({
    container: $('#pub-pane'), getWs: () => workspace(),
    state: {
      settings: state.settings, updateSettings,
      activeConv: () => activeConversation(),
      githubPane: app.ghPane, filesPane: app.filesPane,
      openTab: (t) => switchTab(t),
    },
  });

  await puterPromise.catch(() => {});
  app.picker.load();
  setMode(activeConversation()?.mode || state.settings.mode, { silent: true });
  refreshWorkspaceMeta();

  // panel state: remember it; default open on wide screens, closed on narrow ones
  setPanelOpen(state.settings.panelOpen ?? window.innerWidth > 1180, { persist: false });

  // reveal
  $('#boot').classList.add('gone');
  setTimeout(() => $('#boot').remove(), 400);
  $('#app').hidden = false;
  $('#input').focus();

  // cross-device history
  if (state.settings.syncPuterKv) pullFromPuterKv().then((pulled) => { if (pulled) { renderConversations(); renderConversation(); } });

  // cross-device long-term memory
  if (state.settings.memorySync) {
    pullMemoriesFromCloud()
      .then((r) => {
        if (r.added || r.updated) {
          app.memPane?.refresh();
          toast(`Memory: ${r.added} new, ${r.updated} updated from your Puter cloud`, { type: 'ok', timeout: 5000 });
        }
      })
      .catch(() => { /* offline or signed out — local memory still works */ });
  }

  // keep the settings object live for panes that captured it
  on('settings', (s) => {
    if (app.ghPane) app.ghPane.state.settings = s;
    if (app.pubPane) app.pubPane.state.settings = s;
  });
  onWorkspaceChange(() => { app.filesPane.refreshTree(); refreshWorkspaceMeta(); });
}

function signedInLabel() {
  try {
    if (!window.puter?.auth) return 'Puter ready';
    // Signed out is a call to action, not a status: the models need a (free) login.
    return window.puter.auth.isSignedIn() ? 'Puter · signed in' : 'Sign in to Puter (free)';
  } catch { return 'Puter ready'; }
}

async function initWorkspace(backendId) {
  const want = backendId === 'auto' ? pickDefaultBackend() : backendId;
  const ws = await createWorkspace(want, { dirName: state.settings.puterDir });
  setWorkspace(ws);
  app.wsReady = true;
  updateSettings({ backend: want });
  buildSidebarBackends();
  await app.filesPane.refresh();
  refreshWorkspaceMeta();
  return ws;
}

/* ══════════════════════════ static controls ══════════════════════════ */
function wireStaticControls() {
  // mode switch
  $$('.mode-switch button').forEach((b) => {
    b.onclick = () => setMode(b.dataset.mode);
  });

  // new conversation
  $('#btn-new-chat').onclick = () => { startNewConversation(); $('#input').focus(); };

  // conversation search
  $('#conv-search').addEventListener('input', debounce(() => renderConversations($('#conv-search').value.trim().toLowerCase()), 120));

  // composer
  const input = $('#input');
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(230, input.scrollHeight) + 'px';
    updateContextMeter();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); }
    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey && state.settings.enterToSend !== false) {
      // Enter sends on desktop; Shift+Enter always makes a newline
      if (window.innerWidth > 880) { e.preventDefault(); send(); }
    }
  });
  $('#btn-send').onclick = () => send();
  $('#btn-stop').onclick = stopRun;

  $('#opt-stream').checked = state.settings.stream !== false;
  $('#opt-stream').onchange = (e) => updateSettings({ stream: e.target.checked });
  $('#opt-auto').checked = !!state.settings.autoApprove;
  $('#opt-auto').onchange = (e) => updateSettings({ autoApprove: e.target.checked });

  // attachments
  $('#btn-attach').onclick = () => $('#file-picker').click();
  $('#file-picker').addEventListener('change', async (e) => {
    await handleFiles(e.target.files);
    e.target.value = '';
  });

  // drag & drop anywhere → import into workspace (images also attach)
  ['dragenter', 'dragover'].forEach((ev) => document.addEventListener(ev, (e) => { e.preventDefault(); document.body.classList.add('dragging'); }));
  ['dragleave', 'drop'].forEach((ev) => document.addEventListener(ev, (e) => { e.preventDefault(); if (ev === 'dragleave' && e.relatedTarget) return; document.body.classList.remove('dragging'); }));
  document.addEventListener('drop', async (e) => {
    const files = e.dataTransfer?.files;
    if (!files?.length) return;
    await handleFiles(files);
  });

  // sidebar / panel toggles
  $('#btn-sidebar').onclick = () => $('#sidebar').classList.toggle('open');
  $('#btn-workspace').onclick = () => setPanelOpen(!panelOpen());
  $('#btn-wp-close').onclick = () => setPanelOpen(false);
  $('#btn-settings').onclick = () => openSettingsModal();
  $('#btn-theme').onclick = () => applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
  $('#chip-puter').onclick = () => puterAccountModal();
  $('#btn-user').onclick = () => puterAccountModal();

  // workspace actions
  $('#btn-import').onclick = () => { const i = el('input', { type: 'file', multiple: true, webkitdirectory: '' }); i.onchange = async () => { await importToWorkspace(i.files); }; i.click(); };
  $('#btn-zip').onclick = async () => {
    try { downloadBlob(await workspace().exportZip(), 'workspace.zip'); toast('ZIP downloaded', { type: 'ok' }); }
    catch (e) { toast(prettyError(e), { type: 'err' }); }
  };
  $('#btn-ws-clear').onclick = async () => {
    if (!await confirmDialog({ title: 'Clear the workspace?', message: 'Every file in the current backend is deleted. This cannot be undone.', danger: true, confirmLabel: 'Delete everything' })) return;
    try { await workspace().clear(); await app.filesPane.refresh(); refreshWorkspaceMeta(); toast('Workspace cleared', { type: 'ok' }); }
    catch (e) { toast(prettyError(e), { type: 'err' }); }
  };
  $('#btn-refresh-tree').onclick = () => app.filesPane.refresh();
  $('#btn-new-file').onclick = () => app.filesPane.newFile();
  $('#btn-fv-edit').onclick = () => (app.filesPane.editing ? app.filesPane.saveEdit(app.filesPane.bodyEl.querySelector('textarea')?.value) : app.filesPane.startEdit());
  $('#btn-fv-copy').onclick = async () => {
    const text = app.filesPane.bodyEl.querySelector('textarea')?.value ?? app.filesPane.bodyEl.textContent;
    await navigator.clipboard?.writeText(text).catch(() => {});
    toast('File copied', { type: 'ok', timeout: 1600 });
  };
  $('#btn-fv-download').onclick = () => app.filesPane.download(app.filesPane.selected);
  $('#fv-path').addEventListener('dblclick', () => app.filesPane.togglePreview());

  // terminal
  $('#btn-term-run').onclick = () => app.termPane.run();
  $('#btn-term-clear').onclick = () => app.termPane.clear();
  $('#term-runtime').onchange = (e) => app.termPane.setRuntime(e.target.value);

  // workspace panel tabs — clicking the active tab collapses the panel again
  $$('.wp-tab').forEach((t) => {
    t.onclick = () => {
      if (t.dataset.pane === activeTab() && panelOpen()) setPanelOpen(false);
      else switchTab(t.dataset.pane);
    };
  });

  // global shortcuts
  document.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); app.picker.focusSearch(); }
    if (mod && e.key.toLowerCase() === 'b') { e.preventDefault(); $('#sidebar').classList.toggle('open'); }
    if (mod && e.key.toLowerCase() === 'j') { e.preventDefault(); setPanelOpen(!panelOpen()); }
    if (mod && e.key === '1') { e.preventDefault(); setMode('chat'); }
    if (mod && e.key === '2') { e.preventDefault(); setMode('agent'); }
    if (mod && e.key.toLowerCase() === 'n' && e.shiftKey) { e.preventDefault(); startNewConversation(); }
    if (e.key === 'Escape' && app.cancelRef.current !== undefined && state.busy) stopRun();
    else if (e.key === 'Escape' && panelOpen() && !document.querySelector('.modal-backdrop')) setPanelOpen(false);
  });
}

/* ── workspace panel visibility (desktop: shown inline, narrow: slide-in drawer) ── */
const activeTab = () => $('.wp-tab.active')?.dataset.pane || 'files';
const panelOpen = () => $('#wpanel').classList.contains('open');

function setPanelOpen(open, { persist = true } = {}) {
  $('#wpanel').classList.toggle('open', !!open);
  $('#btn-workspace')?.setAttribute('aria-expanded', String(!!open));
  if (persist) updateSettings({ panelOpen: !!open });
  if (open && activeTab() === 'files') app.filesPane?.refresh();
}

function switchTab(name) {
  $$('.wp-tab').forEach((t) => t.classList.toggle('active', t.dataset.pane === name));
  $$('.wp-pane').forEach((p) => p.classList.toggle('active', p.dataset.pane === name));
  setPanelOpen(true);
  if (name === 'files') app.filesPane.refresh();
  if (name === 'create') app.mediaPane?.loadRefs();
  if (name === 'memory') app.memPane?.refresh();
  if (name === 'connect') app.connPane?.refresh();
  if (name === 'github') app.ghPane.renderSide();
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  writeStorage(KEYS.theme, theme);
}

function setPuterChip(kind, text) {
  const chip = $('#chip-puter');
  chip.className = `chip clickable ${kind}`;
  chip.innerHTML = '';
  chip.append(el('i.dot'), document.createTextNode(text));
}

function showBanner(text) {
  const b = $('#banner');
  b.hidden = false;
  b.innerHTML = '';
  b.append(el('span', { text }), el('button.btn.tiny', { text: 'dismiss', onclick: () => { b.hidden = true; } }));
}

async function refreshUserButton() {
  const user = await puterUser();
  state.puterUser = user;
  const av = $('#user-avatar');
  av.innerHTML = '';
  if (user?.avatar || user?.profile?.picture) {
    av.append(el('img', { src: user.avatar || user.profile.picture, alt: user.username || 'user' }));
  } else {
    av.textContent = user ? (user.username || '?').slice(0, 1).toUpperCase() : '+';
  }
  $('#btn-user').title = user ? `Puter account: ${user.username || user.email}` : 'Sign in to Puter (free) — needed to call the models';
  setPuterChip(user ? 'ok' : 'warn', user ? `Puter · ${user.username}` : 'Sign in to Puter (free)');
}

/* ══════════════════════════ sidebar ══════════════════════════ */
function buildSidebarBackends() {
  const host = $('#backend-list');
  host.innerHTML = '';
  const current = workspace()?.id || state.settings.backend;
  for (const b of BACKENDS) {
    const disabled = (b.id === 'opfs' && !hasOpfs()) || (b.id === 'local' && !hasFsAccessApi()) || (b.id === 'puter' && !window.puter?.fs);
    const row = el(`div.backend${b.id === current ? ' sel' : ''}${disabled ? ' dis' : ''}`, { title: disabled ? 'Not supported in this browser' : b.desc },
      el('span.radio'),
      el('div', {}, el('div.b-name', { text: b.name }), el('div.b-desc', { text: b.desc })),
    );
    row.onclick = async () => {
      if (disabled) { toast(`${b.name} is not available in this browser`, { type: 'warn' }); return; }
      if (b.id === current) return;
      row.style.opacity = '.6';
      try {
        await initWorkspace(b.id);
        toast(`Workspace → ${b.name}`, { type: 'ok' });
      } catch (e) {
        toast(prettyError(e), { type: 'err', timeout: 6000 });
        buildSidebarBackends();
      }
    };
    host.append(row);
  }
  $('#ws-pill').textContent = current || '—';
}

async function refreshWorkspaceMeta() {
  const ws = workspace();
  const meta = $('#ws-meta');
  if (!ws) { meta.innerHTML = ''; return; }
  let stats = { files: 0, dirs: 0, bytes: 0 };
  try { stats = await ws.stats(); } catch { /* ignore */ }
  meta.innerHTML = '';
  meta.append(
    el('div', {}, el('b', { text: ws.rootLabel || ws.id })),
    el('div', { text: `${stats.files} file${stats.files === 1 ? '' : 's'}${stats.dirs ? ` · ${stats.dirs} folder${stats.dirs === 1 ? '' : 's'}` : ''} · ${formatBytes(stats.bytes)}` }),
  );
  $('#ws-pill').textContent = ws.id;
  buildSidebarBackends();
}

function renderConversations(filter = '') {
  const host = $('#conv-list');
  host.innerHTML = '';
  const convs = state.conversations.filter((c) => !filter || (c.title || '').toLowerCase().includes(filter));
  if (!convs.length) {
    host.append(el('div.empty-note', { html: filter ? 'No matches.' : 'No conversations yet.<br>Start one above.' }));
    return;
  }
  for (const c of convs) {
    const row = el(`div.conv${c.id === state.activeId ? ' active' : ''}`);
    row.append(
      el('div.msg-av', { style: { width: '24px', height: '24px', borderRadius: '7px', fontSize: '10px' }, text: c.mode === 'agent' ? 'AG' : 'CH' }),
      el('div.conv-main', {},
        el('div.conv-title', { text: c.title || 'Untitled' }),
        el('div.conv-sub', {},
          el('span', { text: shortModelName(c.model) }),
          el('span', { text: `· ${(c.messages || []).length} msg` }),
        ),
      ),
      el('div.conv-actions', {},
        (() => { const b = el('button', { title: 'Rename' }, icon('edit')); b.onclick = async (e) => { e.stopPropagation(); const t = await promptDialog({ title: 'Rename conversation', value: c.title }); if (t) { renameConversation(c.id, t); renderConversations(filter); } }; return b; })(),
        (() => { const b = el('button', { title: 'Delete' }, icon('trash')); b.onclick = async (e) => { e.stopPropagation(); if (await confirmDialog({ title: 'Delete conversation?', message: c.title, danger: true, confirmLabel: 'Delete' })) { deleteConversation(c.id); renderConversations(filter); renderConversation(); } }; return b; })(),
      ),
    );
    row.onclick = () => { setActive(c.id); renderConversation(); if (window.innerWidth <= 880) $('#sidebar').classList.remove('open'); };
    host.append(row);
  }
}

function renderConversation() {
  const conv = activeConversation();
  app.attachments = [];
  renderAttachments();
  if (!conv) {
    app.chatView.clear();
    app.chatView.showWelcome(true);
    updateModeHint();
    return;
  }
  app.chatView.renderConversation(conv);
  if (conv.model) {
    const key = conv.mode === 'agent' ? 'agentModel' : 'model';
    if (state.settings[key] !== conv.model) updateSettings({ [key]: conv.model });
  }
  setMode(conv.mode || 'chat', { silent: true });
  app.picker?.updateButton();
  updateModeHint();
  updateContextMeter();
}

function startNewConversation() {
  const conv = newConversation({ mode: state.settings.mode, model: state.settings.mode === 'agent' ? state.settings.agentModel : state.settings.model });
  renderConversations();
  renderConversation();
  return conv;
}

function setMode(mode, { silent = false } = {}) {
  if (mode !== 'chat' && mode !== 'agent') return;
  updateSettings({ mode });
  $$('.mode-switch button').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  const conv = activeConversation();
  if (conv && conv.mode !== mode && !(conv.messages || []).length) {
    conv.mode = mode;
    conv.model = mode === 'agent' ? state.settings.agentModel : state.settings.model;
    saveConversations();
  }
  app.picker?.updateButton();
  updateModeHint();
  $('#input').placeholder = mode === 'agent'
    ? 'Describe what to build — the agent writes files, runs code and can ship it…'
    : 'Ask anything…';
  if (!silent && mode === 'agent') toast('Agent mode: the model can use tools (files, shell, Python, GitHub)', { type: 'info', timeout: 3600 });
}

function updateModeHint() {
  const conv = activeConversation();
  const mode = conv?.mode || state.settings.mode;
  $('#mode-hint').textContent = mode === 'agent' ? `Agent · ${shortModelName(conv?.model || state.settings.agentModel)}` : `Chat · ${shortModelName(conv?.model || state.settings.model)}`;
}

function updateContextMeter() {
  const conv = activeConversation();
  const chars = (conv?.messages || []).reduce((a, m) => a + (typeof m.content === 'string' ? m.content.length : 0) +
    (m.toolCalls || []).reduce((b, c) => b + String(c.result || '').length, 0), 0);
  $('#ctx-meter').textContent = `~${Math.ceil(chars / 4).toLocaleString()} tok`;
  $('#ctx-meter').title = `Rough context size of this conversation (${chars.toLocaleString()} chars ≈ ${Math.ceil(chars / 4).toLocaleString()} tokens)`;
}

/* ══════════════════════════ attachments ══════════════════════════ */
async function handleFiles(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return;
  const images = files.filter((f) => f.type.startsWith('image/') && f.size < 6_000_000);
  const others = files.filter((f) => !images.includes(f));

  for (const f of images.slice(0, 4)) {
    const dataUrl = await new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(f); });
    app.attachments.push({ name: f.name, type: f.type, size: f.size, dataUrl });
  }
  renderAttachments();

  if (others.length) {
    const n = await importToWorkspace(others);
    toast(`${n} file(s) added to the workspace`, { type: 'ok' });
  }
  if (images.length) toast(`${images.length} image(s) attached to the next message`, { type: 'ok', timeout: 2200 });
}

function renderAttachments() {
  const host = $('#attachments');
  host.innerHTML = '';
  app.attachments.forEach((a, i) => {
    host.append(el('div.att', {},
      a.dataUrl ? el('img', { src: a.dataUrl, alt: a.name }) : icon('file'),
      el('span.att-name', { text: `${a.name} (${formatBytes(a.size || 0)})` }),
      (() => { const b = el('button', { text: '×', title: 'Remove' }); b.onclick = () => { app.attachments.splice(i, 1); renderAttachments(); }; return b; })(),
    ));
  });
}

async function importToWorkspace(fileList) {
  const ws = workspace();
  try {
    const n = await ws.importFiles(fileList);
    await app.filesPane.refresh();
    refreshWorkspaceMeta();
    return n;
  } catch (e) {
    toast(prettyError(e), { type: 'err' });
    return 0;
  }
}

/* ══════════════════════════ sending ══════════════════════════ */
async function send(textOverride) {
  if (state.busy) { toast('Still working — press Stop first', { type: 'warn' }); return; }
  const input = $('#input');
  // `textOverride` must be a string — event handlers pass an Event, which we ignore
  const text = (typeof textOverride === 'string' ? textOverride : input.value).trim();
  if (!text && !app.attachments.length) { input.focus(); return; }

  // Puter pops its own login window on the first model call — explain that first.
  if (!await maybeExplainPuter()) { input.focus(); return; }

  let conv = activeConversation();
  const mode = state.settings.mode;
  if (!conv) conv = newConversation({ mode });
  if (conv.mode !== mode && !(conv.messages || []).length) conv.mode = mode;

  const model = mode === 'agent' ? (conv.model || state.settings.agentModel) : (conv.model || state.settings.model);
  conv.model = model;

  const attachments = app.attachments.slice();
  app.attachments = [];
  renderAttachments();

  // non-image attachments were already imported; mention them so the model knows
  let content = text;
  if (attachments.length) {
    content += (content ? '\n\n' : '') + `[attached: ${attachments.map((a) => a.name).join(', ')}]`;
  }

  addMessage(conv, { role: 'user', content, attachments: attachments.map((a) => ({ name: a.name, type: a.type, dataUrl: a.dataUrl })) });
  input.value = '';
  input.style.height = 'auto';
  app.chatView.renderConversation(conv);
  renderConversations($('#conv-search').value.trim().toLowerCase());
  updateContextMeter();

  await runTurn(conv);
}

async function runTurn(conv) {
  state.busy = true;
  app.cancelRef.current = false;
  setRunbar(true, conv.mode === 'agent' ? 'Agent starting…' : 'Thinking…');
  $('#btn-send').disabled = true;

  const started = performance.now();
  let currentMsg = null;

  const ui = {
    beginAssistant: ({ step, model }) => {
      currentMsg = addMessage(conv, { role: 'assistant', content: '', model, step, toolCalls: [], streaming: true });
      app.chatView.appendMessage(conv, currentMsg);
      return currentMsg;
    },
    onText: (msg, delta, full) => {
      msg.content = full;
      app.chatView.streamText(conv, msg, full);
    },
    onReasoning: (msg, delta, full) => {
      msg.reasoning = full;
      app.chatView.streamReasoning(conv, msg, full);
    },
    onPendingCalls: (msg, calls) => {
      msg.toolCalls = calls.map((c) => ({ ...c, status: 'running' }));
      for (const c of calls) app.chatView.addPendingToolCard(msg, c);
      setRunbar(true, `calling ${calls.map((c) => c.name).join(', ')}…`);
    },
    onFinal: (msg, { text, reasoning, calls, usage }) => {
      msg.content = text || msg.content || '';
      msg.reasoning = reasoning || msg.reasoning || '';
      msg.usage = usage || msg.usage;
      msg.streaming = false;
      msg.ms = Math.round(performance.now() - started);
      if (calls?.length) {
        const byId = new Map((msg.toolCalls || []).map((c) => [c.id, c]));
        for (const c of calls) if (!byId.has(c.id)) msg.toolCalls.push({ ...c, status: 'running' });
      }
      updateMessage(conv, msg.id, { content: msg.content, reasoning: msg.reasoning, usage: msg.usage, streaming: false, ms: msg.ms, toolCalls: msg.toolCalls });
      app.chatView.finishStreaming(conv, msg);
    },
    onError: (msg, error) => {
      msg.error = error;
      msg.streaming = false;
      if (!msg.content) msg.content = `⚠️ ${error}`;
      updateMessage(conv, msg.id, { content: msg.content, error, streaming: false });
      app.chatView.finishStreaming(conv, msg);
      app.chatView.addNotice(error, 'err');
      maybeSuggestFallback(error);
    },
    onStep: ({ step, maxSteps, model }) => setRunbar(true, `step ${step}/${maxSteps} · ${shortModelName(model)}`),
    onToolStart: (call) => {
      if (currentMsg) {
        const existing = (currentMsg.toolCalls || []).find((c) => c.id === call.id);
        if (!existing) currentMsg.toolCalls = [...(currentMsg.toolCalls || []), { ...call, status: 'running' }];
        app.chatView.addPendingToolCard(currentMsg, call);
      }
      setRunbar(true, `running ${call.name}…`);
    },
    onToolEnd: (record) => {
      if (!currentMsg) return;
      const i = (currentMsg.toolCalls || []).findIndex((c) => c.id === record.id);
      if (i >= 0) currentMsg.toolCalls[i] = record;
      else currentMsg.toolCalls = [...(currentMsg.toolCalls || []), record];
      app.chatView.updateToolCard(currentMsg, record);
      updateMessage(conv, currentMsg.id, { toolCalls: currentMsg.toolCalls });
    },
    onOutput: (level, text) => {
      if (text) app.termPane.printBlock('', text, level === 'error' ? 'err' : level === 'info' ? 'dim' : '');
      switchTabSilent('term');
    },
    onProgress: (frac, label) => setRunbar(true, label, frac),
    onWorkspaceChanged: () => { app.filesPane.refresh(); refreshWorkspaceMeta(); },
    askUser: (q, options) => askUserDialog(q, options),
    onMedia: (media) => { app.chatView.showMedia(activeConversation(), media); app.filesPane.refresh(); },
    onMemory: () => { app.memPane?.refresh(); queueMemoryPush(); },
    requestApproval: (call) => approvalDialog(call),
    setRepo: (full) => app.ghPane?.setRepo(full),
  };

  try {
    const result = await runAgentTurn({ conv, settings: state.settings, ws: workspace(), ui, cancelRef: app.cancelRef });
    conv.meta = conv.meta || {};
    conv.meta.steps = (conv.meta.steps || 0) + result.steps;
    conv.meta.promptTokens = (conv.meta.promptTokens || 0) + (result.usage?.prompt_tokens || 0);
    conv.meta.completionTokens = (conv.meta.completionTokens || 0) + (result.usage?.completion_tokens || 0);

    if (result.stopped) {
      app.chatView.addNotice(result.text ? 'Stopped — partial results kept.' : 'Stopped before the model replied.', 'warn');
      if (result.text && (!currentMsg || !currentMsg.content)) {
        addMessage(conv, { role: 'assistant', content: result.text, model: conv.model });
        app.chatView.renderConversation(conv);
      }
    } else if (result.text && (!currentMsg || (currentMsg.content || '').trim() !== result.text.trim())) {
      // finish-tool summary or a text-protocol answer that never streamed
      if (currentMsg && !currentMsg.content) {
        currentMsg.content = result.text;
        updateMessage(conv, currentMsg.id, { content: result.text, streaming: false });
        app.chatView.renderConversation(conv);
      } else if (!currentMsg) {
        addMessage(conv, { role: 'assistant', content: result.text, model: conv.model, toolCalls: [] });
        app.chatView.renderConversation(conv);
      }
    }

    if (conv.mode === 'agent' && result.toolCalls.length) {
      const changed = [...new Set(result.toolCalls.filter((c) => /^(write_file|edit_file|delete_file|make_directory|rename_file)$/.test(c.name)).map((c) => c.args?.path).filter(Boolean))];
      if (changed.length) {
        toast(`Workspace changed: ${changed.length} file(s) — see the Files tab`, { type: 'ok', timeout: 4200, action: { label: 'Open', onClick: () => switchTab('files') } });
        switchTabSilent('files');
      }
      await app.filesPane.refresh();
      refreshWorkspaceMeta();
    }
    saveConversations();
    renderConversations($('#conv-search').value.trim().toLowerCase());
    updateContextMeter();
  } catch (e) {
    app.chatView.addNotice(prettyError(e), 'err');
    maybeSuggestFallback(prettyError(e));
  } finally {
    state.busy = false;
    setRunbar(false);
    $('#btn-send').disabled = false;
    app.cancelRef.current = false;
    $('#input').focus();
  }
}

function switchTabSilent(name) {
  if (window.innerWidth > 1180) {
    $$('.wp-tab').forEach((t) => t.classList.toggle('active', t.dataset.pane === name));
    $$('.wp-pane').forEach((p) => p.classList.toggle('active', p.dataset.pane === name));
  }
}

function maybeSuggestFallback(errorText) {
  const e = String(errorText || '').toLowerCase();
  if (/model|not found|invalid_model|does not exist|unsupported/.test(e)) {
    toast('That model rejected the request — try another one (Ctrl+K)', { type: 'warn', timeout: 7000, action: { label: 'Models', onClick: () => app.picker.focusSearch() } });
  } else if (/sign ?in|auth|401|403|permission/.test(e)) {
    toast('Puter wants you to sign in for this one — it is free', { type: 'warn', timeout: 7000, action: { label: 'Sign in', onClick: () => puterSignIn() } });
  } else if (/rate|429|quota|limit/.test(e)) {
    toast('Rate limited — signing in to Puter raises the allowance', { type: 'warn', timeout: 7000, action: { label: 'Sign in', onClick: () => puterSignIn() } });
  }
}

function setRunbar(show, text = '', frac = null) {
  const bar = $('#runbar');
  bar.hidden = !show;
  if (show) {
    $('#runbar-text').textContent = text;
    $('#runbar-step').textContent = frac !== null ? `${Math.round(frac * 100)}%` : '';
  }
}

function stopRun() {
  if (!state.busy) return;
  app.cancelRef.current = true;
  setRunbar(true, 'Stopping…');
  toast('Stop requested — finishing the current tool', { type: 'warn', timeout: 2500 });
}

/* ══════════════════════════ message actions ══════════════════════════ */
async function regenerate(m) {
  const conv = activeConversation();
  if (!conv || state.busy) return;
  // drop this assistant message and everything after it, then re-run
  const idx = conv.messages.findIndex((x) => x.id === m.id);
  conv.messages = conv.messages.slice(0, idx);
  saveConversations();
  app.chatView.renderConversation(conv);
  await runTurn(conv);
}

async function editUserMessage(m) {
  const conv = activeConversation();
  if (!conv || state.busy) return;
  const text = await promptDialog({ title: 'Edit your message', label: 'Message', value: typeof m.content === 'string' ? m.content : '', multiline: true, confirmLabel: 'Send' });
  if (text === null) return;
  const idx = conv.messages.findIndex((x) => x.id === m.id);
  conv.messages = conv.messages.slice(0, idx);
  addMessage(conv, { role: 'user', content: text });
  app.chatView.renderConversation(conv);
  await runTurn(conv);
}

async function deleteMsg(m) {
  const conv = activeConversation();
  if (!conv) return;
  removeMessage(conv, m.id);
  app.chatView.renderConversation(conv);
  renderConversations();
}

/* ══════════════════════════ welcome ══════════════════════════ */
function buildWelcome() {
  renderStarters($('#welcome-grid'), STARTERS, async (s) => {
    setMode(s.mode);
    const conv = activeConversation() && !(activeConversation().messages || []).length
      ? activeConversation()
      : newConversation({ mode: s.mode });
    conv.mode = s.mode;
    conv.model = s.mode === 'agent' ? state.settings.agentModel : state.settings.model;
    saveConversations();
    renderConversation();
    $('#input').value = s.text;
    $('#input').dispatchEvent(new Event('input'));
    $('#input').focus();
    if (s.mode === 'agent' && window.innerWidth > 1180) switchTab('files');
  });
}

/** Mirror memory into the user's Puter KV after changes (debounced, best-effort). */
const queueMemoryPush = debounce(() => {
  if (!state.settings.memorySync) return;
  pushMemoriesToCloud().catch(() => { /* signed out or offline */ });
}, 1200);

/* ══════════════════════════ puter account ══════════════════════════ */

/**
 * Shown once, before the first message, while signed out: Puter.js pops its own
 * login window on the first model call and users deserve to know what that means
 * for their money *before* it appears, not after.
 */
async function maybeExplainPuter() {
  try { if (localStorage.getItem(KEYS.seenSignInNote)) return true; } catch { return true; }
  // Puter not loaded (or mocked away): the normal error path will explain instead.
  if (typeof window.puter?.auth?.isSignedIn !== 'function') return true;
  try {
    if (window.puter.auth.isSignedIn()) {
      localStorage.setItem(KEYS.seenSignInNote, '1');
      return true;
    }
  } catch { return true; }

  const ok = await confirmDialog({
    title: 'Before your first message — how Puter billing works',
    html: true,
    confirmLabel: 'Got it, continue',
    cancelLabel: 'Not now',
    message: `
      <p>This site has <b>no server and no API keys</b>. It reaches the models through
      <b>Puter.js</b>, which uses a <b>&ldquo;user pays&rdquo;</b> model:</p>
      <ul class="tight">
        <li><b>Signing in is free</b> — no card, no paid plan. A Puter window pops up on
            the first model call; that is Puter's own login, not this app's.</li>
        <li>Your Puter account comes with an <b>included free allowance</b> of AI usage,
            which covers ordinary chatting and coding sessions.</li>
        <li>If you exhaust that allowance, <b>Puter</b> (not this app) asks you to add
            credits or upgrade. Nothing here can charge you behind your back — you always
            see Puter's own prompt, and you can stop at any time.</li>
        <li>Whoever published this site pays <b>$0</b>: there is no shared key and no
            quota baked into the app, which is why it can offer every model.</li>
      </ul>
      <p class="hint">So &ldquo;unlimited&rdquo; means: no limits imposed by <i>this app</i>.
      Your own Puter account&rsquo;s allowance is the real ceiling.</p>`,
  });

  if (ok) {
    try { localStorage.setItem(KEYS.seenSignInNote, '1'); } catch { /* private mode */ }
    return true;
  }
  toast('Puter will ask you to sign in (free) when you send a message', { type: 'warn', timeout: 6000 });
  return false;
}

async function puterSignIn() {
  try {
    await ensurePuter();
    await window.puter.auth.signIn();
    await refreshUserButton();
    toast('Signed in to Puter', { type: 'ok' });
    if (state.settings.backend === 'puter') await initWorkspace('puter');
    // only touch the cloud mirror when the user actually switched it on
    if (state.settings.memorySync) {
      pushMemoriesToCloud().catch(() => {});
    }
  } catch (e) { toast(prettyError(e), { type: 'err' }); }
}

function puterAccountModal() {
  const user = state.puterUser;
  const body = el('div', {},
    user ? el('div.notice.ok', { html: `Signed in as <b>${esc(user.username || user.email || 'user')}</b>${user.email ? ` (${esc(user.email)})` : ''}<br>UUID: <code>${esc(user.uuid || '—')}</code>` })
         : el('div.notice', { html: 'Not signed in. Signing in is <b>free</b> and needs no card — it unlocks the models, the cloud workspace and publishing to <code>*.puter.site</code>. Puter.js pops this window up automatically on the first model call.' }),
    el('div.setting-group', { style: { marginTop: '14px' } },
      el('h4', { text: 'Who pays for the AI?' }),
      el('p.hint', { style: { fontSize: '12.6px', color: 'var(--text-dim)' }, html: `This playground has no API keys and no server, so it has no bill of its own. Puter.js runs a <i>user-pays</i> model: your own Puter account covers your AI calls. Accounts are free to create and include a free allowance; if you exhaust it, Puter asks you to add credits or upgrade — that prompt comes from Puter, never from this app, and the person hosting this site pays nothing either way.` }),
    ),
    el('div.setting-group', {},
      el('h4', { text: 'Session' }),
      el('div.btn-row', {},
        user ? el('button.btn.danger', { text: 'Sign out', onclick: async () => { try { await window.puter.auth.signOut(); toast('Signed out'); modal.close(); refreshUserButton(); } catch (e) { toast(prettyError(e), { type: 'err' }); } } })
             : el('button.btn.primary', { text: 'Sign in to Puter', onclick: async () => { modal.close(); await puterSignIn(); } }),
        el('button.btn', { text: 'Open puter.com', onclick: () => window.open('https://puter.com', '_blank', 'noopener') }),
      ),
    ),
  );
  const modal = openModal({ title: 'Puter account', iconName: 'user', body });
}

function openSettingsModal() {
  openSettings({
    models: app.picker?.models || [],
    openModelPicker: (key) => {
      if (key === 'agentModel' && state.settings.mode !== 'agent') setMode('agent', { silent: true });
      if (key === 'model' && state.settings.mode !== 'chat') setMode('chat', { silent: true });
      app.picker.focusSearch();
    },
    focusSidebar: () => $('#sidebar').classList.add('open'),
    clearWorkspace: async () => $('#btn-ws-clear').click(),
    puterUserLabel: () => (state.puterUser ? `Signed in as ${state.puterUser.username || state.puterUser.email}` : 'Not signed in'),
    isSignedIn: () => !!state.puterUser,
    toggleSignIn: async () => {
      if (state.puterUser) { try { await window.puter.auth.signOut(); toast('Signed out'); } catch (e) { toast(prettyError(e), { type: 'err' }); } }
      else await puterSignIn();
      refreshUserButton();
    },
    syncNow: () => saveConversations(),
    exportAll: () => {
      const payload = { exportedAt: new Date().toISOString(), settings: state.settings, conversations: state.conversations };
      downloadBlob(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }), 'puter-playground-export.json');
      toast('Exported', { type: 'ok' });
    },
    onChanged: () => { app.picker?.updateButton(); updateModeHint(); buildSidebarBackends(); },
  });
}

/* ══════════════════════════ start ══════════════════════════ */
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();

window.addEventListener('error', (e) => {
  console.error('[pp] uncaught', e.error || e.message);
});

export { app };
