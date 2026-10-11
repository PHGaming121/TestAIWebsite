/**
 * GitHub REST client — 100% browser-side.
 *
 * The user pastes a Personal Access Token (kept in localStorage, never sent
 * anywhere except api.github.com). With it the agent can create repos, commit
 * files through the Git Data API, open branches/PRs/issues and switch on
 * GitHub Pages — so a project can go from prompt to a live github.io URL
 * without leaving this page.
 */
import { GITHUB, KEYS } from './config.js';
import { blobToBase64, prettyError, pool, readStorage, writeStorage, isTextPath } from './util.js';

export class GitHubError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
    this.body = body;
  }
}

export class GitHubClient {
  constructor(token, api = GITHUB.api) {
    this.token = token;
    this.api = api.replace(/\/$/, '');
  }

  async request(path, { method = 'GET', body, headers = {}, accept, raw = false } = {}) {
    const url = path.startsWith('http') ? path : `${this.api}${path.startsWith('/') ? path : `/${path}`}`;
    const res = await fetch(url, {
      method,
      headers: {
        Accept: accept || 'application/vnd.github+json',
        'X-GitHub-Api-Version': GITHUB.apiVersion,
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (raw) return res;

    let data = null;
    const text = await res.text();
    if (text) {
      try { data = JSON.parse(text); }
      catch { data = { raw: text.slice(0, 4000) }; }
    }
    if (!res.ok) {
      const msg = data?.message || data?.error || `GitHub API ${res.status}`;
      const detail = data?.errors?.length ? ` — ${data.errors.map((e) => e.message || e.code || JSON.stringify(e)).join('; ')}` : '';
      throw new GitHubError(`${msg}${detail}`, res.status, data);
    }
    return data;
  }

  /* ── account ──────────────────────────────────────────── */
  async me() {
    const res = await fetch(`${this.api}/user`, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${this.token}`,
        'X-GitHub-Api-Version': GITHUB.apiVersion,
      },
    });
    const scopes = res.headers.get('x-oauth-scopes') || '';
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new GitHubError(data?.message || `Token rejected (HTTP ${res.status})`, res.status, data);
    }
    const user = await res.json();
    return { ...user, scopes };
  }

  async listRepos({ perPage = 100, type = 'all', sort = 'pushed', page = 1 } = {}) {
    return await this.request(`/user/repos?per_page=${perPage}&sort=${sort}&type=${type}&page=${page}&affiliation=owner,collaborator,organization_member`);
  }

  async listOrgs() {
    return await this.request('/user/orgs?per_page=100');
  }

  async searchRepos(q, { perPage = 20 } = {}) {
    return await this.request(`/search/repositories?q=${encodeURIComponent(q)}&per_page=${perPage}`);
  }

  /* ── repos ────────────────────────────────────────────── */
  async getRepo(owner, repo) {
    return await this.request(`/repos/${owner}/${repo}`);
  }

  async createRepo({ name, description = '', isPrivate = true, autoInit = true, owner = null }) {
    const path = owner ? `/orgs/${owner}/repos` : '/user/repos';
    return await this.request(path, {
      method: 'POST',
      body: { name, description, private: isPrivate, auto_init: autoInit, has_issues: true, has_pages: false },
    });
  }

  async deleteRepo(owner, repo) {
    return await this.request(`/repos/${owner}/${repo}`, { method: 'DELETE' });
  }

  async listBranches(owner, repo) {
    return await this.request(`/repos/${owner}/${repo}/branches?per_page=100`);
  }

  async createBranch(owner, repo, branch, fromBranch) {
    const ref = await this.request(`/repos/${owner}/${repo}/git/ref/heads/${fromBranch}`);
    return await this.request(`/repos/${owner}/${repo}/git/refs`, {
      method: 'POST',
      body: { ref: `refs/heads/${branch}`, sha: ref.object.sha },
    });
  }

  /* ── reading ──────────────────────────────────────────── */
  async listTree(owner, repo, ref = 'HEAD', { recursive = true } = {}) {
    try {
      const data = await this.request(`/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}${recursive ? '?recursive=1' : ''}`);
      return data.tree || [];
    } catch (e) {
      if (e.status === 404) return [];
      throw e;
    }
  }

  async readFile(owner, repo, path, ref) {
    const q = ref ? `?ref=${encodeURIComponent(ref)}` : '';
    return await this.request(`/repos/${owner}/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}${q}`);
  }

  async getPages(owner, repo) {
    try { return await this.request(`/repos/${owner}/${repo}/pages`); }
    catch (e) { if (e.status === 404) return null; throw e; }
  }

  /* ── publishing ───────────────────────────────────────── */

  /**
   * Commit a set of files (and deletions) to a branch using the Git Data API.
   * Works on empty repos, existing branches, and new branches.
   *
   * @param {object} o
   * @param {string} o.owner @param {string} o.repo @param {string} o.branch
   * @param {Array<{path:string, content?:string, blob?:Blob, base64?:string, delete?:boolean}>} o.files
   * @param {string} o.message
   * @param {boolean}[o.force]
   * @param {Function}[o.onProgress] (step, done, total) => void
   */
  async pushFiles({ owner, repo, branch, files, message, force = false, onProgress, baseBranch = null }) {
    const total = files.length + 3;
    let done = 0;
    const step = (label) => { done++; onProgress?.(label, done, total); };

    // 1. Resolve the current head (if any)
    let refData = null;
    try { refData = await this.request(`/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`); }
    catch (e) { if (e.status !== 404) throw e; }

    if (!refData && baseBranch) {
      try { refData = await this.request(`/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(baseBranch)}`); }
      catch { refData = null; }
    }
    if (!refData) {
      // try the repo default branch as a base for a brand new branch
      try {
        const repoInfo = await this.getRepo(owner, repo);
        const def = repoInfo.default_branch;
        if (def && def !== branch) {
          try { refData = await this.request(`/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(def)}`); } catch { refData = null; }
        }
      } catch { /* ignore */ }
    }

    let baseCommitSha = refData?.object?.sha || null;
    let baseTreeSha = null;
    if (baseCommitSha) {
      const commit = await this.request(`/repos/${owner}/${repo}/git/commits/${baseCommitSha}`);
      baseTreeSha = commit.tree?.sha || null;
    }
    step(`base ${baseCommitSha ? baseCommitSha.slice(0, 7) : '(empty repo)'}`);

    // 2. Upload blobs
    const tree = [];
    await pool(files, 4, async (file) => {
      if (file.delete) { tree.push({ path: file.path, mode: '100644', type: 'blob', sha: null }); return; }
      let base64 = file.base64;
      if (!base64) {
        if (file.blob) base64 = await blobToBase64(file.blob);
        else base64 = btoa(unescape(encodeURIComponent(String(file.content ?? ''))));
      }
      const blob = await this.request(`/repos/${owner}/${repo}/git/blobs`, {
        method: 'POST',
        body: { content: base64, encoding: 'base64' },
      });
      tree.push({ path: file.path, mode: file.executable ? '100755' : '100644', type: 'blob', sha: blob.sha });
    });
    step(`uploaded ${tree.length} file(s)`);

    // 3. Tree
    const treeRes = await this.request(`/repos/${owner}/${repo}/git/trees`, {
      method: 'POST',
      body: baseTreeSha ? { base_tree: baseTreeSha, tree } : { tree },
    });
    step('tree created');

    // 4. Commit
    const commitRes = await this.request(`/repos/${owner}/${repo}/git/commits`, {
      method: 'POST',
      body: { message, tree: treeRes.sha, parents: baseCommitSha ? [baseCommitSha] : [] },
    });
    step('committed');

    // 5. Move the ref
    if (refData && refData.ref === `refs/heads/${branch}`) {
      await this.request(`/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(branch)}`, {
        method: 'PATCH',
        body: { sha: commitRes.sha, force },
      });
    } else {
      await this.request(`/repos/${owner}/${repo}/git/refs`, {
        method: 'POST',
        body: { ref: `refs/heads/${branch}`, sha: commitRes.sha },
      });
    }
    step('ref updated');

    return {
      sha: commitRes.sha,
      branch,
      files: tree.length,
      url: `https://github.com/${owner}/${repo}/commit/${commitRes.sha}`,
      treeUrl: `https://github.com/${owner}/${repo}/tree/${branch}`,
    };
  }

  /** Simple single-file commit via the Contents API (used for quick edits). */
  async commitFile(owner, repo, path, content, message, { branch, sha } = {}) {
    const body = {
      message,
      content: btoa(unescape(encodeURIComponent(content))),
      ...(branch ? { branch } : {}),
      ...(sha ? { sha } : {}),
    };
    return await this.request(`/repos/${owner}/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}`, { method: 'PUT', body });
  }

  async enablePages(owner, repo, { branch = 'main', path = '/' } = {}) {
    const source = { branch, path };
    const existing = await this.getPages(owner, repo);
    if (existing) {
      await this.request(`/repos/${owner}/${repo}/pages`, { method: 'PUT', body: { source } });
    } else {
      await this.request(`/repos/${owner}/${repo}/pages`, { method: 'POST', body: { source, build_type: 'legacy' } });
    }
    const pages = await this.getPages(owner, repo);
    return pages;
  }

  async createPullRequest(owner, repo, { title, body = '', head, base }) {
    return await this.request(`/repos/${owner}/${repo}/pulls`, { method: 'POST', body: { title, body, head, base } });
  }

  async createIssue(owner, repo, { title, body = '', labels = [] }) {
    return await this.request(`/repos/${owner}/${repo}/issues`, { method: 'POST', body: { title, body, labels } });
  }

  async updateRepo(owner, repo, patch) {
    return await this.request(`/repos/${owner}/${repo}`, { method: 'PATCH', body: patch });
  }

  /** Collect workspace files into push-ready payloads. */
  static async filesFromWorkspace(ws, { only = null, skip = null, maxBytes = 25_000_000 } = {}) {
    const entries = (await ws.list()).filter((e) => e.type === 'file');
    const out = [];
    let total = 0;
    for (const e of entries) {
      if (only && !only.some((p) => e.path === p || e.path.startsWith(p.replace(/\/$/, '') + '/'))) continue;
      if (skip?.some((re) => re.test(e.path))) continue;
      if ((e.size || 0) + total > maxBytes) continue;
      const blob = await ws.readBlob(e.path);
      total += blob.size;
      out.push({
        path: e.path,
        blob,
        text: isTextPath(e.path) && blob.size < 400_000 ? await blob.text() : undefined,
        size: blob.size,
      });
    }
    return out;
  }
}

