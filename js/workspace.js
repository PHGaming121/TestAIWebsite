/**
 * Workspace: one filesystem API, four interchangeable backends.
 *
 *   memory  – ephemeral, zero friction (mirrored to localStorage)
 *   opfs    – browser-private local disk, persists across reloads
 *   local   – a REAL folder on the user's computer (File System Access API)
 *   puter   – the user's Puter cloud drive (cross-device, publishable)
 *
 * Every path used by the app is workspace-relative, POSIX style, no leading "/".
 */
import { BACKENDS } from './config.js';
import {
  basename, dirname, joinPath, normPath, formatBytes, isTextPath, mimeFor,
  hasOpfs, hasFsAccessApi, prettyError, blobToBase64, pool, lib,
} from './util.js';
import { emit } from './store.js';

const listeners = new Set();
export const onWorkspaceChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
const fireChange = (detail) => { listeners.forEach((fn) => { try { fn(detail); } catch (e) { console.error(e); } }); emit('workspace', detail); };

/* ═══════════════════ base ═══════════════════ */
class BaseWorkspace {
  constructor(id) {
    this.id = id;
    this.meta = BACKENDS.find((b) => b.id === id) || { id, name: id, desc: '' };
    this.rootLabel = '/';
  }
  async init() { return this; }
  // to be implemented
  async list() { throw new Error('not implemented'); }
  async readBlob() { throw new Error('not implemented'); }
  async write() { throw new Error('not implemented'); }
  async remove() { throw new Error('not implemented'); }
  async mkdir() { throw new Error('not implemented'); }
  async rename() { throw new Error('not implemented'); }
  async clear() { throw new Error('not implemented'); }
  async describe() { return { backend: this.id, root: this.rootLabel }; }

  async read(path) {
    const p = normPath(path);
    const blob = await this.readBlob(p);
    if (!blob) throw new Error(`No such file: ${p}`);
    return await blob.text();
  }
  async exists(path) {
    const p = normPath(path);
    const all = await this.list();
    return all.some((e) => e.path === p);
  }
  async stat(path) {
    const p = normPath(path);
    const all = await this.list();
    return all.find((e) => e.path === p) || null;
  }
  /** Nested tree for UI + model context. */
  async tree() {
    const entries = await this.list();
    const root = { name: '', path: '', type: 'dir', children: [] };
    const map = new Map([['', root]]);
    const ensureDir = (dirPath) => {
      if (map.has(dirPath)) return map.get(dirPath);
      const parent = ensureDir(dirname(dirPath));
      const node = { name: basename(dirPath) || dirPath, path: dirPath, type: 'dir', children: [] };
      parent.children.push(node);
      map.set(dirPath, node);
      return node;
    };
    for (const e of entries.sort((a, b) => a.path.localeCompare(b.path))) {
      if (e.type === 'dir') { ensureDir(e.path); continue; }
      ensureDir(dirname(e.path)).children.push({ ...e, name: basename(e.path) });
    }
    const sortRec = (n) => {
      if (!Array.isArray(n.children)) return; // leaf file node
      n.children.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
      n.children.forEach(sortRec);
    };
    sortRec(root);
    return root;
  }
  /** Compact text tree for prompts. */
  async treeText({ maxEntries = 400 } = {}) {
    const entries = (await this.list()).slice(0, maxEntries);
    if (!entries.length) return '(empty workspace)';
    const lines = [];
    const dirs = new Set();
    for (const e of entries) {
      if (e.type === 'dir') { dirs.add(e.path); continue; }
      lines.push(`${e.path}  (${formatBytes(e.size || 0)})`);
    }
    for (const d of [...dirs].sort()) if (!entries.some((e) => e.type === 'file' && e.path.startsWith(d + '/'))) lines.push(`${d}/`);
    lines.sort();
    return lines.slice(0, maxEntries).join('\n');
  }
  async stats() {
    const entries = await this.list();
    const files = entries.filter((e) => e.type === 'file');
    return {
      files: files.length,
      dirs: entries.length - files.length,
      bytes: files.reduce((a, e) => a + (e.size || 0), 0),
    };
  }
  async readAllText({ maxBytesPerFile = 200_000, onlyText = true } = {}) {
    const out = new Map();
    const entries = (await this.list()).filter((e) => e.type === 'file' && (!onlyText || isTextPath(e.path)));
    await pool(entries, 4, async (e) => {
      try {
        if ((e.size || 0) > maxBytesPerFile * 4) return;
        const text = await this.read(e.path);
        out.set(e.path, text.slice(0, maxBytesPerFile));
      } catch { /* unreadable — skip */ }
    });
    return out;
  }
  async exportZip(name = 'workspace.zip') {
    const JSZip = lib('JSZip');
    if (!JSZip) throw new Error('JSZip not loaded');
    const zip = new JSZip();
    const entries = (await this.list()).filter((e) => e.type === 'file');
    await pool(entries, 4, async (e) => {
      const blob = await this.readBlob(e.path);
      if (blob) zip.file(e.path, blob);
    });
    return await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
  }
  async importZip(file, { prefix = '' } = {}) {
    const JSZip = lib('JSZip');
    if (!JSZip) throw new Error('JSZip not loaded');
    const zip = await JSZip.loadAsync(file);
    const files = Object.values(zip.files).filter((f) => !f.dir);
    let n = 0;
    await pool(files, 4, async (f) => {
      const blob = await f.async('blob');
      const target = joinPath(prefix, f.name.replace(/^\/+/, ''));
      await this.write(target, blob);
      n++;
    });
    fireChange({ op: 'import', count: n });
    return n;
  }
  async importFiles(fileList, { prefix = '' } = {}) {
    let n = 0;
    for (const f of Array.from(fileList || [])) {
      // webkitRelativePath keeps the folder structure when a directory is picked
      const rel = f.webkitRelativePath || f.name;
      await this.write(joinPath(prefix, rel), f);
      n++;
    }
    fireChange({ op: 'import', count: n });
    return n;
  }
}

