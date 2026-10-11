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
await import(`${REPO_ROOT}/assets/vendor/vendor.bundle.js`);

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

/* ══════ media generation ══════ */
const mediaCalls = { img: [], vid: [] };
const PNG_URI = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
w.puter = {
  ai: {
    async chat() { return {}; },
    async txt2img(prompt, options) { mediaCalls.img.push({ prompt, options }); const i = w.document.createElement('img'); i.src = PNG_URI; return i; },
    async txt2vid(options) { mediaCalls.vid.push(options); const v = w.document.createElement('video'); v.src = 'data:video/mp4;base64,AAAAHGZ0eXBpc29t'; return v; },
  },
};
const M = await import(`${ROOT}/media.js`);

section('media: result normalisation');
ok('extForMime images', M.extForMime('image/png') === 'png' && M.extForMime('image/webp') === 'webp');
ok('extForMime video', M.extForMime('video/mp4') === 'mp4' && M.extForMime('video/webm') === 'webm');
ok('extForMime falls back', M.extForMime('', 'png') === 'png' && M.extForMime('application/zip', 'bin') === 'bin');
const blobCase = await M.toMediaBlob(new w.Blob(['hello'], { type: 'image/png' }));
ok('accepts a Blob', blobCase.blob.size === 5 && blobCase.mime === 'image/png');
const dataCase = await M.toMediaBlob(PNG_URI);
ok('accepts a data URI', dataCase.blob.size > 20 && dataCase.mime === 'image/png', String(dataCase.blob.size));
const objCase = await M.toMediaBlob({ src: 'data:text/plain;base64,aGk=' });
ok('digs a src out of an object', (await objCase.blob.text()) === 'hi');
const elCase = await M.toMediaBlob((() => { const i = w.document.createElement('img'); i.src = PNG_URI; return i; })());
ok('accepts an HTMLImageElement (what txt2img really returns)', elCase.blob.size > 20 && elCase.mime === 'image/png');
const vidElCase = await M.toMediaBlob((() => { const v = w.document.createElement('video'); v.src = 'data:video/mp4;base64,AAAAHGZ0eXBpc29t'; return v; })());
ok('accepts an HTMLVideoElement (what txt2vid really returns)', vidElCase.mime === 'video/mp4');
const resCase = await M.toMediaBlob({ status: 200, ok: true, blob: async () => new w.Blob(['vid'], { type: 'video/webm' }) });
ok('accepts a Response-like', resCase.mime === 'video/webm');
let threw = false;
try { await M.toMediaBlob(null); } catch { threw = true; }
ok('rejects an empty result', threw);

section('media: generateImage');
threw = false;
try { await M.generateImage({ prompt: '   ' }); } catch { threw = true; }
ok('requires a prompt', threw);
const img1 = await M.generateImage({
  prompt: 'a red cube', model: 'gpt-image-2', provider: 'openai', quality: 'high',
  aspectRatio: '16:9', negativePrompt: 'blur', seed: 7, steps: 20,
});
const io = mediaCalls.img.at(-1).options;
ok('maps model/provider/quality', io.model === 'gpt-image-2' && io.provider === 'openai' && io.quality === 'high');
ok('maps aspect ratio to both spellings', io.aspect_ratio === '16:9' && io.ratio?.w === 16 && io.ratio?.h === 9, JSON.stringify(io.ratio));
ok('maps negative prompt / seed / steps', io.negative_prompt === 'blur' && io.seed === 7 && io.steps === 20);
ok('always sends the prompt in the options too', io.prompt === 'a red cube');
ok('returns bytes + an object URL for display', img1.blob.size > 20 && img1.ext === 'png' && (img1.url === '' || img1.url.startsWith('blob:')), img1.url);
ok('no eager base64 of the media (keeps context and memory small)', img1.dataUrl === undefined);
ok('no test_mode unless asked', io.test_mode === undefined);
await M.generateImage({ prompt: 'x', testMode: true });
ok('test mode is passed through (credit-free sample)', mediaCalls.img.at(-1).options.test_mode === true);
await M.generateImage({ prompt: 'x', referenceImage: PNG_URI, strength: 0.6 });
const refOpts = mediaCalls.img.at(-1).options;
ok('image-to-image reference is mapped', refOpts.input_image === PNG_URI && refOpts.input_image_mime_type === 'image/png' && refOpts.strength === 0.6);

