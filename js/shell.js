/**
 * A small POSIX-flavoured shell that runs against the Workspace abstraction.
 * Supports: pipes, &&, ||, ;, redirects (>, >>), quoting, globs (* and ?).
 *
 * It is an *interpreter*, not a real shell — commands are implemented over the
 * workspace API so the agent can inspect and edit files deterministically.
 */
import { dirname, joinPath, normPath, formatBytes, isTextPath } from './util.js';

export const SHELL_COMMANDS = [
  'ls', 'cd', 'pwd', 'cat', 'head', 'tail', 'wc', 'grep', 'find', 'mkdir', 'touch', 'rm',
  'cp', 'mv', 'echo', 'tree', 'du', 'date', 'clear', 'help', 'python', 'py', 'node', 'js',
];

export class Shell {
  /**
   * @param {import('./workspace.js').BaseWorkspace} ws
   * @param {{cwd?:string, external?:Record<string,Function>}} [opts]
   */
  constructor(ws, opts = {}) {
    this.ws = ws;
    this.cwd = opts.cwd || '';
    this.external = opts.external || {}; // {python: async(args, stdin, ctx)=>result}
    this.env = { PWD: '/', USER: 'playground', SHELL: 'pp-sh 1.0' };
  }

  resolve(p = '') {
    const s = String(p).replace(/^~\/?/, '');
    if (!s || s === '.') return this.cwd;
    if (s === '..') return dirname(this.cwd);
    return normPath(s.startsWith('/') ? s.slice(1) : joinPath(this.cwd, s));
  }

  async run(line) {
    const out = [];
    const push = (t = '') => out.push(String(t));
    let lastCode = 0;
    for (const statement of splitStatements(String(line || ''))) {
      lastCode = await this.runStatement(statement, push);
    }
    this.env.PWD = '/' + this.cwd;
    return { output: out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd(), exitCode: lastCode, cwd: this.cwd };
  }

  async runStatement(stmt, push) {
    let stdin = '';
    let code = 0;
    for (let i = 0; i < stmt.segments.length; i++) {
      const seg = stmt.segments[i];
      const res = await this.execSegment(seg, stdin, push, i === stmt.segments.length - 1 ? stmt.redirect : null);
      stdin = res.stdout;
      code = res.code;
      if (code !== 0 && i < stmt.segments.length - 1) break;
    }
    return code;
  }

  async execSegment(tokens, stdin, push, redirect) {
    let stdout = '';
    const emit = (t = '') => {
      const s = String(t);
      stdout += (stdout && !stdout.endsWith('\n') ? '\n' : '') + s;
      if (!redirect) push(s);
    };
    const emitErr = (t = '') => { push(`pp-sh: ${t}`); };

    if (!tokens.length) return { stdout, code: 0 };
    const [cmd, ...args] = tokens;

    try {
      const code = await this.dispatch(cmd, args, { stdin, emit, emitErr });
      if (redirect?.file) {
        const target = this.resolve(redirect.file);
        const prev = redirect.mode === '>>' ? await this.ws.read(target).catch(() => '') : '';
        await this.ws.write(target, prev + (prev && !prev.endsWith('\n') ? '\n' : '') + stdout + (stdout.endsWith('\n') || !stdout ? '' : '\n'));
        push(`→ wrote ${redirect.file}`);
      }
      return { stdout, code };
    } catch (e) {
      emitErr(e?.message || String(e));
      return { stdout, code: 1 };
    }
  }