/* ═══════════════════ memory backend ═══════════════════ */
class MemoryWorkspace extends BaseWorkspace {
  constructor() {
    super('memory');
    this.files = new Map(); // path -> {data: string|Uint8Array|Blob, modified, size}
    this.dirs = new Set();
    this.rootLabel = 'memory://';
    this.persistKey = 'pp.workspace.memory.v1';
    this._restore();
  }
  _restore() {
    try {
      const raw = localStorage.getItem(this.persistKey);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      for (const [p, v] of Object.entries(parsed.files || {})) {
        this.files.set(p, typeof v === 'string'
          ? { data: v, size: v.length, modified: Date.now() }
          : { data: new Uint8Array(v.bytes), size: v.bytes.length, modified: Date.now(), binary: true });
      }
      (parsed.dirs || []).forEach((d) => this.dirs.add(d));
    } catch { /* ignore corrupt cache */ }
  }
  _persist() {
    if (this._t) clearTimeout(this._t);
    this._t = setTimeout(() => {
      try {
        const files = {};
        let total = 0;
        for (const [p, v] of this.files) {
          if (total > 4_000_000) break; // keep localStorage happy
          if (typeof v.data === 'string') { files[p] = v.data; total += v.data.length; }
          else if (v.data instanceof Uint8Array && v.data.length < 400_000) { files[p] = { bytes: [...v.data] }; total += v.data.length * 2; }
        }
        localStorage.setItem(this.persistKey, JSON.stringify({ files, dirs: [...this.dirs].slice(0, 500) }));
      } catch { /* quota — non-fatal */ }
    }, 600);
  }
  _markParents(path) {
    let d = dirname(path);
    while (d) { this.dirs.add(d); d = dirname(d); }
  }
  async list() {
    const out = [];
    for (const d of this.dirs) out.push({ path: d, name: basename(d), type: 'dir', size: 0, modified: 0 });
    for (const [p, v] of this.files) out.push({ path: p, name: basename(p), type: 'file', size: v.size, modified: v.modified });
    return out;
  }
  async readBlob(path) {
    const p = normPath(path);
    const v = this.files.get(p);
    if (!v) throw new Error(`No such file: ${p}`);
    if (v.data instanceof Blob) return v.data;
    if (typeof v.data === 'string') return new Blob([v.data], { type: mimeFor(p) });
    return new Blob([v.data], { type: mimeFor(p) });
  }
  async write(path, content) {
    const p = normPath(path);
    if (!p) throw new Error('Invalid path');
    let data, size;
    if (typeof content === 'string') { data = content; size = content.length; }
    else if (content instanceof Blob) { data = new Uint8Array(await content.arrayBuffer()); size = content.size; }
    else if (content instanceof Uint8Array || content instanceof ArrayBuffer) { data = content instanceof Uint8Array ? content : new Uint8Array(content); size = data.length; }
    else { data = String(content ?? ''); size = data.length; }
    this.files.set(p, { data, size, modified: Date.now() });
    this._markParents(p);
    this._persist();
    fireChange({ op: 'write', path: p });
    return { path: p, size };
  }
  async remove(path) {
    const p = normPath(path);
    if (this.files.delete(p)) { this._persist(); fireChange({ op: 'remove', path: p }); return true; }
    if (this.dirs.has(p)) {
      this.dirs.delete(p);
      for (const f of [...this.files.keys()]) if (f.startsWith(p + '/')) this.files.delete(f);
      for (const d of [...this.dirs]) if (d.startsWith(p + '/')) this.dirs.delete(d);
      this._persist(); fireChange({ op: 'remove', path: p });
      return true;
    }
    throw new Error(`No such path: ${p}`);
  }
  async mkdir(path) {
    const p = normPath(path);
    this.dirs.add(p);
    this._markParents(p);
    this._persist(); fireChange({ op: 'mkdir', path: p });
    return { path: p };
  }
  async rename(from, to) {
    const f = normPath(from), t = normPath(to);
    if (this.files.has(f)) {
      const v = this.files.get(f);
      this.files.delete(f);
      this.files.set(t, { ...v, modified: Date.now() });
      this._markParents(t);
    } else if (this.dirs.has(f)) {
      for (const [p, v] of [...this.files]) if (p.startsWith(f + '/')) { this.files.delete(p); this.files.set(joinPath(t, p.slice(f.length + 1)), v); }
      this.dirs.delete(f);
    } else throw new Error(`No such path: ${f}`);
    this._persist(); fireChange({ op: 'rename', from: f, to: t });
    return { path: t };
  }
  async clear() {
    this.files.clear(); this.dirs.clear(); this._persist();
    fireChange({ op: 'clear' });
  }
  async describe() { return { backend: 'memory', root: 'memory://', note: 'Ephemeral — mirrored to this browser’s localStorage.' }; }
}

