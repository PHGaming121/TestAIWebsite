/**
 * Headless smoke test for the Puter Playground core logic.
 * Runs the real ES modules inside jsdom: workspace, shell, tools, agent, markdown.
 */
import { JSDOM } from 'jsdom';
import fs from 'fs';
import path from 'node:path';
const REPO_ROOT = path.resolve(import.meta.dirname, '..');

const dom = new JSDOM('<!doctype html><html><body><div id="toast-root"></div><div id="modal-root"></div></body></html>', {
  url: 'https://phgaming121.github.io/TestAIWebsite/',
  pretendToBeVisual: true,
});
const w = dom.window;
global.window = w;
global.document = w.document;
Object.defineProperty(globalThis, 'navigator', { value: w.navigator, configurable: true });
global.localStorage = w.localStorage;
global.sessionStorage = w.sessionStorage;
global.location = w.location;
global.HTMLElement = w.HTMLElement;
global.Element = w.Element;
global.Node = w.Node;
global.Event = w.Event;
global.CustomEvent = w.CustomEvent;
global.FileReader = w.FileReader;
global.CSS = w.CSS;
global.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0);
global.cancelAnimationFrame = (id) => clearTimeout(id);
global.indexedDB = undefined;

// load the vendored library bundle (marked / DOMPurify / hljs / JSZip)
await import('/tmp/bundle/vendor.bundle.js');

const ROOT = `${REPO_ROOT}/js`;
const { createWorkspace, workspace, setWorkspace } = await import(`${ROOT}/workspace.js`);
const { Shell, tokenize } = await import(`${ROOT}/shell.js`);
const { runShell } = await import(`${ROOT}/exec.js`);
const { ALL_TOOLS, TOOL_MAP, nativeToolSchemas, toolsDoc } = await import(`${ROOT}/tools.js`);
const { parseToolBlocks, toProviderMessages, agentSystemPrompt, chatSystemPrompt, toolResultsMessage } = await import(`${ROOT}/agent.js`);
const { renderMarkdownInto, mdToHtml } = await import(`${ROOT}/markdown.js`);
const { guessProvider, explainAiError } = await import(`${ROOT}/llm.js`);
const util = await import(`${ROOT}/util.js`);

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
};
const section = (s) => console.log(`\n── ${s}`);

/* ══════ util ══════ */
section('util');
ok('normPath collapses dots', util.normPath('a/./b/../c') === 'a/c', util.normPath('a/./b/../c'));
ok('joinPath', util.joinPath('src', '/app.js') === 'src/app.js');
ok('dirname/basename', util.dirname('a/b/c.js') === 'a/b' && util.basename('a/b/c.js') === 'c.js');
ok('isTextPath js', util.isTextPath('x/app.js') === true);
ok('isTextPath png', util.isTextPath('x/a.png') === false);
ok('hljsLang tsx', util.hljsLang('a.tsx') === 'typescript');
ok('truncate', util.truncate('x'.repeat(50), 20).length < 50);
ok('safeJsonParse fenced', JSON.stringify(util.safeJsonParse('```json\n{"a":1}\n```')) === '{"a":1}');
ok('safeJsonParse trailing comma', util.safeJsonParse('{"a":1,}')?.a === 1);
ok('estimateTokens', util.estimateTokens('abcd') === 1);

/* ══════ memory workspace ══════ */
section('workspace (memory)');
const ws = await createWorkspace('memory');
setWorkspace(ws);
await ws.write('index.html', '<h1>hi</h1>');
await ws.write('src/app.js', 'console.log(1)');
await ws.write('src/lib/util.js', 'export const a=1');
await ws.write('assets/logo.svg', '<svg/>');
ok('read back', (await ws.read('index.html')) === '<h1>hi</h1>');
const _l = await ws.list(); ok('list count', _l.filter(e=>e.type==='file').length === 4 && _l.some(e=>e.type==='dir'&&e.path==='src'), JSON.stringify(_l.map(e=>e.path)));
ok('exists', await ws.exists('src/app.js'));
ok('stats', (await ws.stats()).files === 4);
const tree = await ws.tree();
ok('tree nesting', tree.children.some(c => c.name === 'src' && c.children.length === 2));
ok('treeText lists files', (await ws.treeText()).includes('src/lib/util.js'));
await ws.rename('src/app.js', 'src/main.js');
ok('rename', await ws.exists('src/main.js') && !(await ws.exists('src/app.js')));
await ws.mkdir('docs');
ok('mkdir', (await ws.list()).some(e => e.path === 'docs' && e.type === 'dir'));
await ws.remove('docs');
ok('remove dir', !(await ws.list()).some(e => e.path === 'docs'));
const blob = await ws.readBlob('assets/logo.svg');
ok('readBlob', !!blob && blob.size > 0);
try {
  const zip = await ws.exportZip();
  ok('exportZip', !!zip && zip.size > 100, `size=${zip?.size}`);
} catch (e) { ok('exportZip', false, e.message); }
await ws.clear();
ok('clear', (await ws.list()).length === 0);