  async dispatch(cmd, args, ctx) {
    const { emit, emitErr, stdin } = ctx;
    const ws = this.ws;

    switch (cmd) {
      case 'help': {
        emit(`pp-sh — mini shell over the ${ws.id} workspace\n\nCommands:\n` +
          '  ls [-l] [-a] [path]     list directory\n' +
          '  cd <path>               change directory\n' +
          '  pwd                     print working directory\n' +
          '  cat <file...>           print file(s)\n' +
          '  head|tail [-n N] <file> first/last lines\n' +
          '  wc [-l|-w|-c] <file>    count lines/words/bytes\n' +
          '  grep [-i] [-n] <pat> <file|->   search (use - for stdin)\n' +
          '  find [path] [-name <glob>]      recursive listing\n' +
          '  mkdir [-p] <dir...>     create directories\n' +
          '  touch <file...>         create empty files\n' +
          '  rm [-r] <path...>       delete files/dirs\n' +
          '  cp <src> <dst>          copy file\n' +
          '  mv <src> <dst>          move/rename\n' +
          '  echo <text...>          print text (supports > redirect)\n' +
          '  tree [path]             show tree\n' +
          '  du [path]               disk usage\n' +
          '  python <file|-c code>   run Python (Pyodide, lazy-loaded)\n' +
          '  node <file|-e code>     run JavaScript in a sandboxed worker\n' +
          '  date, clear, help\n\nPipes, &&, ||, ;, > and >> all work.');
        return 0;
      }

      case 'clear': emit('\u000c'); return 0;
      case 'date': emit(new Date().toString()); return 0;

      case 'pwd': emit('/' + this.cwd); return 0;

      case 'cd': {
        const target = this.resolve(args[0] || '');
        const entries = await ws.list();
        if (target && !entries.some((e) => e.type === 'dir' && e.path === target)) { emitErr(`cd: ${args[0] || '/'}: no such directory`); return 1; }
        this.cwd = target;
        return 0;
      }

      case 'ls': {
        const long = args.includes('-l') || args.includes('-la') || args.includes('-al');
        const all = args.includes('-a') || args.includes('-la') || args.includes('-al');
        const pathArg = args.find((a) => !a.startsWith('-'));
        const target = this.resolve(pathArg || '');
        const entries = (await ws.list()).filter((e) => dirname(e.path) === target);
        const shown = entries
          .filter((e) => all || !e.name.startsWith('.'))
          .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
        if (!shown.length) { emit(pathArg ? `(empty: ${pathArg})` : '(empty workspace — try `help`)'); return 0; }
        if (long) {
          emit(shown.map((e) => `${e.type === 'dir' ? 'd' : '-'}rw-r--r--  ${String(formatBytes(e.size || 0)).padStart(9)}  ${e.name}${e.type === 'dir' ? '/' : ''}`).join('\n'));
        } else {
          emit(shown.map((e) => e.name + (e.type === 'dir' ? '/' : '')).join('   '));
        }
        return 0;
      }

      case 'cat': {
        if (!args.length) { emit(stdin); return 0; }
        let code = 0;
        for (const a of args) {
          if (a === '-' || a === '/dev/stdin') { emit(stdin); continue; }
          try { emit(await ws.read(this.resolve(a))); }
          catch { emitErr(`cat: ${a}: no such file`); code = 1; }
        }
        return code;
      }

      case 'head':
      case 'tail': {
        const nIdx = args.indexOf('-n');
        let n = 10;
        const rest = [...args];
        if (nIdx >= 0) { n = parseInt(rest[nIdx + 1], 10) || 10; rest.splice(nIdx, 2); }
        const file = rest.find((a) => !a.startsWith('-'));
        let text = stdin;
        if (file && file !== '-') { try { text = await ws.read(this.resolve(file)); } catch { emitErr(`${cmd}: ${file}: no such file`); return 1; } }
        const lines = splitLines(text);
        emit((cmd === 'head' ? lines.slice(0, n) : lines.slice(Math.max(0, lines.length - n))).join('\n'));
        return 0;
      }

      case 'wc': {
        const mode = args.find((a) => a.startsWith('-')) || '';
        const file = args.find((a) => !a.startsWith('-'));
        let text = stdin;
        if (file && file !== '-') { try { text = await ws.read(this.resolve(file)); } catch { emitErr(`wc: ${file}: no such file`); return 1; } }
        const lines = splitLines(text).length;
        const words = String(text).split(/\s+/).filter(Boolean).length;
        const bytes = new Blob([String(text)]).size;
        emit(mode === '-l' ? String(lines) : mode === '-w' ? String(words) : mode === '-c' ? String(bytes) : `${lines}\t${words}\t${bytes}${file ? '\t' + file : ''}`);
        return 0;
      }

      case 'grep': {
        const flags = args.filter((a) => a.startsWith('-')).join('');
        const positional = args.filter((a) => !a.startsWith('-'));
        if (!positional.length) { emitErr('grep: need a pattern'); return 2; }
        const pattern = positional[0];
        const files = positional.slice(1);
        const re = new RegExp(pattern, flags.includes('i') ? 'gi' : 'g');
        const sources = [];
        if (!files.length || files.includes('-')) sources.push({ name: '', text: stdin });
        const entries = await ws.list();
        const isDir = (target) => target === '' || entries.some((e) => e.type === 'dir' && e.path === target);
        const wanted = files.filter((x) => x !== '-');
        const targets = [];
        if (!wanted.length) {
          // no file arguments: search the whole current directory recursively
          targets.push(...entries.filter((e) => e.type === 'file' && isTextPath(e.path) &&
            (this.cwd === '' || e.path.startsWith(this.cwd + '/'))).map((e) => e.path));
        }
        for (const f of wanted) {
          const target = this.resolve(f);
          if (isDir(target)) {
            targets.push(...entries.filter((e) => e.type === 'file' && isTextPath(e.path) &&
              (target === '' || e.path.startsWith(target + '/'))).map((e) => e.path));
          } else targets.push(target);
        }
        for (const t of [...new Set(targets)]) {
          try { sources.push({ name: t, text: await ws.read(t) }); } catch { /* skip unreadable */ }
        }
        let hits = 0;
        for (const src of sources) {
          splitLines(src.text).forEach((line, i) => {
            re.lastIndex = 0;
            if (re.test(line)) {
              hits++;
              const prefix = flags.includes('n') ? `${src.name}:${i + 1}:` : (src.name ? `${src.name}:` : '');
              emit(prefix + line);
            }
          });
        }
        if (!hits) return 1;
        return 0;
      }

      case 'find': {
        const nameIdx = args.indexOf('-name');
        const glob = nameIdx >= 0 ? args[nameIdx + 1] : null;
        const pathArg = args.find((a) => !a.startsWith('-') && (nameIdx < 0 || args.indexOf(a) !== nameIdx + 1));
        const base = this.resolve(pathArg || '');
        const re = glob ? globToRegExp(glob) : null;
        const entries = (await ws.list()).filter((e) => !base || e.path.startsWith(base));
        const shown = entries.filter((e) => !re || re.test(e.name) || re.test(e.path));
        emit(shown.length ? shown.map((e) => (e.type === 'dir' ? e.path + '/' : e.path)).join('\n') : '(no matches)');
        return 0;
      }

      case 'tree': {
        const base = this.resolve(args[0] || '');
        const entries = await ws.list();
        const lines = [base ? base + '/' : './'];
        const relevant = entries.filter((e) => !base || e.path === base || e.path.startsWith(base + '/'));
        relevant.sort((a, b) => a.path.localeCompare(b.path)).slice(0, 300).forEach((e) => {
          const depth = e.path.split('/').length - (base ? base.split('/').length : 0);
          lines.push(`${'  '.repeat(Math.max(0, depth))}${e.type === 'dir' ? '├─ ' : '├─ '}${e.name}${e.type === 'dir' ? '/' : ''}`);
        });
        emit(lines.join('\n'));
        return 0;
      }

      case 'du': {
        const base = this.resolve(args[0] || '');
        const entries = (await ws.list()).filter((e) => e.type === 'file' && (!base || e.path.startsWith(base)));
        const total = entries.reduce((a, e) => a + (e.size || 0), 0);
        emit(`${formatBytes(total)}\t${entries.length} files\t${base ? '/' + base : '/'}`);
        return 0;
      }

      case 'mkdir': {
        for (const a of args.filter((x) => !x.startsWith('-'))) await ws.mkdir(this.resolve(a));
        emit(`created ${args.filter((x) => !x.startsWith('-')).join(', ')}`);
        return 0;
      }

      case 'touch': {
        for (const a of args) {
          const p = this.resolve(a);
          if (!(await ws.exists(p))) await ws.write(p, '');
        }
        return 0;
      }

      case 'rm': {
        const recursive = args.some((a) => /^-r|-rf|-fr/.test(a));
        const paths = args.filter((a) => !a.startsWith('-'));
        for (const p of paths) {
          const target = this.resolve(p);
          const st = await ws.stat(target);
          if (!st) { emitErr(`rm: ${p}: no such file`); continue; }
          if (st.type === 'dir' && !recursive) { emitErr(`rm: ${p}: is a directory (use -r)`); return 1; }
          await ws.remove(target);
        }
        emit(`removed ${paths.join(', ')}`);
        return 0;
      }

      case 'cp': {
        if (args.length < 2) { emitErr('cp: need <src> <dst>'); return 1; }
        const src = this.resolve(args[0]); const dst = this.resolve(args[1]);
        const blob = await ws.readBlob(src);
        await ws.write(dst, blob);
        emit(`${args[0]} → ${args[1]}`);
        return 0;
      }

      case 'mv': {
        if (args.length < 2) { emitErr('mv: need <src> <dst>'); return 1; }
        await ws.rename(this.resolve(args[0]), this.resolve(args[1]));
        emit(`${args[0]} → ${args[1]}`);
        return 0;
      }

      case 'echo': {
        emit(args.join(' ').replace(/\\n/g, '\n').replace(/\\t/g, '\t'));
        return 0;
      }

      case 'python':
      case 'py':
      case 'node':
      case 'js': {
        const lang = (cmd === 'python' || cmd === 'py') ? 'python' : 'javascript';
        if (!this.external[lang]) { emitErr(`${lang} runtime is not available`); return 1; }
        const res = await this.external[lang](args, stdin, { cwd: this.cwd, shell: this });
        if (res.output) emit(res.output);
        if (res.error) { emitErr(String(res.error).split('\n').slice(-6).join('\n')); return res.exitCode ?? 1; }
        return res.exitCode ?? 0;
      }

      case 'export': {
        const [k, ...v] = (args[0] || '').split('=');
        if (k) this.env[k] = v.join('=');
        return 0;
      }
      case 'env': emit(Object.entries(this.env).map(([k, v]) => `${k}=${v}`).join('\n')); return 0;
      case 'which': emit(SHELL_COMMANDS.includes(args[0]) ? `/bin/${args[0]}` : `${args[0]} not found`); return SHELL_COMMANDS.includes(args[0]) ? 0 : 1;

      default: {
        if (cmd.endsWith('.sh') || cmd.endsWith('.py') || cmd.endsWith('.js')) {
          return this.dispatch(cmd.endsWith('.py') ? 'python' : 'node', [cmd, ...args], ctx);
        }
        emitErr(`${cmd}: command not found (try \`help\`)`);
        return 127;
      }
    }
  }
}

