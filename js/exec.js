/**
 * Code execution bridge (main thread).
 *
 *   runJavaScript()  → sandboxed Web Worker with an async `fs` bridge
 *   runPython()      → Pyodide (CPython/WASM) in a persistent worker
 *   runShell()       → the mini-shell interpreter from ./shell.js
 *
 * All three operate on the active Workspace, so anything the agent writes is
 * immediately visible in the Files tab and can be committed to GitHub.
 */
import { Shell } from './shell.js';
import { isTextPath, truncate, prettyError, formatBytes, pool } from './util.js';

const WORKER_URL_JS = new URL('./workers/js-sandbox.js', import.meta.url);
const WORKER_URL_PY = new URL('./workers/py-sandbox.js', import.meta.url);

const PYODIDE_FALLBACKS = ['0.28.3', '0.27.7', '0.26.4', '0.25.1'];

/* ══════════════ JavaScript sandbox ══════════════ */

/**
 * @param {string} code
 * @param {import('./workspace.js').BaseWorkspace} ws
 * @param {{timeoutMs?:number, args?:any[], onLog?:Function}} [opts]
 */
export async function runJavaScript(code, ws, opts = {}) {
  const { timeoutMs = 20000, args = [], onLog } = opts;
  const output = [];
  let worker;
  try {
    worker = new Worker(WORKER_URL_JS, { type: 'classic' });
  } catch (e) {
    return { output: '', error: `Could not start the JS sandbox: ${prettyError(e)}`, exitCode: 1, ms: 0 };
  }

  const started = performance.now();
  const result = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      output.push({ level: 'error', text: `⏱ timed out after ${timeoutMs}ms — worker terminated` });
      resolve({ ok: false, timeout: true });
    }, timeoutMs);

    worker.onmessage = async (ev) => {
      const msg = ev.data || {};
      if (msg.type === 'log') {
        output.push({ level: msg.level, text: msg.text });
        onLog?.(msg.level, msg.text);
        return;
      }
      if (msg.type === 'fs') {
        try {
          const data = await handleFsRequest(msg, ws);
          worker.postMessage({ type: 'fs-result', id: msg.id, ok: true, data });
        } catch (e) {
          worker.postMessage({ type: 'fs-result', id: msg.id, ok: false, error: prettyError(e) });
        }
        return;
      }
      if (msg.type === 'done') {
        clearTimeout(timer);
        resolve(msg);
      }
    };
    worker.onerror = (e) => {
      clearTimeout(timer);
      resolve({ ok: false, error: e?.message || 'Worker error' });
    };
    worker.postMessage({ type: 'run', code, args });
  });

  worker.terminate();
  const ms = Math.round(performance.now() - started);
  const text = output.map((o) => o.text).join('\n');
  if (result.timeout) return { output: text, error: `Execution timed out after ${timeoutMs}ms`, exitCode: 124, ms };
  if (!result.ok) {
    return { output: text, error: [result.error, result.stack].filter(Boolean).join('\n'), exitCode: 1, ms };
  }
  const value = result.value !== undefined ? `\n↳ ${result.value}` : '';
  return { output: text + value, error: null, exitCode: 0, ms };
}

async function handleFsRequest(msg, ws) {
  const { op, path } = msg;
  switch (op) {
    case 'read': return { text: await ws.read(path) };
    case 'readBlob': {
      const blob = await ws.readBlob(path);
      return { bytes: Array.from(new Uint8Array(await blob.arrayBuffer())) };
    }
    case 'write': {
      const content = typeof msg.content === 'string' ? msg.content : new Uint8Array(msg.content);
      await ws.write(path, content);
      return { ok: true };
    }
    case 'list': return { entries: await ws.list() };
    case 'exists': return { exists: await ws.exists(path) };
    case 'remove': await ws.remove(path); return { ok: true };
    case 'mkdir': await ws.mkdir(path); return { ok: true };
    case 'rename': await ws.rename(msg.from, msg.to); return { ok: true };
    default: throw new Error(`Unknown fs op: ${op}`);
  }
}