/* ══════ shell ══════ */
section('shell');
await ws.write('a.txt', 'alpha\nbeta\ngamma\n');
await ws.write('dir/b.txt', 'beta only\n');
await ws.write('app.py', 'print("hello")\n');
let r = await runShell('ls', ws);
ok('ls', r.output.includes('a.txt') && r.output.includes('dir/'), r.output);
r = await runShell('ls -l', ws);
ok('ls -l shows sizes', /\d/.test(r.output) && r.output.includes('a.txt'));
r = await runShell('cat a.txt', ws);
ok('cat', r.output.includes('alpha'));
r = await runShell('head -n 2 a.txt', ws);
ok('head -n 2', r.output.split('\n').filter(Boolean).length === 2, r.output);
r = await runShell('tail -n 1 a.txt', ws);
ok('tail -n 1', r.output.trim() === 'gamma', r.output);
r = await runShell('wc -l a.txt', ws);
ok('wc -l', r.output.trim().startsWith('3'), r.output);
r = await runShell('grep beta .', ws);
ok('grep recursive', r.output.includes('a.txt') && r.output.includes('dir/b.txt'), r.output);
r = await runShell('cat a.txt | grep -n gamma', ws);
ok('pipe grep -n', /:3:gamma|3:gamma/.test(r.output), r.output);
r = await runShell('echo "hello world" > c.txt', ws);
ok('redirect >', (await ws.read('c.txt')).trim() === 'hello world');
r = await runShell('echo "second" >> c.txt', ws);
ok('redirect >>', (await ws.read('c.txt')).includes('second') && (await ws.read('c.txt')).includes('hello world'));
r = await runShell('find . -name "*.txt"', ws);
ok('find -name glob', r.output.includes('a.txt') && r.output.includes('c.txt'), r.output);
r = await runShell('mkdir -p x/y/z && ls x/y', ws);
ok('mkdir -p && ls', r.exitCode === 0 && r.output.includes('z'), r.output);
r = await runShell('cp a.txt copy.txt && ls', ws);
ok('cp &&', await ws.exists('copy.txt'));
r = await runShell('mv copy.txt moved.txt', ws);
ok('mv', await ws.exists('moved.txt') && !(await ws.exists('copy.txt')));
r = await runShell('rm moved.txt', ws);
ok('rm', !(await ws.exists('moved.txt')));
r = await runShell('tree', ws);
ok('tree cmd', r.output.includes('a.txt'));
r = await runShell('du', ws);
ok('du', /files/.test(r.output), r.output);
r = await runShell('cd dir; pwd; ls', ws);
ok('cd; pwd; ls', r.output.includes('/dir') && r.output.includes('b.txt'), r.output);
r = await runShell('cd ..', ws);
ok('cd ..', r.exitCode === 0);
r = await runShell('nonexistentcmd', ws);
ok('unknown command → 127', r.exitCode === 127 && /command not found/.test(r.output));
r = await runShell('help', ws);
ok('help', r.output.includes('grep') && r.exitCode === 0);
r = await runShell('cat missing.txt', ws);
ok('missing file → exit 1', r.exitCode === 1);
r = await runShell('echo a && echo b || echo c', ws);
ok('&& / || chain', r.output.includes('a') && r.output.includes('b'), r.output);
ok('tokenize quotes', JSON.stringify(tokenize(`echo "hello world" 'x y'`)) === '["echo","hello world","x y"]');