section('media: generateVideo');
await M.generateVideo({ prompt: 'dunes at dawn', seconds: 5, size: '720p', generateAudio: true, fps: 24, negativePrompt: 'text' });
const vo = mediaCalls.vid.at(-1);
ok('video prompt + duration + size', vo.prompt === 'dunes at dawn' && vo.seconds === 5 && vo.size === '720p');
ok('video audio / fps / negative prompt', vo.generate_audio === true && vo.fps === 24 && vo.negative_prompt === 'text');
ok('no model means the driver default', vo.model === undefined);
await M.generateVideo({ prompt: 'x', model: 'seedance-2-5', firstFrame: PNG_URI, lastFrame: PNG_URI, referenceImages: [PNG_URI], testMode: true });
const vo2 = mediaCalls.vid.at(-1);
ok('image-to-video frames mapped', vo2.input_reference === PNG_URI && vo2.last_frame === PNG_URI && vo2.reference_images?.length === 1);
ok('video model + test mode', vo2.model === 'seedance-2-5' && vo2.test_mode === true);
const noVid = w.puter.ai.txt2vid;
delete w.puter.ai.txt2vid;
threw = false;
try { await M.generateVideo({ prompt: 'x' }); } catch (e) { threw = /txt2vid/.test(e.message); }
w.puter.ai.txt2vid = noVid;
ok('clear error when the driver is missing', threw);

/* ══════ long-term memory ══════ */
const MEM = await import(`${ROOT}/memory.js`);
w.puter.kv = {
  _s: new Map(),
  async set(k, v) { this._s.set(k, v); return true; },
  async get(k) { return this._s.get(k) ?? null; },
  async del(k) { this._s.delete(k); },
};
MEM.clearMemories();

section('memory: storage');
const m1 = MEM.addMemory({ text: 'The user prefers plain JavaScript over TypeScript.', kind: 'preference', tags: ['js', 'style'] });
ok('adds a memory with an id and kind', m1.entry.id && m1.entry.kind === 'preference' && m1.deduped === false);
ok('tags are normalised', m1.entry.tags.join(',') === 'js,style');
const m2 = MEM.addMemory({ text: 'The user prefers plain JavaScript over TypeScript!', kind: 'note' });
ok('near-duplicate text updates instead of piling up', m2.deduped === true && MEM.memories().length === 1);
MEM.addMemory({ text: 'Their main project is TestAIWebsite, a static Puter playground.', kind: 'project', tags: ['repo'] });
MEM.addMemory({ text: 'Deploys go to GitHub Pages, never to a paid host.', kind: 'decision' });
MEM.addMemory({ text: 'The user lives in São Paulo and works in America/Sao_Paulo.', kind: 'fact' });
ok('persists to localStorage', JSON.parse(w.localStorage.getItem('pp.memory.v1')).length === 4);
ok('stats count by kind', MEM.memoryStats().count === 4 && MEM.memoryStats().byKind.find((k) => k.id === 'project').n === 1);
let thrown = false;
try { MEM.addMemory({ text: '   ' }); } catch { thrown = true; }
ok('rejects an empty memory', thrown);
thrown = false;
try { MEM.addMemory({ text: 'x'.repeat(5000) }); } catch { thrown = true; }
ok('rejects an absurdly long memory', thrown);
const unknownKind = MEM.addMemory({ text: 'Something with a bogus kind.', kind: 'nonsense' });
ok('unknown kinds fall back to note', unknownKind.entry.kind === 'note');
MEM.removeMemory(unknownKind.entry.id);

