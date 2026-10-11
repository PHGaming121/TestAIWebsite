/**
 * Application state: settings + conversation history, persisted to localStorage
 * and (optionally) mirrored into Puter KV so it follows the user across devices.
 */
import { DEFAULTS, KEYS } from './config.js';
import { readStorage, writeStorage, uid, debounce, prettyError } from './util.js';

const listeners = new Map(); // event -> Set<fn>

export function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(fn);
  return () => listeners.get(event)?.delete(fn);
}
export function emit(event, payload) {
  listeners.get(event)?.forEach((fn) => { try { fn(payload); } catch (e) { console.error(e); } });
  listeners.get('*')?.forEach((fn) => { try { fn({ event, payload }); } catch (e) { console.error(e); } });
}

export const state = {
  settings: { ...DEFAULTS },
  conversations: [],
  activeId: null,
  puterReady: false,
  puterUser: null,
  busy: false,
};

/* ── settings ───────────────────────────────────────────── */
const saveSettingsNow = () => writeStorage(KEYS.settings, state.settings);
export const saveSettings = debounce(saveSettingsNow, 220);

export function updateSettings(patch) {
  Object.assign(state.settings, patch);
  saveSettings();
  emit('settings', state.settings);
}

export function loadState() {
  const saved = readStorage(KEYS.settings, null);
  if (saved && typeof saved === 'object') {
    state.settings = { ...DEFAULTS, ...saved };
  }
  state.conversations = readStorage(KEYS.conversations, []) || [];
  if (!Array.isArray(state.conversations)) state.conversations = [];
  state.activeId = readStorage(KEYS.activeConv, null);
  if (!state.conversations.some((c) => c.id === state.activeId)) {
    state.activeId = state.conversations[0]?.id ?? null;
  }
  return state;
}

const saveConvsNow = () => {
  // Keep storage bounded: strip transient fields, cap history size.
  const slim = state.conversations.slice(0, 120).map((c) => ({
    ...c,
    messages: (c.messages || []).slice(-400).map(({ el, ...m }) => m),
  }));
  const ok = writeStorage(KEYS.conversations, slim);
  if (!ok) emit('toast', { type: 'warn', text: 'History too large to save locally — older chats may not persist.' });
  writeStorage(KEYS.activeConv, state.activeId);
  syncToPuterKv(slim);
};
export const saveConversations = debounce(saveConvsNow, 400);

/* ── conversations ──────────────────────────────────────── */
export function activeConversation() {
  return state.conversations.find((c) => c.id === state.activeId) || null;
}

export function newConversation(opts = {}) {
  const conv = {
    id: uid('conv'),
    title: opts.title || 'New conversation',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    mode: opts.mode || state.settings.mode,
    model: opts.model || (opts.mode === 'agent' ? state.settings.agentModel : state.settings.model),
    messages: [],
    meta: { steps: 0, promptTokens: 0, completionTokens: 0 },
    pinned: false,
  };
  state.conversations.unshift(conv);
  state.activeId = conv.id;
  saveConversations();
  emit('conversation:new', conv);
  return conv;
}

export function setActive(id) {
  if (state.activeId === id) return;
  state.activeId = id;
  writeStorage(KEYS.activeConv, id);
  emit('conversation:active', activeConversation());
}

export function deleteConversation(id) {
  const i = state.conversations.findIndex((c) => c.id === id);
  if (i < 0) return;
  state.conversations.splice(i, 1);
  if (state.activeId === id) state.activeId = state.conversations[0]?.id ?? null;
  saveConversations();
  emit('conversation:deleted', id);
  emit('conversation:active', activeConversation());
}

export function renameConversation(id, title) {
  const c = state.conversations.find((x) => x.id === id);
  if (!c) return;
  c.title = title || 'Untitled';
  c.updatedAt = Date.now();
  saveConversations();
  emit('conversations', state.conversations);
}

