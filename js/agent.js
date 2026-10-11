/**
 * The agent loop.
 *
 * Talks to any Puter model, requests tools (natively when the model supports
 * function calling, otherwise through a fenced-JSON text protocol), executes
 * them against the workspace, and feeds results back until the model calls
 * `finish`, the user hits Stop, or the step budget runs out.
 */
import { chat, contentToText } from './llm.js';
import { ALL_TOOLS, TOOL_MAP, nativeToolSchemas, toolsDoc, APPROVAL } from './tools.js';
import { runJavaScript, runPython } from './exec.js';
import { clientFromStorage } from './github.js';
import { estimateTokens, prettyError, safeJsonParse, truncate, readStorage, writeStorage, normPath } from './util.js';
import { KEYS } from './config.js';

export const TEXT_PROTOCOL_MARK = '```tool';

/* ── approval memory ────────────────────────────────────── */
export function allowedTools() { return new Set(readStorage(KEYS.allowTools, []) || []); }
export function rememberTool(name) { const s = allowedTools(); s.add(name); writeStorage(KEYS.allowTools, [...s]); }
export function forgetTool(name) { const s = allowedTools(); s.delete(name); writeStorage(KEYS.allowTools, [...s]); }

/* ── system prompts ─────────────────────────────────────── */
export function chatSystemPrompt(settings, ctx = {}) {
  const custom = (settings.systemPromptChat || '').trim();
  const base = custom || [
    'You are Playground, a brilliant, direct AI assistant inside a browser-based AI playground.',
    'Answer in clean GitHub-flavoured Markdown. Use fenced code blocks with a language tag.',
    'Be concrete and technical; skip filler such as "Certainly!" or "I hope this helps".',
    'If you lack the files, tools or current data a question needs, say so plainly instead of guessing.',
  ].join('\n');
  const extra = [];
  if (ctx.model) extra.push(`Active model: ${ctx.model}`);
  if (ctx.date) extra.push(`Today's date: ${ctx.date}`);
  if (ctx.workspaceTree) extra.push(`The user's workspace currently contains:\n${truncate(ctx.workspaceTree, 3000)}`);
  if (ctx.memory) extra.push(ctx.memory);
  return [base, extra.join('\n')].filter(Boolean).join('\n\n');
}

export function agentSystemPrompt(settings, ctx) {
  const custom = (settings.systemPromptAgent || '').trim();
  const gh = ctx.githubConnected
    ? `GitHub is CONNECTED as ${ctx.githubLogin || 'the user'}. Selected repo: ${ctx.githubRepo || '(none yet — create one if the task needs it)'}. You can create repos, push commits, open branches/PRs and enable GitHub Pages.`
    : 'GitHub is NOT connected. If the task needs GitHub, tell the user to paste a Personal Access Token in the GitHub tab (use ask_user if you need them to do it now). Never invent a token.';

  const parts = [
    custom ||
`You are Playground Agent, an autonomous senior software engineer running entirely inside the user's browser.
You have real tools: create/read/edit/delete files in a workspace, run shell commands, execute JavaScript in a
sandbox, execute Python through Pyodide, and publish projects to GitHub or a free Puter subdomain.`,

`## Environment
- Workspace backend: ${ctx.workspaceDescription || 'in-browser'}
- All paths are workspace-relative (e.g. "src/app.js"). There is no host filesystem beyond the workspace.
- ${gh}
- Everything executes client-side in the user's browser. The only hosting targets are GitHub Pages and Puter hosting.
- Today's date: ${ctx.date}.`,

`## How to work
1. Plan the smallest set of files that makes the project genuinely work. Prefer a few complete, high-quality files over many stubs.
2. Inspect the workspace first (list_files) unless you are starting from scratch.
3. WRITE COMPLETE FILES. Never emit "// rest of the code", placeholders, or diffs when calling write_file.
4. Verify: run the code (run_javascript / run_python / run_shell), read the errors, fix them, and only then report success.
5. For web projects produce a self-contained, responsive, good-looking result: semantic HTML, modern CSS, no build step, no external CDN dependencies unless asked, and RELATIVE asset paths so it works from a GitHub Pages sub-path.
6. Publishing to github.io: create the repo PUBLIC (free plans need public repos for Pages), push to "main", then call github_enable_pages, then report the live URL and note that the first build takes ~1 minute.
7. Keep going until the task is actually complete. Do not pause to ask permission unless something is genuinely ambiguous or destructive.
8. End by calling the finish tool with a concise summary: what you built, which files changed, how to run it, and any live URLs.`,

`## Tool protocol
${ctx.protocol === 'text' ? textProtocolDoc() : nativeProtocolDoc()}`,

`## Available tools
${toolsDoc(ctx.toolNames || null)}`,

`## Rules
- Never invent file contents you have not read, and never fabricate command output or URLs.
- If a tool errors, read the message, adjust, and retry once or twice before changing strategy.
- Batch independent tool calls in a single turn; keep dependent steps sequential.
- Keep prose short — let the tool calls do the work.`,
  ];

  if (ctx.workspaceTree) parts.push(`## Current workspace\n\`\`\`\n${truncate(ctx.workspaceTree, 6000)}\n\`\`\``);
  if (ctx.memory) parts.push(ctx.memory);
  if (ctx.skills) parts.push(ctx.skills);
  return parts.filter(Boolean).join('\n\n');
}

