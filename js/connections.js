/**
 * Connections: other apps and APIs the agent can talk to.
 *
 * A connection is just a base URL plus how to authenticate against it. The
 * agent calls it through `call_connection`; the same transport powers
 * `web_fetch`, which gives the playground a way to read the web even though it
 * has no server of its own.
 *
 * Requests go out through providers.netFetch, so a CORS-hostile API is reached
 * via Puter's proxy instead of failing, while localhost endpoints stay direct.
 */
import { prettyError, safeJsonParse, truncate, readStorage, writeStorage, uid } from './util.js';
import { KEYS } from './config.js';
import { netFetch, joinUrl, isLoopbackUrl } from './providers.js';
import { readGitHubCredsAnywhere } from './github.js';

export const AUTH_TYPES = [
  { id: 'none', label: 'No auth' },
  { id: 'bearer', label: 'Bearer token', hint: 'sent as Authorization: Bearer …' },
  { id: 'header', label: 'Custom header', hint: 'e.g. X-API-Key' },
  { id: 'basic', label: 'Basic (user:pass)' },
  { id: 'github', label: 'Use my GitHub token', hint: 'reuses the token from the GitHub tab' },
];

/** Ready-made connections that need no signup at all. */
export const CONNECTION_PRESETS = [
  {
    id: 'duckduckgo', name: 'DuckDuckGo Instant Answers', baseUrl: 'https://api.duckduckgo.com',
    authType: 'none', description: 'Keyless search summaries. GET /?q=SEARCH&format=json&no_html=1',
    docs: 'https://duckduckgo.com/duckduckgo-help-pages/results/r-instant-answers',
  },
  {
    id: 'wikipedia', name: 'Wikipedia REST', baseUrl: 'https://en.wikipedia.org/api/rest_v1',
    authType: 'none', description: 'Keyless encyclopaedia. GET /page/summary/TITLE or /page/html/TITLE',
    docs: 'https://en.wikipedia.org/api/rest_v1/',
  },
  {
    id: 'github', name: 'GitHub REST API', baseUrl: 'https://api.github.com',
    authType: 'github', description: 'Any GitHub endpoint, authenticated with the token already saved in the GitHub tab.',
  },
  {
    id: 'huggingface', name: 'Hugging Face Hub', baseUrl: 'https://huggingface.co/api',
    authType: 'none', description: 'Keyless model/dataset metadata: GET /models?search=… — add a token for private repos.',
  },
  {
    id: 'custom', name: 'Custom REST app', baseUrl: '', authType: 'bearer',
    description: 'Anything else: a company API, a webhook, Home Assistant, a self-hosted service…',
  },
];

/* ── storage ─────────────────────────────────────────────── */

let cache = null;

export function listConnections() {
  if (cache) return cache;
  const raw = readStorage(KEYS.connections, []);
  cache = Array.isArray(raw) ? raw.filter((c) => c && c.name && c.baseUrl !== undefined) : [];
  return cache;
}

function persist() { writeStorage(KEYS.connections, listConnections()); }

export function getConnection(id) { return listConnections().find((c) => c.id === id) || null; }

export function saveConnection(input = {}) {
  const list = listConnections();
  const id = input.id || uid('conn');
  const record = {
    id,
    name: String(input.name || 'Connection').trim() || 'Connection',
    baseUrl: String(input.baseUrl || '').trim().replace(/\/+$/, ''),
    authType: AUTH_TYPES.some((a) => a.id === input.authType) ? input.authType : 'none',
    apiKey: input.apiKey || '',
    headerName: input.headerName || 'X-API-Key',
    headers: input.headers && typeof input.headers === 'object' ? input.headers : {},
    description: String(input.description || '').trim(),
    enabled: input.enabled !== false,
    preset: input.preset || null,
    updatedAt: Date.now(),
  };
  const i = list.findIndex((c) => c.id === id);
  if (i >= 0) list[i] = record; else list.push(record);
  persist();
  return record;
}

export function removeConnection(id) {
  const list = listConnections();
  const i = list.findIndex((c) => c.id === id);
  if (i < 0) return false;
  list.splice(i, 1);
  persist();
  return true;
}

/** Add one of the presets (or re-add it if it was deleted). */
export function addPreset(presetId) {
  const preset = CONNECTION_PRESETS.find((p) => p.id === presetId);
  if (!preset) throw new Error(`Unknown preset "${presetId}"`);
  const existing = listConnections().find((c) => c.preset === presetId && c.name === preset.name);
  if (existing) return existing;
  return saveConnection({ ...preset, preset: presetId, id: uid('conn') });
}

/* ── calling ─────────────────────────────────────────────── */

