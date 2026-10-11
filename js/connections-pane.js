/**
 * Connect pane: pick which AI provider answers, and manage the external apps
 * the agent is allowed to call.
 *
 * Provider keys and connection credentials live in this browser's localStorage
 * only — they are never sent anywhere except the endpoint they belong to.
 */
import { el, esc, prettyError } from './util.js';
import { icon, toast, openModal, confirmDialog } from './ui.js';
import {
  PROVIDERS, providerById, providerConfig, saveProviderConfig,
  isProviderReady, testProvider, listProviderModels, isLoopbackUrl,
} from './providers.js';
import {
  AUTH_TYPES, CONNECTION_PRESETS, listConnections, saveConnection, removeConnection,
  addPreset, callConnection,
} from './connections.js';

export class ConnectionsPane {
  /**
   * @param {object} o
   * @param {HTMLElement} o.container   #connect-pane
   * @param {Function} o.getSettings    () => settings
   * @param {Function} o.updateSettings (patch) => void
   * @param {Function}[o.onModelsChanged] () => void — refresh the model picker
   */
  constructor(o) {
    Object.assign(this, o);
    this.selectedProvider = this.getSettings().providerId || 'puter';
    this.build();
  }

  build() {
    const c = this.container;
    c.innerHTML = '';
    c.append(this.providerCard(), this.connectionsCard());
  }

  refresh() { this.build(); }

  /* ══════════════ providers ══════════════ */
  providerCard() {
    const sel = el('select.inp', {},
      ...PROVIDERS.map((p) => el('option', { value: p.id, text: p.label })),
    );
    sel.value = this.selectedProvider;
    const detail = el('div.provider-detail');
    sel.onchange = () => { this.selectedProvider = sel.value; this.renderProviderDetail(detail, sel.value); };

    const card = el('div.card', {},
      el('h4', {}, icon('chip'), el('span', { text: '1 · Which AI answers' })),
      el('p.hint', { html: 'Puter needs no key and covers 400+ models. Pick another provider to use your own key, a free tier, or a model running on your own machine — the workspace, agent and publishing all keep working.' }),
      el('label.lbl', { text: 'Provider' }),
      sel,
      detail,
    );
    this.renderProviderDetail(detail, this.selectedProvider);
    return card;
  }