section('memory: retrieval');
const byPhrase = MEM.searchMemory('javascript typescript');
ok('ranks the matching preference first', byPhrase[0]?.text.includes('JavaScript'), byPhrase[0]?.text);
const byTag = MEM.searchMemory('repo');
ok('finds by tag', byTag.some((m) => m.tags?.includes('repo')));
const byProject = MEM.searchMemory('what am i building');
ok('unrelated queries do not match everything', MEM.searchMemory('quantum chromodynamics').length === 0);
ok('project memory is retrievable', MEM.searchMemory('TestAIWebsite playground')[0]?.kind === 'project');
const pinned = MEM.memories().find((m) => m.kind === 'fact');
MEM.updateMemory(pinned.id, { pinned: true });
ok('pinning works', MEM.memories().find((m) => m.id === pinned.id).pinned === true);
ok('pinned memories surface with an empty query', MEM.searchMemory('', { limit: 3 }).some((m) => m.pinned));
MEM.updateMemory(pinned.id, { text: 'The user lives in São Paulo, Brazil (America/Sao_Paulo).' });
ok('editing keeps the id and bumps updatedAt', MEM.memories().find((m) => m.id === pinned.id).text.includes('Brazil'));
ok('removeMemory reports misses', MEM.removeMemory('mem_nope') === false);
MEM.markUsed([pinned.id]);
ok('markUsed counts hits', MEM.memories().find((m) => m.id === pinned.id).hits === 1);

section('memory: prompt injection');
const block = MEM.memoryPromptBlock('do you remember my language preference?');
ok('block has a header', block.startsWith('## Long-term memory'), block.slice(0, 60));
ok('block contains the relevant memory', /JavaScript/.test(block));
ok('block tells the model not to invent memories', /Never invent memories/.test(block));
ok('pinned memory is always included', /São Paulo/.test(MEM.memoryPromptBlock('something totally unrelated')));
ok('respects the character budget', MEM.memoryPromptBlock('javascript', { budgetChars: 60 }).length < 400);
ok('empty store injects nothing', (() => { MEM.clearMemories(); const b = MEM.memoryPromptBlock('anything'); MEM.mergeMemories([{ text: 'x' }]); MEM.clearMemories(); return b === ''; })());
MEM.clearMemories();
MEM.addMemory({ text: 'The user prefers plain JavaScript over TypeScript.', kind: 'preference' });
MEM.addMemory({ text: 'Their main project is TestAIWebsite.', kind: 'project' });

section('memory: cloud mirror + merge');
const pushed = await MEM.pushMemoriesToCloud();
ok('push reports the count', pushed === 2);
MEM.clearMemories();
const pulled = await MEM.pullMemoriesFromCloud();
ok('pull restores what was pushed', pulled.added === 2 && MEM.memories().length === 2);
const merged = MEM.mergeMemories([
  { text: 'The user prefers plain JavaScript over TypeScript.', updatedAt: 1 },          // older dupe → ignored
  { text: 'Their main project is TestAIWebsite.', updatedAt: Date.now() + 5000, tags: ['repo'] }, // newer → updated
  { text: 'The user answers in British English.', kind: 'preference' },                  // new
]);
ok('merge adds new entries', merged.added === 1);
ok('merge updates newer copies', merged.updated === 1);
ok('merge ignores stale duplicates', MEM.memories().length === 3);
ok('merged tags are unioned', MEM.memories().find((m) => m.text.includes('TestAIWebsite')).tags.includes('repo'));

