/**
 * Alternative AI providers.
 *
 * Puter stays the default and needs no key, but plenty of people already have
 * an OpenRouter / Groq / Gemini key, or an Ollama box on their own machine.
 * Every one of those speaks the OpenAI chat-completions dialect, so a single
 * adapter covers them all — plus any custom endpoint that does.
 *
 * Two browser realities shape this file:
 *
 *  1. CORS. Most provider APIs refuse browser requests. `puter.net.fetch`
 *     proxies through Puter and is not bound by CORS, so it is the fallback
 *     when a direct fetch fails. It is XHR-based, which means no incremental
 *     streaming — so on that path we ask for a single completion and hand the
 *     whole answer over at once.
 *  2. localhost. Puter's proxy runs on their servers and can never reach
 *     127.0.0.1 on the user's machine, so loopback endpoints always use a
 *     direct fetch.
 */
import { prettyError, safeJsonParse, readStorage, writeStorage } from './util.js';
import { KEYS } from './config.js';
import { ensurePuter } from './llm.js';

export const PROVIDERS = [
  {
    id: 'puter', label: 'Puter (default)', kind: 'puter', keyless: true,
    blurb: '400+ models, no key and no backend. Usage is metered against your own free Puter account.',
  },
  {
    id: 'ollama', label: 'Ollama (this machine)', kind: 'openai', keyless: true,
    baseUrl: 'http://localhost:11434/v1', loopback: true,
    blurb: 'Unlimited and private, on your own hardware. Start Ollama, then allow this origin:',
    hint: 'OLLAMA_ORIGINS=https://phgaming121.github.io ollama serve',
    docs: 'https://github.com/ollama/ollama/blob/main/docs/faq.md',
  },
  {
    id: 'lmstudio', label: 'LM Studio (this machine)', kind: 'openai', keyless: true,
    baseUrl: 'http://localhost:1234/v1', loopback: true,
    blurb: 'Enable the local server in LM Studio and allow CORS from any origin.',
  },
  {
    id: 'pollinations', label: 'Pollinations (no signup)', kind: 'openai', keyless: true,
    baseUrl: 'https://text.pollinations.ai/openai',
    blurb: 'Free text generation with no account and no key. Anonymous use is rate-limited to roughly one request per 15 seconds.',
    docs: 'https://github.com/pollinations/pollinations',
  },
  {
    id: 'openrouter', label: 'OpenRouter', kind: 'openai', keyRequired: true, keyPrefix: 'sk-or-',
    baseUrl: 'https://openrouter.ai/api/v1',
    blurb: 'One key for hundreds of models, including a rotating set of :free ones. No card needed for the free tier.',
    docs: 'https://openrouter.ai/settings/keys',
  },
  {
    id: 'groq', label: 'Groq', kind: 'openai', keyRequired: true, keyPrefix: 'gsk_',
    baseUrl: 'https://api.groq.com/openai/v1',
    blurb: 'Extremely fast inference with a permanent free tier (rate-limited). No card needed.',
    docs: 'https://console.groq.com/keys',
  },
  {
    id: 'gemini', label: 'Google Gemini', kind: 'openai', keyRequired: true, keyPrefix: 'AIza',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    blurb: 'Generous free tier with a 1M-token context. Note that Google may train on free-tier prompts.',
    docs: 'https://aistudio.google.com/app/apikey',
  },
  {
    id: 'mistral', label: 'Mistral', kind: 'openai', keyRequired: true,
    baseUrl: 'https://api.mistral.ai/v1',
    blurb: 'Free experiment tier covering the whole Mistral lineup (phone verification required).',
    docs: 'https://console.mistral.ai/api-keys',
  },
  {
    id: 'deepseek', label: 'DeepSeek', kind: 'openai', keyRequired: true, keyPrefix: 'sk-',
    baseUrl: 'https://api.deepseek.com/v1',
    blurb: 'Very cheap strong coding models; pay-as-you-go after a small signup grant.',
    docs: 'https://platform.deepseek.com/api_keys',
  },
  {
    id: 'nvidia', label: 'NVIDIA NIM', kind: 'openai', keyRequired: true, keyPrefix: 'nvapi-',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    blurb: 'Free developer keys with a per-minute rate limit and no daily cap.',
    docs: 'https://build.nvidia.com/',
  },
  {
    id: 'together', label: 'Together AI', kind: 'openai', keyRequired: true,
    baseUrl: 'https://api.together.xyz/v1',
    blurb: 'Large open-model catalogue with trial credits.',
    docs: 'https://api.together.ai/settings/api-keys',
  },
  {
    id: 'openai', label: 'OpenAI', kind: 'openai', keyRequired: true, keyPrefix: 'sk-',
    baseUrl: 'https://api.openai.com/v1',
    blurb: 'Paid, metered to your own OpenAI account.',
    docs: 'https://platform.openai.com/api-keys',
  },
  {
    id: 'custom', label: 'Custom endpoint', kind: 'openai', userBaseUrl: true, keyOptional: true,
    baseUrl: '',
    blurb: 'Any OpenAI-compatible URL: vLLM, llama.cpp server, LocalAI, text-generation-inference, a company gateway…',
  },
];