/* ══════════════ Python (Pyodide) ══════════════ */

let pyWorker = null;
let pyState = 'idle'; // idle | loading | ready | error
let pyVersion = null;
let pyStatusText = '';
const pyWaiters = [];

export const pythonStatus = () => ({ state: pyState, version: pyVersion, status: pyStatusText });

async function discoverPyodideVersion() {
  try {
    const res = await fetch('https://data.jsdelivr.com/v1/packages/npm/pyodide', { cache: 'force-cache' });
    if (!res.ok) return null;
    const data = await res.json();
    const latest = data?.tags?.latest;
    if (latest && /^\d+\.\d+\.\d+/.test(latest)) return latest;
    const list = (data?.versions || []).map((v) => v.version).filter((v) => /^\d+\.\d+\.\d+$/.test(v));
    return list[0] || null;
  } catch { return null; }
}

export async function ensurePython({ version = '', onStatus } = {}) {
  if (pyState === 'ready' && pyWorker) return true;
  if (pyState === 'loading') {
    return new Promise((resolve) => pyWaiters.push(resolve));
  }

  pyState = 'loading';
  pyStatusText = 'resolving Pyodide…';
  onStatus?.(pyStatusText);

  const versions = version ? [version, ...PYODIDE_FALLBACKS] : [...PYODIDE_FALLBACKS];
  const discovered = await discoverPyodideVersion();
  if (discovered) versions.unshift(discovered);

  for (const v of [...new Set(versions)]) {
    const indexURL = `https://cdn.jsdelivr.net/pyodide/v${v}/full/`;
    try {
      pyStatusText = `downloading CPython ${v}…`;
      onStatus?.(pyStatusText);
      const ok = await startPyWorker(indexURL, v);
      if (ok) {
        pyState = 'ready';
        pyVersion = v;
        pyStatusText = `Pyodide ${v} ready`;
        onStatus?.(pyStatusText);
        pyWaiters.splice(0).forEach((r) => r(true));
        return true;
      }
    } catch (e) {
      pyStatusText = `Pyodide ${v} failed: ${prettyError(e)}`;
    }
  }

  pyState = 'error';
  pyStatusText = 'Could not load Pyodide from jsDelivr. Check the network connection or set a version in Settings.';
  onStatus?.(pyStatusText);
  pyWaiters.splice(0).forEach((r) => r(false));
  return false;
}

function startPyWorker(indexURL, version) {
  return new Promise((resolve) => {
    let worker;
    try { worker = new Worker(WORKER_URL_PY, { type: 'classic' }); }
    catch (e) { pyStatusText = `Worker blocked: ${prettyError(e)}`; resolve(false); return; }

    const fail = setTimeout(() => { try { worker.terminate(); } catch { /* ignore */ } resolve(false); }, 90000);
    worker.onmessage = (ev) => {
      const msg = ev.data || {};
      if (msg.type === 'ready') {
        clearTimeout(fail);
        pyWorker = worker;
        worker.onmessage = pyMessageHandler;
        resolve(true);
      } else if (msg.type === 'init-error') {
        clearTimeout(fail);
        pyStatusText = msg.error;
        try { worker.terminate(); } catch { /* ignore */ }
        resolve(false);
      }
    };
    worker.onerror = (e) => {
      clearTimeout(fail);
      pyStatusText = `Pyodide ${version} error: ${e?.message || 'unknown'}`;
      try { worker.terminate(); } catch { /* ignore */ }
      resolve(false);
    };
    worker.postMessage({ type: 'init', indexURL, cwd: '/home/playground' });
  });
}

let currentPyRun = null;
function pyMessageHandler(ev) {
  const msg = ev.data || {};
  if (!currentPyRun) return;
  if (msg.type === 'log') { currentPyRun.logs.push(msg); currentPyRun.onLog?.(msg.level, msg.text); }
  else if (msg.type === 'done') { currentPyRun.resolve(msg); }
}

export function killPython() {
  try { pyWorker?.terminate(); } catch { /* ignore */ }
  pyWorker = null; pyState = 'idle'; pyVersion = null; pyStatusText = '';
}

