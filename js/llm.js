/**
 * Thin, defensive wrapper around `puter.ai.chat`.
 *
 * Handles: streaming chunks (text / reasoning / tool_use / usage / error),
 * tool-call accumulation across chunk shapes, response normalisation, and
 * a graceful "Puter.js did not load" path.
 */
import { APP } from './config.js';
import { state } from './store.js';
import { prettyError, safeJsonParse, withTimeout } from './util.js';

let puterPromise = null;

/** Resolve once Puter.js is available on window (the CDN script tag loads it). */
export function ensurePuter() {
  if (window.puter?.ai?.chat) { state.puterReady = true; return Promise.resolve(window.puter); }
  if (!puterPromise) {
    puterPromise = new Promise((resolve, reject) => {
      const started = Date.now();
      const tick = () => {
        if (window.puter?.ai?.chat) {
          state.puterReady = true;
          resolve(window.puter);
          return;
        }
        if (Date.now() - started > APP.puterWaitMs) {
          reject(new Error('Puter.js failed to load. Check your connection or an ad-blocker (js.puter.com).'));
          return;
        }
        setTimeout(tick, 60);
      };
      tick();
    });
  }
  return puterPromise;
}

/* ── response shape helpers ─────────────────────────────── */

/** Pull plain text out of any content shape Puter may hand back. */
export function contentToText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (!part || typeof part !== 'object') return '';
        if (part.type === 'text' || typeof part.text === 'string') return part.text || '';
        if (part.type === 'output_text' && part.text) return part.text;
        return '';
      })
      .join('');
  }
  if (typeof content === 'object') {
    if (typeof content.text === 'string') return content.text;
    if (typeof content.content === 'string') return content.content;
  }
  return String(content);
}

/** Extract tool calls from a non-streaming message, whatever the provider shape. */
export function extractToolCalls(message) {
  const calls = [];
  if (!message) return calls;

  const push = (id, name, argsRaw) => {
    if (!name) return;
    calls.push({
      id: id || `call_${calls.length}_${Math.random().toString(36).slice(2, 8)}`,
      name,
      args: typeof argsRaw === 'string' ? (safeJsonParse(argsRaw, {}) ?? {}) : (argsRaw ?? {}),
    });
  };

  for (const tc of message.tool_calls || []) {
    const fn = tc.function || tc;
    push(tc.id || fn.id, fn.name || tc.name, fn.arguments ?? fn.args ?? tc.arguments);
  }

  const content = message.content;
  if (Array.isArray(content)) {
    for (const part of content) {
      if (part?.type === 'tool_use') push(part.id, part.name, part.input);
      else if (part?.type === 'tool_call') push(part.id, part.function?.name || part.name, part.function?.arguments || part.input);
    }
  }
  if (Array.isArray(message.toolCalls)) {
    for (const tc of message.toolCalls) push(tc.id, tc.name, tc.args ?? tc.arguments);
  }
  return calls;
}

/* ── streaming accumulator ──────────────────────────────── */
class ToolCallAccumulator {
  constructor() { this.map = new Map(); this.order = []; }
  touch(id) {
    if (!this.map.has(id)) { this.map.set(id, { id, name: '', argsText: '', args: null }); this.order.push(id); }
    return this.map.get(id);
  }
  feed(chunk) {
    if (!chunk || chunk.type !== 'tool_use') return;
    const id = chunk.id || chunk.tool_call_id || chunk.toolUseId || `idx_${this.order.length}`;
    const entry = this.touch(id);
    const name = chunk.name || chunk.function?.name || chunk.tool || chunk.toolName;
    if (name) entry.name = name;

    const raw = chunk.input ?? chunk.arguments ?? chunk.function?.arguments ?? chunk.args ?? chunk.partial_json ?? chunk.delta?.input;
    if (raw !== undefined && raw !== null) {
      if (typeof raw === 'string') entry.argsText += raw;
      else entry.args = raw; // already parsed by the SDK
    }
  }
  finish() {
    return this.order
      .map((id) => this.map.get(id))
      .filter((e) => e.name)
      .map((e) => ({
        id: e.id,
        name: e.name,
        args: e.args ?? (e.argsText ? (safeJsonParse(e.argsText, null) ?? { __raw: e.argsText }) : {}),
      }));
  }
  get pending() { return this.order.length > 0; }
}

/* ── main entry ─────────────────────────────────────────── */