section('memory: distillation');
const cands = MEM.parseCandidates('[{"text":"The user likes dark themes.","kind":"preference","tags":["ui"]}]');
ok('parses a bare JSON array', cands.length === 1 && cands[0].kind === 'preference' && cands[0].tags[0] === 'ui');
ok('parses a fenced array', MEM.parseCandidates('Sure!\n```json\n[{"text":"A fact worth keeping."}]\n```').length === 1);
ok('parses an array wrapped in prose', MEM.parseCandidates('Here you go: [{"text":"Prose wrapped."}] hope that helps').length === 1);
ok('rejects garbage', MEM.parseCandidates('not json at all').length === 0 && MEM.parseCandidates('').length === 0);
ok('drops entries that are already stored', MEM.parseCandidates('[{"text":"The user prefers plain JavaScript over TypeScript."}]').length === 0);
ok('drops malformed items', MEM.parseCandidates('[{"kind":"note"},null,{"text":"ok one"}]').length === 1);
ok('clamps runaway output', MEM.parseCandidates(JSON.stringify(Array.from({ length: 60 }, (_, i) => ({ text: `fact ${i}` })))).length === 25);
thrown = false;
try { await MEM.distillConversation({ messages: [] }, { complete: async () => '[]' }); } catch { thrown = true; }
ok('refuses to distil an empty conversation', thrown);
thrown = false;
try { await MEM.distillConversation({ messages: [{ role: 'user', content: 'hi' }] }, {}); } catch { thrown = true; }
ok('needs a completion function', thrown);
const calls = [];
const distilled = await MEM.distillConversation(
  { messages: [{ role: 'user', content: 'I always ship to GitHub Pages.' }, { role: 'assistant', content: 'Noted.' }, { role: 'tool', content: 'ignored' }] },
  { complete: async (msgs, opts) => { calls.push({ msgs, opts }); return '[{"text":"The user ships to GitHub Pages.","kind":"decision","tags":["deploy"]}]'; }, model: 'gpt-5.4-nano' },
);
ok('distil returns candidates', distilled.length === 1 && distilled[0].text.includes('GitHub Pages'));
ok('distil sends the transcript, not tool noise', calls[0].msgs[1].content.includes('I always ship') && !calls[0].msgs[1].content.includes('ignored'));
ok('distil asks for a low temperature and the chosen model', calls[0].opts.temperature === 0.1 && calls[0].opts.model === 'gpt-5.4-nano');
ok('distil instructs against storing secrets', /secrets|API keys/i.test(calls[0].msgs[0].content));

section('memory: targeting for destructive ops');
MEM.clearMemories();
const keep = MEM.addMemory({ text: 'The user ships everything to GitHub Pages.', kind: 'decision' }).entry;
MEM.addMemory({ text: 'The user lives in São Paulo.', kind: 'fact', pinned: true });
MEM.addMemory({ text: 'The user prefers tabs over spaces in editor configs.', kind: 'preference' });
ok('bestMatch finds the lexical match', MEM.bestMatch('GitHub Pages deployment').entry.id === keep.id);
ok('a pinned memory does not hijack an unrelated match', MEM.bestMatch('GitHub Pages').entry.text.includes('GitHub Pages'));
ok('bestMatch returns null when nothing matches', MEM.bestMatch('zzz qqq') === null);
const amb = MEM.bestMatch('user');
ok('ambiguous queries are reported, not guessed', !!amb?.ambiguous && amb.ambiguous.length >= 2, String(amb?.ambiguous?.length));
ok('rankedSearch exposes scores', MEM.rankedSearch('GitHub Pages')[0].lex > 0);
ok('stem matching links related words', MEM.bestMatch('shipping the site')?.entry.text.includes('GitHub Pages') === true, JSON.stringify(MEM.bestMatch('shipping the site')));
ok('stem matching links deploy → deployment', (MEM.clearMemories(), MEM.addMemory({ text: 'The user deploys to GitHub Pages only.', kind: 'decision' }), MEM.bestMatch('deployment target')?.entry.text.includes('deploys') === true));