/**
 * @param {string} code
 * @param {import('./workspace.js').BaseWorkspace} ws
 */
export async function runPython(code, ws, opts = {}) {
  const { timeoutMs = 90000, onLog, onStatus, version = '' } = opts;
  const ready = await ensurePython({ version, onStatus });
  if (!ready) return { output: '', error: pyStatusText || 'Pyodide unavailable', exitCode: 1, ms: 0, filesWritten: [] };

  // Mount text files so Python can read the project.
  const files = [];
  const entries = (await ws.list()).filter((e) => e.type === 'file' && isTextPath(e.path) && (e.size || 0) < 800_000);
  let total = 0;
  await pool(entries.slice(0, 200), 4, async (e) => {
    if (total > 3_000_000) return;
    try { const text = await ws.read(e.path); total += text.length; files.push({ path: e.path, content: text }); }
    catch { /* skip */ }
  });

  const started = performance.now();
  const logs = [];
  const result = await new Promise((resolve) => {
    currentPyRun = { logs, onLog, resolve };
    const timer = setTimeout(() => resolve({ ok: false, error: `Timed out after ${Math.round(timeoutMs / 1000)}s`, timeout: true }), timeoutMs);
    const origResolve = resolve;
    currentPyRun.resolve = (m) => { clearTimeout(timer); origResolve(m); };
    pyWorker.postMessage({ type: 'run', code, files });
  });
  currentPyRun = null;

  const ms = Math.round(performance.now() - started);
  const textNow = () => logs.map((l) => l.text).join('\n');

  if (result.timeout) {
    killPython(); // a runaway Python call cannot be interrupted; restart clean next time
    return { output: textNow(), error: `Timed out after ${Math.round(timeoutMs / 1000)}s (runtime reset)`, exitCode: 124, ms, filesWritten: [] };
  }
  if (!result.ok) return { output: textNow(), error: result.error || 'Python error', exitCode: 1, ms, filesWritten: [] };

  // Write changed/created files back into the workspace.
  const filesWritten = [];
  for (const f of result.files || []) {
    try {
      const before = await ws.exists(f.path) ? await ws.read(f.path).catch(() => null) : null;
      const after = f.text ?? null;
      if (after !== null && before === after) continue;
      await ws.write(f.path, f.text !== undefined ? f.text : new Uint8Array(f.bytes));
      filesWritten.push(f.path);
    } catch (e) { logs.push({ level: 'warn', text: `could not save ${f.path}: ${prettyError(e)}` }); }
  }

  const value = result.value !== undefined && result.value !== 'None' && result.value !== '' ? `\n↳ ${truncate(result.value, 2000)}` : '';
  const pkgNote = result.packages ? `\n📦 loaded: ${result.packages}` : '';
  return {
    output: textNow() + pkgNote + value,
    error: null,
    exitCode: 0,
    ms,
    filesWritten,
  };
}

/* ══════════════ Shell ══════════════ */
const shells = new WeakMap();

export function getShell(ws, external = {}) {
  let sh = shells.get(ws);
  if (!sh) { sh = new Shell(ws, { external }); shells.set(ws, sh); }
  sh.external = { ...sh.external, ...external };
  return sh;
}

export async function runShell(line, ws, opts = {}) {
  const { external = {}, onLog } = opts;
  const sh = getShell(ws, external);
  const res = await sh.run(line);
  if (onLog && res.output) onLog('log', res.output);
  return { ...res, cwd: sh.cwd };
}

/* ══════════════ helpers ══════════════ */
export function summarizeExec(res) {
  const bits = [];
  if (res.output) bits.push(truncate(res.output, 8000));
  if (res.error) bits.push(`ERROR: ${truncate(res.error, 4000)}`);
  if (res.filesWritten?.length) bits.push(`Files written: ${res.filesWritten.join(', ')}`);
  if (res.ms) bits.push(`(${res.ms}ms)`);
  return bits.join('\n') || '(no output)';
}

export { formatBytes };
