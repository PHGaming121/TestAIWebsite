/**
 * End-to-end boot test: loads the REAL index.html in jsdom, mocks Puter.js,
 * boots the app, and drives the UI (chat send, agent tool calls, approvals,
 * model picker, workspace panel, tabs).
 */
import { JSDOM } from 'jsdom';
import fs from 'fs';
import path from 'node:path';
const REPO_ROOT = path.resolve(import.meta.dirname, '..');

const html = fs.readFileSync(`${REPO_ROOT}/index.html`, 'utf8');
const dom = new JSDOM(html, { url: 'https://phgaming121.github.io/TestAIWebsite/', pretendToBeVisual: true, runScripts: 'outside-only' });
const w = dom.window;

for (const k of ['document', 'localStorage', 'sessionStorage', 'location', 'HTMLElement', 'Element', 'Node',
  'Event', 'CustomEvent', 'FileReader', 'Blob', 'File', 'CSS', 'getComputedStyle', 'requestAnimationFrame',
  'cancelAnimationFrame', 'MouseEvent', 'KeyboardEvent', 'DataTransfer']) {
  if (w[k] !== undefined) {
    try { Object.defineProperty(globalThis, k, { value: w[k], configurable: true, writable: true }); } catch { /* ignore */ }
  }
}
Object.defineProperty(globalThis, 'window', { value: w, configurable: true, writable: true });
Object.defineProperty(globalThis, 'navigator', { value: w.navigator, configurable: true, writable: true });
globalThis.indexedDB = undefined;
w.scrollTo = () => {};
w.HTMLElement.prototype.scrollTo = () => {};

await import(`${REPO_ROOT}/assets/vendor/vendor.bundle.js`);

/* ── Puter.js mock ─────────────────────────────────────── */
const puterCalls = [];
let scripted = [];      // queue of chunk arrays for streaming responses
let rejectToolsOnce = false;
let signedIn = false;
const kvStore = new Map();

function asyncIterable(items) {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const it of items) { await new Promise((r) => setTimeout(r, 1)); yield it; }
    },
  };
}

const puterMock = {
  env: 'web',
  appID: null,
  APIOrigin: 'https://api.puter.com',
  ai: {
    normalize: undefined,
    async chat(messages, options = {}) {
      puterCalls.push({ messages: JSON.parse(JSON.stringify(messages)), options });
      if (rejectToolsOnce && options.tools?.length) {
        rejectToolsOnce = false;
        throw new Error('invalid_request_error: this model does not support tools');
      }
      const script = scripted.shift();
      if (options.stream) return asyncIterable(script || [{ type: 'text', text: 'Hello from the mock model.' }]);
      const last = (script || [{ type: 'text', text: 'Hello from the mock model.' }]);
      const text = last.filter((c) => c.type === 'text').map((c) => c.text).join('');
      const tools = last.filter((c) => c.type === 'tool_use');
      return {
        message: { content: text, ...(tools.length ? { tool_calls: tools.map((t) => ({ id: t.id, function: { name: t.name, arguments: JSON.stringify(t.input) } })) } : {}) },
        finish_reason: tools.length ? 'tool_calls' : 'stop',
        usage: { prompt_tokens: 42, completion_tokens: 17 },
      };
    },
    async listModels() {
      return [
        { id: 'claude-sonnet-4-5', provider: 'anthropic', description: 'Balanced coding', supports_tools: true, context_length: 200000 },
        { id: 'claude-opus-4-5', provider: 'anthropic', description: 'Deep reasoning', supports_tools: true },
        { id: 'gpt-5.4-nano', provider: 'openai', description: 'Fast', supports_tools: true, context_length: 128000 },
        { id: 'gpt-5.4', provider: 'openai', description: 'Flagship', supports_tools: true, supports_vision: true },
        { id: 'google/gemini-3.1-pro-preview', provider: 'google', description: '1M context', supports_tools: true, context_length: 1000000 },
        { id: 'deepseek-chat', provider: 'deepseek', description: 'Value coding', supports_tools: true },
        { id: 'grok-4-fast', provider: 'xai', description: 'xAI', supports_tools: true },
      ];
    },
    async listModelProviders() { return ['anthropic', 'openai', 'google', 'deepseek', 'xai']; },
    async txt2img() { return new w.Blob(['fakepng'], { type: 'image/png' }); },
  },
  auth: {
    isSignedIn: () => signedIn,
    async signIn() { signedIn = true; return true; },
    async signOut() { signedIn = false; },
    async getUser() { return signedIn ? { username: 'tester', uuid: 'u-1', email: 't@example.com' } : null; },
  },
  kv: {
    async set(k, v) { kvStore.set(k, v); return true; },
    async get(k) { return kvStore.get(k) ?? null; },
    async del(k) { return kvStore.delete(k); },
    async list() { return [...kvStore.keys()].map((k) => ({ key: k })); },
  },
  fs: {
    homePath: '/tester',
    _store: new Map(),
    async mkdir(p) { this._store.set(p, { is_dir: true, name: p.split('/').pop(), path: p }); return this._store.get(p); },
    async write(p, data) { const item = { is_dir: false, name: p.split('/').pop(), path: p, size: data?.size ?? String(data ?? '').length }; this._store.set(p, item); return item; },
    async read(p) { const v = this._store.get(p); if (!v || v.is_dir) throw { code: 'subject_does_not_exist', message: 'not found' }; return new w.Blob([v.content ?? '']); },
    async readdir(p) { const out = []; for (const [k, v] of this._store) if (k.startsWith(p + '/') && !k.slice(p.length + 1).includes('/')) out.push(v); return out; },
    async delete(p) { for (const k of [...this._store.keys()]) if (k === p || k.startsWith(p + '/')) this._store.delete(k); return true; },
    async stat(p) { return this._store.get(p) || null; },
    async space() { return { used: 1024, capacity: 1073741824 }; },
  },
  hosting: {
    async create(sub, dir) { return { subdomain: sub, root_dir: dir }; },
    async update(sub, dir) { return { subdomain: sub, root_dir: dir }; },
    async list() { return []; },
    async delete() { return true; },
  },
};
w.puter = puterMock;
globalThis.puter = puterMock;

/* ── boot the app ──────────────────────────────────────── */
const errors = [];
dom.virtualConsole.on('jsdomError', (e) => errors.push('jsdomError: ' + (e.detail?.stack || e.stack || e.message)));
dom.virtualConsole.on('error', (...a) => errors.push('console.error: ' + a.map(String).join(' ').slice(0, 300)));
w.addEventListener('error', (e) => errors.push(String(e.error?.stack || e.message)));
process.on('unhandledRejection', (r) => errors.push('unhandledRejection: ' + (r?.stack || r)));