/* ── token storage ──────────────────────────────────────── */
export function loadGitHubCreds() {
  const saved = readStorage(KEYS.github, null);
  if (!saved?.token) return null;
  if (saved.sessionOnly && !sessionStorage.getItem('pp.gh.session')) return null;
  return saved;
}

export function saveGitHubCreds(creds) {
  const payload = { ...creds, savedAt: Date.now() };
  if (payload.sessionOnly) {
    sessionStorage.setItem('pp.gh.session', '1');
    // keep only in sessionStorage — survives reload within the tab, not across tabs
    try { sessionStorage.setItem(KEYS.github, JSON.stringify(payload)); } catch { /* ignore */ }
    try { localStorage.removeItem(KEYS.github); } catch { /* ignore */ }
    return payload;
  }
  writeStorage(KEYS.github, payload);
  try { sessionStorage.removeItem(KEYS.github); } catch { /* ignore */ }
  return payload;
}

export function readGitHubCredsAnywhere() {
  try {
    const s = sessionStorage.getItem(KEYS.github);
    if (s) { const p = JSON.parse(s); if (p?.token) return p; }
  } catch { /* ignore */ }
  return loadGitHubCreds();
}

export function clearGitHubCreds() {
  try { localStorage.removeItem(KEYS.github); } catch { /* ignore */ }
  try { sessionStorage.removeItem(KEYS.github); sessionStorage.removeItem('pp.gh.session'); } catch { /* ignore */ }
}

export function clientFromStorage() {
  const creds = readGitHubCredsAnywhere();
  return creds?.token ? new GitHubClient(creds.token) : null;
}

export { prettyError };
