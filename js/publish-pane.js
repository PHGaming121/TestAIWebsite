/**
 * Publish pane: get the project out of the browser —
 * ZIP download, standalone HTML, Puter subdomain hosting, GitHub Pages,
 * and conversation export.
 */
import { el, prettyError, downloadBlob, basename } from './util.js';
import { icon, toast, confirmDialog } from './ui.js';
import { conversationToMarkdown } from './store.js';

export class PublishPane {
  /**
   * @param {object} o
   * @param {HTMLElement} o.container
   * @param {Function} o.getWs
   * @param {object} o.state        {settings, updateSettings, activeConv, githubPane, filesPane}
   */
  constructor(o) {
    Object.assign(this, o);
    this.build();
  }

  build() {
    const c = this.container;
    c.innerHTML = '';

    /* ── Puter hosting ─────────────────────────────────── */
    const sub = el('input.inp', { type: 'text', placeholder: 'my-project', spellcheck: 'false' });
    const srcDir = el('input.inp.mono', { type: 'text', placeholder: '(whole workspace)', spellcheck: 'false' });
    const pubBtn = el('button.btn.primary', {}, icon('globe'), el('span', { text: 'Publish to puter.site' }));
    const pubLog = el('div.logbox', { style: { display: 'none', marginTop: '10px' } });
    const sites = el('div', { style: { marginTop: '10px' } });

    pubBtn.onclick = async () => {
      const name = (sub.value || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '');
      if (!name) { toast('Pick a subdomain (letters, numbers, dashes)'); return; }
      pubBtn.disabled = true;
      pubLog.style.display = '';
      pubLog.textContent = 'Checking Puter account…';
      try {
        if (!window.puter?.hosting) throw new Error('Puter.js hosting is unavailable in this browser.');
        if (!window.puter.auth.isSignedIn()) {
          pubLog.textContent += '\nOpening Puter sign-in (free)…';
          await window.puter.auth.signIn();
        }
        const dirName = `playground-sites/${name}`;
        pubLog.textContent += `\nCopying workspace to ~/${dirName}…`;
        await window.puter.fs.mkdir(dirName, { createMissingParents: true, overwrite: false, dedupeName: false }).catch(() => {});
        const ws = this.getWs();
        const prefix = (srcDir.value || '').trim().replace(/^\/+|\/+$/g, '');
        const entries = (await ws.list()).filter((e) => e.type === 'file' && (!prefix || e.path.startsWith(prefix + '/')));
        if (!entries.length) throw new Error('Nothing to publish in that folder.');
        let n = 0;
        for (const e of entries) {
          const rel = prefix ? e.path.slice(prefix.length + 1) : e.path;
          if (!rel) continue;
          const blob = await ws.readBlob(e.path);
          await window.puter.fs.write(`${dirName}/${rel}`, blob, { overwrite: true, dedupeName: false, createMissingParents: true });
          n++;
          pubLog.textContent = pubLog.textContent.replace(/\n.*$/, `\nUploading ${n}/${entries.length}…`);
        }
        pubLog.textContent += `\nCreating https://${name}.puter.site…`;
        try { await window.puter.hosting.create(name, dirName); }
        catch (e) {
          if (/exist/i.test(prettyError(e))) await window.puter.hosting.update(name, dirName);
          else throw e;
        }
        const url = `https://${name}.puter.site`;
        pubLog.textContent += `\n✓ Live at ${url}`;
        toast(`Published → ${url}`, { type: 'ok', timeout: 7000 });
        this.listSites(sites);
      } catch (e) {
        pubLog.textContent += `\n✗ ${prettyError(e)}`;
        toast(prettyError(e), { type: 'err', timeout: 6000 });
      } finally { pubBtn.disabled = false; }
    };

    const puterCard = el('div.card', {},
      el('h4', {}, icon('globe'), el('span', { text: 'Publish to a free Puter subdomain' })),
      el('p.hint', { text: 'Copies the workspace into your Puter drive and serves it at https://<name>.puter.site — instant, no build, no DNS.' }),
      el('label.lbl', { text: 'Subdomain' }), sub,
      el('label.lbl', { text: 'Publish only this folder (optional)', style: { marginTop: '8px' } }), srcDir,
      el('div.row', { style: { marginTop: '10px' } }, pubBtn),
      pubLog, sites,
    );

    /* ── GitHub Pages ──────────────────────────────────── */
    const ghRepo = el('input.inp.mono', { type: 'text', placeholder: 'owner/repo', value: this.state.settings.githubRepo || '' });
    const ghBranch = el('input.inp.mono', { type: 'text', value: this.state.settings.githubBranch || 'main', style: { width: '120px' } });
    const ghBtn = el('button.btn.primary', {}, icon('github'), el('span', { text: 'Push + enable Pages' }));
    const ghNote = el('div', {});

    ghBtn.onclick = async () => {
      const repo = ghRepo.value.trim();
      if (!repo.includes('/')) { toast('Enter the repository as owner/repo'); return; }
      if (!this.state.githubPane?.connected()) { toast('Connect GitHub in the GitHub tab first'); this.state.openTab?.('github'); return; }
      this.state.updateSettings({ githubRepo: repo, githubBranch: ghBranch.value.trim() || 'main' });
      this.state.githubPane.setRepo(repo);
      this.state.openTab?.('github');
      await this.state.githubPane.push({
        message: `Publish from Puter Playground`,
        branch: ghBranch.value.trim() || 'main',
        enablePages: true,
        prog: this.state.githubPane.pushControls.pushProg,
        log: this.state.githubPane.pushControls.pushLog,
        btn: this.state.githubPane.pushControls.pushBtn,
      });
      const [owner, name] = repo.split('/');
      ghNote.innerHTML = '';
      ghNote.append(el('div.notice.ok', { style: { marginTop: '10px' }, html: `Once the build finishes: <a href="https://${owner}.github.io/${name}/" target="_blank" rel="noopener">https://${owner}.github.io/${name}/</a>` }));
    };

    const ghCard = el('div.card', {},
      el('h4', {}, icon('github'), el('span', { text: 'Publish to github.io' })),
      el('p.hint', { text: 'Pushes the workspace to a public repo and switches on GitHub Pages. The site appears at https://<user>.github.io/<repo>/ about a minute later.' }),
      el('label.lbl', { text: 'Repository (owner/name)' }), ghRepo,
      el('div.row', { style: { marginTop: '8px' } },
        el('div', { style: { flex: '1' } }, el('label.lbl', { text: 'Branch' }), ghBranch),
      ),
      el('div.row', { style: { marginTop: '10px' } }, ghBtn),
      ghNote,
    );

    /* ── local exports ─────────────────────────────────── */
    const zipBtn = el('button.btn', {}, icon('download'), el('span', { text: 'Download ZIP' }));
    zipBtn.onclick = async () => {
      try {
        const ws = this.getWs();
        const blob = await ws.exportZip('workspace.zip');
        downloadBlob(blob, `playground-${new Date().toISOString().slice(0, 10)}.zip`);
        toast('ZIP downloaded', { type: 'ok' });
      } catch (e) { toast(prettyError(e), { type: 'err' }); }
    };

    const htmlBtn = el('button.btn', {}, icon('file'), el('span', { text: 'Standalone HTML' }));
    htmlBtn.onclick = async () => {
      try {
        const ws = this.getWs();
        const candidates = ['index.html', ...(await ws.list()).filter((e) => /\.html?$/i.test(e.path)).map((e) => e.path)];
        let path = null;
        for (const p of candidates) { if (await ws.exists(p)) { path = p; break; } }
        if (!path) { toast('No HTML file in the workspace'); return; }
        const html = await this.state.filesPane.buildPreview(path);
        downloadBlob(new Blob([html], { type: 'text/html' }), basename(path).replace(/\.html?$/i, '') + '-standalone.html');
        toast(`Exported ${path} with assets inlined`, { type: 'ok' });
      } catch (e) { toast(prettyError(e), { type: 'err' }); }
    };

    const mdBtn = el('button.btn', {}, icon('book'), el('span', { text: 'Export chat (.md)' }));
    mdBtn.onclick = () => {
      const conv = this.state.activeConv?.();
      if (!conv?.messages?.length) { toast('Nothing to export yet'); return; }
      downloadBlob(new Blob([conversationToMarkdown(conv)], { type: 'text/markdown' }), `${(conv.title || 'conversation').replace(/[^\w\-]+/g, '-').slice(0, 40)}.md`);
    };

    const jsonBtn = el('button.btn', {}, icon('save'), el('span', { text: 'Export chat (.json)' }));
    jsonBtn.onclick = () => {
      const conv = this.state.activeConv?.();
      if (!conv) { toast('Nothing to export yet'); return; }
      downloadBlob(new Blob([JSON.stringify({ ...conv, messages: conv.messages.map(({ el, ...m }) => m) }, null, 2)], { type: 'application/json' }), `${(conv.title || 'conversation').replace(/[^\w\-]+/g, '-').slice(0, 40)}.json`);
    };

    const exportCard = el('div.card', {},
      el('h4', {}, icon('download'), el('span', { text: 'Take it with you' })),
      el('p.hint', { text: 'Everything you build belongs to you — no lock-in, no export limits.' }),
      el('div.btn-row', {}, zipBtn, htmlBtn, mdBtn, jsonBtn),
    );

    c.append(puterCard, ghCard, exportCard);
    this.listSites(sites);
  }

  async listSites(container) {
    if (!container) return;
    container.innerHTML = '';
    if (!window.puter?.hosting?.list) return;
    try {
      if (!window.puter.auth?.isSignedIn?.()) return;
      const subs = await window.puter.hosting.list();
      if (!subs?.length) return;
      const wrap = el('div', {}, el('label.lbl', { text: `Your Puter sites (${subs.length})` }));
      for (const s of subs.slice(0, 12)) {
        const name = s.subdomain || s.name;
        wrap.append(el('div.kv', {},
          el('a', { href: `https://${name}.puter.site`, target: '_blank', rel: 'noopener', text: `${name}.puter.site` }),
          el('span.row', { style: { gap: '4px' } },
            el('button.mini-btn', {
              text: 'delete', onclick: async () => {
                if (!await confirmDialog({ title: `Delete ${name}.puter.site?`, message: 'The site stops being served. Files stay in your Puter drive.', danger: true, confirmLabel: 'Delete' })) return;
                try { await window.puter.hosting.delete(name); toast('Site deleted'); this.listSites(container); }
                catch (e) { toast(prettyError(e), { type: 'err' }); }
              },
            }),
          ),
        ));
      }
      container.append(wrap);
    } catch { /* listing is best-effort */ }
  }
}
