/**
 * Long-term memory: durable facts about the user, their preferences and their
 * projects that survive across conversations, reloads and (optionally) devices.
 *
 * Deliberately dependency-free — no embeddings, no server, no model call needed
 * for retrieval. Ranking is a transparent keyword/tag/recency score, which keeps
 * it instant, offline, and free of credit usage. `distill()` is the one place a
 * model is used, and it always needs an explicit click.
 */
import { uid, prettyError, truncate } from './util.js';
import { KEYS } from './config.js';
import { readStorage, writeStorage } from './util.js';

export const MEMORY_KINDS = [
  { id: 'fact', label: 'Fact', hint: 'Something true about the user or their world' },
  { id: 'preference', label: 'Preference', hint: 'How they like things done' },
  { id: 'project', label: 'Project', hint: 'A repo, app or goal they are working on' },
  { id: 'decision', label: 'Decision', hint: 'A choice that should not be re-litigated' },
  { id: 'person', label: 'Person', hint: 'Someone who comes up in their work' },
  { id: 'note', label: 'Note', hint: 'Anything else worth keeping' },
];

const STOPWORDS = new Set(('a an the and or but if then than that this these those of to in on for with without from into over under is are was were be been being do does did done have has had having i you he she it we they them his her its our your their me my mine not no yes so as at by about again all any can could should would will just very more most other some such only own same too s t don now'.split(' ')));

export const tokenize = (text) => String(text || '')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, ' ')
  .split(' ')
  .filter((t) => t.length > 2 && !STOPWORDS.has(t));

const normalize = (text) => tokenize(text).join(' ');

/**
 * Very light suffix stemmer. Good enough to match "prefers" with "preference",
 * "deploy" with "deploying" and "repo" with "repos" — which is what retrieval
 * actually needs — without pulling in a dependency.
 */
export function stem(token) {
  let t = String(token).toLowerCase();
  const suffixes = ['ization', 'isation', 'tion', 'sion', 'ence', 'ance', 'ment', 'iness', 'ness', 'ing', 'ied', 'ies', 'ed', 'es', 's'];
  for (let i = 0; i < 2; i++) {
    for (const suf of suffixes) {
      if (t.length - suf.length >= 3 && t.endsWith(suf)) { t = t.slice(0, -suf.length); break; }
    }
    // shipping → shipp → ship, so doubled consonants still match their base form
    t = t.replace(/([bdfglmnprst])\1$/, '$1');
  }
  return t;
}

/* ── storage ─────────────────────────────────────────────── */

let cache = null;

export function memories() {
  if (cache) return cache;
  const raw = readStorage(KEYS.memory, []);
  cache = Array.isArray(raw) ? raw.filter((m) => m && typeof m.text === 'string') : [];
  return cache;
}

function persist() {
  writeStorage(KEYS.memory, memories());
}

export function memoryStats() {
  const list = memories();
  const chars = list.reduce((a, m) => a + String(m.text || '').length, 0);
  return {
    count: list.length,
    chars,
    pinned: list.filter((m) => m.pinned).length,
    byKind: MEMORY_KINDS.map((k) => ({ ...k, n: list.filter((m) => m.kind === k.id).length })),
    oldest: list.reduce((min, m) => Math.min(min, m.createdAt || Date.now()), Date.now()),
  };
}

/* ── CRUD ────────────────────────────────────────────────── */

/**
 * Add a memory. Near-duplicates (same normalised text) update the existing
 * entry instead of piling up — an agent that saves the same fact twice should
 * not create two rows.
 */
