/**
 * Skills pane: see what is installed, import skills from other assistants,
 * write new ones, and decide what each is allowed to do.
 *
 * Skills are third-party instructions. This pane is deliberately loud about
 * that: validity errors, requested tool permissions and untrusted origins are
 * shown on the row, and nothing is granted silently.
 */
import { el, prettyError, truncate, downloadBlob } from './util.js';
import { icon, toast, openModal, confirmDialog } from './ui.js';
import {
  listSkills, readSkillBody, saveSkill, deleteSkill, parseImport, importSkillZip,
  skillNameFrom, setSkillState, MAX_DESCRIPTION,
} from './skills.js';
import { rememberTool, forgetTool, allowedTools } from './agent.js';
import { webFetch } from './connections.js';

/** Claude-style `allowed-tools` entries map onto this app's tools for display. */
const TOOL_ALIASES = [
  [/^bash/i, 'run_shell'], [/^shell/i, 'run_shell'], [/^read$/i, 'read_file'], [/^write$/i, 'write_file'],
  [/^edit$/i, 'edit_file'], [/^web_?fetch|^fetch/i, 'web_fetch'], [/^web_?search/i, 'web_fetch'],
  [/^glob|^grep|^search/i, 'search_files'], [/^python/i, 'run_python'], [/^node|^js/i, 'run_javascript'],
];

function mapAllowedTools(spec) {
  const out = new Set();
  for (const token of String(spec || '').split(/[\s,]+/).filter(Boolean)) {
    const base = token.replace(/\(.*?\)/g, '').trim();
    const hit = TOOL_ALIASES.find(([re]) => re.test(base));
    if (hit) out.add(hit[1]);
  }
  return [...out];
}

export class SkillsPane {
  /**
   * @param {object} o
   * @param {HTMLElement} o.container  #skills-pane
   * @param {Function} o.getWs         () => workspace
   * @param {Function}[o.openFile]     (path) => void
   */
  constructor(o) {
    Object.assign(this, o);
    this.skills = [];
    this.build();
  }

  build() {
    const c = this.container;
    c.innerHTML = '';
    this.listEl = el('div.skill-list');
    this.countEl = el('div.hint');

    c.append(
      el('div.card', {},
        el('h4', {}, icon('zap'), el('span', { text: 'Skills' })),
        el('p.hint', { html: 'A skill is a folder with a <code>SKILL.md</code>: YAML frontmatter (<code>name</code>, <code>description</code>) plus Markdown instructions. It is the <a href="https://agentskills.io" target="_blank" rel="noopener">Agent Skills open standard</a>, so the same file works in Claude, ChatGPT, Codex, Gemini CLI, VS Code and Cursor. Only names and descriptions go into the prompt; the body loads when the agent activates a skill.' }),
        this.countEl,
        this.listEl,
      ),
      this.importCard(),
      this.newSkillCard(),
    );
    this.refresh();
  }

  /* ── list ─────────────────────────────────────────────── */
  async refresh() {
    try { this.skills = await listSkills(this.getWs()); }
    catch (e) { this.listEl.replaceChildren(el('div.notice.err', { text: prettyError(e) })); return; }
    const enabled = this.skills.filter((s) => s.enabled).length;
    this.countEl.textContent = this.skills.length
      ? `${this.skills.length} installed · ${enabled} enabled · stored in the workspace, so they push to GitHub with everything else`
      : 'Nothing installed yet — import one below, or ask the agent to create one.';
    this.listEl.replaceChildren();
    if (!this.skills.length) {
      this.listEl.append(el('div.fv-empty', { text: 'No skills in the workspace. Discovery also looks in .claude/skills, .agents/skills and .gemini/skills.' }));
      return;
    }
    for (const s of this.skills) this.listEl.append(this.row(s));
  }