export const providerById = (id) => PROVIDERS.find((p) => p.id === id) || null;

/* ── per-provider configuration (keys stay in this browser) ── */

function allConfigs() {
  const raw = readStorage(KEYS.providers, {});
  return raw && typeof raw === 'object' ? raw : {};
}

export function providerConfig(id) {
  const def = providerById(id) || {};
  const cfg = allConfigs()[id] || {};
  return {
    id: def.id || id,
    label: def.label || id,
    kind: def.kind || 'openai',
    loopback: !!def.loopback,
    baseUrl: (cfg.baseUrl || def.baseUrl || '').replace(/\/+$/, ''),
    apiKey: cfg.apiKey || '',
    extraHeaders: cfg.extraHeaders || {},
    model: cfg.model || '',
    enabled: cfg.enabled !== false,
    def,
  };
}

export function saveProviderConfig(id, patch = {}) {
  const all = allConfigs();
  const prev = all[id] || {};
  all[id] = { ...prev, ...patch };
  if (all[id].apiKey === '') delete all[id].apiKey;
  writeStorage(KEYS.providers, all);
  return providerConfig(id);
}

export function clearProviderConfig(id) {
  const all = allConfigs();
  delete all[id];
  writeStorage(KEYS.providers, all);
}

/** Which provider a request should go to right now. */
export function activeProvider(settings) {
  const id = settings?.providerId || 'puter';
  if (id === 'puter') return null;           // null === the built-in Puter path
  return providerConfig(id);
}

export function isProviderReady(cfg) {
  if (!cfg || cfg.kind === 'puter') return true;
  if (!cfg.baseUrl) return false;
  if (cfg.def?.keyRequired && !cfg.apiKey) return false;
  return true;
}

/* ── transport ───────────────────────────────────────────── */

const LOOPBACK = /^(https?:\/\/)?(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)([:/]|$)/i;

export const isLoopbackUrl = (url) => LOOPBACK.test(String(url || ''));

/**
 * Fetch with a CORS escape hatch.
 * @returns {Promise<{res:Response, via:'direct'|'puter', streaming:boolean}>}
 */
/**
 * Strip `"stream": true` out of a JSON request body. The Puter proxy is
 * XHR-backed and buffers the whole response, so an SSE stream would come back
 * as unparseable text — asking for one completion instead is what actually works.
 */
function withoutStreaming(body) {
  if (typeof body !== 'string') return body;
  const parsed = safeJsonParse(body, null);
  if (!parsed || typeof parsed !== 'object' || !parsed.stream) return body;
  return JSON.stringify({ ...parsed, stream: false, stream_options: undefined });
}

