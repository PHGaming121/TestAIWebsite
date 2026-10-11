/**
 * Model picker: live catalogue from puter.ai.listModels() (400+ models),
 * grouped by provider, with search, favourites and free-form entry.
 */
import { el, readStorage, writeStorage, debounce } from './util.js';
import { toast } from './ui.js';
import { CURATED_MODELS, PROVIDER_LABELS, KEYS, MODEL_CACHE_TTL } from './config.js';
import { fetchLiveModels, shortModelName } from './llm.js';
import { state, updateSettings } from './store.js';

const PROVIDER_ORDER = ['anthropic', 'openai', 'google', 'xai', 'deepseek', 'meta', 'mistral', 'qwen', 'amazon', 'together', 'openrouter', 'cloudflare', 'replicate'];
const AGENT_READY = /claude-(opus|sonnet)|gpt-5|gpt-4\.1|gemini-3|gemini-2\.5-pro|grok-4|deepseek-chat|o3|o4|codex/i;
const MAX_RENDER = 260;

export class ModelPicker {
  constructor(o) {
    Object.assign(this, o); // {btn, nameEl, dotEl, menu, searchEl, groupsEl, favsEl, footEl, customInput, customBtn, refreshBtn}
    this.models = [];
    this.source = 'curated';
    this.favs = new Set(readStorage(KEYS.favModels, []) || []);
    this.open = false;
    this.wire();
  }

