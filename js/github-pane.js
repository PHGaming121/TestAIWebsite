/**
 * GitHub pane: connect a Personal Access Token, pick or create a repo, and push
 * the workspace (optionally switching on GitHub Pages in the same click).
 *
 * The token is only ever sent to api.github.com and stored in this browser
 * (localStorage, or sessionStorage when "this tab only" is selected).
 */
import { el, prettyError, formatBytes } from './util.js';
import { GITHUB } from './config.js';
import { icon, toast, confirmDialog } from './ui.js';
import {
  GitHubClient, saveGitHubCreds, clearGitHubCreds, readGitHubCredsAnywhere,
} from './github.js';

export class GitHubPane {
  /**
   * @param {object} o
   * @param {HTMLElement} o.container  #gh-pane
   * @param {HTMLElement} o.sideBody   sidebar GitHub block body
   * @param {HTMLElement} o.sidePill   sidebar pill
   * @param {Function} o.getWs
   * @param {object} o.state           {settings, updateSettings}
   * @param {Function} o.onConnected   (creds) => void
   */
  constructor(o) {
    Object.assign(this, o);
    this.creds = readGitHubCredsAnywhere();
    this.repos = [];
    this.build();
  }

  get client() { return this.creds?.token ? new GitHubClient(this.creds.token) : null; }