const nativeProtocolDoc = () =>
  "You have native function calling: request tools in your provider's native format and the playground executes them, returning each result as a tool message. Independent calls may be batched in one turn.";

const textProtocolDoc = () =>
`This session uses the JSON text protocol. To call tools, output a fenced block that begins with \`\`\`tool containing ONE JSON object, or an array of objects for parallel calls:
${TEXT_PROTOCOL_MARK}
{"name": "write_file", "args": {"path": "index.html", "content": "<!doctype html>…"}}
\`\`\`
Then STOP and wait: the playground executes the calls and replies with their results.
Use exact tool names, valid JSON, and args that match the schema. Never write tool results yourself.`;

/* ── message plumbing ───────────────────────────────────── */

/** Flatten stored conversation messages into provider messages. */
export function toProviderMessages(conv, { protocol, maxChars = 260000 } = {}) {
  const out = [];
  for (const m of conv.messages || []) {
    if (m.role === 'system') continue;

    if (m.role === 'user') {
      const content = typeof m.content === 'string' ? m.content : contentToText(m.content);
      const withImages = Array.isArray(m.attachments) && m.attachments.some((a) => a.dataUrl);
      if (withImages) {
        const parts = [{ type: 'text', text: content }];
        for (const a of m.attachments) if (a.dataUrl) parts.push({ type: 'image_url', image_url: { url: a.dataUrl } });
        out.push({ role: 'user', content: parts });
      } else {
        out.push({ role: 'user', content });
      }
      continue;
    }

    if (m.role === 'assistant') {
      const calls = (m.toolCalls || []).filter((c) => c.status !== 'pending');
      const text = contentToText(m.content);
      if (calls.length && protocol === 'native') {
        out.push({
          role: 'assistant',
          content: text || null,
          tool_calls: calls.map((c) => ({
            id: c.id,
            type: 'function',
            function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) },
          })),
        });
        for (const c of calls) out.push({ role: 'tool', tool_call_id: c.id, content: truncate(String(c.result ?? ''), 12000) });
      } else if (calls.length) {
        const block = calls.map((c) => ({ name: c.name, args: c.args ?? {} }));
        out.push({ role: 'assistant', content: `${text || ''}\n${TEXT_PROTOCOL_MARK}\n${JSON.stringify(block, null, 2)}\n\`\`\`` });
        out.push({ role: 'user', content: toolResultsMessage(calls) });
      } else if (text) {
        out.push({ role: 'assistant', content: text });
      }
      continue;
    }

    if (m.role === 'tool') out.push({ role: 'user', content: `[tool result]\n${truncate(String(m.content ?? ''), 8000)}` });
  }
  return compactHistory(out, maxChars);
}

export function toolResultsMessage(calls) {
  const body = calls.map((c) => {
    const status = c.status === 'error' ? 'ERROR' : c.status === 'denied' ? 'DENIED BY USER' : 'OK';
    return `### ${c.name} → ${status}\n${truncate(String(c.result ?? '(no output)'), 8000)}`;
  }).join('\n\n');
  return `Tool results:\n\n${body}\n\nContinue with the next step, or call finish when the task is complete.`;
}

/** Trim the oldest bulk when the transcript grows past the request budget. */
function compactHistory(messages, maxChars) {
  const size = (m) => (typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content || '').length);
  let total = messages.reduce((a, m) => a + size(m), 0);
  if (total <= maxChars) return messages;
  const out = messages.slice();
  for (let i = 1; i < out.length - 4 && total > maxChars; i++) {
    const m = out[i];
    if (typeof m.content !== 'string') continue;
    if ((m.role === 'tool' || m.role === 'user') && m.content.length > 600) {
      const keep = truncate(m.content, 300, '\n…[older context trimmed]');
      total -= m.content.length - keep.length;
      out[i] = { ...m, content: keep };
    }
  }
  return out;
}

