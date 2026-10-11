/**
 * Sandboxed JavaScript runtime for the playground.
 *
 * Runs agent-authored code inside a Web Worker: no DOM, no localStorage, no
 * access to the host page. A curated `fs` object bridges (async) to the real
 * workspace on the main thread, and `console` is streamed back for display.
 */
(() => {
  const pending = new Map();
  let reqId = 0;
  const logs = [];

  const send = (msg) => self.postMessage(msg);

  function ask(op, payload) {
    const id = ++reqId;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      send({ type: 'fs', id, op, ...payload });
    });
  }

  /* ── console ──────────────────────────────────────────── */
  const fmt = (v, depth = 0) => {
    if (v === null) return 'null';
    if (v === undefined) return 'undefined';
    const t = typeof v;
    if (t === 'string') return depth === 0 ? v : JSON.stringify(v);
    if (t === 'number' || t === 'boolean' || t === 'bigint') return String(v);
    if (t === 'function') return `[Function ${v.name || 'anonymous'}]`;
    if (t === 'symbol') return v.toString();
    if (v instanceof Error) return `${v.name}: ${v.message}`;
    if (v instanceof Blob) return `Blob(${v.size} bytes, ${v.type || 'no type'})`;
    if (v instanceof Uint8Array) return `Uint8Array(${v.length})`;
    if (Array.isArray(v)) {
      if (depth > 2) return `Array(${v.length})`;
      return `[ ${v.map((x) => fmt(x, depth + 1)).join(', ')} ]`;
    }
    if (t === 'object') {
      if (depth > 2) return `{…}`;
      try {
        const entries = Object.entries(v).slice(0, 60).map(([k, x]) => `${k}: ${fmt(x, depth + 1)}`);
        return `{ ${entries.join(', ')} }`;
      } catch { return '[Object]'; }
    }
    return String(v);
  };

  const makeLog = (level) => (...args) => {
    const text = args.map((a) => fmt(a)).join(' ');
    logs.push({ level, text });
    send({ type: 'log', level, text });
  };
  const console = {
    log: makeLog('log'), info: makeLog('info'), warn: makeLog('warn'),
    error: makeLog('error'), debug: makeLog('debug'), trace: makeLog('debug'),
    dir: (o) => makeLog('log')(fmt(o, 1)),
    table: (rows) => {
      if (!Array.isArray(rows)) return makeLog('log')(fmt(rows));
      const keys = [...new Set(rows.flatMap((r) => (r && typeof r === 'object' ? Object.keys(r) : [])))];
      if (!keys.length) return makeLog('log')(rows.map((r) => fmt(r)).join('\n'));
      const line = (cells) => cells.map((c) => String(c ?? '').padEnd(14)).join(' | ');
      makeLog('log')([line(keys), line(keys.map(() => '--------------')), ...rows.map((r) => line(keys.map((k) => r?.[k])))].join('\n'));
    },
    time: (() => { const t = {}; return (l = 'default') => { t[l] = performance.now(); }; })(),
    timeEnd: (() => { const noop = () => {}; return noop; })(),
    group: makeLog('log'), groupEnd: () => {}, assert: (cond, ...m) => { if (!cond) makeLog('error')('Assertion failed:', ...m); },
  };

  /* ── fs bridge ────────────────────────────────────────── */
  const fs = {
    read: (path) => ask('read', { path }).then((r) => r.text),
    readBytes: (path) => ask('readBlob', { path }).then((r) => new Uint8Array(r.bytes)),
    write: (path, content) => ask('write', { path, content: typeof content === 'string' ? content : Array.from(new Uint8Array(content instanceof ArrayBuffer ? content : content.buffer || content)) }),
    list: () => ask('list', {}).then((r) => r.entries),
    exists: (path) => ask('exists', { path }).then((r) => !!r.exists),
    remove: (path) => ask('remove', { path }),
    mkdir: (path) => ask('mkdir', { path }),
    rename: (from, to) => ask('rename', { from, to }),
    tree: () => ask('list', {}).then((r) => r.entries.filter((e) => e.type === 'file').map((e) => e.path)),
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ── message handling ─────────────────────────────────── */
  self.onmessage = async (event) => {
    const msg = event.data || {};

    if (msg.type === 'fs-result') {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.data ?? {});
      else p.reject(new Error(msg.error || 'filesystem error'));
      return;
    }

    if (msg.type === 'run') {
      const started = performance.now();
      try {
        const factory = new Function(
          'console', 'fs', 'sleep', 'args', 'self_', 'globalThis_',
          '"use strict";\nreturn (async () => {\n' + msg.code + '\n})();',
        );
        const result = await factory(console, fs, sleep, msg.args || [], null, null);
        send({
          type: 'done',
          ok: true,
          value: result === undefined ? undefined : fmt(result, 1),
          ms: Math.round(performance.now() - started),
          logs,
        });
      } catch (err) {
        send({
          type: 'done',
          ok: false,
          error: err && err.message ? err.message : String(err),
          stack: err && err.stack ? String(err.stack).split('\n').slice(0, 6).join('\n') : '',
          ms: Math.round(performance.now() - started),
          logs,
        });
      }
    }
  };

  send({ type: 'ready' });
})();