/* ══════ tools ══════ */
section('tools');
ok('tool count', ALL_TOOLS.length >= 24, String(ALL_TOOLS.length));
ok('all tools have valid schema', ALL_TOTools => true);
let schemaOk = true;
for (const t of ALL_TOOLS) {
  if (t.schema.type !== 'function' || !t.schema.function.name || !t.schema.function.parameters) { schemaOk = false; console.log('   bad schema', t.name); }
  if (t.schema.function.name !== t.name) { schemaOk = false; }
  for (const req of t.schema.function.parameters.required || []) {
    if (!(req in (t.schema.function.parameters.properties || {}))) { schemaOk = false; console.log('   required not in properties:', t.name, req); }
  }
}
ok('schemas valid & self-consistent', schemaOk);
ok('native schemas serialize', JSON.stringify(nativeToolSchemas()).length > 1000);
ok('toolsDoc mentions write_file', toolsDoc().includes('write_file'));
ok('JSON round-trip of schemas', JSON.parse(JSON.stringify(nativeToolSchemas())).length === ALL_TOOLS.length);

const ctx = { ws, settings: { maxToolOutputChars: 14000, maxFileCharsForModel: 24000, execTimeoutMs: 5000, pyodideVersion: '' }, onOutput: () => {}, onProgress: () => {}, touch: () => {} };
const call = async (name, args) => await TOOL_MAP.get(name).run(ctx, args);

ok('list_files', (await call('list_files', {})).includes('a.txt'));
ok('write_file creates', (await call('write_file', { path: 'new/thing.txt', content: 'hello' })).startsWith('Created'));
ok('read_file', (await call('read_file', { path: 'new/thing.txt' })).includes('hello'));
ok('read_file missing → helpful error', (await call('read_file', { path: 'nope.txt' })).includes('ERROR'));
ok('edit_file', (await call('edit_file', { path: 'new/thing.txt', old_string: 'hello', new_string: 'bye' })).includes('Edited'));
ok('edit_file applied', (await ws.read('new/thing.txt')) === 'bye');
ok('edit_file no-match error', (await call('edit_file', { path: 'new/thing.txt', old_string: 'zzz', new_string: 'q' })).includes('not found'));
ok('search_files', (await call('search_files', { pattern: 'bye' })).includes('new/thing.txt'));
ok('make_directory', (await call('make_directory', { path: 'empty/dir' })).includes('Created'));
ok('rename_file', (await call('rename_file', { from: 'new/thing.txt', to: 'new/other.txt' })).includes('Renamed'));
ok('delete_file', (await call('delete_file', { path: 'new/other.txt' })).includes('Deleted'));
ok('github_status without token', (await call('github_status', {})).includes('NOT connected'));
const sh2 = await call('run_shell', { command: 'ls' });
ok('run_shell tool', sh2.startsWith('$ ls') && sh2.includes('[exit 0]'), sh2.slice(0, 120));

/* ══════ agent protocol ══════ */
section('agent protocol');
const parsed = parseToolBlocks('Here you go:\n```tool\n{"name":"write_file","args":{"path":"a.txt","content":"x"}}\n```\nDone.');
ok('parse single tool block', parsed.calls.length === 1 && parsed.calls[0].name === 'write_file', JSON.stringify(parsed.calls));
ok('parse strips block from text', !parsed.text.includes('```tool') && parsed.text.includes('Here you go'));
const parsedArr = parseToolBlocks('```tool\n[{"name":"read_file","args":{"path":"a.txt"}},{"name":"list_files","args":{}}]\n```');
ok('parse array of calls', parsedArr.calls.length === 2);
ok('ignores plain json blocks', parseToolBlocks('```json\n{"a":1}\n```').calls.length === 0);
ok('ignores prose', parseToolBlocks('no tools here').calls.length === 0);