  row(s) {
    const enabled = el('input', { type: 'checkbox', title: 'Enabled' });
    enabled.checked = s.enabled;
    enabled.onchange = () => { setSkillState(s.name, { enabled: enabled.checked }); this.refresh(); };

    const badges = el('div.skill-badges', {},
      s.source ? el('span.tag', { text: s.source }) : null,
      s.root && s.root !== 'skills' ? el('span.tag', { text: s.root }) : null,
      s.license ? el('span.tag', { text: s.license }) : null,
      s.trusted ? el('span.tag.tool', { text: 'trusted' }) : el('span.tag.hot', { text: 'unreviewed' }),
    );

    const row = el('div.skill-row', {},
      el('div.skill-main', {},
        el('div.skill-name', {}, enabled, el('b', { text: s.name }),
          el('span.dim', { text: ` · ${s.bodyLines} lines` })),
        el('div.skill-desc', { text: s.description || '(no description)' }),
        badges,
        s.errors?.length ? el('div.notice.err', { style: { marginTop: '6px' }, text: `Invalid: ${s.errors.join('; ')}` }) : null,
        s.warnings?.length ? el('div.hint', { text: s.warnings.join(' · ') }) : null,
        s.allowedTools ? this.allowedToolsNote(s) : null,
      ),
      el('div.mem-actions', {},
        el('button.btn.tiny', { text: 'View', onclick: () => this.viewSkill(s) }),
        el('button.icon-btn', { title: 'Open SKILL.md in Files', onclick: () => this.openFile?.(s.path) }, icon('file')),
        el('button.icon-btn', {
          title: 'Delete skill',
          onclick: async () => {
            if (!await confirmDialog({ title: `Delete the skill “${s.name}”?`, message: `${s.dir} is removed from the workspace.`, danger: true, confirmLabel: 'Delete' })) return;
            try { await deleteSkill(this.getWs(), s.folder || s.name); this.refresh(); toast('Skill deleted', { type: 'ok' }); }
            catch (e) { toast(prettyError(e), { type: 'err' }); }
          },
        }, icon('trash')),
      ),
    );
    return row;
  }

  allowedToolsNote(s) {
    const mapped = mapAllowedTools(s.allowedTools);
    const granted = allowedTools();
    return el('div.notice.warn', { style: { marginTop: '6px' } },
      el('div', { html: `This skill asks to pre-approve tools: <code>${s.allowedTools}</code>` }),
      mapped.length ? el('div.hint', { text: `That maps onto: ${mapped.join(', ')}. Nothing is granted automatically — choose below.` }) : null,
      mapped.length ? el('div.row', { style: { marginTop: '6px', flexWrap: 'wrap' } },
        ...mapped.map((tool) => el('button.btn.tiny', {
          text: granted.has(tool) ? `✓ ${tool} allowed` : `Allow ${tool}`,
          onclick: () => {
            if (granted.has(tool)) { forgetTool(tool); toast(`${tool} will ask again`); }
            else { rememberTool(tool); toast(`${tool} is now pre-approved`, { type: 'ok' }); }
            this.refresh();
          },
        })),
      ) : null,
    );
  }

  async viewSkill(s) {
    let full;
    try { full = await readSkillBody(this.getWs(), s.name); }
    catch (e) { toast(prettyError(e), { type: 'err' }); return; }
    const body = el('pre.skill-body', { text: full?.body || '(empty)' });
    const modal = openModal({
      title: `Skill: ${s.name}`, iconName: 'zap', wide: true,
      body: el('div', {},
        el('div.notice.info', { html: `<b>${s.name}</b> — ${s.description}` }),
        full?.files?.length ? el('p.hint', { text: `Bundled files: ${full.files.map((f) => f.path).join(', ')}` }) : null,
        s.allowedTools ? el('div.notice.warn', { text: `Requests tool permissions: ${s.allowedTools}` }) : null,
        body,
      ),
      footer: [
        el('button.btn.tiny', {
          text: 'Download SKILL.md',
          onclick: async () => {
            const blob = await this.getWs().readBlob(s.path).catch(() => null);
            if (blob) downloadBlob(blob, 'SKILL.md');
          },
        }),
        el('button.btn.tiny', {
          text: s.trusted ? 'Mark unreviewed' : 'Mark as reviewed',
          onclick: () => { setSkillState(s.name, { trusted: !s.trusted }); modal.close(); this.refresh(); },
        }),
        el('button.btn', { text: 'Close', onclick: () => modal.close() }),
      ],
    });
  }

