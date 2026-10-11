/** Small helpers shared by every module. No dependencies. */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/** Create an element: el('div.class#id', {attrs}, ...children) */
export function el(spec, attrs = {}, ...kids) {
  const [tagPart, ...rest] = String(spec).split('.');
  const m = tagPart.split('#');
  const node = document.createElement(m[0] || 'div');
  if (m[1]) node.id = m[1];
  for (const chunk of rest) {
    for (const cls of String(chunk).split(/\s+/)) {
      if (cls) node.classList.add(cls);
    }
  }
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className += ' ' + v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids.flat(9)) {
    if (kid === null || kid === undefined || kid === false) continue;
    node.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return node;
}

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const uid = (p = 'id') => `${p}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
export const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, Number.isFinite(n) ? n : lo));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function debounce(fn, ms = 250) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export function withTimeout(promise, ms, label = 'operation') {
  let t;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(t)),
    new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms); }),
  ]);
}

/* ── formatting ─────────────────────────────────────────── */
export function formatBytes(n) {
  if (!Number.isFinite(n)) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 ** 2).toFixed(2)} MB`;
}

export function formatTime(ts) {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const yest = new Date(now); yest.setDate(now.getDate() - 1);
  if (d.toDateString() === yest.toDateString()) return 'Yesterday';
  if (now - d < 6 * 864e5) return d.toLocaleDateString([], { weekday: 'short' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export function truncate(s, max = 4000, note = '\n…[truncated]') {
  s = String(s ?? '');
  if (s.length <= max) return s;
  const head = Math.ceil(max * 0.72);
  const tail = max - head;
  return `${s.slice(0, head)}${note}\n${s.slice(s.length - tail)}`;
}

/** Rough token estimate: ~4 chars/token for English-ish text & code. */
export const estimateTokens = (s) => Math.ceil(String(s ?? '').length / 4);

/* ── paths ──────────────────────────────────────────────── */
export function normPath(p) {
  let s = String(p ?? '').replace(/\\/g, '/').trim();
  if (!s) return '';
  const abs = s.startsWith('/');
  s = s.replace(/^\/+/, '');
  const out = [];
  for (const part of s.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { out.pop(); continue; }
    out.push(part);
  }
  return (abs ? '/' : '') + out.join('/');
}
export const joinPath = (...parts) => normPath(parts.filter(Boolean).map((p) => String(p).replace(/^\/+/, '')).join('/'));
export const dirname = (p) => { const n = normPath(p); const i = n.lastIndexOf('/'); return i <= 0 ? '' : n.slice(0, i); };
export const basename = (p) => { const n = normPath(p); return n.slice(n.lastIndexOf('/') + 1); };
export const extname = (p) => { const b = basename(p); const i = b.lastIndexOf('.'); return i > 0 ? b.slice(i + 1).toLowerCase() : ''; };

const TEXT_EXT = new Set(['txt', 'md', 'markdown', 'json', 'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'vue', 'svelte',
  'html', 'htm', 'css', 'scss', 'sass', 'less', 'svg', 'xml', 'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf', 'env',
  'py', 'rb', 'go', 'rs', 'java', 'kt', 'c', 'h', 'cpp', 'hpp', 'cs', 'php', 'sh', 'bash', 'zsh', 'sql', 'csv',
  'tsv', 'log', 'gitignore', 'dockerignore', 'editorconfig', 'lock', 'plist', 'gradle', 'tf', 'r', 'lua', 'pl',
  'swift', 'dart', 'ex', 'exs', 'erl', 'hs', 'ml', 'scala', 'asm', 's', 'bat', 'ps1', 'makefile', 'dockerfile',
  'gitattributes', 'npmrc', 'nvmrc', 'babelrc', 'eslintrc', 'prettierrc', 'txt', 'tex', 'bib', 'rst', 'adoc']);

export function isTextPath(p) {
  const ext = extname(p);
  const base = basename(p).toLowerCase();
  if (!ext) return ['makefile', 'dockerfile', 'license', 'readme', 'notice', 'procfile'].includes(base) || base.startsWith('.');
  return TEXT_EXT.has(ext);
}

const MIME = {
  html: 'text/html', htm: 'text/html', css: 'text/css', js: 'text/javascript', mjs: 'text/javascript',
  json: 'application/json', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', ico: 'image/x-icon', mp3: 'audio/mpeg', wav: 'audio/wav',
  mp4: 'video/mp4', webm: 'video/webm', pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown',
  csv: 'text/csv', xml: 'application/xml', zip: 'application/zip', wasm: 'application/wasm',
};
export const mimeFor = (p) => MIME[extname(p)] || 'application/octet-stream';

export const isImagePath = (p) => ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp', 'avif'].includes(extname(p));
export const isVideoPath = (p) => ['mp4', 'webm', 'mov', 'mkv', 'm4v', 'avi'].includes(extname(p));
export const isAudioPath = (p) => ['mp3', 'wav', 'ogg', 'opus', 'm4a', 'flac', 'aac', 'weba'].includes(extname(p));
export const isBinaryPath = (p) => !isTextPath(p) && !isImagePath(p);

/** highlight.js language id for a path */
export function hljsLang(p) {
  const map = {
    js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript',
    html: 'xml', htm: 'xml', svg: 'xml', xml: 'xml', vue: 'xml', py: 'python', rb: 'ruby', go: 'go', rs: 'rust',
    java: 'java', kt: 'kotlin', c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cs: 'csharp', php: 'php', sh: 'bash',
    bash: 'bash', zsh: 'bash', yml: 'yaml', yaml: 'yaml', json: 'json', md: 'markdown', css: 'css', scss: 'scss',
    sql: 'sql', toml: 'ini', ini: 'ini', dockerfile: 'dockerfile', makefile: 'makefile', txt: 'plaintext',
    swift: 'swift', dart: 'dart', lua: 'lua', r: 'r', pl: 'perl', ex: 'elixir', hs: 'haskell', tf: 'hcl',
  };
  const base = basename(p).toLowerCase();
  if (base === 'dockerfile') return 'dockerfile';
  if (base === 'makefile') return 'makefile';
  return map[extname(p)] || 'plaintext';
}

/* ── misc ───────────────────────────────────────────────── */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = el('textarea', { style: { position: 'fixed', opacity: '0' } });
    ta.value = text; document.body.append(ta); ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { /* ignore */ }
    ta.remove();
    return ok;
  }
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: filename, style: { display: 'none' } });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function safeJsonParse(text, fallback = null) {
  if (typeof text !== 'string') return text ?? fallback;
  try { return JSON.parse(text); } catch { /* fall through */ }
  // tolerate ```json fences and trailing commas
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) { try { return JSON.parse(fence[1]); } catch { /* ignore */ } }
  const first = Math.min(...['{', '['].map((c) => { const i = text.indexOf(c); return i < 0 ? Infinity : i; }));
  if (Number.isFinite(first)) {
    const sub = text.slice(first);
    try { return JSON.parse(sub); } catch { /* ignore */ }
    try { return JSON.parse(sub.replace(/,(\s*[}\]])/g, '$1')); } catch { /* ignore */ }
  }
  return fallback;
}