/* ══════ connections & providers ══════ */
const CN = await import(`${ROOT}/connections.js`);
const PR = await import(`${ROOT}/providers.js`);
w.puter.net = {
  fetch: async (url, init) => {
    netLog.push({ url, init, via: 'puter' });
    return new Response(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: 'Answered through the Puter proxy.' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 2 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  },
};
const netLog = [];
let fetchLog = [];
let fetchImpl = null;
globalThis.fetch = async (url, init) => {
  fetchLog.push({ url: String(url), init });
  if (fetchImpl) return await fetchImpl(url, init);
  return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
};

section('providers: registry + config');
ok('Puter is the default first entry', PR.PROVIDERS[0].id === 'puter' && PR.PROVIDERS[0].keyless);
ok('a custom endpoint provider exists', PR.PROVIDERS.some((p) => p.id === 'custom' && p.userBaseUrl));
ok('local providers are marked loopback', PR.providerById('ollama').loopback === true && PR.providerById('lmstudio').loopback === true);
ok('keyless providers need no key', PR.isProviderReady(PR.providerConfig('ollama')) === true && PR.isProviderReady(PR.providerConfig('pollinations')) === true);
ok('key providers are not ready without a key', PR.isProviderReady(PR.providerConfig('openrouter')) === false);
PR.saveProviderConfig('openrouter', { apiKey: 'sk-or-test', model: 'openrouter/free' });
ok('saving a key makes it ready', PR.isProviderReady(PR.providerConfig('openrouter')) === true);
ok('config is persisted', JSON.parse(w.localStorage.getItem('pp.providers.v1')).openrouter.apiKey === 'sk-or-test');
ok('custom provider needs a URL', PR.isProviderReady(PR.providerConfig('custom')) === false);
PR.saveProviderConfig('custom', { baseUrl: 'https://api.test/v1/', apiKey: 'k' });
ok('trailing slashes are trimmed', PR.providerConfig('custom').baseUrl === 'https://api.test/v1');
ok('activeProvider(null settings) means Puter', PR.activeProvider({}) === null && PR.activeProvider({ providerId: 'puter' }) === null);
ok('activeProvider returns the chosen config', PR.activeProvider({ providerId: 'custom' }).baseUrl === 'https://api.test/v1');
PR.saveProviderConfig('openrouter', { apiKey: '' });
ok('an empty key is dropped', PR.providerConfig('openrouter').apiKey === '');
ok('joinUrl avoids double slashes', PR.joinUrl('https://a.b/v1/', '/chat') === 'https://a.b/v1/chat');
ok('loopback detection', PR.isLoopbackUrl('http://localhost:11434/v1') && PR.isLoopbackUrl('http://127.0.0.1:8080') && PR.isLoopbackUrl('http://192.168.1.20:1234/v1') && !PR.isLoopbackUrl('https://api.openai.com/v1'));
ok('401 is explained as a key problem', /API key/.test(PR.explainProviderError('unauthorized', PR.providerConfig('custom'), 401)));
ok('404 is explained as a model/path problem', /model or path/.test(PR.explainProviderError('no such model', PR.providerConfig('custom'), 404)));
ok('429 is explained as rate limit or credit', /rate-limited|credit/.test(PR.explainProviderError('too many requests', PR.providerConfig('custom'), 429)));
ok('500 is explained as their server', /server error/.test(PR.explainProviderError('boom', PR.providerConfig('custom'), 503)));

section('providers: OpenAI-compatible chat');
const cfg = PR.providerConfig('custom');
function sseResponse(lines) {
  const enc = new TextEncoder();
  const body = new ReadableStream({
    start(c) { for (const l of lines) c.enqueue(enc.encode(l)); c.close(); },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}
fetchImpl = async () => sseResponse([
  'data: {"choices":[{"delta":{"role":"assistant","content":"Hello"}}]}\n\n',
  'data: {"choices":[{"delta":{"content":" world","reasoning_content":"(thinking)"}}]}\n\n',
  'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_a","function":{"name":"write_file","arguments":"{\\"path\\""}}]}}]}\n\n',
  'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":\\"a.txt\\",\\"content\\":\\"hi\\"}"}}]}}],"usage":{"prompt_tokens":5,"completion_tokens":9}}\n\n',
  'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
  'data: [DONE]\n\n',
]);
fetchLog = [];
const streamed = await PR.chatViaProvider(cfg, { model: 'test-model', messages: [{ role: 'user', content: 'hi' }], stream: true, tools: [{ type: 'function', function: { name: 'write_file' } }] });
ok('streams text from SSE deltas', streamed.text === 'Hello world', streamed.text);
ok('captures reasoning_content', streamed.reasoning === '(thinking)', streamed.reasoning);
ok('reassembles a tool call split across chunks', streamed.toolCalls.length === 1 && streamed.toolCalls[0].name === 'write_file' && streamed.toolCalls[0].args.path === 'a.txt', JSON.stringify(streamed.toolCalls));
ok('captures usage from the stream', streamed.usage?.completion_tokens === 9);
ok('reports the finish reason', streamed.finishReason === 'tool_calls');
ok('went direct, not through the proxy', streamed.via === 'direct' && streamed.streamed === true);
const sent = JSON.parse(fetchLog[0].init.body);
ok('sends an OpenAI-shaped request', fetchLog[0].url === 'https://api.test/v1/chat/completions' && sent.model === 'test-model' && sent.stream === true && sent.tool_choice === 'auto');
ok('sends the stored bearer key', fetchLog[0].init.headers.Authorization === 'Bearer k');
fetchImpl = async () => new Response(JSON.stringify({
  choices: [{ message: { role: 'assistant', content: 'All done.', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'finish', arguments: '{"summary":"done"}' } }] }, finish_reason: 'tool_calls' }],
  usage: { prompt_tokens: 3, completion_tokens: 4 },
}), { status: 200, headers: { 'content-type': 'application/json' } });
const plain = await PR.chatViaProvider(cfg, { model: 'test-model', messages: [{ role: 'user', content: 'hi' }], stream: false });
ok('parses a non-streaming completion', plain.text === 'All done.' && plain.finishReason === 'tool_calls');
ok('parses non-streaming tool arguments', plain.toolCalls[0].args.summary === 'done');
fetchImpl = async () => new Response(JSON.stringify({ error: { message: 'Incorrect API key provided' } }), { status: 401 });
let perr = '';
try { await PR.chatViaProvider(cfg, { model: 'm', messages: [], stream: false }); } catch (e) { perr = e.message; }
ok('a 401 becomes an actionable message', /API key/.test(perr), perr);
fetchImpl = async () => { const e = new TypeError('Failed to fetch'); throw e; };
const proxied = await PR.chatViaProvider(cfg, { model: 'test-model', messages: [{ role: 'user', content: 'hi' }], stream: true });
ok('CORS failure falls back to the Puter proxy', proxied.via === 'puter' && proxied.streamed === false && /Puter proxy/.test(proxied.text), JSON.stringify(proxied).slice(0, 120));
ok('the proxied retry asks for a single completion, not a stream', JSON.parse(netLog.at(-1).init.body).stream === false, netLog.at(-1).init.body);
fetchImpl = async (url) => {
  if (/\/models$/.test(String(url))) return new Response(JSON.stringify({ data: [{ id: 'test-model', object: 'model' }, { id: 'other-model' }] }), { status: 200 });
  return new Response('{}', { status: 200 });
};
const models = await PR.listProviderModels(cfg);
ok('lists provider models', models.length === 2 && models[0].id === 'test-model', JSON.stringify(models));
const probe = await PR.testProvider(cfg);
ok('testProvider reports reachability', probe.ok === true && probe.models === 2);
fetchImpl = null;