/** Parse fenced tool blocks out of a text-protocol answer. */
export function parseToolBlocks(text) {
  const calls = [];
  let cleaned = String(text || '');
  const re = /```(?:tool|tool_call|toolcall|function)\s*\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(cleaned))) {
    const raw = m[1].trim();
    if (!/^[\[{]/.test(raw)) continue;
    const parsed = safeJsonParse(raw, null);
    if (!parsed) continue;
    const arr = Array.isArray(parsed) ? parsed : [parsed];
    const looksLikeTool = arr.every((c) => c && typeof c === 'object' && (c.name || c.tool));
    if (!looksLikeTool) continue;
    for (const c of arr) {
      calls.push({
        id: c.id || `txt_${calls.length}_${Math.random().toString(36).slice(2, 7)}`,
        name: c.name || c.tool,
        args: c.args ?? c.arguments ?? c.input ?? {},
        fromText: true,
      });
    }
    cleaned = cleaned.replace(m[0], '');
    re.lastIndex = 0;
  }
  return { calls, text: cleaned.trim() };
}

/**
 * After a mid-run downgrade to the text protocol, any native `tool_calls` /
 * `role: 'tool'` traffic already in the transcript has to be rewritten, or the
 * provider will reject a tools-less request that still contains tool messages.
 */
function downgradeToolMessages(messages) {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      const block = m.tool_calls.map((c) => ({ name: c.function?.name, args: safeJsonParse(c.function?.arguments ?? '{}', {}) }));
      messages[i] = { role: 'assistant', content: `${m.content || ''}\n${TEXT_PROTOCOL_MARK}\n${JSON.stringify(block, null, 2)}\n\`\`\`` };
    } else if (m.role === 'tool') {
      messages[i] = { role: 'user', content: toolResultsMessage([{ name: m.name || 'tool', status: 'ok', result: m.content }]) };
    }
  }
  return messages;
}

/* ── the loop ───────────────────────────────────────────── */

/**
 * @typedef {object} AgentUI
 * @property {(info:{step:number,model:string})=>object} beginAssistant creates the assistant message record
 * @property {(msg:object, delta:string, full:string)=>void} onText
 * @property {(msg:object, delta:string, full:string)=>void} onReasoning
 * @property {(msg:object, calls:Array)=>void} onPendingCalls
 * @property {(msg:object, info:{text:string,reasoning:string,calls:Array,usage:object})=>void} onFinal
 * @property {(msg:object, error:string)=>void} onError
 * @property {(info:{step:number,maxSteps:number,model:string})=>void} onStep
 * @property {(call:object)=>void} onToolStart
 * @property {(call:object)=>void} onToolEnd
 * @property {(level:string,text:string)=>void} onOutput
 * @property {(frac:number,label:string)=>void} onProgress
 * @property {()=>void} onWorkspaceChanged
 * @property {(question:string,options:string[])=>Promise<string>} [askUser]
 * @property {(media:{kind:string,path:string,url?:string,model?:string,prompt?:string,testMode?:boolean})=>void} [onMedia]
 * @property {(call:object)=>Promise<{allow:boolean,remember:boolean,reason?:string}>} [requestApproval]
 * @property {(fullName:string)=>void} [setRepo]
 */

/**
 * @param {object} o
 * @param {object} o.conv       conversation record
 * @param {object} o.settings
 * @param {object} o.ws         workspace
 * @param {AgentUI} o.ui
 * @param {{current:boolean}} o.cancelRef
 */
