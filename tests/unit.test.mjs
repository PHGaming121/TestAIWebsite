/**
 * Unit tests for the two Forge engines.
 *
 * Run with:  node --test tests/   (Node 20+)
 * No dependencies, no network, no browser required.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const C = require('../compressor.js');
const S = require('../skills.js');

/* ------------------------------------------------------------------ compressor */

test('estimator is monotonic and roughly four characters per token', () => {
  assert.equal(C.estimateTokens(''), 0);
  const short = C.estimateTokens('hello world');
  const long = C.estimateTokens('hello world '.repeat(40));
  assert.ok(long > short * 30, 'longer text must cost more');
  const prose = C.estimateTokens('The quick brown fox jumps over the lazy dog. '.repeat(10));
  const ratio = 'The quick brown fox jumps over the lazy dog. '.repeat(10).length / prose;
  assert.ok(ratio > 2.5 && ratio < 6, `characters per token was ${ratio}`);
});

test('comment stripping never touches string or regex contents', () => {
  const source = [
    'const url = "https://example.com/a//b";',
    "const hash = '# not-a-comment';",
    'const re = /a\\/\\/b/; // trailing comment',
    'const division = total / count; // not a regex',
    'const tpl = `literal // text`;',
    '/* block */ const kept = 1;'
  ].join('\n');
  const { text } = C.stripComments(source, 'js');
  assert.ok(text.includes('"https://example.com/a//b"'), 'url in a string survives');
  assert.ok(text.includes("'# not-a-comment'"), 'hash inside a string survives');
  assert.ok(text.includes('/a\\/\\/b/'), 'regex literal survives');
  assert.ok(text.includes('total / count;'), 'division survives');
  assert.ok(text.includes('`literal // text`'), 'template literal survives');
  assert.ok(!text.includes('trailing comment'), 'line comment removed');
  assert.ok(!text.includes('/* block */'), 'block comment removed');
});

test('important comments are preserved', () => {
  const source = [
    '#!/usr/bin/env node',
    '// eslint-disable-next-line no-console',
    '// @ts-expect-error intentional',
    '// TODO: fix this later',
    '# noqa: E501',
    '// just noise'
  ].join('\n');
  const { text } = C.stripComments(source, 'js');
  assert.ok(text.includes('#!/usr/bin/env node'));
  assert.ok(text.includes('eslint-disable-next-line'));
  assert.ok(text.includes('@ts-expect-error'));
  assert.ok(text.includes('TODO'));
  assert.ok(!text.includes('just noise'));
});