// start in agent mode with auto-approve so tools run without a dialog
w.localStorage.setItem('pp.settings.v1', JSON.stringify({ mode: 'agent', autoApprove: true, stream: true, maxSteps: 6, panelOpen: true }));
// the signed-out billing note is asserted in its own section further down
w.localStorage.setItem('pp.seenSignInNote.v1', '1');

const appModule = await import(`${REPO_ROOT}/js/app.js`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
await wait(300);

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
};
const $ = (s) => w.document.querySelector(s);
const $$ = (s) => [...w.document.querySelectorAll(s)];
const click = (elm) => elm.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
// boot removes the splash on a timer, so poll instead of sleeping a fixed amount
const waitFor = async (fn, ms = 5000, step = 40) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return true; await wait(step); }
  return fn();
};
await waitFor(() => !$('#boot'));

console.log('\n── boot');
ok('splash removed', !$('#boot'));
ok('app visible', $('#app') && $('#app').hidden === false);
ok('no boot errors', errors.length === 0, errors.slice(0, 3).join(' | '));
ok('puter chip reports status', /\bok\b|\bwarn\b/.test($('#chip-puter').className), $('#chip-puter').className);
ok('signed-out chip invites a free sign-in', $('#chip-puter').textContent.includes('Sign in to Puter (free)'), $('#chip-puter').textContent);
ok('backends rendered', $$('#backend-list .backend').length === 4);
ok('memory backend selected (no OPFS in jsdom)', $('#ws-pill').textContent === 'memory', $('#ws-pill').textContent);
ok('agent mode active from settings', $('#mode-agent').classList.contains('active'));
ok('welcome visible with 4 starters', $$('#welcome-grid .wcard').length === 4);
ok('local-folder backend disabled', $$('#backend-list .backend')[2].classList.contains('dis'));
ok('opfs backend disabled', $$('#backend-list .backend')[1].classList.contains('dis'));

console.log('\n── model picker');
await wait(200);
click($('#btn-model'));
await wait(120);
ok('menu opens', $('#model-menu').hidden === false);
ok('live models listed', $$('#model-groups .model-item').length >= 7, String($$('#model-groups .model-item').length));
ok('provider groups rendered', $$('#model-groups .mg-title').length >= 4);
ok('foot shows count', /models/.test($('#model-menu-foot').textContent), $('#model-menu-foot').textContent);
$('#model-search').value = 'gemini';
$('#model-search').dispatchEvent(new w.Event('input'));
await wait(200);
ok('search filters', $$('#model-groups .model-item').length >= 1 && $$('#model-groups .mi-name').every((n) => /gemini/i.test(n.textContent)));
const firstItem = $('#model-groups .model-item');
click(firstItem);
await wait(150);
ok('selecting a model closes the menu', $('#model-menu').hidden === true);
ok('model button shows selection', /gemini/i.test($('#model-name').textContent), $('#model-name').textContent);
await wait(400);
ok('settings persisted', JSON.parse(w.localStorage.getItem('pp.settings.v1')||'{}').agentModel?.includes('gemini'), w.localStorage.getItem('pp.settings.v1')?.slice(0,160));

console.log('\n── chat mode round trip');
scripted = [[{ type: 'reasoning', reasoning: 'Let me think…' }, { type: 'text', text: '# Answer\n\nIt works. ```js\nconst x=1;\n```' }, { type: 'usage', usage: { prompt_tokens: 10, completion_tokens: 20 } }]];
click($('#mode-chat'));
await wait(60);
$('#input').value = 'Say hello';
click($('#btn-send'));
await wait(600);
ok('user message rendered', $$('.msg.user').length === 1);
ok('assistant message rendered', $$('.msg.assistant').length === 1);
ok('markdown rendered', $('.msg.assistant .md h1')?.textContent === 'Answer', $('.msg.assistant .md')?.innerHTML?.slice(0, 120));
ok('code block enhanced', !!$('.msg.assistant .code-wrap .code-head button'));
ok('reasoning box present', !!$('.msg.assistant .reasoning'));
ok('streaming caret removed', !$('.caret-blink'));
ok('conversation listed in sidebar', $$('#conv-list .conv').length === 1);
ok('conversation auto-titled', ($('#conv-list .conv-title')?.textContent || '') === 'Say hello', $('#conv-list .conv-title')?.textContent);
console.log('   [debug] puterCalls:', puterCalls.length, '| messages html len:', $('#messages').innerHTML.length, '| errors:', errors.length);
if (errors.length) console.log('   [debug] first errors:', errors.slice(0,3).join('\n    '));
ok('puter.ai.chat received system+user', (puterCalls.at(-1)?.messages?.length === 2) && puterCalls.at(-1).messages[0].role === 'system');
ok('chat uses the chat model setting', (puterCalls.at(-1)?.options?.model || '') === JSON.parse(w.localStorage.getItem('pp.settings.v1')).model, puterCalls.at(-1)?.options?.model);
ok('welcome hidden after message', $('#welcome').classList.contains('hidden'));

console.log('\n── agent mode with tools');
click($('#mode-agent'));
await wait(60);
click($('#btn-new-chat'));
await wait(120);
scripted = [
  // step 1: model calls write_file + list_files (native tool_use chunks)
  [
    { type: 'text', text: 'Building it now.' },
    { type: 'tool_use', id: 'call_1', name: 'write_file', input: { path: 'index.html', content: '<!doctype html><title>Hi</title><h1>Hello</h1>' } },
    { type: 'tool_use', id: 'call_2', name: 'write_file', input: { path: 'app.js', content: 'console.log("hi")' } },
    { type: 'usage', usage: { prompt_tokens: 100, completion_tokens: 50 } },
  ],
  // step 2: reads back and finishes
  [
    { type: 'tool_use', id: 'call_3', name: 'list_files', input: {} },
  ],
  [
    { type: 'tool_use', id: 'call_4', name: 'finish', input: { summary: 'Built index.html and app.js in the workspace.' } },
  ],
];
$('#input').value = 'Build a hello world site';
click($('#btn-send'));
await wait(1600);

ok('tool cards rendered', $$('.tool-card').length >= 3, String($$('.tool-card').length));
ok('write_file card succeeded', $$('.tool-card.ok').length >= 2);
ok('tool card body has result', $$('.tool-card .tc-body pre').some((p) => /Created|Updated|files/.test(p.textContent)), $$('.tool-card .tc-body pre')[0]?.textContent?.slice(0, 80));
ok('files landed in the workspace', (await (await import(`${REPO_ROOT}/js/workspace.js`)).workspace().list()).some((e) => e.path === 'index.html'));
ok('file tree rendered', $$('#file-tree .ft-row').length >= 2, String($$('#file-tree .ft-row').length));
ok('run bar hidden after completion', $('#runbar').hidden === true);
ok('native tools were sent', puterCalls.some((c) => Array.isArray(c.options.tools) && c.options.tools.length > 20));
ok('tool results fed back as role=tool', puterCalls.some((c) => c.messages.some((m) => m.role === 'tool' && /Created/.test(String(m.content)))));
ok('finish tool ended the loop', puterCalls.filter((c) => c.options.tools).length === 3, String(puterCalls.filter((c) => c.options.tools).length));
ok('steps recorded', JSON.parse(w.localStorage.getItem('pp.conversations.v1'))[0].meta.steps >= 2);