section('connections: apps the agent can call');
ok('presets include keyless search and Wikipedia', CN.CONNECTION_PRESETS.some((p) => p.id === 'duckduckgo') && CN.CONNECTION_PRESETS.some((p) => p.id === 'wikipedia'));
const ddg = CN.addPreset('duckduckgo');
ok('adding a preset stores it', CN.listConnections().some((c) => c.id === ddg.id) && JSON.parse(w.localStorage.getItem('pp.connections.v1')).length === 1);
ok('adding the same preset twice does not duplicate', CN.addPreset('duckduckgo').id === ddg.id && CN.listConnections().length === 1);
ok('buildUrl joins path and query', CN.buildUrl(ddg, { path: '/', query: { q: 'putter js', format: 'json' } }) === 'https://api.duckduckgo.com/?q=putter+js&format=json', CN.buildUrl(ddg, { path: '/', query: { q: 'putter js', format: 'json' } }));
ok('buildUrl accepts an absolute URL', CN.buildUrl(ddg, { path: 'https://other.example/x' }) === 'https://other.example/x');
fetchLog = [];
fetchImpl = async () => new Response('{"AbstractText":"Puter is a cloud OS."}', { status: 200, headers: { 'content-type': 'application/json' } });
const called = await CN.callConnection(ddg, { path: '/', query: { q: 'puter', format: 'json' } });
ok('callConnection performs the request', called.ok && called.status === 200 && called.json.AbstractText.includes('Puter'));
ok('callConnection reports the URL it used', called.url.includes('q=puter'), called.url);
const bearer = CN.saveConnection({ name: 'Bearer API', baseUrl: 'https://api.example.com', authType: 'bearer', apiKey: 'sekret' });
fetchLog = [];
await CN.callConnection(bearer, { path: '/v1/things' });
ok('bearer auth header is applied', fetchLog[0].init.headers.Authorization === 'Bearer sekret');
const headerAuth = CN.saveConnection({ name: 'Header API', baseUrl: 'https://api.example.com', authType: 'header', headerName: 'X-Api-Key', apiKey: 'abc' });
fetchLog = [];
await CN.callConnection(headerAuth, {});
ok('custom header auth is applied', fetchLog[0].init.headers['X-Api-Key'] === 'abc' && !fetchLog[0].init.headers.Authorization);
const basic = CN.saveConnection({ name: 'Basic API', baseUrl: 'https://api.example.com', authType: 'basic', apiKey: 'user:pass' });
fetchLog = [];
await CN.callConnection(basic, {});
ok('basic auth is base64 encoded', fetchLog[0].init.headers.Authorization === `Basic ${Buffer.from('user:pass').toString('base64')}`);
const gh = CN.saveConnection({ name: 'GitHub via token', baseUrl: 'https://api.github.com', authType: 'github' });
fetchLog = [];
let ghErr = '';
try { await CN.callConnection(gh, { path: '/user' }); } catch (e) { ghErr = e.message; }
ok('github auth needs the GitHub tab token', /GitHub token/.test(ghErr), ghErr);
const disabled = CN.saveConnection({ name: 'Off', baseUrl: 'https://api.example.com', enabled: false });
let disErr = '';
try { await CN.callConnection(disabled, {}); } catch (e) { disErr = e.message; }
ok('disabled connections refuse to run', /disabled/.test(disErr));
let noConn = '';
try { await CN.callConnection('conn_missing', {}); } catch (e) { noConn = e.message; }
ok('unknown connection id is reported', /No such connection/.test(noConn));
fetchImpl = async () => new Response('{"a":1}', { status: 200 });
ok('removeConnection deletes it', CN.removeConnection(bearer.id) === true && CN.getConnection(bearer.id) === null && CN.removeConnection('nope') === false);
fetchImpl = null;