  build() {
    this.container.innerHTML = '';

    /* ── connection card ───────────────────────────────── */
    const tokenInput = el('input.inp.mono', { type: 'password', placeholder: 'github_pat_… or ghp_…', autocomplete: 'off', spellcheck: 'false' });
    const sessionOnly = el('input', { type: 'checkbox' });
    if (this.creds?.sessionOnly) sessionOnly.checked = true;

    const connectBtn = el('button.btn.primary', { text: 'Connect' }, );
    const disconnectBtn = el('button.btn.danger', { text: 'Disconnect' });
    const status = el('div', { style: { marginTop: '10px' } });

    connectBtn.onclick = async () => {
      const token = tokenInput.value.trim();
      if (!token) { toast('Paste a token first'); return; }
      connectBtn.disabled = true; connectBtn.textContent = 'Checking…';
      try {
        const client = new GitHubClient(token);
        const me = await client.me();
        this.creds = saveGitHubCreds({
          token, login: me.login, name: me.name || me.login, avatar: me.avatar_url,
          scopes: me.scopes, sessionOnly: sessionOnly.checked,
        });
        toast(`Connected as ${me.login}`, { type: 'ok' });
        this.onConnected?.(this.creds);
        await this.loadRepos();
        this.renderStatus(status, disconnectBtn);
        this.renderSide();
      } catch (e) {
        toast(prettyError(e), { type: 'err', timeout: 6000 });
      } finally {
        connectBtn.disabled = false; connectBtn.textContent = 'Connect';
      }
    };

    disconnectBtn.onclick = async () => {
      if (!await confirmDialog({ title: 'Disconnect GitHub?', message: 'The token is removed from this browser. Nothing on GitHub changes.', danger: true, confirmLabel: 'Disconnect' })) return;
      clearGitHubCreds();
      this.creds = null;
      this.repos = [];
      this.onConnected?.(null);
      this.renderStatus(status, disconnectBtn);
      this.renderSide();
      toast('GitHub disconnected');
    };

    const connectCard = el('div.card', {},
      el('h4', {}, icon('key'), el('span', { text: '1 · Connect GitHub' })),
      el('p.hint', { html: `Paste a <a href="https://github.com/settings/tokens" target="_blank" rel="noopener">Personal Access Token</a> (${GITHUB.scopesHint}). It stays in this browser and is sent only to <code>api.github.com</code>.` }),
      tokenInput,
      el('label.checkline', { style: { marginTop: '8px' } }, sessionOnly, el('span', { text: 'Keep for this browser tab only (do not persist)' })),
      el('div.row', { style: { marginTop: '10px' } }, connectBtn, disconnectBtn),
      status,
    );

    /* ── repo card ─────────────────────────────────────── */
    const repoSelect = el('select.inp', {});
    const repoManual = el('input.inp.mono', { type: 'text', placeholder: 'or type owner/repo', spellcheck: 'false' });
    const refreshRepos = el('button.btn.tiny', { text: 'refresh' });
    const useRepo = el('button.btn.tiny', { text: 'select' });
    const repoInfo = el('div', { style: { marginTop: '8px' } });

    refreshRepos.onclick = () => this.loadRepos();
    useRepo.onclick = () => {
      const value = repoManual.value.trim() || repoSelect.value;
      if (!value) { toast('Pick or type a repository'); return; }
      this.state.updateSettings({ githubRepo: value });
      toast(`Selected ${value}`, { type: 'ok' });
      this.showRepoInfo(repoInfo, value);
      this.renderSide();
    };
    repoSelect.onchange = () => {
      if (!repoSelect.value) return;
      this.state.updateSettings({ githubRepo: repoSelect.value });
      this.showRepoInfo(repoInfo, repoSelect.value);
      this.renderSide();
    };

    const repoCard = el('div.card', {},
      el('h4', {}, icon('branch'), el('span', { text: '2 · Choose a repository' })),
      el('p.hint', { text: 'The agent pushes to this repo by default. You can also create a new one below.' }),
      el('label.lbl', { text: 'Your repositories' }),
      repoSelect,
      el('div.row', { style: { marginTop: '8px' } }, repoManual, useRepo, refreshRepos),
      repoInfo,
    );

    /* ── create repo card ──────────────────────────────── */
    const newName = el('input.inp', { type: 'text', placeholder: 'my-awesome-project', spellcheck: 'false' });
    const newDesc = el('input.inp', { type: 'text', placeholder: 'Short description (optional)' });
    const newPublic = el('input', { type: 'checkbox', checked: true });
    const createBtn = el('button.btn.primary', { text: 'Create repository' });
    createBtn.onclick = async () => {
      if (!this.client) { toast('Connect GitHub first'); return; }
      const name = newName.value.trim();
      if (!name) { toast('Repository name is required'); return; }
      createBtn.disabled = true; createBtn.textContent = 'Creating…';
      try {
        const repo = await this.client.createRepo({ name, description: newDesc.value.trim(), isPrivate: !newPublic.checked, autoInit: true });
        this.state.updateSettings({ githubRepo: repo.full_name });
        toast(`Created ${repo.full_name}`, { type: 'ok' });
        newName.value = ''; newDesc.value = '';
        await this.loadRepos();
        this.renderSide();
        repoInfo.innerHTML = '';
        repoInfo.append(el('div.notice.ok', { html: `Created <a href="${repo.html_url}" target="_blank" rel="noopener">${repo.html_url}</a>` }));
      } catch (e) { toast(prettyError(e), { type: 'err', timeout: 6000 }); }
      finally { createBtn.disabled = false; createBtn.textContent = 'Create repository'; }
    };
    const createCard = el('div.card', {},
      el('h4', {}, icon('plus'), el('span', { text: '3 · Or create a new repository' })),
      el('label.lbl', { text: 'Name' }), newName,
      el('label.lbl', { text: 'Description', style: { marginTop: '8px' } }), newDesc,
      el('label.checkline', { style: { marginTop: '8px' } }, newPublic, el('span', { text: 'Public (required for free github.io Pages)' })),
      el('div.row', { style: { marginTop: '10px' } }, createBtn),
    );

    /* ── push card ─────────────────────────────────────── */
    const pushMsg = el('input.inp', { type: 'text', value: 'Update from Puter Playground' });
    const pushBranch = el('input.inp.mono', { type: 'text', value: this.state.settings.githubBranch || 'main', style: { width: '130px' } });
    const pushPages = el('input', { type: 'checkbox', checked: true });
    const pushBtn = el('button.btn.primary', {}, icon('upload'), el('span', { text: 'Push workspace' }));
    const pushProg = el('div.progress', {}, el('i'));
    const pushLog = el('div.logbox', { style: { display: 'none' } });

    pushBtn.onclick = () => this.push({ message: pushMsg.value, branch: pushBranch.value.trim(), enablePages: pushPages.checked, prog: pushProg, log: pushLog, btn: pushBtn });

    const pushCard = el('div.card', {},
      el('h4', {}, icon('rocket'), el('span', { text: '4 · Push the workspace' })),
      el('p.hint', { text: 'Commits every file in the workspace through the Git Data API (blobs → tree → commit → ref), then optionally turns on GitHub Pages.' }),
      el('label.lbl', { text: 'Commit message' }), pushMsg,
      el('div.row', { style: { marginTop: '8px' } },
        el('div', { style: { flex: '1' } }, el('label.lbl', { text: 'Branch' }), pushBranch),
      ),
      el('label.checkline', {}, pushPages, el('span', { text: 'Enable GitHub Pages after pushing (public repos)' })),
      el('div.row', { style: { marginTop: '10px' } }, pushBtn),
      pushProg, pushLog,
    );

    this.container.append(connectCard, repoCard, createCard, pushCard);
    this.pushControls = { pushMsg, pushBranch, pushPages, pushProg, pushLog, pushBtn };

    this.renderStatus(status, disconnectBtn);
    this.renderSide();
    if (this.creds?.token) this.loadRepos().then(() => {
      const sel = this.state.settings.githubRepo;
      if (sel) this.showRepoInfo(repoInfo, sel);
    });
    this._repoSelect = repoSelect;
    this._repoInfo = repoInfo;
  }

