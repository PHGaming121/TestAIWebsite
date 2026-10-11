/**
 * Markdown rendering: marked → DOMPurify → highlight.js, with copy buttons on
 * every fenced code block. Re-renders are cheap enough for live streaming.
 */
import { copyText, hljsLang, esc, lib } from './util.js';

let configured = false;

function configure() {
  if (configured || !lib('marked')) return;
  try {
    lib('marked').setOptions({
      gfm: true,
      breaks: true,
      headerIds: false,
      mangle: false,
    });
  } catch { /* older/newer option sets — defaults are fine */ }

  const purify = lib('DOMPurify');
  if (purify?.addHook) {
    purify.addHook('afterSanitizeAttributes', (node) => {
      if (node.tagName === 'A' && node.getAttribute('href')?.match(/^https?:/i)) {
        node.setAttribute('target', '_blank');
        node.setAttribute('rel', 'noopener noreferrer');
      }
    });
  }
  configured = true;
}

/** Convert markdown text to sanitised HTML. */
export function mdToHtml(md) {
  configure();
  const text = String(md ?? '');
  const marked = lib('marked');
  if (!marked) return esc(text).replace(/\n/g, '<br>');
  let html;
  try {
    html = marked.parse(text);
  } catch (e) {
    console.warn('[pp] markdown parse failed', e);
    html = esc(text).replace(/\n/g, '<br>');
  }
  const purify = lib('DOMPurify');
  if (purify) {
    html = purify.sanitize(html, { ADD_ATTR: ['target', 'rel'], USE_PROFILES: { html: true } });
  }
  return html;
}

/** Render markdown into an element and enhance code blocks. */
export function renderMarkdownInto(node, md, { langHint } = {}) {
  node.innerHTML = mdToHtml(md);
  node.classList.add('md');
  enhanceCodeBlocks(node, langHint);
  return node;
}

function enhanceCodeBlocks(root, langHint) {
  root.querySelectorAll('pre').forEach((pre) => {
    if (pre.parentElement?.classList.contains('code-wrap')) return;
    const code = pre.querySelector('code');
    const raw = (code || pre).textContent || '';
    let lang = '';
    if (code) {
      const cls = [...code.classList].find((c) => c.startsWith('language-'));
      if (cls) lang = cls.slice(9);
    }
    if (!lang && langHint) lang = langHint;
    if (!lang) lang = guessFromContent(raw);

    const wrap = document.createElement('div');
    wrap.className = 'code-wrap';

    const head = document.createElement('div');
    head.className = 'code-head';
    head.innerHTML = `<span class="lang">${esc(lang || 'code')}</span><span class="acts"></span>`;

    const copyBtn = document.createElement('button');
    copyBtn.textContent = 'copy';
    copyBtn.title = 'Copy code';
    copyBtn.addEventListener('click', async () => {
      const ok = await copyText(raw);
      copyBtn.textContent = ok ? 'copied ✓' : 'failed';
      setTimeout(() => { copyBtn.textContent = 'copy'; }, 1400);
    });

    const dlBtn = document.createElement('button');
    dlBtn.textContent = 'save';
    dlBtn.title = 'Save as file';
    dlBtn.addEventListener('click', () => {
      const ext = extForLang(lang) || 'txt';
      const blob = new Blob([raw], { type: 'text/plain' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `snippet-${Date.now().toString(36)}.${ext}`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 3000);
    });

    head.querySelector('.acts').append(copyBtn, dlBtn);
    pre.replaceWith(wrap);
    wrap.append(head, pre);

    const hl = lib('hljs');
    if (code && hl && lang && lang !== 'plaintext') {
      try {
        code.className = `hljs language-${lang}`;
        const res = hl.highlight(raw, { language: hl.getLanguage(lang) ? lang : 'plaintext', ignoreIllegals: true });
        code.innerHTML = res.value;
      } catch { /* leave as plain text */ }
    }
  });
}

function guessFromContent(code) {
  const c = code.trim();
  if (/^<(!doctype|html|div|svg|body|head)/i.test(c)) return 'html';
  if (/^(import |from |def |class .*:\s*$|print\()/m.test(c) && /:\s*$/m.test(c)) return 'python';
  if (/^(const |let |var |function |=>|import .* from )/m.test(c)) return 'javascript';
  if (/^\s*\{[\s\S]*\}\s*$/.test(c) && /"\w+"\s*:/.test(c)) return 'json';
  if (/^(#!\/bin\/(ba)?sh|ls |cd |mkdir |npm |git |curl )/m.test(c)) return 'bash';
  if (/^(package main|func )/m.test(c)) return 'go';
  if (/^\s*(SELECT|INSERT|CREATE TABLE|UPDATE|DELETE FROM)/im.test(c)) return 'sql';
  return '';
}

function extForLang(lang) {
  const map = {
    javascript: 'js', typescript: 'ts', python: 'py', html: 'html', xml: 'xml', css: 'css', json: 'json',
    bash: 'sh', shell: 'sh', yaml: 'yml', markdown: 'md', go: 'go', rust: 'rs', java: 'java', sql: 'sql',
    ruby: 'rb', php: 'php', c: 'c', cpp: 'cpp', csharp: 'cs', dockerfile: 'dockerfile', plaintext: 'txt',
  };
  return map[String(lang || '').toLowerCase()] || '';
}

export { hljsLang };