  /* ── import ───────────────────────────────────────────── */
  importCard() {
    const area = el('textarea.inp.mono', { rows: 6, spellcheck: 'false', placeholder: 'Paste a SKILL.md, a ChatGPT custom-GPT JSON export, a Gemini Gem, or a CLAUDE.md / AGENTS.md file…' });
    const urlInput = el('input.inp.mono', { type: 'text', placeholder: 'https://raw.githubusercontent.com/…/SKILL.md' });
    const preview = el('div.import-preview');
    const fileInput = el('input', { type: 'file', accept: '.md,.json,.txt,.yaml,.yml,.zip,application/zip', style: { display: 'none' } });

    const showPreview = () => {
      const text = area.value.trim();
      if (!text) { preview.replaceChildren(); return null; }
      const parsed = parseImport(text);
      preview.replaceChildren(
        el('div.notice.info', {},
          el('div', { html: `Detected: <b>${parsed.kind}</b> → skill <code>${parsed.name || '(unnamed)'}</code>` }),
          el('div.dim', { text: truncate(parsed.description || '(no description)', 300, '…') }),
          parsed.errors?.length ? el('div.sync-err', { text: `Errors: ${parsed.errors.join('; ')}` }) : null,
          parsed.warnings?.length ? el('div.dim', { text: `Warnings: ${parsed.warnings.join('; ')}` }) : null,
          parsed.allowedTools ? el('div.sync-err', { text: `Requests tools: ${parsed.allowedTools} (never granted automatically)` }) : null,
        ),
      );
      return parsed;
    };
    area.addEventListener('input', () => showPreview());

    const doImport = async (parsed) => {
      if (!parsed) parsed = showPreview();
      if (!parsed) { toast('Paste something to import first', { type: 'warn' }); return; }
      if (parsed.errors?.length) { toast(`Cannot import: ${parsed.errors[0]}`, { type: 'err', timeout: 6000 }); return; }
      try {
        const saved = await saveSkill(this.getWs(), { ...parsed, source: parsed.kind, overwrite: true });
        area.value = '';
        preview.replaceChildren();
        await this.refresh();
        toast(`Imported “${saved.name}” → ${saved.path}`, { type: 'ok', timeout: 4000 });
      } catch (e) { toast(prettyError(e), { type: 'err', timeout: 6000 }); }
    };

    fileInput.onchange = async () => {
      const f = fileInput.files?.[0];
      if (!f) return;
      try {
        if (/\.zip$/i.test(f.name) || f.type === 'application/zip') {
          const res = await importSkillZip(this.getWs(), f);
          await this.refresh();
          toast(`Imported “${res.name}”${res.bundled?.length ? ` with ${res.bundled.length} bundled file(s)` : ''}`, { type: 'ok', timeout: 4000 });
        } else {
          area.value = await f.text();
          showPreview();
        }
      } catch (e) { toast(prettyError(e), { type: 'err', timeout: 7000 }); }
      fileInput.value = '';
    };

    return el('div.card', {},
      el('h4', {}, icon('upload'), el('span', { text: 'Import a skill' })),
      el('p.hint', { html: 'Format is detected automatically. ChatGPT custom GPTs and Gemini Gems become skills; their knowledge files and API actions are noted so you can finish wiring them up (drop files into <code>references/</code>, add the API in the Connect tab).' }),
      area,
      preview,
      el('div.row', { style: { marginTop: '8px' } },
        el('button.btn.primary.tiny', { text: 'Import pasted skill', onclick: () => doImport(null) }),
        el('button.btn.tiny', { text: 'Choose file… (.md/.json/.zip)', onclick: () => fileInput.click() }),
        fileInput,
      ),
      el('label.lbl', { text: '…or from a URL' }),
      el('div.row', {}, urlInput,
        el('button.btn.tiny', {
          text: 'Fetch',
          onclick: async () => {
            const url = urlInput.value.trim();
            if (!url) { toast('Paste a URL first'); return; }
            try {
              const page = await webFetch(url, { maxChars: 60000 });
              area.value = page.text;
              showPreview();
              toast('Fetched — check the preview, then import', { type: 'ok' });
            } catch (e) { toast(prettyError(e), { type: 'err', timeout: 6000 }); }
          },
        })),
      el('p.hint', { text: `Descriptions are capped at ${MAX_DESCRIPTION} characters and must not contain angle brackets; names must be kebab-case and match their folder.` }),
    );
  }

  /* ── authoring ───────────────────────────────────────── */
  newSkillCard() {
    const name = el('input.inp.mono', { type: 'text', placeholder: 'pdf-table-extract' });
    const desc = el('textarea.inp', { rows: 2, placeholder: 'Extracts tables from PDFs into CSV. Use when a task needs structured data out of a PDF report, invoice or form.' });
    const body = el('textarea.inp.mono', { rows: 8, spellcheck: 'false', placeholder: '## Steps\n1. …\n\n## Gotchas\n- …' });

    return el('div.card', {},
      el('h4', {}, icon('plus'), el('span', { text: 'Write a skill' })),
      el('label.lbl', { text: 'Name (kebab-case)' }), name,
      el('label.lbl', { text: 'Description — what it does and when to use it' }), desc,
      el('label.lbl', { text: 'Instructions (Markdown)' }), body,
      el('div.row', { style: { marginTop: '8px' } },
        el('button.btn.primary.tiny', {
          text: 'Create skill',
          onclick: async () => {
            try {
              const saved = await saveSkill(this.getWs(), {
                name: skillNameFrom(name.value) || name.value,
                description: desc.value.trim(),
                body: body.value,
                source: 'hand-written',
              });
              name.value = ''; desc.value = ''; body.value = '';
              await this.refresh();
              toast(`Created ${saved.path}`, { type: 'ok' });
            } catch (e) { toast(prettyError(e), { type: 'err', timeout: 7000 }); }
          },
        }),
      ),
    );
  }
}