test('real javaScript still parses after stripping', () => {
  const directory = mkdtempSync(join(tmpdir(), 'forge-strip-'));
  try {
    for (const file of ['app.js', 'compressor.js', 'skills.js']) {
      const source = require('node:fs').readFileSync(join(require('node:path').resolve(import.meta.dirname, '..'), file), 'utf8');
      const { text } = C.stripComments(source, C.langFromPath(file));
      const target = join(directory, file);
      writeFileSync(target, text);
      execFileSync(process.execPath, ['--check', target]);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the newest user message is never rewritten', () => {
  const messages = [
    { role: 'system', content: 'You are a helper.' },
    { role: 'user', content: 'old question' },
    { role: 'assistant', content: 'Sure thing!  In order to   answer, I will   explain.  ' },
    { role: 'user', content: 'Please do NOT change   this   message.  Thanks!' }
  ];
  const { messages: out } = C.compressMessages(messages, { profile: 'aggressive' });
  const lastUser = out.filter(message => message.role === 'user').pop();
  assert.equal(lastUser.content, 'Please do NOT change   this   message.  Thanks!');
});

test('balanced profile reaches the documented saving range on the sample', () => {
  const six = C.benchmark({ profile: 'balanced', turns: 6 });
  const twenty = C.benchmark({ profile: 'balanced', turns: 20 });
  assert.ok(six.savedPct >= 38, `6-turn saving was ${six.savedPct}%`);
  assert.ok(twenty.savedPct >= 60, `20-turn saving was ${twenty.savedPct}%`);
  assert.ok(twenty.savedPct <= 95, 'claim must stay credible');
  assert.equal(twenty.tokensAfter, C.estimateMessages(C.compressMessages(C.buildSample(20), { profile: 'balanced' }).messages));
});

test('safe profile keeps every comment', () => {
  const result = C.compressText('```js\n// keep me\nconst a = 1;\n```', { profile: 'safe' });
  assert.ok(result.text.includes('// keep me'));
});

test('off profile is a byte-for-byte passthrough', () => {
  const messages = C.buildSample(4);
  const { messages: out, report } = C.compressMessages(messages, { profile: 'off' });
  assert.deepEqual(out.map(m => m.content), messages.map(m => m.content));
  assert.equal(report.savedTokens, 0);
});

test('a duplicate read inside one request becomes a pointer, never the only copy', () => {
  const body = Array.from({ length: 40 }, (_, i) => `const value${i} = ${i}; // line ${i}`).join('\n');
  const messages = [
    { role: 'system', content: 's' },
    { role: 'user', content: 'read it' },
    { role: 'assistant', content: 'ok' },
    { role: 'tool', content: `FILE: src/a.js\n${body}` },
    { role: 'user', content: 'again' },
    { role: 'assistant', content: 'ok' },
    { role: 'tool', content: `FILE: src/a.js\n${body}` },
    { role: 'user', content: 'and again' },
    { role: 'assistant', content: 'ok' }
  ];
  const { messages: out, report } = C.compressMessages(messages, { profile: 'balanced', keepRecentTurns: 1, pruneOldPayloads: false });
  const repeats = report.techniques.find(item => item.id === 'repeat-suppression');
  assert.ok(repeats && repeats.hits === 1, 'expected exactly one repeat-suppression hit');
  const tools = out.filter(message => message.role === 'tool');
  assert.ok(tools[0].content.includes('const value39'), 'the first copy stays in the payload');
  assert.ok(tools[1].content.includes('identical to the earlier read'), 'the duplicate is a pointer');
  assert.ok(!tools[1].content.includes('const value39'), 'the duplicate body is dropped');
});

test('a pruned payload never becomes a suppression target', () => {
  // The provider API is stateless: if the only copy is pruned, a later read
  // must still carry its content instead of pointing at nothing.
  const body = Array.from({ length: 40 }, (_, i) => `const value${i} = ${i}; // line ${i}`).join('\n');
  const messages = [
    { role: 'system', content: 's' },
    { role: 'user', content: 'read it' },
    { role: 'assistant', content: 'ok' },
    { role: 'tool', content: `FILE: src/a.js\n${body}` },
    { role: 'user', content: 'again' },
    { role: 'assistant', content: 'ok' },
    { role: 'tool', content: `FILE: src/a.js\n${body}` },
    { role: 'user', content: 'and again' },
    { role: 'assistant', content: 'ok' }
  ];
  const { messages: out, report } = C.compressMessages(messages, { profile: 'balanced', keepRecentTurns: 1, pruneOldPayloads: true });
  assert.ok(report.techniques.some(item => item.id === 'payload-pruning' && item.hits === 1));
  const tools = out.filter(message => message.role === 'tool');
  assert.ok(tools[0].content.includes('pruned from older context'));
  assert.ok(tools[1].content.includes('const value39'), 'the surviving read keeps its full body');
  const dangling = tools.filter(message => message.content.includes('identical to the earlier read'));
  assert.deepEqual(dangling, [], 'no pointer may reference a copy that is not in the payload');
});

test('a realistic agent session with commented files saves more than a chat', () => {
  const heavy = [];
  for (let turn = 0; turn < 12; turn += 1) {
    heavy.push({ role: 'user', content: `Please inspect module ${turn} and explain the retry strategy in detail.` });
    heavy.push({ role: 'assistant', content: `Sure thing! In order to answer that properly I should read the file first, then walk through the logic step by step and highlight anything that looks risky.\n\n\`\`\`js\n${'// assistant sketch\nconst x = 1;\n'.repeat(6)}\`\`\`` });
    heavy.push({ role: 'tool', content: `FILE: src/module${turn % 3}.js\n${'// helper comment line that exists only for humans\nexport function run(input) {\n  // compute the thing\n  return input + 1;\n\n}\n'.repeat(24)}` });
  }
  const report = C.compressMessages(heavy, { profile: 'balanced' }).report;
  assert.ok(report.savedPct >= 60, `context-heavy session saved only ${report.savedPct}%`);
});

test('budget enforcement stays inside the requested ceiling', () => {
  const messages = C.buildSample(30);
  const { messages: out, report } = C.compressMessages(messages, { profile: 'balanced', targetTokens: 1200 });
  const total = C.estimateMessages(out);
  assert.ok(total <= 1400, `expected <= 1400 tokens, got ${total}`);
  assert.ok(out.some(message => typeof message.content === 'string' && message.content.includes('compacted to fit')));
  assert.ok(report.techniques.some(item => item.id === 'budget'));
  assert.equal(out[0].role, 'system', 'system prompt stays first');
});

test('tool schemas are slimmed without touching names or required lists', () => {
  const tools = [{
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read one text file from the connected project. '.repeat(6),
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Project-relative file path. '.repeat(8) } },
        required: ['path']
      }
    }
  }];
  const { tools: slim, report } = C.compactToolDefinitions(tools);
  assert.equal(slim[0].function.name, 'read_file');
  assert.deepEqual(slim[0].function.parameters.required, ['path']);
  assert.ok(report.tokens > 0);
  assert.ok(JSON.stringify(slim).length < JSON.stringify(tools).length);
  assert.deepEqual(tools[0].function.parameters.required, ['path'], 'input is not mutated');
});