/* ═══════════════════ handle-based backends (OPFS + local folder) ═══════════════════ */
class HandleWorkspace extends BaseWorkspace {
  constructor(id, root) {
    super(id);
    this.root = root;
    this.rootLabel = id === 'opfs' ? 'opfs://playground' : (root?.name || 'local folder');
  }
  async _dir(path, { create = false } = {}) {
    let handle = this.root;
    const parts = normPath(path).split('/').filter(Boolean);
    if (create && parts.length) parts.pop();
    for (const part of parts) {
      handle = await handle.getDirectoryHandle(part, { create });
    }
    if (!create && parts.length) {
      // verify the final directory exists when we are addressing a dir
      const full = normPath(path).split('/').filter(Boolean);
      let h = this.root;
      for (const part of full) h = await h.getDirectoryHandle(part, { create: false });
      return h;
    }
    return handle;
  }
  async list() {
    const out = [];
    const walk = async (handle, prefix) => {
      for await (const [name, child] of handle.entries()) {
        const path = prefix ? `${prefix}/${name}` : name;
        if (child.kind === 'directory') {
          out.push({ path, name, type: 'dir', size: 0, modified: 0 });
          await walk(child, path);
        } else {
          let size = 0, modified = 0;
          try { const f = await child.getFile(); size = f.size; modified = f.lastModified; } catch { /* permission — ignore */ }
          out.push({ path, name, type: 'file', size, modified });
        }
      }
    };
    await walk(this.root, '');
    return out;
  }
  async readBlob(path) {
    const p = normPath(path);
    const dir = await this._dir(dirname(p));
    const fh = await dir.getFileHandle(basename(p));
    return await fh.getFile();
  }
  async write(path, content) {
    const p = normPath(path);
    const dir = await this._dir(dirname(p), { create: true });
    const fh = await dir.getFileHandle(basename(p), { create: true });
    const w = await fh.createWritable();
    await w.write(content instanceof Blob || typeof content === 'string' ? content : new Blob([content]));
    await w.close();
    fireChange({ op: 'write', path: p });
    return { path: p };
  }
  async remove(path) {
    const p = normPath(path);
    const parent = dirname(p);
    const dir = await this._dir(parent);
    await dir.removeEntry(basename(p), { recursive: true });
    fireChange({ op: 'remove', path: p });
    return true;
  }
  async mkdir(path) {
    const p = normPath(path);
    await this._dir(p, { create: true });
    // ensure the final segment exists too
    const parts = p.split('/').filter(Boolean);
    let h = this.root;
    for (const part of parts) h = await h.getDirectoryHandle(part, { create: true });
    fireChange({ op: 'mkdir', path: p });
    return { path: p };
  }
  async rename(from, to) {
    const f = normPath(from), t = normPath(to);
    const st = await this.stat(f);
    if (!st) throw new Error(`No such path: ${f}`);
    if (st.type === 'file') {
      const blob = await this.readBlob(f);
      await this.write(t, blob);
      await this.remove(f);
    } else {
      const entries = (await this.list()).filter((e) => e.path.startsWith(f + '/'));
      for (const e of entries) {
        const target = joinPath(t, e.path.slice(f.length + 1));
        if (e.type === 'file') await this.write(target, await this.readBlob(e.path));
        else await this.mkdir(target);
      }
      await this.remove(f);
    }
    fireChange({ op: 'rename', from: f, to: t });
    return { path: t };
  }
  async clear() {
    for await (const [name] of this.root.entries()) {
      await this.root.removeEntry(name, { recursive: true });
    }
    fireChange({ op: 'clear' });
  }
}

