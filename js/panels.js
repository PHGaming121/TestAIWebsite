/**
 * Workspace panel panes: file tree + viewer (with a real multi-file preview)
 * and the terminal (mini-shell / JavaScript / Python).
 */
import {
  el, basename, dirname, formatBytes, hljsLang, isTextPath, isImagePath, isVideoPath, isAudioPath,
  prettyError, downloadBlob, lib,
} from './util.js';
import { icon, toast, promptDialog, confirmDialog } from './ui.js';
import { runShell, runJavaScript, runPython, pythonStatus } from './exec.js';

/* ══════════════════════════ FILES PANE ══════════════════════════ */
export class FilesPane {
  constructor({ treeEl, viewEl, pathEl, bodyEl, previewEl, hintEl, getWs, onChanged }) {
    this.treeEl = treeEl;
    this.viewEl = viewEl;
    this.pathEl = pathEl;
    this.bodyEl = bodyEl;
    this.previewEl = previewEl;
    this.hintEl = hintEl;
    this.getWs = getWs;
    this.onChanged = onChanged || (() => {});
    this.expanded = new Set(['']);
    this.selected = null;
    this.editing = false;
    this.dirty = new Set();
    this.previewOn = false;
  }

  markTouched(path) { this.dirty.add(path); this.refreshTree(); }

  async refresh() {
    await this.refreshTree();
    if (this.selected) await this.open(this.selected, { keepView: true }).catch(() => {});
  }

