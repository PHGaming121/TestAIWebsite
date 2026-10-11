/** Settings modal: every knob the playground exposes. */
import { el } from './util.js';
import { toast, openModal, confirmDialog } from './ui.js';
import { APP, KEYS } from './config.js';
import { state, updateSettings } from './store.js';
import { forgetTool, allowedTools } from './agent.js';
import { ensurePython, pythonStatus, killPython } from './exec.js';

/**
 * @param {object} ctx {models, onChanged, refreshModels, openModelPicker, puterUser, signOut}
 */
export function openSettings(ctx = {}) {
  const s = state.settings;

  const row = (title, hint, control) =>
    el('div.setting', {}, el('div.s-text', {}, el('b', { text: title }), hint ? el('small', { html: hint }) : null), el('div.s-ctl', {}, control));

  const toggle = (key, on = () => {}) => {
    const input = el('input', { type: 'checkbox' });
    input.checked = !!s[key];
    input.onchange = () => { updateSettings({ [key]: input.checked }); on(input.checked); };
    return el('label.toggle', {}, input, el('span'));
  };

  const number = (key, opts = {}) => {
    const input = el('input.num', { type: 'number', min: opts.min ?? 0, max: opts.max ?? 100000, step: opts.step ?? 1 });
    input.value = s[key] ?? opts.min ?? 0;
    input.onchange = () => {
      let v = Number(input.value);
      if (!Number.isFinite(v)) v = opts.min ?? 0;
      v = Math.max(opts.min ?? 0, Math.min(opts.max ?? 1e9, v));
      input.value = v;
      updateSettings({ [key]: v });
      opts.on?.(v);
    };
    return input;
  };

  const select = (key, options, on) => {
    const sel = el('select.inp', { style: { width: 'auto', minWidth: '150px' } });
    for (const [value, label] of options) sel.append(el('option', { value, text: label, selected: String(s[key] ?? '') === String(value) }));
    sel.onchange = () => { updateSettings({ [key]: sel.value }); on?.(sel.value); };
    return sel;
  };

  const slider = (key, { min = 0, max = 2, step = 0.1 } = {}) => {
    const range = el('input', { type: 'range', min, max, step });
    range.value = s[key] ?? min;
    const label = el('span.mono', { style: { fontSize: '12px', width: '34px', textAlign: 'right' }, text: String(range.value) });
    range.oninput = () => { label.textContent = range.value; updateSettings({ [key]: Number(range.value) }); };
    return el('div.row', {}, range, label);
  };

  /* ── model & generation ──────────────────────────────── */
  const modelGroup = el('div.setting-group', {},
    el('h4', { text: 'Model & generation' }),
    row('Chat model', 'Used in Chat mode.', el('button.btn.tiny', { text: s.model || 'choose…', onclick: () => ctx.openModelPicker?.('model') })),
    row('Agent model', 'Used in Agent mode. Strong tool-calling models (Claude, GPT-5.x, Gemini) work best.', el('button.btn.tiny', { text: s.agentModel || 'choose…', onclick: () => ctx.openModelPicker?.('agentModel') })),
    row('Temperature (chat)', 'Lower = more focused, higher = more creative.', slider('temperature')),
    row('Temperature (agent)', 'Agents want determinism — 0.1–0.3 is usually right.', slider('agentTemperature', { min: 0, max: 1.5, step: 0.05 })),
    row('Max output tokens', '0 lets each model use its own default.', number('maxTokens', { min: 0, max: 200000, step: 512 })),
    row('Reasoning effort', 'Only affects reasoning models.', select('reasoningEffort', [['', 'model default'], ['minimal', 'minimal'], ['low', 'low'], ['medium', 'medium'], ['high', 'high'], ['xhigh', 'xhigh']])),
    row('Stream responses', 'Show tokens as they arrive.', toggle('stream')),
    row('Normalise responses', 'Ask Puter for the OpenAI-style response shape from every provider — keeps tool calling consistent across models.', toggle('normalize')),
    row('Tool protocol', '"Auto" sends native tools and also understands the JSON fallback.', select('toolProtocol', [['auto', 'auto (recommended)'], ['native', 'native function calling'], ['text', 'JSON text protocol']])),
  );

  /* ── agent ───────────────────────────────────────────── */
  const allowList = [...allowedTools()];
  const agentGroup = el('div.setting-group', {},
    el('h4', { text: 'Agent' }),
    row('Max steps per turn', 'Each step is one model call. Complex builds need 15–40.', number('maxSteps', { min: 1, max: 200 })),
    row('Auto-approve tools', 'Let the agent write files, run code and push without asking. Off means every write/exec/publish step needs a click.', toggle('autoApprove')),
    row('Always-allowed tools', allowList.length ? allowList.join(', ') : 'none yet',
      el('button.btn.tiny', {
        text: 'reset', onclick: async () => {
          if (!await confirmDialog({ title: 'Forget remembered approvals?', message: 'You will be asked again before each write/execute/publish step.', danger: true, confirmLabel: 'Reset' })) return;
          allowList.forEach(forgetTool);
          toast('Approvals reset', { type: 'ok' });
        },
      })),
    row('Tool output limit', 'Characters of tool output fed back to the model.', number('maxToolOutputChars', { min: 1000, max: 60000, step: 1000 })),
    row('JavaScript timeout', 'Milliseconds before a sandboxed script is killed.', number('execTimeoutMs', { min: 1000, max: 300000, step: 1000 })),
  );

  /* ── workspace ───────────────────────────────────────── */
  const wsGroup = el('div.setting-group', {},
    el('h4', { text: 'Workspace' }),
    row('Backend', state.workspaceLabel || 'Chosen in the sidebar.', el('button.btn.tiny', { text: s.backend || 'auto', onclick: () => ctx.focusSidebar?.() })),
    row('Puter folder name', 'Where the Puter cloud workspace lives (~/<name>).', (() => {
      const i = el('input.inp.mono', { type: 'text', style: { width: '200px' }, value: s.puterDir });
      i.onchange = () => updateSettings({ puterDir: i.value.trim() || 'PlaygroundWorkspace' });
      return i;
    })()),
    row('Wipe the workspace', 'Deletes every file in the current backend.', el('button.btn.tiny.danger', { text: 'clear files', onclick: () => ctx.clearWorkspace?.() })),
  );

  /* ── python ──────────────────────────────────────────── */
  const pyStatus = pythonStatus();
  const pyGroup = el('div.setting-group', {},
    el('h4', { text: 'Python runtime (Pyodide)' }),
    row('Status', pyStatus.state === 'ready' ? `Pyodide ${pyStatus.version} loaded` : (pyStatus.status || 'not loaded — it downloads on first use'),
      el('button.btn.tiny', {
        text: pyStatus.state === 'ready' ? 'restart' : 'pre-load',
        onclick: async (e) => {
          e.target.disabled = true; e.target.textContent = 'loading…';
          if (pyStatus.state === 'ready') killPython();
          const ok = await ensurePython({ version: state.settings.pyodideVersion });
          toast(ok ? 'Python runtime ready' : 'Python runtime failed to load', { type: ok ? 'ok' : 'err' });
          e.target.disabled = false; e.target.textContent = 'done';
        },
      })),
    row('Pyodide version', 'Blank = use the latest published on jsDelivr. Pin one if a version misbehaves.', (() => {
      const i = el('input.inp.mono', { type: 'text', style: { width: '140px' }, placeholder: 'latest', value: s.pyodideVersion || '' });
      i.onchange = () => { updateSettings({ pyodideVersion: i.value.trim() }); killPython(); };
      return i;
    })()),
  );

  /* ── prompts ─────────────────────────────────────────── */
  const chatPrompt = el('textarea.inp', { rows: 4, placeholder: 'Default chat system prompt' });
  chatPrompt.value = s.systemPromptChat || '';
  chatPrompt.onchange = () => updateSettings({ systemPromptChat: chatPrompt.value });
  const agentPrompt = el('textarea.inp', { rows: 8, placeholder: 'Default agent system prompt (leave blank for the built-in engineer prompt)' });
  agentPrompt.value = s.systemPromptAgent || '';
  agentPrompt.onchange = () => updateSettings({ systemPromptAgent: agentPrompt.value });
  const promptGroup = el('div.setting-group', {},
    el('h4', { text: 'System prompts' }),
    el('label.lbl', { text: 'Chat mode override' }), chatPrompt,
    el('label.lbl', { text: 'Agent mode override', style: { marginTop: '10px' } }), agentPrompt,
    el('div.row', { style: { marginTop: '8px' } }, el('button.btn.tiny', {
      text: 'reset both to defaults', onclick: () => {
        chatPrompt.value = ''; agentPrompt.value = '';
        updateSettings({ systemPromptChat: '', systemPromptAgent: '' });
        toast('System prompts reset', { type: 'ok' });
      },
    })),
  );

  /* ── data & account ──────────────────────────────────── */
  const dataGroup = el('div.setting-group', {},
    el('h4', { text: 'Data, sync & account' }),
    row('Mirror history to Puter KV', 'Keeps your conversations available when you sign in on another device. Stored in your own Puter account.', toggle('syncPuterKv', (on) => { if (on) ctx.syncNow?.(); })),
    row('Puter account', ctx.puterUserLabel?.() || 'not signed in',
      el('button.btn.tiny', { text: ctx.isSignedIn?.() ? 'sign out' : 'sign in', onclick: () => ctx.toggleSignIn?.() })),
    row('Export everything', 'Conversations + settings as JSON.', el('button.btn.tiny', {
      text: 'export', onclick: () => ctx.exportAll?.(),
    })),
    row('Factory reset', 'Wipes conversations, settings, remembered approvals and the in-browser workspace.', el('button.btn.tiny.danger', {
      text: 'reset app', onclick: async () => {
        if (!await confirmDialog({ title: 'Reset the whole playground?', message: 'Conversations, settings and the in-browser workspace are deleted from this browser. GitHub tokens are removed too. Puter cloud files are untouched.', danger: true, confirmLabel: 'Erase everything' })) return;
        Object.values(KEYS).forEach((k) => { try { localStorage.removeItem(k); } catch { /* ignore */ } });
        try { sessionStorage.clear(); } catch { /* ignore */ }
        location.reload();
      },
    })),
  );

  /* ── about ───────────────────────────────────────────── */
  const about = el('div.setting-group', {},
    el('h4', { text: 'About' }),
    el('div.notice.info', {
      html: `<b>${APP.name} ${APP.version}</b> — a static web app, no backend, no API keys.<br><br>
      Models are served by <a href="https://puter.com" target="_blank" rel="noopener">Puter.js</a> under its
      <i>user-pays</i> model: the developer (this page) pays nothing, and each visitor uses their own free Puter
      allowance — which is why there are no hard-coded limits, quotas or paywalls here. Sign in to Puter for the
      largest allowance and for cloud storage.<br><br>
      Everything the agent writes lives in the workspace you choose (browser memory, browser disk, a real folder,
      or your Puter drive) and can be exported or pushed to GitHub at any time.`,
    }),
  );

  const body = el('div', {}, modelGroup, agentGroup, wsGroup, pyGroup, promptGroup, dataGroup, about);
  const m = openModal({ title: 'Settings', iconName: 'gear', body, wide: true, onClose: () => ctx.onChanged?.() });
  return m;
}