export async function runAgentTurn(o) {
  const { conv, settings, ws, ui, cancelRef } = o;
  const model = conv.model || (conv.mode === 'agent' ? settings.agentModel : settings.model) || settings.model;
  const isAgent = conv.mode === 'agent';
  const protocolSetting = isAgent ? (settings.toolProtocol || 'auto') : 'none';
  const useNative = protocolSetting === 'native' || protocolSetting === 'auto';

  let tree = '';
  try { tree = isAgent ? await ws.treeText({ maxEntries: 200 }) : ''; } catch { /* ignore */ }

  // long-term memory + skills are injected relative to what the user just asked
  const lastUserText = [...(conv.messages || [])].reverse().find((m) => m.role === 'user');
  const query = typeof lastUserText?.content === 'string' ? lastUserText.content : '';
  let memoryBlock = '';
  if (settings.memoryEnabled !== false) {
    try {
      const { memoryPromptBlock } = await import('./memory.js');
      memoryBlock = memoryPromptBlock(query, { budgetChars: settings.memoryBudgetChars || 1600 });
    } catch { /* memory is best-effort; never break a run over it */ }
  }
  let skillsBlock = '';
  try {
    const { skillsPromptBlock } = await import('./skills.js');
    skillsBlock = await skillsPromptBlock(ws, query);
  } catch { /* skills are optional */ }

  const creds = clientFromStorage();
  let workspaceDescription = `${ws.id} workspace`;
  try {
    const d = await ws.describe();
    workspaceDescription = `${d.backend} backend rooted at ${d.root}${d.note ? ` (${d.note})` : ''}`;
  } catch { /* ignore */ }

  const system = isAgent
    ? agentSystemPrompt(settings, {
      workspaceDescription,
      workspaceTree: tree,
      githubConnected: !!creds?.token,
      githubLogin: creds?.login,
      githubRepo: settings.githubRepo,
      date: new Date().toDateString(),
      protocol: useNative ? 'native' : 'text',
      memory: memoryBlock || undefined,
      skills: skillsBlock || undefined,
    })
    : chatSystemPrompt(settings, {
      model, date: new Date().toDateString(), workspaceTree: tree || undefined,
      memory: memoryBlock || undefined,
      skills: skillsBlock || undefined,
    });

  const messages = [
    { role: 'system', content: system },
    ...toProviderMessages(conv, { protocol: useNative ? 'native' : 'text' }),
  ];

  const runtimes = {
    javascript: async (args) => {
      const code = args[0] === '-e' ? args.slice(1).join(' ') : await ws.read(normPath(args[0] || '')).catch(() => '');
      if (!code) return { output: '', error: `no code to run (${args[0] || 'missing file'})`, exitCode: 1 };
      const res = await runJavaScript(code, ws, { timeoutMs: settings.execTimeoutMs });
      return { output: res.output, error: res.error, exitCode: res.exitCode };
    },
    python: async (args) => {
      const code = args[0] === '-c' ? args.slice(1).join(' ') : await ws.read(normPath(args[0] || '')).catch(() => '');
      if (!code) return { output: '', error: `no code to run (${args[0] || 'missing file'})`, exitCode: 1 };
      const res = await runPython(code, ws, { timeoutMs: 90000, version: settings.pyodideVersion });
      return { output: res.output, error: res.error, exitCode: res.exitCode };
    },
  };

  const toolCtx = {
    ws, settings, runtimes,
    github: creds?.token ? clientFromStorage() : null,
    askUser: ui.askUser,
    setRepo: ui.setRepo,
    // media tools hand their result straight to the transcript; the bytes never
    // go back to the model (a base64 image in context would burn credits for nothing)
    onMedia: (m) => ui.onMedia?.(m),
    onMemory: () => ui.onMemory?.(),
    onSkills: () => ui.onSkills?.(),
    convId: conv?.id || null,
    onOutput: (level, text) => ui.onOutput?.(level, text),
    onProgress: (frac, label) => ui.onProgress?.(frac, label),
    touch: () => ui.onWorkspaceChanged?.(),
    finishReason: null,
  };

  const allCalls = [];
  const maxSteps = isAgent ? Math.max(1, settings.maxSteps || 30) : 1;
  let steps = 0;
  let finalText = '';
  let stopped = false;
  let usageTotal = { prompt_tokens: 0, completion_tokens: 0 };
  // Native tools are offered when asked for, but a model that rejects them
  // downgrades this turn to the fenced-JSON text protocol instead of failing.
  let nativeActive = isAgent && useNative;

  while (steps < maxSteps) {
    if (cancelRef?.current) { stopped = true; break; }
    steps++;
    ui.onStep?.({ step: steps, maxSteps, model });

    const msg = ui.beginAssistant({ step: steps, model });

    let res;
    try {
      let attempt = 0;
      for (;;) {
        try {
          res = await chat({
            messages, model,
            tools: nativeActive ? nativeToolSchemas() : undefined,
            temperature: isAgent ? settings.agentTemperature : settings.temperature,
            maxTokens: settings.maxTokens,
            reasoningEffort: settings.reasoningEffort,
            stream: settings.stream !== false,
            normalize: settings.normalize !== false,
            onText: (delta, full) => ui.onText?.(msg, delta, full),
            onReasoning: (delta, full) => ui.onReasoning?.(msg, delta, full),
            onToolStart: (calls) => ui.onPendingCalls?.(msg, calls),
            onUsage: (usage) => {
              if (!usage) return;
              usageTotal = {
                prompt_tokens: (usageTotal.prompt_tokens || 0) + (usage.prompt_tokens || usage.input_tokens || 0),
                completion_tokens: (usageTotal.completion_tokens || 0) + (usage.completion_tokens || usage.output_tokens || 0),
              };
            },
            isCancelled: () => !!cancelRef?.current,
          });
          break;
        } catch (callErr) {
          const why = prettyError(callErr).toLowerCase();
          const toolRelated = /tool|function[_ ]call|unsupported|not support|invalid_request|invalid request|bad_request/.test(why);
          if (nativeActive && attempt === 0 && toolRelated) {
            attempt++;
            nativeActive = false;
            downgradeToolMessages(messages);
            ui.onOutput?.('warn', `This model rejected native tool calling (${truncate(prettyError(callErr), 160)}) — switching this run to the JSON text protocol.`);
            continue;
          }
          throw callErr;
        }
      }
    } catch (e) {
      ui.onError?.(msg, prettyError(e));
      stopped = true;
      break;
    }

    let text = res.text || '';
    let calls = res.toolCalls || [];

    // Accept fenced-JSON tool calls even when native tools were offered —
    // plenty of models answer in text and it would be a shame to ignore them.
    if (isAgent && text) {
      const parsed = parseToolBlocks(text);
      if (parsed.calls.length) {
        const seen = new Set(calls.map((c) => `${c.name}:${JSON.stringify(c.args)}`));
        calls = [...calls, ...parsed.calls.filter((c) => !seen.has(`${c.name}:${JSON.stringify(c.args)}`))];
        text = parsed.text;
      }
    }

    ui.onFinal?.(msg, { text, reasoning: res.reasoning, calls, usage: res.usage });
    if (text) finalText = text;
    if (res.cancelled) { stopped = true; break; }
    if (!isAgent || !calls.length) break;

    messages.push({
      role: 'assistant',
      content: text || null,
      ...(nativeActive ? {
        tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) } })),
      } : {}),
    });
    if (!nativeActive) messages[messages.length - 1].content = `${text || ''}\n${TEXT_PROTOCOL_MARK}\n${JSON.stringify(calls.map((c) => ({ name: c.name, args: c.args })), null, 2)}\n\`\`\``;

    const results = [];
    let finishCalled = false;

    for (const call of calls) {
      if (cancelRef?.current) { stopped = true; break; }
      allCalls.push(call);
      ui.onToolStart?.(call);

      const def = TOOL_MAP.get(call.name);
      if (!def) {
        const record = { ...call, status: 'error', result: `ERROR: unknown tool "${call.name}". Available tools: ${ALL_TOOLS.map((t) => t.name).join(', ')}` };
        results.push(record); ui.onToolEnd?.(record);
        continue;
      }

      const needsApproval = def.approval !== APPROVAL.READ && !settings.autoApprove && !allowedTools().has(def.name);
      if (needsApproval && ui.requestApproval) {
        const decision = await ui.requestApproval({ ...call, approval: def.approval });
        if (!decision?.allow) {
          const record = { ...call, status: 'denied', result: `DENIED by the user${decision?.reason ? `: ${decision.reason}` : ''}. Rethink this step or ask what they would prefer.` };
          results.push(record); ui.onToolEnd?.(record);
          continue;
        }
        if (decision.remember) rememberTool(def.name);
      }

      const started = performance.now();
      let out, status = 'ok';
      try {
        out = await def.run(toolCtx, call.args || {});
        if (typeof out !== 'string') out = JSON.stringify(out, null, 2);
      } catch (e) {
        status = 'error';
        out = `ERROR: ${prettyError(e)}`;
      }
      const record = { ...call, status, result: truncate(out ?? '', settings.maxToolOutputChars || 14000), ms: Math.round(performance.now() - started) };
      results.push(record);
      ui.onToolEnd?.(record);
      if (def.approval !== APPROVAL.READ) ui.onWorkspaceChanged?.();
      if (def.name === 'finish') { finishCalled = true; toolCtx.finishReason = record.result.replace(/^FINISHED:\s*/, ''); }
    }

    if (results.length) {
      if (nativeActive) for (const r of results) messages.push({ role: 'tool', tool_call_id: r.id, content: truncate(String(r.result ?? ''), 12000) });
      else messages.push({ role: 'user', content: toolResultsMessage(results) });
    }

    if (finishCalled) break;
    if (cancelRef?.current) { stopped = true; break; }
  }

  return {
    text: toolCtx.finishReason || finalText,
    steps,
    toolCalls: allCalls,
    stopped,
    usage: usageTotal,
    tokens: estimateTokens(messages.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n')),
  };
}
