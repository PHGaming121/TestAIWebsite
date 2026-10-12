/**
 * End-to-end smoke test: boot the real index.html in jsdom, stub the CodeCraft
 * API, and drive the two new features the way a user would.
 *
 * Requires jsdom:  npm install --no-save jsdom  &&  node --test "tests/*.test.mjs"
 * The test skips itself (rather than failing) when jsdom is not installed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let JSDOM;
try {
  ({ JSDOM } = await import('jsdom'));
} catch (_) {
  JSDOM = null;
}

const HTML = readFileSync(join(root, 'index.html'), 'utf8');

const WORKSPACE_FILES = {
  'CLAUDE.md': '# House rules\n\nAlways wrap API calls in the retry helper. Never log tokens.\n',
  '.claude/skills/release-notes/SKILL.md': [
    '---',
    'name: release-notes',
    'description: Turn a list of merged pull requests into release notes. Use when the user asks for a changelog or release summary.',
    'allowed-tools:',
    '  - Read',
    '---',
    '',
    '# Release notes',
    '',
    'Group changes by type and mention breaking changes first.'
  ].join('\n'),
  'src/api.js': [
    '// src/api.js',
    '// Wrapper with retry. Comments here are intentionally verbose to give the',
    '// token saver something realistic to work with in agent mode.',
    '/**',
    ' * Fetch with retry.',
    ' * @param {string} url',
    ' */',
    'export async function get(url) {',
    '  // three attempts total, doubling the delay each time',
    '  for (let attempt = 1; attempt <= 3; attempt += 1) {',
    '    // NOTE: keep this in sync with the gateway timeout',
    '    const response = await fetch(url);',
    '    if (response.ok) return response.json();',
    '    await new Promise(resolve => setTimeout(resolve, attempt * 250));',
    '  }',
    '  throw new Error("gave up");',
    '}'
  ].join('\n')
};

function boot({ fetchImpl } = {}) {
  const dom = new JSDOM(HTML, {
    runScripts: 'dangerously',
    resources: undefined,
    url: 'https://example.github.io/TestAIWebsite/',
    pretendToBeVisual: true,
    beforeParse(window) {
      window.fetch = fetchImpl || (async () => { throw new Error('fetch not stubbed'); });
      window.showDirectoryPicker = undefined;
      window.HTMLDialogElement.prototype.showModal = function showModal() {
        this.setAttribute('open', '');
        this.open = true;
      };
      window.HTMLDialogElement.prototype.close = function close() {
        this.removeAttribute('open');
        this.open = false;
        this.dispatchEvent(new window.Event('close'));
      };
      window.requestAnimationFrame = callback => window.setTimeout(() => callback(0), 0);
    }
  });
  // jsdom does not execute external <script src> unless resources are enabled.
  const scripts = ['compressor.js', 'skills.js', 'app.js'];
  for (const file of scripts) {
    const element = dom.window.document.createElement('script');
    element.textContent = readFileSync(join(root, file), 'utf8');
    dom.window.document.body.append(element);
  }
  return dom;
}

const maybe = JSDOM ? test : test.skip;

maybe('the page boots, renders the new panels and reports no console errors', () => {
  const errors = [];
  const dom = boot();
  const { window } = dom;
  window.addEventListener('error', event => errors.push(event.message));
  assert.equal(window.ForgeCompressor != null, true, 'compressor module loaded');
  assert.equal(window.ForgeSkills != null, true, 'skills module loaded');
  assert.equal(window.document.querySelector('#saverHeadline').textContent.includes('Nothing compressed'), true);
  assert.equal(window.document.querySelector('#skillsHeadline').textContent.includes('No skill markdown'), true);
  assert.deepEqual(errors, []);
});