test('prepareRequest merges message and tool savings', () => {
  const result = C.prepareRequest({
    messages: C.buildSample(10),
    tools: [{ type: 'function', function: { name: 'x', description: 'Do a thing. '.repeat(20), parameters: { type: 'object', properties: {}, required: [] } } }],
    options: { profile: 'aggressive' }
  });
  assert.equal(result.tools.length, 1);
  assert.ok(result.report.savedPct > 50, `saved ${result.report.savedPct}%`);
  assert.ok(result.report.techniques.some(item => item.id === 'tool-schema'));
});

test('unknown languages are left alone', () => {
  const source = '-- not sure this is lua\nSELECT 1; -- sql\n';
  const lua = C.stripComments(source, 'lua');
  assert.ok(lua.text.includes('SELECT 1;'));
});

/* ---------------------------------------------------------------------- skills */

const WORKSPACE = new Map(Object.entries({
  'CLAUDE.md': '# House rules\n\nRun `npm test` before proposing changes. Never commit secrets.\n',
  'packages/web/CLAUDE.md': 'Use the shared component library and keep new UI keyboard accessible.',
  'src/.claude/skills/invoice-parser/SKILL.md': [
    '---',
    'name: invoice-parser',
    'description: Extract line items from supplier invoice PDFs and validate the totals. Use when an invoice or receipt is attached.',
    'allowed-tools:',
    '  - Read',
    '  - Bash',
    'license: MIT',
    'metadata:',
    '  owner: finance-platform',
    '---',
    '',
    '# Invoice parser',
    '',
    '1. Run pdftotext.',
    '2. Validate the sum of line items against the printed total.'.padEnd(200, ' ')
  ].join('\n'),
  'src/.claude/skills/invoice-parser/references/fields.md': 'field | meaning\n--- | ---\ntotal | printed total\n',
  'src/.claude/skills/invoice-parser/scripts/extract.sh': '#!/bin/sh\npdftotext "$1" -\n',
  '.claude/commands/ship.md': '---\ndescription: Cut a release from the current branch\n---\nShip it.\n',
  '.claude/agents/test-writer.md': '---\nname: test-writer\ndescription: Writes the missing unit tests for a module.\n---\nWrite tests.\n',
  'skills/broken/SKILL.md': '---\nname: Broken Skill\ndescription: tiny\n---\n',
  'README.md': '# Not a skill\n'
}));

test('discovery finds every supported Claude markdown shape', () => {
  const registry = S.discover(WORKSPACE);
  assert.deepEqual(registry.skills.map(skill => skill.name), ['broken-skill', 'invoice-parser']);
  assert.deepEqual(registry.commands.map(item => item.name), ['ship']);
  assert.deepEqual(registry.agents.map(item => item.name), ['test-writer']);
  assert.deepEqual(registry.memory.map(item => item.path), ['CLAUDE.md', 'packages/web/CLAUDE.md']);
  assert.ok(!registry.skills.some(skill => skill.path === 'README.md'));
});

test('front matter is parsed, including nested maps and lists', () => {
  const record = S.discover(WORKSPACE).skills.find(skill => skill.name === 'invoice-parser');
  assert.equal(record.description.startsWith('Extract line items'), true);
  assert.deepEqual(record.allowedTools, ['Read', 'Bash']);
  assert.equal(record.license, 'MIT');
  assert.deepEqual(record.metadata, { owner: 'finance-platform' });
  assert.equal(record.valid, true);
});