/* ═══════════════════ Puter cloud backend ═══════════════════ */
class PuterWorkspace extends BaseWorkspace {
  constructor(dir = 'PlaygroundWorkspace') {
    super('puter');
    this.dir = dir.replace(/^\/+|\/+$/g, '') || 'PlaygroundWorkspace';
    this.rootLabel = `puter:~/${this.dir}`;
  }
  get puter() {
    if (!window.puter?.fs) throw new Error('Puter.js is not available');
    return window.puter;
  }
  abs(path = '') {
    const p = normPath(path);
    return p ? `${this.dir}/${p}` : this.dir;
  }
  rel(absolute) {
    let p = String(absolute || '').replace(/\\/g, '/');
    const home = this.puter.fs?.homePath || '';
    if (home && p.startsWith(home)) p = p.slice(home.length);
    const idx = p.indexOf(`/${this.dir}/`);
    if (idx >= 0) return normPath(p.slice(idx + this.dir.length + 2));
    if (p.startsWith(`${this.dir}/`)) return normPath(p.slice(this.dir.length + 1));
    if (p === `/${this.dir}` || p === this.dir) return '';
    return normPath(p.replace(/^\/+/, ''));
  }
  async init() {
    await this.puter.fs.mkdir(this.dir, { createMissingParents: true, overwrite: false, dedupeName: false }).catch(async (e) => {
      // already exists is fine; anything else is a real problem
      const msg = prettyError(e).toLowerCase();
      if (!/exist|already|item_with_same_name/.test(msg)) throw e;
    });
    return this;
  }
  async list() {
    const out = [];
    const walk = async (dirAbs, prefix) => {
      let items;
      try {
        items = await this.puter.fs.readdir(dirAbs);
      } catch (e) {
        const msg = prettyError(e).toLowerCase();
        if (/not found|no such|does not exist|subject_does_not_exist/.test(msg)) return;
        throw e;
      }
      for (const it of items || []) {
        const name = it.name ?? it.basename ?? basename(it.path || '');
        if (!name) continue;
        const path = prefix ? `${prefix}/${name}` : name;
        const isDir = it.is_dir === true || it.isDir === true || it.type === 'directory';
        if (isDir) {
          out.push({ path, name, type: 'dir', size: 0, modified: it.modified ? new Date(it.modified).getTime() : 0 });
          await walk(it.path || this.abs(path), path);
        } else {
          out.push({ path, name, type: 'file', size: it.size ?? 0, modified: it.modified ? new Date(it.modified).getTime() : 0 });
        }
      }
    };
    await walk(this.abs(), '');
    return out;
  }
  async readBlob(path) {
    const p = normPath(path);
    const blob = await this.puter.fs.read(this.abs(p));
    if (!blob) throw new Error(`No such file: ${p}`);
    return blob instanceof Blob ? blob : new Blob([blob]);
  }
  async write(path, content) {
    const p = normPath(path);
    const parent = dirname(p);
    if (parent) await this.mkdir(parent);
    const data = content instanceof Blob || typeof content === 'string'
      ? content
      : new Blob([content]);
    const item = await this.puter.fs.write(this.abs(p), data, { overwrite: true, dedupeName: false, createMissingParents: true });
    fireChange({ op: 'write', path: p });
    return { path: p, item };
  }
  async remove(path) {
    const p = normPath(path);
    await this.puter.fs.delete(this.abs(p), { recursive: true });
    fireChange({ op: 'remove', path: p });
    return true;
  }
  async mkdir(path) {
    const p = normPath(path);
    if (!p) return { path: '' };
    await this.puter.fs.mkdir(this.abs(p), { createMissingParents: true, overwrite: false, dedupeName: false }).catch((e) => {
      const msg = prettyError(e).toLowerCase();
      if (!/exist|already|same_name/.test(msg)) throw e;
    });
    return { path: p };
  }
  async rename(from, to) {
    const f = normPath(from), t = normPath(to);
    if (dirname(f) === dirname(t)) {
      await this.puter.fs.rename(this.abs(f), basename(t));
    } else {
      await this.puter.fs.move(this.abs(f), this.abs(dirname(t) || '.'));
      if (basename(f) !== basename(t)) await this.puter.fs.rename(this.abs(joinPath(dirname(t), basename(f))), basename(t));
    }
    fireChange({ op: 'rename', from: f, to: t });
    return { path: t };
  }
  async clear() {
    try { await this.puter.fs.delete(this.abs(), { recursive: true, descendantsOnly: true }); }
    catch { /* nothing to clear */ }
    await this.init();
    fireChange({ op: 'clear' });
  }
  async describe() {
    let space = null;
    try { space = await this.puter.fs.space?.(); } catch { /* ignore */ }
    return {
      backend: 'puter',
      root: this.rootLabel,
      signedIn: !!window.puter?.auth?.isSignedIn?.(),
      space: space ? { used: space.used, capacity: space.capacity, free: (space.capacity || 0) - (space.used || 0) } : null,
    };
  }
  /** Copy the whole workspace into another Puter dir (used before publishing). */
  async copyToPuterDir(targetDir) {
    const entries = (await this.list()).filter((e) => e.type === 'file');
    await this.puter.fs.mkdir(targetDir, { createMissingParents: true, overwrite: false, dedupeName: false }).catch(() => {});
    let n = 0;
    await pool(entries, 3, async (e) => {
      const blob = await this.readBlob(e.path);
      await this.puter.fs.write(`${targetDir}/${e.path}`, blob, { overwrite: true, dedupeName: false, createMissingParents: true });
      n++;
    });
    return n;
  }
}