export function addMemory({ text, kind = 'note', tags = [], source = 'user', pinned = false, conv = null }) {
  const body = String(text || '').trim();
  if (!body) throw new Error('A memory needs some text');
  if (body.length > 4000) throw new Error('That is too long for a single memory — split it up');

  const key = normalize(body);
  const list = memories();
  const dupe = list.find((m) => normalize(m.text) === key);
  if (dupe) {
    dupe.text = body;
    dupe.kind = kind || dupe.kind;
    dupe.tags = mergeTags(dupe.tags, tags);
    dupe.updatedAt = Date.now();
    dupe.hits = (dupe.hits || 0) + 1;
    if (pinned) dupe.pinned = true;
    persist();
    return { entry: dupe, deduped: true };
  }

  const entry = {
    id: uid('mem'),
    kind: MEMORY_KINDS.some((k) => k.id === kind) ? kind : 'note',
    text: body,
    tags: mergeTags([], tags),
    pinned: !!pinned,
    source,
    conv,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    hits: 0,
  };
  list.unshift(entry);
  persist();
  return { entry, deduped: false };
}

export function updateMemory(id, patch = {}) {
  const m = memories().find((x) => x.id === id);
  if (!m) throw new Error('No such memory');
  if (patch.text !== undefined) {
    const body = String(patch.text).trim();
    if (!body) throw new Error('A memory cannot be empty');
    m.text = body;
  }
  if (patch.kind !== undefined && MEMORY_KINDS.some((k) => k.id === patch.kind)) m.kind = patch.kind;
  if (patch.tags !== undefined) m.tags = mergeTags([], patch.tags);
  if (patch.pinned !== undefined) m.pinned = !!patch.pinned;
  m.updatedAt = Date.now();
  persist();
  return m;
}

export function removeMemory(id) {
  const list = memories();
  const i = list.findIndex((x) => x.id === id);
  if (i < 0) return false;
  list.splice(i, 1);
  persist();
  return true;
}

export function clearMemories() {
  cache = [];
  persist();
}