  renderProviderDetail(host, id) {
    const def = providerById(id);
    const cfg = providerConfig(id);
    host.innerHTML = '';
    if (!def) return;

    const active = this.getSettings().providerId === id;
    host.append(el('div.notice.info', { html: `<b>${esc(def.label)}</b> — ${esc(def.blurb || '')}` }));
    if (def.hint) {
      host.append(el('div.hint', { style: { marginTop: '6px' } },
        el('code', { text: def.hint }),
        el('div', { text: 'Loopback servers must allow this site as an origin; Puter cannot proxy to your own machine.' })));
    }
    if (def.docs) {
      host.append(el('p.hint', {}, el('a', { href: def.docs, target: '_blank', rel: 'noopener', text: `Get a key / docs ↗` })));
    }

    if (def.kind === 'puter') {
      const row = el('div.row', { style: { marginTop: '10px' } },
        active
          ? el('span.tag.tool', { text: 'active' })
          : el('button.btn.primary.tiny', { text: 'Use Puter', onclick: () => { this.useProvider('puter'); } }),
      );
      host.append(row);
      host.append(el('p.hint', { text: 'Signing in is free and needs no card; your Puter account carries its own allowance.' }));
      return;
    }

    const baseInput = el('input.inp.mono', { type: 'text', value: cfg.baseUrl, placeholder: 'https://api.example.com/v1' });
    baseInput.disabled = !(def.userBaseUrl || def.loopback || id === 'custom');
    const keyInput = el('input.inp.mono', { type: 'password', value: cfg.apiKey, placeholder: def.keyPrefix ? `${def.keyPrefix}…` : 'API key (optional for keyless endpoints)', autocomplete: 'off', spellcheck: 'false' });
    const modelInput = el('input.inp.mono', { type: 'text', value: cfg.model, placeholder: 'default model id (optional)' });
    const status = el('div.hint');

    const save = () => {
      saveProviderConfig(id, { baseUrl: baseInput.value.trim(), apiKey: keyInput.value.trim(), model: modelInput.value.trim() });
      toast(`${def.label} saved`, { type: 'ok' });
      this.useProvider(id, { silent: true });
      this.renderProviderDetail(host, id);
    };

    const testBtn = el('button.btn.tiny', { text: 'Test' });
    testBtn.onclick = async () => {
      saveProviderConfig(id, { baseUrl: baseInput.value.trim(), apiKey: keyInput.value.trim(), model: modelInput.value.trim() });
      const probe = providerConfig(id);
      testBtn.disabled = true;
      status.textContent = 'Contacting the endpoint…';
      const r = await testProvider(probe);
      testBtn.disabled = false;
      if (r.ok) {
        status.textContent = r.models
          ? `Reachable — ${r.models} model${r.models === 1 ? '' : 's'} (${r.sample.join(', ')}${r.sample.length > 3 ? ', …' : ''})`
          : `Reachable — ${r.note || 'endpoint answered'}`;
        status.className = 'hint sync-ok';
      } else {
        status.textContent = r.error;
        status.className = 'hint sync-err';
      }
    };

    const modelsBtn = el('button.btn.tiny', { text: 'Load its models' });
    modelsBtn.onclick = async () => {
      modelsBtn.disabled = true;
      status.textContent = 'Loading model list…';
      try {
        const models = await listProviderModels(providerConfig(id));
        status.textContent = `${models.length} models available from ${def.label}`;
        status.className = 'hint sync-ok';
        this.useProvider(id, { silent: true });
        this.onModelsChanged?.();
      } catch (e) {
        status.textContent = prettyError(e);
        status.className = 'hint sync-err';
      } finally { modelsBtn.disabled = false; }
    };

    host.append(
      el('label.lbl', { text: 'Endpoint' }), baseInput,
      def.keyRequired || def.keyOptional
        ? el('label.lbl', { text: def.keyRequired ? 'API key (required)' : 'API key (optional)' })
        : null,
      def.keyRequired || def.keyOptional ? keyInput : null,
      el('label.lbl', { text: 'Default model (optional)' }), modelInput,
      el('p.hint', { html: 'Stored in this browser only, and sent only to that endpoint. Requests that a browser cannot make directly (CORS) are relayed through <code>puter.net.fetch</code>.' }),
      el('div.row', { style: { marginTop: '10px' } },
        el('button.btn.primary.tiny', { text: active ? 'Save (active)' : 'Save & use', onclick: save }),
        testBtn, modelsBtn,
        active && id !== 'puter' ? el('button.btn.tiny', {
          text: 'Switch back to Puter',
          onclick: () => { this.useProvider('puter'); this.selectedProvider = 'puter'; this.build(); },
        }) : null,
        cfg.apiKey ? el('button.btn.tiny.danger', {
          text: 'Remove key',
          onclick: async () => {
            if (!await confirmDialog({ title: `Remove the ${def.label} key?`, message: 'The stored key is deleted from this browser.', danger: true, confirmLabel: 'Remove' })) return;
            saveProviderConfig(id, { apiKey: '' });
            this.build();
          },
        }) : null,
      ),
      status,
      active ? el('div.tag.tool', { style: { marginTop: '8px' }, text: `Active provider: ${def.label}` }) : null,
      !isProviderReady(cfg) && active ? el('div.notice.warn', { style: { marginTop: '8px' }, text: 'This provider is not usable yet — add the missing endpoint or key.' }) : null,
    );
  }

  useProvider(id, { silent = false } = {}) {
    this.updateSettings({ providerId: id });
    this.onModelsChanged?.();
    if (!silent) {
      const def = providerById(id);
      toast(def?.kind === 'puter' ? 'Back to Puter — no key needed' : `Now using ${def?.label || id}`, { type: 'ok' });
      this.build();
    }
  }

  /* ══════════════ app connections ══════════════ */
  connectionsCard() {
    const listEl = el('div.conn-list');
    const renderList = () => {
      const conns = listConnections();
      listEl.replaceChildren();
      if (!conns.length) {
        listEl.append(el('div.fv-empty', { text: 'No connections yet — add a preset below, or connect any REST app.' }));
        return;
      }
      for (const conn of conns) listEl.append(this.connRow(conn, renderList));
    };

    const presetRow = el('div.preset-row', {},
      ...CONNECTION_PRESETS.filter((p) => p.id !== 'custom').map((p) => el('button.btn.tiny', {
        text: `+ ${p.name}`,
        title: p.description,
        onclick: () => { addPreset(p.id); renderList(); toast(`${p.name} connected`, { type: 'ok' }); },
      })),
      el('button.btn.tiny', { text: '+ Custom app…', onclick: () => this.editConnection(null, renderList) }),
    );

    const card = el('div.card', {},
      el('h4', {}, icon('plug'), el('span', { text: '2 · Apps the agent can call' })),
      el('p.hint', { html: 'Each connection is a base URL plus how to authenticate. The agent uses <code>list_connections</code>, <code>call_connection</code> and <code>web_fetch</code> — every call asks your approval first unless you enable auto-approve.' }),
      presetRow,
      listEl,
    );
    renderList();
    return card;
  }