export function readStorage(key, fallback = null) {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch { return fallback; }
}

export function writeStorage(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; }
  catch (e) { console.warn('[pp] storage write failed', key, e); return false; }
}

/** Base64 (URL-safe handling) for binary payloads sent to the GitHub API. */
export async function blobToBase64(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < buf.length; i += chunk) {
    bin += String.fromCharCode.apply(null, buf.subarray(i, i + chunk));
  }
  return btoa(bin);
}

export function base64ToUint8(b64) {
  const bin = atob(String(b64).replace(/\s/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Tiny promise pool — runs `fn(item)` with at most `limit` in flight. */
export async function pool(items, limit, fn) {
  const results = new Array(items.length);
  let idx = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

export const isSecureContext = () => window.isSecureContext !== false;
export const hasFsAccessApi = () => typeof window.showDirectoryPicker === 'function';
export const hasOpfs = () => !!(navigator.storage && navigator.storage.getDirectory);

/**
 * Look up a vendored library (marked / DOMPurify / hljs / JSZip).
 * Checks both `window` and `globalThis` so the bundle works however it is loaded.
 */
export const lib = (name) => {
  try { if (typeof window !== 'undefined' && window[name]) return window[name]; } catch { /* ignore */ }
  try { if (typeof globalThis !== 'undefined' && globalThis[name]) return globalThis[name]; } catch { /* ignore */ }
  return null;
};

export function prettyError(e) {
  if (!e) return 'Unknown error';
  if (typeof e === 'string') return e;
  const parts = [];
  if (e.message) parts.push(e.message);
  else if (e.msg) parts.push(e.msg);
  if (e.code && !parts.join(' ').includes(e.code)) parts.push(`(${e.code})`);
  if (e.status && !parts.join(' ').includes(String(e.status))) parts.push(`[HTTP ${e.status}]`);
  if (!parts.length) {
    try { return JSON.stringify(e).slice(0, 400); } catch { return String(e); }
  }
  return parts.join(' ');
}