/* ── parsing helpers ────────────────────────────────────── */
/** Split into lines the way coreutils sees them (a trailing newline is not an extra empty line). */
function splitLines(text) {
  const lines = String(text ?? '').split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

export function tokenize(line) {
  const tokens = [];
  let cur = '';
  let quote = null;
  let has = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) { quote = null; }
      else if (ch === '\\' && quote === '"') { cur += line[++i] ?? ''; }
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; has = true; continue; }
    if (ch === '\\' ) { cur += line[++i] ?? ''; has = true; continue; }
    if (/\s/.test(ch)) { if (has || cur) tokens.push(cur); cur = ''; has = false; continue; }
    cur += ch; has = true;
  }
  if (has || cur) tokens.push(cur);
  return tokens;
}

function splitStatements(line) {
  const statements = [];
  let buf = '';
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) { buf += ch; if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; buf += ch; continue; }
    if (ch === ';' ) { statements.push({ text: buf, op: ';' }); buf = ''; continue; }
    if (ch === '&' && line[i + 1] === '&') { statements.push({ text: buf, op: '&&' }); buf = ''; i++; continue; }
    if (ch === '|' && line[i + 1] === '|') { statements.push({ text: buf, op: '||' }); buf = ''; i++; continue; }
    if (ch === '\n') { statements.push({ text: buf, op: ';' }); buf = ''; continue; }
    buf += ch;
  }
  if (buf.trim()) statements.push({ text: buf, op: ';' });
  return statements
    .filter((s) => s.text.trim())
    .map((s) => parsePipeline(s.text));
}

function parsePipeline(text) {
  // split on single '|' that is not part of '||'
  const parts = [];
  let buf = '';
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) { buf += ch; if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; buf += ch; continue; }
    if (ch === '|' && text[i + 1] !== '|') { parts.push(buf); buf = ''; continue; }
    buf += ch;
  }
  parts.push(buf);

  const segments = parts.map((p) => {
    const redirect = { mode: null, file: null };
    let clean = p.replace(/(>>|>)\s*([^\s'"|&;]+)/g, (_, mode, file) => { redirect.mode = mode; redirect.file = file.replace(/['"]/g, ''); return ''; });
    return tokenize(clean.trim());
  }).filter((t) => t.length);

  return { segments, redirect: segments.length ? extractRedirect(parts[parts.length - 1]) : null };
}

function extractRedirect(lastPart) {
  const m = String(lastPart).match(/(>>|>)\s*([^\s'"|&;]+)/);
  return m ? { mode: m[1], file: m[2].replace(/['"]/g, '') } : null;
}

export function globToRegExp(glob) {
  const escaped = String(glob).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}