  connRow(conn, renderList) {
    const enabled = el('input', { type: 'checkbox', title: 'Enabled' });
    enabled.checked = conn.enabled !== false;
    enabled.onchange = () => { saveConnection({ ...conn, enabled: enabled.checked }); };

    const status = el('span.dim');
    const testBtn = el('button.btn.tiny', { text: 'Test' });
    testBtn.onclick = async () => {
      testBtn.disabled = true;
      status.textContent = 'calling…';
      try {
        const r = await callConnection(conn, { method: 'GET', path: '', maxChars: 400 });
        status.textContent = `${r.status} ${r.ok ? 'ok' : 'failed'}${r.via === 'puter' ? ' (proxied)' : ''}`;
        status.className = r.ok ? 'dim sync-ok' : 'dim sync-err';
      } catch (e) {
        status.textContent = prettyError(e).slice(0, 90);
        status.className = 'dim sync-err';
      } finally { testBtn.disabled = false; }
    };

    return el('div.conn-row', {},
      el('div.conn-main', {},
        el('div.conn-name', {}, enabled, el('b', { text: conn.name }),
          conn.authType !== 'none' ? el('span.tag', { text: conn.authType }) : null),
        el('div.conn-url', { text: conn.baseUrl || '(no base URL)' }),
        conn.description ? el('div.dim', { text: conn.description }) : null,
        status,
      ),
      el('div.mem-actions', {},
        testBtn,
        el('button.icon-btn', { title: 'Edit', onclick: () => this.editConnection(conn, renderList) }, icon('edit')),
        el('button.icon-btn', {
          title: 'Remove',
          onclick: async () => {
            if (!await confirmDialog({ title: `Remove “${conn.name}”?`, message: 'The connection and its stored key are deleted from this browser.', danger: true, confirmLabel: 'Remove' })) return;
            removeConnection(conn.id);
            renderList();
          },
        }, icon('trash')),
      ),
    );
  }

  editConnection(conn, onSaved) {
    const name = el('input.inp', { type: 'text', value: conn?.name || '', placeholder: 'My weather API' });
    const base = el('input.inp.mono', { type: 'text', value: conn?.baseUrl || '', placeholder: 'https://api.example.com' });
    const auth = el('select.inp', {}, ...AUTH_TYPES.map((a) => el('option', { value: a.id, text: a.label })));
    auth.value = conn?.authType || 'none';
    const key = el('input.inp.mono', { type: 'password', value: conn?.apiKey || '', placeholder: 'token / user:pass', autocomplete: 'off' });
    const headerName = el('input.inp.mono', { type: 'text', value: conn?.headerName || 'X-API-Key' });
    const desc = el('textarea.inp', { rows: 2, placeholder: 'What is this for? The agent reads this to decide when to use it.' });
    desc.value = conn?.description || '';
    const headers = el('textarea.inp.mono', { rows: 2, placeholder: '{"Extra-Header": "value"}  (optional JSON)' });
    headers.value = conn?.headers && Object.keys(conn.headers).length ? JSON.stringify(conn.headers, null, 2) : '';
    const err = el('div.notice.err', { style: { display: 'none' } });

    const authHint = el('p.hint');
    const syncHint = () => {
      const t = AUTH_TYPES.find((a) => a.id === auth.value);
      authHint.textContent = t?.hint || '';
      headerName.parentElement && (headerName.hidden = auth.value !== 'header');
    };
    auth.onchange = syncHint;
    syncHint();

    const body = el('div', {},
      el('label.lbl', { text: 'Name' }), name,
      el('label.lbl', { text: 'Base URL' }), base,
      isLoopbackUrl(base.value) ? el('p.hint', { text: 'Local address — called directly, never through the Puter proxy.' }) : null,
      el('label.lbl', { text: 'Authentication' }), auth, authHint,
      el('label.lbl', { text: 'Header name' }), headerName,
      el('label.lbl', { text: 'Token / credentials' }), key,
      el('label.lbl', { text: 'Description for the agent' }), desc,
      el('label.lbl', { text: 'Extra headers' }), headers,
      el('p.hint', { text: 'Credentials stay in this browser and are only ever sent to this base URL.' }),
      err,
    );

    const modal = openModal({
      title: conn ? 'Edit connection' : 'Connect an app',
      iconName: 'plug',
      body,
      footer: [
        el('button.btn', { text: 'Cancel', onclick: () => modal.close() }),
        el('button.btn.primary', {
          text: 'Save connection',
          onclick: () => {
            const baseUrl = base.value.trim().replace(/\/+$/, '');
            if (!name.value.trim()) return showErr('Give it a name');
            if (!/^https?:\/\/.+/i.test(baseUrl)) return showErr('Base URL must start with http:// or https://');
            let extra = {};
            if (headers.value.trim()) {
              try {
                extra = JSON.parse(headers.value);
                if (!extra || typeof extra !== 'object' || Array.isArray(extra)) throw new Error('not an object');
              } catch { return showErr('Extra headers must be a JSON object'); }
            }
            saveConnection({
              ...(conn || {}),
              name: name.value.trim(), baseUrl, authType: auth.value,
              apiKey: key.value.trim(), headerName: headerName.value.trim() || 'X-API-Key',
              description: desc.value.trim(), headers: extra,
            });
            modal.close();
            onSaved?.();
            toast('Connection saved', { type: 'ok' });
          },
        }),
      ],
    });

    function showErr(msg) { err.textContent = msg; err.style.display = ''; }
  }
}
