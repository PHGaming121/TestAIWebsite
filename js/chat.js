/**
 * Chat view: renders the transcript, streams tokens into Markdown, and shows
 * each agent tool call as an expandable card.
 */
import { el, esc, formatTime, copyText, truncate } from './util.js';
import { renderMarkdownInto, mdToHtml } from './markdown.js';
import { icon, toast } from './ui.js';
import { shortModelName } from './llm.js';

const AV = { user: 'YOU', assistant: 'AI', tool: 'TOOL', system: 'SYS' };

export class ChatView {
  /**
   * @param {object} o
   * @param {HTMLElement} o.messages   #messages container
   * @param {HTMLElement} o.scroll     scrollable parent
   * @param {HTMLElement} o.welcome    welcome screen element
   * @param {object} o.handlers        {onRegenerate, onEditUser, onDelete, onSendText}
   */
  constructor(o) {
    this.messagesEl = o.messages;
    this.scrollEl = o.scroll;
    this.welcomeEl = o.welcome;
    this.handlers = o.handlers || {};
    this.nodes = new Map();     // message id -> DOM refs
    this.pinnedBottom = true;
    this._raf = null;
    this._dirty = new Set();

    this.scrollEl.addEventListener('scroll', () => {
      const { scrollTop, scrollHeight, clientHeight } = this.scrollEl;
      this.pinnedBottom = scrollHeight - scrollTop - clientHeight < 120;
    }, { passive: true });
  }

  scrollToBottom(force = false) {
    if (!force && !this.pinnedBottom) return;
    requestAnimationFrame(() => { this.scrollEl.scrollTop = this.scrollEl.scrollHeight; });
  }

  clear() {
    this.messagesEl.innerHTML = '';
    this.nodes.clear();
  }

  showWelcome(show) {
    if (this.welcomeEl) this.welcomeEl.classList.toggle('hidden', !show);
  }

  /* ── whole-conversation render ────────────────────────── */
  renderConversation(conv) {
    this.clear();
    const msgs = conv?.messages || [];
    this.showWelcome(msgs.length === 0);
    for (const m of msgs) this.appendMessage(conv, m, { animate: false });
    this.pinnedBottom = true;
    this.scrollToBottom(true);
  }

  /* ── single message ───────────────────────────────────── */
  appendMessage(conv, m, { animate = true } = {}) {
    this.showWelcome(false);
    const wrap = el(`div.msg.${m.role}`, { 'data-id': m.id, style: animate ? {} : { animation: 'none' } });

    const av = el('div.msg-av', { text: AV[m.role] || 'AI' });
    const col = el('div.msg-col');

    const head = el('div.msg-head', {},
      el('span.msg-who', { text: m.role === 'user' ? 'You' : (m.role === 'tool' ? 'Tool' : 'Playground') }),
      el('span.msg-meta', { text: this.metaText(m) }),
    );

    const bubble = el('div.msg-bubble');
    const md = el('div.md');
    bubble.append(md);
    col.append(head);

    // reasoning
    let reasoningBox = null;
    if (m.reasoning) {
      reasoningBox = el('details.reasoning', {},
        el('summary', {}, icon('sparkles'), el('span', { text: 'Thinking' })),
        el('div.r-body', { text: m.reasoning }),
      );
      col.append(reasoningBox);
    }

    // attachments (user messages)
    if (m.attachments?.length) {
      const att = el('div.attachments', { style: { padding: '0 0 8px' } },
        ...m.attachments.map((a) => el('div.att', {},
          a.dataUrl && a.type?.startsWith('image/') ? el('img', { src: a.dataUrl, alt: a.name }) : icon('file'),
          el('span.att-name', { text: a.name })),
        ));
      col.append(att);
    }

    if (m.role === 'tool') {
      col.append(el('div.tool-cards'));
      this.renderToolCards(col.querySelector('.tool-cards'), [{ ...m, name: m.name || 'tool', args: m.args, result: m.content, status: m.status || 'ok' }]);
    } else {
      col.append(bubble);
    }

    const toolBox = el('div');
    col.append(toolBox);
    if (m.toolCalls?.length) this.renderToolCards(toolBox, m.toolCalls);

    // actions
    const actions = el('div.msg-actions');
    const copyBtn = el('button', { title: 'Copy message' }, icon('copy'), el('span', { text: 'copy' }));
    copyBtn.onclick = async () => {
      const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content, null, 2);
      const ok = await copyText(text);
      toast(ok ? 'Copied to clipboard' : 'Copy failed', { type: ok ? 'ok' : 'err' });
    };
    actions.append(copyBtn);