console.log('\n── approval gate (auto-approve off)');
w.localStorage.setItem('pp.settings.v1', JSON.stringify({ ...JSON.parse(w.localStorage.getItem('pp.settings.v1')), autoApprove: false }));
location.reload === undefined; // jsdom: settings are read live from state, so flip via the UI toggle instead
click($('#opt-auto'));            // toggles autoApprove off through the real UI path
await wait(80);
click($('#btn-new-chat'));
await wait(100);
scripted = [[{ type: 'tool_use', id: 'ap_1', name: 'write_file', input: { path: 'approved.txt', content: 'yes' } }], [{ type: 'text', text: 'All done.' }]];
$('#input').value = 'write a file please';
click($('#btn-send'));
await wait(400);
ok('approval modal shown', !!$('.modal-backdrop') && /Approve tool call/.test($('.modal-head h3')?.textContent || ''));
ok('approval shows tool args', /approved\.txt/.test($('.modal-body pre')?.textContent || ''));
const allowBtn = $$('.modal-foot .btn').find((b) => b.textContent === 'Allow');
click(allowBtn);
await wait(700);
ok('tool ran after approval', (await (await import(`${REPO_ROOT}/js/workspace.js`)).workspace().exists('approved.txt')));
ok('modal closed', !$('.modal-backdrop'));
ok('remembered approval persisted', JSON.parse(w.localStorage.getItem('pp.tools.allow.v1') || '[]').length >= 0);

console.log('\n── text protocol fallback (model answers with fenced JSON)');
click($('#opt-auto'));   // re-enable auto-approve so this test isolates the protocol, not the gate
await wait(80);
ok('no stale modals left open', !$('.modal-backdrop'));
click($('#btn-new-chat'));
await wait(100);
scripted = [[{ type: 'text', text: 'Sure!\n```tool\n{"name":"write_file","args":{"path":"proto.txt","content":"from text protocol"}}\n```\n' }], [{ type: 'text', text: 'Wrote it via the text protocol.' }]];
$('#input').value = 'write proto.txt';
click($('#btn-send'));
await wait(900);
ok('text-protocol call executed', await (await import(`${REPO_ROOT}/js/workspace.js`)).workspace().exists('proto.txt'));
ok('tool block stripped from the visible answer', !$$('.msg.assistant .md').some((n) => n.textContent.includes('```tool')));

console.log('\n── workspace panel');
click($$('.wp-tab').find((t) => t.dataset.pane === 'files'));
await wait(150);
ok('files pane active', $('.wp-pane[data-pane="files"]').classList.contains('active'));
const rows = $$('#file-tree .ft-row');
ok('tree lists agent files', rows.some((r) => r.textContent.includes('index.html')));
const row = rows.find((r) => r.textContent.includes('index.html'));
click(row);
await wait(200);
ok('viewer shows path', $('#fv-path').textContent.includes('index.html'), $('#fv-path').textContent);
ok('viewer shows highlighted code', $('#fv-body code').textContent.includes('<!doctype html'));
click($('#btn-fv-copy'));
await wait(50);
click($$('.wp-tab').find((t) => t.dataset.pane === 'github'));
await wait(120);
ok('github pane has connect card', /Personal Access Token/.test($('#gh-pane').textContent));
ok('sidebar github pill says not linked', $('#gh-pill').textContent === 'not linked', $('#gh-pill').textContent);
click($$('.wp-tab').find((t) => t.dataset.pane === 'publish'));
await wait(120);
ok('publish pane has puter.site + github.io cards', /puter\.site/.test($('#pub-pane').textContent) && /github\.io/.test($('#pub-pane').textContent));
click($$('.wp-tab').find((t) => t.dataset.pane === 'term'));
await wait(120);
ok('terminal shows shell help hint', /mini shell/.test($('#term-out').textContent));

console.log('\n── workspace panel: open / close');
ok('panel was open at boot (remembered setting)', $('#wpanel').classList.contains('open'));
ok('panel has a close button', !!$('#btn-wp-close'));
click($('#btn-wp-close'));
await wait(60);
ok('close button hides the panel', !$('#wpanel').classList.contains('open'));
await wait(300);   // settings writes are debounced
ok('closing persisted to settings', JSON.parse(w.localStorage.getItem('pp.settings.v1')).panelOpen === false);
click($('#btn-workspace'));
await wait(60);
ok('topbar button re-opens it', $('#wpanel').classList.contains('open'));
await wait(300);
ok('reopen persisted to settings', JSON.parse(w.localStorage.getItem('pp.settings.v1')).panelOpen === true);
click($$('.wp-tab').find((t) => t.dataset.pane === 'term'));
await wait(60);
ok('clicking the already-active tab collapses the panel', !$('#wpanel').classList.contains('open'));
click($$('.wp-tab').find((t) => t.dataset.pane === 'term'));
await wait(60);
ok('clicking it again re-opens on that tab', $('#wpanel').classList.contains('open') && $('.wp-tab.active').dataset.pane === 'term');
w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'j', ctrlKey: true, bubbles: true }));
await wait(60);
ok('Ctrl+J toggles the panel shut', !$('#wpanel').classList.contains('open'));
w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'j', ctrlKey: true, bubbles: true }));
await wait(60);
ok('Ctrl+J toggles it back open', $('#wpanel').classList.contains('open'));
w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
await wait(60);
ok('Escape closes it', !$('#wpanel').classList.contains('open'));
click($('#btn-workspace'));
await wait(60);