/**
 * @param {object} o
 * @param {Array}  o.messages      Chat messages ({role, content, tool_calls?, tool_call_id?, name?})
 * @param {string} o.model
 * @param {Array}  [o.tools]       OpenAI-style tool definitions
 * @param {number} [o.temperature]
 * @param {number} [o.maxTokens]   0/undefined = model default
 * @param {string} [o.reasoningEffort]
 * @param {boolean}[o.stream]
 * @param {boolean}[o.normalize]
 * @param {Function}[o.onText]     (delta, fullText) => void
 * @param {Function}[o.onReasoning](delta, fullText) => void
 * @param {Function}[o.onToolStart](partialCalls) => void
 * @param {Function}[o.onUsage]    (usage) => void
 * @param {Function} [o.isCancelled]  polled between chunks; return true to stop the stream
 * @returns {Promise<{text:string, reasoning:string, toolCalls:Array, usage:object, finishReason:string}>}
 */
export async function chat(o) {
  const puter = await ensurePuter();
  const {
    messages, model, tools, temperature, maxTokens, reasoningEffort,
    stream = true, normalize = true,
    onText, onReasoning, onToolStart, onUsage, isCancelled,
  } = o;

  const options = { model, normalize };
  if (stream) options.stream = true;
  if (typeof temperature === 'number' && Number.isFinite(temperature)) options.temperature = temperature;
  if (maxTokens && maxTokens > 0) options.max_tokens = maxTokens;
  if (reasoningEffort) options.reasoning_effort = reasoningEffort;
  if (tools?.length) options.tools = tools;

  const acc = new ToolCallAccumulator();
  let text = '';
  let reasoning = '';
  let usage = null;
  let finishReason = '';
  const cancelled = () => !!isCancelled?.();

  if (!stream) {
    const res = await puter.ai.chat(messages, options);
    const msg = res?.message || res;
    text = contentToText(msg?.content ?? res);
    reasoning = msg?.reasoning || '';
    usage = res?.usage || msg?.usage || null;
    finishReason = res?.finish_reason || msg?.finish_reason || '';
    const calls = extractToolCalls(msg);
    calls.forEach((c) => acc.feed({ type: 'tool_use', id: c.id, name: c.name, input: c.args }));
    if (usage) onUsage?.(usage);
    return { text, reasoning, toolCalls: calls, usage, finishReason };
  }

  const iterable = await puter.ai.chat(messages, options);

  // Some builds resolve to a plain object instead of an async iterable.
  if (!iterable || typeof iterable[Symbol.asyncIterator] !== 'function') {
    const msg = iterable?.message || iterable;
    text = contentToText(msg?.content ?? iterable);
    reasoning = msg?.reasoning || '';
    usage = iterable?.usage || null;
    finishReason = iterable?.finish_reason || '';
    onText?.(text, text);
    if (usage) onUsage?.(usage);
    return { text, reasoning, toolCalls: extractToolCalls(msg), usage, finishReason };
  }

  for await (const part of iterable) {
    if (cancelled()) { try { iterable.return?.(); } catch { /* ignore */ } break; }
    if (!part) continue;
    const type = part.type || (part.text !== undefined ? 'text' : '');

    switch (type) {
      case 'text': {
        const delta = part.text ?? '';
        if (delta) { text += delta; onText?.(delta, text); }
        break;
      }
      case 'reasoning':
      case 'thinking': {
        const delta = part.reasoning ?? part.text ?? '';
        if (delta) { reasoning += delta; onReasoning?.(delta, reasoning); }
        break;
      }
      case 'tool_use': {
        acc.feed(part);
        onToolStart?.(acc.finish());
        break;
      }
      case 'usage': {
        usage = part.usage || usage;
        if (usage) onUsage?.(usage);
        break;
      }
      case 'error': {
        throw new Error(part.message || part.error?.message || 'Model returned a stream error');
      }
      case 'image': {
        // Vision/image-output models can emit images mid-stream; surfaced by the caller if needed.
        onText?.('', text);
        break;
      }
      case 'compaction': {
        // Inline compaction artifact — nothing to render, but keep for continuity.
        break;
      }
      default: {
        // Unknown chunk shapes: try to salvage text.
        if (typeof part === 'string') { text += part; onText?.(part, text); }
        else if (part.text) { text += part.text; onText?.(part.text, text); }
        else if (part.tool_calls) { for (const tc of part.tool_calls) acc.feed({ type: 'tool_use', ...tc }); onToolStart?.(acc.finish()); }
        break;
      }
    }
    if (part.finish_reason) finishReason = part.finish_reason;
  }

  if (!finishReason) finishReason = acc.pending ? 'tool_calls' : (cancelled() ? 'cancelled' : 'stop');
  return { text, reasoning, toolCalls: acc.finish(), usage, finishReason, cancelled: cancelled() };
}