export async function netFetch(url, init = {}) {
  const local = isLoopbackUrl(url);
  try {
    const res = await fetch(url, init);
    return { res, via: 'direct', streaming: true };
  } catch (e) {
    if (local) throw new Error(`${prettyError(e)} — is the local server running, and does it allow this origin? (Ollama: OLLAMA_ORIGINS, LM Studio: enable CORS)`);
    // most provider APIs reject browser origins; Puter proxies without CORS
    const puter = await ensurePuter().catch(() => null);
    if (!puter?.net?.fetch) throw e;
    const res = await puter.net.fetch(url, {
      method: init.method || 'GET',
      headers: init.headers || {},
      body: withoutStreaming(init.body ?? null),
    });
    return { res, via: 'puter', streaming: false };   // XHR-backed: no incremental stream
  }
}

function authHeaders(cfg) {
  const h = { 'Content-Type': 'application/json', ...cfg.extraHeaders };
  if (cfg.apiKey) h.Authorization = `Bearer ${cfg.apiKey}`;
  if (cfg.id === 'openrouter') {
    // OpenRouter attributes free-tier traffic with these two headers
    h['HTTP-Referer'] = globalThis.location?.origin || 'https://phgaming121.github.io';
    h['X-Title'] = 'Puter Playground';
  }
  return h;
}

export function joinUrl(base, path) {
  return `${String(base).replace(/\/+$/, '')}/${String(path).replace(/^\/+/, '')}`;
}

/* ── errors ──────────────────────────────────────────────── */

export function explainProviderError(err, cfg, status) {
  const raw = prettyError(err);
  const s = ` ${String(raw).toLowerCase()} `;
  if (status === 401 || status === 403 || /invalid.?api.?key|unauthoriz|authentication|permission/.test(s)) {
    return `${cfg.label} rejected the API key (${status || 'auth error'}). Check it is current and enabled for this endpoint — the key is stored only in this browser.`;
  }
  if (status === 404 || /not found|does not exist|unknown model|no such model/.test(s)) {
    return `${cfg.label} does not recognise that model or path (${status || 404}). Refresh the model list for this provider, or pick another model.`;
  }
  if (status === 429 || /rate.?limit|too many requests|quota|insufficient|credit|balance/.test(s)) {
    return `${cfg.label} rate-limited or out of credit (${status || 429}). Wait a moment, switch model, or top up that provider — this app never sees their billing.`;
  }
  if (status >= 500) return `${cfg.label} returned a server error (${status}). Try again in a moment.`;
  return raw;
}

/* ── OpenAI-compatible chat ──────────────────────────────── */

/**
 * One chat completion against any OpenAI-compatible endpoint. Returns the same
 * shape as llm.js `chat()` so the agent loop cannot tell the difference.
 */
