/* global importScripts */
/**
 * Pyodide worker: real CPython (compiled to WASM) in the browser.
 *
 * The playground mounts the current workspace into Pyodide's virtual FS,
 * runs the code, streams stdout/stderr back, and ships any created or changed
 * files home so the agent can commit them.
 */
(() => {
  let pyodide = null;
  let cwd = '/home/playground';
  const MAX_FILE_BYTES = 1_500_000;
  const MAX_FILES_BACK = 120;

  const send = (m) => self.postMessage(m);
  const log = (level, text) => send({ type: 'log', level, text });

  const TEXTISH = /\.(py|txt|md|json|csv|tsv|html?|css|js|mjs|xml|ya?ml|toml|ini|cfg|log|sh|sql|svg|tex|rst)$/i;

  async function init(msg) {
    const indexURL = msg.indexURL;
    try {
      importScripts(`${indexURL}pyodide.js`);
    } catch (e) {
      send({ type: 'init-error', error: `Could not load Pyodide from ${indexURL} (${e.message}). Check your connection or change the Pyodide version in Settings.` });
      return;
    }
    try {
      pyodide = await self.loadPyodide({ indexURL });
      pyodide.setStdout({ batched: (s) => log('log', s) });
      pyodide.setStderr({ batched: (s) => log('error', s) });
      pyodide.setStdin?.({ batched: () => {} });
      pyodide.FS.mkdirTree(cwd);
      pyodide.FS.chdir(cwd);
      send({ type: 'ready', version: pyodide.version });
    } catch (e) {
      send({ type: 'init-error', error: `Pyodide failed to start: ${e.message || e}` });
    }
  }

  function writeFileTree(files) {
    for (const f of files || []) {
      const path = f.path.replace(/^\/+/, '');
      if (!path) continue;
      const full = `${cwd}/${path}`;
      const dir = full.slice(0, full.lastIndexOf('/'));
      try {
        pyodide.FS.mkdirTree(dir);
        if (typeof f.content === 'string') pyodide.FS.writeFile(full, f.content);
        else pyodide.FS.writeFile(full, new Uint8Array(f.bytes));
      } catch (e) { log('warn', `mount: could not write ${path} (${e.message || e})`); }
    }
  }

  function snapshot() {
    const map = new Map();
    const walk = (dir) => {
      let entries;
      try { entries = pyodide.FS.readdir(dir); } catch { return; }
      for (const name of entries) {
        if (name === '.' || name === '..') continue;
        const full = `${dir}/${name}`;
        let st;
        try { st = pyodide.FS.stat(full); } catch { continue; }
        if (pyodide.FS.isDir(st.mode)) {
          // skip pyodide's own runtime dirs
          if (/node_modules|__pycache__|site-packages|\/lib\/|\.git/.test(full)) continue;
          walk(full);
        } else if (pyodide.FS.isFile(st.mode)) {
          if (st.size > MAX_FILE_BYTES) continue;
          try { map.set(full.slice(cwd.length + 1), pyodide.FS.readFile(full)); } catch { /* skip */ }
        }
      }
    };
    walk(cwd);
    return map;
  }

  async function run(msg) {
    if (!pyodide) { send({ type: 'done', ok: false, error: 'Pyodide is not ready' }); return; }
    const started = performance.now();
    try {
      pyodide.FS.mkdirTree(cwd);
      pyodide.FS.chdir(cwd);
      writeFileTree(msg.files);
      const before = snapshot();

      let pkgs = '';
      try {
        const loaded = await pyodide.loadPackagesFromImports(msg.code, {
          messageCallback: (m) => log('info', `📦 ${m}`),
          errorCallback: () => {},
        });
        if (loaded?.length) pkgs = loaded.map((p) => p.packageName).join(', ');
      } catch (e) { log('warn', `package autodetect: ${e.message || e}`); }

      const result = await pyodide.runPythonAsync(msg.code);

      const after = snapshot();
      const changed = [];
      let n = 0;
      for (const [path, bytes] of after) {
        if (n++ > MAX_FILES_BACK) break;
        const old = before.get(path);
        const same = old && old.length === bytes.length && old.every((b, i) => b === bytes[i]);
        if (same) continue;
        const isText = TEXTISH.test(path);
        if (isText) {
          changed.push({ path, text: new TextDecoder().decode(bytes) });
        } else if (bytes.length < 400_000) {
          changed.push({ path, bytes: Array.from(bytes) });
        }
      }

      send({
        type: 'done',
        ok: true,
        value: result === undefined || result === null ? undefined : String(result),
        packages: pkgs,
        files: changed,
        ms: Math.round(performance.now() - started),
      });
    } catch (e) {
      send({
        type: 'done',
        ok: false,
        error: e?.message ? String(e.message).split('\n').slice(-14).join('\n') : String(e),
        ms: Math.round(performance.now() - started),
      });
    }
  }

  self.onmessage = (event) => {
    const msg = event.data || {};
    if (msg.type === 'init') { if (msg.cwd) cwd = msg.cwd; init(msg); }
    else if (msg.type === 'run') run(msg);
    else if (msg.type === 'ping') send({ type: 'pong', ready: !!pyodide });
  };
})();