  async refreshTree() {
    const ws = this.getWs();
    this.treeEl.innerHTML = '';
    let entries = [];
    try { entries = await ws.list(); }
    catch (e) {
      this.treeEl.append(el('div.empty-note', { text: `Cannot read workspace: ${prettyError(e)}` }));
      return;
    }
    if (!entries.length) {
      this.treeEl.append(el('div.empty-note', { html: 'Empty workspace.<br>Ask the agent to build something, or use <b>Import</b> in the sidebar.' }));
      this.hintEl.textContent = '0 files';
      return;
    }

    // build nested structure
    const root = { children: new Map() };
    for (const e of entries) {
      const parts = e.path.split('/');
      let node = root;
      parts.forEach((part, i) => {
        const isFile = i === parts.length - 1 && e.type === 'file';
        if (!node.children.has(part)) {
          node.children.set(part, {
            name: part,
            path: parts.slice(0, i + 1).join('/'),
            type: isFile ? 'file' : 'dir',
            size: isFile ? e.size : 0,
            children: new Map(),
          });
        }
        const child = node.children.get(part);
        if (isFile) { child.type = 'file'; child.size = e.size; }
        node = child;
      });
    }

    const files = entries.filter((e) => e.type === 'file');
    this.hintEl.textContent = `${files.length} files · ${formatBytes(files.reduce((a, e) => a + (e.size || 0), 0))}`;

    const render = (node, depth) => {
      const items = [...node.children.values()].sort((a, b) =>
        (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
      for (const item of items) {
        if (item.type === 'dir') {
          const open = this.expanded.has(item.path);
          const row = el('div.ft-row', { class: open ? 'open' : '', style: { paddingLeft: `${6 + depth * 11}px` } },
            el('svg.ft-caret', { viewBox: '0 0 24 24', html: '<path d="M9 6l6 6-6 6"/>' }),
            icon('folder'),
            el('span.ft-name', { text: item.name }),
          );
          row.onclick = () => {
            if (this.expanded.has(item.path)) this.expanded.delete(item.path);
            else this.expanded.add(item.path);
            this.refreshTree();
          };
          this.treeEl.append(row);
          if (open) render(item, depth + 1);
        } else {
          const row = el('div.ft-row', { class: this.selected === item.path ? 'sel' : '', style: { paddingLeft: `${17 + depth * 11}px` } },
            icon('file'),
            el('span.ft-name', { text: item.name }),
            el('span.ft-size', { text: item.size ? formatBytes(item.size) : '' }),
          );
          if (this.dirty.has(item.path)) row.classList.add('dirty');
          row.onclick = () => this.open(item.path);
          row.oncontextmenu = (ev) => { ev.preventDefault(); this.fileMenu(ev, item.path); };
          this.treeEl.append(row);
        }
      }
    };
    render(root, 0);
    // auto-expand single top-level folders for a tidier first impression
    if (!this.expanded.size || (this.expanded.size === 1 && this.expanded.has(''))) {
      const dirs = [...root.children.values()].filter((c) => c.type === 'dir');
      if (dirs.length === 1) { this.expanded.add(dirs[0].path); render(root, 0); }
    }
  }

  fileMenu(ev, path) {
    const menu = el('div.model-menu', { style: { position: 'fixed', left: `${ev.clientX}px`, top: `${ev.clientY}px`, transform: 'none', width: '190px', padding: '6px', maxHeight: 'none' } });
    const item = (label, fn) => {
      const b = el('div.model-item', { style: { padding: '6px 8px' } }, el('span.mi-name', { text: label }));
      b.onclick = () => { menu.remove(); fn(); };
      menu.append(b);
    };
    item('Open', () => this.open(path));
    item('Rename…', async () => {
      const next = await promptDialog({ title: 'Rename / move', label: 'New path', value: path });
      if (!next) return;
      try { await this.getWs().rename(path, next); toast('Renamed', { type: 'ok' }); this.refresh(); }
      catch (e) { toast(prettyError(e), { type: 'err' }); }
    });
    item('Duplicate', async () => {
      try {
        const ws = this.getWs();
        const blob = await ws.readBlob(path);
        const ext = path.includes('.') ? '.' + path.split('.').pop() : '';
        const base = path.slice(0, path.length - ext.length);
        await ws.write(`${base}-copy${ext}`, blob);
        this.refresh();
      } catch (e) { toast(prettyError(e), { type: 'err' }); }
    });
    item('Download', () => this.download(path));
    item('Delete', async () => {
      if (!await confirmDialog({ title: `Delete ${basename(path)}?`, message: 'This removes the file from the workspace.', danger: true, confirmLabel: 'Delete' })) return;
      try { await this.getWs().remove(path); this.selected = null; this.refresh(); }
      catch (e) { toast(prettyError(e), { type: 'err' }); }
    });
    document.body.append(menu);
    const kill = (e) => { if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('mousedown', kill); } };
    setTimeout(() => document.addEventListener('mousedown', kill), 10);
  }

  async open(path, { keepView = false } = {}) {
    const ws = this.getWs();
    this.selected = path;
    this.editing = false;
    this.previewEl.hidden = true;
    this.previewOn = false;
    this.bodyEl.style.display = '';
    this.pathEl.textContent = path;
    this.refreshTree();

    try {
      if (isImagePath(path)) {
        const blob = await ws.readBlob(path);
        const url = URL.createObjectURL(blob);
        this.bodyEl.style.display = 'none';
        this.previewEl.hidden = false;
        this.previewEl.innerHTML = '';
        this.previewEl.append(el('div', { style: { display: 'grid', placeItems: 'center', height: '100%', padding: '12px', background: 'repeating-conic-gradient(#1b202c 0 25%, #151924 0 50%) 50%/18px 18px' } },
          el('img', { src: url, style: { maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', borderRadius: '8px' } })));
        return;
      }
      if (isVideoPath(path) || isAudioPath(path)) {
        const blob = await ws.readBlob(path);
        const url = URL.createObjectURL(blob);
        this.bodyEl.style.display = 'none';
        this.previewEl.hidden = false;
        this.previewEl.innerHTML = '';
        this.previewEl.append(el('div', { style: { display: 'grid', placeItems: 'center', height: '100%', padding: '12px', background: '#0d111a' } },
          isVideoPath(path)
            ? el('video', { src: url, controls: true, playsinline: true, style: { maxWidth: '100%', maxHeight: '100%', borderRadius: '8px' } })
            : el('audio', { src: url, controls: true, style: { width: 'min(420px,100%)' } })));
        return;
      }
      if (!isTextPath(path)) {
        const st = await ws.stat(path);
        this.bodyEl.innerHTML = '';
        this.bodyEl.append(el('div.fv-empty', { html: `Binary file · ${formatBytes(st?.size || 0)}<br><br><button class="btn tiny" id="dl-bin">Download</button>` }));
        this.bodyEl.querySelector('#dl-bin').onclick = () => this.download(path);
        return;
      }
      const text = await ws.read(path);
      this.renderCode(path, text);
      if (!keepView) this.scrollToTop();
    } catch (e) {
      this.bodyEl.innerHTML = '';
      this.bodyEl.append(el('div.fv-empty', { text: prettyError(e) }));
    }
  }

  renderCode(path, text) {
    const code = el('code');
    this.bodyEl.innerHTML = '';
    this.bodyEl.append(code);
    const lang = hljsLang(path);
    const hl = lib('hljs');
    if (hl && hl.getLanguage(lang)) {
      try { code.innerHTML = hl.highlight(text, { language: lang, ignoreIllegals: true }).value; }
      catch { code.textContent = text; }
    } else code.textContent = text;
    code.className = `hljs language-${lang}`;
  }

  scrollToTop() { this.bodyEl.scrollTop = 0; }

  async startEdit() {
    if (!this.selected) { toast('Open a file first'); return; }
    const ws = this.getWs();
    const text = await ws.read(this.selected).catch(() => '');
    this.editing = true;
    const ta = el('textarea.fv-editor', { spellcheck: 'false' });
    ta.value = text;
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') {
        e.preventDefault();
        const s = ta.selectionStart;
        ta.value = ta.value.slice(0, s) + '  ' + ta.value.slice(ta.selectionEnd);
        ta.selectionStart = ta.selectionEnd = s + 2;
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); this.saveEdit(ta.value); }
    });
    this.bodyEl.innerHTML = '';
    this.bodyEl.style.display = '';
    this.bodyEl.append(ta);
    ta.focus();
    this.pathEl.innerHTML = `${escPath(this.selected)} <span class="muted">· editing (Ctrl+S to save)</span>`;
  }

  async saveEdit(value) {
    if (!this.selected) return;
    try {
      await this.getWs().write(this.selected, value ?? '');
      this.dirty.add(this.selected);
      toast(`Saved ${basename(this.selected)}`, { type: 'ok' });
      await this.open(this.selected);
      this.onChanged();
    } catch (e) { toast(prettyError(e), { type: 'err' }); }
  }

  async download(path) {
    try {
      const blob = await this.getWs().readBlob(path);
      downloadBlob(blob, basename(path));
    } catch (e) { toast(prettyError(e), { type: 'err' }); }
  }

  /** Build a self-contained preview of an HTML file (inlines local css/js/images). */
  async buildPreview(path) {
    const ws = this.getWs();
    let html = await ws.read(path);
    const base = dirname(path);
    const resolve = (ref) => {
      if (/^(https?:|data:|blob:|\/\/|#|mailto:)/i.test(ref)) return null;
      const clean = ref.replace(/^\.\//, '').split('?')[0].split('#')[0];
      const p = clean.startsWith('/') ? clean.slice(1) : (base ? `${base}/${clean}` : clean);
      return p.split('/').reduce((acc, part) => {
        if (part === '..') acc.pop();
        else if (part && part !== '.') acc.push(part);
        return acc;
      }, []).join('/');
    };

    // inline stylesheets
    const linkRe = /<link[^>]+rel=["']?stylesheet["']?[^>]*>/gi;
    for (const tag of html.match(linkRe) || []) {
      const href = tag.match(/href=["']([^"']+)["']/i)?.[1];
      const p = href && resolve(href);
      if (!p) continue;
      const css = await ws.read(p).catch(() => null);
      if (css === null) continue;
      html = html.replace(tag, `<style>\n/* ${p} */\n${css}\n</style>`);
    }
    // inline scripts (skip modules/external http)
    const scriptRe = /<script[^>]+src=["']([^"']+)["'][^>]*><\/script>/gi;
    for (const tag of html.match(scriptRe) || []) {
      const src = tag.match(/src=["']([^"']+)["']/i)?.[1];
      const p = src && resolve(src);
      if (!p) continue;
      const js = await ws.read(p).catch(() => null);
      if (js === null) continue;
      const isModule = /type=["']module["']/i.test(tag);
      html = html.replace(tag, `<script${isModule ? ' type="module"' : ''}>\n/* ${p} */\n${js.replace(/<\/script>/gi, '<\\/script>')}\n</script>`);
    }
    // images → data URLs
    const imgRe = /(<img[^>]+src=["'])([^"']+)(["'])/gi;
    for (const m of html.match(imgRe) || []) {
      const p = resolve(m.replace(/^<img[^>]+src=["']/i, '').replace(/["']$/i, ''));
      if (!p) continue;
      try {
        const blob = await ws.readBlob(p);
        if (blob.size > 2_000_000) continue;
        const dataUrl = await blobToDataUrl(blob);
        html = html.replace(m, m.replace(/src=["'][^"']+["']/i, `src="${dataUrl}"`));
      } catch { /* missing asset — leave as-is */ }
    }
    return html;
  }

  async togglePreview(path = this.selected) {
    if (!path) { toast('Open an HTML file first'); return; }
    if (!/\.html?$/i.test(path)) {
      // not an HTML file — try the nearest index.html instead
      const ws = this.getWs();
      const candidates = [dirname(path) ? `${dirname(path)}/index.html` : 'index.html', 'index.html'];
      for (const c of candidates) {
        if (await ws.exists(c)) { path = c; break; }
      }
      if (!/\.html?$/i.test(path)) { toast('Preview works on .html files'); return; }
    }
    if (this.previewOn && this.previewEl.dataset.for === path) {
      this.previewOn = false;
      this.previewEl.hidden = true;
      this.bodyEl.style.display = '';
      return;
    }
    try {
      const html = await this.buildPreview(path);
      this.bodyEl.style.display = 'none';
      this.previewEl.hidden = false;
      this.previewEl.dataset.for = path;
      this.previewOn = true;
      this.previewEl.innerHTML = '';
      const frame = el('iframe.fv-preview', { sandbox: 'allow-scripts allow-modals allow-forms allow-popups', title: 'Preview' });
      frame.srcdoc = html;
      this.previewEl.append(frame);
    } catch (e) {
      toast(`Preview failed: ${prettyError(e)}`, { type: 'err' });
    }
  }

  async newFile() {
    const path = await promptDialog({
      title: 'New file', label: 'Workspace-relative path', placeholder: 'e.g. src/app.js',
      validate: (v) => (!v ? 'Path is required' : null),
    });
    if (!path) return;
    try {
      const ws = this.getWs();
      if (await ws.exists(path)) { toast('That file already exists — opening it'); return this.open(path); }
      await ws.write(path, '');
      await this.refreshTree();
      await this.open(path);
      this.startEdit();
    } catch (e) { toast(prettyError(e), { type: 'err' }); }
  }
}

function escPath(p) { return String(p).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c])); }

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
}

/* ══════════════════════════ TERMINAL PANE ══════════════════════════ */
export class TermPane {
  constructor({ outEl, inEl, promptEl, runtimeEl, hintEl, getWs, onChanged }) {
    this.out = outEl;
    this.input = inEl;
    this.promptEl = promptEl;
    this.runtimeEl = runtimeEl;
    this.hintEl = hintEl;
    this.getWs = getWs;
    this.onChanged = onChanged || (() => {});
    this.history = [];
    this.histIdx = -1;
    this.busy = false;
    this.cwd = '';

    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.run(); }
      if (e.key === 'ArrowUp' && this.input.selectionStart === 0) {
        e.preventDefault();
        if (this.histIdx < this.history.length - 1) this.input.value = this.history[++this.histIdx];
      }
      if (e.key === 'ArrowDown' && this.histIdx >= 0) {
        e.preventDefault();
        this.histIdx--;
        this.input.value = this.histIdx >= 0 ? this.history[this.histIdx] : '';
      }
    });
    this.print('pp-sh — mini shell over the workspace. Type `help` for commands.\nRuntimes: mini-shell, JavaScript (sandboxed worker), Python (Pyodide).', 'dim');
  }

  print(text, cls = '') {
    if (text === '\u000c') { this.out.innerHTML = ''; return; }
    const line = el('div', { class: cls ? `t-${cls}` : '', text: String(text) });
    this.out.append(line);
    this.out.scrollTop = this.out.scrollHeight;
  }

  printBlock(title, text, cls = '') {
    if (title) this.print(title, 'dim');
    if (text) {
      const b = el('div.t-block', { class: cls ? `t-${cls}` : '' });
      b.textContent = text;
      this.out.append(b);
      this.out.scrollTop = this.out.scrollHeight;
    }
  }

  clear() { this.out.innerHTML = ''; }

  setRuntime(rt) {
    if (this.runtimeEl) this.runtimeEl.value = rt;
    this.promptEl.textContent = rt === 'py' ? '>>>' : rt === 'js' ? '>' : '$';
    this.hintEl.textContent = rt === 'py' ? 'python 3 · pyodide' : rt === 'js' ? 'sandboxed worker' : 'mini-shell';
  }

  async run(code) {
    if (this.busy) { toast('Still running the previous command'); return; }
    const runtime = this.runtimeEl?.value || 'shell';
    const text = (code ?? this.input.value).trimEnd();
    if (!text.trim()) return;
    this.history.unshift(text);
    this.histIdx = -1;
    this.input.value = '';
    this.busy = true;
    const ws = this.getWs();
    const started = performance.now();
    const prefix = runtime === 'py' ? '>>>' : runtime === 'js' ? '>' : `$ ${this.cwd ? this.cwd + ' ' : ''}`;
    this.printBlock(`${prefix} ${text.split('\n')[0]}${text.includes('\n') ? ` … (+${text.split('\n').length - 1} lines)` : ''}`, '', 'cmd');

    try {
      if (runtime === 'shell') {
        const res = await runShell(text, ws, { onLog: () => {} });
        this.cwd = res.cwd || this.cwd;
        this.promptEl.textContent = '$';
        if (res.output) this.printBlock('', res.output, res.exitCode ? 'err' : '');
        this.print(`[exit ${res.exitCode} · ${Math.round(performance.now() - started)}ms]`, 'dim');
        if (res.exitCode === 0 && /\b(rm|mv|cp|mkdir|touch|>|write)\b/.test(text)) this.onChanged();
      } else if (runtime === 'js') {
        const res = await runJavaScript(text, ws, {
          timeoutMs: 30000,
          onLog: (lvl, t) => this.printBlock('', t, lvl === 'error' ? 'err' : lvl === 'warn' ? 'dim' : ''),
        });
        if (res.output) this.printBlock('', res.output);
        if (res.error) this.printBlock('', res.error, 'err');
        this.print(`[exit ${res.exitCode} · ${res.ms}ms]`, 'dim');
        this.onChanged();
      } else {
        const st = pythonStatus();
        if (st.state !== 'ready') this.print('starting Pyodide (one-time download)…', 'dim');
        const res = await runPython(text, ws, {
          timeoutMs: 120000,
          onLog: (lvl, t) => this.printBlock('', t, lvl === 'error' ? 'err' : ''),
          onStatus: (s) => this.print(s, 'dim'),
        });
        if (res.output) this.printBlock('', res.output);
        if (res.error) this.printBlock('', res.error, 'err');
        if (res.filesWritten?.length) this.print(`saved → ${res.filesWritten.join(', ')}`, 'ok');
        this.print(`[exit ${res.exitCode} · ${res.ms}ms]`, 'dim');
        this.onChanged();
      }
    } catch (e) {
      this.printBlock('', prettyError(e), 'err');
    } finally {
      this.busy = false;
      this.out.scrollTop = this.out.scrollHeight;
    }
  }
}

export { blobToDataUrl };
