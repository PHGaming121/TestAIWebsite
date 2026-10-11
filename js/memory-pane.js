/**
 * Memory pane: view, add, edit, pin, search and distil long-term memories, and
 * optionally mirror them into the user's own Puter KV so they follow them
 * across devices.
 *
 * Distillation is the only step that calls a model, it is never automatic, and
 * every candidate has to be ticked by hand before it is stored.
 */
import { el, prettyError, formatTime, downloadBlob, truncate } from './util.js';
import { icon, toast, confirmDialog, promptDialog, openModal } from './ui.js';
import {
  MEMORY_KINDS, memories, addMemory, updateMemory, removeMemory, clearMemories,
  searchMemory, memoryStats, distillConversation, pushMemoriesToCloud, pullMemoriesFromCloud, mergeMemories,
} from './memory.js';

export class MemoryPane {
  /**
   * @param {object} o
   * @param {HTMLElement} o.container   #memory-pane
   * @param {Function} o.getSettings    () => settings object
   * @param {Function} o.updateSettings (patch) => void
   * @param {Function} o.activeConv     () => conversation record
   * @param {Function} o.complete       (messages, opts) => Promise<string>
   * @param {Function}[o.sideBody]      sidebar block body to re-render
   */
  constructor(o) {
    Object.assign(this, o);
    this.query = '';
    this.kindFilter = '';
    this.candidates = [];
    this.build();
  }