  wire() {
    this.btn.onclick = (e) => { e.stopPropagation(); this.toggle(); };
    document.addEventListener('click', (e) => {
      if (this.open && !this.menu.contains(e.target) && !this.btn.contains(e.target)) this.close();
    });
    this.searchEl.addEventListener('input', debounce(() => this.render(), 90));
    this.searchEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const first = this.groupsEl.querySelector('.model-item');
        if (first) first.click();
      }
      if (e.key === 'Escape') this.close();
    });
    this.customBtn.onclick = () => {
      const id = this.customInput.value.trim();
      if (!id) return;
      this.select(id);
      this.customInput.value = '';
    };
    this.customInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') this.customBtn.click(); });
    this.refreshBtn.onclick = () => this.load({ force: true });
  }

  toggle() { this.open ? this.close() : this.show(); }

  show() {
    this.open = true;
    this.menu.hidden = false;
    this.btn.setAttribute('aria-expanded', 'true');
    this.render();
    setTimeout(() => this.searchEl.focus(), 30);
  }

  close() {
    this.open = false;
    this.menu.hidden = true;
    this.btn.setAttribute('aria-expanded', 'false');
  }

  focusSearch() { this.show(); this.searchEl.select(); }

  /** Which setting the picker edits: the model for the current mode. */
  get targetKey() { return state.settings.mode === 'agent' ? 'agentModel' : 'model'; }
  get current() { return state.settings[this.targetKey] || state.settings.model; }

  async load({ force = false } = {}) {
    this.setFoot('loading model catalogue…');
    try {
      const { models, cached } = await fetchLiveModels({ force, cacheTtl: MODEL_CACHE_TTL });
      if (models?.length) {
        this.models = models;
        this.source = cached ? 'cache' : 'live';
      } else {
        this.models = CURATED_MODELS;
        this.source = 'curated';
      }
    } catch (e) {
      this.models = CURATED_MODELS;
      this.source = 'curated';
      this.setFoot(`live catalogue unavailable — using the curated list`);
      if (force) toast(`Could not load the live model list: ${e.message}`, { type: 'warn' });
    }
    this.mergeCurated();
    this.updateButton();
    if (this.open) this.render();
    this.setFoot(`${this.models.length} models · ${this.source === 'live' ? 'live from Puter' : this.source === 'cache' ? 'cached from Puter' : 'curated fallback'}${this.source !== 'live' ? ' · ↻ to refresh' : ''}`);
    return this.models;
  }

  /** Make sure the well-known models are always present, even if the API omits them. */
  mergeCurated() {
    const have = new Set(this.models.map((m) => m.id));
    for (const c of CURATED_MODELS) if (!have.has(c.id)) this.models.push(c);
    this.models.sort((a, b) => a.id.localeCompare(b.id));
  }

  setFoot(text) { if (this.footEl) this.footEl.textContent = text; }

  updateButton() {
    const id = this.current;
    this.nameEl.textContent = shortModelName(id) || 'choose model';
    this.nameEl.title = id;
    const m = this.models.find((x) => x.id === id);
    this.dotEl.style.background = m ? providerColor(m.provider) : 'var(--muted)';
  }

  select(id) {
    const key = this.targetKey;
    updateSettings({ [key]: id });
    this.updateButton();
    this.close();
    this.onSelected?.(id, key);
    const other = key === 'model' ? 'agentModel' : 'model';
    if (!state.settings[other]) updateSettings({ [other]: id });
  }

  toggleFav(id) {
    if (this.favs.has(id)) this.favs.delete(id);
    else this.favs.add(id);
    writeStorage(KEYS.favModels, [...this.favs]);
    this.render();
  }

  render() {
    const q = (this.searchEl.value || '').trim().toLowerCase();
    const groupsEl = this.groupsEl;
    groupsEl.innerHTML = '';

    /* favourites */
    this.favsEl.innerHTML = '';
    const favIds = [...this.favs];
    if (favIds.length) {
      for (const id of favIds.slice(0, 10)) {
        const chip = el('button.fav-chip', { title: id },
          el('span', { text: shortModelName(id) }),
          el('span.x', { text: '×' }),
        );
        chip.onclick = (e) => {
          if (e.target.classList.contains('x')) { this.toggleFav(id); return; }
          this.select(id);
        };
        this.favsEl.append(chip);
      }
    }

    /* filtering */
    let list = this.models;
    if (q) {
      list = list.filter((m) =>
        m.id.toLowerCase().includes(q) ||
        (m.label || '').toLowerCase().includes(q) ||
        (m.desc || '').toLowerCase().includes(q) ||
        (m.provider || '').toLowerCase().includes(q) ||
        (m.tags || []).some((t) => t.includes(q)));
    }

    /* grouping */
    const byProvider = new Map();
    for (const m of list) {
      const key = (m.provider || 'other').toLowerCase();
      if (!byProvider.has(key)) byProvider.set(key, []);
      byProvider.get(key).push(m);
    }
    const providers = [...byProvider.keys()].sort((a, b) => {
      const ia = PROVIDER_ORDER.indexOf(a), ib = PROVIDER_ORDER.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
    });

    let rendered = 0;
    for (const provider of providers) {
      const models = byProvider.get(provider).slice().sort((a, b) => score(b) - score(a) || a.id.localeCompare(b.id));
      const title = el('div.mg-title', {},
        el('span.dot', { style: { width: '8px', height: '8px', borderRadius: '50%', background: providerColor(provider), display: 'inline-block' } }),
        el('span', { text: PROVIDER_LABELS[provider] || titleCase(provider) }),
        el('span.count', { text: String(models.length) }),
      );
      groupsEl.append(title);
      for (const m of models) {
        if (rendered++ > MAX_RENDER) {
          groupsEl.append(el('div.mg-title', {}, el('span', { text: `${list.length - MAX_RENDER} more — keep typing to narrow it down` })));
          return;
        }
        groupsEl.append(this.modelRow(m));
      }
    }
    if (!list.length) {
      groupsEl.append(el('div.empty-note', { html: `No model matches “${q}”.<br>You can still type any model id below — Puter accepts hundreds.` }));
    }
  }

  modelRow(m) {
    const isCurrent = m.id === this.current;
    const row = el('div.model-item', { class: isCurrent ? 'sel' : '' });
    const star = el('button.mini-btn', {
      title: this.favs.has(m.id) ? 'Remove from favourites' : 'Pin to favourites',
      style: { padding: '1px 5px', border: '0', background: 'transparent', color: this.favs.has(m.id) ? 'var(--warn)' : 'var(--muted)' },
      text: this.favs.has(m.id) ? '★' : '☆',
    });
    star.onclick = (e) => { e.stopPropagation(); this.toggleFav(m.id); };

    const tags = el('div.mi-tags');
    if (AGENT_READY.test(m.id)) tags.append(el('span.tag.tool', { text: 'agent' }));
    for (const t of (m.tags || []).slice(0, 2)) tags.append(el('span.tag', { text: t }));
    if (m.ctx) tags.append(el('span.tag', { text: `${Math.round(m.ctx / 1000)}k` }));

    row.append(
      el('span.model-dot', { style: { background: providerColor(m.provider) } }),
      el('div', { style: { minWidth: 0, flex: '1' } },
        el('div.mi-name', { text: m.id }),
        m.desc ? el('div.mi-desc', { text: m.desc }) : null,
      ),
      tags, star,
    );
    row.onclick = () => this.select(m.id);
    return row;
  }
}

function score(m) {
  let s = 0;
  if (AGENT_READY.test(m.id)) s += 10;
  if ((m.tags || []).includes('tools')) s += 4;
  if (/sonnet|gpt-5|gemini-3|opus|grok-4/i.test(m.id)) s += 3;
  if (/nano|mini|flash-lite|tiny|1b|3b/i.test(m.id)) s -= 2;
  if (m.ctx && m.ctx >= 200000) s += 1;
  return s;
}

export function providerColor(provider) {
  const map = {
    anthropic: '#d97757', openai: '#10a37f', google: '#4285f4', gemini: '#4285f4', xai: '#e5e7eb', grok: '#e5e7eb',
    deepseek: '#4d6bfe', meta: '#0866ff', mistral: '#ff7000', qwen: '#615ced', amazon: '#ff9900',
    together: '#0f6fff', openrouter: '#a78bfa', cloudflare: '#f38020', replicate: '#f43f5e',
  };
  return map[(provider || '').toLowerCase()] || 'var(--accent-2)';
}

const titleCase = (s) => String(s || '').replace(/(^|[-_ ])(\w)/g, (_, __, c) => c.toUpperCase());