maybe('connecting with a key loads models and enables the saver', async () => {
  const calls = [];
  const dom = boot({
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });
      if (String(url).endsWith('/v1/models')) {
        return new Response(JSON.stringify({ data: [{ id: 'claude-opus-4.8', capabilities: ['tools'], context_window: 200000, pricing: { input_per_1k: 0.003, output_per_1k: 0.015 } }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      return new Response(JSON.stringify({ error: { message: 'unexpected call' } }), { status: 500 });
    }
  });
  const { window } = dom;
  const document = window.document;
  document.querySelector('#apiSettingsButton').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  document.querySelector('#apiKeyInput').value = 'cc_test_key';
  document.querySelector('#apiForm').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await new Promise(resolve => window.setTimeout(resolve, 60));
  assert.equal(document.querySelector('#apiLabel').textContent, 'CodeCraft ready');
  assert.equal(calls.length >= 1, true);
  assert.equal(calls[0].url, 'https://codecraftapi.com/v1/models');
});

maybe('the workspace scan feeds skills into the system message and compresses the request', async () => {
  const requests = [];
  const dom = boot({
    fetchImpl: async (url, options = {}) => {
      if (String(url).endsWith('/v1/models')) {
        return new Response(JSON.stringify({ data: [{ id: 'claude-opus-4.8', capabilities: ['tools', 'streaming'], context_window: 200000 }] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      requests.push(JSON.parse(options.body));
      return new Response(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'Loaded the retry helper and the release-notes skill.' } }],
        usage: { total_tokens: 120 }
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
  });
  const { window } = dom;
  const document = window.document;

  // Connect.
  document.querySelector('#apiSettingsButton').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  document.querySelector('#apiKeyInput').value = 'cc_test_key';
  document.querySelector('#apiForm').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await new Promise(resolve => window.setTimeout(resolve, 40));

  // Simulate a connected workspace by handing the app its file map.
  const files = window.document.defaultView;
  const app = window;
  // Reach into the module scope the same way the workspace UI does: through the
  // file input event, which is the supported path.
  const input = document.querySelector('#localFileInput');
  Object.defineProperty(input, 'files', {
    value: Object.entries(WORKSPACE_FILES).map(([path, content]) => ({
      name: path.split('/').pop(),
      webkitRelativePath: `demo-project/${path}`,
      size: content.length,
      text: async () => content
    }))
  });
  input.dispatchEvent(new window.Event('change', { bubbles: true }));
  await new Promise(resolve => window.setTimeout(resolve, 80));

  assert.equal(app.document.querySelector('#skillsBadge').textContent, 'LOADED');
  assert.equal(app.document.querySelector('#skillsHeadline').textContent.includes('2 Claude markdown entries loaded'), true);
  const miniNames = [...app.document.querySelectorAll('#skillMiniList strong')].map(node => node.textContent);
  assert.deepEqual(miniNames.sort(), ['CLAUDE.md', 'release-notes']);
  void files;

  // Ask the agent something with stale, comment-heavy context in play.
  const prompt = app.document.querySelector('#promptInput');
  prompt.value = 'Read src/api.js and tell me whether the retry delay is safe.';
  app.document.querySelector('.mode-tab[data-mode="chat"]').dispatchEvent(new app.MouseEvent('click', { bubbles: true }));
  app.document.querySelector('#promptForm').dispatchEvent(new app.Event('submit', { bubbles: true, cancelable: true }));
  await new Promise(resolve => window.setTimeout(resolve, 120));

  assert.equal(requests.length, 1, 'exactly one completion request was sent');
  const payload = requests[0];
  assert.equal(payload.model, 'claude-opus-4.8');
  assert.equal(payload.messages[0].role, 'system');
  assert.ok(payload.messages[0].content.includes('<project_instructions path="CLAUDE.md">'), 'memory is injected');
  assert.ok(payload.messages[0].content.includes('- release-notes —'), 'skill index is injected');
  assert.ok(payload.messages[0].content.includes('<skill name="release-notes"'), 'chat mode inlines the skill body');
  assert.ok(payload.messages[0].content.includes('Never log tokens'), 'instruction text survives compression');

  // The badge on the answer reflects a measured saving.
  const chips = [...app.document.querySelectorAll('.meta-chip')].map(node => node.textContent);
  assert.ok(chips.some(text => text.includes('tokens saved')), `expected a saver chip, got ${chips.join(' | ')}`);
  assert.ok(chips.some(text => text.includes('Claude file')), `expected a skills chip, got ${chips.join(' | ')}`);
  assert.equal(app.document.querySelector('#saverRuns').textContent, '1');
});

maybe('agent mode sends the skill tools and compresses a re-read of the same file', async () => {
  const requests = [];
  let round = 0;
  const dom = boot({
    fetchImpl: async (url, options = {}) => {
      if (String(url).endsWith('/v1/models')) {
        return new Response(JSON.stringify({ data: [{ id: 'claude-opus-4.8', capabilities: ['tools'], context_window: 200000 }] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      requests.push(JSON.parse(options.body));
      round += 1;
      if (round === 1) {
        return new Response(JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'Let me read the file.', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'src/api.js' }) } }] } }]
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (round === 2) {
        return new Response(JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'Read it again to be sure.', tool_calls: [{ id: 'call_2', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'src/api.js' }) } }] } }]
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'The retry delay doubles, so it is fine.' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
  });
  const { window } = dom;
  const document = window.document;
  document.querySelector('#apiSettingsButton').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  document.querySelector('#apiKeyInput').value = 'cc_test_key';
  document.querySelector('#apiForm').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await new Promise(resolve => window.setTimeout(resolve, 40));

  const input = document.querySelector('#localFileInput');
  Object.defineProperty(input, 'files', {
    value: Object.entries(WORKSPACE_FILES).map(([path, content]) => ({
      name: path.split('/').pop(),
      webkitRelativePath: `demo-project/${path}`,
      size: content.length,
      text: async () => content
    }))
  });
  input.dispatchEvent(new window.Event('change', { bubbles: true }));
  await new Promise(resolve => window.setTimeout(resolve, 80));

  document.querySelector('.mode-tab[data-mode="agent"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  document.querySelector('#promptInput').value = 'Check whether the retry delay is safe.';
  document.querySelector('#promptForm').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await new Promise(resolve => window.setTimeout(resolve, 200));

  assert.equal(requests.length, 3, 'two tool rounds plus a final answer');
  const toolNames = (requests[0].tools || []).map(tool => tool.function.name);
  assert.ok(toolNames.includes('read_skill'), `skill tools were sent: ${toolNames.join(', ')}`);
  assert.equal(requests[0].tool_choice, 'auto');

  const toolMessages = requests[2].messages.filter(message => message.role === 'tool');
  assert.equal(toolMessages.length, 2);
  assert.ok(toolMessages[0].content.includes('[forge:compressed]'), 'first read is comment-trimmed');
  assert.ok(toolMessages[0].content.includes('NOTE: keep this in sync'), 'directive comments survive the trim');
  assert.ok(toolMessages[1].content.includes('identical to the earlier read'), `second read is a pointer, got: ${toolMessages[1].content.slice(0, 90)}`);
  assert.ok(!toolMessages[1].content.includes('export async function get'), 'the duplicate body is not sent twice');
  assert.ok(toolMessages[0].content.includes('export async function get'), 'the first copy keeps the code');

  const chip = [...document.querySelectorAll('.meta-chip')].find(node => node.textContent.includes('tokens saved'));
  assert.ok(chip, 'agent answer carries a savings chip');
  assert.ok(!/≤0/.test(document.querySelector('#saverChipSaving').textContent));
});

maybe('the benchmark button shows measured savings in the dialog', async () => {
  const dom = boot();
  const { window } = dom;
  const document = window.document;
  document.querySelector('#saverChip').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  document.querySelector('#saverBenchmarkButton').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await new Promise(resolve => window.setTimeout(resolve, 30));
  const meta = document.querySelector('#saverReportMeta').textContent;
  assert.match(meta, /→/);
  const rows = [...document.querySelectorAll('.technique-row span')].map(node => node.textContent);
  assert.ok(rows.length >= 3, `expected several techniques, got ${rows.join(' | ')}`);
  assert.ok(rows.some(text => text.includes('Stale file payload pruning')));
});

maybe('the connection doctor explains a blocked request', async () => {
  const dom = boot({
    fetchImpl: async () => { throw new TypeError('Failed to fetch'); }
  });
  const { window } = dom;
  const document = window.document;
  document.querySelector('#runDoctorButton').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await new Promise(resolve => window.setTimeout(resolve, 120));
  const rows = [...document.querySelectorAll('.doctor-row')].map(row => `${row.className}|${row.textContent}`);
  assert.ok(rows.some(text => text.includes('is-fail') && text.includes('blocked cross-origin request')), 'failing check is explained');
  assert.ok(rows.some(text => text.includes('Reaching the API host')));
  assert.ok(document.querySelector('#doctorSteps').children.length >= 4);
});

maybe('a pasted skill is added, validated and injected', async () => {
  const dom = boot();
  const { window } = dom;
  const document = window.document;
  document.querySelector('#skillsOpenButton').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  document.querySelector('#skillsPasteButton').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  document.querySelector('#skillNameInput').value = 'Release Notes';
  document.querySelector('#skillBodyInput').value = '---\nname: Release Notes\ndescription: turns merged PRs into release notes\n---\n\nGroup by type.';
  document.querySelector('#skillEditorSave').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await new Promise(resolve => window.setTimeout(resolve, 30));
  assert.equal(document.querySelector('#skillsBadge').textContent, 'CHECK');
  const badges = [...document.querySelectorAll('.skill-badge')].map(node => node.textContent);
  assert.ok(badges.includes('SKILL'));
  const problems = [...document.querySelectorAll('.skill-problems li')].map(node => node.textContent);
  assert.ok(problems.some(text => text.includes('kebab-case')), `expected a name warning, got ${problems.join(' | ')}`);
});