  build() {
    const c = this.container;
    c.innerHTML = '';

    /* ── controls ─────────────────────────────────────── */
    this.searchEl = el('input.inp', { type: 'search', placeholder: 'Search memories…' });
    this.searchEl.addEventListener('input', () => { this.query = this.searchEl.value.trim(); this.renderList(); });

    this.kindSel = el('select.inp', {},
      el('option', { value: '', text: 'all kinds' }),
      ...MEMORY_KINDS.map((k) => el('option', { value: k.id, text: k.label })),
    );
    this.kindSel.onchange = () => { this.kindFilter = this.kindSel.value; this.renderList(); };

    const addBtn = el('button.btn.tiny', {}, icon('plus'), el('span', { text: 'Add' }));
    addBtn.onclick = () => this.addFlow();

    /* ── sync ─────────────────────────────────────────── */
    this.syncCheck = el('input', { type: 'checkbox' });
    this.syncCheck.checked = !!this.getSettings().memorySync;
    this.syncCheck.onchange = async () => {
      this.updateSettings({ memorySync: this.syncCheck.checked });
      if (!this.syncCheck.checked) { this.renderStats(); return; }
      try {
        await pushMemoriesToCloud();
        this.setSyncNote('Mirrored to your Puter KV', 'ok');
      } catch (e) {
        this.syncCheck.checked = false;
        this.updateSettings({ memorySync: false });
        this.setSyncNote(prettyError(e), 'err');
      }
      this.renderStats();
    };
    const syncNowBtn = el('button.btn.tiny', { text: 'Sync now', title: 'Push local memories and merge the cloud copy' });
    syncNowBtn.onclick = async () => this.syncNow();
    this.syncNote = el('div.hint');

    /* ── distil ───────────────────────────────────────── */
    this.distilBtn = el('button.btn.wide', {}, icon('sparkles'), el('span', { text: 'Distil memories from this conversation' }));
    this.distilBtn.onclick = () => this.distil();
    this.candidateBox = el('div.candidates');

    /* ── list ─────────────────────────────────────────── */
    this.listEl = el('div.memory-list');
    this.statsEl = el('div.hint');

    /* ── export / import / clear ──────────────────────── */
    const exportBtn = el('button.btn.tiny', { text: 'Export JSON' });
    exportBtn.onclick = () => {
      const payload = { exportedAt: new Date().toISOString(), items: memories() };
      downloadBlob(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }), 'playground-memories.json');
      toast('Memories exported', { type: 'ok' });
    };
    const importBtn = el('button.btn.tiny', { text: 'Import' });
    const importFile = el('input', { type: 'file', accept: 'application/json,.json', style: { display: 'none' } });
    importBtn.onclick = () => importFile.click();
    importFile.onchange = async () => {
      const f = importFile.files?.[0];
      if (!f) return;
      try {
        const data = JSON.parse(await f.text());
        const items = Array.isArray(data) ? data : data.items;
        const { added, updated } = mergeMemories(items || []);
        toast(`Imported: ${added} new, ${updated} updated`, { type: 'ok' });
        this.refresh();
      } catch (e) { toast(prettyError(e), { type: 'err' }); }
      importFile.value = '';
    };
    const clearBtn = el('button.btn.tiny.danger', { text: 'Erase all' });
    clearBtn.onclick = async () => {
      if (!await confirmDialog({
        title: 'Erase every memory?',
        message: 'All long-term memories stored in this browser are deleted. This cannot be undone.',
        danger: true, confirmLabel: 'Erase everything',
      })) return;
      clearMemories();
      this.refresh();
      toast('Long-term memory erased');
    };

    c.append(
      el('div.card', {},
        el('h4', {}, icon('brain'), el('span', { text: 'Long-term memory' })),
        el('p.hint', { html: 'Durable facts the agent keeps across conversations — who you are, how you like things done, what you are building. Stored in this browser; nothing is sent anywhere unless you switch on the Puter mirror below.' }),
        el('div.row', { style: { marginTop: '8px' } }, this.searchEl, this.kindSel, addBtn),
        this.statsEl,
      ),
      el('div.card', {},
        el('h4', {}, icon('sparkles'), el('span', { text: 'Distil from a conversation' })),
        el('p.hint', { text: 'Asks a model to propose memories from the open conversation. Nothing is saved until you tick it — and secrets are never proposed.' }),
        this.distilBtn,
        this.candidateBox,
      ),
      el('div.card', {},
        el('h4', {}, icon('cloud'), el('span', { text: 'Cross-device mirror' })),
        el('label.checkline', {}, this.syncCheck,
          el('span', {}, el('b', { text: 'Mirror into my Puter KV' }), el('span', { text: ' — needs a free Puter sign-in; the key is yours, in your own cloud space' }))),
        el('div.row', { style: { marginTop: '6px' } }, syncNowBtn),
        this.syncNote,
      ),
      el('div.card', {},
        el('h4', {}, icon('layers'), el('span', { text: 'Memories' })),
        this.listEl,
        el('div.row', { style: { marginTop: '10px' } }, exportBtn, importBtn, importFile, clearBtn),
      ),
    );

    this.refresh();
  }

  refresh() { this.renderStats(); this.renderList(); }

  renderStats() {
    const st = memoryStats();
    const kindLine = st.byKind.filter((k) => k.n).map((k) => `${k.n} ${k.label.toLowerCase()}`).join(' · ');
    this.statsEl.replaceChildren(el('span', {
      text: st.count
        ? `${st.count} memor${st.count === 1 ? 'y' : 'ies'} · ${st.pinned} pinned · ${kindLine || 'mixed'}`
        : 'No memories yet — add one, or distil them from a conversation.',
    }));
  }

  renderList() {
    const list = this.query || this.kindFilter
      ? searchMemory(this.query, { limit: 200, kind: this.kindFilter })
      : memories();
    this.listEl.replaceChildren();
    if (!list.length) {
      this.listEl.append(el('div.fv-empty', { text: this.query ? `Nothing matches “${this.query}”` : 'Nothing stored yet.' }));
      return;
    }
    for (const m of list) this.listEl.append(this.row(m));
  }

  row(m) {
    const kindTag = el('span.tag', { text: m.kind });
    if (m.pinned) kindTag.classList.add('free');
    const textEl = el('div.mem-text', { text: m.text });
    const meta = el('div.mem-meta', {},
      kindTag,
      ...(m.tags || []).map((t) => el('span.tag', { text: `#${t}` })),
      el('span.dim', { text: `${m.source || 'user'} · ${formatTime(m.updatedAt || m.createdAt)}` }),
      m.hits ? el('span.dim', { text: `used ${m.hits}×` }) : null,
    );

    const pinBtn = el('button.icon-btn', { title: m.pinned ? 'Unpin' : 'Pin (always inject)' }, icon('sparkles'));
    pinBtn.onclick = () => { updateMemory(m.id, { pinned: !m.pinned }); this.refresh(); };
    if (m.pinned) pinBtn.classList.add('on');

    const editBtn = el('button.icon-btn', { title: 'Edit' }, icon('edit'));
    editBtn.onclick = async () => {
      const next = await promptDialog({
        title: 'Edit memory', label: 'Text', value: m.text, multiline: true, confirmLabel: 'Save',
      });
      if (next) { updateMemory(m.id, { text: next }); this.refresh(); toast('Memory updated', { type: 'ok' }); }
    };

    const delBtn = el('button.icon-btn', { title: 'Delete' }, icon('trash'));
    delBtn.onclick = async () => {
      if (!await confirmDialog({ title: 'Delete this memory?', message: truncate(m.text, 200, '…'), danger: true, confirmLabel: 'Delete' })) return;
      removeMemory(m.id);
      this.refresh();
    };

    return el('div.mem-row', {},
      el('div.mem-main', {}, textEl, meta),
      el('div.mem-actions', {}, pinBtn, editBtn, delBtn),
    );
  }

  async addFlow() {
    const text = await promptDialog({
      title: 'Add a memory',
      label: 'What should the agent remember in every future conversation?',
      placeholder: 'The user prefers plain JavaScript over TypeScript',
      multiline: true,
      confirmLabel: 'Remember',
    });
    if (!text) return;
    const kind = await this.pickKind();
    addMemory({ text, kind, source: 'user' });
    this.refresh();
    toast('Memory saved', { type: 'ok' });
  }

  /** Which kind of memory is this? Six big buttons beat a <select> here. */
  pickKind() {
    return new Promise((resolve) => {
      const buttons = MEMORY_KINDS.map((k) => el('button.kind-opt', {},
        el('b', { text: k.label }),
        el('span', { text: k.hint }),
      ));
      const body = el('div.kind-grid', {}, ...buttons);
      const modal = openModal({ title: 'What kind of memory is this?', iconName: 'brain', body });
      buttons.forEach((btn, i) => {
        btn.onclick = () => { modal.close(); resolve(MEMORY_KINDS[i].id); };
      });
      // closing without choosing falls back to a plain note
      const origClose = modal.close;
      modal.close = (r) => { resolve('note'); origClose.call(modal, r); };
    });
  }

  /* ── distillation ──────────────────────────────────── */
  async distil() {
    const conv = this.activeConv?.();
    if (!conv || !(conv.messages || []).length) { toast('Open a conversation with some messages first', { type: 'warn' }); return; }
    this.distilBtn.disabled = true;
    this.candidateBox.replaceChildren(el('div.hint', { text: 'Reading the conversation…' }));
    try {
      const model = this.getSettings().memoryDistillModel || this.getSettings().model;
      const found = await distillConversation(conv, { complete: this.complete, model });
      this.candidates = found;
      if (!found.length) {
        this.candidateBox.replaceChildren(el('div.hint', { text: 'Nothing worth keeping in this conversation — no memories proposed.' }));
        return;
      }
      this.renderCandidates();
    } catch (e) {
      this.candidateBox.replaceChildren(el('div.notice.err', { text: prettyError(e) }));
    } finally {
      this.distilBtn.disabled = false;
    }
  }

  renderCandidates() {
    const boxes = [];
    this.candidateBox.replaceChildren(
      el('div.hint', { text: `${this.candidates.length} candidate${this.candidates.length === 1 ? '' : 's'} — tick what is actually worth keeping:` }),
      ...this.candidates.map((cand) => {
        const box = el('input', { type: 'checkbox' });
        box.checked = true;
        boxes.push({ box, cand });
        return el('label.cand', {}, box,
          el('span', {},
            el('span.tag', { text: cand.kind }),
            el('span', { text: ` ${cand.text}` }),
            cand.tags?.length ? el('span.dim', { text: ` · #${cand.tags.join(' #')}` }) : null,
          ));
      }),
      el('div.row', { style: { marginTop: '8px' } },
        el('button.btn.primary.tiny', {
          text: 'Save selected',
          onclick: () => {
            let n = 0;
            for (const { box, cand } of boxes) {
              if (!box.checked) continue;
              addMemory({ text: cand.text, kind: cand.kind, tags: cand.tags, source: 'distill' });
              n++;
            }
            this.candidates = [];
            this.candidateBox.replaceChildren(el('div.hint', { text: n ? `Saved ${n} memor${n === 1 ? 'y' : 'ies'}.` : 'Nothing selected.' }));
            this.refresh();
            if (n) toast(`Saved ${n} memories`, { type: 'ok' });
          },
        }),
        el('button.btn.tiny', { text: 'Discard', onclick: () => { this.candidates = []; this.candidateBox.replaceChildren(); } }),
      ),
    );
  }

  /* ── cloud mirror ──────────────────────────────────── */
  async syncNow() {
    this.setSyncNote('Syncing…', '');
    try {
      const pulled = await pullMemoriesFromCloud();
      const pushed = await pushMemoriesToCloud();
      this.setSyncNote(`Merged ${pulled.added} new / ${pulled.updated} updated from the cloud · ${pushed} stored`, 'ok');
      this.refresh();
    } catch (e) {
      this.setSyncNote(prettyError(e), 'err');
    }
  }

  setSyncNote(text, kind) {
    this.syncNote.textContent = text;
    this.syncNote.className = `hint${kind ? ` sync-${kind}` : ''}`;
  }

}