    if (m.role === 'user') {
      const editBtn = el('button', { title: 'Edit & resend' }, icon('edit'), el('span', { text: 'edit' }));
      editBtn.onclick = () => this.handlers.onEditUser?.(m);
      actions.append(editBtn);
    }
    if (m.role === 'assistant') {
      const regen = el('button', { title: 'Regenerate from here' }, icon('refresh'), el('span', { text: 'retry' }));
      regen.onclick = () => this.handlers.onRegenerate?.(m);
      actions.append(regen);
    }
    const del = el('button', { title: 'Delete message' }, icon('trash'), el('span', { text: 'del' }));
    del.onclick = () => this.handlers.onDelete?.(m);
    actions.append(del);
    col.append(actions);

    wrap.append(av, col);
    this.messagesEl.append(wrap);

    const text = typeof m.content === 'string' ? m.content : '';
    if (text) renderMarkdownInto(md, text);
    else if (m.role !== 'tool') md.innerHTML = '';

    this.nodes.set(m.id, { wrap, col, md, bubble, toolBox, head, reasoningBox, record: m, buffer: text });
    this.scrollToBottom();
    return this.nodes.get(m.id);
  }

  metaText(m) {
    const bits = [];
    if (m.model) bits.push(shortModelName(m.model));
    if (m.step) bits.push(`step ${m.step}`);
    if (m.ts) bits.push(formatTime(m.ts));
    if (m.usage?.completion_tokens || m.usage?.output_tokens) bits.push(`${m.usage.completion_tokens || m.usage.output_tokens} tok`);
    if (m.ms) bits.push(`${m.ms}ms`);
    return bits.join(' · ');
  }

  /* ── live streaming ───────────────────────────────────── */
  ensureMessage(conv, m) {
    return this.nodes.get(m.id) || this.appendMessage(conv, m);
  }

  streamText(conv, m, full) {
    const n = this.ensureMessage(conv, m);
    n.buffer = full;
    if (!n.caret) {
      n.caret = el('span.caret-blink');
      n.md.parentElement.append(n.caret);
    }
    this._dirty.add(m.id);
    if (!this._raf) {
      this._raf = requestAnimationFrame(() => {
        this._raf = null;
        for (const id of this._dirty) {
          const node = this.nodes.get(id);
          if (!node) continue;
          renderMarkdownInto(node.md, node.buffer);
        }
        this._dirty.clear();
        this.scrollToBottom();
      });
    }
  }

  streamReasoning(conv, m, full) {
    const n = this.ensureMessage(conv, m);
    if (!n.reasoningBox) {
      n.reasoningBox = el('details.reasoning', {},
        el('summary', {}, icon('sparkles'), el('span', { text: 'Thinking…' })),
        el('div.r-body'),
      );
      n.col.insertBefore(n.reasoningBox, n.bubble);
    }
    n.reasoningBox.querySelector('.r-body').textContent = full;
    if (!n.reasoningBox.open && full.length < 4000) n.reasoningBox.open = true;
    this.scrollToBottom();
  }

  finishStreaming(conv, m) {
    const n = this.nodes.get(m.id);
    if (!n) return;
    n.caret?.remove(); n.caret = null;
    const text = typeof m.content === 'string' ? m.content : '';
    renderMarkdownInto(n.md, text);
    n.buffer = text;
    n.head.querySelector('.msg-meta').textContent = this.metaText(m);
    if (n.reasoningBox) n.reasoningBox.querySelector('summary span').textContent = 'Thought process';
    if (n.reasoningBox) n.reasoningBox.open = false;
    this.scrollToBottom();
  }

  /* ── tool cards ───────────────────────────────────────── */
  renderToolCards(container, calls) {
    for (const c of calls || []) this.upsertToolCard(container, c);
  }

  upsertToolCard(container, call) {
    if (!container) return null;
    // keyed lookup instead of a CSS selector — tool ids can contain any characters
    if (!this._cards) this._cards = new WeakMap();
    let byId = this._cards.get(container);
    if (!byId) { byId = new Map(); this._cards.set(container, byId); }
    const key = call.id || call.name;
    let card = byId.get(key);
    if (!card) {
      card = el('div.tool-card.run', { 'data-call': call.id || call.name });
      const head = el('div.tc-head', {},
        el('div.tc-ico', {}, icon(toolIcon(call.name))),
        el('span.tc-name', { text: call.name }),
        el('span.tc-args', { text: argSummary(call.args) }),
        el('span.tc-status', {}, el('span.mini-spin')),
      );
      const body = el('div.tc-body', { style: { display: 'none' } }, el('pre'));
      head.onclick = () => {
        const open = body.style.display !== 'none';
        body.style.display = open ? 'none' : '';
        head.querySelector('.tc-ico').style.transform = open ? '' : 'rotate(0deg)';
      };
      card.append(head, body);
      container.append(card);
      byId.set(key, card);
    }
    const status = card.querySelector('.tc-status');
    const body = card.querySelector('.tc-body pre');
    card.querySelector('.tc-args').textContent = argSummary(call.args);

    if (call.status === 'pending' || call.status === 'running' || !call.status) {
      card.className = 'tool-card run';
      status.innerHTML = '';
      status.append(el('span.mini-spin'));
    } else {
      card.className = `tool-card ${call.status === 'error' ? 'err' : call.status === 'denied' ? 'err' : 'ok'}`;
      status.textContent = call.status === 'error' ? 'failed' : call.status === 'denied' ? 'denied' : (call.ms ? `${call.ms}ms` : 'done');
      body.textContent = truncate(String(call.result ?? ''), 6000);
      if (call.status === 'error') body.classList.add('tc-err');
      if (call.status === 'ok' && !body.classList.contains('tc-err')) body.classList.add('tc-ok');
      // auto-open failures so the user can see what happened
      if (call.status === 'error' || call.status === 'denied') body.style.display = '';
    }
    this.scrollToBottom();
    return card;
  }

  /** Live card for a call that has not been executed yet. */
  addPendingToolCard(m, call) {
    const n = this.nodes.get(m.id);
    if (!n) return;
    return this.upsertToolCard(n.toolBox, { ...call, status: 'running' });
  }

  updateToolCard(m, call) {
    const n = this.nodes.get(m.id);
    if (!n) return;
    return this.upsertToolCard(n.toolBox, call);
  }

  /* ── misc ─────────────────────────────────────────────── */
  addNotice(text, type = 'info') {
    const node = el('div.msg.system', {},
      el('div.msg-av', { text: '!' }),
      el('div.msg-col', {}, el('div.msg-bubble', {}, el(`div.notice.${type}`, { text }))),
    );
    this.messagesEl.append(node);
    this.scrollToBottom(true);
    return node;
  }

  setBusy(busy) {
    this.messagesEl.classList.toggle('busy', busy);
  }
}

