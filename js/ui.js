/** UI primitives: icons, toasts, modals, confirmations, approval prompts. */
import { el, esc, copyText } from './util.js';

/* ── icons ──────────────────────────────────────────────── */
const PATHS = {
  file: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6',
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  caret: 'M9 6l6 6-6 6',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  trash: 'M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14',
  check: 'M20 6L9 17l-5-5',
  x: 'M18 6L6 18M6 6l12 12',
  play: 'M6 4l14 8-14 8z',
  stop: 'M6 6h12v12H6z',
  download: 'M12 3v12M7 11l5 5 5-5M4 21h16',
  upload: 'M12 21V9M7 13l5-5 5 5M4 3h16',
  refresh: 'M21 12a9 9 0 1 1-3-6.7M21 3v6h-6',
  gear: 'M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z',
  github: 'M9 19c-4 1.5-4-2.5-6-3m12 5v-3.9a3.4 3.4 0 0 0-1-2.6c3-.3 6.2-1.5 6.2-6.7A5.2 5.2 0 0 0 18.8 4a4.9 4.9 0 0 0-.1-3.6s-1.4-.4-4.5 1.7a15.4 15.4 0 0 0-8.2 0C3 0 1.6.4 1.6.4A4.9 4.9 0 0 0 1.5 4a5.2 5.2 0 0 0-1.4 3.6c0 5.2 3.2 6.4 6.2 6.7a3.4 3.4 0 0 0-1 2.6V21',
  rocket: 'M5 15l-2 7 7-2M13.5 3.5s3.5-.5 7 3c3.5 3.5 3 7 3 7l-8 8-6-6zM14 10h.01',
  terminal: 'M4 17l6-5-6-5M12 19h8',
  sparkles: 'M12 3l1.8 4.6L18.5 9l-4.7 1.4L12 15l-1.8-4.6L5.5 9l4.7-1.4zM19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9z',
  globe: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18',
  eye: 'M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  edit: 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z',
  plus: 'M12 5v14M5 12h14',
  send: 'M5 12h14M13 6l6 6-6 6',
  warn: 'M12 3l10 18H2zM12 9v5M12 17h.01',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v5M12 8h.01',
  user: 'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
  cloud: 'M17.5 19a4.5 4.5 0 0 0 .5-9 6 6 0 0 0-11.6 1.6A3.5 3.5 0 0 0 7 19z',
  disk: 'M4 4h12l4 4v12H4zM8 4v6h8V4M8 20v-6h8v6',
  chip: 'M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3M6 6h12v12H6z',
  branch: 'M6 3v12M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9c0 6-12 3-12 9',
  key: 'M21 2l-2 2m-7.6 7.6a5 5 0 1 1-7 7 5 5 0 0 1 7-7zm0 0L15 8m4 4l3-3 2 2',
  video: 'M23 7l-7 5 7 5zM2 5h14v14H2z',
  brain: 'M9.5 3A2.5 2.5 0 0 0 7 5.5 2.5 2.5 0 0 0 4.5 8c0 .8.4 1.6 1 2a2.6 2.6 0 0 0-.4 1.5A2.5 2.5 0 0 0 7.5 14c0 .5.2 1 .5 1.4A2.6 2.6 0 0 0 7 17a2.5 2.5 0 0 0 4 2 2 2 0 0 0 3-1.7V5a2 2 0 0 0-2-2zM14.5 3A2.5 2.5 0 0 1 17 5.5 2.5 2.5 0 0 1 19.5 8c0 .8-.4 1.6-1 2 .3.4.4.9.4 1.5a2.5 2.5 0 0 1-2.4 2.5c0 .5-.2 1-.5 1.4.6.4 1 .9 1 1.6a2.5 2.5 0 0 1-4 2 2 2 0 0 1-3-1.7V5a2 2 0 0 1 2-2z',
  plug: 'M9 2v6M15 2v6M6 8h12v3a6 6 0 0 1-12 0zM12 17v5',
  zap: 'M13 2L4 14h7l-1 8 9-12h-7z',
  layers: 'M12 2l9 5-9 5-9-5zM3 12l9 5 9-5M3 17l9 5 9-5',
  image: 'M3 5h18v14H3zM8.5 11a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM21 15l-5-5L5 19',
  bot: 'M12 2v3M5 7h14v9a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3zM9 12h.01M15 12h.01M2 12h3M19 12h3',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2',
  book: 'M4 4h7v16H4zM13 4h7v16h-7z',
  save: 'M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2zM17 21v-8H7v8M7 3v5h8',
};

export function icon(name, cls = '') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  if (cls) svg.setAttribute('class', cls);
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', PATHS[name] || PATHS.info);
  svg.append(p);
  return svg;
}

/* ── toasts ─────────────────────────────────────────────── */
export function toast(text, { type = 'info', timeout = 3800, action } = {}) {
  const root = document.getElementById('toast-root');
  if (!root) return;
  const node = el(`div.toast.${type}`, {},
    el('span.tdot'),
    el('span', { text: String(text) }),
    action ? el('button.mini-btn', { text: action.label, onclick: () => { action.onClick?.(); node.remove(); } }) : null,
  );
  root.append(node);
  const kill = () => { node.classList.add('out'); setTimeout(() => node.remove(), 260); };
  const t = setTimeout(kill, timeout);
  node.addEventListener('click', (e) => { if (e.target === node || e.target.classList.contains('tdot')) { clearTimeout(t); kill(); } });
  return kill;
}

