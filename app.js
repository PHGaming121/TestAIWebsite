(() => {
  'use strict';

  const API_BASE = 'https://codecraftapi.com/v1';
  const GITHUB_API = 'https://api.github.com';
  const SETTINGS_KEY = 'forge.settings.v1';
  const DOCS_URL = 'https://codecraftapi.com/docs';
  const LOGIN_URL = 'https://codecraftapi.com/login';
  const DASHBOARD_URL = 'https://codecraftapi.com/dashboard';
  const COMPRESSOR = window.ForgeCompressor || null;
  const SKILLS = window.ForgeSkills || null;
  const FALLBACK_MODEL = 'claude-opus-4.8';
  const MAX_FILE_BYTES = 180_000;
  const MAX_WORKSPACE_FILES = 140;
  const MAX_WORKSPACE_CHARS = 720_000;
  const MAX_AGENT_ROUNDS = 8;
  const MAX_TOOL_CALLS = 18;
  const SKIP_DIRS = new Set(['.git', 'node_modules', 'vendor', 'dist', 'build', 'coverage', '.next', '.nuxt', '.output', 'target', '__pycache__', '.venv', 'venv']);
  const TEXT_EXTENSIONS = new Set([
    'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'vue', 'svelte', 'html', 'htm', 'css', 'scss', 'sass', 'less', 'json', 'jsonc', 'md', 'mdx', 'txt', 'text', 'xml', 'svg', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'py', 'pyi', 'go', 'rs', 'java', 'kt', 'kts', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'php', 'rb', 'swift', 'sh', 'bash', 'zsh', 'sql', 'graphql', 'gql', 'prisma', 'dockerfile', 'makefile', 'gradle', 'properties', 'env', 'example', 'lock', 'gitignore', 'gitattributes', 'editorconfig', 'prettierrc', 'eslintrc', 'babelrc', 'npmrc', 'nvmrc', 'nojekyll'
  ]);
  const CHAT_SYSTEM = 'You are Forge, a thoughtful and practical coding assistant in a browser-based playground. Be clear, accurate, and concise. Use code examples when useful. You do not have access to a user\'s files unless they are explicitly shown in the conversation. Do not claim that you ran code, tests, or commands.';
  const AGENT_SYSTEM = 'You are Forge, a careful coding agent. You can inspect files in the connected workspace using list_files, read_file, and search_files. Use those tools before making assumptions, and read a file before replacing it. Use write_file to propose a complete replacement for a file; the browser will ask the user to approve each write. Make the smallest useful change, preserve project conventions, and never claim you ran tests or commands because shell execution is not available in this browser workspace. Do not ask for API keys or GitHub tokens in chat. If no workspace is connected, explain that one must be connected before you can inspect or edit project files.';

  const TOOL_DEFINITIONS = [
    {
      type: 'function',
      function: {
        name: 'list_files',
        description: 'List paths in the connected project. Use this first to discover the project structure. Optionally filter paths by a substring.',
        parameters: {
          type: 'object',
          properties: {
            contains: { type: 'string', description: 'Optional case-insensitive substring to filter paths.' },
            limit: { type: 'integer', description: 'Maximum paths to return, up to 150.' }
          },
          required: []
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'read_file',
        description: 'Read one text file from the connected project. Use this to inspect relevant code before proposing changes.',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string', description: 'Project-relative file path.' } },
          required: ['path']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'search_files',
        description: 'Search text in the files loaded into the connected project. Returns matching file paths and line numbers.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Text to find, case-insensitive.' },
            limit: { type: 'integer', description: 'Maximum matching lines to return, up to 50.' }
          },
          required: ['query']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'write_file',
        description: 'Request a complete replacement or creation of one project text file. The browser will show the proposed content and require the user to approve before anything is saved. Read the current file first when it exists.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Project-relative file path to create or replace.' },
            content: { type: 'string', description: 'Complete new file content.' }
          },
          required: ['path', 'content']
        }
      }
    }
  ];

  const state = {
    apiKey: '',
    models: [],
    selectedModel: FALLBACK_MODEL,
    selectedModelData: null,
    mode: 'chat',
    sessions: [],
    currentSession: null,
    workspace: { kind: 'none', name: '', owner: '', repo: '', branch: 'main' },
    files: new Map(),
    fileHandles: new Map(),
    dirtyFiles: new Set(),
    baseBlobShas: new Map(),
    githubToken: '',
    abortController: null,
    sending: false,
    pendingApproval: null,
    rateLimitText: 'Provider limits and pricing apply',
    toastTimer: null,
    apiBase: API_BASE,
    // Token saver settings and measured totals. The compressor keeps its own
    // per-request index for duplicate reads: provider requests are stateless,
    // so a cross-request index would produce dangling pointers.
    saver: {
      profile: 'balanced',
      keepRecentTurns: 2,
      compactCurrentTurnFiles: true,
      pruneOldPayloads: true,
      compactToolSchemas: true,
      targetTokens: 0,
      totals: { runs: 0, tokensBefore: 0, tokensAfter: 0, saved: 0, lastReport: null, lastLabel: '' }
    },
    // Claude skill data discovered from the workspace or added by hand.
    skills: {
      registry: { skills: [], memory: [], commands: [], agents: [], warnings: [], total: 0, errorCount: 0 },
      manual: [],
      override: new Map(),
      contextKey: '',
      context: '',
      lastTokens: 0
    },
    diagnostics: { results: [], running: false, finishedAt: 0, base: '' }
  };

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const dom = {
    appShell: $('.app-shell'), sidebar: $('#sidebar'), newSessionButton: $('#newSessionButton'), historyList: $('#historyList'), recentCount: $('#recentCount'),
    apiSidebarButton: $('#apiSidebarButton'), githubSidebarButton: $('#githubSidebarButton'), apiSettingsButton: $('#apiSettingsButton'), heroConnectButton: $('#heroConnectButton'), heroWorkspaceButton: $('#heroWorkspaceButton'),
    sidebarApiDot: $('#sidebarApiDot'), topApiDot: $('#topApiDot'), sidebarApiHint: $('#sidebarApiHint'), apiLabel: $('#apiLabel'),
    modelSelect: $('#modelSelect'), activeModelName: $('#activeModelName'), activeModelDescription: $('#activeModelDescription'), modelContext: $('#modelContext'), modelTools: $('#modelTools'), modelCapabilityBadge: $('#modelCapabilityBadge'), rateLimitText: $('#rateLimitText'),
    chatArea: $('#chatArea'), welcomeScreen: $('#welcomeScreen'), messageList: $('#messageList'), promptForm: $('#promptForm'), promptInput: $('#promptInput'), sendButton: $('#sendButton'), quickPrompts: $('#quickPrompts'), workspaceHint: $('#workspaceHint'), modeHint: $('#modeHint'),
    connectFolderButton: $('#connectFolderButton'), connectGithubButton: $('#connectGithubButton'), attachButton: $('#attachButton'), changeWorkspaceButton: $('#changeWorkspaceButton'), disconnectWorkspaceButton: $('#disconnectWorkspaceButton'),
    workspaceName: $('#workspaceName'), workspaceSub: $('#workspaceSub'), workspaceAvatar: $('#workspaceAvatar'), workspaceStateDot: $('#workspaceStateDot'), workspaceConnectActions: $('#workspaceConnectActions'), workspaceConnectedActions: $('#workspaceConnectedActions'), workspaceTypeBadge: $('#workspaceTypeBadge'), workspaceBranchBadge: $('#workspaceBranchBadge'), workspaceEmpty: $('#workspaceEmpty'), filePanel: $('#filePanel'), fileCount: $('#fileCount'), fileSearch: $('#fileSearch'), fileList: $('#fileList'),
    topWorkspaceChip: $('#topWorkspaceChip'), workspaceFooterStatus: $('#workspaceFooterStatus'), pushChangesButton: $('#pushChangesButton'), dirtyCount: $('#dirtyCount'), downloadChangesButton: $('#downloadChangesButton'), downloadCount: $('#downloadCount'), localFileInput: $('#localFileInput'),
    apiDialog: $('#apiDialog'), apiForm: $('#apiForm'), apiKeyInput: $('#apiKeyInput'), apiFormError: $('#apiFormError'), saveApiButton: $('#saveApiButton'), revealApiKeyButton: $('#revealApiKeyButton'),
    githubDialog: $('#githubDialog'), githubForm: $('#githubForm'), githubRepoInput: $('#githubRepoInput'), githubBranchInput: $('#githubBranchInput'), githubTokenInput: $('#githubTokenInput'), githubFormError: $('#githubFormError'), connectGithubSubmit: $('#connectGithubSubmit'),
    writeDialog: $('#writeDialog'), writeDialogDescription: $('#writeDialogDescription'), writeFilePath: $('#writeFilePath'), writeLineCount: $('#writeLineCount'), writePreview: $('#writePreview'), approveWriteButton: $('#approveWriteButton'), denyWriteButton: $('#denyWriteButton'),
    fileDialog: $('#fileDialog'), fileDialogPath: $('#fileDialogPath'), filePreviewCode: $('#filePreviewCode'), copyFileButton: $('#copyFileButton'), toastRegion: $('#toastRegion'), mobileMenuButton: $('#mobileMenuButton'), inspectorMenuButton: $('#inspectorMenuButton'),
    // Token saver
    saverChip: $('#saverChip'), saverChipLabel: $('#saverChipLabel'), saverChipSaving: $('#saverChipSaving'), saverBadge: $('#saverBadge'), saverHeadline: $('#saverHeadline'), saverSub: $('#saverSub'),
    saverMeterFill: $('#saverMeterFill'), saverSent: $('#saverSent'), saverSaved: $('#saverSaved'), saverRuns: $('#saverRuns'), saverOpenButton: $('#saverOpenButton'),
    saverDialog: $('#saverDialog'), profileGrid: $('#profileGrid'), saverCurrentTurnToggle: $('#saverCurrentTurnToggle'), saverPruneToggle: $('#saverPruneToggle'), saverSchemaToggle: $('#saverSchemaToggle'),
    saverTurnsSelect: $('#saverTurnsSelect'), saverBudgetInput: $('#saverBudgetInput'), saverReport: $('#saverReport'), saverReportTitle: $('#saverReportTitle'), saverReportMeta: $('#saverReportMeta'),
    saverReportMeter: $('#saverReportMeter'), techniqueTable: $('#techniqueTable'), saverPreviewButton: $('#saverPreviewButton'), saverBenchmarkButton: $('#saverBenchmarkButton'), saverResetButton: $('#saverResetButton'), saverFootnote: $('#saverFootnote'),
    // Skills
    skillsBadge: $('#skillsBadge'), skillsHeadline: $('#skillsHeadline'), skillsSub: $('#skillsSub'), skillMiniList: $('#skillMiniList'), skillsOpenButton: $('#skillsOpenButton'),
    skillsDialog: $('#skillsDialog'), skillsList: $('#skillsList'), skillsCount: $('#skillsCount'), skillsRescanButton: $('#skillsRescanButton'), skillsAddFileButton: $('#skillsAddFileButton'),
    skillsPasteButton: $('#skillsPasteButton'), skillsTemplateButton: $('#skillsTemplateButton'), skillFileInput: $('#skillFileInput'), skillEditor: $('#skillEditor'), skillNameInput: $('#skillNameInput'),
    skillBodyInput: $('#skillBodyInput'), skillEditorSave: $('#skillEditorSave'), skillEditorCancel: $('#skillEditorCancel'), skillEditorError: $('#skillEditorError'),
    // Connection doctor + environment banner
    doctorDialog: $('#doctorDialog'), doctorRunButton: $('#doctorRunButton'), doctorStatus: $('#doctorStatus'), doctorResults: $('#doctorResults'), doctorCopyButton: $('#doctorCopyButton'), doctorSteps: $('#doctorSteps'),
    openCodecraftLoginButton: $('#openCodecraftLoginButton'), apiBaseInput: $('#apiBaseInput'), runDoctorButton: $('#runDoctorButton'),
    envBanner: $('#envBanner'), envBannerText: $('#envBannerText'), envBannerClose: $('#envBannerClose')
  };

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  }

  function iconSvg(name) {
    const icons = {
      forge: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2.2 17.2 6.3v7.4L10 17.8l-7.2-4.1V6.3L10 2.2Z"/><path d="m6.9 7.8 3.1-1.8 3.1 1.8v4.4L10 14l-3.1-1.8V7.8Z"/></svg>',
      user: '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="6.5" r="3"/><path d="M4.5 16.5a5.5 5.5 0 0 1 11 0"/></svg>',
      file: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M11.7 2.8H5.2A1.4 1.4 0 0 0 3.8 4.2v11.6a1.4 1.4 0 0 0 1.4 1.4h9.6a1.4 1.4 0 0 0 1.4-1.4V8.3l-4.5-5.5Z"/><path d="M11.4 3v5.3h4.5"/></svg>',
      copy: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5" y="4" width="8" height="9" rx="1.3"/><path d="M3.5 10.5V3.8A1.3 1.3 0 0 1 4.8 2.5h5"/></svg>',
      tool: '<svg viewBox="0 0 18 18" aria-hidden="true"><path d="M9 2.2v2M4.2 5.4 3 4.2m10.8 1.2L15 4.2M2.7 9h12.6M4.6 6.2h8.8a1.8 1.8 0 0 1 1.8 1.8v3.7a1.8 1.8 0 0 1-1.8 1.8H4.6a1.8 1.8 0 0 1-1.8-1.8V8a1.8 1.8 0 0 1 1.8-1.8Z"/><path d="M6.4 9.6v1.8m5.2-1.8v1.8"/></svg>'
    };
    return icons[name] || icons.file;
  }

  function showToast(message, kind = 'success', timeout = 3600) {
    const toast = document.createElement('div');
    toast.className = `toast${kind === 'error' ? ' is-error' : ''}`;
    toast.textContent = message;
    dom.toastRegion.append(toast);
    window.setTimeout(() => toast.remove(), timeout);
  }

  function setFormError(element, message = '') {
    element.textContent = message;
    element.classList.toggle('is-visible', Boolean(message));
  }

  function friendlyFetchError(error, service) {
    if (error?.name === 'AbortError') return 'Request cancelled.';
    if (error instanceof TypeError || error?.name === 'TypeError') return `Could not reach ${service}. Check your connection, and confirm the API allows browser requests (CORS).`;
    return error?.message || `Something went wrong while contacting ${service}.`;
  }

  async function readErrorResponse(response) {
    let body = '';
    try { body = await response.text(); } catch (_) { /* response body can be empty */ }
    let data;
    try { data = body ? JSON.parse(body) : null; } catch (_) { data = null; }
    const detail = data?.error?.message || data?.message || body;
    return detail ? `${response.status}: ${String(detail).slice(0, 420)}` : `${response.status}: ${response.statusText || 'Request failed'}`;
  }

  function setApiConnected(connected, label = '') {
    dom.sidebarApiDot.classList.toggle('is-connected', connected);
    dom.topApiDot.classList.toggle('is-connected', connected);
    dom.sidebarApiDot.classList.toggle('is-error', label === 'error');
    dom.topApiDot.classList.toggle('is-error', label === 'error');
    dom.apiLabel.textContent = connected ? 'CodeCraft ready' : label === 'error' ? 'API error' : 'Connect API';
    dom.sidebarApiHint.textContent = connected
      ? `${state.models.length} model${state.models.length === 1 ? '' : 's'} available for this tab.`
      : label === 'error' ? 'Check your key or connection, then try again.' : 'Connect your key to load models and start a session.';
  }

  function formatContext(value) {
    if (!Number.isFinite(Number(value)) || Number(value) <= 0) return '—';
    const size = Number(value);
    if (size >= 1_000_000) return `${(size / 1_000_000).toFixed(size % 1_000_000 ? 1 : 0)}M`;
    if (size >= 1000) return `${Math.round(size / 1000)}k`;
    return String(size);
  }

  function renderModelDetails() {
    const model = state.models.find(item => item.id === state.selectedModel) || state.selectedModelData;
    state.selectedModelData = model || null;
    dom.activeModelName.textContent = state.selectedModel || FALLBACK_MODEL;
    if (!model) {
      dom.activeModelDescription.textContent = state.apiKey ? 'Model details are not available.' : 'Choose a model from your CodeCraft catalog.';
      dom.modelContext.textContent = '—';
      dom.modelTools.textContent = '—';
      dom.modelCapabilityBadge.textContent = state.apiKey ? 'CONNECTED' : 'API NEEDED';
      dom.modelCapabilityBadge.classList.toggle('is-muted', !state.apiKey);
      return;
    }
    dom.activeModelDescription.textContent = model.description || `${model.name || model.id} is available through your CodeCraft account.`;
    dom.modelContext.textContent = formatContext(model.context_window);
    const capabilities = Array.isArray(model.capabilities) ? model.capabilities : [];
    const supportsTools = capabilities.includes('tools');
    dom.modelTools.textContent = capabilities.length ? (supportsTools ? 'Supported' : 'Not listed') : 'Unknown';
    dom.modelCapabilityBadge.textContent = capabilities.includes('reasoning') ? 'REASONING' : supportsTools ? 'TOOL READY' : 'AVAILABLE';
    dom.modelCapabilityBadge.classList.toggle('is-muted', !supportsTools && !capabilities.includes('reasoning'));
    const price = model.pricing;
    if (price && (price.input_per_1k !== undefined || price.output_per_1k !== undefined)) {
      const inputPrice = Number(price.input_per_1k || 0).toFixed(5).replace(/0+$/, '').replace(/\.$/, '');
      const outputPrice = Number(price.output_per_1k || 0).toFixed(5).replace(/0+$/, '').replace(/\.$/, '');
      dom.rateLimitText.textContent = `In $${inputPrice} · Out $${outputPrice} per 1K tokens`;
    } else {
      dom.rateLimitText.textContent = state.rateLimitText;
    }
  }

  function renderModelOptions() {
    const previous = state.selectedModel;
    const options = state.models.map(model => {
      const label = model.name && model.name !== model.id ? `${model.name} · ${model.id}` : model.id;
      return `<option value="${escapeHtml(model.id)}">${escapeHtml(label)}</option>`;
    });
    if (!state.models.some(model => model.id === FALLBACK_MODEL)) {
      options.unshift(`<option value="${FALLBACK_MODEL}">${FALLBACK_MODEL}</option>`);
    }
    dom.modelSelect.innerHTML = options.join('');
    if ([...dom.modelSelect.options].some(option => option.value === previous)) {
      dom.modelSelect.value = previous;
    } else {
      dom.modelSelect.value = state.models[0]?.id || FALLBACK_MODEL;
      state.selectedModel = dom.modelSelect.value;
    }
    renderModelDetails();
  }

  async function fetchModels(apiKey) {
    let response;
    try {
      response = await fetch(`${state.apiBase}/models`, {
        headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
        cache: 'no-store'
      });
    } catch (error) {
      throw new Error(friendlyFetchError(error, 'CodeCraft API'));
    }
    if (!response.ok) throw new Error(await readErrorResponse(response));
    let payload;
    try { payload = await response.json(); } catch (_) { throw new Error('CodeCraft returned an unreadable model list.'); }
    const models = Array.isArray(payload) ? payload : payload?.data;
    if (!Array.isArray(models)) throw new Error('CodeCraft returned an unexpected model list.');
    return models.filter(model => model && typeof model.id === 'string');
  }

  function openApiDialog() {
    setFormError(dom.apiFormError, '');
    if (dom.apiBaseInput) dom.apiBaseInput.value = state.apiBase;
    dom.apiKeyInput.value = '';
    dom.apiKeyInput.placeholder = state.apiKey ? 'Connected for this tab — enter a new key to replace' : 'cc_••••••••••••••••';
    dom.apiKeyInput.type = 'password';
    dom.revealApiKeyButton.textContent = 'Show';
    if (typeof dom.apiDialog.showModal === 'function') dom.apiDialog.showModal();
    else dom.apiDialog.setAttribute('open', '');
    window.setTimeout(() => dom.apiKeyInput.focus(), 60);
  }

  async function handleApiFormSubmit(event) {
    event.preventDefault();
    setFormError(dom.apiFormError, '');
    if (dom.apiBaseInput) {
      const normalized = normalizeApiBase(dom.apiBaseInput.value);
      if (normalized.error) {
        setFormError(dom.apiFormError, normalized.error);
        return;
      }
      if (normalized.value !== state.apiBase) {
        state.apiBase = normalized.value;
        saveSettings();
        state.models = [];
        showToast(`API base set to ${state.apiBase}.`);
      }
    }
    const candidate = dom.apiKeyInput.value.trim() || state.apiKey;
    if (!candidate) {
      setFormError(dom.apiFormError, 'Paste a CodeCraft API key to continue.');
      dom.apiKeyInput.focus();
      return;
    }
    dom.saveApiButton.disabled = true;
    dom.saveApiButton.innerHTML = 'Testing connection…';
    try {
      const models = await fetchModels(candidate);
      state.apiKey = candidate;
      state.models = models;
      setApiConnected(true);
      renderModelOptions();
      dom.apiDialog.close();
      showToast(`Connected to CodeCraft. ${models.length} models loaded.`);
    } catch (error) {
      setApiConnected(Boolean(state.apiKey), state.apiKey ? '' : 'error');
      const base = friendlyFetchError(error, 'CodeCraft API');
      setFormError(dom.apiFormError, `${base}${error instanceof TypeError ? ' Open the Connection doctor for the exact reason — a browser check, a blocker or an offline network all look like this.' : ''}`);
    } finally {
      dom.saveApiButton.disabled = false;
      dom.saveApiButton.innerHTML = 'Save &amp; test <span>↗</span>';
    }
  }

  /* ---------------------------------------------------------------------- *
   * Settings (non-secret only; API keys are never persisted)
   * ---------------------------------------------------------------------- */

  function loadSettings() {
    let stored = null;
    try { stored = JSON.parse(window.localStorage.getItem(SETTINGS_KEY) || 'null'); } catch (_) { stored = null; }
    if (!stored || typeof stored !== 'object') return;
    if (typeof stored.apiBase === 'string' && stored.apiBase) state.apiBase = stored.apiBase;
    const saver = stored.saver;
    if (saver && typeof saver === 'object') {
      if (COMPRESSOR && COMPRESSOR.PROFILES[saver.profile]) state.saver.profile = saver.profile;
      if (Number.isFinite(Number(saver.keepRecentTurns))) state.saver.keepRecentTurns = Math.max(1, Math.min(6, Number(saver.keepRecentTurns)));
      if (typeof saver.compactCurrentTurnFiles === 'boolean') state.saver.compactCurrentTurnFiles = saver.compactCurrentTurnFiles;
      if (typeof saver.pruneOldPayloads === 'boolean') state.saver.pruneOldPayloads = saver.pruneOldPayloads;
      if (typeof saver.compactToolSchemas === 'boolean') state.saver.compactToolSchemas = saver.compactToolSchemas;
      if (Number.isFinite(Number(saver.targetTokens))) state.saver.targetTokens = Math.max(0, Number(saver.targetTokens));
    }
  }

  function saveSettings() {
    try {
      window.localStorage.setItem(SETTINGS_KEY, JSON.stringify({
        apiBase: state.apiBase,
        saver: {
          profile: state.saver.profile,
          keepRecentTurns: state.saver.keepRecentTurns,
          compactCurrentTurnFiles: state.saver.compactCurrentTurnFiles,
          pruneOldPayloads: state.saver.pruneOldPayloads,
          compactToolSchemas: state.saver.compactToolSchemas,
          targetTokens: state.saver.targetTokens
        }
      }));
    } catch (_) { /* private mode or storage disabled */ }
  }

  function normalizeApiBase(value) {
    const raw = String(value || '').trim().replace(/\/+$/, '');
    if (!raw) return { value: API_BASE, error: '' };
    let url;
    try { url = new URL(raw.includes('://') ? raw : `https://${raw}`); } catch (_) { return { value: state.apiBase, error: 'That does not look like a valid URL.' }; }
    const localHost = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && localHost)) {
      return { value: state.apiBase, error: 'Use https:// (plain http is only allowed for localhost gateways).' };
    }
    const path = url.pathname.replace(/\/+$/, '');
    if (!path || path === '/') url.pathname = '/v1';
    return { value: url.origin + url.pathname.replace(/\/+$/, ''), error: '' };
  }

  /* ---------------------------------------------------------------------- *
   * Claude skills: discovery, context, tools
   * ---------------------------------------------------------------------- */

  function skillEntries() {
    const registry = state.skills.registry;
    return [...(registry.skills || []), ...(registry.memory || []), ...(registry.commands || []), ...(registry.agents || [])];
  }

  /** Discover skills from the workspace, merge manual ones, apply toggles. */
  function refreshSkills(options = {}) {
    if (!SKILLS) return state.skills.registry;
    const discovered = SKILLS.discover(state.files);
    const manual = state.skills.manual.map(entry => {
      const classification = SKILLS.classify(entry.path, entry.content) || { kind: 'skill', format: 'skill-md' };
      const record = SKILLS.buildRecord(entry.path, entry.content, classification);
      const validation = SKILLS.validate(record);
      record.errors = validation.errors;
      record.warnings = validation.warnings;
      record.valid = validation.valid;
      record.manual = true;
      return record;
    });
    discovered.skills = [...discovered.skills, ...manual].sort((a, b) => a.name.localeCompare(b.name));
    discovered.total += manual.length;
    discovered.errorCount += manual.reduce((sum, item) => sum + item.errors.length, 0);
    for (const record of skillEntries()) {
      const override = state.skills.override.get(record.path);
      record.enabled = override === undefined ? true : override;
    }
    state.skills.registry = discovered;
    state.skills.contextKey = '';
    if (options.silent !== true) renderSkillsPanel();
    if (options.toast) {
      const total = discovered.total;
      showToast(total ? `Loaded ${total} Claude markdown entr${total === 1 ? 'y' : 'ies'} into the model context.` : 'No CLAUDE.md or SKILL.md files found in this workspace.');
    }
    return discovered;
  }

  /** Build (and cache) the skills/memory block that rides in the system message. */
  function skillsContextBlock(mode = state.mode) {
    if (!SKILLS) return '';
    const registry = state.skills.registry;
    if (!registry.total) {
      state.skills.context = '';
      state.skills.lastTokens = 0;
      return '';
    }
    const key = [mode, registry.total, registry.errorCount, [...state.skills.override.entries()].join('|'), state.skills.manual.length, state.skills.registry.discoveredAt].join('::');
    if (key === state.skills.contextKey && state.skills.context) return state.skills.context;
    const built = SKILLS.buildContext(registry, {
      canLoadSkillFiles: mode === 'agent',
      inlineSkillBodyChars: mode === 'agent' ? 0 : 1400,
      memoryBudgetChars: 12000
    });
    // Instruction files are compressed with the lossless profile: whitespace
    // only, so nothing the project owner wrote can be reworded.
    const memorySafe = COMPRESSOR && built.text
      ? COMPRESSOR.compressText(built.text, { profile: 'safe' })
      : null;
    state.skills.context = memorySafe?.text || built.text;
    state.skills.lastTokens = COMPRESSOR ? COMPRESSOR.estimateTokens(state.skills.context) : built.report.tokens;
    state.skills.rawContextChars = built.text.length;
    state.skills.contextChars = state.skills.context.length;
    state.skills.rawTokens = COMPRESSOR ? COMPRESSOR.estimateTokens(built.text) : built.report.tokens;
    state.skills.contextKey = key;
    return state.skills.context;
  }

  function getSystemMessage(mode = state.mode) {
    const base = mode === 'agent' ? AGENT_SYSTEM : CHAT_SYSTEM;
    const skills = skillsContextBlock(mode);
    const content = skills ? `${base}\n\n${skills}` : base;
    return { role: 'system', content };
  }

  /** Base tools plus the skill tools, only when there is something to load. */
  function currentToolDefinitions() {
    if (!SKILLS || !state.skills.registry.total) return TOOL_DEFINITIONS;
    const extras = SKILLS.TOOL_DEFINITIONS.filter(tool => {
      if (tool.function.name === 'read_skill_resource') return state.skills.registry.skills.some(record => record.enabled !== false && record.resources.length);
      return true;
    });
    return [...TOOL_DEFINITIONS, ...extras];
  }

  function ensureSession() {
    if (state.currentSession) return state.currentSession;
    const session = {
      id: `session-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`,
      title: 'New session',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      apiMessages: [getSystemMessage()],
      entries: []
    };
    state.sessions.unshift(session);
    state.currentSession = session;
    renderHistory();
    return session;
  }

  function syncSessionSystem(session) {
    if (!session) return;
    if (!session.apiMessages.length || session.apiMessages[0].role !== 'system') session.apiMessages.unshift(getSystemMessage());
    else session.apiMessages[0] = getSystemMessage();
  }

  function titleFromPrompt(prompt) {
    const compact = prompt.replace(/\s+/g, ' ').trim();
    return compact.length > 32 ? `${compact.slice(0, 31).trimEnd()}…` : compact || 'New session';
  }

  function renderHistory() {
    dom.historyList.replaceChildren();
    const recent = state.sessions.slice(0, 12);
    dom.recentCount.textContent = String(state.sessions.length);
    if (!recent.length) {
      const empty = document.createElement('div');
      empty.className = 'history-empty';
      empty.textContent = 'Your sessions will appear here.';
      dom.historyList.append(empty);
      return;
    }
    for (const session of recent) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `history-item${state.currentSession?.id === session.id ? ' is-current' : ''}`;
      button.title = session.title;
      button.innerHTML = `${iconSvg('file')}<span></span>`;
      $('.history-item span', button).textContent = session.title;
      button.addEventListener('click', () => switchSession(session));
      dom.historyList.append(button);
    }
  }

  function switchSession(session) {
    if (session === state.currentSession) return;
    state.currentSession = session;
    syncSessionSystem(session);
    renderConversation();
    renderHistory();
    if (window.innerWidth <= 760) dom.appShell.classList.remove('menu-open');
  }

  function newSession() {
    if (state.sending) stopGeneration();
    state.currentSession = null;
    dom.messageList.replaceChildren();
    dom.messageList.hidden = true;
    dom.welcomeScreen.hidden = false;
    dom.promptInput.value = '';
    resizePrompt();
    renderHistory();
    if (window.innerWidth <= 760) dom.appShell.classList.remove('menu-open');
    dom.promptInput.focus();
  }

  function setMode(mode) {
    if (!['chat', 'agent'].includes(mode)) return;
    state.mode = mode;
    $$('[data-mode]').forEach(button => {
      const active = button.dataset.mode === mode;
      if (button.classList.contains('nav-item')) {
        button.classList.toggle('is-active', active);
        if (active) button.setAttribute('aria-current', 'page');
        else button.removeAttribute('aria-current');
      } else {
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-selected', String(active));
      }
    });
    dom.modeHint.textContent = mode === 'agent' ? 'AGENT' : 'CHAT';
    dom.modeHint.classList.toggle('agent-mode', mode === 'agent');
    dom.promptInput.placeholder = mode === 'agent'
      ? (state.skills.registry.total ? 'Describe a task — project skills are loaded…' : 'Describe a task for the agent…')
      : 'Ask a question or describe what you want to build…';
    const quickPrompts = $$('.quick-prompts button');
    quickPrompts.forEach(button => {
      if (mode === 'agent') button.title = 'Tip: connect a workspace so the agent can inspect files.';
      else button.removeAttribute('title');
    });
    if (state.currentSession) syncSessionSystem(state.currentSession);
    if (mode === 'agent' && state.workspace.kind === 'none') {
      dom.workspaceFooterStatus.textContent = 'Connect a workspace for file tools';
    } else if (state.workspace.kind === 'none') {
      dom.workspaceFooterStatus.textContent = 'Ready when you are';
    }
  }

  function addEntry(session, role, text = '') {
    const entry = { id: `entry-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`, role, text, activities: [], pending: role === 'assistant', error: '', element: null, sessionId: session.id, report: null };
    session.entries.push(entry);
    session.updatedAt = Date.now();
    if (session === state.currentSession) {
      dom.welcomeScreen.hidden = true;
      dom.messageList.hidden = false;
      entry.element = createMessageRow(entry);
      dom.messageList.append(entry.element);
      scrollToBottom(true);
    }
    return entry;
  }

  function renderConversation() {
    dom.messageList.replaceChildren();
    const entries = state.currentSession?.entries || [];
    const hasEntries = entries.length > 0;
    dom.welcomeScreen.hidden = hasEntries;
    dom.messageList.hidden = !hasEntries;
    if (!hasEntries) return;
    for (const entry of entries) {
      entry.element = createMessageRow(entry);
      dom.messageList.append(entry.element);
    }
    scrollToBottom(false);
  }

  function createMessageRow(entry) {
    const row = document.createElement('article');
    row.className = `message-row ${entry.role === 'user' ? 'user-message-row' : 'assistant-message-row'}`;
    row.dataset.entryId = entry.id;
    const avatar = document.createElement('div');
    avatar.className = `message-avatar${entry.role === 'user' ? ' user-avatar' : ''}`;
    avatar.innerHTML = iconSvg(entry.role === 'user' ? 'user' : 'forge');
    const body = document.createElement('div');
    body.className = 'message-body';
    const meta = document.createElement('div');
    meta.className = 'message-meta';
    const author = document.createElement('strong');
    author.textContent = entry.role === 'user' ? 'You' : 'Forge';
    const time = document.createElement('time');
    time.dateTime = new Date().toISOString();
    time.textContent = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    meta.append(author, time);
    const content = document.createElement('div');
    content.className = `message-text${entry.role === 'assistant' ? ' markdown-content' : ''}`;
    const activity = document.createElement('div');
    activity.className = 'activity-list';
    body.append(meta, content, activity);
    if (entry.role === 'user') row.append(avatar, body);
    else row.append(avatar, body);
    updateMessageRow(entry, row);
    return row;
  }

  function updateMessageRow(entry, existingRow = entry.element) {
    if (!existingRow) return;
    entry.element = existingRow;
    const content = $('.message-text', existingRow);
    const activityList = $('.activity-list', existingRow);
    content.replaceChildren();
    if (entry.role === 'user') {
      content.textContent = entry.text;
    } else if (entry.text) {
      renderMarkdown(content, entry.text);
    }
    if (entry.pending && entry.role === 'assistant' && !entry.text) {
      const indicator = document.createElement('span');
      indicator.className = 'typing-indicator';
      indicator.setAttribute('aria-label', 'Forge is thinking');
      indicator.innerHTML = '<span></span><span></span><span></span>';
      content.append(indicator);
    }
    if (entry.error) {
      const error = document.createElement('div');
      error.className = 'message-error';
      error.textContent = entry.error;
      content.append(error);
    }
    const meta = $('.message-meta', existingRow);
    if (meta) {
      meta.querySelectorAll('.meta-chip').forEach(node => node.remove());
      if (entry.report && entry.report.savedTokens > 0) {
        const chip = document.createElement('span');
        chip.className = `meta-chip${entry.report.lossy ? ' is-lossy' : ''}`;
        chip.textContent = `−${entry.report.savedPct}% · ${entry.report.savedTokens.toLocaleString()} tokens saved`;
        chip.title = [
          `${entry.report.profileLabel} profile`,
          `${entry.report.tokensBefore.toLocaleString()} → ${entry.report.tokensAfter.toLocaleString()} input tokens`,
          ...(entry.report.techniques || []).map(item => `${item.label}: ${item.tokens.toLocaleString()} tokens`)
        ].join('\n');
        meta.append(chip);
      }
      if (entry.role === 'assistant' && state.skills.registry.total) {
        const skillChip = document.createElement('span');
        skillChip.className = 'meta-chip is-muted';
        skillChip.textContent = `${state.skills.registry.total} Claude file${state.skills.registry.total === 1 ? '' : 's'} in context`;
        skillChip.title = 'CLAUDE.md / SKILL.md data loaded into the system message for this request.';
        meta.append(skillChip);
      }
    }
    activityList.replaceChildren();
    for (const message of entry.activities) {
      const item = document.createElement('div');
      item.className = 'agent-activity';
      item.innerHTML = iconSvg('tool');
      const label = document.createElement('span');
      label.textContent = message;
      item.append(label);
      activityList.append(item);
    }
    if (entry.sessionId === state.currentSession?.id) scrollToBottom(false);
  }

  function applyReportToEntry(entry, report) {
    if (!report || report.profile === 'off') return;
    const current = entry.report || { tokensBefore: 0, tokensAfter: 0, savedTokens: 0, savedPct: 0, runs: 0, techniques: [], lossy: false, profileLabel: report.profileLabel };
    current.tokensBefore += report.tokensBefore;
    current.tokensAfter += report.tokensAfter;
    current.savedTokens += report.savedTokens;
    current.runs += 1;
    current.lossy = current.lossy || report.lossy;
    current.profileLabel = report.profileLabel;
    current.savedPct = current.tokensBefore ? Math.round((current.savedTokens / current.tokensBefore) * 1000) / 10 : 0;
    current.techniques = report.techniques || [];
    entry.report = current;
    if (entry.element) updateMessageRow(entry);
  }

  function addActivity(entry, message) {
    entry.activities.push(message);
    if (entry.element) updateMessageRow(entry);
  }

  function scrollToBottom(smooth) {
    if (!dom.chatArea) return;
    const scroll = () => { dom.chatArea.scrollTop = dom.chatArea.scrollHeight; };
    if (smooth && typeof dom.chatArea.scrollTo === 'function') dom.chatArea.scrollTo({ top: dom.chatArea.scrollHeight, behavior: 'smooth' });
    else requestAnimationFrame(scroll);
  }

  function appendInline(container, text) {
    const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\([^)]+\))/g;
    let cursor = 0;
    for (const match of text.matchAll(pattern)) {
      const index = match.index;
      if (index > cursor) container.append(document.createTextNode(text.slice(cursor, index)));
      const token = match[0];
      if (token.startsWith('`')) {
        const code = document.createElement('code');
        code.textContent = token.slice(1, -1);
        container.append(code);
      } else if (token.startsWith('**')) {
        const strong = document.createElement('strong');
        strong.textContent = token.slice(2, -2);
        container.append(strong);
      } else if (token.startsWith('*')) {
        const emphasis = document.createElement('em');
        emphasis.textContent = token.slice(1, -1);
        container.append(emphasis);
      } else {
        const linkParts = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
        let url;
        try { url = new URL(linkParts?.[2] || '', window.location.href); } catch (_) { url = null; }
        if (linkParts && url && ['http:', 'https:'].includes(url.protocol)) {
          const link = document.createElement('a');
          link.href = url.href;
          link.target = '_blank';
          link.rel = 'noreferrer noopener';
          link.textContent = linkParts[1];
          container.append(link);
        } else container.append(document.createTextNode(token));
      }
      cursor = index + token.length;
    }
    if (cursor < text.length) container.append(document.createTextNode(text.slice(cursor)));
  }

  function renderMarkdown(container, markdown) {
    container.replaceChildren();
    const lines = String(markdown).replace(/\r/g, '').split('\n');
    let paragraph = [];
    let list = null;
    let index = 0;
    const flushParagraph = () => {
      if (!paragraph.length) return;
      const p = document.createElement('p');
      paragraph.forEach((line, lineIndex) => {
        if (lineIndex) p.append(document.createElement('br'));
        appendInline(p, line);
      });
      container.append(p);
      paragraph = [];
    };
    const flushList = () => { list = null; };
    while (index < lines.length) {
      const line = lines[index];
      const fence = /^\s*```([^`]*)$/.exec(line);
      if (fence) {
        flushParagraph(); flushList();
        const language = fence[1].trim() || 'code';
        const codeLines = [];
        index += 1;
        while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) codeLines.push(lines[index++]);
        const wrap = document.createElement('div');
        wrap.className = 'code-block-wrap';
        const header = document.createElement('div');
        header.className = 'code-block-head';
        const lang = document.createElement('span');
        lang.textContent = language;
        const copy = document.createElement('button');
        copy.type = 'button';
        copy.className = 'code-copy-button';
        copy.textContent = 'Copy';
        copy.addEventListener('click', async () => {
          try { await navigator.clipboard.writeText(codeLines.join('\n')); copy.textContent = 'Copied'; window.setTimeout(() => { copy.textContent = 'Copy'; }, 1200); }
          catch (_) { showToast('Clipboard access is not available in this browser.', 'error'); }
        });
        header.append(lang, copy);
        const pre = document.createElement('pre');
        const code = document.createElement('code');
        code.textContent = codeLines.join('\n');
        pre.append(code);
        wrap.append(header, pre);
        container.append(wrap);
        index += 1;
        continue;
      }
      if (!line.trim()) { flushParagraph(); flushList(); index += 1; continue; }
      const heading = /^(#{1,3})\s+(.+)$/.exec(line);
      if (heading) {
        flushParagraph(); flushList();
        const element = document.createElement(`h${heading[1].length}`);
        appendInline(element, heading[2]);
        container.append(element);
        index += 1;
        continue;
      }
      const bullet = /^\s*[-*+]\s+(.+)$/.exec(line);
      const numbered = /^\s*\d+[.)]\s+(.+)$/.exec(line);
      if (bullet || numbered) {
        flushParagraph();
        const type = bullet ? 'ul' : 'ol';
        if (!list || list.tagName.toLowerCase() !== type) {
          flushList();
          list = document.createElement(type);
          container.append(list);
        }
        const li = document.createElement('li');
        appendInline(li, (bullet || numbered)[1]);
        list.append(li);
        index += 1;
        continue;
      }
      flushList();
      paragraph.push(line);
      index += 1;
    }
    flushParagraph();
  }

  function resizePrompt() {
    dom.promptInput.style.height = 'auto';
    dom.promptInput.style.height = `${Math.min(dom.promptInput.scrollHeight, 170)}px`;
  }

  function setBusy(busy) {
    state.sending = busy;
    dom.modelSelect.disabled = busy;
    $$('.mode-tab, .nav-item[data-mode]').forEach(button => { button.disabled = busy; });
    [dom.apiSettingsButton, dom.apiSidebarButton, dom.githubSidebarButton, dom.connectFolderButton, dom.connectGithubButton, dom.attachButton, dom.changeWorkspaceButton, dom.disconnectWorkspaceButton].forEach(button => { if (button) button.disabled = busy; });
    if (busy) {
      dom.sendButton.classList.add('is-stop');
      dom.sendButton.setAttribute('aria-label', 'Stop generation');
      dom.promptInput.setAttribute('aria-busy', 'true');
    } else {
      dom.sendButton.classList.remove('is-stop');
      dom.sendButton.setAttribute('aria-label', 'Send message');
      dom.promptInput.removeAttribute('aria-busy');
    }
  }

  function stopGeneration() {
    if (!state.sending) return;
    state.abortController?.abort();
    if (state.pendingApproval) {
      const pending = state.pendingApproval;
      state.pendingApproval = null;
      try { dom.writeDialog.close(); } catch (_) { /* dialog may not be open */ }
      pending.resolve(false);
    }
    showToast('Stopping the current run…');
  }

  async function handlePromptSubmit(event) {
    event.preventDefault();
    if (state.sending) { stopGeneration(); return; }
    const prompt = dom.promptInput.value.trim();
    if (!prompt) return;
    if (!state.apiKey) {
      openApiDialog();
      showToast('Connect your CodeCraft API key before sending a prompt.', 'error');
      return;
    }
    if (state.mode === 'agent' && Array.isArray(state.selectedModelData?.capabilities) && !state.selectedModelData.capabilities.includes('tools')) {
      showToast('This model does not list tool support. Choose a model with the tools capability to use Agent mode.', 'error', 5000);
      return;
    }
    const session = ensureSession();
    syncSessionSystem(session);
    if (session.title === 'New session') session.title = titleFromPrompt(prompt);
    session.updatedAt = Date.now();
    renderHistory();
    session.apiMessages.push({ role: 'user', content: prompt });
    const userEntry = addEntry(session, 'user', prompt);
    userEntry.pending = false;
    dom.promptInput.value = '';
    resizePrompt();
    const assistantEntry = addEntry(session, 'assistant', '');
    setBusy(true);
    state.abortController = new AbortController();
    const signal = state.abortController.signal;
    try {
      if (state.mode === 'agent') await runAgent(session, assistantEntry, signal);
      else await runChat(session, assistantEntry, signal);
      if (!signal.aborted) assistantEntry.pending = false;
    } catch (error) {
      assistantEntry.pending = false;
      if (error?.name === 'AbortError' || signal.aborted) {
        if (!assistantEntry.text) assistantEntry.text = 'Run stopped.';
        else assistantEntry.text += '\n\n*Run stopped.*';
      } else {
        const message = friendlyFetchError(error, 'CodeCraft API');
        if (assistantEntry.text) assistantEntry.error = message;
        else assistantEntry.error = message;
        showToast(message, 'error', 5200);
      }
      if (assistantEntry.element) updateMessageRow(assistantEntry);
    } finally {
      if (state.currentSession === session) renderHistory();
      setBusy(false);
      state.abortController = null;
      state.pendingApproval = null;
      if (assistantEntry.element) updateMessageRow(assistantEntry);
    }
  }

  /** Run the outbound payload through the token saver and record the result. */
  function compressRequest({ messages, tools }) {
    const saver = state.saver;
    if (!COMPRESSOR || saver.profile === 'off') {
      return { messages, tools, report: COMPRESSOR ? COMPRESSOR.compressMessages(messages, { profile: 'off' }).report : null };
    }
    const prepared = COMPRESSOR.prepareRequest({
      messages,
      tools,
      options: {
        profile: saver.profile,
        keepRecentTurns: saver.keepRecentTurns,
        compactCurrentTurnFiles: saver.compactCurrentTurnFiles,
        pruneOldPayloads: saver.pruneOldPayloads,
        compactToolSchemas: saver.compactToolSchemas,
        targetTokens: saver.targetTokens
      }
    });
    // The system message is sent verbatim (it holds the instructions), but the
    // skill/instruction block itself was already compacted when it was built.
    // Attribute that measured saving to this request too.
    const skillTokens = (state.skills.rawTokens || 0) - (state.skills.lastTokens || 0);
    if (skillTokens > 0 && prepared.report) {
      prepared.report.tokensBefore += skillTokens;
      prepared.report.savedTokens = prepared.report.tokensBefore - prepared.report.tokensAfter;
      prepared.report.savedPct = prepared.report.tokensBefore
        ? Math.round((prepared.report.savedTokens / prepared.report.tokensBefore) * 1000) / 10
        : 0;
      prepared.report.techniques = [{
        id: 'skills-context',
        label: 'Instruction + skill block compaction',
        lossy: false,
        chars: (state.skills.rawContextChars || 0) - (state.skills.contextChars || 0),
        tokens: skillTokens,
        hits: 1,
        detail: 'workspace markdown compared with the compacted copy that went into the system message'
      }, ...prepared.report.techniques];
    }
    recordSaverReport(prepared.report);
    return prepared;
  }

  function recordSaverReport(report) {
    if (!report) return;
    const totals = state.saver.totals;
    totals.runs += 1;
    totals.tokensBefore += report.tokensBefore;
    totals.tokensAfter += report.tokensAfter;
    totals.saved += report.savedTokens;
    totals.lastReport = report;
    renderSaverPanel();
  }

  async function requestCompletion(messages, options = {}) {
    const model = state.models.find(item => item.id === state.selectedModel);
    const capabilities = Array.isArray(model?.capabilities) ? model.capabilities : null;
    const compressed = compressRequest({
      messages,
      tools: options.tools?.length ? options.tools : null
    });
    const payload = {
      model: state.selectedModel,
      messages: compressed.messages,
      stream: !capabilities || capabilities.includes('streaming'),
      temperature: state.mode === 'agent' ? 0.25 : 0.55
    };
    if (compressed.tools?.length) {
      payload.tools = compressed.tools;
      payload.tool_choice = 'auto';
    }
    options.onReport?.(compressed.report);
    let response;
    try {
      response = await fetch(`${state.apiBase}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${state.apiKey}`, 'Content-Type': 'application/json', Accept: 'text/event-stream, application/json' },
        body: JSON.stringify(payload),
        signal: options.signal
      });
    } catch (error) {
      throw new Error(friendlyFetchError(error, 'CodeCraft API'));
    }
    updateRateLimit(response.headers);
    if (!response.ok) throw new Error(await readErrorResponse(response));
    const contentType = response.headers.get('content-type') || '';
    if (!response.body || !contentType.toLowerCase().includes('text/event-stream')) {
      const body = await response.json();
      if (body?.error) throw new Error(body.error.message || 'CodeCraft API returned an error.');
      const message = body?.choices?.[0]?.message;
      if (!message) throw new Error('CodeCraft returned an empty completion.');
      return { text: typeof message.content === 'string' ? message.content : '', toolCalls: normalizeToolCalls(message.tool_calls || []), usage: body.usage || null, report: compressed.report };
    }
    const streamed = await readEventStream(response.body, options);
    return { ...streamed, report: compressed.report };
  }

  function updateRateLimit(headers) {
    const rpm = headers.get('x-ratelimit-remaining');
    const tpm = headers.get('x-ratelimit-remaining-tokens');
    if (rpm || tpm) {
      const bits = [];
      if (rpm) bits.push(`${rpm} req left`);
      if (tpm) bits.push(`${Number(tpm).toLocaleString()} tokens left`);
      state.rateLimitText = bits.join(' · ');
      if (!state.models.find(item => item.id === state.selectedModel)?.pricing) dom.rateLimitText.textContent = state.rateLimitText;
    }
  }

  async function readEventStream(body, options = {}) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let text = '';
    let usage = null;
    const calls = new Map();
    const processLine = line => {
      if (!line.startsWith('data:')) return;
      const raw = line.slice(5).trim();
      if (!raw || raw === '[DONE]') return;
      let data;
      try { data = JSON.parse(raw); } catch (_) { return; }
      if (data?.error) throw new Error(data.error.message || 'CodeCraft returned an error while streaming.');
      const choice = data?.choices?.[0];
      const delta = choice?.delta;
      if (typeof delta?.content === 'string') {
        text += delta.content;
        options.onText?.(text);
      } else if (Array.isArray(delta?.content)) {
        const textChunk = delta.content.filter(part => part?.type === 'text').map(part => part.text || '').join('');
        if (textChunk) { text += textChunk; options.onText?.(text); }
      }
      if (Array.isArray(delta?.tool_calls)) {
        for (const part of delta.tool_calls) {
          const index = Number.isInteger(part.index) ? part.index : calls.size;
          const current = calls.get(index) || { id: '', type: 'function', function: { name: '', arguments: '' } };
          if (part.id) current.id += part.id;
          if (part.type) current.type = part.type;
          if (part.function?.name) current.function.name += part.function.name;
          if (part.function?.arguments) current.function.arguments += part.function.arguments;
          calls.set(index, current);
        }
      }
      if (data.usage) usage = data.usage;
    };
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || '';
        for (const line of lines) processLine(line);
      }
      buffer += decoder.decode();
      if (buffer) processLine(buffer);
    } catch (error) {
      try { await reader.cancel(); } catch (_) { /* stream already closed */ }
      throw error;
    }
    return { text, toolCalls: normalizeToolCalls([...calls.values()]), usage };
  }

  function normalizeToolCalls(calls) {
    return calls.map((call, index) => ({
      id: call.id || `call_${Date.now()}_${index}`,
      type: call.type || 'function',
      function: {
        name: call.function?.name || '',
        arguments: typeof call.function?.arguments === 'string' ? call.function.arguments : JSON.stringify(call.function?.arguments || {})
      }
    }));
  }

  async function runChat(session, entry, signal) {
    let segment = '';
    const result = await requestCompletion(session.apiMessages, {
      signal,
      onReport: report => applyReportToEntry(entry, report),
      onText: text => {
        segment = text;
        entry.text = text;
        entry.pending = true;
        if (entry.element) updateMessageRow(entry);
      }
    });
    entry.text = result.text || 'I didn’t receive any text in that response.';
    entry.pending = false;
    session.apiMessages.push({ role: 'assistant', content: result.text || '' });
    session.updatedAt = Date.now();
    if (entry.element) updateMessageRow(entry);
    void segment;
  }

  async function runAgent(session, entry, signal) {
    let completedToolCalls = 0;
    let rounds = 0;
    while (rounds < MAX_AGENT_ROUNDS) {
      if (signal.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
      rounds += 1;
      let segment = '';
      const textBeforeRound = entry.text;
      const result = await requestCompletion(session.apiMessages, {
        signal,
        onReport: report => applyReportToEntry(entry, report),
        tools: currentToolDefinitions(),
        onText: text => {
          segment = text;
          entry.pending = true;
          if (text) entry.text = `${textBeforeRound}${textBeforeRound ? '\n\n' : ''}${text}`;
          if (entry.element) updateMessageRow(entry);
        }
      });
      const assistantContent = result.text || '';
      if (assistantContent && segment !== assistantContent) {
        entry.text = `${textBeforeRound}${textBeforeRound ? '\n\n' : ''}${assistantContent}`;
      }
      if (!result.toolCalls.length) {
        session.apiMessages.push({ role: 'assistant', content: assistantContent });
        entry.pending = false;
        if (!entry.text) entry.text = 'I didn’t receive any text in that response.';
        session.updatedAt = Date.now();
        if (entry.element) updateMessageRow(entry);
        return;
      }
      session.apiMessages.push({ role: 'assistant', content: assistantContent || null, tool_calls: result.toolCalls });
      for (const call of result.toolCalls) {
        if (signal.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
        completedToolCalls += 1;
        if (completedToolCalls > MAX_TOOL_CALLS) {
          session.apiMessages.push({ role: 'tool', tool_call_id: call.id, content: 'Tool-call limit reached for this run. Summarize what you have and ask the user to continue if needed.' });
          entry.text += '\n\nI paused after reaching the per-run tool limit. You can send a follow-up to continue.';
          entry.pending = false;
          if (entry.element) updateMessageRow(entry);
          return;
        }
        const name = call.function?.name || 'unknown tool';
        addActivity(entry, `Agent requested ${name.replaceAll('_', ' ')}…`);
        let output;
        try {
          const args = JSON.parse(call.function?.arguments || '{}');
          output = await executeTool(name, args, entry);
        } catch (error) {
          output = { content: `Tool error: ${error.message || String(error)}`, activity: `${name.replaceAll('_', ' ')} · error` };
        }
        if (output.activity) addActivity(entry, output.activity);
        session.apiMessages.push({ role: 'tool', tool_call_id: call.id, content: String(output.content).slice(0, 30_000) });
        session.updatedAt = Date.now();
      }
    }
    entry.pending = false;
    entry.text += '\n\nI paused after 8 agent rounds to keep the run bounded. Send a follow-up to continue.';
    if (entry.element) updateMessageRow(entry);
  }

  function normalizeWorkspacePath(path) {
    if (typeof path !== 'string' || !path.trim()) throw new Error('A project-relative file path is required.');
    const normalized = path.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/{2,}/g, '/');
    if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) throw new Error('Use a project-relative path, not an absolute path.');
    const segments = normalized.split('/');
    if (segments.some(segment => segment === '..' || segment === '.')) throw new Error('Paths cannot contain parent-directory segments.');
    if (segments[0] === '.git' || normalized.includes('/.git/')) throw new Error('The .git directory is not available to the agent.');
    if (normalized.length > 240) throw new Error('The file path is too long.');
    return normalized;
  }

  function currentWorkspaceName() {
    if (state.workspace.kind === 'github') return `${state.workspace.owner}/${state.workspace.repo}`;
    return state.workspace.name || 'project';
  }

  function hasUnexportedChanges() {
    return state.dirtyFiles.size > 0 && ['github', 'local-import'].includes(state.workspace.kind);
  }

  async function executeTool(name, args, entry) {
    if (SKILLS && name === 'list_skills') {
      const registry = state.skills.registry;
      if (!registry.total) return { content: 'No Claude markdown (CLAUDE.md, SKILL.md, .claude/commands) was found in this workspace.', activity: 'No skills found' };
      const filter = typeof args.kind === 'string' ? args.kind.trim().toLowerCase() : '';
      const rows = skillEntries()
        .filter(record => record.enabled !== false)
        .filter(record => !filter || record.kind === filter || (filter === 'memory' && record.kind === 'memory'))
        .map(record => `${record.kind.padEnd(8)} ${record.name} — ${record.description || record.summary || 'no description'} (${record.path})`);
      return {
        content: `${rows.length} entr${rows.length === 1 ? 'y' : 'ies'} available:\n${rows.join('\n')}`,
        activity: `Listed ${rows.length} skill entr${rows.length === 1 ? 'y' : 'ies'}`
      };
    }
    if (SKILLS && name === 'read_skill') {
      const record = SKILLS.resolveSkill(state.skills.registry, args.name);
      if (!record) return { content: `No skill named “${args.name}”. Use list_skills to see the available names.`, activity: `Unknown skill · ${args.name}` };
      if (record.enabled === false) return { content: `The user disabled “${record.name}” for this session, so its instructions are not available.`, activity: `Skill disabled · ${record.name}` };
      const rendered = SKILLS.renderSkillForModel(record, { maxChars: 24000 });
      const compact = COMPRESSOR && state.saver.profile !== 'off'
        ? COMPRESSOR.compressText(rendered, { profile: state.saver.profile === 'safe' ? 'safe' : 'balanced' }).text
        : rendered;
      return { content: compact, activity: `Loaded skill ${record.name}` };
    }
    if (SKILLS && name === 'read_skill_resource') {
      const record = SKILLS.resolveSkill(state.skills.registry, args.name);
      if (!record) return { content: `No skill named “${args.name}”.`, activity: `Unknown skill · ${args.name}` };
      let path;
      try { path = normalizeWorkspacePath(args.path); } catch (error) { return { content: error.message, activity: 'Resource path rejected' }; }
      const content = state.files.get(path);
      if (content === undefined) {
        const alternatives = record.resources.map(item => item.relative).slice(0, 10);
        return { content: `Not found in the workspace: ${path}.${alternatives.length ? ` Files bundled with this skill: ${alternatives.join(', ')}` : ''}`, activity: `Missing skill file · ${args.path}` };
      }
      return { content: `SKILL FILE: ${path}\n${content.slice(0, 20000)}${content.length > 20000 ? '\n… truncated' : ''}`, activity: `Read ${path}` };
    }
    if (state.workspace.kind === 'none') return { content: 'No workspace is connected. Ask the user to connect a local folder or GitHub repository before using file tools.', activity: 'No workspace connected' };
    if (name === 'list_files') {
      const contains = typeof args.contains === 'string' ? args.contains.toLowerCase() : '';
      const limit = Math.max(1, Math.min(150, Number(args.limit) || 100));
      const paths = [...state.files.keys()].filter(path => !contains || path.toLowerCase().includes(contains)).sort((a, b) => a.localeCompare(b)).slice(0, limit);
      return { content: paths.length ? `Workspace ${currentWorkspaceName()} · ${state.files.size} files loaded\n${paths.join('\n')}${paths.length === limit && state.files.size > paths.length ? '\n… more files omitted' : ''}` : `No loaded files match${contains ? ` “${contains}”` : ''}.`, activity: `Listed ${paths.length} file${paths.length === 1 ? '' : 's'}` };
    }
    if (name === 'read_file') {
      const path = normalizeWorkspacePath(args.path);
      const content = state.files.get(path);
      if (content === undefined) return { content: `File not found in the loaded workspace: ${path}. Use list_files to discover available paths.`, activity: `Could not find ${path}` };
      return { content: `FILE: ${path}\n${content.slice(0, 28_000)}${content.length > 28_000 ? '\n… file truncated for context' : ''}`, activity: `Read ${path}` };
    }
    if (name === 'search_files') {
      const query = typeof args.query === 'string' ? args.query.trim() : '';
      if (!query) return { content: 'Provide a non-empty search query.', activity: 'Search skipped · empty query' };
      const limit = Math.max(1, Math.min(50, Number(args.limit) || 30));
      const found = [];
      const needle = query.toLowerCase();
      for (const [path, content] of state.files) {
        const lines = content.split(/\r?\n/);
        for (let lineNumber = 0; lineNumber < lines.length; lineNumber += 1) {
          if (lines[lineNumber].toLowerCase().includes(needle)) {
            const snippet = lines[lineNumber].trim().slice(0, 260);
            found.push(`${path}:${lineNumber + 1}: ${snippet}`);
            if (found.length >= limit) break;
          }
        }
        if (found.length >= limit) break;
      }
      return { content: found.length ? `Matches for “${query}”:\n${found.join('\n')}${found.length === limit ? '\n… match limit reached' : ''}` : `No matches for “${query}” in loaded text files.`, activity: `Searched for “${query.slice(0, 32)}” · ${found.length} match${found.length === 1 ? '' : 'es'}` };
    }
    if (name === 'write_file') {
      const path = normalizeWorkspacePath(args.path);
      if (typeof args.content !== 'string') return { content: 'The content argument must be a string.', activity: `Could not edit ${path}` };
      if (args.content.length > MAX_FILE_BYTES) return { content: `This playground limits individual files to ${MAX_FILE_BYTES.toLocaleString()} characters. Split the content into smaller files or provide a smaller change.`, activity: `Change too large · ${path}` };
      if (!isTextPath(path)) return { content: 'This playground only edits text/code files. The requested path looks like a binary file.', activity: `Declined binary file · ${path}` };
      const previous = state.files.get(path) || '';
      const approved = await requestWriteApproval(path, args.content, previous, entry);
      if (!approved) return { content: `The user declined the proposed change to ${path}. Do not claim the file was changed.`, activity: `User declined edit · ${path}` };
      try {
        await applyFileChange(path, args.content);
        renderWorkspaceUI();
        return { content: `Updated ${path}. ${state.workspace.kind === 'github' ? 'The change is staged in browser memory; it has not been uploaded to GitHub yet. The user must choose Push changes.' : state.workspace.kind === 'local-import' ? 'This browser imported the folder read-only; the change is staged in browser memory. The user can download changed files as a ZIP.' : 'The approved content was written to the selected local folder.'}`, activity: `Approved and updated ${path}` };
      } catch (error) {
        return { content: `Could not write ${path}: ${error.message || String(error)}`, activity: `Write failed · ${path}` };
      }
    }
    return { content: `Unknown tool: ${name}`, activity: `Unknown tool · ${name}` };
  }

  function requestWriteApproval(path, content, previous, entry) {
    if (state.pendingApproval) return Promise.resolve(false);
    dom.writeDialogDescription.textContent = state.workspace.kind === 'github'
      ? 'The agent wants to stage a file change. It will not reach GitHub until you explicitly push.'
      : state.workspace.kind === 'local-import'
        ? 'The agent wants to stage a file change in this tab. This imported folder is read-only; you can download edits afterward.'
        : 'The agent wants to write this file to your local folder. Inspect the preview and approve to continue.';
    dom.writeFilePath.textContent = path;
    const lines = content.split(/\r?\n/);
    dom.writeLineCount.textContent = `${lines.length} line${lines.length === 1 ? '' : 's'} · ${content.length.toLocaleString()} chars`;
    const shown = lines.slice(0, 70).join('\n');
    dom.writePreview.textContent = `${shown}${lines.length > 70 ? '\n\n… preview truncated' : ''}`;
    dom.approveWriteButton.disabled = false;
    dom.approveWriteButton.textContent = 'Approve change ✓';
    if (typeof dom.writeDialog.showModal === 'function') dom.writeDialog.showModal();
    else dom.writeDialog.setAttribute('open', '');
    return new Promise(resolve => {
      state.pendingApproval = { resolve, path, content, previous, entry };
    });
  }

  async function applyFileChange(path, content) {
    if (state.workspace.kind === 'local') {
      const fileHandle = await getLocalFileHandle(path);
      const writable = await fileHandle.createWritable();
      await writable.write(content);
      await writable.close();
      state.fileHandles.set(path, fileHandle);
    }
    state.files.set(path, content);
    state.dirtyFiles.add(path);
  }

  async function getLocalFileHandle(path) {
    let handle = state.fileHandles.get(path);
    if (handle) {
      const permission = await handle.queryPermission({ mode: 'readwrite' });
      if (permission === 'granted') return handle;
      const requested = await handle.requestPermission({ mode: 'readwrite' });
      if (requested !== 'granted') throw new Error('The browser did not grant permission to write this file.');
      return handle;
    }
    const segments = path.split('/');
    let directory = state.workspace.rootHandle;
    if (!directory) throw new Error('The local folder handle is no longer available. Reconnect the folder.');
    for (const segment of segments.slice(0, -1)) directory = await directory.getDirectoryHandle(segment, { create: true });
    handle = await directory.getFileHandle(segments[segments.length - 1], { create: true });
    return handle;
  }

  function resolveWriteApproval(approved) {
    const pending = state.pendingApproval;
    if (!pending) return;
    state.pendingApproval = null;
    try { dom.writeDialog.close(); } catch (_) { /* dialog may not be open */ }
    pending.resolve(approved);
  }

  function isTextPath(path) {
    const name = path.split('/').pop().toLowerCase();
    if (!name || name.startsWith('.ds_store')) return false;
    const parts = name.split('.');
    const extension = parts.length > 1 ? parts.pop() : name;
    if (TEXT_EXTENSIONS.has(extension)) return true;
    return ['.gitignore', '.gitattributes', '.editorconfig', '.env', 'dockerfile', 'makefile', 'readme', 'license', 'procfile', 'justfile'].some(prefix => name === prefix || name.startsWith(`${prefix}.`));
  }

  function resetWorkspace(force = false) {
    if (!force && hasUnexportedChanges() && !window.confirm('There are unpushed or staged file changes. Disconnect and discard them?')) return false;
    state.workspace = { kind: 'none', name: '', owner: '', repo: '', branch: 'main' };
    state.files.clear();
    state.fileHandles.clear();
    state.dirtyFiles.clear();
    state.baseBlobShas.clear();
    state.githubToken = '';
    renderWorkspaceUI();
    return true;
  }

  async function connectLocalFolder() {
    if (state.sending) {
      showToast('Stop the current agent run before changing its workspace.', 'error');
      return;
    }
    if (typeof window.showDirectoryPicker === 'function' && window.isSecureContext) {
      try {
        const rootHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
        if (hasUnexportedChanges() && !window.confirm('Replace the current workspace and discard its staged changes?')) return;
        state.files.clear(); state.fileHandles.clear(); state.dirtyFiles.clear(); state.baseBlobShas.clear(); state.githubToken = '';
        state.workspace = { kind: 'local', name: rootHandle.name || 'Local project', rootHandle, owner: '', repo: '', branch: '' };
        dom.workspaceFooterStatus.textContent = 'Reading local files…';
        renderWorkspaceUI();
        let totalChars = 0;
        let count = 0;
        await scanDirectoryHandle(rootHandle, '', { get count() { return count; }, set count(value) { count = value; }, get totalChars() { return totalChars; }, set totalChars(value) { totalChars = value; } });
        renderWorkspaceUI();
        dom.workspaceFooterStatus.textContent = `Local folder · ${state.files.size} text files`;
        showToast(`Connected ${rootHandle.name || 'folder'} · ${state.files.size} text files loaded.`);
      } catch (error) {
        if (error?.name === 'AbortError') return;
        showToast(`Could not open that folder: ${error.message || String(error)}`, 'error', 5000);
        if (state.workspace.kind === 'local' && state.files.size === 0) resetWorkspace(true);
      }
      return;
    }
    dom.localFileInput.value = '';
    dom.localFileInput.click();
  }

  async function scanDirectoryHandle(directory, prefix, counters) {
    for await (const [name, handle] of directory.entries()) {
      if (counters.count >= MAX_WORKSPACE_FILES || counters.totalChars >= MAX_WORKSPACE_CHARS) return;
      if (handle.kind === 'directory') {
        if (SKIP_DIRS.has(name.toLowerCase())) continue;
        await scanDirectoryHandle(handle, prefix ? `${prefix}/${name}` : name, counters);
      } else {
        const path = prefix ? `${prefix}/${name}` : name;
        if (!isTextPath(path)) continue;
        try {
          const file = await handle.getFile();
          if (file.size > MAX_FILE_BYTES) continue;
          const content = await file.text();
          if (content.includes('\0')) continue;
          state.files.set(path, content);
          state.fileHandles.set(path, handle);
          counters.count += 1;
          counters.totalChars += content.length;
        } catch (_) { /* locked/unreadable files are skipped */ }
      }
    }
  }

  async function handleImportedFiles(event) {
    const files = [...(event.target.files || [])];
    if (!files.length) return;
    if (hasUnexportedChanges() && !window.confirm('Replace the current workspace and discard its staged changes?')) return;
    state.files.clear(); state.fileHandles.clear(); state.dirtyFiles.clear(); state.baseBlobShas.clear(); state.githubToken = '';
    const rootName = files[0].webkitRelativePath?.split('/')[0] || 'Imported project';
    state.workspace = { kind: 'local-import', name: rootName, owner: '', repo: '', branch: '' };
    renderWorkspaceUI();
    dom.workspaceFooterStatus.textContent = 'Importing local files…';
    let totalChars = 0;
    for (const file of files) {
      if (state.files.size >= MAX_WORKSPACE_FILES || totalChars >= MAX_WORKSPACE_CHARS) break;
      const fullPath = file.webkitRelativePath || file.name;
      const path = fullPath.includes('/') ? fullPath.split('/').slice(1).join('/') : fullPath;
      if (!isTextPath(path) || file.size > MAX_FILE_BYTES) continue;
      // File inputs include whole directory trees; skip dependencies and build output to keep context focused.
      if (path.split('/').some(segment => SKIP_DIRS.has(segment.toLowerCase()))) continue;
      try {
        const content = await file.text();
        if (content.includes('\0') || totalChars + content.length > MAX_WORKSPACE_CHARS) continue;
        state.files.set(path, content);
        totalChars += content.length;
        if (state.files.size % 15 === 0) {
          dom.workspaceFooterStatus.textContent = `Importing local files… ${state.files.size}`;
          renderWorkspaceUI();
        }
      } catch (_) { /* unreadable files are skipped */ }
    }
    renderWorkspaceUI();
    dom.workspaceFooterStatus.textContent = `Imported read-only · ${state.files.size} text files`;
    showToast(`Imported ${rootName}. This browser cannot write to the selected folder; use Download edits after changes.`);
  }

  function githubHeaders(token = state.githubToken) {
    const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
    if (token) headers.Authorization = `Bearer ${token}`;
    return headers;
  }

  async function githubRequest(path, options = {}) {
    let response;
    try {
      const headers = { ...githubHeaders(options.token), ...(options.headers || {}) };
      if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
      response = await fetch(`${GITHUB_API}${path}`, { method: options.method || 'GET', headers, body: options.body, cache: 'no-store' });
    } catch (error) {
      throw new Error(friendlyFetchError(error, 'GitHub API'));
    }
    if (!response.ok) {
      const detail = await readErrorResponse(response);
      if (response.status === 403 && /rate limit/i.test(detail)) throw new Error(`GitHub API rate limit reached. Add a GitHub token and try again. ${detail}`);
      if (response.status === 404) throw new Error('Repository, branch, or file not found. Check the owner/name, visibility, and branch.');
      throw new Error(`GitHub API · ${detail}`);
    }
    if (response.status === 204) return null;
    return response.json();
  }

  function openGithubDialog() {
    setFormError(dom.githubFormError, '');
    if (state.workspace.kind === 'github') {
      dom.githubRepoInput.value = `${state.workspace.owner}/${state.workspace.repo}`;
      dom.githubBranchInput.value = state.workspace.branch || 'main';
    } else {
      dom.githubRepoInput.value = '';
      dom.githubBranchInput.value = 'main';
    }
    dom.githubTokenInput.value = '';
    dom.githubTokenInput.placeholder = state.githubToken ? 'Token connected for this tab — optional replacement' : 'ghp_… or github_pat_…';
    if (typeof dom.githubDialog.showModal === 'function') dom.githubDialog.showModal();
    else dom.githubDialog.setAttribute('open', '');
    window.setTimeout(() => dom.githubRepoInput.focus(), 60);
  }

  async function handleGithubFormSubmit(event) {
    event.preventDefault();
    setFormError(dom.githubFormError, '');
    const rawRepo = dom.githubRepoInput.value.trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '').replace(/\/$/, '');
    const parts = rawRepo.split('/').filter(Boolean);
    const branch = dom.githubBranchInput.value.trim() || 'main';
    const token = dom.githubTokenInput.value.trim() || (state.workspace.kind === 'github' ? state.githubToken : '');
    if (parts.length !== 2 || parts.some(part => !/^[A-Za-z0-9_.-]+$/.test(part))) {
      setFormError(dom.githubFormError, 'Enter a repository in owner/name format, for example octocat/hello-world.');
      return;
    }
    if (branch.includes('..') || branch.startsWith('/') || branch.length > 200) {
      setFormError(dom.githubFormError, 'Enter a valid branch name.');
      return;
    }
    if (state.sending) { setFormError(dom.githubFormError, 'Stop the agent run before changing its workspace.'); return; }
    dom.connectGithubSubmit.disabled = true;
    dom.connectGithubSubmit.textContent = 'Loading repository…';
    try {
      const sameTarget = state.workspace.kind === 'github'
        && state.workspace.owner.toLowerCase() === parts[0].toLowerCase()
        && state.workspace.repo.toLowerCase() === parts[1].toLowerCase()
        && state.workspace.branch === branch;
      if (sameTarget) {
        if (token) {
          await githubRequest(`/repos/${encodeURIComponent(parts[0])}/${encodeURIComponent(parts[1])}/branches/${encodeURIComponent(branch)}`, { token });
          state.githubToken = token;
          showToast('GitHub token verified for this tab. Staged changes were kept.');
        }
        dom.githubDialog.close();
        return;
      }
      const files = await loadGithubWorkspace(parts[0], parts[1], branch, token);
      if (hasUnexportedChanges() && !window.confirm('Replace the current workspace and discard its staged changes?')) return;
      state.files = files.files;
      state.baseBlobShas = files.blobs;
      state.fileHandles.clear();
      state.dirtyFiles.clear();
      state.githubToken = token;
      state.workspace = { kind: 'github', owner: parts[0], repo: parts[1], name: `${parts[0]}/${parts[1]}`, branch, headSha: files.headSha, rootTreeSha: files.treeSha, truncated: files.truncated };
      renderWorkspaceUI();
      dom.githubDialog.close();
      showToast(`Connected ${parts[0]}/${parts[1]} · ${files.files.size} text files loaded.`);
      if (files.truncated) showToast('GitHub marked the repository tree as truncated; only the files returned by the API are available.', 'error', 6000);
    } catch (error) {
      setFormError(dom.githubFormError, friendlyFetchError(error, 'GitHub API'));
    } finally {
      dom.connectGithubSubmit.disabled = false;
      dom.connectGithubSubmit.innerHTML = 'Connect repository <span>↗</span>';
      if (state.workspace.kind === 'github') dom.workspaceFooterStatus.textContent = `${state.workspace.branch} · ${state.files.size} text files`;
    }
  }

  async function loadGithubWorkspace(owner, repo, branch, token) {
    const prefix = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
    const branchData = await githubRequest(`${prefix}/branches/${encodeURIComponent(branch)}`, { token });
    const headSha = branchData?.commit?.sha;
    const treeSha = branchData?.commit?.commit?.tree?.sha;
    if (!headSha || !treeSha) throw new Error('GitHub did not return the selected branch head.');
    const tree = await githubRequest(`${prefix}/git/trees/${encodeURIComponent(treeSha)}?recursive=1`, { token });
    const candidates = (tree.tree || []).filter(item => item.type === 'blob' && item.path && isTextPath(item.path) && Number(item.size || 0) <= MAX_FILE_BYTES && !item.path.split('/').some(segment => SKIP_DIRS.has(segment.toLowerCase())));
    const files = new Map();
    const blobs = new Map();
    let totalChars = 0;
    let next = 0;
    const worker = async () => {
      while (next < candidates.length && files.size < MAX_WORKSPACE_FILES && totalChars < MAX_WORKSPACE_CHARS) {
        const item = candidates[next++];
        try {
          const blob = await githubRequest(`${prefix}/git/blobs/${encodeURIComponent(item.sha)}`, { token });
          if (blob.encoding !== 'base64' || typeof blob.content !== 'string') continue;
          const text = decodeBase64Utf8(blob.content);
          if (text.includes('\0') || totalChars + text.length > MAX_WORKSPACE_CHARS) continue;
          files.set(item.path, text);
          blobs.set(item.path, item.sha);
          totalChars += text.length;
          if (next % 12 === 0) dom.workspaceFooterStatus.textContent = `Loading GitHub files… ${files.size}`;
        } catch (error) {
          if (error?.message?.includes('rate limit')) throw error;
        }
      }
    };
    await Promise.all(Array.from({ length: 5 }, worker));
    return { files, blobs, headSha, treeSha, truncated: Boolean(tree.truncated) || candidates.length > MAX_WORKSPACE_FILES };
  }

  function decodeBase64Utf8(value) {
    const binary = atob(value.replace(/\s/g, ''));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  }

  function encodeBase64Utf8(value) {
    const bytes = new TextEncoder().encode(value);
    let binary = '';
    const chunkSize = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
    }
    return btoa(binary);
  }

  async function pushGithubChanges() {
    if (state.workspace.kind !== 'github' || !state.dirtyFiles.size) return;
    if (!state.githubToken) {
      openGithubDialog();
      showToast('Add a GitHub token with repository contents access to push these staged changes.', 'error', 5000);
      return;
    }
    const commitButton = dom.pushChangesButton;
    commitButton.disabled = true;
    const label = $('span', commitButton);
    label.textContent = 'Pushing…';
    try {
      const { owner, repo, branch } = state.workspace;
      const prefix = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
      const branchData = await githubRequest(`${prefix}/branches/${encodeURIComponent(branch)}`);
      const headSha = branchData?.commit?.sha;
      const baseTreeSha = branchData?.commit?.commit?.tree?.sha;
      if (!headSha || !baseTreeSha) throw new Error('Could not read the current GitHub branch head.');
      const paths = [...state.dirtyFiles];
      const blobShas = new Map();
      let cursor = 0;
      const createBlobWorker = async () => {
        while (cursor < paths.length) {
          const path = paths[cursor++];
          const content = state.files.get(path);
          if (typeof content !== 'string') throw new Error(`Missing staged file content for ${path}.`);
          const blob = await githubRequest(`${prefix}/git/blobs`, { method: 'POST', body: JSON.stringify({ content: encodeBase64Utf8(content), encoding: 'base64' }) });
          blobShas.set(path, blob.sha);
          dom.workspaceFooterStatus.textContent = `Preparing commit… ${blobShas.size}/${paths.length}`;
        }
      };
      await Promise.all(Array.from({ length: Math.min(4, paths.length) }, createBlobWorker));
      const tree = await githubRequest(`${prefix}/git/trees`, {
        method: 'POST',
        body: JSON.stringify({
          base_tree: baseTreeSha,
          tree: paths.map(path => ({ path, mode: '100644', type: 'blob', sha: blobShas.get(path) }))
        })
      });
      const message = $('#commitMessageInput')?.value.trim() || 'Forge: update workspace';
      const commit = await githubRequest(`${prefix}/git/commits`, {
        method: 'POST',
        body: JSON.stringify({ message, tree: tree.sha, parents: [headSha] })
      });
      await githubRequest(`${prefix}/git/refs/heads/${encodeURIComponent(branch)}`, {
        method: 'PATCH',
        body: JSON.stringify({ sha: commit.sha, force: false })
      });
      for (const [path, sha] of blobShas) state.baseBlobShas.set(path, sha);
      state.workspace.headSha = commit.sha;
      state.workspace.rootTreeSha = tree.sha;
      state.dirtyFiles.clear();
      renderWorkspaceUI();
      dom.workspaceFooterStatus.textContent = `Pushed to ${branch}`;
      showToast(`Pushed ${paths.length} file${paths.length === 1 ? '' : 's'} to ${owner}/${repo}.`);
    } catch (error) {
      showToast(friendlyFetchError(error, 'GitHub API'), 'error', 6000);
      dom.workspaceFooterStatus.textContent = 'Push failed · review your token and branch';
    } finally {
      commitButton.disabled = false;
      const buttonLabel = $('span', commitButton);
      if (buttonLabel) buttonLabel.textContent = 'Push changes';
    }
  }

  function renderWorkspaceUI() {
    const kind = state.workspace.kind;
    const connected = kind !== 'none';
    const count = state.files.size;
    dom.workspaceConnectActions.hidden = connected;
    dom.workspaceConnectedActions.hidden = !connected;
    dom.workspaceStateDot.classList.toggle('is-ready', connected);
    dom.workspaceEmpty.hidden = connected;
    dom.filePanel.hidden = !connected;
    dom.disconnectWorkspaceButton.hidden = !connected;
    dom.workspaceName.textContent = connected ? (kind === 'github' ? `${state.workspace.owner}/${state.workspace.repo}` : state.workspace.name || 'Local project') : 'No workspace yet';
    dom.workspaceSub.textContent = !connected
      ? 'Connect a folder or repository'
      : kind === 'github'
        ? `${state.workspace.branch} branch · ${count} text files`
        : kind === 'local-import'
          ? `Read-only import · ${count} text files`
          : `Local folder · ${count} text files`;
    dom.workspaceTypeBadge.textContent = kind === 'github' ? 'GITHUB' : kind === 'local-import' ? 'IMPORT' : 'LOCAL';
    dom.workspaceBranchBadge.hidden = kind !== 'github';
    dom.workspaceBranchBadge.textContent = state.workspace.branch || 'main';
    dom.topWorkspaceChip.classList.toggle('is-connected', connected);
    const chipText = $('span', dom.topWorkspaceChip);
    chipText.textContent = connected ? (kind === 'github' ? `${state.workspace.owner}/${state.workspace.repo}` : state.workspace.name || 'Local folder') : 'No workspace';
    dom.workspaceHint.classList.toggle('is-connected', connected);
    const hintText = dom.workspaceHint.lastChild;
    if (hintText && hintText.nodeType === Node.TEXT_NODE) hintText.textContent = connected ? `${count} files · ${kind === 'github' ? 'GitHub' : kind === 'local-import' ? 'read-only' : 'local'}` : 'No project connected';
    dom.workspaceHint.title = connected ? `${count} text files available to the agent` : 'Connect a local folder or GitHub repository';
    dom.pushChangesButton.hidden = kind !== 'github' || state.dirtyFiles.size === 0;
    const commitMessageWrap = $('#commitMessageWrap');
    if (commitMessageWrap) commitMessageWrap.hidden = kind !== 'github' || state.dirtyFiles.size === 0;
    dom.dirtyCount.textContent = String(state.dirtyFiles.size);
    dom.downloadChangesButton.hidden = kind !== 'local-import' || state.dirtyFiles.size === 0;
    dom.downloadCount.textContent = String(state.dirtyFiles.size);
    if (kind === 'none') dom.workspaceFooterStatus.textContent = state.mode === 'agent' ? 'Connect a workspace for file tools' : 'Ready when you are';
    else if (kind === 'github') dom.workspaceFooterStatus.textContent = state.dirtyFiles.size ? `${state.dirtyFiles.size} staged change${state.dirtyFiles.size === 1 ? '' : 's'}` : `${state.workspace.branch} · ${count} text files`;
    else if (kind === 'local-import') dom.workspaceFooterStatus.textContent = state.dirtyFiles.size ? `${state.dirtyFiles.size} staged change${state.dirtyFiles.size === 1 ? '' : 's'} · download to export` : `Imported read-only · ${count} text files`;
    else dom.workspaceFooterStatus.textContent = state.dirtyFiles.size ? `${state.dirtyFiles.size} approved local change${state.dirtyFiles.size === 1 ? '' : 's'} saved` : `Local folder · ${count} text files`;
    renderFileList();
    // Re-discover skill markdown whenever the set of markdown paths changes.
    // (A Map identity check would miss in-place edits: the app mutates one Map.)
    const scanToken = [...state.files.keys()]
      .filter(path => /\.(?:md|markdown|mdx)$/i.test(path) || /SKILL\.md$/i.test(path))
      .join('|');
    if (scanToken !== state.skills.scanToken) {
      state.skills.scanToken = scanToken;
      refreshSkills({ silent: true });
      renderSkillsPanel();
      if (state.currentSession) syncSessionSystem(state.currentSession);
    }
  }

  function renderFileList() {
    dom.fileList.replaceChildren();
    const query = dom.fileSearch.value.trim().toLowerCase();
    const paths = [...state.files.keys()].filter(path => !query || path.toLowerCase().includes(query)).sort((a, b) => a.localeCompare(b));
    dom.fileCount.textContent = String(state.files.size);
    if (!paths.length) {
      const empty = document.createElement('div');
      empty.className = 'file-list-empty';
      empty.textContent = state.files.size ? 'No files match that filter.' : 'No text files were loaded.';
      dom.fileList.append(empty);
      return;
    }
    for (const path of paths) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'file-row';
      row.title = path;
      row.innerHTML = `${iconSvg('file')}<span class="file-path"></span>`;
      $('.file-path', row).textContent = path;
      if (state.dirtyFiles.has(path)) {
        const mark = document.createElement('i');
        mark.className = 'dirty-mark';
        mark.title = 'Changed';
        row.append(mark);
      }
      row.addEventListener('click', () => openFilePreview(path));
      dom.fileList.append(row);
    }
  }

  function openFilePreview(path) {
    const content = state.files.get(path);
    if (content === undefined) return;
    dom.fileDialogPath.textContent = path;
    dom.filePreviewCode.textContent = content;
    dom.copyFileButton.dataset.path = path;
    delete dom.copyFileButton.dataset.skillPath;
    if (typeof dom.fileDialog.showModal === 'function') dom.fileDialog.showModal();
    else dom.fileDialog.setAttribute('open', '');
  }

  function openFilePickerOrFolder() {
    connectLocalFolder();
  }

  function createZip(files) {
    const encoder = new TextEncoder();
    const localParts = [];
    const centralParts = [];
    let offset = 0;
    const crcTable = createCrcTable();
    for (const [path, content] of files) {
      const name = encoder.encode(path);
      const data = encoder.encode(content);
      const crc = crc32(data, crcTable);
      const local = new Uint8Array(30 + name.length);
      const localView = new DataView(local.buffer);
      localView.setUint32(0, 0x04034b50, true);
      localView.setUint16(4, 20, true);
      localView.setUint16(6, 0x0800, true);
      localView.setUint16(8, 0, true);
      localView.setUint16(10, 0, true);
      localView.setUint16(12, 0x21, true);
      localView.setUint32(14, crc, true);
      localView.setUint32(18, data.length, true);
      localView.setUint32(22, data.length, true);
      localView.setUint16(26, name.length, true);
      localView.setUint16(28, 0, true);
      local.set(name, 30);
      localParts.push(local, data);

      const central = new Uint8Array(46 + name.length);
      const centralView = new DataView(central.buffer);
      centralView.setUint32(0, 0x02014b50, true);
      centralView.setUint16(4, 20, true);
      centralView.setUint16(6, 20, true);
      centralView.setUint16(8, 0x0800, true);
      centralView.setUint16(10, 0, true);
      centralView.setUint16(12, 0, true);
      centralView.setUint16(14, 0x21, true);
      centralView.setUint32(16, crc, true);
      centralView.setUint32(20, data.length, true);
      centralView.setUint32(24, data.length, true);
      centralView.setUint16(28, name.length, true);
      centralView.setUint16(30, 0, true);
      centralView.setUint16(32, 0, true);
      centralView.setUint16(34, 0, true);
      centralView.setUint16(36, 0, true);
      centralView.setUint32(38, 0, true);
      centralView.setUint32(42, offset, true);
      central.set(name, 46);
      centralParts.push(central);
      offset += local.length + data.length;
    }
    const centralOffset = offset;
    const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
    const end = new Uint8Array(22);
    const endView = new DataView(end.buffer);
    endView.setUint32(0, 0x06054b50, true);
    endView.setUint16(4, 0, true);
    endView.setUint16(6, 0, true);
    endView.setUint16(8, files.length, true);
    endView.setUint16(10, files.length, true);
    endView.setUint32(12, centralSize, true);
    endView.setUint32(16, centralOffset, true);
    endView.setUint16(20, 0, true);
    return new Blob([...localParts, ...centralParts, end], { type: 'application/zip' });
  }

  function createCrcTable() {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      table[n] = c >>> 0;
    }
    return table;
  }

  function crc32(bytes, table) {
    let crc = 0xffffffff;
    for (const byte of bytes) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }

  function downloadChanges() {
    if (state.workspace.kind !== 'local-import' || !state.dirtyFiles.size) return;
    const changed = [...state.dirtyFiles].map(path => [path, state.files.get(path)]).filter(([, content]) => typeof content === 'string');
    if (!changed.length) return;
    const blob = createZip(changed);
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${(state.workspace.name || 'project').replace(/[^A-Za-z0-9_.-]+/g, '-')}-edits.zip`;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast(`Downloaded ${changed.length} edited file${changed.length === 1 ? '' : 's'} as a ZIP.`);
  }

  /* ---------------------------------------------------------------------- *
   * Token saver UI
   * ---------------------------------------------------------------------- */

  function formatCount(value) {
    const number = Number(value) || 0;
    if (number >= 1_000_000) return `${(number / 1_000_000).toFixed(number % 1_000_000 ? 1 : 0)}M`;
    if (number >= 1000) return `${(number / 1000).toFixed(number % 1000 < 100 ? 1 : 0)}k`;
    return String(number);
  }

  function sessionSaverPercentage() {
    const totals = state.saver.totals;
    if (!totals.tokensBefore) return 0;
    return Math.round((totals.saved / totals.tokensBefore) * 1000) / 10;
  }

  function renderSaverPanel() {
    if (!COMPRESSOR) return;
    const totals = state.saver.totals;
    const percent = sessionSaverPercentage();
    const profile = COMPRESSOR.PROFILES[state.saver.profile] || COMPRESSOR.PROFILES.balanced;
    dom.saverBadge.textContent = profile.label.toUpperCase();
    dom.saverBadge.classList.toggle('is-muted', state.saver.profile === 'off');
    dom.saverChipLabel.textContent = `Saver · ${profile.label}`;
    dom.saverChipSaving.hidden = totals.runs === 0;
    dom.saverChipSaving.textContent = `−${percent}%`;
    dom.saverChipSaving.classList.toggle('is-off', percent <= 0);
    dom.saverMeterFill.style.width = `${Math.min(100, percent)}%`;
    dom.saverSent.textContent = formatCount(totals.tokensBefore - totals.saved);
    dom.saverSaved.textContent = formatCount(totals.saved);
    dom.saverRuns.textContent = String(totals.runs);
    if (!totals.runs) {
      dom.saverHeadline.textContent = 'Nothing compressed yet';
      dom.saverSub.textContent = 'Requests are compacted in this tab before they are sent. Your files and the visible conversation are never modified.';
    } else {
      dom.saverHeadline.textContent = `−${percent}% input tokens this session`;
      dom.saverSub.textContent = `${totals.tokensBefore.toLocaleString()} tokens of context became ${totals.tokensAfter.toLocaleString()} across ${totals.runs} request${totals.runs === 1 ? '' : 's'}.`;
    }
    if (dom.saverDialog.open) renderSaverReport(totals.lastReport, 'Last request');
  }

  function renderProfileGrid() {
    if (!COMPRESSOR) return;
    const profiles = ['off', 'safe', 'balanced', 'aggressive'];
    dom.profileGrid.replaceChildren();
    for (const id of profiles) {
      const profile = COMPRESSOR.PROFILES[id];
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `profile-option${state.saver.profile === id ? ' is-active' : ''}`;
      button.setAttribute('role', 'radio');
      button.setAttribute('aria-checked', String(state.saver.profile === id));
      const tag = profile.id === 'off' || profile.lossy === false ? 'lossless' : 'lossy';
      button.innerHTML = `<span class="profile-tag ${tag}">${tag === 'lossless' ? 'LOSSLESS' : 'REWRITES'}</span><strong></strong><small></small>`;
      $('strong', button).textContent = profile.label;
      $('small', button).textContent = profile.description;
      button.addEventListener('click', () => {
        state.saver.profile = id;
        saveSettings();
        renderProfileGrid();
        renderSaverPanel();
        showToast(`Token saver profile: ${profile.label}.`);
      });
      dom.profileGrid.append(button);
    }
  }

  function renderSaverReport(report, title = 'Session totals') {
    if (!dom.saverDialog.open) return;
    dom.saverReportTitle.textContent = title;
    if (!report) {
      const totals = state.saver.totals;
      const percent = sessionSaverPercentage();
      dom.saverReportMeta.textContent = totals.runs ? `${totals.runs} runs · −${percent}%` : 'no requests yet';
      dom.saverReportMeter.style.width = `${Math.min(100, percent)}%`;
      dom.techniqueTable.innerHTML = totals.runs
        ? '<div class="technique-empty">Send another message to see a per-request breakdown, or run the sample benchmark.</div>'
        : '<div class="technique-empty">Nothing compressed yet. Run the sample benchmark to see what each technique saves.</div>';
      return;
    }
    dom.saverReportMeta.textContent = `${report.tokensBefore.toLocaleString()} → ${report.tokensAfter.toLocaleString()} tokens · −${report.savedPct}%`;
    dom.saverReportMeter.style.width = `${Math.min(100, report.savedPct)}%`;
    if (!report.techniques.length) {
      dom.techniqueTable.innerHTML = '<div class="technique-empty">Nothing needed rewriting in this request.</div>';
      return;
    }
    dom.techniqueTable.replaceChildren();
    for (const technique of report.techniques) {
      const row = document.createElement('div');
      row.className = 'technique-row';
      row.innerHTML = `<span></span><i class="technique-tag ${technique.lossy ? '' : 'is-lossless'}">${technique.lossy ? 'REWRITE' : 'LOSSLESS'}</i><b></b>`;
      $('span', row).textContent = `${technique.label}${technique.hits ? ` ×${technique.hits}` : ''}`;
      $('b', row).textContent = `−${technique.tokens.toLocaleString()} tok`;
      row.title = technique.detail || (technique.lossy ? 'Rewrites wording or removes comments from the request copy.' : 'Lossless: whitespace and duplicate removal only.');
      dom.techniqueTable.append(row);
    }
  }

  function openSaverDialog() {
    if (!COMPRESSOR) {
      showToast('The token saver module did not load.', 'error');
      return;
    }
    renderProfileGrid();
    dom.saverCurrentTurnToggle.checked = state.saver.compactCurrentTurnFiles;
    dom.saverPruneToggle.checked = state.saver.pruneOldPayloads;
    dom.saverSchemaToggle.checked = state.saver.compactToolSchemas;
    dom.saverTurnsSelect.value = String(state.saver.keepRecentTurns);
    dom.saverBudgetInput.value = String(state.saver.targetTokens || 0);
    dom.saverReportTitle.textContent = 'Session totals';
    if (typeof dom.saverDialog.showModal === 'function') dom.saverDialog.showModal();
    else dom.saverDialog.setAttribute('open', '');
    renderSaverReport(state.saver.totals.lastReport, state.saver.totals.lastReport ? 'Last request' : 'Session totals');
  }

  function previewCompression() {
    if (!COMPRESSOR) return;
    const session = state.currentSession;
    const messages = session?.apiMessages?.length ? session.apiMessages : [getSystemMessage()];
    const prepared = COMPRESSOR.compressMessages(messages, {
      profile: state.saver.profile,
      keepRecentTurns: state.saver.keepRecentTurns,
      compactCurrentTurnFiles: state.saver.compactCurrentTurnFiles,
      pruneOldPayloads: state.saver.pruneOldPayloads,
      compactToolSchemas: state.saver.compactToolSchemas,
      targetTokens: state.saver.targetTokens
    });
    renderSaverReport(
      { ...prepared.report, tokensBefore: prepared.report.tokensBefore, tokensAfter: prepared.report.tokensAfter },
      session?.apiMessages?.length ? 'Preview · this conversation' : 'Preview · system prompt only'
    );
    showToast(`Preview: ${prepared.report.tokensBefore.toLocaleString()} → ${prepared.report.tokensAfter.toLocaleString()} tokens (−${prepared.report.savedPct}%).`);
  }

  function runBenchmark() {
    if (!COMPRESSOR) return;
    const profile = state.saver.profile === 'off' ? 'balanced' : state.saver.profile;
    const scenario = state.mode === 'agent' ? 'agent' : 'session';
    const turns = scenario === 'agent' ? 12 : 20;
    const report = COMPRESSOR.benchmark({ profile, scenario, turns });
    renderSaverReport(report, `Benchmark · ${scenario === 'agent' ? 'Agent session with file reads' : 'Chat session'} · ${turns} turns · ${report.profileLabel}`);
    showToast(`Benchmark: −${report.savedPct}% on a synthetic ${turns}-turn ${scenario === 'agent' ? 'agent' : 'chat'} session.`);
  }

  /* ---------------------------------------------------------------------- *
   * Skills UI
   * ---------------------------------------------------------------------- */

  function renderSkillsPanel() {
    if (!SKILLS) return;
    const registry = state.skills.registry;
    const active = skillEntries().filter(record => record.enabled !== false);
    dom.skillsBadge.textContent = registry.errorCount ? 'CHECK' : registry.total ? 'LOADED' : 'NONE';
    dom.skillsBadge.classList.toggle('is-muted', registry.total === 0);
    dom.skillMiniList.replaceChildren();
    if (!registry.total) {
      dom.skillsHeadline.textContent = 'No skill markdown found';
      dom.skillsSub.textContent = 'Forge reads CLAUDE.md, agents.md, SKILL.md, .claude/commands and .claude/agents from the connected workspace and loads them as model data. Add one, or paste a skill directly.';
      return;
    }
    dom.skillsHeadline.textContent = `${registry.total} Claude markdown ${registry.total === 1 ? 'entry' : 'entries'} loaded`;
    const counts = [
      registry.skills.length ? `${registry.skills.length} skill${registry.skills.length === 1 ? '' : 's'}` : '',
      registry.memory.length ? `${registry.memory.length} instruction file${registry.memory.length === 1 ? '' : 's'}` : '',
      registry.commands.length ? `${registry.commands.length} command${registry.commands.length === 1 ? '' : 's'}` : '',
      registry.agents.length ? `${registry.agents.length} sub-agent${registry.agents.length === 1 ? '' : 's'}` : ''
    ].filter(Boolean);
    dom.skillsSub.textContent = `${counts.join(' · ')} in the model context (≈${state.skills.lastTokens.toLocaleString()} tokens). ${registry.errorCount ? `${registry.errorCount} need front-matter fixes.` : ''}`;
    for (const record of active.slice(0, 4)) {
      const row = document.createElement('div');
      row.className = 'skill-mini';
      row.innerHTML = '<strong></strong><small></small>';
      $('strong', row).textContent = record.name;
      $('small', row).textContent = record.kind === 'memory' ? 'MEMORY' : record.kind.toUpperCase();
      row.title = record.path;
      dom.skillMiniList.append(row);
    }
    if (active.length > 4) {
      const more = document.createElement('div');
      more.className = 'skill-mini';
      more.innerHTML = `<strong>+${active.length - 4} more</strong><small>OPEN</small>`;
      dom.skillMiniList.append(more);
    }
  }

  function skillRow(record) {
    const row = document.createElement('div');
    row.className = 'skill-row';
    const head = document.createElement('div');
    head.className = 'skill-row-head';
    head.innerHTML = `<span class="skill-badge kind-${record.kind}">${record.kind.toUpperCase()}</span><strong></strong><label class="skill-toggle"><input type="checkbox" /><span>in context</span></label>`;
    $('strong', head).textContent = record.name + (record.manual ? ' · added here' : '');
    const toggle = $('input', head);
    toggle.checked = record.enabled !== false;
    toggle.addEventListener('change', () => {
      state.skills.override.set(record.path, toggle.checked);
      record.enabled = toggle.checked;
      state.skills.contextKey = '';
      renderSkillsDialog();
      renderSkillsPanel();
      if (state.currentSession) syncSessionSystem(state.currentSession);
    });
    row.append(head);
    const description = document.createElement('p');
    description.textContent = record.description || record.summary || 'No description — the model has less to go on when deciding to load this.';
    row.append(description);
    const path = document.createElement('span');
    path.className = 'skill-path';
    path.textContent = `${record.path} · ${record.lines} lines · ${record.chars.toLocaleString()} chars${record.resources.length ? ` · ${record.resources.length} bundled file${record.resources.length === 1 ? '' : 's'}` : ''}`;
    row.append(path);
    if (record.errors.length || record.warnings.length) {
      const list = document.createElement('ul');
      list.className = 'skill-problems';
      for (const message of record.errors) {
        const item = document.createElement('li');
        item.className = 'is-error';
        item.textContent = message;
        list.append(item);
      }
      for (const message of record.warnings) {
        const item = document.createElement('li');
        item.textContent = message;
        list.append(item);
      }
      row.append(list);
    }
    const actions = document.createElement('div');
    actions.className = 'skill-row-actions';
    const preview = document.createElement('button');
    preview.type = 'button';
    preview.className = 'modal-secondary';
    preview.textContent = 'Preview body';
    preview.addEventListener('click', () => {
      dom.fileDialogPath.textContent = `${record.path}${record.allowedTools.length ? ` · allowed-tools: ${record.allowedTools.join(', ')}` : ''}`;
      dom.filePreviewCode.textContent = record.body || '(empty body)';
      dom.copyFileButton.dataset.path = '';
      dom.copyFileButton.dataset.skillPath = record.path;
      if (typeof dom.fileDialog.showModal === 'function') dom.fileDialog.showModal();
    });
    actions.append(preview);
    if (record.manual) {
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'modal-secondary';
      remove.textContent = 'Remove';
      remove.addEventListener('click', () => {
        state.skills.manual = state.skills.manual.filter(item => item.path !== record.path);
        refreshSkills();
        renderSkillsDialog();
        renderSkillsPanel();
      });
      actions.append(remove);
    }
    row.append(actions);
    return row;
  }

  function renderSkillsDialog() {
    if (!SKILLS || !dom.skillsDialog.open) return;
    const registry = state.skills.registry;
    dom.skillsCount.textContent = registry.total
      ? `${registry.total} entr${registry.total === 1 ? 'y' : 'ies'} · ≈${state.skills.lastTokens.toLocaleString()} tokens injected`
      : 'nothing detected yet';
    dom.skillsList.replaceChildren();
    if (!registry.total) {
      const empty = document.createElement('div');
      empty.className = 'skill-empty';
      empty.innerHTML = 'No Claude markdown found in this workspace.<br />Add <code>CLAUDE.md</code> or <code>.claude/skills/&lt;name&gt;/SKILL.md</code>, click <strong>Rescan workspace</strong>, or paste one below.';
      dom.skillsList.append(empty);
      return;
    }
    const order = { skill: 0, memory: 1, command: 2, agent: 3 };
    const rows = skillEntries().sort((a, b) => (order[a.kind] - order[b.kind]) || a.name.localeCompare(b.name));
    for (const record of rows) dom.skillsList.append(skillRow(record));
  }

  function openSkillsDialog() {
    if (!SKILLS) {
      showToast('The skills module did not load.', 'error');
      return;
    }
    dom.skillEditor.hidden = true;
    setFormError(dom.skillEditorError, '');
    renderSkillsDialog();
    if (typeof dom.skillsDialog.showModal === 'function') dom.skillsDialog.showModal();
    else dom.skillsDialog.setAttribute('open', '');
  }

  async function handleSkillFiles(event) {
    const files = [...(event.target.files || [])];
    dom.skillFileInput.value = '';
    if (!files.length || !SKILLS) return;
    let added = 0;
    for (const file of files) {
      const content = await file.text();
      const relative = file.webkitRelativePath || file.name;
      const path = relative.includes('/') ? relative.split('/').slice(1).join('/') : relative;
      const target = /skill\.md$/i.test(path) ? path : `.claude/skills/${SKILLS.toId(path.replace(/\.[^.]*$/, '')) || 'skill'}/${path.split('/').pop()}`;
      state.skills.manual = state.skills.manual.filter(item => item.path !== target);
      state.skills.manual.push({ path: target, content, name: path.split('/').pop() });
      added += 1;
    }
    refreshSkills();
    renderSkillsDialog();
    renderSkillsPanel();
    if (state.currentSession) syncSessionSystem(state.currentSession);
    showToast(`${added} skill file${added === 1 ? '' : 's'} added to the model context.`);
  }

  function savePastedSkill() {
    if (!SKILLS) return;
    const name = dom.skillNameInput.value.trim();
    const body = dom.skillBodyInput.value.trim();
    if (!body) {
      setFormError(dom.skillEditorError, 'Paste some markdown (or a full SKILL.md with front matter) first.');
      return;
    }
    setFormError(dom.skillEditorError, '');
    const id = SKILLS.toId(name || 'pasted-skill');
    const path = `.claude/skills/${id}/SKILL.md`;
    const content = /^\s*---/.test(body)
      ? body
      : ['---', `name: ${id}`, `description: ${(name ? `${name}. ` : '')}Pasted into Forge and loaded as a Claude-format skill. Describe when to use it by editing this line.`, '---', '', body].join('\n');
    state.skills.manual = state.skills.manual.filter(item => item.path !== path);
    state.skills.manual.push({ path, content, name: id });
    dom.skillNameInput.value = '';
    dom.skillBodyInput.value = '';
    dom.skillEditor.hidden = true;
    refreshSkills();
    renderSkillsDialog();
    renderSkillsPanel();
    if (state.currentSession) syncSessionSystem(state.currentSession);
    showToast(`“${id}” is now available to the model.`);
  }

  function downloadSkillTemplate() {
    if (!SKILLS) return;
    const blob = new Blob([SKILLS.template('my-skill')], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'SKILL.md';
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast('Template downloaded. Save it as .claude/skills/<name>/SKILL.md in your project.');
  }

  /* ---------------------------------------------------------------------- *
   * Connection doctor
   * ---------------------------------------------------------------------- */

  function doctorRow(id, state_, title, detail) {
    let row = $(`[data-doctor="${id}"]`, dom.doctorResults);
    if (!row) {
      row = document.createElement('div');
      row.className = 'doctor-row';
      row.dataset.doctor = id;
      row.innerHTML = '<i></i><div><strong></strong><small></small></div>';
      dom.doctorResults.append(row);
    }
    row.classList.remove('is-pass', 'is-warn', 'is-fail', 'is-run');
    row.classList.add(`is-${state_}`);
    $('strong', row).textContent = title;
    $('small', row).innerHTML = detail;
    return row;
  }

  function describeFetchFailure(error, url) {
    if (error?.name === 'AbortError') return { level: 'warn', text: 'The check was cancelled.' };
    if (error instanceof TypeError || error?.name === 'TypeError') {
      return {
        level: 'fail',
        text: `The browser could not complete the request to <code>${escapeHtml(url)}</code>. That is the signature of a blocked cross-origin request: a browser check (Cloudflare), an ad/privacy blocker, an offline network, or a provider that does not allow this page's origin.`
      };
    }
    return { level: 'fail', text: escapeHtml(error?.message || String(error)) };
  }

  async function probe(url, headers = {}) {
    const started = performance.now();
    try {
      const response = await fetch(url, { headers, cache: 'no-store' });
      return { response, ms: Math.round(performance.now() - started), error: null };
    } catch (error) {
      return { response: null, ms: Math.round(performance.now() - started), error };
    }
  }

  async function runDoctor() {
    if (state.diagnostics.running) return;
    state.diagnostics.running = true;
    state.diagnostics.results = [];
    dom.doctorResults.replaceChildren();
    dom.doctorRunButton.disabled = true;
    dom.doctorStatus.textContent = 'running checks…';
    const base = state.apiBase;
    const push = (id, level, title, detail) => {
      state.diagnostics.results.push({ id, level, title, detail: detail.replace(/<[^>]+>/g, '') });
      doctorRow(id, level === 'run' ? 'run' : level, title, detail);
    };

    try {
      push('env', location.protocol === 'file:' ? 'fail' : location.isSecureContext ? 'pass' : 'warn', 'Page environment',
        location.protocol === 'file:'
          ? 'This page was opened straight from disk (<code>file://</code>), which sends an <code>Origin: null</code> and is rejected by most APIs. Serve it over http(s) — for example <code>python3 -m http.server 8000</code> — or use the published Pages URL.'
          : `Served over ${location.protocol}//${location.host}${location.isSecureContext ? ' (secure context)' : ' — not a secure context, so some APIs are blocked'}.`);

      push('online', navigator.onLine ? 'pass' : 'fail', 'Device connectivity',
        navigator.onLine ? 'The browser reports an active connection.' : 'The browser reports that this device is offline.');

      push('dns', 'run', 'Reaching the API host', `GET <code>${escapeHtml(base)}/models</code> without a key…`);
      const anonymous = await probe(`${base}/models`, { Accept: 'application/json' });
      if (anonymous.error) {
        const failure = describeFetchFailure(anonymous.error, `${base}/models`);
        doctorRow('dns', failure.level, 'Reaching the API host', failure.text);
        state.diagnostics.results[state.diagnostics.results.length - 1].detail = failure.text.replace(/<[^>]+>/g, '');
      } else {
        const status = anonymous.response.status;
        const body = await anonymous.response.text().catch(() => '');
        const looksBlocked = /just a moment|cf-chl|cloudflare|enable javascript/i.test(body) || status === 403 || status === 503;
        doctorRow('dns', looksBlocked ? 'warn' : 'pass', 'Reaching the API host',
          looksBlocked
            ? `The host answered <strong>${status}</strong> with a browser-check page rather than JSON (${anonymous.ms} ms). Sign in at CodeCraft in this browser first so the check is cleared, then run the checks again.`
            : `Host reachable in ${anonymous.ms} ms (HTTP ${status}). An unauthenticated request is expected to be rejected — that is what this check verifies.`);
        state.diagnostics.results[state.diagnostics.results.length - 1].detail = looksBlocked ? `Browser-check response (HTTP ${status})` : `Reachable in ${anonymous.ms} ms (HTTP ${status})`;
      }

      push('key', state.apiKey ? 'run' : 'warn', 'Your API key', state.apiKey ? 'Sending an authenticated model list request…' : 'No key is loaded in this tab. Connect one above and re-run.');
      if (state.apiKey) {
        const authorized = await probe(`${base}/models`, { Authorization: `Bearer ${state.apiKey}`, Accept: 'application/json' });
        if (authorized.error) {
          const failure = describeFetchFailure(authorized.error, `${base}/models`);
          doctorRow('key', failure.level, 'Your API key', failure.text);
        } else if (authorized.response.ok) {
          let count = 0;
          try {
            const payload = await authorized.response.json();
            count = (Array.isArray(payload) ? payload : payload?.data || []).length;
          } catch (_) { count = 0; }
          doctorRow('key', 'pass', 'Your API key', `Accepted in ${authorized.ms} ms — ${count} model${count === 1 ? '' : 's'} visible to this account.`);
        } else {
          const detail = await readErrorResponse(authorized.response);
          const hint = authorized.response.status === 401 || authorized.response.status === 403
            ? ' The key was rejected: check that it is active, spelled correctly, and has the inference and models:read scopes.'
            : authorized.response.status === 429
              ? ' Rate limited: wait for the window to reset or use another key.'
              : '';
          doctorRow('key', 'fail', 'Your API key', `${escapeHtml(detail)}.${hint}`);
        }
      }

      push('cors', 'pass', 'Browser request rules',
        `Forge talks to <code>${escapeHtml(new URL(base).host)}</code> directly from this tab; nothing is proxied. If the two checks above failed with a network error while the CodeCraft site itself loads in another tab, the block is at the edge (browser check, extension, VPN or company proxy) rather than in Forge.`);

      const failed = [...dom.doctorResults.children].filter(row => row.classList.contains('is-fail')).length;
      dom.doctorStatus.textContent = failed ? `${failed} check${failed === 1 ? '' : 's'} failing · ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : `all checks passed · ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
    } finally {
      state.diagnostics.running = false;
      state.diagnostics.finishedAt = Date.now();
      dom.doctorRunButton.disabled = false;
    }
  }

  function openDoctorDialog() {
    dom.doctorSteps.innerHTML = [
      '<li><strong>Sign in once in this browser.</strong> Open the CodeCraft sign-in page, finish it (including the “Checking your browser…” step), then come back and press <em>Save &amp; test</em>. The check leaves a clearance cookie on the API host that a plain fetch cannot obtain.</li>',
      '<li><strong>Turn off privacy shields for this host.</strong> Content blockers, Brave Shields, some VPN clients and school/company proxies drop the request before CodeCraft sees it.</li>',
      '<li><strong>If the sign-in page itself never stops loading:</strong> the page is inside a Cloudflare browser check. Try a private window with extensions disabled, another network (mobile hotspot), and make sure the device clock is correct — a skewed clock fails the challenge.</li>',
      '<li><strong>Serve the app over http(s).</strong> Pages served from <code>file://</code> send <code>Origin: null</code>, which most APIs reject outright.</li>',
      '<li><strong>Last resort: point Forge at your own gateway.</strong> Advanced → API base URL accepts any OpenAI-compatible endpoint you control that forwards to CodeCraft.</li>'
    ].join('');
    if (typeof dom.doctorDialog.showModal === 'function') dom.doctorDialog.showModal();
    else dom.doctorDialog.setAttribute('open', '');
    if (!state.diagnostics.results.length) runDoctor();
  }

  function copyDoctorReport() {
    const lines = [
      `Forge connection report · ${new Date().toISOString()}`,
      `page: ${location.href}`,
      `base: ${state.apiBase}`,
      `secure context: ${location.isSecureContext}`,
      `online: ${navigator.onLine}`,
      `key loaded: ${state.apiKey ? 'yes' : 'no'}`,
      `models loaded: ${state.models.length}`,
      ...state.diagnostics.results.map(item => `${item.level.toUpperCase()} ${item.title}: ${item.detail}`)
    ];
    navigator.clipboard.writeText(lines.join('\n'))
      .then(() => showToast('Connection report copied. Paste it anywhere you like — it contains no key.'))
      .catch(() => showToast('Clipboard access is not available in this browser.', 'error'));
  }

  /* ---------------------------------------------------------------------- *
   * Environment banner
   * ---------------------------------------------------------------------- */

  function renderEnvironmentBanner() {
    if (!dom.envBanner) return;
    let dismissed = false;
    try { dismissed = window.sessionStorage.getItem('forge.envBannerDismissed') === '1'; } catch (_) { dismissed = false; }
    if (dismissed) return;
    if (location.protocol === 'file:') {
      dom.envBannerText.innerHTML = 'This copy of Forge was opened from a file on disk (<code>file://</code>). API requests from that origin are usually rejected. Serve the folder instead — <code>python3 -m http.server 8000</code> — or use the published GitHub Pages URL.';
      dom.envBanner.hidden = false;
      return;
    }
    if (/\.github\.io$/i.test(location.hostname) && /\/404/.test(document.body.textContent || '')) {
      dom.envBannerText.innerHTML = 'GitHub Pages is not serving this project yet, so the URL you followed does not exist.';
      dom.envBanner.hidden = false;
    }
  }

    function renderModelsFromFallback() {
    dom.modelSelect.innerHTML = `<option value="${FALLBACK_MODEL}">${FALLBACK_MODEL}</option>`;
    dom.modelSelect.value = FALLBACK_MODEL;
    state.selectedModel = FALLBACK_MODEL;
    renderModelDetails();
  }

  function bindEvents() {
    dom.apiSettingsButton.addEventListener('click', openApiDialog);
    dom.apiSidebarButton.addEventListener('click', openApiDialog);
    dom.heroConnectButton.addEventListener('click', openApiDialog);
    dom.apiForm.addEventListener('submit', handleApiFormSubmit);
    dom.revealApiKeyButton.addEventListener('click', () => {
      const show = dom.apiKeyInput.type === 'password';
      dom.apiKeyInput.type = show ? 'text' : 'password';
      dom.revealApiKeyButton.textContent = show ? 'Hide' : 'Show';
      dom.apiKeyInput.focus();
    });
    if (COMPRESSOR) {
      dom.saverOpenButton.addEventListener('click', openSaverDialog);
      dom.saverChip.addEventListener('click', openSaverDialog);
      dom.saverCurrentTurnToggle.addEventListener('change', () => {
        state.saver.compactCurrentTurnFiles = dom.saverCurrentTurnToggle.checked;
        saveSettings();
      });
      dom.saverPruneToggle.addEventListener('change', () => {
        state.saver.pruneOldPayloads = dom.saverPruneToggle.checked;
        saveSettings();
      });
      dom.saverSchemaToggle.addEventListener('change', () => {
        state.saver.compactToolSchemas = dom.saverSchemaToggle.checked;
        saveSettings();
      });
      dom.saverTurnsSelect.addEventListener('change', () => {
        state.saver.keepRecentTurns = Number(dom.saverTurnsSelect.value) || 2;
        saveSettings();
      });
      dom.saverBudgetInput.addEventListener('change', () => {
        state.saver.targetTokens = Math.max(0, Number(dom.saverBudgetInput.value) || 0);
        dom.saverBudgetInput.value = String(state.saver.targetTokens);
        saveSettings();
      });
      dom.saverPreviewButton.addEventListener('click', previewCompression);
      dom.saverBenchmarkButton.addEventListener('click', runBenchmark);
      dom.saverResetButton.addEventListener('click', () => {
        state.saver.totals = { runs: 0, tokensBefore: 0, tokensAfter: 0, saved: 0, lastReport: null, lastLabel: '' };
        renderSaverPanel();
        renderSaverReport(null, 'Session totals');
        showToast('Token saver counters reset.');
      });
    }

    if (SKILLS) {
      dom.skillsOpenButton.addEventListener('click', openSkillsDialog);
      dom.skillsRescanButton.addEventListener('click', () => {
        refreshSkills({ toast: true });
        renderSkillsDialog();
        renderSkillsPanel();
        if (state.currentSession) syncSessionSystem(state.currentSession);
      });
      dom.skillsAddFileButton.addEventListener('click', () => dom.skillFileInput.click());
      dom.skillFileInput.addEventListener('change', handleSkillFiles);
      dom.skillsPasteButton.addEventListener('click', () => {
        dom.skillEditor.hidden = !dom.skillEditor.hidden;
        setFormError(dom.skillEditorError, '');
        if (!dom.skillEditor.hidden) {
          if (!dom.skillBodyInput.value) dom.skillBodyInput.value = SKILLS.template('my-skill');
          dom.skillNameInput.focus();
        }
      });
      dom.skillsTemplateButton.addEventListener('click', downloadSkillTemplate);
      dom.skillEditorCancel.addEventListener('click', () => { dom.skillEditor.hidden = true; });
      dom.skillEditorSave.addEventListener('click', savePastedSkill);
    }

    dom.runDoctorButton.addEventListener('click', () => {
      try { dom.apiDialog.close(); } catch (_) { /* not open */ }
      openDoctorDialog();
    });
    dom.doctorRunButton.addEventListener('click', runDoctor);
    dom.doctorCopyButton.addEventListener('click', copyDoctorReport);
    dom.openCodecraftLoginButton.addEventListener('click', () => {
      window.open(LOGIN_URL, '_blank', 'noreferrer');
      showToast('Finish the sign-in (including the browser check), then come back and press “Save & test”.');
    });
    dom.envBannerClose.addEventListener('click', () => {
      dom.envBanner.hidden = true;
      try { window.sessionStorage.setItem('forge.envBannerDismissed', '1'); } catch (_) { /* storage disabled */ }
    });

    dom.modelSelect.addEventListener('change', () => {
      state.selectedModel = dom.modelSelect.value;
      renderModelDetails();
    });

    dom.newSessionButton.addEventListener('click', newSession);
    $$('[data-mode]').forEach(button => button.addEventListener('click', () => setMode(button.dataset.mode)));
    dom.promptForm.addEventListener('submit', handlePromptSubmit);
    dom.promptInput.addEventListener('input', resizePrompt);
    dom.promptInput.addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        dom.promptForm.requestSubmit();
      }
    });
    $$('.suggestion-card, .quick-prompts button').forEach(button => button.addEventListener('click', () => {
      dom.promptInput.value = button.dataset.prompt || '';
      resizePrompt();
      dom.promptInput.focus();
    }));

    dom.connectFolderButton.addEventListener('click', openFilePickerOrFolder);
    dom.attachButton.addEventListener('click', openFilePickerOrFolder);
    dom.heroWorkspaceButton.addEventListener('click', openFilePickerOrFolder);
    dom.connectGithubButton.addEventListener('click', openGithubDialog);
    dom.githubSidebarButton.addEventListener('click', openGithubDialog);
    dom.inspectorMenuButton.addEventListener('click', openGithubDialog);
    dom.githubForm.addEventListener('submit', handleGithubFormSubmit);
    dom.localFileInput.addEventListener('change', handleImportedFiles);
    dom.fileSearch.addEventListener('input', renderFileList);
    dom.changeWorkspaceButton.addEventListener('click', () => { if (resetWorkspace()) showToast('Workspace disconnected.'); });
    dom.disconnectWorkspaceButton.addEventListener('click', () => { if (resetWorkspace()) showToast('Workspace disconnected.'); });
    dom.pushChangesButton.addEventListener('click', pushGithubChanges);
    dom.downloadChangesButton.addEventListener('click', downloadChanges);

    dom.approveWriteButton.addEventListener('click', () => resolveWriteApproval(true));
    dom.denyWriteButton.addEventListener('click', () => resolveWriteApproval(false));
    dom.writeDialog.addEventListener('cancel', event => { event.preventDefault(); resolveWriteApproval(false); });
    dom.writeDialog.addEventListener('close', () => {
      if (state.pendingApproval) {
        const pending = state.pendingApproval;
        state.pendingApproval = null;
        pending.resolve(false);
      }
    });
    dom.copyFileButton.addEventListener('click', async () => {
      const path = dom.copyFileButton.dataset.path;
      const skillPath = dom.copyFileButton.dataset.skillPath;
      const content = (path ? state.files.get(path) : '') || (skillPath ? (SKILLS?.resolveSkill(state.skills.registry, skillPath)?.body || '') : '') || '';
      try {
        await navigator.clipboard.writeText(content);
        dom.copyFileButton.innerHTML = 'Copied <span>✓</span>';
        window.setTimeout(() => { dom.copyFileButton.innerHTML = 'Copy contents <span>⧉</span>'; }, 1300);
      } catch (_) { showToast('Clipboard access is not available in this browser.', 'error'); }
    });

    $$('[data-close-dialog]').forEach(button => button.addEventListener('click', () => {
      const target = document.getElementById(button.dataset.closeDialog);
      if (target?.id === 'writeDialog') resolveWriteApproval(false);
      else target?.close();
    }));
    [dom.apiDialog, dom.githubDialog, dom.fileDialog].forEach(dialog => {
      dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
    });

    dom.mobileMenuButton.addEventListener('click', () => dom.appShell.classList.toggle('menu-open'));
    dom.appShell.addEventListener('click', event => {
      if (window.innerWidth <= 760 && dom.appShell.classList.contains('menu-open') && event.target === dom.appShell) dom.appShell.classList.remove('menu-open');
    });
    document.addEventListener('keydown', event => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        newSession();
      }
      if (event.key === 'Escape' && dom.appShell.classList.contains('menu-open')) dom.appShell.classList.remove('menu-open');
    });
  }

  /** Read-only introspection for the console and for tests. Never exposes keys. */
  function exposeDebugApi() {
    window.ForgeDebug = {
      snapshot: () => ({
        apiBase: state.apiBase,
        apiKeyLoaded: Boolean(state.apiKey),
        models: state.models.length,
        mode: state.mode,
        workspace: state.workspace.kind,
        files: state.files.size,
        skills: state.skills.registry.total,
        skillErrors: state.skills.registry.errorCount,
        skillTokens: state.skills.lastTokens,
        saverProfile: state.saver.profile,
        saverRuns: state.saver.totals.runs,
        saverSavedPct: sessionSaverPercentage()
      }),
      systemMessage: () => getSystemMessage().content,
      compress: (messages, options) => COMPRESSOR?.compressMessages(messages, options),
      benchmark: (options) => COMPRESSOR?.benchmark(options),
      refreshSkills: () => { refreshSkills(); return state.skills.registry.total; },
      doctor: () => { openDoctorDialog(); return true; }
    };
  }

  function init() {
    loadSettings();
    bindEvents();
    renderModelsFromFallback();
    renderHistory();
    refreshSkills({ silent: true });
    renderWorkspaceUI();
    renderSaverPanel();
    renderSkillsPanel();
    renderEnvironmentBanner();
    setMode('chat');
    resizePrompt();
    exposeDebugApi();
  }

  init();
})();
