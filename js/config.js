/**
 * Central configuration for the Puter Playground.
 * Everything a user might want to change lives here (and in Settings at runtime).
 */

export const APP = {
  name: 'Puter Playground',
  version: '1.0.0',
  puterScript: 'https://js.puter.com/v2/',
  puterWaitMs: 12000,
};

/** localStorage / puter.kv keys */
export const KEYS = {
  settings: 'pp.settings.v1',
  conversations: 'pp.conversations.v1',
  activeConv: 'pp.activeConv.v1',
  models: 'pp.models.v1',
  modelsAt: 'pp.models.at.v1',
  favModels: 'pp.models.favs.v1',
  github: 'pp.github.v1',
  workspaceMem: 'pp.workspace.memory.v1',
  theme: 'pp.theme.v1',
  allowTools: 'pp.tools.allow.v1',
  seenSignInNote: 'pp.seenSignInNote.v1',
  memory: 'pp.memory.v1',
  connections: 'pp.connections.v1',
  providers: 'pp.providers.v1',
  skills: 'pp.skills.v1',
};

/** How long a cached model catalogue stays fresh (ms). */
export const MODEL_CACHE_TTL = 6 * 60 * 60 * 1000;

export const DEFAULTS = {
  model: 'claude-sonnet-4-5',
  agentModel: 'claude-sonnet-4-5',
  temperature: 0.7,
  agentTemperature: 0.2,
  maxTokens: 0, // 0 = model default
  reasoningEffort: '', // '', 'minimal', 'low', 'medium', 'high'
  stream: true,
  normalize: true,
  mode: 'chat',
  maxSteps: 30,
  autoApprove: false,
  toolTimeoutMs: 120000,
  execTimeoutMs: 20000,
  pyodideVersion: '', // '' = discover latest from jsDelivr
  maxToolOutputChars: 14000,
  maxFileCharsForModel: 24000,
  systemPromptChat: '',
  systemPromptAgent: '',
  backend: 'auto',
  puterDir: 'PlaygroundWorkspace',
  githubBranch: 'main',
  githubRepo: '',
  syncPuterKv: false,
  compactToolHistory: true,
  panelOpen: null,      // null = auto (open on wide screens, closed on narrow)
  memoryEnabled: true,
  memoryBudgetChars: 1600,
  memorySync: false,     // mirror long-term memory into the user's Puter KV
  memoryDistillModel: '',// '' = reuse the chat model
  providerId: 'puter',   // active AI provider (see js/providers.js)
};

/**
 * Curated fallback catalogue, used before the live list arrives (or if the
 * browser cannot reach the Puter API). The live list from
 * `puter.ai.listModels()` always wins and is much larger.
 */