/* ── modal ──────────────────────────────────────────────── */
export function openModal({ title, body, footer, onClose, icon: iconName = null, wide = false }) {
  const root = document.getElementById('modal-root');
  const backdrop = el('div.modal-backdrop');
  const closeBtn = el('button.icon-btn', { title: 'Close', onclick: () => close() }, icon('x'));
  const modal = el('div.modal', { style: wide ? { width: 'min(880px,100%)' } : {} },
    el('div.modal-head', {}, iconName ? icon(iconName) : null, el('h3', { text: title }), closeBtn),
    el('div.modal-body', {}, body),
    footer ? el('div.modal-foot', {}, footer) : null,
  );
  backdrop.append(modal);
  root.append(backdrop);
  document.body.style.overflow = 'hidden';

  function close(result) {
    backdrop.remove();
    if (!document.querySelector('.modal-backdrop')) document.body.style.overflow = '';
    onClose?.(result);
  }
  backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) close(); });
  const onKey = (e) => { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); } };
  document.addEventListener('keydown', onKey);
  return { close, root: modal, body: modal.querySelector('.modal-body') };
}

export function confirmDialog({ title = 'Are you sure?', message = '', confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false, html = false }) {
  return new Promise((resolve) => {
    const body = el('div', {}, html ? el('div', { html: message }) : el('div', { text: message, style: { whiteSpace: 'pre-wrap' } }));
    let done = false;
    const m = openModal({
      title, body,
      onClose: () => { if (!done) resolve(false); },
      footer: [
        el('button.btn', { text: cancelLabel, onclick: () => { done = true; m.close(); resolve(false); } }),
        el(`button.btn.${danger ? 'danger' : 'primary'}`, { text: confirmLabel, onclick: () => { done = true; m.close(); resolve(true); } }),
      ],
    });
  });
}

export function promptDialog({ title = 'Enter a value', label = '', value = '', placeholder = '', confirmLabel = 'OK', multiline = false, validate = null }) {
  return new Promise((resolve) => {
    const input = multiline
      ? el('textarea.inp', { rows: 6, placeholder })
      : el('input.inp', { type: 'text', value, placeholder });
    if (multiline) input.value = value;
    const err = el('div.notice.err', { style: { display: 'none', marginTop: '8px' } });
    const body = el('div', {}, label ? el('label.lbl', { text: label }) : null, input, err);
    let done = false;
    const submit = () => {
      const v = input.value.trim();
      if (validate) {
        const problem = validate(v);
        if (problem) { err.textContent = problem; err.style.display = ''; return; }
      }
      done = true; m.close(); resolve(v);
    };
    const m = openModal({
      title, body,
      onClose: () => { if (!done) resolve(null); },
      footer: [
        el('button.btn', { text: 'Cancel', onclick: () => { done = true; m.close(); resolve(null); } }),
        el('button.btn.primary', { text: confirmLabel, onclick: submit }),
      ],
    });
    setTimeout(() => input.focus(), 40);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !multiline) { e.preventDefault(); submit(); } });
  });
}

/** Tool-approval gate shown before a write/exec/publish tool runs. */
export function approvalDialog(call) {
  return new Promise((resolve) => {
    const tierLabel = {
      write: 'modify your workspace',
      exec: 'execute code',
      github: 'talk to GitHub',
      publish: 'publish your project',
      network: 'call an external service you connected',
    }[call.approval] || 'perform an action';
    const argText = JSON.stringify(call.args ?? {}, null, 2);
    const remember = el('input', { type: 'checkbox' });
    const body = el('div', {},
      el('div.notice.warn', { html: `The agent wants to <b>${esc(tierLabel)}</b> using <code>${esc(call.name)}</code>.` }),
      el('label.lbl', { text: 'Arguments', style: { marginTop: '12px' } }),
      el('pre.logbox', { text: argText.length > 3000 ? argText.slice(0, 3000) + '\n…' : argText }),
      el('label.checkline', {}, remember, el('span', { text: `Always allow ${call.name} in this browser` })),
    );
    let done = false;
    const m = openModal({
      title: 'Approve tool call?', iconName: 'warn', body,
      onClose: () => { if (!done) resolve({ allow: false, remember: false, reason: 'dialog dismissed' }); },
      footer: [
        el('button.btn', { text: 'Deny', onclick: () => { done = true; m.close(); resolve({ allow: false, remember: false, reason: 'user denied this call' }); } }),
        el('button.btn.primary', { text: 'Allow', onclick: () => { done = true; m.close(); resolve({ allow: true, remember: remember.checked }); } }),
      ],
    });
  });
}

/** The agent's `ask_user` tool. */
export function askUserDialog(question, options = []) {
  return new Promise((resolve) => {
    const input = el('input.inp', { type: 'text', placeholder: 'Type your answer…' });
    const body = el('div', {},
      el('p', { text: question, style: { margin: '0 0 12px', fontSize: '14px' } }),
      options.length ? el('div.btn-row', { style: { marginBottom: '12px', flexWrap: 'wrap' } },
        ...options.slice(0, 4).map((o) => el('button.btn.tiny', {
          text: o, onclick: () => { input.value = o; input.focus(); },
        }))) : null,
      input,
    );
    let done = false;
    const m = openModal({
      title: 'The agent has a question', iconName: 'bot', body,
      onClose: () => { if (!done) resolve(''); },
      footer: [
        el('button.btn', { text: 'Skip', onclick: () => { done = true; m.close(); resolve(''); } }),
        el('button.btn.primary', { text: 'Answer', onclick: () => { done = true; const v = input.value.trim(); m.close(); resolve(v); } }),
      ],
    });
    setTimeout(() => input.focus(), 40);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); done = true; const v = input.value.trim(); m.close(); resolve(v); }
    });
  });
}

export async function copyButtonFeedback(btn, text) {
  const ok = await copyText(text);
  const prev = btn.textContent;
  btn.textContent = ok ? 'copied ✓' : 'failed';
  setTimeout(() => { btn.textContent = prev; }, 1300);
}