const conv = {
  mode: 'agent', model: 'test-model',
  messages: [
    { id: '1', role: 'user', content: 'build it' },
    { id: '2', role: 'assistant', content: 'sure', toolCalls: [{ id: 'c1', name: 'write_file', args: { path: 'a' }, result: 'Created a', status: 'ok' }] },
    { id: '3', role: 'user', content: 'thanks' },
  ],
};
const native = toProviderMessages(conv, { protocol: 'native' });
ok('native replay has tool_calls', native.some(m => m.role === 'assistant' && m.tool_calls?.length === 1));
ok('native replay has tool result', native.some(m => m.role === 'tool' && m.tool_call_id === 'c1'));
const textMode = toProviderMessages(conv, { protocol: 'text' });
ok('text replay has ```tool block', textMode.some(m => m.role === 'assistant' && String(m.content).includes('```tool')));
ok('text replay feeds results as user', textMode.some(m => m.role === 'user' && String(m.content).includes('Tool results')));
ok('toolResultsMessage flags errors', toolResultsMessage([{ name: 'x', status: 'error', result: 'boom' }]).includes('ERROR'));

const sys = agentSystemPrompt({ maxSteps: 30 }, {
  workspaceDescription: 'memory backend', workspaceTree: 'a.txt', githubConnected: true,
  githubLogin: 'me', githubRepo: 'me/x', date: 'today', protocol: 'native',
});
ok('agent system prompt mentions tools', sys.includes('write_file') && sys.includes('github_push') && sys.includes('finish'));
ok('agent system prompt mentions GitHub state', sys.includes('CONNECTED as me'));
ok('chat prompt is short-ish', chatSystemPrompt({}).length > 50 && chatSystemPrompt({}).length < 2000);

/* ══════ markdown ══════ */
section('markdown');
const html = mdToHtml('# Title\n\n```js\nconst a = 1;\n```\n\n- one\n- two\n\n<script>alert(1)</script>');
ok('renders heading', html.includes('<h1>Title</h1>'));
ok('renders code fence', html.includes('<code'));
ok('sanitises script tags', !html.includes('<script>'), html.slice(0, 200));
const node = w.document.createElement('div');
renderMarkdownInto(node, '```python\nprint(1)\n```');
ok('code block gets wrapper + copy button', node.querySelector('.code-wrap') && node.querySelector('.code-head button'));
ok('hljs highlighted python', node.querySelector('code')?.innerHTML.includes('hljs'));
const node2 = w.document.createElement('div');
renderMarkdownInto(node2, 'plain **bold** text');
ok('inline markdown', node2.innerHTML.includes('<strong>bold</strong>'));

/* ══════ models ══════ */
section('model helpers');
ok('guessProvider claude', guessProvider('claude-sonnet-4-5') === 'anthropic');
ok('guessProvider prefixed', guessProvider('google/gemini-3.1-pro') === 'google');
ok('guessProvider gpt', guessProvider('gpt-5.4-nano') === 'openai');
ok('guessProvider deepseek', guessProvider('deepseek-reasoner') === 'deepseek');

/* ══════ friendly AI errors ══════ */
section('explainAiError');
const creditMsg = explainAiError(new Error('insufficient credits: your balance is too low'), { model: 'claude-sonnet-4-5' });
ok('credit exhaustion explains the allowance', /allowance/i.test(creditMsg) && /puter\.com/.test(creditMsg), creditMsg);
ok('credit message offers a lighter model', /lighter model/i.test(creditMsg));
const signInMsg = explainAiError(new Error('401 Unauthorized: user must sign in'), { model: 'gpt-5.4' });
ok('auth error points at the free sign-in', /sign in/i.test(signInMsg) && /free/.test(signInMsg), signInMsg);
const rateMsg = explainAiError(new Error('429 Too Many Requests'));
ok('rate limit is explained', /rate-limited|busy/i.test(rateMsg), rateMsg);
const modelMsg = explainAiError(new Error('model not found: foo/bar-9'), { model: 'foo/bar-9' });
ok('unknown model suggests the picker', /model picker|Ctrl/i.test(modelMsg), modelMsg);
ok('unrelated errors are left alone', explainAiError(new Error('socket hang up')) === null);
ok('non-Error values are handled', typeof explainAiError({ message: 'quota exceeded' }) === 'string');

console.log(`\n═══ ${pass} passed, ${fail} failed ═══`);
process.exit(fail ? 1 : 0);