export const CURATED_MODELS = [
  { id: 'claude-sonnet-4-5', provider: 'anthropic', label: 'Claude Sonnet 4.5', desc: 'Balanced coding workhorse', tags: ['tools', 'vision'] },
  { id: 'claude-opus-4-5', provider: 'anthropic', label: 'Claude Opus 4.5', desc: 'Deep reasoning + agentic coding', tags: ['tools', 'vision'] },
  { id: 'claude-haiku-4-5', provider: 'anthropic', label: 'Claude Haiku 4.5', desc: 'Fast and cheap', tags: ['tools'] },
  { id: 'gpt-5.4-nano', provider: 'openai', label: 'GPT-5.4 Nano', desc: 'Puter default, very fast', tags: ['tools'] },
  { id: 'gpt-5.4-mini', provider: 'openai', label: 'GPT-5.4 Mini', desc: 'Fast generalist', tags: ['tools'] },
  { id: 'gpt-5.4', provider: 'openai', label: 'GPT-5.4', desc: 'Flagship OpenAI model', tags: ['tools', 'vision'] },
  { id: 'gpt-5.3-codex', provider: 'openai', label: 'GPT-5.3 Codex', desc: 'Tuned for code generation', tags: ['tools'] },
  { id: 'o3', provider: 'openai', label: 'o3', desc: 'Reasoning model', tags: ['reasoning'] },
  { id: 'google/gemini-3.1-pro-preview', provider: 'google', label: 'Gemini 3.1 Pro', desc: '1M context reasoning', tags: ['tools', 'vision'] },
  { id: 'google/gemini-2.5-flash', provider: 'google', label: 'Gemini 2.5 Flash', desc: 'Huge context, fast', tags: ['tools', 'vision'] },
  { id: 'grok-4-fast', provider: 'xai', label: 'Grok 4 Fast', desc: 'xAI, large context', tags: ['tools'] },
  { id: 'deepseek-chat', provider: 'deepseek', label: 'DeepSeek Chat', desc: 'Great value coding model', tags: ['tools'] },
  { id: 'deepseek-reasoner', provider: 'deepseek', label: 'DeepSeek Reasoner', desc: 'Step-by-step reasoning', tags: ['reasoning'] },
  { id: 'meta-llama/Meta-Llama-3.3-70B-Instruct-Turbo', provider: 'meta', label: 'Llama 3.3 70B', desc: 'Open weights', tags: [] },
  { id: 'mistral-large-latest', provider: 'mistral', label: 'Mistral Large', desc: 'European frontier model', tags: ['tools'] },
];

/** Providers we always show, even when the live catalogue is unavailable. */
export const PROVIDER_LABELS = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  google: 'Google',
  gemini: 'Google',
  xai: 'xAI',
  grok: 'xAI',
  deepseek: 'DeepSeek',
  meta: 'Meta',
  mistral: 'Mistral',
  amazon: 'Amazon',
  together: 'Together (open models)',
  openrouter: 'OpenRouter',
  cloudflare: 'Cloudflare Workers AI',
  replicate: 'Replicate',
  puter: 'Puter',
  other: 'Other',
};

/** Workspace backends the agent can operate on. */
export const BACKENDS = [
  {
    id: 'memory',
    name: 'In-browser memory',
    desc: 'Instant, ephemeral. Perfect for quick experiments.',
  },
  {
    id: 'opfs',
    name: 'Local disk (private)',
    desc: 'Your browser’s private storage. Persists across reloads, never leaves this device.',
  },
  {
    id: 'local',
    name: 'Local folder…',
    desc: 'Pick a real folder on your computer (Chrome, Edge, Opera). Reads & writes your actual files.',
  },
  {
    id: 'puter',
    name: 'Puter cloud drive',
    desc: 'Stored in your free Puter account — available on every device, needed for one-click publishing.',
  },
];

export const GITHUB = {
  api: 'https://api.github.com',
  apiVersion: '2022-11-28',
  scopesHint: 'classic token with "repo" scope, or a fine-grained token with Contents + Administration read/write',
};

/** Welcome-screen starter cards. */
export const STARTERS = [
  {
    icon: 'rocket',
    title: 'Ship a game to GitHub',
    mode: 'agent',
    text: 'Build a polished single-file Snake game with score persistence, then create a GitHub repo called "snake-game", push it and enable GitHub Pages so it is live on github.io.',
  },
  {
    icon: 'terminal',
    title: 'Write & run code',
    mode: 'agent',
    text: 'Write a Python script that generates a 30-day workout plan as CSV, run it in the sandbox, then show me the first rows and save the output to the workspace.',
  },
  {
    icon: 'sparkles',
    title: 'Explain like a senior dev',
    mode: 'chat',
    text: 'Explain how async/await works under the hood in JavaScript, with a short code example and the three most common pitfalls.',
  },
  {
    icon: 'globe',
    title: 'Build & publish a landing page',
    mode: 'agent',
    text: 'Create a responsive landing page for a fictional coffee subscription startup (index.html + styles.css), preview it in the Files tab, then publish it to a Puter subdomain.',
  },
];