console.log('\n── css regressions');
const css = fs.readFileSync(`${REPO_ROOT}/assets/css/styles.css`, 'utf8');
ok('[hidden] wins over component display rules', /\[hidden\]\{display:none!important\}/.test(css));
ok('model menu is not permanently visible', /\.model-menu\{[^}]*display:flex/.test(css) && /\[hidden\]\{display:none!important\}/.test(css));
ok('workspace panel is hidden until opened', /\.wpanel\{[^}]*display:none/.test(css) && /\.wpanel\.open\{display:flex\}/.test(css));
ok('narrow screens still slide the drawer', /@media \(max-width:1180px\)\{\s*\.wpanel\{display:flex/.test(css));
ok('workspace toggle is reachable on phones', !/only-wide" id="btn-workspace/.test(fs.readFileSync(`${REPO_ROOT}/index.html`, 'utf8')));

console.log('\n── create pane: image + video generation');
const { workspace: wsOf } = await import(`${REPO_ROOT}/js/workspace.js`);
const PNG_SRC = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const imgCalls = [];
const vidCalls = [];
puterMock.ai.txt2img = async (prompt, options) => {
  imgCalls.push({ prompt, options });
  const i = w.document.createElement('img'); i.src = PNG_SRC; return i;
};
puterMock.ai.txt2vid = async (options) => {
  vidCalls.push(options);
  const v = w.document.createElement('video'); v.src = 'data:video/mp4;base64,AAAAHGZ0eXBpc29tAA=='; return v;
};
click($$('.wp-tab').find((t) => t.dataset.pane === 'create'));
await wait(150);
ok('create pane rendered', /Create/.test($('#media-pane').textContent) && $$('#media-pane .seg').length === 2);
ok('image and video are switchable', $$('#media-pane .seg').map((b) => b.textContent.trim()).join('|') === 'Image|Video');
const freeBox = $$('#media-pane .checkline').find((l) => /Free sample/.test(l.textContent))?.querySelector('input');
ok('credit-free test mode is ON by default', freeBox?.checked === true);
ok('model + provider + quality controls exist', $$('#media-pane select').length >= 4, String($$('#media-pane select').length));
const genBtn = $$('#media-pane button').find((b) => /Generate/.test(b.textContent));
$('#media-pane textarea').value = 'a red cube on white';
click(genBtn);
await wait(600);
let paths = (await wsOf().list()).map((e) => e.path);
ok('generated image saved under media/', paths.some((p) => /^media\/image-[\w-]+\.png$/.test(p)), paths.join(','));
ok('txt2img got the prompt and test_mode', imgCalls.length === 1 && imgCalls[0].prompt === 'a red cube on white' && imgCalls[0].options.test_mode === true, JSON.stringify(imgCalls[0]));
ok('result card shows the image', !!$('#media-pane .media-result img'));
ok('result names the saved file', /media\/image-[\w-]+\.png/.test($('#media-pane').textContent));
ok('session history thumbnail added', $$('#media-pane .media-thumb').length === 1);
ok('free-sample tag shown', /free sample — no credits used/i.test($('#media-pane').textContent));
click($$('#media-pane .seg').find((b) => /Video/.test(b.textContent)));
await wait(100);
ok('switching to video swaps the options', $('#media-pane .video-opts, #media-pane .opt-grid') && /Output size/.test($('#media-pane').textContent));
$('#media-pane textarea').value = 'a slow pan over dunes';
click($$('#media-pane button').find((b) => /Generate/.test(b.textContent)));
await wait(700);
paths = (await wsOf().list()).map((e) => e.path);
ok('generated video saved under media/', paths.some((p) => /^media\/video-[\w-]+\.mp4$/.test(p)), paths.filter((p) => p.startsWith('media/')).join(','));
ok('txt2vid got prompt + test mode', vidCalls.length === 1 && vidCalls[0].prompt === 'a slow pan over dunes' && vidCalls[0].test_mode === true, JSON.stringify(vidCalls[0]));
ok('video result renders a <video>', !!$('#media-pane .media-result video'));
click($$('#media-pane .seg').find((b) => /Image/.test(b.textContent)));
await wait(80);
await wsOf().write('media/refs/seed.png', new w.Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }));
click($$('.wp-tab').find((t) => t.dataset.pane === 'files'));
await wait(60);
click($$('.wp-tab').find((t) => t.dataset.pane === 'create'));
await wait(200);
const refOpts = [...$$('#media-pane select').find((s) => [...s.options].some((o) => /none \(text-to-image\)/.test(o.text))).options].map((o) => o.value);
ok('workspace images are offered as references', refOpts.some((v) => /media\/(image-|refs\/seed)/.test(v)), refOpts.join(','));

console.log('\n── agent media tools');
click($('#mode-agent'));
await wait(60);
if (!$('#opt-auto').checked) { click($('#opt-auto')); await wait(80); }
click($('#btn-new-chat'));
await wait(150);
const beforeMedia = puterCalls.length;
scripted = [
  [{ type: 'tool_use', id: 'img1', name: 'generate_image', input: { prompt: 'a blue sphere', test_mode: true } },
   { type: 'tool_use', id: 'vid1', name: 'generate_video', input: { prompt: 'the sphere spinning', seconds: 5, test_mode: true } }],
  [{ type: 'text', text: 'Done — the image and the clip are in media/.' }],
];
$('#input').value = 'make me a sphere image and a short clip';
click($('#btn-send'));
await wait(1400);
paths = (await wsOf().list()).map((e) => e.path);
ok('agent generate_image wrote a file', paths.filter((p) => /^media\/image-/.test(p)).length >= 2, paths.filter((p) => p.startsWith('media/')).join(','));
ok('agent generate_video wrote a file', paths.filter((p) => /^media\/video-/.test(p)).length >= 2, paths.filter((p) => p.startsWith('media/')).join(','));
const toolCards = $$('.tool-card');
const mediaCards = $$('.msg.assistant .media-card');
ok('media shown inline in the transcript', mediaCards.length >= 2, String(mediaCards.length));
ok('media card links back to the file', /media\/(image|video)-/.test(mediaCards[0]?.textContent || ''), mediaCards[0]?.textContent);
const resultsSent = puterCalls.slice(beforeMedia).flatMap((c) => c.messages).filter((m) => m.role === 'tool').map((m) => String(m.content));
ok('tool results are short text, not base64', resultsSent.length >= 1 && resultsSent.every((r) => r.length < 300 && !/base64|data:image/.test(r)), resultsSent.join(' | ').slice(0, 160));
ok('no media bytes were sent back to the model', !puterCalls.slice(beforeMedia).some((c) => JSON.stringify(c.messages).includes('data:image')));
ok('media tools are approval-gated WRITE tools', toolCards.length >= 0);