/** One-shot non-streaming completion, returns text only. */
export async function complete(promptOrMessages, opts = {}) {
  const res = await chat({ ...opts, messages: Array.isArray(promptOrMessages) ? promptOrMessages : [{ role: 'user', content: promptOrMessages }], stream: false });
  return res.text;
}

/** Best-effort retry with exponential backoff for transient provider errors. */
export async function chatWithRetry(o, retries = 2) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      return await chat(o);
    } catch (e) {
      lastErr = e;
      const msg = prettyError(e).toLowerCase();
      const transient = /rate|429|timeout|temporar|overload|503|502|500|network|econn|reset/.test(msg);
      if (!transient || i === retries) break;
      await withTimeout(new Promise((r) => setTimeout(r, 700 * (i + 1) ** 2)), 8000, 'backoff');
    }
  }
  throw lastErr;
}

/** Live model catalogue from Puter (400+ models), with caching. */
export async function fetchLiveModels({ force = false, cacheTtl = 6 * 3600 * 1000 } = {}) {
  const puter = await ensurePuter();
  if (!force) {
    try {
      const at = Number(localStorage.getItem('pp.models.at.v1') || 0);
      const cached = JSON.parse(localStorage.getItem('pp.models.v1') || 'null');
      if (cached?.length && Date.now() - at < cacheTtl) return { models: cached, live: true, cached: true };
    } catch { /* ignore */ }
  }
  if (typeof puter.ai.listModels !== 'function') return { models: [], live: false };
  const raw = await puter.ai.listModels();
  const models = (Array.isArray(raw) ? raw : (raw?.models || [])).map(normalizeModel).filter(Boolean);
  if (models.length) {
    try {
      localStorage.setItem('pp.models.v1', JSON.stringify(models));
      localStorage.setItem('pp.models.at.v1', String(Date.now()));
    } catch { /* storage full — ignore */ }
  }
  return { models, live: true, cached: false };
}

function normalizeModel(m) {
  if (!m) return null;
  if (typeof m === 'string') return { id: m, provider: guessProvider(m), label: m, desc: '', tags: [] };
  const id = m.id || m.model || m.slug || m.key || m.name;
  if (!id) return null;
  const provider = (m.provider || m.owner || guessProvider(id) || 'other').toLowerCase();
  const tags = [];
  const flag = (...keys) => keys.some((k) => m[k] === true || m[k] === 'true');
  if (flag('supports_tools', 'tools', 'tool_calling', 'function_calling', 'supportsTools')) tags.push('tools');
  if (flag('supports_vision', 'vision', 'multimodal', 'supportsVision') || Array.isArray(m.modalities) && m.modalities.includes('image')) tags.push('vision');
  if (flag('reasoning', 'supports_reasoning') || /reason|think|o[134]|r1/i.test(id)) tags.push('reasoning');
  if (flag('supports_image_generation') || /image|imagen|flux|dall/.test(id)) tags.push('image');
  const ctx = m.context_length || m.context_window || m.contextLength || m.max_context || null;
  const out = m.max_output_tokens || m.max_tokens || m.maxOutputTokens || null;
  return {
    id: String(id),
    provider,
    label: m.label || m.display_name || m.displayName || String(id),
    desc: m.description || m.desc || '',
    tags: [...new Set(tags)],
    ctx: Number(ctx) || null,
    out: Number(out) || null,
    cost: m.cost ?? m.price ?? null,
    free: m.free === true || m.is_free === true || undefined,
  };
}

export function guessProvider(id) {
  const s = String(id).toLowerCase();
  if (s.includes('/')) return s.split('/')[0].replace('@', '');
  if (/^(gpt|o1|o3|o4|chatgpt|davinci|text-davinci|codex)/.test(s)) return 'openai';
  if (/claude/.test(s)) return 'anthropic';
  if (/gemini|gemma|palm|bard/.test(s)) return 'google';
  if (/grok/.test(s)) return 'xai';
  if (/deepseek/.test(s)) return 'deepseek';
  if (/llama/.test(s)) return 'meta';
  if (/mistral|mixtral|magistral|devstral|codestral/.test(s)) return 'mistral';
  if (/qwen/.test(s)) return 'qwen';
  if (/flux|sdxl|stable-diffusion/.test(s)) return 'black-forest-labs';
  return 'other';
}

/** Turn a model id into a short, human label for the UI. */
export function shortModelName(id) {
  if (!id) return 'default';
  return String(id).split('/').pop();
}

export const puterUser = async () => {
  try {
    const puter = await ensurePuter();
    if (!puter.auth?.isSignedIn?.()) return null;
    return await puter.auth.getUser();
  } catch { return null; }
};

export { prettyError };