  renderStatus(statusEl, disconnectBtn) {
    statusEl.innerHTML = '';
    if (this.creds?.token) {
      statusEl.append(el('div.notice.ok', {
        html: `Connected as <b>${this.creds.login || 'unknown'}</b>${this.creds.scopes ? ` · scopes: <code>${this.creds.scopes}</code>` : ''}${this.creds.sessionOnly ? ' · <i>this tab only</i>' : ''}`,
      }));
      disconnectBtn.style.display = '';
    } else {
      statusEl.append(el('div.notice', { text: 'Not connected. The agent can still build everything locally; it just cannot push until you connect.' }));
      disconnectBtn.style.display = 'none';
    }
  }

  async loadRepos() {
    if (!this.client) return;
    try {
      const repos = await this.client.listRepos({ perPage: 100 });
      this.repos = repos;
      const select = this._repoSelect;
      if (!select) return;
      select.innerHTML = '';
      select.append(el('option', { value: '', text: `${repos.length} repositories…` }));
      for (const r of repos) {
        select.append(el('option', { value: r.full_name, text: `${r.full_name}${r.private ? ' 🔒' : ''}` }));
      }
      const current = this.state.settings.githubRepo;
      if (current) select.value = current;
    } catch (e) {
      toast(`Could not list repos: ${prettyError(e)}`, { type: 'err' });
    }
  }

  async showRepoInfo(infoEl, fullName) {
    infoEl.innerHTML = '';
    if (!this.client || !fullName.includes('/')) return;
    const [owner, repo] = fullName.split('/');
    const box = el('div', {}, el('div.muted', { text: 'loading…', style: { fontSize: '11.5px' } }));
    infoEl.append(box);
    try {
      const info = await this.client.getRepo(owner, repo);
      const pages = await this.client.getPages(owner, repo);
      box.innerHTML = '';
      box.append(el('div.card', { style: { margin: '0', padding: '10px', background: 'var(--panel)' } },
        el('div.kv', {}, el('span', { text: 'visibility' }), el('span', { text: info.private ? 'private' : 'public' })),
        el('div.kv', {}, el('span', { text: 'default branch' }), el('span', { text: info.default_branch })),
        el('div.kv', {}, el('span', { text: 'size' }), el('span', { text: `${info.size || 0} KB` })),
        el('div.kv', {}, el('span', { text: 'pages' }), el('span', { html: pages?.html_url ? `<a href="${pages.html_url}" target="_blank" rel="noopener">${pages.html_url}</a> (${pages.status || 'built'})` : 'off' })),
        el('div.row', { style: { marginTop: '9px' } },
          el('a.btn.tiny', { href: info.html_url, target: '_blank', rel: 'noopener', text: 'Open on GitHub' }),
          el('button.btn.tiny', { text: 'Browse files', onclick: () => this.browse(infoEl, fullName) }),
        ),
      ));
    } catch (e) {
      box.innerHTML = '';
      box.append(el('div.notice.err', { text: prettyError(e) }));
    }
  }