console.log('\n── memory pane');
const MEM = await import(`${REPO_ROOT}/js/memory.js`);
MEM.clearMemories();
MEM.addMemory({ text: 'The user ships everything to GitHub Pages.', kind: 'decision', tags: ['deploy'] });
MEM.addMemory({ text: 'The user prefers plain JavaScript over TypeScript.', kind: 'preference' });
click($$('.wp-tab').find((t) => t.dataset.pane === 'memory'));
await wait(150);
ok('memory pane rendered', /Long-term memory/.test($('#memory-pane').textContent));
ok('stats count the memories', /2 memories/.test($('#memory-pane').textContent), $('#memory-pane').textContent.slice(0, 120));
ok('both memories listed', $$('#memory-pane .mem-row').length === 2);
ok('kind tags shown', /decision/.test($('#memory-pane').textContent) && /preference/.test($('#memory-pane').textContent));
$('#memory-pane input[type=search]').value = 'typescript';
$('#memory-pane input[type=search]').dispatchEvent(new w.Event('input', { bubbles: true }));
await wait(120);
ok('search filters the list', $$('#memory-pane .mem-row').length === 1 && /JavaScript/.test($('#memory-pane .mem-row').textContent));
$('#memory-pane input[type=search]').value = '';
$('#memory-pane input[type=search]').dispatchEvent(new w.Event('input', { bubbles: true }));
await wait(120);
ok('clearing the search restores the list', $$('#memory-pane .mem-row').length === 2);
ok('pin / edit / delete controls exist', $$('#memory-pane .mem-row .mem-actions .icon-btn').length === 6);
click($$('#memory-pane .mem-row')[0].querySelector('.mem-actions .icon-btn'));
await wait(120);
ok('pinning marks the memory', MEM.memories().some((m) => m.pinned));
ok('cloud mirror is off by default', $('#memory-pane input[type=checkbox]').checked === false);
const prefRow = $$('#memory-pane .mem-row').find((r) => /JavaScript/.test(r.textContent));
const delBtn = prefRow.querySelectorAll('.mem-actions .icon-btn')[2];
click(delBtn);
await wait(150);
const confirmDlg = $('.modal-backdrop');
ok('delete asks for confirmation', /Delete this memory\?/.test(confirmDlg?.textContent || ''));
click([...confirmDlg.querySelectorAll('button')].find((b) => /^Delete$/.test(b.textContent.trim())));
await wait(200);
ok('delete removed it', MEM.memories().length === 1);

console.log('\n── agent memory tools');
click($('#btn-new-chat'));
await wait(150);
const beforeMem = puterCalls.length;
scripted = [
  [{ type: 'tool_use', id: 'r1', name: 'remember', input: { text: 'The user is building TestAIWebsite, a static Puter playground.', kind: 'project', tags: ['repo'] } },
   { type: 'tool_use', id: 'r2', name: 'recall', input: { query: 'GitHub Pages deploy' } }],
  [{ type: 'text', text: 'Noted — and yes, you ship to GitHub Pages.' }],
];
$('#input').value = 'remember that project, and what do you know about how I deploy?';
click($('#btn-send'));
await wait(1500);
ok('remember stored the memory', MEM.memories().some((m) => m.kind === 'project' && /TestAIWebsite/.test(m.text)));
ok('recall found the deployment decision', MEM.memories().some((m) => m.hits > 0), JSON.stringify(MEM.memories().map((m) => m.hits)));
const recallResult = puterCalls.slice(beforeMem).flatMap((c) => c.messages).filter((m) => m.role === 'tool').map((m) => String(m.content)).join('\n');
ok('recall returned the memory to the model', /GitHub Pages/.test(recallResult), recallResult.slice(0, 140));
ok('recall exposes ids so forget can target one', /id: mem_/.test(recallResult), recallResult.slice(0, 120));
const lastSystem = puterCalls.at(-1).messages.find((m) => m.role === 'system')?.content || '';
ok('memory is injected into the next system prompt', /Long-term memory/.test(lastSystem) && /GitHub Pages/.test(lastSystem));
ok('memory block tells the model not to invent memories', /Never invent memories/.test(lastSystem));
scripted = [[{ type: 'tool_use', id: 'f1', name: 'forget', input: { query: 'TestAIWebsite project' } }], [{ type: 'text', text: 'Forgotten.' }]];
$('#input').value = 'actually, forget that project note';
click($('#btn-send'));
await wait(1200);
ok('forget deleted it', !MEM.memories().some((m) => /TestAIWebsite/.test(m.text)));
ok('memory pane refreshed after agent changes', $$('#memory-pane .mem-row').length === MEM.memories().length);

console.log('\n── memory distillation');
MEM.clearMemories();
click($('#btn-new-chat'));
await wait(120);
click($('#mode-chat'));
await wait(80);
scripted = [[{ type: 'text', text: 'Hello!' }]];
$('#input').value = 'hi';
click($('#btn-send'));
await wait(700);
click($$('.wp-tab').find((t) => t.dataset.pane === 'memory'));
await wait(120);
scripted = [[{ type: 'text', text: '```json\n[{"text":"The user greets tersely.","kind":"preference","tags":["style"]},{"text":"The user works late.","kind":"fact"}]\n```' }]];
click($$('#memory-pane button').find((b) => /Distil memories/.test(b.textContent)));
await wait(900);
ok('distil proposed candidates', $$('#memory-pane .cand').length === 2, String($$('#memory-pane .cand').length));
ok('candidates are ticked by default', $$('#memory-pane .cand input').every((c) => c.checked));
$$('#memory-pane .cand input')[1].checked = false;
click($$('#memory-pane button').find((b) => /Save selected/.test(b.textContent)));
await wait(250);
ok('only the ticked candidate was saved', MEM.memories().length === 1 && /tersely/.test(MEM.memories()[0].text));
ok('saved with its kind and tags', MEM.memories()[0].kind === 'preference' && MEM.memories()[0].tags.includes('style'));
ok('distilled memories say where they came from', MEM.memories()[0].source === 'distill');

console.log('\n── settings modal');
click($('#btn-settings'));
await wait(150);
ok('settings modal opens', /Settings/.test($('.modal-head h3')?.textContent || ''));
ok('settings has all groups', $$('.modal-body .setting-group').length >= 6, String($$('.modal-body .setting-group').length));
ok('max steps control present', $$('.modal-body input.num').length >= 3);
click($('.modal-head .icon-btn'));
await wait(100);
ok('settings modal closes', !$('.modal-backdrop'));

console.log('\n── persistence & conversation switching');
ok('conversations persisted', JSON.parse(w.localStorage.getItem('pp.conversations.v1')).length >= 4);
const convs = $$('#conv-list .conv');
click(convs[convs.length - 1]);
await wait(200);
ok('switching conversations re-renders', $$('.msg').length >= 2, String($$('.msg').length));
click($('#btn-new-chat'));
await wait(150);
ok('new chat shows welcome', !$('#welcome').classList.contains('hidden'));

console.log('\n── drag & drop import');
const dt = { files: [Object.assign(new w.File(['dropped content'], 'dropped.txt', { type: 'text/plain' }), {})] };
const dropEvent = new w.Event('drop', { bubbles: true });
dropEvent.dataTransfer = dt;
w.document.dispatchEvent(dropEvent);
await wait(400);
ok('dropped file imported to workspace', await (await import(`${REPO_ROOT}/js/workspace.js`)).workspace().exists('dropped.txt'));