function authHeadersFor(conn) {
  const h = { Accept: 'application/json, text/plain, */*', ...(conn.headers || {}) };
  let key = conn.apiKey || '';
  if (conn.authType === 'github') key = readGitHubCredsAnywhere()?.token || '';
  if (!key || conn.authType === 'none') return h;
  if (conn.authType === 'bearer') h.Authorization = `Bearer ${key}`;
  else if (conn.authType === 'header') h[conn.headerName || 'X-API-Key'] = key;
  else if (conn.authType === 'basic') {
    try { h.Authorization = `Basic ${btoa(unescape(encodeURIComponent(key)))}`; }
    catch { /* malformed credential — send nothing rather than crash */ }
  }
  return h;
}

export function buildUrl(conn, { path = '', query } = {}) {
  let url = path && !/^https?:\/\//i.test(path) ? joinUrl(conn.baseUrl, path) : (path || conn.baseUrl);
  const params = new URLSearchParams();
  if (query && typeof query === 'object') {
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) params.set(k, String(v));
  }
  const qs = params.toString();
  if (qs) url += (url.includes('?') ? '&' : '?') + qs;
  return url;
}

/**
 * Perform a request against a connection.
 * @returns {Promise<{ok:boolean, status:number, url:string, text:string, json:any, truncated:boolean}>}
 */
export async function callConnection(connOrId, { method = 'GET', path = '', query, body, headers, maxChars = 14000, signal } = {}) {
  const conn = typeof connOrId === 'string' ? getConnection(connOrId) : connOrId;
  if (!conn) throw new Error('No such connection — use list_connections to see what is configured.');
  if (conn.enabled === false) throw new Error(`Connection "${conn.name}" is disabled.`);
  if (!conn.baseUrl) throw new Error(`Connection "${conn.name}" has no base URL.`);
  if (conn.authType === 'github' && !readGitHubCredsAnywhere()?.token) {
    throw new Error(`Connection "${conn.name}" needs the GitHub token from the GitHub tab.`);
  }

  const url = buildUrl(conn, { path, query });
  const init = { method: String(method).toUpperCase(), headers: { ...authHeadersFor(conn), ...(headers || {}) }, signal };
  if (body !== undefined && body !== null && !['GET', 'HEAD'].includes(init.method)) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
    if (typeof body !== 'string') init.headers['Content-Type'] = init.headers['Content-Type'] || 'application/json';
  }

  const { res, via } = await netFetch(url, init);
  const raw = await res.text().catch(() => '');
  const text = truncate(raw, maxChars, '\n…[truncated]');
  return {
    ok: !!res.ok, status: res.status ?? 0, url, via, text,
    json: safeJsonParse(raw, null),
    truncated: raw.length > text.length,
  };
}

/**
 * Read any URL as text. HTML is reduced to something a model can actually use
 * (script/style/nav stripped, tags unwrapped, whitespace collapsed) so the
 * agent can read documentation without a server-side extractor.
 */
export async function webFetch(url, { maxChars = 14000, asHtml = false, signal } = {}) {
  const target = String(url || '').trim();
  if (!/^https?:\/\//i.test(target)) throw new Error('web_fetch needs an absolute http(s) URL');
  if (isLoopbackUrl(target)) throw new Error('Refusing to fetch a loopback/private address — use a connection for local services.');

  const { res, via } = await netFetch(target, { headers: { Accept: asHtml ? 'text/html,*/*' : 'text/html,application/json;q=0.9,*/*;q=0.8' }, signal });
  const raw = await res.text().catch(() => '');
  if (!res.ok && !raw) throw new Error(`Fetch failed: HTTP ${res.status} for ${target}`);
  const isHtml = /<\s*(html|head|body|div|p|article)\b/i.test(raw.slice(0, 4000));
  const text = isHtml && !asHtml ? htmlToText(raw) : raw;
  return {
    ok: !!res.ok, status: res.status ?? 0, url: target, via,
    title: (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(raw)?.[1] || '').trim().slice(0, 200),
    text: truncate(text, maxChars, '\n…[truncated]'),
    truncated: text.length > maxChars,
  };
}

/** Minimal, dependency-free readability pass. */
export function htmlToText(html) {
  let out = String(html || '');
  out = out.replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\s*(nav|header|footer|aside|form|svg|noscript)\b[\s\S]*?<\/\s*\1\s*>/gi, ' ');
  // keep the shape of the document: headings, list items and code blocks
  out = out.replace(/<\s*(h[1-6])[^>]*>/gi, '\n\n## ')
    .replace(/<\s*(li)[^>]*>/gi, '\n- ')
    .replace(/<\s*(pre|code)[^>]*>/gi, '\n```\n')
    .replace(/<\s*\/\s*(pre|code)\s*>/gi, '\n```\n')
    .replace(/<\s*(p|div|section|article|tr|br)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  out = out.replace(/&(amp|lt|gt|quot|#39|nbsp);/gi, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ' }[e] || ' '));
  return out.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

export { prettyError };