section('connections: web_fetch');
let werr = '';
try { await CN.webFetch('http://localhost:8080/secret'); } catch (e) { werr = e.message; }
ok('refuses loopback addresses', /loopback|private/i.test(werr), werr);
werr = '';
try { await CN.webFetch('notaurl'); } catch (e) { werr = e.message; }
ok('refuses a non-URL', /absolute http/.test(werr));
fetchImpl = async () => new Response(`<html><head><title>Docs</title><script>var s=1;</script><style>.a{}</style></head><body><nav>menu</nav><h1>Install</h1><p>Run <code>npm i</code>.</p><ul><li>one</li><li>two</li></ul></body></html>`, { status: 200, headers: { 'content-type': 'text/html' } });
const page = await CN.webFetch('https://docs.example.com/guide');
ok('extracts the title', page.title === 'Docs', page.title);
ok('strips script, style and nav', !/var s=1|menu|\.a\{\}/.test(page.text), page.text.slice(0, 120));
ok('keeps headings, code and list items', /## Install/.test(page.text) && /npm i/.test(page.text) && /- one/.test(page.text), page.text.slice(0, 160));
ok('reports ok + status', page.ok === true && page.status === 200);
const big = await CN.webFetch('https://docs.example.com/guide', { maxChars: 40 });
ok('truncates to the budget', big.text.length <= 60 && big.truncated === true);
fetchImpl = async () => new Response('{"plain":"json"}', { status: 200, headers: { 'content-type': 'application/json' } });
const json = await CN.webFetch('https://api.example.com/x');
ok('JSON bodies pass through untouched', json.text.includes('"plain"'));
ok('htmlToText unescapes entities', CN.htmlToText('<p>a &amp; b &lt;c&gt;</p>').includes('a & b <c>'));
fetchImpl = null;
CN.listConnections().slice().forEach((c) => CN.removeConnection(c.id));


console.log(`\n═══ ${pass} passed, ${fail} failed ═══`);
process.exit(fail ? 1 : 0);
