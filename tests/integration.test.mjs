/**
 * Second end-to-end pass: the GitHub flow (token → repo → blobs/tree/commit/ref →
 * Pages) and the Puter cloud workspace + deploy tool, with a mocked api.github.com.
 */
import { JSDOM } from 'jsdom';
import fs from 'fs';
import path from 'node:path';
const REPO_ROOT = path.resolve(import.meta.dirname, '..');

const html = fs.readFileSync(`${REPO_ROOT}/index.html`, 'utf8');
const dom = new JSDOM(html, { url: 'https://phgaming121.github.io/TestAIWebsite/', pretendToBeVisual: true, runScripts: 'outside-only' });
const w = dom.window;
for (const k of ['document', 'localStorage', 'sessionStorage', 'location', 'HTMLElement', 'Element', 'Node', 'Event',
  'CustomEvent', 'FileReader', 'Blob', 'File', 'CSS', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame',
  'MouseEvent', 'KeyboardEvent']) {
  if (w[k] !== undefined) { try { Object.defineProperty(globalThis, k, { value: w[k], configurable: true, writable: true }); } catch { /* ignore */ } }
}
Object.defineProperty(globalThis, 'window', { value: w, configurable: true, writable: true });
Object.defineProperty(globalThis, 'navigator', { value: w.navigator, configurable: true, writable: true });
globalThis.indexedDB = undefined;
w.scrollTo = () => {};
await import('/tmp/bundle/vendor.bundle.js');

/* ── GitHub API mock ───────────────────────────────────── */
const gh = { calls: [], blobs: {}, repoExists: false, pagesEnabled: false, refs: {} };
const json = (obj, status = 200, headers = {}) => ({
  ok: status >= 200 && status < 300, status,
  headers: { get: (k) => headers[k.toLowerCase()] ?? null },
  json: async () => obj, text: async () => JSON.stringify(obj),
});