function mergeTags(a, b) {
  const out = [...new Set([...(a || []), ...(b || [])].map((t) => String(t).trim().toLowerCase().replace(/^#/, '')).filter(Boolean))];
  return out.slice(0, 12);
}

/* ── retrieval ───────────────────────────────────────────── */

/**
 * Lexical relevance only: 0 when the query shares nothing with the memory.
 * Kept separate from the prior (pinned/recency/use-count) so that a fresh
 * memory does not match every unrelated query just for being new.
 */
function lexicalScore(m, query) {
  const q = String(query || '').toLowerCase().trim();
  const qTokens = tokenize(q);
  if (!qTokens.length) return 0;

  const text = String(m.text).toLowerCase();
  const mTokens = new Set(tokenize(m.text + ' ' + (m.tags || []).join(' ')));
  const mStems = new Set([...mTokens].map(stem));
  let score = 0;
  if (text.includes(q)) score += 4;                                   // whole phrase present
  for (const t of qTokens) {
    if (mTokens.has(t)) score += 1.2;                                 // shared token
    else if (mStems.has(stem(t))) score += 1.0;                       // shared stem (prefers ↔ preference)
    else if (t.length > 3 && [...mTokens].some((mt) => mt.startsWith(t) || t.startsWith(mt))) score += 0.5;   // prefix
  }
  if ((m.tags || []).some((t) => q.includes(t))) score += 1.5;        // tag mention
  return (score / Math.max(2, qTokens.length)) * 2;                   // normalise for long queries
}

/**
 * Score a memory against a query: lexical relevance plus a prior for pinned,
 * recent and frequently used entries. Transparent, instant and offline.
 */
export function scoreMemory(m, query) {
  const prior = (m.pinned ? 2.5 : 0) + recency(m) + Math.min(0.5, (m.hits || 0) * 0.05);
  if (!String(query || '').trim()) return prior;
  return lexicalScore(m, query) + prior;
}

function recency(m) {
  const ageDays = (Date.now() - (m.updatedAt || m.createdAt || Date.now())) / 86400000;
  return Math.max(0, 0.6 - ageDays * 0.02);
}

/** Ranked search. Empty query returns the most relevant overall (pinned, recent). */
export function rankedSearch(query = '', { limit = 8, kind = '' } = {}) {
  const q = String(query || '').trim();
  return memories()
    .filter((m) => !kind || m.kind === kind)
    .map((m) => ({ entry: m, lex: q ? lexicalScore(m, q) : 0, score: scoreMemory(m, q) }))
    // a real query needs a real match — pinned memories are the only exception
    .filter((r) => !q || r.lex > 0.2 || r.entry.pinned)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export function searchMemory(query = '', opts = {}) {
  return rankedSearch(query, opts).map((r) => r.entry);
}

/**
 * The single best *lexical* match for a query, for destructive operations.
 * Pinned/recency priors are deliberately ignored here: a pinned memory must not
 * win a "which one did they mean?" contest it has nothing to do with.
 * Returns `{ entry, lex, ambiguous }`, or null when nothing matches.
 */
export function bestMatch(query, { kind = '' } = {}) {
  const ranked = rankedSearch(query, { limit: 6, kind })
    .map((r) => ({ ...r, lex: r.lex }))
    .filter((r) => r.lex > 0.2)
    .sort((a, b) => b.lex - a.lex);
  if (!ranked.length) return null;
  const top = ranked[0];
  const close = ranked.filter((r) => r.lex >= top.lex * 0.85);
  return { entry: top.entry, lex: top.lex, ambiguous: close.length > 1 ? close.map((r) => r.entry) : null };
}

export function markUsed(ids) {
  const now = Date.now();
  let touched = false;
  for (const m of memories()) {
    if (ids.includes(m.id)) { m.hits = (m.hits || 0) + 1; m.lastUsed = now; touched = true; }
  }
  if (touched) persist();
}

/**
 * The block injected into the system prompt: pinned memories first, then the
 * best matches for what the user just said, capped to a character budget so
 * long memories never crowd out the conversation.
 */
export function memoryPromptBlock(query = '', { budgetChars = 1600, limit = 14 } = {}) {
  const list = memories();
  if (!list.length) return '';
  const picked = searchMemory(query, { limit });
  if (!picked.length) return '';

  const lines = [];
  let used = 0;
  for (const m of picked) {
    const line = `- [${m.kind}] ${truncate(m.text, 400, '…')}${m.tags?.length ? ` #${m.tags.join(' #')}` : ''}`;
    if (used + line.length > budgetChars) break;
    lines.push(line);
    used += line.length;
  }
  if (!lines.length) return '';
  return `## Long-term memory (durable facts about this user)
${lines.join('\n')}

Use these without asking the user to repeat themselves. If something here conflicts with what the user says now,
the user is right — update the memory with the remember tool. Never invent memories that are not listed.`;
}

/* ── cross-device mirror (Puter KV) ──────────────────────── */

const KV_KEY = 'playground.memory.v1';

/** Push the local list to the user's Puter KV store. */
export async function pushMemoriesToCloud() {
  const puter = globalThis.window?.puter;
  if (!puter?.kv?.set) throw new Error('Puter KV is unavailable — sign in first');
  await puter.kv.set(KV_KEY, JSON.stringify({ v: 1, savedAt: Date.now(), items: memories() }));
  return memories().length;
}

/**
 * Pull the cloud copy and merge it in. Merging is by normalised text, keeping
 * the newest `updatedAt`, so neither side clobbers the other.
 */
export async function pullMemoriesFromCloud() {
  const puter = globalThis.window?.puter;
  if (!puter?.kv?.get) return { added: 0, updated: 0 };
  const raw = await puter.kv.get(KV_KEY);
  if (!raw) return { added: 0, updated: 0 };
  let payload;
  try { payload = JSON.parse(typeof raw === 'string' ? raw : await raw.text()); }
  catch { return { added: 0, updated: 0 }; }
  return mergeMemories(payload?.items || []);
}

/** Merge a list of entries into local storage; returns what changed. */
export function mergeMemories(incoming) {
  const list = memories();
  const byKey = new Map(list.map((m) => [normalize(m.text), m]));
  let added = 0, updated = 0;
  for (const inc of (Array.isArray(incoming) ? incoming : [])) {
    if (!inc || typeof inc.text !== 'string' || !inc.text.trim()) continue;
    const key = normalize(inc.text);
    const existing = byKey.get(key);
    if (!existing) {
      const entry = {
        id: inc.id && !list.some((m) => m.id === inc.id) ? inc.id : uid('mem'),
        kind: MEMORY_KINDS.some((k) => k.id === inc.kind) ? inc.kind : 'note',
        text: inc.text.trim(),
        tags: mergeTags([], inc.tags),
        pinned: !!inc.pinned,
        source: inc.source || 'sync',
        conv: inc.conv || null,
        createdAt: inc.createdAt || Date.now(),
        updatedAt: inc.updatedAt || Date.now(),
        hits: inc.hits || 0,
      };
      list.unshift(entry);
      byKey.set(key, entry);
      added++;
    } else if ((inc.updatedAt || 0) > (existing.updatedAt || 0)) {
      Object.assign(existing, {
        text: inc.text.trim(), kind: existing.kind, tags: mergeTags(existing.tags, inc.tags),
        pinned: existing.pinned || !!inc.pinned, updatedAt: inc.updatedAt,
      });
      updated++;
    }
  }
  if (added || updated) persist();
  return { added, updated };
}

/* ── distillation (the only model call in this module) ───── */

const DISTILL_PROMPT = `Extract the durable, reusable facts from this conversation that are worth remembering long-term.

Rules:
- Only facts that will still matter in a future, unrelated conversation (identity, preferences, environment, ongoing projects, standing decisions).
- Skip anything task-specific, temporary, or already obvious from the files.
- Never record secrets: no API keys, tokens, passwords, or personal identifiers beyond a first name.
- Each item: one sentence, third person ("The user prefers …"), max 240 characters.

Return ONLY a JSON array (no prose, no code fence) of objects:
[{"text":"...","kind":"fact|preference|project|decision|person|note","tags":["short","kebab","tags"]}]

Return [] if there is nothing worth keeping.`;

/**
 * Ask a cheap model to propose memories from a conversation. Nothing is saved
 * until the user approves individual candidates in the UI.
 */
export async function distillConversation(conv, { complete, model } = {}) {
  if (typeof complete !== 'function') throw new Error('No completion function supplied');
  const transcript = (conv?.messages || [])
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => `${m.role === 'user' ? 'USER' : 'ASSISTANT'}: ${truncate(typeof m.content === 'string' ? m.content : '', 1200, '…')}`)
    .join('\n');
  if (!transcript.trim()) throw new Error('This conversation has nothing to distil yet');

  const raw = await complete([
    { role: 'system', content: DISTILL_PROMPT },
    { role: 'user', content: truncate(transcript, 24000, '\n…[truncated]') },
  ], { model, temperature: 0.1, maxTokens: 1200 });

  return parseCandidates(raw);
}

/** Tolerant JSON extraction: models love wrapping arrays in prose or fences. */
export function parseCandidates(raw) {
  const text = String(raw || '').trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('[');
  const end = body.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  let arr;
  try { arr = JSON.parse(body.slice(start, end + 1)); } catch { return []; }
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((c) => c && typeof c.text === 'string' && c.text.trim().length > 3)
    .map((c) => ({
      text: c.text.trim().slice(0, 400),
      kind: MEMORY_KINDS.some((k) => k.id === c.kind) ? c.kind : 'note',
      tags: mergeTags([], Array.isArray(c.tags) ? c.tags : []),
    }))
    .filter((c) => !memories().some((m) => normalize(m.text) === normalize(c.text)))
    .slice(0, 25);
}

export { prettyError };