test('bundled resources are attached to their skill', () => {
  const record = S.discover(WORKSPACE).skills.find(skill => skill.name === 'invoice-parser');
  assert.deepEqual(record.resources.map(item => item.relative), ['references/fields.md', 'scripts/extract.sh']);
  assert.equal(record.resources[0].category, 'reference');
  assert.equal(record.resources[1].category, 'script');
});

test('spec violations are reported instead of silently normalised', () => {
  const record = S.discover(WORKSPACE).skills.find(skill => skill.name === 'broken-skill');
  assert.equal(record.valid, false);
  assert.ok(record.errors.some(error => error.includes('kebab-case')));
});

test('context block carries memory, the skill index and the load instruction', () => {
  const registry = S.discover(WORKSPACE);
  const { text, report } = S.buildContext(registry, { canLoadSkillFiles: true });
  assert.ok(text.includes('<project_instructions path="CLAUDE.md">'));
  assert.ok(text.includes('npm test'));
  assert.ok(text.includes('- invoice-parser —'));
  assert.ok(text.includes('call read_skill'));
  assert.ok(!text.includes('Run pdftotext'), 'agent mode must not inline whole skill bodies');
  assert.ok(report.tokens > 0);
  assert.deepEqual(report.included.skills, ['broken-skill', 'invoice-parser']);
});

test('chat mode inlines small skill bodies instead of exposing tools', () => {
  const registry = S.discover(WORKSPACE);
  const { text } = S.buildContext(registry, { canLoadSkillFiles: false, inlineSkillBodyChars: 4000 });
  assert.ok(text.includes('<skill name="invoice-parser"'));
  assert.ok(text.includes('Run pdftotext'));
});

test('disabled entries are left out of the context block', () => {
  const registry = S.discover(WORKSPACE);
  registry.memory.forEach(item => { item.enabled = false; });
  const { text, report } = S.buildContext(registry, { canLoadSkillFiles: true });
  assert.ok(!text.includes('project_instructions'));
  assert.deepEqual(report.included.memory, []);
});

test('read_skill resolves by name and by path and renders a delimited block', () => {
  const registry = S.discover(WORKSPACE);
  assert.equal(S.resolveSkill(registry, 'invoice-parser').name, 'invoice-parser');
  assert.equal(S.resolveSkill(registry, 'src/.claude/skills/invoice-parser/SKILL.md').name, 'invoice-parser');
  assert.equal(S.resolveSkill(registry, 'nope'), null);
  const rendered = S.renderSkillForModel(S.resolveSkill(registry, 'invoice-parser'));
  assert.ok(rendered.startsWith('<skill name="invoice-parser"'));
  assert.ok(rendered.trimEnd().endsWith('</skill>'));
  assert.ok(rendered.includes('Bundled files: references/fields.md'));
});

test('a pasted skill becomes a valid record with a template', () => {
  const registry = S.discover(new Map());
  const record = S.upsertManualSkill(registry, { name: 'My Skill', description: 'Demo', body: 'Do the thing carefully.' });
  assert.equal(record.name, 'my-skill');
  assert.equal(record.path, '.claude/skills/my-skill/SKILL.md');
  assert.equal(record.valid, true);
  const parsed = S.parseFrontmatter(S.template('Report Writer'));
  assert.equal(parsed.data.name, 'report-writer');
  assert.ok(parsed.data.description.length > 20);
  assert.ok(parsed.body.includes('## Steps'));
});

test('malformed front matter degrades gracefully', () => {
  const parsed = S.parseFrontmatter('---\nname: x\nthis line has no colon\nlist: [a, b, c]\n---\nbody');
  assert.equal(parsed.data.name, 'x');
  assert.deepEqual(parsed.data.list, ['a', 'b', 'c']);
  assert.equal(parsed.warnings.length, 1);
  assert.equal(parsed.body, 'body');
});

test('block scalars keep their line structure', () => {
  const parsed = S.parseFrontmatter('---\ndescription: >\n  folded text\n  across lines\nallowed-tools: |\n  Read\n  Grep\n---\nx');
  assert.equal(parsed.data.description, 'folded text across lines');
  assert.equal(parsed.data['allowed-tools'], 'Read\nGrep');
});