export async function chatViaProvider(cfg, o) {
  const { ToolCallAccumulator } = await import('./llm.js');
  const {
    messages, tools, temperature, maxTokens, reasoningEffort,
    onText, onReasoning, onToolStart, onUsage, isCancelled,
  } = o;
  let model = o.model || cfg.model || '';
  if (!model) throw new Error(`${cfg.label} needs a model id — pick one in the model picker or the Connect tab.`);

  const wantStream = o.stream !== false;
  const body = { model, messages };
  if (typeof temperature === 'number' && Number.isFinite(temperature)) body.temperature = temperature;
  if (maxTokens && maxTokens > 0) body.max_tokens = maxTokens;
  if (reasoningEffort) body.reasoning_effort = reasoningEffort;
  if (tools?.length) { body.tools = tools; body.tool_choice = 'auto'; }

  const controller = new AbortController();
  const acc = new ToolCallAccumulator();
  let text = '';
  let reasoning = '';
  let usage = null;
  let finishReason = '';
  let emittedCalls = 0;
  const cancelled = () => !!isCancelled?.();

  // Ask for streaming only when the transport can actually deliver it.
  const { res, via, streaming } = await netFetch(joinUrl(cfg.baseUrl, 'chat/completions'), {
    method: 'POST',
    headers: authHeaders(cfg),
    body: JSON.stringify({ ...body, ...(wantStream ? { stream: true, stream_options: { include_usage: true } } : {}) }),
    signal: controller.signal,
  }).catch((e) => { throw new Error(explainProviderError(e, cfg, 0)); });

  if (!res.ok) {
    const detail = await res.text?.().catch(() => '');
    const parsed = safeJsonParse(detail, null);
    const msg = parsed?.error?.message || parsed?.message || detail || `HTTP ${res.status}`;
    throw new Error(explainProviderError(msg, cfg, res.status));
  }

  if (wantStream && streaming && res.body?.getReader) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      if (cancelled()) { try { controller.abort(); } catch { /* already gone */ } break; }
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        const chunk = safeJsonParse(payload, null);
        if (!chunk) continue;
        if (chunk.usage) { usage = chunk.usage; onUsage?.(usage); }
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta || {};
        const reason = delta.reasoning ?? delta.reasoning_content ?? choice.reasoning_content;
        if (reason) { reasoning += reason; onReasoning?.(reason, reasoning); }
        if (delta.content) { text += delta.content; onText?.(delta.content, text); }
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) acc.feedDelta(tc);
          const soFar = acc.finish();          // only calls whose name has arrived
          if (soFar.length && soFar.length !== emittedCalls) {
            emittedCalls = soFar.length;
            onToolStart?.(soFar);
          }
        }
        if (choice.finish_reason) finishReason = choice.finish_reason;
      }
    }
  } else {
    // Non-streaming (either requested, or the CORS proxy path which cannot stream)
    const raw = await res.text();
    const data = safeJsonParse(raw, null);
    if (!data) throw new Error(`${cfg.label} returned something that is not JSON: ${String(raw).slice(0, 200)}`);
    const choice = data.choices?.[0] || {};
    const msg = choice.message || {};
    text = contentOf(msg.content);
    reasoning = msg.reasoning ?? msg.reasoning_content ?? '';
    if (reasoning) onReasoning?.(reasoning, reasoning);
    if (text) onText?.(text, text);
    usage = data.usage || null;
    if (usage) onUsage?.(usage);
    finishReason = choice.finish_reason || '';
    for (const tc of (msg.tool_calls || [])) {
      acc.feed({
        type: 'tool_use',
        id: tc.id,
        name: tc.function?.name,
        input: safeJsonParse(tc.function?.arguments, {}),
      });
    }
  }

  if (!finishReason) finishReason = acc.pending ? 'tool_calls' : (cancelled() ? 'cancelled' : 'stop');
  return {
    text, reasoning, toolCalls: acc.finish(), usage, finishReason,
    cancelled: cancelled(), via, streamed: wantStream && streaming,
    model,
  };
}

/** Provider content can be a string or an array of parts. */
function contentOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((p) => (typeof p === 'string' ? p : p?.text || '')).join('');
  return '';
}

/* ── model catalogue ─────────────────────────────────────── */

export async function listProviderModels(cfg) {
  if (!cfg.baseUrl) throw new Error(`${cfg.label} has no endpoint URL yet.`);
  const { normalizeModel } = await import('./llm.js');
  const { res } = await netFetch(joinUrl(cfg.baseUrl, 'models'), { headers: authHeaders(cfg) });
  if (!res.ok) {
    const detail = await res.text?.().catch(() => '');
    throw new Error(explainProviderError(detail || `HTTP ${res.status}`, cfg, res.status));
  }
  const data = safeJsonParse(await res.text(), null);
  const rawList = Array.isArray(data) ? data : (data?.data || data?.models || []);
  return rawList.map(normalizeModel).filter(Boolean);
}

/** Cheap reachability check used by the Connect tab's "Test" button. */
export async function testProvider(cfg) {
  if (!cfg.baseUrl) return { ok: false, error: 'No endpoint URL' };
  try {
    const models = await listProviderModels(cfg);
    if (models.length) return { ok: true, models: models.length, sample: models.slice(0, 3).map((m) => m.id) };
    // some endpoints hide /models — fall back to a one-token completion
    const probe = await chatViaProvider(cfg, {
      model: cfg.model || 'gpt-4o-mini', stream: false,
      messages: [{ role: 'user', content: 'ping' }], maxTokens: 1,
    });
    return { ok: true, models: 0, note: `endpoint reachable (answered ${probe.via === 'puter' ? 'through the Puter proxy' : 'directly'})` };
  } catch (e) {
    return { ok: false, error: prettyError(e) };
  }
}