  async browse(infoEl, fullName) {
    const [owner, repo] = fullName.split('/');
    const box = el('div.card', { style: { marginTop: '8px', padding: '10px', background: 'var(--panel)' } },
      el('div.muted', { text: 'loading tree…', style: { fontSize: '11.5px' } }));
    infoEl.append(box);
    try {
      const info = await this.client.getRepo(owner, repo);
      const tree = await this.client.listTree(owner, repo, info.default_branch);
      box.innerHTML = '';
      box.append(el('label.lbl', { text: `${tree.length} objects on ${info.default_branch}` }));
      const list = el('div.logbox', { style: { maxHeight: '200px' } });
      list.textContent = tree.map((t) => `${t.type === 'tree' ? '📁' : '  '} ${t.path}${t.size ? `  (${formatBytes(t.size)})` : ''}`).join('\n');
      box.append(list);
      const importBtn = el('button.btn.tiny', { style: { marginTop: '8px' }, text: '⬇ Import repo into workspace' });
      importBtn.onclick = async () => {
        importBtn.disabled = true; importBtn.textContent = 'importing…';
        try {
          const ws = this.getWs();
          const blobs = tree.filter((t) => t.type === 'blob' && t.size < 2_000_000).slice(0, 200);
          let n = 0;
          for (const b of blobs) {
            const data = await this.client.readFile(owner, repo, b.path, info.default_branch);
            if (data.encoding === 'base64') {
              const bytes = Uint8Array.from(atob(data.content.replace(/\n/g, '')), (c) => c.charCodeAt(0));
              await ws.write(b.path, new Blob([bytes]));
              n++;
            }
          }
          toast(`Imported ${n} files into the workspace`, { type: 'ok' });
          this.state.onWorkspaceChanged?.();
        } catch (e) { toast(prettyError(e), { type: 'err' }); }
        finally { importBtn.disabled = false; importBtn.textContent = '⬇ Import repo into workspace'; }
      };
      box.append(importBtn);
    } catch (e) {
      box.innerHTML = '';
      box.append(el('div.notice.err', { text: prettyError(e) }));
    }
  }