export function touchConversation(conv) {
  if (!conv) return;
  conv.updatedAt = Date.now();
  saveConversations();
  emit('conversations', state.conversations);
}

export function addMessage(conv, msg) {
  const m = { id: uid('m'), ts: Date.now(), ...msg };
  conv.messages.push(m);
  conv.updatedAt = Date.now();
  if (conv.title === 'New conversation' && m.role === 'user') {
    conv.title = deriveTitle(m.content);
  }
  saveConversations();
  emit('message:added', { conv, message: m });
  return m;
}

export function updateMessage(conv, id, patch) {
  const m = conv.messages.find((x) => x.id === id);
  if (!m) return null;
  Object.assign(m, patch);
  conv.updatedAt = Date.now();
  saveConversations();
  emit('message:updated', { conv, message: m });
  return m;
}

export function removeMessage(conv, id) {
  const i = conv.messages.findIndex((m) => m.id === id);
  if (i < 0) return;
  conv.messages.splice(i, 1);
  saveConversations();
  emit('message:removed', { conv, id });
}

export function truncateAfter(conv, id) {
  const i = conv.messages.findIndex((m) => m.id === id);
  if (i < 0) return;
  conv.messages = conv.messages.slice(0, i);
  saveConversations();
  emit('conversation:active', conv);
}

function deriveTitle(content) {
  let text = typeof content === 'string' ? content : (content?.text || '');
  text = text.replace(/\s+/g, ' ').trim();
  if (!text) return 'New conversation';
  return text.length > 52 ? text.slice(0, 52).trimEnd() + '…' : text;
}

/* ── Puter KV mirror (cross-device history) ─────────────── */
let kvBusy = false;
async function syncToPuterKv(slim) {
  if (!state.settings.syncPuterKv || !state.puterReady || kvBusy) return;
  try {
    kvBusy = true;
    const payload = JSON.stringify(slim.slice(0, 40));
    if (payload.length > 900_000) return; // KV values have practical size limits
    await window.puter?.kv?.set('playground.conversations', payload);
  } catch (e) {
    console.warn('[pp] KV sync failed:', prettyError(e));
  } finally {
    kvBusy = false;
  }
}

export async function pullFromPuterKv() {
  if (!state.puterReady) return false;
  try {
    const raw = await window.puter?.kv?.get('playground.conversations');
    if (!raw) return false;
    const remote = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!Array.isArray(remote) || !remote.length) return false;
    const byId = new Map(state.conversations.map((c) => [c.id, c]));
    let added = 0;
    for (const c of remote) {
      if (!c?.id) continue;
      const local = byId.get(c.id);
      if (!local) { state.conversations.push(c); added++; }
      else if ((c.updatedAt || 0) > (local.updatedAt || 0) && (c.messages?.length || 0) >= (local.messages?.length || 0)) {
        Object.assign(local, c);
      }
    }
    if (added) {
      state.conversations.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      saveConversations();
      emit('conversations', state.conversations);
    }
    return added > 0;
  } catch (e) {
    console.warn('[pp] KV pull failed:', prettyError(e));
    return false;
  }
}

/* ── export helpers ─────────────────────────────────────── */
export function conversationToMarkdown(conv) {
  const lines = [`# ${conv.title}`, '', `- Model: \`${conv.model || 'default'}\``, `- Mode: ${conv.mode}`, `- Created: ${new Date(conv.createdAt).toLocaleString()}`, ''];
  for (const m of conv.messages || []) {
    const body = typeof m.content === 'string' ? m.content : JSON.stringify(m.content, null, 2);
    lines.push(`## ${m.role}`, '', body || '_(empty)_', '');
    for (const tc of m.toolCalls || []) {
      lines.push(`> 🔧 **${tc.name}** \`${JSON.stringify(tc.args || {}).slice(0, 240)}\``, '');
      if (tc.result) lines.push('```', String(tc.result).slice(0, 2000), '```', '');
    }
  }
  return lines.join('\n');
}