function toolIcon(name) {
  if (!name) return 'terminal';
  if (name.startsWith('github')) return 'github';
  if (name.startsWith('run_') || name === 'run_shell') return 'terminal';
  if (name === 'generate_image') return 'image';
  if (name === 'deploy_to_puter') return 'rocket';
  if (name === 'ask_user') return 'user';
  if (name === 'finish') return 'check';
  if (name.startsWith('read') || name.startsWith('list') || name.startsWith('search')) return 'eye';
  if (name.startsWith('write') || name.startsWith('edit') || name === 'make_directory') return 'edit';
  if (name.startsWith('delete')) return 'trash';
  return 'chip';
}

function argSummary(args) {
  if (!args || typeof args !== 'object') return '';
  const keys = Object.keys(args);
  if (!keys.length) return '';
  const parts = keys.slice(0, 3).map((k) => {
    const v = args[k];
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    return `${k}=${s.length > 60 ? s.slice(0, 60) + '…' : s}`;
  });
  if (keys.length > 3) parts.push(`+${keys.length - 3}`);
  return parts.join('  ');
}

/** Render the welcome/start screen cards. */
export function renderStarters(container, starters, onPick) {
  container.innerHTML = '';
  for (const s of starters) {
    const card = el('button.wcard', { type: 'button' },
      el('div.wc-ico', {}, icon(s.icon || 'sparkles')),
      el('h4', { text: s.title }),
      el('p', { text: s.text.length > 130 ? s.text.slice(0, 130) + '…' : s.text }),
    );
    card.onclick = () => onPick(s);
    container.append(card);
  }
}

export { mdToHtml };