/* ═══════════════════ IndexedDB handle storage (local folder) ═══════════════════ */
const IDB_NAME = 'pp-handles';
function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => { req.result.createObjectStore('kv'); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbSet(key, val) {
  const db = await idb();
  return new Promise((res, rej) => {
    const tx = db.transaction('kv', 'readwrite');
    tx.objectStore('kv').put(val, key);
    tx.oncomplete = res; tx.onerror = () => rej(tx.error);
  });
}
async function idbGet(key) {
  const db = await idb();
  return new Promise((res, rej) => {
    const tx = db.transaction('kv', 'readonly');
    const r = tx.objectStore('kv').get(key);
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}

/* ═══════════════════ factory ═══════════════════ */
let current = null;

export async function createWorkspace(backendId, opts = {}) {
  const id = backendId === 'auto' ? pickDefaultBackend() : backendId;

  if (id === 'memory') { current = await new MemoryWorkspace().init(); return current; }

  if (id === 'opfs') {
    if (!hasOpfs()) throw new Error('This browser has no private local storage (OPFS). Use In-browser memory instead.');
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(opts.dirName || 'playground', { create: true });
    current = await new HandleWorkspace('opfs', dir).init();
    return current;
  }

  if (id === 'local') {
    if (!hasFsAccessApi()) throw new Error('Your browser does not expose the File System Access API. Try Chrome, Edge or Opera — or pick another workspace.');
    const saved = opts.reuse !== false ? await idbGet('localDir') : null;
    let handle = null;
    if (saved) {
      const perm = await saved.queryPermission?.({ mode: 'readwrite' });
      if (perm === 'granted') handle = saved;
      else {
        const ask = await saved.requestPermission?.({ mode: 'readwrite' });
        if (ask === 'granted') handle = saved;
      }
    }
    if (!handle) {
      handle = await window.showDirectoryPicker({ mode: 'readwrite', id: 'pp-workspace', startIn: 'documents' });
      await idbSet('localDir', handle);
    }
    const ws = new HandleWorkspace('local', handle);
    ws.rootLabel = `📁 ${handle.name}`;
    current = await ws.init();
    return current;
  }

  if (id === 'puter') {
    const { ensurePuter } = await import('./llm.js');
    await ensurePuter();
    if (!window.puter?.auth?.isSignedIn?.()) {
      try { await window.puter.auth.signIn(); } catch { /* user may cancel; anonymous Puter FS still works in many cases */ }
    }
    current = await new PuterWorkspace(opts.dirName || 'PlaygroundWorkspace').init();
    return current;
  }

  throw new Error(`Unknown workspace backend: ${id}`);
}

export function pickDefaultBackend() {
  if (hasOpfs()) return 'opfs';
  return 'memory';
}

export function workspace() {
  if (!current) current = new MemoryWorkspace();
  return current;
}
export function setWorkspace(ws) { current = ws; fireChange({ op: 'backend', backend: ws?.id }); return ws; }
export function hasWorkspace() { return !!current; }
export const backendInfo = () => BACKENDS;
export { blobToBase64 };
