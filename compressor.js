/*!
 * Forge Token Compressor
 * ---------------------------------------------------------------------------
 * A dependency-free, browser-side context compressor for the CodeCraft chat
 * and agent pipelines. It rewrites the *outbound* request payload so fewer
 * input tokens are spent per turn, then reports exactly what it saved.
 *
 * Design rules that keep this honest and safe:
 *   1. The newest user message is never modified. Ever.
 *   2. The workspace itself is never touched — compression only affects the
 *      copy of the conversation that is about to be sent to the provider.
 *   3. Every technique is measured separately, so the UI can show real
 *      before/after numbers instead of a marketing claim.
 *   4. Lossy techniques (comment stripping, symbol summarisation) are labelled
 *      `lossy` in the report and are opt-in through the `safe` profile.
 *
 * Exposes: globalThis.ForgeCompressor
 */
(function (root) {
  'use strict';

  /* ---------------------------------------------------------------------- *
   * Token estimation
   * ---------------------------------------------------------------------- */

  // Ranges that tokenizers usually encode as (close to) one token per glyph.
  const WIDE_RE = /[\u1100-\u11ff\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef\u3000-\u303f]/g;
  const WORD_RE = /[A-Za-z_][A-Za-z0-9_]*/g;
  const SYMBOL_RE = /[{}()[\]<>#%&*+\-=|~^$@!?;:.,"'`\\/]/g;

  /**
   * Estimate the token count of a string.
   *
   * This is a heuristic, not a tokenizer: it blends character density (prose
   * runs about 4 characters per token, code and punctuation run denser) with
   * word and symbol counts. It is deliberately stable so that the savings
   * percentage shown in the UI is meaningful.
   */
  function estimateTokens(value) {
    const text = typeof value === 'string' ? value : value == null ? '' : String(value);
    if (!text) return 0;
    const wide = (text.match(WIDE_RE) || []).length;
    const narrow = text.length - wide;
    if (!narrow) return wide;
    const words = (text.match(WORD_RE) || []).length;
    const symbols = (text.match(SYMBOL_RE) || []).length;
    const byChars = narrow / 3.85;
    const byWords = words * 0.78;
    const bySymbols = symbols * 0.34;
    // Weighted blend: characters dominate, words/symbols correct for very
    // dense code (many braces) and very sparse prose.
    const estimate = byChars * 0.62 + byWords * 0.24 + bySymbols * 0.14;
    return Math.max(1, Math.ceil(estimate) + wide);
  }

  function estimateMessages(messages, options = {}) {
    if (!Array.isArray(messages)) return 0;
    const overhead = options.perMessageOverhead ?? 4;
    return messages.reduce((sum, message) => {
      const content = messageContent(message);
      const toolCalls = message?.tool_calls ? JSON.stringify(message.tool_calls).length / 3.85 : 0;
      return sum + estimateTokens(content) + Math.ceil(toolCalls) + overhead;
    }, 0);
  }

  function messageContent(message) {
    const content = message?.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .map(part => (typeof part === 'string' ? part : part?.text || part?.content || ''))
        .join('\n');
    }
    return '';
  }

  /* ---------------------------------------------------------------------- *
   * Profiles
   * ---------------------------------------------------------------------- */

  const PROFILES = {
    off: {
      id: 'off',
      label: 'Off',
      keepTurns: 2,
      description: 'Send the conversation exactly as written. No compression.',
      lossy: false,
      stripComments: false,
      compactFiles: false,
      suppressRepeats: false,
      tightenProse: false,
      summarizeHistory: false,
      summarizeCode: false,
      pruneOldPayloads: false,
      compactToolSchemas: false,
      dropBlankLines: false
    },
    safe: {
      id: 'safe',
      label: 'Safe',
      keepTurns: 2,
      description: 'Whitespace, repeated file payloads and duplicated text only. Nothing is rewritten.',
      lossy: false,
      stripComments: false,
      compactFiles: true,
      suppressRepeats: true,
      tightenProse: false,
      summarizeHistory: false,
      summarizeCode: false,
      pruneOldPayloads: false,
      compactToolSchemas: true,
      dropBlankLines: true
    },
    balanced: {
      id: 'balanced',
      label: 'Balanced',
      keepTurns: 2,
      description: 'Recommended. Also trims code comments and tightens older prose on the way out.',
      lossy: true,
      stripComments: true,
      compactFiles: true,
      suppressRepeats: true,
      tightenProse: true,
      summarizeHistory: true,
      summarizeCode: false,
      pruneOldPayloads: true,
      compactToolSchemas: true,
      dropBlankLines: true
    },
    aggressive: {
      id: 'aggressive',
      label: 'Aggressive',
      keepTurns: 1,
      description: 'Maximum reduction. Elides large code bodies down to signatures. May omit detail the model needs for full-file rewrites.',
      lossy: true,
      stripComments: true,
      compactFiles: true,
      suppressRepeats: true,
      tightenProse: true,
      summarizeHistory: true,
      summarizeCode: true,
      pruneOldPayloads: true,
      compactToolSchemas: true,
      dropBlankLines: true
    }
  };

  const DEFAULT_OPTIONS = {
    profile: 'balanced',
    targetTokens: 0,
    keepRecentTurns: 2,
    perMessageOverhead: 4,
    seen: null,
    // Bodies shorter than this are not worth replacing with a pointer.
    repeatThreshold: 320,
    // Age (in turns) before a tool payload is reduced to a stub. Bodies are
    // never lost: read_file reloads them on demand.
    pruneAfterTurns: 2,
    // Tool output produced by *this* turn is rewritten too (comments trimmed),
    // because that is where most agent-mode tokens are spent. User and
    // assistant text inside the live turn is still left byte-for-byte intact.
    compactCurrentTurnFiles: true
  };

  function resolveProfile(profile) {
    if (typeof profile === 'object' && profile) return { ...PROFILES.balanced, ...profile };
    return PROFILES[profile] || PROFILES.balanced;
  }

  // Individual options may override the profile's flags, so the UI switches
  // work exactly as labelled regardless of which profile is selected.
  const OVERRIDABLE_FLAGS = [
    'stripComments', 'compactFiles', 'suppressRepeats', 'tightenProse',
    'summarizeHistory', 'summarizeCode', 'pruneOldPayloads', 'compactToolSchemas', 'dropBlankLines'
  ];

  function resolveProfileFor(config) {
    const profile = { ...resolveProfile(config.profile) };
    for (const flag of OVERRIDABLE_FLAGS) {
      if (typeof config[flag] === 'boolean') profile[flag] = config[flag];
    }
    return profile;
  }

  /* ---------------------------------------------------------------------- *
   * Shared helpers
   * ---------------------------------------------------------------------- */

  // Comments that carry meaning for tooling or for humans must survive.
  const IMPORTANT_COMMENT_RE = /^(?:!|@preserve|@license|@cc_on|@ts-|@flow|@jsx|@vitest|@jest|eslint|prettier|tslint|biome|stylelint|istanbul|#!|#\s*type:|#\s*noqa|#\s*pragma|#\s*coding[:=]|#\s*-?-\s*coding|region|endregion|TODO|FIXME|HACK|XXX|NOTE:|SAFETY|SECURITY|IMPORTANT:|nolint|noqa|c8 ignore|v8 ignore|istanbul ignore|webpackChunkName|vite-ignore)/i;
  const DIRECTIVE_HINT_RE = /@(?:ts|jsx|flow|vitest|jest|license|preserve|cc_on)|eslint|prettier|noqa|nolint|coding[:=]/i;

  function collapseSpacesInProse(line) {
    return line.replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+$/g, '');
  }

  function countBlankLines(text) {
    return (text.match(/^\s*$/gm) || []).length;
  }

  /**
   * Split a text into prose and fenced-code segments so each can be treated
   * with rules that suit it.
   */
  function segment(text) {
    const segments = [];
    const lines = String(text).split('\n');
    let prose = [];
    let index = 0;
    const flushProse = () => {
      if (!prose.length) return;
      segments.push({ type: 'prose', text: prose.join('\n') });
      prose = [];
    };
    while (index < lines.length) {
      const fence = /^\s*(```+|~~~+)\s*([^\s`]*)/.exec(lines[index]);
      if (fence) {
        const marker = fence[1][0].repeat(3);
        const lang = (fence[2] || '').trim().toLowerCase();
        const body = [];
        index += 1;
        while (index < lines.length && !new RegExp(`^\\s*${fence[1][0]}{3,}\\s*$`).test(lines[index])) {
          body.push(lines[index]);
          index += 1;
        }
        index += 1; // consume closing fence
        flushProse();
        segments.push({ type: 'code', lang, text: body.join('\n'), marker });
        continue;
      }
      prose.push(lines[index]);
      index += 1;
    }
    flushProse();
    return segments;
  }

  function rebuild(segments) {
    return segments
      .map(part => (part.type === 'code' ? `${part.marker}${part.lang || ''}\n${part.text}\n${part.marker}` : part.text))
      .join('\n');
  }

  /* ---------------------------------------------------------------------- *
   * Comment stripping (language aware, string aware)
   * ---------------------------------------------------------------------- */

  const COMMENT_SPECS = {
    js: { line: ['//'], block: [['/*', '*/']], template: true, regex: true },
    python: { line: ['#'], triple: true },
    shell: { line: ['#'] },
    yaml: { line: ['#'], hashNeedsSpace: true },
    sql: { line: ['--'], block: [['/*', '*/']] },
    html: { block: [['<!--', '-->']] },
    css: { block: [['/*', '*/']] },
    lua: { line: ['--'], block: [['--[[', ']]']] },
    ruby: { line: ['#'] },
    php: { line: ['//', '#'], block: [['/*', '*/']] },
    c: { line: ['//'], block: [['/*', '*/']] },
    batch: { line: ['::', 'REM '] }
  };

  const LANG_GROUPS = {
    js: ['js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'javascript', 'typescript', 'jsonc', 'vue', 'svelte', 'java', 'kt', 'kts', 'swift', 'go', 'rust', 'rs', 'cs', 'c', 'h', 'cc', 'cpp', 'hpp', 'scala', 'dart', 'groovy', 'gradle', 'php', 'solidity'],
    python: ['py', 'python', 'pyi'],
    shell: ['sh', 'bash', 'zsh', 'fish', 'shell', 'console', 'dockerfile', 'makefile', 'make', 'toml', 'ini', 'cfg', 'conf', 'properties', 'env', 'gitignore', 'editorconfig', 'desktop'],
    yaml: ['yaml', 'yml'],
    sql: ['sql', 'hql', 'plsql'],
    html: ['html', 'htm', 'xml', 'svg', 'vue-template', 'markdown-html'],
    css: ['css', 'scss', 'sass', 'less', 'styl', 'stylus', 'postcss'],
    lua: ['lua', 'luau'],
    ruby: ['rb', 'ruby', 'rake', 'gemspec'],
    batch: ['bat', 'cmd', 'ps1', 'powershell']
  };

  function normalizeLang(lang) {
    const value = String(lang || '').toLowerCase().trim().replace(/^language-/, '');
    if (!value) return '';
    if (COMMENT_SPECS[value]) return value;
    for (const [group, aliases] of Object.entries(LANG_GROUPS)) {
      if (aliases.includes(value)) return group;
    }
    if (COMMENT_SPECS[value.split(/[.:]/)[0]]) return value.split(/[.:]/)[0];
    return value;
  }

  function langFromPath(path) {
    const name = String(path || '').split('/').pop().toLowerCase();
    if (name === 'dockerfile') return 'shell';
    if (name === 'makefile') return 'shell';
    if (/^\.?gitignore|^\.?dockerignore|^\.?npmrc|^\.?editorconfig|^\.?env/.test(name)) return 'shell';
    const ext = name.includes('.') ? name.split('.').pop() : name;
    return normalizeLang(ext);
  }

  function stringDelimiter(char) {
    return char === '"' || char === "'" || char === '`';
  }

  /**
   * Remove comments from source text without touching string contents.
   * Returns `{ text, removed }` where `removed` is the number of characters
   * dropped. Unknown languages are returned unchanged.
   */
  function stripComments(source, lang) {
    const language = normalizeLang(lang);
    const spec = COMMENT_SPECS[language];
    if (!spec || !source) return { text: source, removed: 0 };
    const blockOpenings = (spec.block || []).map(([open, close]) => ({ open, close }));
    let out = '';
    let index = 0;
    let removed = 0;
    let quote = null;
    let regexMode = false;
    let regexClass = false;
    const length = source.length;
    const isHashLang = (spec.line || []).includes('#');
    let atLineStart = true;

    const append = chunk => { out += chunk; };
    const skipTo = end => { removed += end - index; index = end; };

    while (index < length) {
      const char = source[index];

      if (quote) {
        append(char);
        if (char === '\\' && quote !== '`') { append(source[index + 1] || ''); index += 2; continue; }
        if (char === quote) quote = null;
        if (char === '\n') {
          if (quote === '`' || quote === "'") quote = null; // unterminated: fail open
          atLineStart = true;
        }
        index += 1;
        continue;
      }

      if (spec.triple && (source.startsWith('"""', index) || source.startsWith("'''", index))) {
        const marker = source.slice(index, index + 3);
        const end = source.indexOf(marker, index + 3);
        const stop = end === -1 ? length : end + 3;
        append(source.slice(index, stop));
        index = stop;
        atLineStart = false;
        continue;
      }

      if (regexMode) {
        append(char);
        if (char === '\\') { append(source[index + 1] || ''); index += 2; continue; }
        if (char === '[') regexClass = true;
        else if (char === ']') regexClass = false;
        else if (char === '/' && !regexClass) regexMode = false;
        else if (char === '\n') regexMode = false;
        index += 1;
        continue;
      }

      if (stringDelimiter(char) && !(isHashLang && char === "'" && /[\u2019']/.test(source[index - 1] || ''))) {
        quote = char;
        append(char);
        index += 1;
        atLineStart = false;
        continue;
      }

      // Line and block comments are tested *before* regular-expression
      // detection: `3, // note` is a comment, never a regex.
      let matched = false;
      for (const marker of spec.line || []) {
        if (!source.startsWith(marker, index)) continue;
        if (marker === 'REM ' && index > 0 && !/\s/.test(source[index - 1])) continue;
        if (marker === '#' && spec.hashNeedsSpace && !atLineStart && !/\s/.test(source[index - 1] || '')) continue;
        if (marker === '//' && (source[index - 1] === ':')) continue; // https://
        const lineEnd = source.indexOf('\n', index);
        const stop = lineEnd === -1 ? length : lineEnd;
        const commentText = source.slice(index, stop);
        if (IMPORTANT_COMMENT_RE.test(commentText.replace(/^[#/;:*-]+/, '').trim()) || DIRECTIVE_HINT_RE.test(commentText)) {
          append(commentText);
        } else {
          removed += stop - index;
        }
        index = stop;
        matched = true;
        break;
      }
      if (matched) continue;

      for (const entry of blockOpenings) {
        if (!source.startsWith(entry.open, index)) continue;
        const end = source.indexOf(entry.close, index + entry.open.length);
        if (end === -1) { matched = true; break; } // unterminated: keep the rest verbatim
        const commentText = source.slice(index + entry.open.length, end);
        if (IMPORTANT_COMMENT_RE.test(commentText.trim()) || DIRECTIVE_HINT_RE.test(commentText)) {
          append(source.slice(index, end + entry.close.length));
        } else {
          removed += end + entry.close.length - index;
          // Keep newlines so diagnostics that quote line numbers stay aligned.
          const newlines = commentText.match(/\n/g);
          if (newlines) append('\n'.repeat(newlines.length));
        }
        index = end + entry.close.length;
        matched = true;
        break;
      }
      if (matched) continue;

      // Regex literal detection for C-family languages (avoid eating `//` in /re/).
      if (spec.regex && char === '/' && looksLikeRegexStart(out) && hasRegexTerminator(source, index)) {
        regexMode = true;
        regexClass = false;
        append(char);
        index += 1;
        continue;
      }

      append(char);
      if (char === '\n') atLineStart = true;
      else if (!/\s/.test(char)) atLineStart = false;
      index += 1;
    }
    return { text: out, removed };
  }

  /** A regex literal cannot span a line, so require a terminator on the same line. */
  function hasRegexTerminator(source, start) {
    let index = start + 1;
    let inClass = false;
    while (index < source.length) {
      const char = source[index];
      if (char === '\n') return false;
      if (char === '\\') { index += 2; continue; }
      if (char === '[') inClass = true;
      else if (char === ']') inClass = false;
      else if (char === '/' && !inClass) return true;
      index += 1;
    }
    return false;
  }

  function looksLikeRegexStart(output) {
    const tail = output.replace(/[ \t]+$/, '');
    if (!tail) return false;
    const last = tail[tail.length - 1];
    if ('(,=:[!&|?{};+-*%^~<>'.includes(last)) return true;
    return /(?:^|[\s;(,])(?:return|typeof|instanceof|in|of|case|delete|void|do|else|yield|await)$/.test(tail);
  }

  /* ---------------------------------------------------------------------- *
   * Technique: whitespace normalisation
   * ---------------------------------------------------------------------- */

  function normalizeWhitespace(text, options = {}) {
    const original = text;
    let next = String(text).replace(/\r\n?/g, '\n');
    const lines = next.split('\n');
    const keepBlankLines = options.keepBlankLines !== false;
    const out = [];
    let blankRun = 0;
    for (const line of lines) {
      if (!line.trim()) {
        blankRun += 1;
        const allowed = keepBlankLines ? 1 : 0;
        if (blankRun <= allowed) out.push('');
        continue;
      }
      blankRun = 0;
      out.push(/^\s/.test(line) ? line.replace(/[ \t]+$/, '') : collapseSpacesInProse(line));
    }
    next = out.join('\n').replace(/\n{3,}/g, '\n\n');
    return { text: next, changed: next !== original, removed: original.length - next.length };
  }

  /* ---------------------------------------------------------------------- *
   * Technique: prose tightening
   * ---------------------------------------------------------------------- */

  const PHRASE_RULES = [
    [/\bIn order to\b/gi, 'To'],
    [/\bin order to\b/g, 'to'],
    [/\bIt is important to note that\b/gi, 'Note:'],
    [/\bPlease note that\b/gi, 'Note:'],
    [/\bit should be noted that\b/gi, 'note'],
    [/\bmake sure (?:that )?you\b/gi, 'ensure you'],
    [/\bmake sure (?:that )?\b/gi, 'ensure '],
    [/\bas well as\b/g, 'and'],
    [/\bdue to the fact that\b/gi, 'because'],
    [/\bat this point in time\b/gi, 'now'],
    [/\bin the event that\b/gi, 'if'],
    [/\bfor the purpose of\b/gi, 'for'],
    [/\bwith regard to\b/gi, 'about'],
    [/\bwith respect to\b/gi, 'about'],
    [/\ba (?:large )?number of\b/gi, 'many'],
    [/\bis able to\b/gi, 'can'],
    [/\bare able to\b/gi, 'can'],
    [/\bhas the ability to\b/gi, 'can'],
    [/\bin addition(?:,| )/gi, 'also '],
    [/\bhowever, /gi, 'but '],
    [/\btherefore, /gi, 'so '],
    [/\bfurthermore, /gi, 'also '],
    [/\bmoreover, /gi, 'also '],
    [/\bI (?:will|'ll) (?:now )?/g, ''],
    [/\bAs an AI(?: language model)?,?\s*/gi, ''],
    [/\bLet(?:'s| us) take a look at\b/gi, 'Looking at'],
    [/\bHere(?:'s| is) (?:what|how)\b/gi, 'How'],
    [/\bIn this (?:section|response),? (?:I(?:'ll| will) )?/gi, ''],
    [/\bSure(?: thing)?[,!.]\s*/gi, ''],
    [/\bCertainly[,.!]\s*/gi, ''],
    [/\bOf course[,.!]\s*/gi, ''],
    [/\bGreat question[,.!]\s*/gi, ''],
    [/\bFeel free to\b/gi, 'You can'],
    [/\bkeep in mind that\b/gi, 'note'],
    [/\bthe reason (?:is|being) that\b/gi, 'because'],
    [/\bvery\s+/g, ''],
    [/\bbasically\s+/g, ''],
    [/\bactually\s+/g, ''],
    [/\bsimply\s+/g, ''],
    [/\bjust\s+/g, '']
  ];

  function tightenProse(text, options = {}) {
    const original = text;
    let next = String(text);
    // Protect fenced code from phrase rewriting.
    const fences = [];
    next = next.replace(/```[\s\S]*?```/g, match => {
      fences.push(match);
      return `\u0000FENCE${fences.length - 1}\u0000`;
    });
    next = next.replace(/`[^`\n]+`/g, match => {
      fences.push(match);
      return `\u0000FENCE${fences.length - 1}\u0000`;
    });
    for (const [pattern, replacement] of PHRASE_RULES) next = next.replace(pattern, replacement);
    next = next
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/\s+([,.;:!?])/g, '$1')
      .replace(/(\*\*|__|\*|_)(\s*)([^*_]+?)\2\1/g, '$3') // drop markdown emphasis in context copies
      .replace(/^[-*]\s+(?=\S)/gm, '- ')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/[ \t]+$/gm, '');
    next = next.replace(/\u0000FENCE(\d+)\u0000/g, (_, position) => fences[Number(position)] || '');
    if (options.dedupeSentences !== false) {
      const seen = new Set();
      const lines = next.split('\n');
      const kept = [];
      for (const line of lines) {
        const key = line.trim().replace(/\s+/g, ' ').toLowerCase();
        if (key.length > 60 && seen.has(key)) continue;
        if (key.length > 60) seen.add(key);
        kept.push(line);
      }
      next = kept.join('\n');
    }
    return { text: next, changed: next !== original, removed: original.length - next.length };
  }

  /* ---------------------------------------------------------------------- *
   * Technique: code compaction
   * ---------------------------------------------------------------------- */

  function compactCode(code, lang, profile) {
    const original = String(code);
    let next = original;
    let commentsRemoved = 0;
    let blankRemoved = 0;
    const lineCountBefore = original.split('\n').length;

    if (profile.stripComments) {
      const result = stripComments(next, lang);
      next = result.text;
      commentsRemoved = result.removed;
    }
    if (profile.dropBlankLines) {
      const before = next.length - next.replace(/^\s*$/gm, '').length;
      next = next.replace(/[ \t]+$/gm, '').replace(/^\s*$\n/gm, '');
      blankRemoved = before;
    }
    if (profile.stripComments) {
      next = next.replace(/\n{2,}/g, '\n').replace(/\n+$/, '');
    }
    if (profile.summarizeCode && next.length > 5000) {
      const summarized = summarizeCode(next, lang);
      next = summarized.text;
    }
    const lineCountAfter = next.split('\n').length;
    return {
      text: next,
      changed: next !== original,
      removed: original.length - next.length,
      commentsRemoved,
      blankRemoved,
      linesElided: Math.max(0, lineCountBefore - lineCountAfter)
    };
  }

  const SIGNATURE_PATTERNS = [
    /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|enum|namespace|struct|impl|trait|func|def|fn|public|private|protected|static|final|abstract|\w+\s*[:(]|\/\/)/,
    /^\s*(?:import|export|require|from|use|using|#include|package|module)\b/,
    /^\s*(?:@\w+|#\[)/,
    /^\s*[A-Za-z_$][\w$]*\s*[:=]\s*(?:\(|async|function|=>)/,
    /^\s*(?:const|let|var|val|readonly|mut)\s/,
    /^\s*(?:if|for|while|switch|match|try|catch|return|throw|await)\b.*[{(]\s*$/,
    /^\s*\)\s*[:{]/,
    /^\s*\/\*\*?/
  ];

  const SIGNATURE_LANGS = new Set([
    'js', 'python', 'ruby', 'lua', 'php', 'batch', 'sql', 'c'
  ]);

  function summarizeCode(code, lang) {
    const language = normalizeLang(lang);
    // Markup, stylesheets and data files have no signature structure: eliding
    // "the rest" would delete the document rather than compress it.
    if (language && !SIGNATURE_LANGS.has(language)) return { text: code };
    const lines = String(code).split('\n');
    const keep = new Set();
    lines.forEach((line, index) => {
      if (index < 14) keep.add(index);
      if (line.length > 400) return;
      if (SIGNATURE_PATTERNS.some(pattern => pattern.test(line))) keep.add(index);
    });
    const out = [];
    let elided = 0;
    let previousKept = -2;
    lines.forEach((line, index) => {
      if (keep.has(index)) {
        if (elided > 0) {
          out.push(`  … ${elided} line${elided === 1 ? '' : 's'} elided by Forge compressor …`);
          elided = 0;
        }
        out.push(line);
        previousKept = index;
      } else {
        elided += 1;
      }
    });
    if (elided > 0) out.push(`  … ${elided} line${elided === 1 ? '' : 's'} elided by Forge compressor …`);
    void lang;
    void previousKept;
    return { text: out.join('\n') };
  }

  /* ---------------------------------------------------------------------- *
   * Technique: extractive summarisation of older turns
   * ---------------------------------------------------------------------- */

  const SIGNAL_RE = /(?:error|bug|fix|fail|wrong|must|should|need|require|decide|decision|because|instead|breaking|deprecat|migrat|security|leak|perf|important|note that|remember|next step|todo|api|token|limit|file|path|\/[\w.-]+\/|\.\w{1,4}\b|\b\d+(?:\.\d+)?(?:%|ms|s|kb|mb)?\b)/i;

  function splitSentences(text) {
    return String(text)
      .split(/(?<=[.!?:])\s+(?=[A-Z0-9"'`\-*])|\n{2,}/)
      .map(part => part.trim())
      .filter(Boolean);
  }

  function summarizeProse(text, ratio = 0.4) {
    const original = String(text);
    const budget = Math.max(80, Math.round(original.length * ratio));
    if (original.length <= 400) return { text: original, changed: false, removed: 0 };
    const blocks = original.split(/(```[\s\S]*?```)/);
    const kept = [];
    let used = 0;
    for (const block of blocks) {
      if (!block) continue;
      if (block.startsWith('```')) {
        // Old code blocks are the single biggest token sink; keep only the
        // first two lines as a reminder of what the block contained.
        const lines = block.split('\n');
        if (used > budget * 0.5) continue;
        const excerpt = `${lines.slice(0, 2).join('\n')}\n… code omitted from older context …\n\`\`\``;
        kept.push(excerpt);
        used += excerpt.length;
        continue;
      }
      const sentences = splitSentences(block);
      if (!sentences.length) continue;
      const scored = sentences.map((sentence, index) => {
        let score = SIGNAL_RE.test(sentence) ? 2 : 0;
        if (index === 0) score += 2.4;
        if (index === sentences.length - 1) score += 1.2;
        if (/\d/.test(sentence)) score += 0.4;
        if (sentence.length > 220) score -= 0.5;
        if (sentence.length < 24) score -= 0.3;
        return { sentence, index, score };
      });
      const chosen = [...scored].sort((a, b) => b.score - a.score || a.index - b.index);
      const picked = [];
      let localUsed = 0;
      const localBudget = Math.max(120, Math.round(block.length * ratio));
      for (const item of chosen) {
        if (localUsed + item.sentence.length > localBudget) continue;
        picked.push(item);
        localUsed += item.sentence.length;
      }
      picked.sort((a, b) => a.index - b.index);
      if (picked.length) {
        const excerpt = picked.map(item => item.sentence).join(' ');
        kept.push(excerpt);
        used += excerpt.length;
      }
    }
    let next = kept.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
    if (!next) next = original.slice(0, Math.min(original.length, budget));
    if (next.length >= original.length * 0.94) return { text: original, changed: false, removed: 0 };
    return { text: next, changed: true, removed: original.length - next.length };
  }

  /* ---------------------------------------------------------------------- *
   * File payload detection (agent tool results)
   * ---------------------------------------------------------------------- */

  const FILE_PAYLOAD_RE = /^(?:FILE:\s*)(.+?)\n([\s\S]*)$/;
  const TRUNCATION_RE = /\n… file truncated for context$/;
  const COMPRESSED_MARKER = '[forge:compressed]';

  function parseFilePayload(text) {
    const match = FILE_PAYLOAD_RE.exec(String(text));
    if (!match) return null;
    const path = match[1].trim();
    let body = match[2];
    let truncated = false;
    if (TRUNCATION_RE.test(body)) {
      truncated = true;
      body = body.replace(TRUNCATION_RE, '');
    }
    return { path, body, truncated };
  }

  function fingerprint(value) {
    let hash = 0x811c9dc5;
    const text = String(value);
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16);
  }

  function compressFilePayload(text, options = {}, seen = null) {
    const parsed = parseFilePayload(text);
    if (!parsed) return null;
    const profile = resolveProfile(options.profile);
    const lang = langFromPath(parsed.path);
    const hash = fingerprint(parsed.body);
    const key = `${parsed.path}#${hash}`;
    // `seen` only ever contains copies that are still present in the payload
    // being prepared: a provider request is stateless, so pointing at a copy
    // that was pruned from an earlier request would lose the file entirely.
    const previous = seen?.get(key);

    if (profile.suppressRepeats && previous && parsed.body.length >= (options.repeatThreshold || 320)) {
      return {
        text: `FILE: ${parsed.path}\n${COMPRESSED_MARKER} identical to the earlier read of this file in this request (${parsed.body.length.toLocaleString()} chars, ${estimateTokens(parsed.body).toLocaleString()} tokens not repeated). Use that copy.`,
        technique: 'repeat-suppression',
        detail: `re-used earlier read of ${parsed.path}`
      };
    }

    if (!profile.compactFiles) {
      if (seen) seen.set(key, { hash, body: parsed.body, tokens: estimateTokens(parsed.body) });
      return { text, technique: null, detail: '' };
    }

    const compacted = compactCode(parsed.body, lang, profile);
    const header = `FILE: ${parsed.path} ${COMPRESSED_MARKER}\n`;
    const trailer = parsed.truncated ? '\n… file truncated for context' : '';
    const candidate = `${header}${compacted.text}${trailer}`;
    if (seen) seen.set(key, { hash, body: parsed.body, tokens: estimateTokens(parsed.body) });
    if (!compacted.changed || estimateTokens(candidate) >= estimateTokens(text)) {
      return { text, technique: null, detail: '' };
    }
    return {
      text: candidate,
      technique: profile.summarizeCode && compacted.linesElided ? 'file-summary' : 'file-compaction',
      detail: `${parsed.path}: −${compacted.commentsRemoved.toLocaleString()} chars of comments, −${compacted.blankRemoved.toLocaleString()} chars of blank lines${compacted.linesElided ? `, ${compacted.linesElided} lines elided` : ''}`
    };
  }

  /* ---------------------------------------------------------------------- *
   * Message preparation
   * ---------------------------------------------------------------------- */

  function cloneMessages(messages) {
    return (messages || []).map(message => {
      const copy = { ...message };
      if (Array.isArray(message?.content)) {
        copy.content = message.content.map(part => ({ ...(part || {}) }));
      }
      return copy;
    });
  }

  /** Indices protected from rewriting: the system prompt and the newest turn. */
  function protectedIndices(messages, keepRecentTurns) {
    const protectedSet = new Set();
    let turnsSeen = 0;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      protectedSet.add(index);
      if (messages[index].role === 'user') {
        turnsSeen += 1;
        if (turnsSeen >= Math.max(1, keepRecentTurns) + 1) break;
      }
    }
    messages.forEach((message, index) => {
      if (message.role === 'system') protectedSet.add(index);
    });
    return protectedSet;
  }

  function makeStepStats() {
    return {
      trim: { chars: 0, tokens: 0, hits: 0 },
      prose: { chars: 0, tokens: 0, hits: 0 },
      code: { chars: 0, tokens: 0, hits: 0 },
      files: { chars: 0, tokens: 0, hits: 0 },
      repeats: { chars: 0, tokens: 0, hits: 0 },
      history: { chars: 0, tokens: 0, hits: 0 },
      pruning: { chars: 0, tokens: 0, hits: 0 },
      schema: { chars: 0, tokens: 0, hits: 0 },
      budget: { chars: 0, tokens: 0, hits: 0 }
    };
  }

  /**
   * Compress a message array.
   *
   * Returns `{ messages, report }`. `messages` is always a new array — the
   * caller's conversation is left untouched.
   */
  function compressMessages(messages, options = {}) {
    const config = { ...DEFAULT_OPTIONS, ...options };
    const profile = resolveProfileFor(config);
    if (options.keepRecentTurns === undefined && profile.keepTurns) config.keepRecentTurns = profile.keepTurns;
    const working = cloneMessages(messages);
    const stats = makeStepStats();
    const tokensBefore = estimateMessages(working, config);
    // Suppression index: the first *kept* copy of each file+content inside this
    // payload. Populated lazily as the loop walks the messages in order.
    const seen = new Map();
    const perMessage = [];
    const notes = [];

    if (profile.id === 'off') {
      return {
        messages: working,
        report: buildReport({ profile, tokensBefore, tokensAfter: tokensBefore, stats, notes, perMessage, messages: working })
      };
    }

    const protectedSet = protectedIndices(working, config.keepRecentTurns);

    working.forEach((message, index) => {
      if (typeof message.content !== 'string') return;
      const before = message.content;
      const beforeTokens = estimateTokens(before);
      const techniques = [];
      const isTool = message.role === 'tool';
      const isProtected = protectedSet.has(index);

      // Tool payloads are handled first, on the untouched text, so the
      // identity hash for repeat suppression is stable across turns. The live
      // turn keeps its user/assistant text byte-for-byte intact, but the file
      // payloads this very request produced are compressed: they are the
      // single largest token sink in agent mode.
      // Old tool payloads are reduced to a stub. This is the same idea as
      // context pruning in a CLI agent: the model can always re-read a file,
      // and stale bodies are usually the bulk of a long session.
      if (isTool && !isProtected && profile.pruneOldPayloads && before.length > 320) {
        const payload = parseFilePayload(before);
        const label = payload ? payload.path : 'tool output';
        const lines = before.split('\n').length;
        const body = payload ? payload.body : before;
        // A pruned body is *not* available to the model, so it must not become
        // a suppression target for a later identical payload.
        void body;
        const stub = payload
          ? `${label} ${COMPRESSED_MARKER} pruned from older context (${body.length.toLocaleString()} chars, ${lines} lines). Call read_file("${label}") to load it again.`
          : `tool output ${COMPRESSED_MARKER} pruned from older context (${body.length.toLocaleString()} chars, ${lines} lines). Re-run the tool if you need it.`;
        if (estimateTokens(stub) < estimateTokens(before)) {
          stats.pruning.chars += before.length - stub.length;
          stats.pruning.tokens += estimateTokens(before) - estimateTokens(stub);
          stats.pruning.hits += 1;
          techniques.push('payload-pruning');
          message.content = stub;
          perMessage.push({ index, role: message.role, tokensBefore: beforeTokens, tokensAfter: estimateTokens(stub), techniques, protected: false });
          return;
        }
      }

      if (isTool && profile.compactFiles && (!isProtected || config.compactCurrentTurnFiles)) {
        const payload = compressFilePayload(before, { ...config, profile }, seen);
        if (payload?.technique) {
          const saved = estimateTokens(before) - estimateTokens(payload.text);
          const bucket = payload.technique === 'repeat-suppression' ? stats.repeats : stats.files;
          bucket.chars += before.length - payload.text.length;
          bucket.tokens += saved;
          bucket.hits += 1;
          techniques.push(payload.technique);
          if (payload.detail) notes.push(payload.detail);
          message.content = payload.text;
          perMessage.push({ index, role: message.role, tokensBefore: beforeTokens, tokensAfter: estimateTokens(payload.text), techniques, protected: isProtected, live: isProtected });
          return;
        }
      }

      if (isProtected) {
        perMessage.push({ index, role: message.role, tokensBefore: beforeTokens, tokensAfter: beforeTokens, techniques, protected: true });
        return;
      }

      let text = before;

      // 1. Whitespace normalisation (always safe, never changes meaning).
      const trimmed = normalizeWhitespace(text, { keepBlankLines: profile.dropBlankLines ? false : true });
      if (trimmed.changed) {
        stats.trim.chars += trimmed.removed;
        stats.trim.hits += 1;
        techniques.push('whitespace');
        text = trimmed.text;
      }

      if (isTool) {
        // Non-file tool output (search results, directory listings) usually
        // wraps code in fences; compact those blocks the same way.
        const segmented = segment(text);
        const rebuilt = segmented.map(part => {
          if (part.type !== 'code') return part;
          const compacted = compactCode(part.text, part.lang, { ...profile, summarizeCode: false });
          if (compacted.changed) {
            stats.code.chars += compacted.removed;
            stats.code.tokens += estimateTokens(part.text) - estimateTokens(compacted.text);
            stats.code.hits += 1;
            if (!techniques.includes('code-compaction')) techniques.push('code-compaction');
          }
          return { ...part, text: compacted.text };
        });
        const next = rebuild(rebuilt);
        if (next !== text && next.trim()) text = next;
      } else {
        const segmented = segment(text);
        const rebuilt = segmented.map(part => {
          if (part.type !== 'code') return part;
          const compacted = compactCode(part.text, part.lang, { ...profile, summarizeCode: profile.summarizeCode && message.role === 'assistant' });
          if (compacted.changed) {
            stats.code.chars += compacted.removed;
            stats.code.tokens += estimateTokens(part.text) - estimateTokens(compacted.text);
            stats.code.hits += 1;
            if (!techniques.includes('code-compaction')) techniques.push('code-compaction');
          }
          return { ...part, text: compacted.text };
        });
        text = rebuild(rebuilt);

        if (message.role === 'assistant' && profile.tightenProse) {
          const tightened = tightenProse(text);
          if (tightened.changed) {
            stats.prose.chars += tightened.removed;
            stats.prose.tokens += estimateTokens(text) - estimateTokens(tightened.text);
            stats.prose.hits += 1;
            techniques.push('prose');
            text = tightened.text;
          }
          if (profile.summarizeHistory) {
            const summarized = summarizeProse(text, config.oldTurnRatio || 0.45);
            if (summarized.changed) {
              stats.history.chars += summarized.removed;
              stats.history.tokens += estimateTokens(text) - estimateTokens(summarized.text);
              stats.history.hits += 1;
              techniques.push('history');
              text = summarized.text;
            }
          }
        }
      }

      message.content = text;
      perMessage.push({ index, role: message.role, tokensBefore: beforeTokens, tokensAfter: estimateTokens(text), techniques, protected: false });
    });

    // Budget enforcement: only runs when the caller asks for a hard ceiling.
    if (config.targetTokens > 0) {
      const result = enforceBudget(working, config, profile, stats, notes);
      if (result.changed) techniquesNote(result);
    }

    const tokensAfter = estimateMessages(working, config);
    return {
      messages: working,
      report: buildReport({ profile, tokensBefore, tokensAfter, stats, notes, perMessage, messages: working })
    };
  }

  function techniquesNote() { /* placeholder kept for report symmetry */ }

  function enforceBudget(messages, config, profile, stats) {
    let total = estimateMessages(messages, config);
    let changed = false;
    const protectedSet = protectedIndices(messages, config.keepRecentTurns);
    const budget = config.targetTokens;

    // Pass 1: compress older assistant messages harder.
    for (let index = 0; index < messages.length && total > budget; index += 1) {
      if (protectedSet.has(index) || typeof messages[index].content !== 'string') continue;
      if (messages[index].role !== 'assistant') continue;
      const before = messages[index].content;
      const summarized = summarizeProse(before, 0.22);
      if (summarized.changed) {
        messages[index].content = summarized.text;
        stats.budget.chars += before.length - summarized.text.length;
        stats.budget.tokens += estimateTokens(before) - estimateTokens(summarized.text);
        stats.budget.hits += 1;
        total = estimateMessages(messages, config);
        changed = true;
      }
    }

    // Pass 2: stub out old tool payloads.
    const droppedPaths = [];
    for (let index = 0; index < messages.length && total > budget; index += 1) {
      if (protectedSet.has(index) || messages[index].role !== 'tool') continue;
      const content = messages[index].content;
      if (typeof content !== 'string' || content.length < 400) continue;
      const parsed = parseFilePayload(content);
      const label = parsed ? parsed.path : 'tool output';
      const replacement = `${label} · ${COMPRESSED_MARKER} body omitted to stay inside the context budget (${content.length.toLocaleString()} chars). Re-read the file with read_file if you need it again.`;
      messages[index].content = replacement;
      stats.budget.chars += content.length - replacement.length;
      stats.budget.tokens += estimateTokens(content) - estimateTokens(replacement);
      stats.budget.hits += 1;
      droppedPaths.push(label);
      total = estimateMessages(messages, config);
      changed = true;
    }

    // Pass 3: drop the oldest turns entirely, leaving an explicit marker.
    while (total > budget && messages.length > 6) {
      let dropIndex = -1;
      for (let index = 0; index < messages.length; index += 1) {
        if (protectedSet.has(index)) continue;
        if (!['user', 'assistant', 'tool'].includes(messages[index].role)) continue;
        dropIndex = index;
        break;
      }
      if (dropIndex === -1) break;
      const removed = messages.splice(dropIndex, 1)[0];
      stats.budget.chars += messageContent(removed).length;
      stats.budget.tokens += estimateTokens(messageContent(removed));
      stats.budget.hits += 1;
      total = estimateMessages(messages, config);
      changed = true;
    }
    if (changed && profile.id !== 'off') {
      const marker = { role: 'system', content: `[forge] Earlier context was compacted to fit the model context window (profile: ${profile.label}).${droppedPaths.length ? ` Tool payloads omitted: ${droppedPaths.slice(0, 8).join(', ')}${droppedPaths.length > 8 ? '…' : ''}.` : ''} Ask for a file again if you need its full contents.` };
      messages.splice(1, 0, marker);
    }
    return { changed };
  }

  function buildReport({ profile, tokensBefore, tokensAfter, stats, notes, perMessage, messages }) {
    const savedTokens = Math.max(0, tokensBefore - tokensAfter);
    const techniques = [
      { id: 'whitespace', label: 'Whitespace + blank lines', lossy: false, ...stats.trim },
      { id: 'prose', label: 'Prose tightening', lossy: true, ...stats.prose },
      { id: 'code-compaction', label: 'Code comment trimming', lossy: true, ...stats.code },
      { id: 'file-compaction', label: 'Workspace file compaction', lossy: true, ...stats.files },
      { id: 'repeat-suppression', label: 'Repeated read suppression', lossy: false, ...stats.repeats },
      { id: 'history', label: 'Older turn summarisation', lossy: true, ...stats.history },
      { id: 'payload-pruning', label: 'Stale file payload pruning', lossy: true, ...stats.pruning },
      { id: 'tool-schema', label: 'Tool schema slimming', lossy: true, ...stats.schema },
      { id: 'budget', label: 'Context budget enforcement', lossy: true, ...stats.budget }
    ].filter(item => item.hits > 0);
    const uniqueNotes = [...new Set(notes)].slice(0, 12);
    return {
      profile: profile.id,
      profileLabel: profile.label,
      lossy: profile.lossy,
      tokensBefore,
      tokensAfter,
      savedTokens,
      savedPct: tokensBefore ? Math.round((savedTokens / tokensBefore) * 1000) / 10 : 0,
      charsBefore: messages.reduce((sum, message) => sum + messageContent(message).length, 0),
      techniques,
      notes: uniqueNotes,
      messages: perMessage,
      generatedAt: Date.now()
    };
  }

  /* ---------------------------------------------------------------------- *
   * Tool schema slimming
   * ---------------------------------------------------------------------- */

  /**
   * Tool definitions are re-sent on every round of an agent run, so their
   * prose is pure recurring cost. Names, types and `required` lists are left
   * untouched; only descriptions are trimmed to their first useful clause.
   */
  function compactToolDefinitions(tools, options = {}) {
    if (!Array.isArray(tools) || !tools.length) return { tools, report: null };
    const maxChars = options.maxDescriptionChars || 140;
    let before = 0;
    let after = 0;
    const trimmed = tools.map(tool => {
      const copy = JSON.parse(JSON.stringify(tool));
      const fn = copy.function;
      if (!fn) return copy;
      before += JSON.stringify(tool).length;
      if (typeof fn.description === 'string') fn.description = shortenDescription(fn.description, maxChars);
      const properties = fn.parameters?.properties;
      if (properties && typeof properties === 'object') {
        for (const key of Object.keys(properties)) {
          const property = properties[key];
          if (property && typeof property.description === 'string') {
            property.description = shortenDescription(property.description, maxChars);
          }
        }
      }
      after += JSON.stringify(copy).length;
      return copy;
    });
    const tokensSaved = Math.max(0, Math.ceil((before - after) / 3.85));
    return {
      tools: trimmed,
      report: {
        id: 'tool-schema',
        label: 'Tool schema slimming',
        lossy: true,
        chars: Math.max(0, before - after),
        tokens: tokensSaved,
        hits: tokensSaved > 0 ? 1 : 0,
        detail: `tool descriptions trimmed (${tools.length} tool${tools.length === 1 ? '' : 's'})`
      }
    };
  }

  function shortenDescription(text, maxChars) {
    const cleaned = String(text).replace(/\s+/g, ' ').trim();
    if (cleaned.length <= maxChars) return cleaned;
    const window = cleaned.slice(0, maxChars);
    // Prefer cutting at a sentence or clause boundary, keeping the first
    // sentence (which carries the actual instruction) intact whenever possible.
    const sentenceEnd = window.search(/[.!?]\s/);
    if (sentenceEnd > 40) return window.slice(0, sentenceEnd + 1);
    const clauseEnd = Math.max(window.lastIndexOf('; '), window.lastIndexOf(', '), window.lastIndexOf(' — '));
    if (clauseEnd > 60) return window.slice(0, clauseEnd).replace(/[,;]$/, '') + '.';
    return window.replace(/\s+\S*$/, '') + '…';
  }

  /* ---------------------------------------------------------------------- *
   * Single-string helper (used for tool payloads and skill injection)
   * ---------------------------------------------------------------------- */

  function compressText(text, options = {}) {
    const config = { ...DEFAULT_OPTIONS, ...options };
    const profile = resolveProfileFor(config);
    const original = String(text ?? '');
    if (profile.id === 'off' || !original) {
      return { text: original, report: buildReport({ profile, tokensBefore: estimateTokens(original), tokensAfter: estimateTokens(original), stats: makeStepStats(), notes: [], perMessage: [], messages: [] }) };
    }
    const before = estimateTokens(original);
    const trimmed = normalizeWhitespace(original, { keepBlankLines: false });
    let next = trimmed.text;
    const segmented = segment(next).map(part => {
      if (part.type !== 'code') return part;
      const compacted = compactCode(part.text, part.lang, profile);
      return { ...part, text: compacted.text };
    });
    next = rebuild(segmented);
    if (profile.tightenProse) next = tightenProse(next).text;
    const after = estimateTokens(next);
    return {
      text: next,
      report: buildReport({ profile, tokensBefore: before, tokensAfter: after, stats: makeStepStats(), notes: [], perMessage: [], messages: [] })
    };
  }

  /* ---------------------------------------------------------------------- *
   * Request-level entry point
   * ---------------------------------------------------------------------- */

  /**
   * Prepare one outbound request: compress messages and, when the run has
   * tools, slim the tool definitions too. Returns the payload pieces plus a
   * single merged report for the UI.
   */
  function prepareRequest({ messages, tools, options = {} } = {}) {
    const config = { ...DEFAULT_OPTIONS, ...options };
    const profile = resolveProfileFor(config);
    const result = compressMessages(messages, config);
    let nextTools = tools;
    let schemaEntry = null;
    if (tools?.length && profile.compactToolSchemas) {
      const slimmed = compactToolDefinitions(tools, config);
      nextTools = slimmed.tools;
      schemaEntry = slimmed.report;
    }
    const report = { ...result.report };
    if (schemaEntry?.hits) {
      report.techniques = [...report.techniques, schemaEntry];
      report.tokensBefore += schemaEntry.tokens;
      report.tokensAfter += 0;
      report.savedTokens = report.tokensBefore - report.tokensAfter;
      report.savedPct = report.tokensBefore ? Math.round((report.savedTokens / report.tokensBefore) * 1000) / 10 : 0;
    }
    return { messages: result.messages, tools: nextTools, report };
  }

  /* ---------------------------------------------------------------------- *
   * Built-in benchmark sample
   * ---------------------------------------------------------------------- */

  const SAMPLE_FILES = {
    'src/api/client.js': [
      '// src/api/client.js',
      '// Thin wrapper around fetch with retry + auth handling.',
      '// Keep this file dependency-free: it is imported by the service worker.',
      '',
      'import { logger } from "../util/logger.js";',
      '',
      '/**',
      ' * Default retry policy for idempotent requests.',
      ' * @type {{attempts: number, backoffMs: number}}',
      ' */',
      'const RETRY = {',
      '  attempts: 3, // three total tries, including the first one',
      '  backoffMs: 250, // doubled on every retry',
      '};',
      '',
      '// Requests that are safe to replay when the network hiccups.',
      'const IDEMPOTENT = new Set(["GET", "HEAD", "OPTIONS"]);',
      '',
      'export async function request(url, options = {}) {',
      '  // Build the headers once so retries reuse them',
      '  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };',
      '  let attempt = 0;',
      '  let wait = RETRY.backoffMs;',
      '  // Loop until we succeed or run out of attempts',
      '  while (attempt < RETRY.attempts) {',
      '    attempt += 1;',
      '    try {',
      '      // NOTE: do not add credentials here; the gateway rejects wildcard origins',
      '      const response = await fetch(url, { ...options, headers });',
      '      if (!response.ok && response.status >= 500 && IDEMPOTENT.has(options.method || "GET")) {',
      '        throw new Error(`upstream ${response.status}`);',
      '      }',
      '      return response;',
      '    } catch (error) {',
      '      logger.warn("request failed", { url, attempt, error });',
      '      if (attempt >= RETRY.attempts) throw error;',
      '      // Exponential backoff with a small jitter so retries do not synchronise',
      '      await new Promise(resolve => setTimeout(resolve, wait + Math.random() * 50));',
      '      wait *= 2;',
      '    }',
      '  }',
      '  throw new Error("unreachable");',
      '}'
    ].join('\n'),
    'src/api/session.js': [
      '// src/api/session.js',
      '// Session bootstrap: exchanges a one-time code for a short-lived token.',
      '',
      'import { request } from "./client.js";',
      '',
      'const TOKEN_TTL_MS = 15 * 60 * 1000; // fifteen minutes, mirrors the gateway',
      '',
      '// The refresh timer is module scoped on purpose; there must only ever be one.',
      'let timer = null;',
      'let current = null;',
      '',
      'export async function bootstrap(code) {',
      '  // Exchange the code; the gateway rotates it on every use',
      '  const response = await request("/session", {',
      '    method: "POST",',
      '    body: JSON.stringify({ code }),',
      '  });',
      '  const payload = await response.json();',
      '  // Refresh slightly early so an in-flight request never sees an expired token',
      '  scheduleRefresh(payload.expiresAt ?? Date.now() + TOKEN_TTL_MS);',
      '  current = payload.token;',
      '  return current;',
      '}',
      '',
      'function scheduleRefresh(expiresAt) {',
      '  if (timer) clearTimeout(timer);',
      '  const delay = Math.max(5_000, expiresAt - Date.now() - 30_000);',
      '  timer = setTimeout(() => {',
      '    // TODO: surface a re-auth prompt instead of silently refreshing',
      '    current = null;',
      '  }, delay);',
      '}'
    ].join('\n'),
    'src/util/logger.js': [
      '// src/util/logger.js',
      'const LEVELS = ["debug", "info", "warn", "error"];',
      '',
      'export const logger = {',
      '  // Deliberately tiny: the playground has no console bridge.',
      '  debug: (...args) => LEVELS.includes("debug") && console.debug(...args),',
      '  info: (...args) => console.info(...args),',
      '  warn: (...args) => console.warn(...args),',
      '  error: (...args) => console.error(...args),',
      '};'
    ].join('\n')
  };

  const SAMPLE_QUESTIONS = [
    'Can you please take a careful look at the checkout flow and tell me whether anything looks broken?',
    'The discount code seems to do nothing when the cart already had a promotion. Why would that happen?',
    'I would like to understand the retry logic in the API client. What happens if a 503 arrives on a POST?',
    'Is there any chance the refresh timer leaks if the page navigates away mid-session?',
    'What would you change first if I wanted the smallest safe fix here, and why?',
    'Please summarise the risks and give me a short checklist I can follow before shipping.'
  ];

  const SAMPLE_FILE_CYCLE = ['src/api/client.js', 'src/api/session.js', 'src/util/logger.js'];

  const SAMPLE = buildSample(6);

  /**
   * Build a realistic, deliberately verbose conversation. It mirrors what a
   * long agent session looks like: chatty assistant prose, commented source
   * files, and the same files being read again in later turns.
   */
  function buildSample(turns = 6) {
    const messages = [
      {
        role: 'system',
        content: 'You are Forge, a thoughtful and practical coding assistant in a browser-based playground. Be clear, accurate, and concise. Use code examples when useful. You do not have access to a user\'s files unless they are explicitly shown in the conversation. Do not claim that you ran code, tests, or commands.'
      }
    ];
    for (let turn = 0; turn < turns; turn += 1) {
      messages.push({
        role: 'user',
        content: `${SAMPLE_QUESTIONS[turn % SAMPLE_QUESTIONS.length]} Please walk me through your reasoning step by step and include the relevant code so I can follow along.`
      });
      const path = SAMPLE_FILE_CYCLE[turn % SAMPLE_FILE_CYCLE.length];
      messages.push({
        role: 'assistant',
        content: [
          'Sure thing! Great question. In order to answer this properly, it is important to note that I first want to read the relevant files so that my explanation is accurate rather than speculative. Let me take a look at the API client and the session bootstrap now.',
          '',
          '```js',
          SAMPLE_FILES[path].split('\n').slice(0, 14).join('\n'),
          '```',
          '',
          `Basically, there are two things going on here that are worth separating. First, the retry policy in \`${path}\` is applied before the response body is parsed, so an upstream 503 that arrives with a JSON error envelope is retried instead of surfaced. Secondly, the session bootstrap schedules its refresh from the value returned by the gateway, which means that if the gateway omits \`expiresAt\`, the client falls back to its own fifteen minute default and the timer will fire after the token has already expired.`,
          '',
          'I will read both files in full before proposing anything, and I will keep the change as small as I reasonably can so that it stays easy to review.',
          'Furthermore, it should be noted that the logger is deliberately tiny and does not buffer, so nothing in the retry path will swallow an error message.'
        ].join('\n')
      });
      messages.push({
        role: 'tool',
        content: `FILE: ${path}\n${SAMPLE_FILES[path]}`
      });
    }
    return messages;
  }

  /**
   * A second, deliberately different sample: a multi-turn Agent session where
   * every turn reads a comment-heavy workspace file. This is what real agent
   * usage looks like, and it is where the saver pays off most.
   */
  function buildAgentSample(turns = 12, options = {}) {
    const body = (name) => [
      `// src/${name}.js`,
      '// Service module. The comment density here matches a typical hand-written',
      '// codebase: documentation blocks, inline notes and blank lines.',
      '',
      '/**',
      ` * Run the ${name} pipeline.`,
      ' * @param {object} input',
      ' * @returns {Promise<object>}',
      ' */',
      `export async function run${name.replace(/[^a-z0-9]/gi, '')}(input) {`,
      '  // Validate first: the upstream caller does not always supply a body.',
      '  if (!input || typeof input !== "object") {',
      '    // throwing here keeps the retry helper in charge of backoff',
      '    throw new TypeError("input must be an object");',
      '  }',
      '',
      '  // Normalise the payload so downstream modules see one shape.',
      '  const normalised = Object.fromEntries(',
      '    Object.entries(input).map(([key, value]) => [key.trim(), value]),',
      '  );',
      '',
      '  // The timeout is intentionally generous: the gateway batches writes.',
      '  const controller = new AbortController();',
      '  const timer = setTimeout(() => controller.abort(), 15_000);',
      '',
      '  try {',
      '    return await request("/' + name + '", { body: normalised, signal: controller.signal });',
      '  } finally {',
      '    // Always clear the timer, even when the request rejects.',
      '    clearTimeout(timer);',
      '  }',
      '}'
    ].join('\n');
    const files = ['checkout', 'ledger', 'mailer'].map(name => `src/${name}.js`);
    const messages = [{ role: 'system', content: 'You are Forge, a careful coding agent. Inspect files before proposing changes.' }];
    for (let turn = 0; turn < turns; turn += 1) {
      const path = files[turn % files.length];
      messages.push({ role: 'user', content: `Please read ${path} and explain how its timeout and validation logic behaves under load.` });
      messages.push({
        role: 'assistant',
        content: `Sure thing! In order to answer that properly I should read the file rather than guess. Let me take a look, and I will keep the explanation focused on the timeout handling and the validation branch.\n\n\`\`\`js\n${body(path.replace(/^src\//, '').replace(/\.js$/, '')).split('\n').slice(0, 12).join('\n')}\n\`\`\`\n\nI will now talk through what I found and point out anything that looks risky.`
      });
      messages.push({ role: 'tool', content: `FILE: ${path}\n${body(path.replace(/^src\//, '').replace(/\.js$/, ''))}` });
    }
    void options;
    return messages;
  }

  function benchmark(options = {}) {
    const profileId = options.profile || 'balanced';
    const sample = options.scenario === 'agent'
      ? buildAgentSample(options.turns || 12)
      : buildSample(options.turns || 6);
    return compressMessages(sample, {
      profile: profileId,
      keepRecentTurns: options.keepRecentTurns,
      compactCurrentTurnFiles: true,
      targetTokens: options.targetTokens || 0
    }).report;
  }

  /* ---------------------------------------------------------------------- *
   * Public API
   * ---------------------------------------------------------------------- */

  const api = {
    PROFILES,
    DEFAULT_OPTIONS,
    estimateTokens,
    estimateMessages,
    compressMessages,
    compressText,
    resolveProfile,
    resolveProfileFor,
    compressFilePayload,
    compactCode,
    stripComments,
    tightenProse,
    summarizeProse,
    normalizeWhitespace,
    segment,
    langFromPath,
    fingerprint,
    parseFilePayload,
    compactToolDefinitions,
    prepareRequest,
    benchmark,
    buildSample,
    buildAgentSample,
    SAMPLE,
    SAMPLE_FILES,
    COMPRESSED_MARKER
  };

  root.ForgeCompressor = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