async function mockFetch(url, opts = {}) {
  const u = String(url);
  if (!u.startsWith('https://api.github.com')) throw new Error('unexpected fetch: ' + u);
  const method = (opts.method || 'GET').toUpperCase();
  const path = u.replace('https://api.github.com', '');
  const body = opts.body ? JSON.parse(opts.body) : null;
  gh.calls.push({ method, path, body });

  if (path === '/user' && method === 'GET') return json({ login: 'PHGaming121', name: 'PH', avatar_url: 'https://x/a.png', public_repos: 3, private_repos: 1 }, 200, { 'x-oauth-scopes': 'repo, gist' });
  if (path.startsWith('/user/repos') && method === 'GET') return json([
    { full_name: 'PHGaming121/TestAIWebsite', private: true, default_branch: 'main', description: 'test', size: 12 },
    { full_name: 'PHGaming121/old-project', private: false, default_branch: 'main', size: 4 },
  ]);
  if (path === '/user/repos' && method === 'POST') { gh.repoExists = true; return json({ full_name: `PHGaming121/${body.name}`, html_url: `https://github.com/PHGaming121/${body.name}`, default_branch: 'main', private: body.private, size: 0 }, 201); }

  const repoMatch = path.match(/^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/);
  if (repoMatch) {
    const [, , , rest] = repoMatch;
    if (!rest || rest === '/') {
      if (!gh.repoExists) return json({ message: 'Not Found' }, 404);
      return json({ full_name: 'PHGaming121/snake-game', default_branch: 'main', private: false, size: 8, html_url: 'https://github.com/PHGaming121/snake-game' });
    }
    if (rest === '/git/blobs' && method === 'POST') {
      const sha = 'blob' + Object.keys(gh.blobs).length;
      gh.blobs[sha] = body.content;
      return json({ sha, url: 'u' }, 201);
    }
    if (rest === '/git/trees' && method === 'POST') return json({ sha: 'tree123', tree: body.tree }, 201);
    if (rest === '/git/commits' && method === 'POST') return json({ sha: 'commitabc123def', tree: { sha: body.tree }, message: body.message }, 201);
    if (rest === '/git/refs' && method === 'POST') { gh.refs[body.ref] = body.sha; return json({ ref: body.ref, object: { sha: body.sha } }, 201); }
    if (/^\/git\/ref\/heads\//.test(rest) && method === 'GET') {
      if (!gh.refs['refs/heads/main'] && !gh.repoExisted) return json({ message: 'Not Found' }, 404);
      return json({ ref: 'refs/heads/main', object: { sha: 'oldsha111' } });
    }
    if (/^\/git\/refs\/heads\//.test(rest) && method === 'PATCH') { gh.refs[body.sha ? 'refs/heads/main' : 'x'] = body.sha; return json({ ref: 'refs/heads/main', object: { sha: body.sha } }); }
    if (/^\/git\/commits\//.test(rest) && method === 'GET') return json({ sha: 'oldsha111', tree: { sha: 'basetree999' } });
    if (rest === '/pages' && method === 'GET') return gh.pagesEnabled ? json({ html_url: 'https://phgaming121.github.io/snake-game/', status: 'built', source: { branch: 'main' } }) : json({ message: 'Not Found' }, 404);
    if (rest === '/pages' && method === 'POST') { gh.pagesEnabled = true; return json({ html_url: 'https://phgaming121.github.io/snake-game/', status: 'building' }, 201); }
    if (rest === '/pages' && method === 'PUT') { gh.pagesEnabled = true; return json({ html_url: 'https://phgaming121.github.io/snake-game/', status: 'building' }); }
    if (rest === '/branches' && method === 'GET') return json([{ name: 'main' }]);
    if (rest.startsWith('/git/trees/') && method === 'GET') return json({ tree: [{ path: 'README.md', type: 'blob', size: 12 }] });
    if (rest.startsWith('/contents/') && method === 'GET') return json({ encoding: 'base64', content: btoa('hello repo') });
    if (rest === '/pulls' && method === 'POST') return json({ number: 7, html_url: 'https://github.com/x/pull/7' });
    if (rest === '/issues' && method === 'POST') return json({ number: 3, html_url: 'https://github.com/x/issues/3' });
  }
  return json({ message: `mock: unhandled ${method} ${path}` }, 404);
}
Object.defineProperty(globalThis, 'fetch', { value: mockFetch, configurable: true, writable: true });
w.fetch = mockFetch;

/* ── Puter mock (with a working cloud FS) ──────────────── */
const fsStore = new Map();
let scripted = [];
function asyncIterable(items) { return { [Symbol.asyncIterator]: async function* () { for (const it of items) { await new Promise((r) => setTimeout(r, 1)); yield it; } } }; }
const puterMock = {
  env: 'web', appID: null, APIOrigin: 'https://api.puter.com',
  ai: {
    async chat(messages, options = {}) {
      const script = scripted.shift();
      if (options?.stream) return asyncIterable(script || [{ type: 'text', text: 'ok' }]);
      return { message: { content: 'ok' }, usage: {} };
    },
    async listModels() { return [{ id: 'claude-sonnet-4-5', provider: 'anthropic', supports_tools: true }]; },
    async txt2img() { return new w.Blob(['imgbytes'], { type: 'image/png' }); },
  },
  auth: { isSignedIn: () => true, async signIn() { return true; }, async signOut() {}, async getUser() { return { username: 'tester', uuid: 'u1' }; } },
  kv: { async set() { return true; }, async get() { return null; }, async del() { return true; }, async list() { return []; } },
  fs: {
    homePath: '/tester',
    async mkdir(p) { if (fsStore.has(p)) throw { code: 'item_with_same_name_already_exists', message: 'Item with the same name already exists' }; fsStore.set(p, { is_dir: true, name: p.split('/').pop(), path: p }); return fsStore.get(p); },
    async write(p, data) { const content = typeof data === 'string' ? data : await (data?.text?.() ?? Promise.resolve('')); fsStore.set(p, { is_dir: false, name: p.split('/').pop(), path: p, size: content.length, content }); return fsStore.get(p); },
    async read(p) { const v = fsStore.get(p); if (!v || v.is_dir) throw { code: 'subject_does_not_exist', message: 'File or directory not found' }; return new w.Blob([v.content ?? '']); },
    async readdir(p) { const prefix = p.replace(/\/$/, ''); const out = []; for (const [k, v] of fsStore) { if (!k.startsWith(prefix + '/')) continue; const rest = k.slice(prefix.length + 1); if (!rest.includes('/')) out.push(v); } return out; },
    async delete(p) { for (const k of [...fsStore.keys()]) if (k === p || k.startsWith(p + '/')) fsStore.delete(k); return true; },
    async rename(p, newName) { const v = fsStore.get(p); if (!v) throw { message: 'not found' }; fsStore.delete(p); fsStore.set(`${p.split('/').slice(0, -1).join('/')}/${newName}`, { ...v, name: newName }); return v; },
    async move() { return {}; },
    async stat(p) { return fsStore.get(p) || null; },
    async space() { return { used: 2048, capacity: 1073741824 }; },
  },
  hosting: { async create(sub, dir) { return { subdomain: sub, root_dir: dir }; }, async update(sub, dir) { return { subdomain: sub, root_dir: dir }; }, async list() { return [{ subdomain: 'demo' }]; }, async delete() { return true; } },
};
w.puter = puterMock; globalThis.puter = puterMock;

/* ── boot ──────────────────────────────────────────────── */
const errors = [];
dom.virtualConsole.on('jsdomError', (e) => errors.push('jsdomError: ' + (e.detail?.stack || e.stack || e.message)));
w.addEventListener('error', (e) => errors.push(String(e.error?.stack || e.message)));
process.on('unhandledRejection', (r) => errors.push('unhandledRejection: ' + (r?.stack || r)));

w.localStorage.setItem('pp.settings.v1', JSON.stringify({ mode: 'agent', autoApprove: true, stream: true, maxSteps: 8 }));
await import(`${REPO_ROOT}/js/app.js`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
await wait(400);

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${extra}`); } };
const $ = (s) => w.document.querySelector(s);
const $$ = (s) => [...w.document.querySelectorAll(s)];
const click = (e) => e.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
const setVal = (e, v) => { e.value = v; e.dispatchEvent(new w.Event('input', { bubbles: true })); };

console.log('\n── github pane: connect');
click($$('.wp-tab').find((t) => t.dataset.pane === 'github'));
await wait(100);
const tokenInput = $('#gh-pane input[type="password"]');
ok('token input present', !!tokenInput);
setVal(tokenInput, 'ghp_faketoken');
click($$('.gh-pane .btn.primary').find((b) => b.textContent === 'Connect'));
await wait(400);
ok('token verified via /user', gh.calls.some((c) => c.path === '/user'));
ok('connected notice shown', /Connected as/.test($('#gh-pane').textContent), $('#gh-pane').textContent.slice(0, 120));
ok('sidebar pill shows login', $('#gh-pill').textContent === 'PHGaming121', $('#gh-pill').textContent);
ok('repos loaded into select', $$('#gh-pane select option').length >= 2);
ok('scopes displayed', /repo, gist/.test($('#gh-pane').textContent));

console.log('\n── github pane: push + pages');
// put some files in the workspace first
const { workspace } = await import(`${REPO_ROOT}/js/workspace.js`);
await workspace().write('index.html', '<!doctype html><title>Snake</title><h1>Snake</h1>');
await workspace().write('styles.css', 'body{background:#111}');
await workspace().write('game.js', 'console.log("game")');
// pick an existing repo from the dropdown…
const repoSelect = $('#gh-pane select');
repoSelect.value = 'PHGaming121/old-project';
repoSelect.dispatchEvent(new w.Event('change', { bubbles: true }));
await wait(400);   // settings writes are debounced
ok('selecting a repo updates settings', JSON.parse(w.localStorage.getItem('pp.settings.v1')).githubRepo === 'PHGaming121/old-project');
// …then type a brand new owner/repo (the realistic "publish my project" path)
const manual = $$('#gh-pane input.inp.mono').find((i) => i.placeholder === 'or type owner/repo');
setVal(manual, 'PHGaming121/snake-game');
click($$('.gh-pane .btn.tiny').find((b) => b.textContent === 'select'));
await wait(300);
ok('manual repo selection stored', JSON.parse(w.localStorage.getItem('pp.settings.v1')).githubRepo === 'PHGaming121/snake-game');
const pushMsg = $$('#gh-pane input.inp').find((i) => i.value === 'Update from Puter Playground');
setVal(pushMsg, 'Add snake game');
const pushBtn = $$('.gh-pane .btn.primary').find((b) => b.textContent.includes('Push workspace'));
ok('push button present', !!pushBtn);
click(pushBtn);
await wait(1200);
const log = $('.gh-pane .logbox')?.textContent || '';
ok('repo auto-created when missing', gh.calls.some((c) => c.method === 'POST' && c.path === '/user/repos'), log.slice(0, 300));
ok('3 blobs uploaded', gh.calls.filter((c) => c.path.endsWith('/git/blobs')).length === 3, String(gh.calls.filter((c) => c.path.endsWith('/git/blobs')).length));
ok('tree created', gh.calls.some((c) => c.path.endsWith('/git/trees') && c.method === 'POST'));
ok('commit created with message', gh.calls.some((c) => c.path.endsWith('/git/commits') && c.body?.message === 'Add snake game'));
ok('ref created/updated to main', gh.calls.some((c) => /\/git\/refs?$/.test(c.path) && (c.method === 'POST' || c.method === 'PATCH')));
ok('pages enabled', gh.pagesEnabled === true);
ok('log reports the commit', /commitabc123|commit abc123|✓ commit/.test(log), log.slice(-300));
ok('log reports pages url', /phgaming121\.github\.io\/snake-game/.test(log), log.slice(-300));
ok('blob content is base64 of the file', Object.values(gh.blobs).some((b64) => Buffer.from(b64, 'base64').toString().includes('Snake')));

console.log('\n── agent github_push tool (end to end)');
gh.calls.length = 0; gh.pagesEnabled = false;
click($('#btn-new-chat'));
await wait(120);
scripted = [
  [{ type: 'tool_use', id: 'g1', name: 'github_status', input: {} }],
  [{ type: 'tool_use', id: 'g2', name: 'github_push', input: { repo: 'PHGaming121/snake-game', branch: 'main', message: 'Ship it from the agent', enable_pages: true } }],
  [{ type: 'tool_use', id: 'g3', name: 'finish', input: { summary: 'Pushed and published.' } }],
];
setVal($('#input'), 'push this project to github and turn on pages');
click($('#btn-send'));
await wait(1600);
ok('agent called /user for status', gh.calls.some((c) => c.path === '/user'));
ok('agent uploaded blobs', gh.calls.filter((c) => c.path.endsWith('/git/blobs')).length >= 3, String(gh.calls.filter((c) => c.path.endsWith('/git/blobs')).length));
ok('agent enabled pages', gh.pagesEnabled === true);
const transcript = $('#messages').textContent;
ok('tool result mentions the push', /Pushed \d+ file/.test(transcript), transcript.slice(-400));
ok('tool result mentions the live URL', /github\.io|github\.com/.test(transcript));
ok('finish summary rendered', /Pushed and published/.test(transcript));

console.log('\n── puter cloud workspace backend');
const backends = $$('#backend-list .backend');
const puterRow = backends.find((b) => b.textContent.includes('Puter cloud'));
ok('puter backend enabled (signed in)', !puterRow.classList.contains('dis'));
click(puterRow);
await wait(600);
ok('backend switched to puter', $('#ws-pill').textContent === 'puter', $('#ws-pill').textContent);
ok('puter workspace root created', [...fsStore.keys()].some((k) => k.includes('PlaygroundWorkspace')), [...fsStore.keys()].slice(0, 5).join(','));
await workspace().write('site/index.html', '<h1>puter hosted</h1>');
await wait(200);
ok('file written into puter fs', [...fsStore.keys()].some((k) => k.endsWith('site/index.html')), [...fsStore.keys()].join(','));
ok('list reads it back', (await workspace().list()).some((e) => e.path === 'site/index.html'));
ok('read returns content', (await workspace().read('site/index.html')).includes('puter hosted'));
ok('describe mentions puter', JSON.stringify(await workspace().describe()).includes('puter'));

console.log('\n── deploy_to_puter tool');
const { TOOL_MAP } = await import(`${REPO_ROOT}/js/tools.js`);
const ctx = { ws: workspace(), settings: JSON.parse(w.localStorage.getItem('pp.settings.v1')), onOutput: () => {}, onProgress: () => {}, touch: () => {} };
const deployRes = await TOOL_MAP.get('deploy_to_puter').run(ctx, { subdomain: 'my-snake' });
ok('deploy reports the puter.site url', /my-snake\.puter\.site/.test(deployRes), deployRes);
ok('deploy copied files to the sites dir', [...fsStore.keys()].some((k) => k.includes('playground-sites/my-snake')), [...fsStore.keys()].filter(k=>k.includes('sites')).join(','));

console.log('\n── generate_image tool');
const imgRes = await TOOL_MAP.get('generate_image').run(ctx, { prompt: 'a red cube', path: 'assets/cube.png' });
ok('image tool saved a file', /assets\/cube\.png/.test(imgRes), imgRes);
ok('image bytes present in puter fs', [...fsStore.keys()].some((k) => k.endsWith('assets/cube.png')));

console.log('\n── github tools without a repo selected');
const st = await TOOL_MAP.get('github_list_repos').run(ctx, { search: 'old' });
ok('github_list_repos works', /old-project/.test(st), st);
const treeRes = await TOOL_MAP.get('github_list_files').run(ctx, { repo: 'PHGaming121/snake-game' });
ok('github_list_files works', /README\.md/.test(treeRes), treeRes);
const readRes = await TOOL_MAP.get('github_read_file').run(ctx, { repo: 'PHGaming121/snake-game', path: 'README.md' });
ok('github_read_file decodes base64', readRes.includes('hello repo'), readRes);
const prRes = await TOOL_MAP.get('github_open_pr').run(ctx, { repo: 'PHGaming121/snake-game', title: 'T', head: 'feature', body: 'b' });
ok('github_open_pr works', /pull\/7/.test(prRes), prRes);
const issueRes = await TOOL_MAP.get('github_create_issue').run(ctx, { repo: 'PHGaming121/snake-game', title: 'Bug' });
ok('github_create_issue works', /issues\/3/.test(issueRes), issueRes);
const pagesRes = await TOOL_MAP.get('github_enable_pages').run(ctx, { repo: 'PHGaming121/snake-game', branch: 'main' });
ok('github_enable_pages works', /github\.io/.test(pagesRes), pagesRes);

console.log('\n── errors');
ok('no runtime errors', errors.length === 0, errors.slice(0, 3).join(' | '));

console.log(`\n═══ ${pass} passed, ${fail} failed ═══`);
process.exit(fail ? 1 : 0);