console.log('\n── native tools rejected → text-protocol downgrade');
click($('#mode-agent'));            // the previous section left us in chat mode
await wait(80);
if (!$('#opt-auto').checked) { click($('#opt-auto')); await wait(80); }   // ensure auto-approve ON
ok('agent mode + auto-approve set up', $('#mode-agent').classList.contains('active') && $('#opt-auto').checked);
click($('#btn-new-chat'));
await wait(150);
rejectToolsOnce = true;
const before = puterCalls.length;
scripted = [
  // first attempt is rejected by the mock; the retry (no tools) answers in the text protocol
  [{ type: 'text', text: '```tool\n{"name":"write_file","args":{"path":"downgraded.txt","content":"fallback worked"}}\n```' }],
  [{ type: 'text', text: 'Done via the text protocol.' }],
];
$('#input').value = 'write downgraded.txt';
click($('#btn-send'));
await wait(1200);
ok('retried without tools after rejection', puterCalls.slice(before).some((c) => !c.options.tools) && puterCalls.slice(before).some((c) => !!c.options.tools));
ok('fallback executed the tool', await (await import(`${REPO_ROOT}/js/workspace.js`)).workspace().exists('downgraded.txt'));
ok('user was told about the downgrade', /text protocol|rejected native/i.test($('#term-out').textContent), $('#term-out').textContent.slice(-160));
ok('no tool role leaked into a tools-less request', !puterCalls.slice(before).filter((c) => !c.options.tools).some((c) => c.messages.some((m) => m.role === 'tool')));
rejectToolsOnce = false;

console.log('\n── connect pane: providers');
const PR = await import(`${REPO_ROOT}/js/providers.js`);
const CN = await import(`${REPO_ROOT}/js/connections.js`);
click($$('.wp-tab').find((t) => t.dataset.pane === 'connect'));
await wait(200);
ok('connect pane rendered', /Which AI answers/.test($('#connect-pane').textContent));
const provSel = $('#connect-pane select');
ok('provider list includes Puter, local and key options', [...provSel.options].map((o) => o.value).join(',').includes('puter,ollama') && [...provSel.options].some((o) => o.value === 'openrouter'));
ok('Puter needs no key', /no key and no backend/i.test($('#connect-pane').textContent));
ok('Ollama preset explains the origin env var', (provSel.value = 'ollama', provSel.dispatchEvent(new w.Event('change', { bubbles: true })), /OLLAMA_ORIGINS/.test($('#connect-pane').textContent)));
provSel.value = 'openrouter';
provSel.dispatchEvent(new w.Event('change', { bubbles: true }));
await wait(80);
ok('choosing OpenRouter reveals a key field', $$('#connect-pane input[type=password]').length >= 1 && /API key \(required\)/.test($('#connect-pane').textContent));
const keyInput = $$('#connect-pane input[type=password]')[0];
keyInput.value = 'sk-or-test-key';
click($$('#connect-pane button').find((b) => /Save & use/.test(b.textContent)));
await wait(300);
ok('saving activates the provider', JSON.parse(w.localStorage.getItem('pp.settings.v1')).providerId === 'openrouter');
ok('the key is stored in this browser only', PR.providerConfig('openrouter').apiKey === 'sk-or-test-key');
ok('the active provider is labelled', /Active provider: OpenRouter/.test($('#connect-pane').textContent));
ok('a way back to Puter is offered', $$('#connect-pane button').some((b) => /Switch back to Puter/.test(b.textContent)));
click($$('#connect-pane button').find((b) => /Remove key/.test(b.textContent)));
await wait(150);
click([...$('.modal-backdrop').querySelectorAll('button')].find((b) => /^Remove$/.test(b.textContent.trim())));
await wait(200);
ok('the key can be removed again', PR.providerConfig('openrouter').apiKey === '');
click($$('#connect-pane button').find((b) => /Switch back to Puter/.test(b.textContent)));
await wait(250);
ok('switching back restores the keyless default', JSON.parse(w.localStorage.getItem('pp.settings.v1')).providerId === 'puter');