  async push({ message, branch, enablePages, prog, log, btn }) {
    if (!this.client) { toast('Connect GitHub first'); return; }
    const full = this.state.settings.githubRepo;
    if (!full || !full.includes('/')) { toast('Choose a repository first'); return; }
    const [owner, repo] = full.split('/');
    const ws = this.getWs();

    btn.disabled = true;
    log.style.display = '';
    log.textContent = '';
    const say = (t) => { log.textContent += (log.textContent ? '\n' : '') + t; log.scrollTop = log.scrollHeight; };
    prog.firstElementChild.style.width = '4%';

    try {
      const entries = (await ws.list()).filter((e) => e.type === 'file');
      if (!entries.length) throw new Error('The workspace is empty — nothing to push.');
      say(`Collecting ${entries.length} file(s)…`);
      const files = await GitHubClient.filesFromWorkspace(ws, { skip: [/^\.git\//, /node_modules\//] });

      let info;
      try { info = await this.client.getRepo(owner, repo); }
      catch (e) {
        if (e.status !== 404) throw e;
        say(`Repository not found — creating ${full} (public)…`);
        info = await this.client.createRepo({ name: repo, description: 'Created from Puter Playground', isPrivate: false, autoInit: false });
      }
      const targetBranch = branch || info.default_branch || 'main';
      prog.firstElementChild.style.width = '18%';

      say(`Pushing to ${full}@${targetBranch}…`);
      const res = await this.client.pushFiles({
        owner, repo, branch: targetBranch, files,
        message: message || 'Update from Puter Playground',
        onProgress: (label, d, t) => {
          prog.firstElementChild.style.width = `${Math.round(18 + (d / t) * 66)}%`;
          say(`  · ${label}`);
        },
      });
      prog.firstElementChild.style.width = '88%';
      say(`✓ commit ${res.sha.slice(0, 10)} → ${res.url}`);

      if (enablePages) {
        if (info.private) say('⚠ repo is private — GitHub Pages needs a public repo on free plans. Skipping Pages.');
        else {
          say('Enabling GitHub Pages…');
          try {
            const pages = await this.client.enablePages(owner, repo, { branch: targetBranch, path: '/' });
            say(`✓ Pages: ${pages?.html_url || `https://${owner}.github.io/${repo}/`} (first build ~1 min)`);
          } catch (e) { say(`⚠ Pages: ${prettyError(e)}`); }
        }
      }
      prog.firstElementChild.style.width = '100%';
      toast(`Pushed ${files.length} file(s) to ${full}`, { type: 'ok' });
      this.state.updateSettings({ githubBranch: targetBranch });
      this.showRepoInfo(this._repoInfo, full);
    } catch (e) {
      say(`✗ ${prettyError(e)}`);
      toast(prettyError(e), { type: 'err', timeout: 6000 });
    } finally {
      btn.disabled = false;
      setTimeout(() => { prog.firstElementChild.style.width = '0%'; }, 1600);
    }
  }

  renderSide() {
    if (!this.sideBody) return;
    this.sideBody.innerHTML = '';
    const pill = this.sidePill;
    if (this.creds?.token) {
      pill.textContent = this.creds.login;
      pill.className = 'pill ok';
      this.sideBody.append(
        el('div.ws-meta', {},
          el('div', {}, el('b', { text: this.creds.login }), ' · ', el('span', { text: this.creds.scopes || '' })),
          el('div', { text: `repo: ${this.state.settings.githubRepo || '—'}` }),
        ),
        el('div.btn-row', {},
          el('button.btn.tiny', { text: 'Manage', onclick: () => this.state.openTab?.('github') }),
          el('button.btn.tiny', { text: 'Push', onclick: () => { this.state.openTab?.('github'); setTimeout(() => this.push({ ...this.currentPushArgs(), prog: this.pushControls.pushProg, log: this.pushControls.pushLog, btn: this.pushControls.pushBtn }), 60); } }),
        ),
      );
    } else {
      pill.textContent = 'not linked';
      pill.className = 'pill';
      this.sideBody.append(
        el('p.hint', { style: { margin: '0 0 8px', fontSize: '11.5px', color: 'var(--muted)' }, text: 'Link a token to let the agent create repos, push code and turn on GitHub Pages.' }),
        el('button.btn.tiny.wide', { text: 'Connect GitHub', onclick: () => this.state.openTab?.('github') }),
      );
    }
  }

  currentPushArgs() {
    const c = this.pushControls;
    return { message: c.pushMsg.value, branch: c.pushBranch.value.trim(), enablePages: c.pushPages.checked };
  }

  /** Called by the agent when it selects/creates a repo. */
  setRepo(fullName) {
    this.state.updateSettings({ githubRepo: fullName });
    if (this._repoSelect) {
      if (![...this._repoSelect.options].some((o) => o.value === fullName)) {
        this._repoSelect.append(el('option', { value: fullName, text: fullName }));
      }
      this._repoSelect.value = fullName;
    }
    this.renderSide();
  }

  connected() { return !!this.creds?.token; }
  login() { return this.creds?.login || null; }

  setCreds(creds) {
    this.creds = creds;
    this.renderSide();
    if (creds?.token) this.loadRepos();
  }
}