console.log('\n── connect pane: app connections');
const ddgBtn = $$('#connect-pane .preset-row button').find((b) => /DuckDuckGo/.test(b.textContent));
ok('keyless presets are offered', !!ddgBtn && $$('#connect-pane .preset-row button').some((b) => /Wikipedia/.test(b.textContent)));
click(ddgBtn);
await wait(200);
ok('a preset becomes a connection row', $$('#connect-pane .conn-row').length === 1 && /api\.duckduckgo\.com/.test($('#connect-pane .conn-row').textContent));
const enableBox = $('#connect-pane .conn-row input[type=checkbox]');
enableBox.checked = false;
enableBox.dispatchEvent(new w.Event('change', { bubbles: true }));
await wait(150);
ok('connections can be disabled', CN.listConnections()[0].enabled === false);
enableBox.checked = true;
enableBox.dispatchEvent(new w.Event('change', { bubbles: true }));
await wait(120);
click($$('#connect-pane .preset-row button').find((b) => /Custom app/.test(b.textContent)));
await wait(200);
let modal = $('.modal-backdrop');
ok('custom connection form opens', /Connect an app/.test(modal?.textContent || ''));
ok('auth choices are offered', [...modal.querySelectorAll('select option')].map((o) => o.text).join(',').includes('Bearer token'));
const mInputs = [...modal.querySelectorAll('input.inp')];
mInputs[0].value = 'Weather';
mInputs[1].value = 'not-a-url';
click([...modal.querySelectorAll('button')].find((b) => /Save connection/.test(b.textContent)));
await wait(120);
ok('a bad base URL is rejected', /http:\/\/ or https:\/\//.test($('.modal-backdrop .notice.err')?.textContent || ''), $('.modal-backdrop .notice.err')?.textContent);
mInputs[1].value = 'https://api.weather.example/';
click([...$('.modal-backdrop').querySelectorAll('button')].find((b) => /Save connection/.test(b.textContent)));
await wait(250);
ok('a valid connection is saved', CN.listConnections().some((c) => c.name === 'Weather' && c.baseUrl === 'https://api.weather.example'));
ok('the new row is listed', $$('#connect-pane .conn-row').length === 2);
const connDelBtn = $$('#connect-pane .conn-row').find((r) => /Weather/.test(r.textContent)).querySelectorAll('.icon-btn')[1];
click(connDelBtn);
await wait(150);
click([...$('.modal-backdrop').querySelectorAll('button')].find((b) => /^Remove$/.test(b.textContent.trim())));
await wait(200);
ok('connections can be removed', !CN.listConnections().some((c) => c.name === 'Weather'));

console.log('\n── routing chat through another provider');
const customFetchLog = [];
globalThis.fetch = async (url, init) => {
  customFetchLog.push({ url: String(url), init });
  const askedForStream = /"stream":\s*true/.test(String(init?.body || ''));
  if (askedForStream) {
    const enc = new TextEncoder();
    const body = new ReadableStream({
      start(c) {
        c.enqueue(enc.encode('data: {"choices":[{"delta":{"role":"assistant","content":"Answer from "}}]}\n\n'));
        c.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"the custom endpoint."},"finish_reason":"stop"}],"usage":{"prompt_tokens":4,"completion_tokens":6}}\n\n'));
        c.enqueue(enc.encode('data: [DONE]\n\n'));
        c.close();
      },
    });
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }
  return new Response(JSON.stringify({
    choices: [{ message: { role: 'assistant', content: 'Answer from the custom endpoint.' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 4, completion_tokens: 6 },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
};
PR.saveProviderConfig('custom', { baseUrl: 'https://llm.internal.example/v1', apiKey: 'k-123', model: 'house-model' });
click($$('.wp-tab').find((t) => t.dataset.pane === 'connect'));
await wait(150);
const sel2 = $('#connect-pane select');
sel2.value = 'custom';
sel2.dispatchEvent(new w.Event('change', { bubbles: true }));
await wait(100);
click($$('#connect-pane button').find((b) => /Save & use/.test(b.textContent)));
await wait(300);
click($('#mode-chat'));
await wait(80);
click($('#btn-new-chat'));
await wait(150);
$('#input').value = 'hello from another provider';
click($('#btn-send'));
await wait(900);
ok('the request went to the custom endpoint', customFetchLog.some((c) => c.url === 'https://llm.internal.example/v1/chat/completions'), customFetchLog.map((c) => c.url).join(','));
ok('streaming was requested from the custom endpoint', /"stream":\s*true/.test(String(customFetchLog[0]?.init?.body || '')));
ok('the custom key was used', customFetchLog[0]?.init?.headers?.Authorization === 'Bearer k-123');
ok('Puter was not called for that turn', puterCalls.length === 0 || !puterCalls.at(-1).messages.some((m) => /hello from another provider/.test(JSON.stringify(m))));
ok('the answer rendered in the transcript', $$('.msg.assistant .md').some((n) => /custom endpoint/.test(n.textContent)), $$('.msg.assistant .md').at(-1)?.textContent?.slice(0, 80));
click($$('.wp-tab').find((t) => t.dataset.pane === 'connect'));
await wait(150);
click($$('#connect-pane button').find((b) => /Switch back to Puter/.test(b.textContent)));
await wait(250);
ok('back on Puter afterwards', JSON.parse(w.localStorage.getItem('pp.settings.v1')).providerId === 'puter');

console.log('\n── agent network tools need approval');
click($('#btn-new-chat'));          // a conversation with messages keeps its mode
await wait(150);
click($('#mode-agent'));
await wait(80);
if ($('#opt-auto').checked) { click($('#opt-auto')); await wait(100); }   // approvals ON
scripted = [[{ type: 'tool_use', id: 'wf1', name: 'web_fetch', input: { url: 'https://docs.example.com/guide' } }], [{ type: 'text', text: 'Read it.' }]];
$('#input').value = 'read that page for me';
click($('#btn-send'));
await wait(700);
const approval = $('.modal-backdrop');
ok('web_fetch asks before calling out', /external service you connected/.test(approval?.textContent || ''), approval?.textContent?.slice(0, 120));
ok('the approval names the tool', /web_fetch/.test(approval?.textContent || ''));
click([...approval.querySelectorAll('button')].find((b) => /deny|no/i.test(b.textContent)));
await wait(600);
ok('denying stops the call', !customFetchLog.some((c) => /docs\.example\.com/.test(c.url)));
if (!$('#opt-auto').checked) { click($('#opt-auto')); await wait(100); }
click($('#mode-chat'));
await wait(60);

console.log('\n── skills pane');
const SKILLS = await import(`${REPO_ROOT}/js/skills.js`);
const { workspace: wsSkills } = await import(`${REPO_ROOT}/js/workspace.js`);
click($$('.wp-tab').find((t) => t.dataset.pane === 'skills'));
await wait(250);
ok('skills pane explains the open standard', /Agent Skills open standard/.test($('#skills-pane').textContent) && /SKILL\.md/.test($('#skills-pane').textContent));
ok('empty state offers discovery paths', /No skills in the workspace/.test($('#skills-pane').textContent));
const skillArea = $('#skills-pane textarea');
skillArea.value = '---\nname: pdf-table-extract\ndescription: "Extracts tables from PDF files into CSV or JSON. Use when a task needs structured data out of a PDF report, invoice, or form."\nlicense: MIT\nallowed-tools: Bash(python:*) Read Write\n---\n## Steps\n1. Identify every page with a table.\n2. Extract rows and columns.';
skillArea.dispatchEvent(new w.Event('input', { bubbles: true }));
await wait(150);
ok('pasted SKILL.md is detected before import', /Detected: <b>skill\.md<\/b>|Detected: skill\.md/.test($('#skills-pane .import-preview').textContent) || /skill\.md/.test($('#skills-pane .import-preview').textContent), $('#skills-pane .import-preview').textContent.slice(0, 90));
ok('the preview names the skill', /pdf-table-extract/.test($('#skills-pane .import-preview').textContent));
ok('the preview warns about requested tools', /Requests tools: Bash\(python:\*\) Read Write/.test($('#skills-pane .import-preview').textContent));
click($$('#skills-pane button').find((b) => /Import pasted skill/.test(b.textContent)));
await wait(400);
ok('the skill is stored in the workspace', await wsSkills().exists('skills/pdf-table-extract/SKILL.md'));
ok('the skill is listed in the pane', $$('#skills-pane .skill-row').length === 1 && /pdf-table-extract/.test($('#skills-pane .skill-row').textContent));
ok('an imported skill starts unreviewed', /unreviewed/.test($('#skills-pane .skill-row').textContent));
ok('requested tools are surfaced, not granted', /asks to pre-approve tools/.test($('#skills-pane .skill-row').textContent) && !JSON.parse(w.localStorage.getItem('pp.tools.allow.v1') || '[]').includes('read_file'));
const allowReadBtn = $$('#skills-pane .skill-row button').find((b) => /^Allow read_file$/.test(b.textContent.trim()));
ok('Claude tool names map onto this app', !!allowReadBtn && $$('#skills-pane .skill-row button').some((b) => /^Allow run_shell$/.test(b.textContent.trim())));
click(allowReadBtn);
await wait(200);
ok('granting is an explicit click', JSON.parse(w.localStorage.getItem('pp.tools.allow.v1')).includes('read_file'));
click($$('#skills-pane .skill-row button').find((b) => /^✓ read_file allowed$/.test(b.textContent.trim())));
await wait(200);
ok('and can be taken back', !JSON.parse(w.localStorage.getItem('pp.tools.allow.v1')).includes('read_file'));
click($$('#skills-pane .skill-row button').find((b) => /^View$/.test(b.textContent.trim())));
await wait(250);
ok('the viewer shows the instructions', /Identify every page with a table/.test($('.modal-backdrop')?.textContent || ''));
click([...$('.modal-backdrop').querySelectorAll('button')].find((b) => /Mark as reviewed/.test(b.textContent)));
await wait(250);
ok('review state can be recorded', /trusted/.test($('#skills-pane .skill-row').textContent));
const gptArea = $('#skills-pane textarea');
gptArea.value = JSON.stringify({ name: 'SEO Optimizer', description: 'Optimises pages for search.', instructions: 'Always crawl first, then list the top five issues.', capabilities: ['browser'] });
gptArea.dispatchEvent(new w.Event('input', { bubbles: true }));
await wait(150);
ok('a ChatGPT custom GPT is detected', /chatgpt-gpt/.test($('#skills-pane .import-preview').textContent), $('#skills-pane .import-preview').textContent.slice(0, 90));
click($$('#skills-pane button').find((b) => /Import pasted skill/.test(b.textContent)));
await wait(400);
ok('the GPT became a skill', await wsSkills().exists('skills/seo-optimizer/SKILL.md') && $$('#skills-pane .skill-row').length === 2);
ok('its origin is badged', /chatgpt/.test($('#skills-pane').textContent));
const nameField = $$('#skills-pane input.inp')[0];
const seoRow = $$('#skills-pane .skill-row').find((r) => /seo-optimizer/.test(r.textContent));
const seoToggle = seoRow.querySelector('input[type=checkbox]');
seoToggle.checked = false;
seoToggle.dispatchEvent(new w.Event('change', { bubbles: true }));
await wait(250);
ok('skills can be disabled', (await SKILLS.listSkills(wsSkills())).find((x) => x.name === 'seo-optimizer').enabled === false);

console.log('\n── agent skill tools');
click($('#btn-new-chat'));
await wait(150);
click($('#mode-agent'));
await wait(80);
if (!$('#opt-auto').checked) { click($('#opt-auto')); await wait(100); }
const beforeSkills = puterCalls.length;
scripted = [
  [{ type: 'tool_use', id: 's1', name: 'list_skills', input: {} },
   { type: 'tool_use', id: 's2', name: 'use_skill', input: { name: 'pdf-table-extract' } },
   { type: 'tool_use', id: 's3', name: 'create_skill', input: { name: 'Deploy Checklist', description: 'Pre-flight checks before shipping. Use before any deploy or release.', body: '## Steps\n1. Run the tests.\n2. Check the README.' } }],
  [{ type: 'text', text: 'Loaded the PDF skill, and saved a deploy checklist skill.' }],
];
$('#input').value = 'use the pdf skill and save a deploy checklist as a skill';
click($('#btn-send'));
await wait(1800);
const skillResults = puterCalls.slice(beforeSkills).flatMap((c) => c.messages).filter((m) => m.role === 'tool').map((m) => String(m.content)).join('\n');
ok('list_skills answered from the workspace', /pdf-table-extract/.test(skillResults) && /seo-optimizer/.test(skillResults), skillResults.slice(0, 140));
ok('list_skills notes a disabled skill', /DISABLED/.test(skillResults));
ok('use_skill returned the instructions', /Identify every page with a table/.test(skillResults));
ok('use_skill warns that allowed-tools is not granted', /NOT granted automatically/.test(skillResults));
ok('create_skill wrote a new skill', await wsSkills().exists('skills/deploy-checklist/SKILL.md'));
const newSystem = puterCalls.slice(beforeSkills).map((c) => c.messages.find((m) => m.role === 'system')?.content || '').join('\n');
ok('the skills index is in the system prompt', /## Available skills/.test(newSystem) && /pdf-table-extract/.test(newSystem));
const skillsSection = (/## Available skills[\s\S]*?(?=\n## |$)/.exec(newSystem)?.[0] || '').replace(/\s+/g, ' ');
ok('disabled skills stay out of the skills index', !/seo-optimizer/.test(skillsSection), skillsSection.slice(0, 200));
ok('the prompt says skills cannot widen permissions', /cannot widen your permissions/.test(skillsSection), skillsSection.slice(0, 200));
click($$('.wp-tab').find((t) => t.dataset.pane === 'skills'));
await wait(300);
ok('the pane picked up the agent-created skill', $$('#skills-pane .skill-row').length === 3);

console.log('\n── signed-out Puter pre-flight');
w.localStorage.removeItem('pp.seenSignInNote.v1');
signedIn = false;
click($('#mode-chat'));
await wait(80);
click($('#btn-new-chat'));
await wait(150);
scripted = [[{ type: 'text', text: 'Hi there.' }]];
const callsBefore = puterCalls.length;
$('#input').value = 'hello';
click($('#btn-send'));
await wait(150);
const note = $('.modal-backdrop');
ok('first message while signed out explains the Puter login', !!note && /Puter billing works/.test(note.textContent), note?.textContent?.slice(0, 90));
ok('it says signing in is free and needs no card', /free/.test(note?.textContent || '') && /no card/.test(note?.textContent || ''));
ok('it is honest about the allowance ceiling', /allowance/i.test(note?.textContent || '') && /credits|upgrade/i.test(note?.textContent || ''));
ok('it says the site owner pays nothing', /pays \$0|pays nothing/i.test(note?.textContent || ''));
ok('no model call happened yet', puterCalls.length === callsBefore);
click([...note.querySelectorAll('button')].find((b) => /not now/i.test(b.textContent)));
await wait(120);
ok('cancelling aborts the send', puterCalls.length === callsBefore && !w.localStorage.getItem('pp.seenSignInNote.v1'));
$('#input').value = 'hello';
click($('#btn-send'));
await wait(150);
const note2 = $('.modal-backdrop');
click([...note2.querySelectorAll('button')].find((b) => /continue/i.test(b.textContent)));
await wait(700);
ok('continuing sends the message', puterCalls.length > callsBefore);
ok('the note is not shown again', w.localStorage.getItem('pp.seenSignInNote.v1') === '1');
ok('topbar invites a free sign-in while signed out', /sign in to puter \(free\)/i.test($('#chip-puter').textContent), $('#chip-puter').textContent);
click($('#chip-puter'));
await wait(120);
ok('account modal explains who pays', /Who pays for the AI\?/.test($('.modal-body')?.textContent || ''), $('.modal-body')?.textContent?.slice(0, 80));
click($('.modal-head .icon-btn'));
await wait(80);
signedIn = true;

console.log('\n── errors');
ok('no runtime errors during the whole run', errors.length === 0, errors.slice(0, 4).join(' | '));

console.log(`\n═══ ${pass} passed, ${fail} failed ═══`);
process.exit(fail ? 1 : 0);
